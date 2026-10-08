/**
 * 记忆核心存储引擎。
 *
 * 一份逻辑，三个运行时（Obsidian 插件 / Node CLI / MCP 服务）共用：
 * Vault 与 fs 的差异全部收敛在 `FileStore` 端口里。
 *
 * 不变量（每条都有对应回归测试）：
 * 1. Markdown 是权威；内存索引只是可重建派生。
 * 2. 只有 `confirmed` 参与默认检索；`pending` 默认隔离。
 * 3. 所有写入走比较-写入（内容哈希 + revision），旧任务绝不覆盖人工编辑。
 * 4. 同一来源事件重复到达是幂等的；显式命令重放不会重复建条目。
 * 5. 遗忘后的记忆退出召回；删除留下不含正文的标记，阻止复活。
 * 6. 没有任何模型 / 网络 / MSE 时，记录与检索完全可用。
 *
 * 并发模型：所有**公开**写入方法都在 `Mutex` 内串行执行；内部复用的实现
 * （`*Locked`）不再取锁，避免自我死锁。
 */

import { createId, sha256Hex, shortHash } from './hash.js';
import { Mutex, emptyRuntimeStats, type RuntimeStats } from './lock.js';
import {
  CATEGORY_DIRS,
  DEFAULT_ROOT,
  STATE_DIR,
  assertNotReserved,
  assertSafeRelativePath,
  isInsideRoot,
  memoryFileName,
  normalizePath,
  normalizeRoot,
  assertSafeRoot,
  resolveInsideRoot,
  slugify,
  PathError,
} from './paths.js';
import {
  CHANGELOG_HEADING,
  MAX_CHANGELOG_ENTRIES,
  computeDedupeKey,
  contentHashOf,
  extractTitle,
  parseMemoryFile,
  readChangelogEntries,
  serializeMemoryFile,
  splitBody,
  type ParseIssue,
} from './record.js';
import { MemoryIndex, readTitle, type SearchNote, type SearchRequest, type SearchResult } from './search-index.js';
import {
  PATCH_FILE,
  buildPatch,
  emptyPatchFile,
  parsePatchFile,
  patchHasChanges,
  serializePatchFile,
  type PatchFields,
  type PatchFile,
  type PendingPatch,
} from './patches.js';
import { compareExpectation, type FileStore, type WriteExpectation, type WriteResult } from './storage.js';
import {
  TOMBSTONE_FILE,
  TombstoneSet,
  createTombstone,
  emptyTombstoneFile,
  parseTombstones,
  serializeTombstones,
  type TombstoneFile,
} from './tombstone.js';
import type {
  MemoryKind,
  MemoryMeta,
  MemoryRecord,
  MemoryStatus,
  ScopeFilter,
  ScopeKind,
  SourceKind,
  SourceRef,
  Tombstone,
  WriteOutcome,
} from './types.js';

const STATE_VERSION = 1;

export interface StoreOptions {
  store: FileStore;
  /** 记忆根目录（Vault 内相对路径），默认 `Second Brain`。 */
  root?: string;
  /** 时间源，便于测试注入。 */
  now?: () => number;
  /** id 随机源，便于测试注入确定性。 */
  rand?: () => number;
  /** 单次同步最多处理多少文件，避免超大库卡住界面。 */
  maxScanFiles?: number;
}

export interface StoredRecord {
  record: MemoryRecord;
  raw: string;
  hash: string;
  /** 解析问题（坏数据，不被静默清空）。 */
  issues: ParseIssue[];
  /** 文件中无法安全往返的 YAML 行。 */
  unsupportedYaml: Array<{ line: number; text: string }>;
}

export interface SyncReport {
  scanned: number;
  valid: number;
  invalid: number;
  added: number;
  updated: number;
  removed: number;
  problems: Array<{ path: string; issues: ParseIssue[] }>;
}

export interface MemoryDraft {
  /** 正文（不含标题）。 */
  body: string;
  /** 可选标题；缺省时从正文首行或正文截断推断。 */
  title?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  scope?: ScopeKind;
  scopeRef?: string;
  sourceKind: SourceKind;
  sourceRef?: string;
  tags?: string[];
  aliases?: string[];
  validFrom?: string;
  validUntil?: string;
  reviewAfter?: string;
  allowModel?: boolean;
  sources?: SourceRef[];
  /** 来源事件的稳定 id，用于幂等与去重指纹。 */
  eventId?: string;
  observedAt?: string;
}

export interface CommitResult extends WriteOutcome {
  /** 幂等命中：该事件此前已处理，返回既有记忆。 */
  idempotent?: boolean;
  /**
   * 落地证据：写入成功时是**落盘原文的内容哈希**。
   *
   * 队列回执必须带真实落地证据，否则调用方拿到的是一个无法核验的成功。
   * 由存储层在写入后回填，而不是让调用方自己再读一次（那会有竞态窗口）。
   */
  contentHash?: string;
  /** 永久删除时的删除标记 id；配合 `previousHash` 构成删除证据。 */
  tombstoneId?: string;
  /** 被删除内容的哈希（删除证据）。 */
  previousHash?: string;
  /** 因命中删除标记被拒绝的复活写入。 */
  blockedByTombstone?: Tombstone;
  /** 需要人工确认（AI 提议）。 */
  requiresReview?: boolean;
}

export interface UpdatePatch {
  body?: string;
  title?: string;
  tags?: string[];
  aliases?: string[];
  scope?: ScopeKind;
  scopeRef?: string;
  validUntil?: string;
  reviewAfter?: string;
  allowModel?: boolean;
  status?: MemoryStatus;
  sources?: SourceRef[];
  /** 期望的当前内容哈希；调用方从 UI 拿到的一定是它看到的那一版。 */
  expectedHash?: string;
  /**
   * 精确的前置条件（待审补丁用）。
   *
   * `expectedHash` 在「非用户身份改已确认事实」的分支里有额外语义；
   * `precondition` 则是**无条件**的物理前置条件：磁盘内容哈希不等于它就冲突。
   * 用户接受待审补丁时必须用它——期望值是**提议时捕获的**那一版，
   * 不能在接受瞬间刷新成最新哈希。
   */
  precondition?: string;
  /** 变更说明，写入“变更”小节。 */
  reason: string;
  /** 更新者身份，用于判定“用户明确纠错可立即生效”。 */
  actor: 'user' | 'ai' | 'maintenance';
}

export interface StoreState {
  version: number;
  /** 已处理事件：事件 id → 结果。用于幂等重放。 */
  processed_events: Record<string, { at: string; memory_id: string; action: string }>;
  /**
   * 已应用的外部写事务：请求指纹 → 落地结果。
   *
   * 队列提交先执行副作用、再写回执；崩在两者之间时请求会被保留。
   * 只有把「这一次提交已经发生过」持久记在权威存储里，重放才能补写回执
   * 而不是再执行一遍（那会多出一条记忆）。
   */
  applied_operations?: Record<string, AppliedTransaction>;
  /** 索引版本，用于判断是否需要重建。 */
  index_version: number;
  /** 最近一次同步时间。 */
  last_sync_at: string;
  /** 处理游标：本次已消费到的来源区间末尾。 */
  cursor: string;
}

export interface AppliedTransaction {
  at: string;
  operation: string;
  memory_id: string;
  path: string;
  revision: number;
  content_hash: string;
  /** 永久删除的删除标记（没有新内容可哈希时用它作为落地证据）。 */
  tombstone_id?: string;
  previous_hash?: string;
}

export interface SessionEvent {
  eventId: string;
  text: string;
  /** 该事件是否为用户的明确命令（已通过护栏判定）。 */
  explicit: boolean;
  sourceKind: SourceKind;
  sourceRef: string;
  kind?: MemoryKind;
  observedAt?: string;
  tags?: string[];
  sources?: SourceRef[];
  /** 处理游标位置；只有成功处理的事件才会推进游标。 */
  cursor?: string;
}

export class MemoryStore {
  readonly root: string;
  private readonly store: FileStore;
  private readonly index: MemoryIndex;
  private readonly mutex = new Mutex();
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly maxScanFiles: number;

  private records = new Map<string, StoredRecord>();
  private byPath = new Map<string, string>();
  private tombstones: TombstoneSet = new TombstoneSet();
  private tombstoneFile: TombstoneFile = emptyTombstoneFile(Date.now());
  private state: StoreState = defaultState(Date.now());
  private loaded = false;
  private loadProblems: Array<{ path: string; issues: ParseIssue[] }> = [];
  /** 来源血缘问题（与文件解析问题分开记，避免互相覆盖）。 */
  private lineageProblems: Array<{ path: string; issues: ParseIssue[] }> = [];
  /**
   * 幂等身份索引：事件 id → 记忆 id。
   *
   * **从正文重建**，`state.json` 只用来补充（不是唯一来源）。
   * 这样即使 Markdown 写成功而状态文件写失败，重启后重放同一事件仍会命中幂等。
   */
  private eventIndex = new Map<string, string>();
  /**
   * 删除账本是否处于不可信状态。
   * 为真时：禁止召回（可能复活已删除内容），也禁止新的写入。
   * 绝不自动覆盖坏账本——保留原文件作为修复证据。
   */
  private tombstonesUnreadable = false;
  private tombstonesError = '';
  /**
   * 上一次载入是否**失败**（读盘故障，而不是数据问题）。
   *
   * 读盘故障与「文件确实不存在」是两件事：把前者当成空库会让删除账本
   * 静默失效。因此这里一旦置位，所有召回与写入都停到下一次成功载入为止。
   */
  private loadFailed = false;
  private loadFailureMessage = '';
  /** 待审补丁（AI / 外部工具对已确认事实的修改建议）。 */
  private patches: PatchFile = emptyPatchFile(Date.now());
  private patchesUnreadable = false;
  private patchesError = '';
  /**
   * 补丁变化时的落盘回调。
   *
   * 核心不认识文件系统写入的“状态文件”之外的东西，但插件需要把补丁
   * 真正写进 Vault。用回调而不是让核心自己写，是为了保持「核心不知道
   * 宿主」这条边界；回调缺失时补丁只在内存里，界面会如实提示未落盘。
   */
  private patchPersist: ((body: string) => Promise<boolean>) | null = null;
  /** 因来源失效而退出的派生记忆数量（诊断用）。 */
  private invalidatedDerived = 0;
  private readonly stats: RuntimeStats = emptyRuntimeStats();

  constructor(options: StoreOptions) {
    this.store = options.store;
    /**
     * 根目录在这里就校验一次：一旦根目录含 `..` 或绝对路径，
     * 后续所有 `isInsideRoot` / `resolveInsideRoot` 都会建立在错误前提上。
     * 宁可构造失败，也不要带着不可信根目录继续跑。
     */
    this.root = assertSafeRoot(options.root ?? DEFAULT_ROOT);
    this.now = options.now ?? (() => Date.now());
    this.rand = options.rand ?? Math.random;
    this.maxScanFiles = options.maxScanFiles ?? 20_000;
    this.index = new MemoryIndex({ now: this.now });
  }

  get runtimeStats(): RuntimeStats {
    return { ...this.stats };
  }

  get indexSize(): number {
    return this.index.size;
  }

  get tombstoneCount(): number {
    return this.tombstones.size;
  }

  get problems(): Array<{ path: string; issues: ParseIssue[] }> {
    /**
     * 历史上这里只返回 `loadProblems`，而加载过程中另一个数组曾把它整体覆盖，
     * 于是“删除账本损坏”这种必须被看见的错误会消失。现在三类问题合并返回。
     */
    return [...this.loadProblems, ...this.lineageProblems, ...this.ledgerProblems()];
  }

  /** 删除账本问题（损坏、无法核验）。 */
  private ledgerProblems(): Array<{ path: string; issues: ParseIssue[] }> {
    if (!this.tombstonesUnreadable) return [];
    return [
      {
        path: this.statePath(TOMBSTONE_FILE),
        issues: [
          {
            code: 'bad_frontmatter',
            message: `${this.tombstonesError}为防止已删除内容复活，召回与写入已暂停；请人工修复该文件后重新加载。`,
            fatal: true,
          },
        ],
      },
    ];
  }

  /**
   * 有界生成一个未被占用的记忆 id。
   *
   * 64 次仍然碰撞说明随机源退化或库里已有海量同前缀 id；
   * 两种情况都必须**显式失败**，不能继续循环。
   */
  private generateId(): string {
    const tried: string[] = [];
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = createId('mem', this.rand);
      if (!this.records.has(candidate)) return candidate;
      tried.push(candidate);
    }
    const sample = [...new Set(tried)].slice(0, 3).join('、');
    throw new Error(
      `连续 64 次生成的记忆 id 都已被占用（示例：${sample}）。` +
        '这说明随机源可能退化为常量，或库内同前缀记录异常多；本次写入已中止，未产生任何文件。',
    );
  }

  /**
   * 记忆功能当前是否可安全使用。
   *
   * 两种情况都不安全：删除账本读不懂（无法阻止复活），
   * 或者**上一次读盘失败**（无法确认账本内容）。后者必须显式置位，
   * 不能靠「反正没读到内容」的默认值蒙混过去。
   */
  get isOperational(): boolean {
    return !this.tombstonesUnreadable && !this.patchesUnreadable && !this.loadFailed;
  }

  /** 当前不可操作的原因；可操作时返回空字符串。 */
  get operationalBlockReason(): string {
    if (this.tombstonesUnreadable) {
      return `删除账本无法核验（${this.tombstonesError}）。请先修复 ${this.statePath(TOMBSTONE_FILE)}。`;
    }
    if (this.patchesUnreadable) {
      return `待审补丁文件无法核验（${this.patchesError}）。请先修复 ${this.statePath(PATCH_FILE)}。`;
    }
    if (this.loadFailed) return this.loadFailureMessage;
    return '';
  }

  /** 不可操作时统一拒绝写入。 */
  private assertOperational(action: string): CommitResult | null {
    if (this.isOperational) return null;
    return failure('', '', `${action}已暂停：${this.operationalBlockReason}`);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** 记录一次载入失败：进入不可操作状态并给出可展示的原因。 */
  private markLoadFailed(error: unknown): void {
    this.loadFailed = true;
    this.loaded = false;
    this.loadFailureMessage =
      `上一次载入读取失败：${error instanceof Error ? error.message : String(error)}。` +
      '在成功载入之前，召回与写入都会保持暂停；把读盘故障当成空库会让删除记录失效。';
    this.stats.conflicts += 0;
  }

  /** 成功读到关键状态后清除载入失败状态。 */
  private clearLoadFailure(): void {
    this.loadFailed = false;
    this.loadFailureMessage = '';
  }

  /** 已加载的全部记忆（只读快照）。 */
  all(): MemoryRecord[] {
    return [...this.records.values()].map(entry => entry.record);
  }

  get(id: string): MemoryRecord | null {
    return this.records.get(id)?.record ?? null;
  }

  getStored(id: string): StoredRecord | null {
    return this.records.get(id) ?? null;
  }

  getByPath(path: string): MemoryRecord | null {
    const id = this.byPath.get(normalizePath(path));
    return id ? (this.records.get(id)?.record ?? null) : null;
  }

  /** 原始文本；供导出与提交前比对。 */
  rawOf(id: string): string | null {
    return this.records.get(id)?.raw ?? null;
  }

  hashOf(id: string): string | null {
    return this.records.get(id)?.hash ?? null;
  }

  tombstone(id: string): Tombstone | undefined {
    return this.tombstones.get(id);
  }

  stateDir(): string {
    return `${this.root}/${STATE_DIR}`;
  }

  /**
   * 状态文件路径。
   *
   * 这里**不能**再走 `resolveInsideRoot`：它会调用 `assertSafeRoot`，
   * 而 `.memory` 是保留目录名（用户不允许把记忆根设成它），
   * 但插件自己的状态目录恰好就叫 `.memory`。根目录本身在构造函数里
   * 已经严格校验过，所以这里只做文件名级别的相对路径校验。
   */
  statePath(name: string): string {
    const safeName = assertSafeRelativePath(name, '状态文件名');
    return `${this.stateDir()}/${safeName}`;
  }

  /**
   * 记录一次外部写事务的落地结果（队列提交用）。
   *
   * 顺序：**先写 Markdown，再写这里**。崩在中间时重放会命中记录并补写回执，
   * 不会产生第二条记忆。写失败只如实报错；正文里的 `event_ids`
   * 仍是创建类操作的兜底幂等索引。
   */
  async rememberTransaction(fingerprint: string, transaction: AppliedTransaction): Promise<boolean> {
    if (typeof fingerprint !== 'string' || fingerprint.trim() === '') return false;
    if (!this.state.applied_operations) this.state.applied_operations = {};
    const existing = this.state.applied_operations[fingerprint];
    if (existing && existing.memory_id !== transaction.memory_id) {
      /**
       * 同一指纹已经有**不同**的落地结果：绝不覆盖既有证据。
       * 覆盖会把一次真实提交从恢复索引里抹掉，重放时就会再执行一次。
       */
      return false;
    }
    this.state.applied_operations[fingerprint] = transaction;
    try {
      await this.persistState();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按来源事件 id 找记忆（创建类操作的**正文级**幂等索引）。
   *
   * 与 `processed_events` 的区别：这里读的是 Markdown 正文里的 `event_ids`，
   * 因此状态文件落后或丢失时依然有效。
   */
  findByEventId(eventId: string): string | null {
    if (typeof eventId !== 'string' || eventId === '') return null;
    return this.eventIndex.get(eventId) ?? null;
  }

  /**
   * 按**路径**找记忆 id。
   *
   * 记忆文件的文件名是「短哈希-标题.md」，不是 id，因此外部入口
   * （CLI/MCP/队列）用路径指认目标时必须由存储层解析出 id：
   * 文件名不是身份，frontmatter 里的 `id` 才是。
   */
  idAtPath(path: string): string | null {
    return this.byPath.get(normalizePath(path)) ?? null;
  }

  /** 查询某个请求指纹是否已经落地过（队列重放恢复用）。 */
  findTransaction(fingerprint: string): AppliedTransaction | null {
    if (typeof fingerprint !== 'string' || fingerprint === '') return null;
    return this.state.applied_operations?.[fingerprint] ?? null;
  }

  /* ---------------- 待审补丁 ---------------- */

  /** 设置补丁落盘回调（插件在构造时注入）。 */
  setPatchPersist(persist: ((body: string) => Promise<boolean>) | null): void {
    this.patchPersist = persist;
  }

  /** 待审补丁里该落盘的状态（供插件写入 Vault）。 */
  patchFileBody(): string {
    return serializePatchFile(this.patches, this.now());
  }

  allPatches(): PendingPatch[] {
    return this.patches.items.map(item => ({ ...item }));
  }

  /** 待审（尚未处理）的补丁。 */
  pendingPatches(): PendingPatch[] {
    return this.patches.items.filter(item => item.status === 'pending').map(item => ({ ...item }));
  }

  patchById(id: string): PendingPatch | null {
    const found = this.patches.items.find(item => item.id === id);
    return found ? { ...found } : null;
  }

  /**
   * 提出一条补丁：**不改动任何记忆文件**。
   *
   * 已确认事实只能这样被 AI / 外部入口“修改”：先落一条待审记录，
   * 由用户对照当前内容与新内容后决定。
   */
  async proposePatch(input: {
    targetId: string;
    fields: PatchFields;
    author: string;
    reason: string;
  }): Promise<{ ok: boolean; id: string; message: string }> {
    if (!this.loaded) await this.loadLocked({});
    const blocked = this.assertOperational('提交待审补丁');
    if (blocked) return { ok: false, id: '', message: blocked.message };
    const stored = this.records.get(input.targetId);
    if (!stored) return { ok: false, id: '', message: `未找到记忆 ${input.targetId}。` };
    if (stored.record.meta.status !== 'confirmed') {
      return {
        ok: false,
        id: '',
        message: '只有已确认事实需要待审补丁；候选（pending）请直接修改或确认。',
      };
    }
    const patch = buildPatch({
      record: stored.record,
      hash: stored.hash,
      fields: input.fields,
      author: input.author,
      reason: input.reason,
      now: this.now(),
    });
    if (!patchHasChanges(patch)) {
      return { ok: false, id: patch.id, message: '补丁里没有实际改动字段，未记录。' };
    }
    const existing = this.patches.items.find(item => item.id === patch.id && item.status === 'pending');
    if (existing) {
      return { ok: true, id: patch.id, message: '同一份补丁已经在等待审核，未重复记录。' };
    }
    this.patches.items = [...this.patches.items.filter(item => item.id !== patch.id), patch];
    const persisted = await this.persistPatchFile();
    return {
      ok: true,
      id: patch.id,
      message: persisted
        ? `已记录待审补丁（${patch.id}）。它不会改动正文，请在界面上对照后接受或忽略。`
        : `已记录待审补丁（${patch.id}），但补丁文件未能落盘；重启后会丢失，请检查写入权限。`,
    };
  }

  /**
   * 接受补丁：用**用户权限**应用，并且带**提议时捕获的**期望哈希。
   *
   * 目标正文在等待审核期间被人工改过时：报冲突、保留补丁与新正文，
   * 让用户重新审核——绝不在接受瞬间偷偷刷新成最新哈希然后覆盖人工编辑。
   */
  async acceptPatch(
    id: string,
    options: { handledBy: string } = { handledBy: 'user' },
  ): Promise<{ ok: boolean; applied: boolean; message: string; note?: string }> {
    if (!this.loaded) await this.loadLocked({});
    const blocked = this.assertOperational('应用待审补丁');
    if (blocked) return { ok: false, applied: false, message: blocked.message };
    const patch = this.patches.items.find(item => item.id === id);
    if (!patch) return { ok: false, applied: false, message: `未找到补丁 ${id}。` };
    if (patch.status !== 'pending') {
      return { ok: false, applied: false, message: `补丁 ${id} 已经处理过（${patch.status}），未重复应用。` };
    }
    const stored = this.records.get(this.idAtPath(patch.target) ?? '');
    if (!stored) {
      patch.status = 'conflict';
      patch.handledAt = new Date(this.now()).toISOString();
      patch.handledBy = options.handledBy;
      patch.note = '目标记忆已不存在（可能已被删除）；补丁保留以便追溯。';
      await this.persistPatchFile();
      return { ok: false, applied: false, message: patch.note };
    }
    const targetId = stored.record.meta.id;
    const currentHash = stored.hash;
    /**
     * 期望值一律使用**提议时捕获的哈希**。人工编辑过就冲突，
     * 而不是把用户看到的旧内容当成当前内容写下去。
     */
    const precondition = patch.capturedHash;
    const result = await this.updateLocked(targetId, {
      actor: 'user',
      reason: `用户接受待审补丁 ${patch.id}（提议者 ${patch.author}）：${patch.reason}`,
      precondition,
      ...(patch.fields.body === undefined ? {} : { body: patch.fields.body }),
      ...(patch.fields.title === undefined ? {} : { title: patch.fields.title }),
      ...(patch.fields.tags === undefined ? {} : { tags: patch.fields.tags }),
      ...(patch.fields.scope === undefined
        ? {}
        : { scope: patch.fields.scope as NonNullable<Parameters<MemoryStore['update']>[1]['scope']> }),
      ...(patch.fields.scopeRef === undefined ? {} : { scopeRef: patch.fields.scopeRef }),
      ...(patch.fields.validUntil === undefined ? {} : { validUntil: patch.fields.validUntil }),
      ...(patch.fields.reviewAfter === undefined ? {} : { reviewAfter: patch.fields.reviewAfter }),
    });
    patch.handledAt = new Date(this.now()).toISOString();
    patch.handledBy = options.handledBy;
    if (result.ok) {
      patch.status = 'accepted';
      patch.note = `已应用（rev ${result.revision}）。`;
      await this.persistPatchFile();
      return { ok: true, applied: true, message: result.message };
    }
    if (result.conflict === true && currentHash !== precondition) {
      /**
       * 冲突：**保留新正文**，把补丁标记为需要重新审核。
       * 这里的 note 明确写出「你看到的版本已经变了」，避免用户以为应用失败是 bug。
       */
      patch.status = 'conflict';
      patch.note =
        `目标内容在你审核期间发生了变化（当前哈希 ${currentHash.slice(0, 12)}…，` +
        `提议时是 ${precondition.slice(0, 12)}…）。补丁未应用，正文未被覆盖；请重新对照后再决定。`;
      await this.persistPatchFile();
      return { ok: false, applied: false, message: `${result.message} ${patch.note}`, note: patch.note };
    }
    patch.status = 'conflict';
    patch.note = result.message;
    await this.persistPatchFile();
    return { ok: false, applied: false, message: result.message, note: result.message };
  }

  /** 忽略补丁：只记录处理状态，不改动记忆。 */
  async ignorePatch(
    id: string,
    options: { handledBy: string } = { handledBy: 'user' },
  ): Promise<{ ok: boolean; message: string }> {
    if (!this.loaded) await this.loadLocked({});
    const patch = this.patches.items.find(item => item.id === id);
    if (!patch) return { ok: false, message: `未找到补丁 ${id}。` };
    if (patch.status !== 'pending') {
      return { ok: false, message: `补丁 ${id} 已经处理过（${patch.status}）。` };
    }
    patch.status = 'ignored';
    patch.handledAt = new Date(this.now()).toISOString();
    patch.handledBy = options.handledBy;
    patch.note = '用户忽略：未改动任何记忆内容。';
    await this.persistPatchFile();
    return { ok: true, message: patch.note };
  }

  /** 读取一个通用状态文件（界面自己的处理状态放这里，不进记忆正文）。 */
  async readStateText(name: string): Promise<string | null> {
    return this.store.readFile(this.statePath(name));
  }

  /** 写入一个通用状态文件（同样的 fail-closed 读取路径）。 */
  async writeStateText(name: string, body: string): Promise<boolean> {
    try {
      await this.writeStateFile(name, body);
      return true;
    } catch {
      return false;
    }
  }

  private async persistPatchFile(): Promise<boolean> {
    const body = this.patchFileBody();
    if (this.patchPersist !== null) {
      try {
        return await this.patchPersist(body);
      } catch {
        return false;
      }
    }
    try {
      await this.writeStateFile(PATCH_FILE, body);
      return true;
    } catch {
      return false;
    }
  }

  /** 读取状态目录里的一个文件。 */
  async readStateFile(name: string): Promise<string | null> {
    return this.store.readFile(this.statePath(name));
  }

  /** 写入状态文件（不做内容比较；状态文件由本实例独占维护）。 */
  async writeStateFile(name: string, content: string): Promise<void> {
    await this.store.ensureDir(this.stateDir());
    await this.store.writeFile(this.statePath(name), content, {});
  }

  /**
   * 从磁盘同步：加载状态与删除标记，扫描记忆文件，更新索引。
   *
   * 任何解析失败都只记录问题，不影响其余记录，也绝不静默清空坏数据。
   */
  async load(options: { force?: boolean } = {}): Promise<SyncReport> {
    return this.mutex.run(() => this.loadLocked(options));
  }

  private async loadLocked(options: { force?: boolean }): Promise<SyncReport> {
    const report: SyncReport = { scanned: 0, valid: 0, invalid: 0, added: 0, updated: 0, removed: 0, problems: [] };
    if (this.loaded && !options.force) return report;

    /**
     * 读盘故障**必须**让存储进入不可操作状态，并且继续抛出：
     * 只抛错而不置位的话，调用方 catch 住之后再查询就会看到一个
     * 「没有删除记录的空库」，用户的遗忘承诺静默失效。
     */
    let rawTombstones: string | null;
    try {
      rawTombstones = await this.store.readFile(this.statePath(TOMBSTONE_FILE));
    } catch (error) {
      this.markLoadFailed(error);
      throw error;
    }
    this.clearLoadFailure();
    const parsedTombstones = parseTombstones(rawTombstones);
    this.tombstoneFile = parsedTombstones.file;
    this.tombstones = TombstoneSet.from(parsedTombstones.file);
    /**
     * **fail-closed**：删除账本读不懂时不能当成“没有删除记录”。
     * 否则同步回来的旧副本会被当作正常记忆召回——用户的遗忘承诺静默失效。
     * 这里保留错误、停止召回与写入，并且**不覆盖**坏文件（它本身就是修复依据）。
     */
    if (parsedTombstones.error) {
      this.tombstonesUnreadable = true;
      this.tombstonesError = parsedTombstones.error;
      report.problems.push({
        path: this.statePath(TOMBSTONE_FILE),
        issues: [
          {
            code: 'bad_frontmatter',
            message: `${parsedTombstones.error}为防止已删除内容复活，召回与写入已暂停；请人工修复该文件后重新加载。`,
            fatal: true,
          },
        ],
      });
    } else {
      this.tombstonesUnreadable = false;
      this.tombstonesError = '';
    }
    let rawState: string | null;
    try {
      rawState = await this.store.readFile(this.statePath('state.json'));
    } catch (error) {
      this.markLoadFailed(error);
      throw error;
    }
    this.state = parseState(rawState);

    /**
     * 待审补丁与用户处理状态：与删除账本同样的 fail-closed 原则。
     * 读不出来时不能当成「没有补丁」，否则用户已经审核过的决定会静默消失。
     */
    try {
      const rawPatches = await this.store.readFile(this.statePath(PATCH_FILE));
      const parsedPatches = parsePatchFile(rawPatches);
      if (parsedPatches.error !== null) {
        this.patchesUnreadable = true;
        this.patchesError = parsedPatches.error;
        report.problems.push({
          path: this.statePath(PATCH_FILE),
          issues: [
            {
              code: 'bad_frontmatter',
              message: `${parsedPatches.error}补丁与用户处理状态无法核验，写入已暂停；请人工修复该文件后重新加载。`,
              fatal: true,
            },
          ],
        });
      } else {
        this.patchesUnreadable = false;
        this.patchesError = '';
        this.patches = parsedPatches.file;
      }
    } catch (error) {
      this.markLoadFailed(error);
      throw error;
    }

    let entries: Awaited<ReturnType<FileStore['listFiles']>>;
    try {
      entries = await this.store.listFiles(this.root, ['.md']);
    } catch (error) {
      this.markLoadFailed(error);
      throw error;
    }
    const seen = new Set<string>();
    const problems: Array<{ path: string; issues: ParseIssue[] }> = [];
    for (const entry of entries.slice(0, this.maxScanFiles)) {
      const rel = normalizePath(entry.path);
      if (isInsideRoot(this.stateDir(), rel)) continue;
      const relativeToRoot = rel.startsWith(`${this.root}/`) ? rel.slice(this.root.length + 1) : rel;
      // 跳过隐藏目录（.obsidian / .trash / 附件夹里的隐藏内容）。
      if (/(^|\/)\.[^/]/.test(relativeToRoot)) continue;
      let raw: string | null;
      try {
        raw = await this.store.readFile(rel);
      } catch (error) {
        /**
         * 单个文件读不出来：这是读盘故障，不是「文件不存在」。
         * 记成 fatal 问题并让整体进入不可操作状态，绝不当作空文件跳过。
         */
        this.markLoadFailed(error);
        problems.push({
          path: rel,
          issues: [
            {
              code: 'unreadable',
              message: `${error instanceof Error ? error.message : String(error)}该文件无法读取，本次载入不完整。`,
              fatal: true,
            },
          ],
        });
        continue;
      }
      if (raw === null) continue;
      report.scanned += 1;
      const parsed = parseMemoryFile(rel, raw);
      if (!parsed.record || !parsed.ok || parsed.record.meta.id === '' || !parsed.record.meta.id.startsWith('mem_')) {
        report.invalid += 1;
        const issues =
          parsed.record && !parsed.record.meta.id.startsWith('mem_')
            ? [
                ...parsed.issues,
                {
                  code: 'missing_id' as const,
                  message: 'id 不是本插件生成的 `mem_` 形式，未按记忆纳入（不会改动该文件）。',
                },
              ]
            : parsed.issues;
        problems.push({ path: rel, issues });
        continue;
      }
      const record = parsed.record;
      const hash = contentHashOf(raw);
      if (record.invalid === true) {
        report.invalid += 1;
        problems.push({
          path: rel,
          issues: [
            ...parsed.issues,
            ...(record.invalidReasons ?? []).map(reason => ({
              code: 'unknown_scope' as const,
              message: reason,
              fatal: true,
            })),
          ],
        });
        continue;
      }
      seen.add(record.meta.id);
      const existing = this.records.get(record.meta.id);
      if (!existing) report.added += 1;
      else if (existing.hash !== hash) report.updated += 1;
      /**
       * 解析侧也把正文两端 trim，与序列化保持一致——
       * 否则往返每多一次就多出一条空行，内容哈希与 revision 都会漂移。
       */
      record.body = record.body.trim();
      this.records.set(record.meta.id, {
        record,
        raw,
        hash,
        issues: parsed.issues,
        unsupportedYaml: parsed.unsupportedYaml,
      });
      this.byPath.set(rel, record.meta.id);
      report.valid += 1;
      if (parsed.issues.length > 0) problems.push({ path: rel, issues: parsed.issues });
    }
    for (const [id, entry] of [...this.records]) {
      if (seen.has(id)) continue;
      this.records.delete(id);
      this.byPath.delete(entry.record.path);
      report.removed += 1;
    }

    /**
     * S4：从正文里的 `event_ids` 重建幂等索引。
     *
     * 只写 Markdown 而状态文件丢失时，这一步让重放仍然幂等；
     * 状态文件里额外的记录作为补充（老数据可能只有状态表有记录）。
     */
    this.eventIndex = new Map<string, string>();
    for (const [id, entry] of this.records) {
      for (const eventId of entry.record.meta.event_ids) {
        if (!this.eventIndex.has(eventId)) this.eventIndex.set(eventId, id);
      }
    }
    for (const [eventId, outcome] of Object.entries(this.state.processed_events)) {
      if (!outcome.memory_id) continue;
      if (this.eventIndex.has(eventId)) continue;
      if (!this.records.has(outcome.memory_id)) continue;
      this.eventIndex.set(eventId, outcome.memory_id);
    }

    // 同一 id 出现在两个路径：保留先出现的，第二条记为问题并排除。
    const pathSeen = new Map<string, string>();
    for (const [id, entry] of this.records) {
      const first = pathSeen.get(id);
      if (first) {
        problems.push({
          path: entry.record.path,
          issues: [{ code: 'missing_id', message: `id ${id} 与 ${first} 重复，本条不参与检索。` }],
        });
      } else {
        pathSeen.set(id, entry.record.path);
      }
    }

    this.loadProblems = problems;
    /**
     * `report.problems` 必须包含**全部**已知问题（解析 + 血缘 + 账本），
     * 不能只放最后一轮收集到的那一份数组。
     */
    /**
     * S3：加载期就检查血缘。来源已经失效的派生记忆会被持久标记为
     * `derived_invalid` 并退出召回——这是重建索引**之前**必须完成的一步。
     */
    await this.markBrokenDependents(report);
    report.problems = [...problems, ...this.lineageProblems, ...this.ledgerProblems()];
    this.rebuildIndex();
    this.loaded = true;
    /**
     * 只有**整轮**载入成功才清除读盘故障状态：中途任何一个文件读不出来，
     * 都已经 `markLoadFailed`，这里不能被后面的成功步骤覆盖。
     */
    if (problems.every(problem => problem.issues.every(issue => !issue.fatal))) {
      this.clearLoadFailure();
    }
    return report;
  }

  /** 仅重建派生索引。 */
  rebuildIndex(): void {
    this.index.rebuild(this.all(), new Set(this.tombstones.ids()));
  }

  /**
   * 全量重建：丢弃内存索引，从权威 Markdown 重新读取。
   * “索引是可重建派生物”的产品承诺就落在这个方法上。
   */
  async rebuild(): Promise<SyncReport> {
    return this.mutex.run(async () => {
      this.loaded = false;
      this.records.clear();
      this.byPath.clear();
      return this.loadLocked({ force: true });
    });
  }

  /**
   * 检索。默认只返回已确认记忆，并且绝不臆造结果。
   *
   * 删除账本不可核验时**直接阻断召回**：账本读不懂就无法判断某条记忆
   * 是不是已经被用户永久删除又同步回来，此时“查得到”就是错误答案。
   */
  async search(query: SearchRequest): Promise<SearchResult> {
    if (!this.loaded) await this.load();
    this.stats.reads += 1;
    /**
     * S05 的第二半：只设标记不算防护。
     *
     * 删除账本损坏时，磁盘上任何一条记忆都可能是“已被用户永久删除、
     * 又被同步/恢复回来的旧副本”。无法区分时唯一诚实的答案是**一条都不返回**，
     * 并把原因说清楚，而不是照常召回。
     */
    if (this.tombstonesUnreadable) {
      return {
        hits: [],
        diagnosis: {
          query: query.text,
          candidates: this.index.size,
          excludedByScope: 0,
          excludedByStatus: 0,
          excludedByDerived: 0,
          excludedByExpired: 0,
          excludedByKind: 0,
          excludedByTag: 0,
          excludedByTerms: 0,
          notes: [
            {
              id: '',
              path: this.statePath(TOMBSTONE_FILE),
              title: '删除账本不可核验',
              code: 'invalid_metadata',
              reason: `${this.tombstonesError}无法判断哪些记忆已被永久删除，因此不返回任何结果；请修复该文件后重新加载。`,
            },
          ],
          elapsedMs: 0,
        },
      };
    }
    return this.index.search(query);
  }

  /**
   * 带过期过滤的检索。
   *
   * 过期闸门本身已经下沉到索引（所有查询形状一致），这里只负责把
   * “退回了多少条”如实报出来，并保留显式包含过期的开关。
   */
  async searchWithExpiry(
    query: SearchRequest & { excludeExpired?: boolean },
  ): Promise<SearchResult & { expiredFiltered: number }> {
    const includeExpired = query.excludeExpired === false || query.includeExpired === true;
    const result = await this.search({ ...query, includeExpired });
    return { ...result, expiredFiltered: result.diagnosis.excludedByExpired };
  }

  /**
   * 显式记住：直接从用户输入落库为 confirmed。
   *
   * 这是唯一会“未经审核”写入 confirmed 的路径，调用者必须先通过护栏检查
   * （`evaluateGuard`），确认这确实是用户的明确命令。
   */
  async remember(draft: MemoryDraft): Promise<CommitResult> {
    return this.mutex.run(() => this.commitLocked(draft, { status: draft.status ?? 'confirmed' }));
  }

  /**
   * AI 或外部会话提出的候选：**永远**进入待确认。
   *
   * 审计复现：`propose({status:'confirmed'})` 曾直接写出 confirmed 记忆——
   * 候选入口可以自报身份与状态，等于绕过了“候选必须经用户确认”。
   * 这里刻意忽略 `draft.status`：外部输入的状态字段不是授权凭据。
   */
  async propose(draft: MemoryDraft): Promise<CommitResult> {
    return this.mutex.run(() => this.commitLocked({ ...draft, status: undefined }, { status: 'pending' }));
  }

  /**
   * 通用提交；状态由**调用方显式**指定。
   *
   * 与 `propose` 的区别是这个入口只允许受信任的本机调用者使用（CLI/MCP 的
   * session-commit、导入流程），并且仍然受“AI 不能自我确认”规则约束：
   * 传入 `confirmed` 时来源种类必须是用户动作（`user_explicit` / `user_selection`），
   * 否则强制降级为 pending。
   */
  async commit(draft: MemoryDraft, policy: { status: MemoryStatus }): Promise<CommitResult> {
    return this.mutex.run(async () => {
      const trusted =
        policy.status === 'pending' ||
        draft.sourceKind === 'user_explicit' ||
        draft.sourceKind === 'user_selection';
      const status: MemoryStatus = trusted ? policy.status : 'pending';
      return this.commitLocked({ ...draft, status: undefined }, { status });
    });
  }

  private async commitLocked(draft: MemoryDraft, policy: { status: MemoryStatus }): Promise<CommitResult> {
    if (!this.loaded) await this.loadLocked({});
    const blocked = this.assertOperational('写入');
    if (blocked) return blocked;

    const eventId = draft.eventId ?? '';
    if (eventId) {
      /**
       * 幂等查询的顺序很关键：**先看在正文里记着事件身份的记录**，
       * 再看状态文件。状态文件可能在“Markdown 已写、状态未写”的崩溃点落后，
       * 只查状态表就会把一次安全重试变成第二条重复事实。
       */
      const knownId = this.eventIndex.get(eventId);
      const previous = this.state.processed_events[eventId];
      const targetId =
        knownId ??
        (previous && previous.memory_id && this.records.has(previous.memory_id) ? previous.memory_id : undefined);
      if (targetId && this.records.has(targetId)) {
        const existing = this.records.get(targetId)!;
        if (!this.eventIndex.has(eventId)) this.eventIndex.set(eventId, targetId);
        return {
          ok: true,
          id: existing.record.meta.id,
          path: existing.record.path,
          revision: existing.record.meta.revision,
          conflict: false,
          changed: false,
          idempotent: true,
          message: `事件 ${eventId} 此前已处理，未重复创建（幂等）。`,
        };
      }
    }

    const body = normalizeBody(draft.body);
    if (body.trim() === '') return failure('', '', '内容为空，未写入。');

    const dedupeKey = computeDedupeKey(draft.sourceKind, draft.sourceRef ?? eventId, body);
    const candidateHash = contentHashOf(body);
    const resurrection = this.tombstones.isResurrection({ dedupeKey, contentHash: candidateHash });
    if (resurrection) {
      return {
        ...failure('', '', '该内容命中一条删除标记，已阻止旧来源复活。若确实要重新记录，请显式说明并新建。'),
        blockedByTombstone: resurrection,
      };
    }

    const title = inferTitle(draft, body);
    const kind = draft.kind ?? 'note';
    const observedAt = draft.observedAt ?? new Date(this.now()).toISOString();
    /**
     * 生成记忆 id。
     *
     * **必须有界**：`while (this.records.has(id))` 这种写法在随机源异常
     * （例如测试替身或宿主一时退化成一个常量）时会变成同步死循环——
     * 事件循环再也回不来，连超时定时器都不会跑，应用表现为“卡死”。
     * 这里最多试 64 次，仍然撞就抛出可诊断的错误，让调用方看到原因。
     */
    const id = this.generateId();
    const path = this.choosePath(kind, title, id);
    const meta: MemoryMeta = {
      id,
      kind,
      status: policy.status,
      scope: draft.scope ?? 'personal',
      scope_ref: draft.scopeRef ?? '',
      source_kind: draft.sourceKind,
      source_ref: draft.sourceRef ?? eventId,
      revision: 1,
      observed_at: observedAt,
      valid_from: draft.validFrom ?? '',
      valid_until: draft.validUntil ?? '',
      supersedes: [],
      derived_from: [],
      review_after: draft.reviewAfter ?? '',
      updated_at: new Date(this.now()).toISOString(),
      tags: draft.tags ?? [],
      aliases: draft.aliases ?? [],
      allow_model: draft.allowModel ?? true,
      dedupe_key: dedupeKey,
      // 事件身份写进权威正文——这是崩溃后可恢复的幂等依据。
      event_ids: eventId ? [eventId] : [],
    };
    const record: MemoryRecord = {
      meta,
      body: renderBody(title, body),
      path,
      sources: draft.sources ?? [],
    };
    const text = serializeMemoryFile(record, {
      changelogLines: [`${meta.updated_at} rev 0 → 1：${describeSource(draft.sourceKind)}写入。`],
    });
    await this.store.ensureDir(dirOf(path));
    const result = await this.store.writeFile(path, text, { expectedHash: null });
    if (result.status === 'conflict') {
      this.stats.conflicts += 1;
      return {
        ...failure(id, path, '目标文件已存在，写入被拒绝（未覆盖任何内容）。'),
        conflict: true,
      };
    }
    this.stats.writes += 1;
    this.records.set(id, { record, raw: text, hash: contentHashOf(text), issues: [], unsupportedYaml: [] });
    this.byPath.set(path, id);
    this.index.add(record, false);
    if (eventId) {
      /**
       * 幂等索引在**内存里先登记**，然后才尝试写状态文件。
       * 状态文件写失败时，本次调用会如实报错；但下一次重放会命中
       * 正文里的 `event_ids`，因此不会产生重复记录。
       */
      this.eventIndex.set(eventId, id);
      this.state.processed_events[eventId] = {
        at: new Date(this.now()).toISOString(),
        memory_id: id,
        action: policy.status === 'pending' ? 'propose' : 'remember',
      };
      await this.persistState();
    }
    return {
      ok: true,
      id,
      path,
      revision: 1,
      conflict: false,
      changed: true,
      contentHash: contentHashOf(text),
      requiresReview: policy.status === 'pending',
      message:
        policy.status === 'pending'
          ? `已保存为待确认候选（${path}），确认后才会进入已确认事实查询。`
          : `已记住：${path}`,
    };
  }

  /**
   * 更新一条记忆的正文/元数据。
   *
   * 关键路径：**先在锁外准备好新内容**（包括任何模型调用），再在写入时比对
   * 磁盘上的当前内容哈希；不一致则冲突终止，绝不覆盖人工编辑。
   */
  async update(id: string, patch: UpdatePatch): Promise<CommitResult> {
    return this.mutex.run(() => this.updateLocked(id, patch));
  }

  private async updateLocked(id: string, patch: UpdatePatch): Promise<CommitResult> {
    if (!this.loaded) await this.loadLocked({});
    /**
     * 门禁放在**入口最前面**，而不是依赖后面某段分支：
     * 只要删除账本不可核验，或者调用者身份是 AI 而目标是已确认事实，
     * 就在这里直接拒绝，绝不进入任何改写路径。
     */
    const blockedWrite = this.assertOperational('更新');
    if (blockedWrite) return blockedWrite;
    const stored = this.records.get(id);
    if (!stored) return failure(id, '', `未找到记忆 ${id}。`);
    const record = cloneRecord(stored.record);
    const before = stored.raw;
    /**
     * 非用户身份（AI / 维护任务）对**已确认事实**的修改，在入口就分两种情况拒绝，
     * 绝不进入任何改写分支。顺序很关键：**先答“内容还是我看到的那份吗”**，
     * 再答“你有没有资格改”。调用方拿到“并发冲突”才会去重新读取；
     * 拿到“没资格”才知道要走候选流程。把两者混成一句都会误导。
     */
    if (patch.actor !== 'user' && stored.record.meta.status === 'confirmed') {
      /**
       * 先读一次磁盘实际字节。缓存可能是旧的，而“用户已经手改过”必须优先于
       * “调用者没有资格”——前者要求重新读取，后者要求换流程。
       * 真正的写入保护仍然由后面 `writeFile` 的比较-写入原子区承担，
       * 这一次读取只为把拒绝理由说准。
       */
      const diskRaw = await this.store.readFile(stored.record.path);
      const diskHash = diskRaw === null ? '' : contentHashOf(diskRaw);
      const viewHash = typeof patch.expectedHash === 'string' ? patch.expectedHash : stored.hash;
      if (diskRaw !== null && viewHash !== diskHash) {
        this.stats.conflicts += 1;
        return {
          ...failure(id, stored.record.path, '内容已被修改（可能是人工编辑或并发写入），本次更新已取消；请重新读取后再提交。'),
          conflict: true,
          conflictHash: stored.hash,
          revision: stored.record.meta.revision,
          requiresReview: true,
        };
      }
      return {
        ...failure(
          id,
          stored.record.path,
          patch.actor === 'ai'
            ? '拒绝 AI 修改已确认记忆：AI 不能改写权威事实。请改为提交待确认候选（propose），由用户确认后生效。'
            : '维护任务不能直接修改已确认记忆的正文或权限，请走候选或用户入口。',
        ),
        requiresReview: true,
      };
    }

    if (patch.body !== undefined) {
      const title = patch.title ?? readTitle(record);
      record.body = renderBody(title, normalizeBody(patch.body));
    } else if (patch.title !== undefined) {
      record.body = renderBody(patch.title, stripTitle(record.body));
    }
    if (patch.tags) record.meta.tags = [...patch.tags];
    if (patch.aliases) record.meta.aliases = [...patch.aliases];
    if (patch.scope) record.meta.scope = patch.scope;
    if (patch.scopeRef !== undefined) record.meta.scope_ref = patch.scopeRef;
    if (patch.validUntil !== undefined) record.meta.valid_until = patch.validUntil;
    if (patch.reviewAfter !== undefined) record.meta.review_after = patch.reviewAfter;
    if (patch.allowModel !== undefined) record.meta.allow_model = patch.allowModel;
    if (patch.sources) record.sources = patch.sources.map(source => ({ ...source }));
    /**
     * S2：AI 不得修改权威事实。
     *
     * 审计复现：`update(id, {body:'AI推断新事实', actor:'ai'})` 直接改写了
     * 一条 confirmed 记录的正文，并且**状态仍是 confirmed**——
     * 也就是未审推断被写成了权威事实。
     *
     * 规则（按顺序判定）：
     * - `actor === 'user'`：用户在 UI/CLI 里的直接动作，允许。
     * - AI 想改一条**尚未确认**的记录：允许（候选本来就要被修来修去）。
     * - AI 想改一条**已确认**记录的语义（正文/标签/别名/范围/有效期、
     *   或任何状态变化、权限放宽）：一律拒绝，并提示走“提议”流程。
     *
     * 不做“悄悄降级成 pending”——那会让一条 confirmed 事实在用户不知情时
     * 改变状态；显式拒绝比静默改写更诚实。
     */
    const actor: 'user' | 'ai' = patch.actor === 'user' ? 'user' : 'ai';
    if (patch.status) {
      // pending 不得通过普通更新路径自动变成 confirmed。
      if (record.meta.status === 'pending' && patch.status !== 'pending' && actor !== 'user') {
        return failure(id, stored.record.path, '待确认记忆只能由用户显式确认或驳回，AI 更新不会自动确认。');
      }
      record.meta.status = patch.status;
    }
    if (actor === 'user' && patch.status === 'confirmed') record.meta.source_kind = 'user_explicit';

    if (!diffDetected({ body: record.body, meta: record.meta, sources: record.sources }, stored.record)) {
      return {
        ok: true,
        id,
        path: stored.record.path,
        revision: stored.record.meta.revision,
        conflict: false,
        changed: false,
        contentHash: stored.hash,
        message: '内容与当前版本一致，未产生变更。',
      };
    }

    const previousRevision = stored.record.meta.revision;
    record.meta.revision = previousRevision + 1;
    record.meta.updated_at = new Date(this.now()).toISOString();
    record.meta.dedupe_key = computeDedupeKey(record.meta.source_kind, record.meta.source_ref, record.body);
    const changelog = [
      `${record.meta.updated_at} rev ${previousRevision} → ${record.meta.revision}：${patch.reason}`,
      ...readChangelogEntries(before),
    ].slice(0, MAX_CHANGELOG_ENTRIES);
    const text = serializeMemoryFile(record, { changelogLines: changelog });

    const expectation: WriteExpectation = {
      /**
       * `precondition` 优先：它是调用方在**审核/展示那一刻**捕获的磁盘哈希，
       * 必须无条件比对。人工编辑过就冲突，不会被「最新哈希」悄悄顶替。
       */
      expectedHash: patch.precondition ?? patch.expectedHash ?? contentHashOf(before),
      expectedRevision: patch.precondition === undefined ? previousRevision : undefined,
    };
    const result = await this.store.writeFile(record.path, text, expectation);
    if (result.status === 'conflict') {
      this.stats.conflicts += 1;
      return this.conflictOutcome(id, stored, result);
    }
    this.stats.writes += 1;
    await this.applyLocalWrite(record, text);
    return {
      ok: true,
      id,
      path: record.path,
      revision: record.meta.revision,
      conflict: false,
      changed: true,
      contentHash: contentHashOf(text),
      message: `已更新到 rev ${record.meta.revision}（${patch.reason}）。`,
    };
  }

  /**
   * 用户明确纠错：立即生效（不进入待确认）。
   * 旧版本退出默认召回，历史保留，可查看前后差异。
   */
  async correct(
    targetId: string,
    input: { replacement: string; reason: string; expectedHash?: string; title?: string },
  ): Promise<CommitResult> {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.loadLocked({});
      if (!this.records.has(targetId)) return failure(targetId, '', `未找到待纠正的记忆 ${targetId}。`);
      return this.updateLocked(targetId, {
        body: input.replacement,
        title: input.title,
        reason: input.reason,
        expectedHash: input.expectedHash,
        status: 'confirmed',
        actor: 'user',
      });
    });
  }

  /** 用一条新记忆替代旧记忆：旧版本标记为 superseded 并退出默认召回。 */
  async supersede(oldId: string, draft: MemoryDraft & { reason: string }): Promise<CommitResult> {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.loadLocked({});
      const old = this.records.get(oldId);
      if (!old) return failure(oldId, '', `未找到被替代的记忆 ${oldId}。`);
      const created = await this.commitLocked(
        {
          ...draft,
          scope: draft.scope ?? old.record.meta.scope,
          scopeRef: draft.scopeRef ?? old.record.meta.scope_ref,
        },
        { status: 'confirmed' },
      );
      if (!created.ok) return created;
      const newStored = this.records.get(created.id);
      if (!newStored) return created;

      const updatedRecord: MemoryRecord = {
        ...cloneRecord(newStored.record),
        meta: {
          ...newStored.record.meta,
          supersedes: [oldId],
          derived_from: [`${oldId}@${old.record.meta.revision}`],
        },
      };
      updatedRecord.meta.revision = newStored.record.meta.revision + 1;
      updatedRecord.meta.updated_at = new Date(this.now()).toISOString();
      const newText = serializeMemoryFile(updatedRecord, {
        changelogLines: [
          `${updatedRecord.meta.updated_at} rev ${newStored.record.meta.revision} → ${updatedRecord.meta.revision}：替代 ${oldId}（${draft.reason}）。`,
          ...readChangelogEntries(newStored.raw),
        ].slice(0, MAX_CHANGELOG_ENTRIES),
      });
      const newWrite = await this.store.writeFile(updatedRecord.path, newText, {
        expectedHash: newStored.hash,
        expectedRevision: newStored.record.meta.revision,
      });
      if (newWrite.status === 'conflict') {
        this.stats.conflicts += 1;
        return {
          ...created,
          conflict: true,
          conflictHash: newWrite.actualHash,
          message: `新记忆已写入，但标注替代关系时检测到并发修改，替代关系未写入：${created.path}`,
        };
      }
      await this.applyLocalWrite(updatedRecord, newText);

      const oldRecord = cloneRecord(old.record);
      oldRecord.meta.status = 'superseded';
      oldRecord.meta.revision += 1;
      oldRecord.meta.updated_at = new Date(this.now()).toISOString();
      const oldText = serializeMemoryFile(oldRecord, {
        changelogLines: [
          `${oldRecord.meta.updated_at} rev ${old.record.meta.revision} → ${oldRecord.meta.revision}：已被 ${created.id} 替代（${draft.reason}）。`,
          ...readChangelogEntries(old.raw),
        ].slice(0, MAX_CHANGELOG_ENTRIES),
      });
      const oldWrite = await this.store.writeFile(oldRecord.path, oldText, {
        expectedHash: old.hash,
        expectedRevision: old.record.meta.revision,
      });
      if (oldWrite.status === 'conflict') {
        this.stats.conflicts += 1;
        return {
          ...created,
          conflict: true,
          message: `新记忆 ${created.id} 已写入，但旧记忆在并发修改后未被标记为已替代，请人工确认。`,
        };
      }
      await this.applyLocalWrite(oldRecord, oldText);
      return {
        ...created,
        revision: updatedRecord.meta.revision,
        message: `已用新记忆 ${created.id} 替代 ${oldId}；旧版本退出默认召回但保留历史。`,
      };
    });
  }

  /** 停止使用一条记忆（遗忘的第一种）：保留历史与文件，但退出召回。 */
  async forget(id: string, options: { reason?: string; expectedHash?: string } = {}): Promise<CommitResult> {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.loadLocked({});
      const stored = this.records.get(id);
      if (!stored) return failure(id, '', `未找到记忆 ${id}。`);
      if (stored.record.meta.status === 'archived') {
        return {
          ok: true,
          id,
          path: stored.record.path,
          revision: stored.record.meta.revision,
          conflict: false,
          changed: false,
          message: '该记忆此前已被遗忘，未重复修改。',
        };
      }
      const result = await this.updateLocked(id, {
        status: 'archived',
        reason: options.reason ?? '用户要求忘记（停止使用，保留历史）',
        actor: 'user',
        expectedHash: options.expectedHash,
        reviewAfter: '',
      });
      if (!result.ok) return result;
      /**
       * S3：来源被遗忘后，从它派生的摘要不能继续被召回。
       * 审计复现：`forget(A)` 之后搜“概要”仍然命中 B（derived_from: A@1），
       * 等于用户的遗忘要求被衍生内容绕开。
       */
      const invalidated = await this.invalidateDependentsCascade(id, `来源 ${id} 已被遗忘（archived）`);
      return {
        ...result,
        message:
          result.message +
          (invalidated > 0 ? `；另有 ${invalidated} 条派生记忆随之退出召回等待复核。` : ''),
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* S3：来源血缘失效                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 解析 `derived_from` 条目（`id@revision` 或纯 `id`）。
   * 返回 null 表示这条血缘记录本身无法解释，不能当作“没有依赖”。
   */
  private parseDerivedRef(entry: string): { id: string; revision: number | null } | null {
    const trimmed = entry.trim();
    if (trimmed === '') return null;
    const at = trimmed.lastIndexOf('@');
    if (at <= 0) return /^mem_[0-9a-f]+$/i.test(trimmed) ? { id: trimmed, revision: null } : null;
    const id = trimmed.slice(0, at).trim();
    const revision = Number(trimmed.slice(at + 1));
    if (!/^mem_[0-9a-f]+$/i.test(id)) return null;
    if (!Number.isFinite(revision)) return { id, revision: null };
    return { id, revision };
  }

  /** 某条记录的依赖是否已经不再可信。 */
  private dependencyBroken(entry: string): { broken: boolean; reason: string } | null {
    const parsed = this.parseDerivedRef(entry);
    if (!parsed) {
      // 无法解释的依赖：保守视为失效，宁可退出召回也不要当成没事。
      return { broken: true, reason: `无法解释的派生来源「${entry}」` };
    }
    const source = this.records.get(parsed.id);
    if (!source) {
      const tombstone = this.tombstones.all().find(item => item.id === parsed.id);
      return {
        broken: true,
        reason: tombstone ? `来源 ${parsed.id} 已被永久删除` : `来源 ${parsed.id} 已不在库中`,
      };
    }
    if (source.record.meta.status === 'archived') {
      return { broken: true, reason: `来源 ${parsed.id} 已被遗忘（archived）` };
    }
    if (source.record.meta.status === 'superseded') {
      return { broken: true, reason: `来源 ${parsed.id} 已被新版本替代` };
    }
    if (source.record.invalid === true) {
      return { broken: true, reason: `来源 ${parsed.id} 的元数据无法安全解释` };
    }
    if (parsed.revision !== null && parsed.revision !== source.record.meta.revision) {
      return {
        broken: true,
        reason: `来源 ${parsed.id} 已从 rev ${parsed.revision} 变更为 rev ${source.record.meta.revision}`,
      };
    }
    return { broken: false, reason: '' };
  }

  /**
   * 加载期检查：把来源已失效的派生记忆标记为 `derived_invalid` 并持久化。
   *
   * 标记**必须写回 frontmatter**，不能只放在内存里：
   * 否则下一次打开插件、或换一个入口（CLI/MCP 新进程）就又会召回它。
   *
   * 只标记、不删除用户独立书写的内容；冲突（并发人工编辑）时放弃本次标记，
   * 留给下一次加载处理，绝不覆盖别人的写入。
   */
  private async markBrokenDependents(report: SyncReport): Promise<void> {
    for (const [id, entry] of [...this.records]) {
      const refs = entry.record.meta.derived_from;
      if (refs.length === 0) continue;
      let reason = '';
      for (const ref of refs) {
        const verdict = this.dependencyBroken(ref);
        if (verdict?.broken) {
          reason = verdict.reason;
          break;
        }
      }
      const already = entry.record.meta.derived_invalid === true;
      if (reason === '') {
        if (!already) continue;
        // 来源恢复健康（例如用户撤销了遗忘）：撤掉标记。
        const healed = cloneRecord(entry.record);
        delete healed.meta.derived_invalid;
        delete healed.meta.derived_invalid_reason;
        healed.meta.revision += 1;
        healed.meta.updated_at = new Date(this.now()).toISOString();
        const text = serializeMemoryFile(healed, {
          changelogLines: [
            `${healed.meta.updated_at} rev ${entry.record.meta.revision} → ${healed.meta.revision}：来源已恢复，派生依赖重新生效。`,
            ...readChangelogEntries(entry.raw),
          ].slice(0, MAX_CHANGELOG_ENTRIES),
        });
        const write = await this.store.writeFile(entry.record.path, text, {
          expectedHash: entry.hash,
          expectedRevision: entry.record.meta.revision,
        });
        if (write.status === 'conflict') continue;
        this.stats.writes += 1;
        this.records.set(id, { record: healed, raw: text, hash: contentHashOf(text), issues: entry.issues, unsupportedYaml: entry.unsupportedYaml });
        this.lineageProblems.push({
          path: entry.record.path,
          issues: [{ code: 'unknown_scope', message: '来源已恢复，已解除派生失效标记。' }],
        });
        continue;
      }
      if (already && entry.record.meta.derived_invalid_reason === reason) {
        this.lineageProblems.push({
          path: entry.record.path,
          issues: [{ code: 'unknown_scope', message: `派生失效（沿用已有标记）：${reason}。本条不参与召回。` }],
        });
        continue;
      }
      const marked = cloneRecord(entry.record);
      marked.meta.derived_invalid = true;
      marked.meta.derived_invalid_reason = reason;
      marked.meta.revision += 1;
      marked.meta.updated_at = new Date(this.now()).toISOString();
      const text = serializeMemoryFile(marked, {
        changelogLines: [
          `${marked.meta.updated_at} rev ${entry.record.meta.revision} → ${marked.meta.revision}：派生来源失效（${reason}），本条退出召回等待复核。`,
          ...readChangelogEntries(entry.raw),
        ].slice(0, MAX_CHANGELOG_ENTRIES),
      });
      const write = await this.store.writeFile(entry.record.path, text, {
        expectedHash: entry.hash,
        expectedRevision: entry.record.meta.revision,
      });
      if (write.status === 'conflict') {
        this.lineageProblems.push({
          path: entry.record.path,
          issues: [{ code: 'unknown_scope', message: `需要标记派生失效（${reason}），但文件已被并发修改，本次跳过。` }],
        });
        continue;
      }
      this.stats.writes += 1;
      this.records.set(id, { record: marked, raw: text, hash: contentHashOf(text), issues: entry.issues, unsupportedYaml: entry.unsupportedYaml });
      report.updated += 1;
      this.lineageProblems.push({
        path: entry.record.path,
        issues: [{ code: 'unknown_scope', message: `派生来源失效：${reason}。本条已退出召回，等待人工复核。` }],
      });
    }
  }

  /**
   * 运行期级联：某条来源刚刚被遗忘/删除/修订变化时，标记它的全部后代。
   * 返回被标记的数量。
   */
  private async invalidateDependentsCascade(sourceId: string, reason: string): Promise<number> {
    let count = 0;
    const queue = [sourceId];
    const visited = new Set<string>([sourceId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [id, entry] of [...this.records]) {
        if (visited.has(id)) continue;
        const depends = entry.record.meta.derived_from.some(ref => this.parseDerivedRef(ref)?.id === current);
        if (!depends) continue;
        visited.add(id);
        if (entry.record.meta.derived_invalid === true && entry.record.meta.derived_invalid_reason === reason) {
          queue.push(id);
          continue;
        }
        const marked = cloneRecord(entry.record);
        marked.meta.derived_invalid = true;
        marked.meta.derived_invalid_reason = reason;
        marked.meta.revision += 1;
        marked.meta.updated_at = new Date(this.now()).toISOString();
        const text = serializeMemoryFile(marked, {
          changelogLines: [
            `${marked.meta.updated_at} rev ${entry.record.meta.revision} → ${marked.meta.revision}：派生来源失效（${reason}），本条退出召回等待复核。`,
            ...readChangelogEntries(entry.raw),
          ].slice(0, MAX_CHANGELOG_ENTRIES),
        });
        const write = await this.store.writeFile(entry.record.path, text, {
          expectedHash: entry.hash,
          expectedRevision: entry.record.meta.revision,
        });
        if (write.status === 'conflict') {
          this.lineageProblems.push({
            path: entry.record.path,
            issues: [{ code: 'unknown_scope', message: `来源 ${current} 已失效，但本条文件被并发修改，未能写入失效标记。` }],
          });
          queue.push(id);
          continue;
        }
        this.stats.writes += 1;
        count += 1;
        this.records.set(id, { record: marked, raw: text, hash: contentHashOf(text), issues: entry.issues, unsupportedYaml: entry.unsupportedYaml });
        this.index.add(marked, false);
        queue.push(id);
      }
    }
    this.invalidatedDerived += count;
    return count;
  }

  /**
   * 永久删除一条记忆（遗忘的第二种）：清除派生缓存并留下不含正文的标记。
   * 历史备份是否清理是另一个范围，这里不做承诺。
   */
  async deletePermanently(
    id: string,
    options: { reason?: Tombstone['reason']; expectedHash?: string } = {},
  ): Promise<CommitResult> {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.loadLocked({});
      const blockedWrite = this.assertOperational('删除');
      if (blockedWrite) return blockedWrite;
      const stored = this.records.get(id);
      if (!stored) return failure(id, '', `未找到记忆 ${id}。`);

      /**
       * S1：删除是破坏性操作，**缓存里的哈希不算证据**。
       *
       * 审计复现：用户手改正文后、缓存尚未同步时，拿着旧哈希的删除请求
       * 仍然成功，把人工新内容删掉了。这里把期望值交给后端，
       * 由后端在自己的原子区内读取**磁盘实际字节**再比较、再删除。
       */
      const expectation =
        options.expectedHash !== undefined
          ? { expectedHash: options.expectedHash, expectedRevision: stored.record.meta.revision }
          : { expectedHash: stored.hash, expectedRevision: stored.record.meta.revision };
      const removal = await this.store.removeFile(stored.record.path, expectation);
      if (removal.status === 'conflict') {
        this.stats.conflicts += 1;
        return {
          ...failure(id, stored.record.path, '磁盘上的内容与提交时看到的不一致（可能有人工编辑或并发写入），删除已取消，未删除任何内容。'),
          conflict: true,
          conflictHash: removal.actualHash,
          revision: stored.record.meta.revision,
        };
      }
      if (removal.status === 'missing') {
        return {
          ...failure(id, stored.record.path, '磁盘上已找不到该文件；本次删除未执行任何写入，请重新加载确认。'),
          conflict: true,
        };
      }

      const tombstone = createTombstone({
        id,
        path: stored.record.path,
        revision: stored.record.meta.revision,
        // 用**磁盘上真实删除掉的那一份**做标记，而不是可能过期的内存副本。
        rawContent: stored.raw,
        dedupeKey: stored.record.meta.dedupe_key,
        reason: options.reason ?? 'user_forget',
        now: this.now(),
      });
      this.tombstones.add(tombstone);
      this.tombstoneFile.items = this.tombstones.all();
      await this.writeStateFile(TOMBSTONE_FILE, serializeTombstones(this.tombstoneFile, this.now()));
      this.records.delete(id);
      this.byPath.delete(stored.record.path);
      this.index.remove(id);
      this.stats.writes += 1;
      /** S3：来源没了，派生内容必须一起退出召回。 */
      const invalidated = await this.invalidateDependentsCascade(id, `来源 ${id} 已被永久删除`);
      return {
        ok: true,
        id,
        path: stored.record.path,
        revision: stored.record.meta.revision,
        conflict: false,
        changed: true,
        tombstoneId: tombstone.id,
        previousHash: sha256Hex(tombstone.content_hash),
        message:
          `已永久删除 ${stored.record.path}，并留下不含正文的删除标记以防止复活。` +
          (invalidated > 0 ? `同时有 ${invalidated} 条派生记忆因来源消失而退出召回，等待复核。` : ''),
      };
    });
  }

  /** 恢复一条被遗忘（archived）的记忆。 */
  async restore(id: string, reason = '用户恢复'): Promise<CommitResult> {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.loadLocked({});
      return this.updateLocked(id, { status: 'confirmed', reason, actor: 'user' });
    });
  }

  /** 确认一条待确认候选。 */
  async confirm(id: string, options: { expectedHash?: string; note?: string } = {}): Promise<CommitResult> {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.loadLocked({});
      if (!this.records.has(id)) return failure(id, '', `未找到记忆 ${id}。`);
      const result = await this.updateLocked(id, {
        status: 'confirmed',
        reason: options.note ?? '用户确认待确认记忆',
        actor: 'user',
        expectedHash: options.expectedHash,
      });
      return { ...result, requiresReview: false };
    });
  }

  /** 驳回一条待确认候选：归档保留，不进入召回。 */
  async reject(id: string, options: { expectedHash?: string; note?: string } = {}): Promise<CommitResult> {
    return this.mutex.run(async () => {
      if (!this.loaded) await this.loadLocked({});
      return this.updateLocked(id, {
        status: 'archived',
        reason: options.note ?? '用户驳回待确认候选（保留历史，不进入召回）',
        actor: 'user',
        expectedHash: options.expectedHash,
      });
    });
  }

  /** 标记为有争议：退出默认召回，但保留在冲突队列里供人工处理。 */
  async dispute(id: string, options: { expectedHash?: string; note: string }): Promise<CommitResult> {
    return this.update(id, {
      status: 'disputed',
      reason: options.note,
      actor: 'user',
      expectedHash: options.expectedHash,
    });
  }

  /**
   * 会话事件批量提交。
   *
   * 每个事件有稳定 `eventId`：重复提交不会重复建条目；已处理的事件只更新游标。
   * 显式命令走 confirmed，其余走 pending。
   */
  async commitSession(events: SessionEvent[]): Promise<{
    results: Array<{ eventId: string; outcome: CommitResult }>;
    cursor: string;
    accepted: number;
    duplicates: number;
    failed: number;
  }> {
    return this.mutex.run(async () => {
      const results: Array<{ eventId: string; outcome: CommitResult }> = [];
      let accepted = 0;
      let duplicates = 0;
      let failed = 0;
      for (const event of events) {
        const draft: MemoryDraft = {
          body: event.text,
          kind: event.kind,
          sourceKind: event.sourceKind,
          sourceRef: event.sourceRef,
          eventId: event.eventId,
          observedAt: event.observedAt,
          sources: event.sources,
          tags: event.tags,
        };
        const outcome = await this.commitLocked(draft, { status: event.explicit ? 'confirmed' : 'pending' });
        results.push({ eventId: event.eventId, outcome });
        if (outcome.idempotent) duplicates += 1;
        else if (outcome.ok && outcome.changed) accepted += 1;
        else if (!outcome.ok) failed += 1;
        if (outcome.ok && event.cursor) {
          this.state.cursor = event.cursor;
          await this.persistState();
        }
      }
      return { results, cursor: this.state.cursor, accepted, duplicates, failed };
    });
  }

  /** 写入处理游标（只越过已可靠记录的结果）。 */
  async setCursor(cursor: string): Promise<void> {
    return this.mutex.run(async () => {
      this.state.cursor = cursor;
      await this.persistState();
    });
  }

  get cursor(): string {
    return this.state.cursor;
  }

  /** 待确认列表。 */
  pending(): MemoryRecord[] {
    return this.all().filter(record => record.meta.status === 'pending');
  }

  /** 统计：用于工作台概览与“未解决问题”面板。 */
  statsSummary(): {
    total: number;
    byStatus: Record<MemoryStatus, number>;
    byKind: Partial<Record<MemoryKind, number>>;
    byScope: Partial<Record<ScopeKind, number>>;
    pending: number;
    expired: number;
    dueReview: number;
    forgotten: number;
    problems: number;
  } {
    const byStatus: Record<MemoryStatus, number> = {
      pending: 0,
      confirmed: 0,
      disputed: 0,
      superseded: 0,
      archived: 0,
    };
    const byKind: Partial<Record<MemoryKind, number>> = {};
    const byScope: Partial<Record<ScopeKind, number>> = {};
    const now = this.now();
    let expired = 0;
    let dueReview = 0;
    for (const record of this.all()) {
      byStatus[record.meta.status] += 1;
      byKind[record.meta.kind] = (byKind[record.meta.kind] ?? 0) + 1;
      byScope[record.meta.scope] = (byScope[record.meta.scope] ?? 0) + 1;
      const until = Date.parse(record.meta.valid_until);
      if (Number.isFinite(until) && until < now) expired += 1;
      const review = Date.parse(record.meta.review_after);
      if (Number.isFinite(review) && review <= now) dueReview += 1;
    }
    return {
      total: this.records.size,
      byStatus,
      byKind,
      byScope,
      pending: byStatus.pending,
      expired,
      dueReview,
      forgotten: this.tombstones.size,
      problems: this.loadProblems.length,
    };
  }

  /** 范围白名单：调用者（CLI/MCP）只能看见被授权的范围。 */
  scopeAllowed(record: MemoryRecord, allowed: ScopeFilter[] | null): boolean {
    if (!allowed || allowed.length === 0) return true;
    for (const filter of allowed) {
      if (record.meta.scope !== filter.scope) continue;
      if (record.meta.scope === 'personal') return true;
      if (!filter.ref || filter.ref === record.meta.scope_ref) return true;
    }
    return false;
  }

  /** 供导入/同步使用的完整快照。 */
  snapshot(): Array<{ id: string; path: string; hash: string; revision: number; status: MemoryStatus }> {
    return this.all().map(record => ({
      id: record.meta.id,
      path: record.path,
      hash: this.hashOf(record.meta.id) ?? '',
      revision: record.meta.revision,
      status: record.meta.status,
    }));
  }

  private async applyLocalWrite(record: MemoryRecord, raw: string): Promise<void> {
    const hash = contentHashOf(raw);
    this.records.set(record.meta.id, { record, raw, hash, issues: [], unsupportedYaml: [] });
    this.byPath.set(record.path, record.meta.id);
    this.index.add(record, this.tombstones.has(record.meta.id));
  }

  /**
   * 取回一条记忆的完整信息，附带“为什么它不在检索里”的诊断。
   * 供工作台回答“这条记忆为什么没被返回”。
   */
  explain(id: string): {
    found: boolean;
    id: string;
    path: string;
    status: string;
    scope: string;
    reasons: string[];
  } {
    const stored = this.records.get(id);
    if (stored) {
      return {
        found: true,
        id,
        path: stored.record.path,
        status: stored.record.meta.status,
        scope: stored.record.meta.scope === 'personal' ? 'personal' : `${stored.record.meta.scope}:${stored.record.meta.scope_ref}`,
        reasons: this.exclusionReasons(stored.record),
      };
    }
    const tombstone = this.tombstones.get(id);
    if (tombstone) {
      return {
        found: false,
        id,
        path: tombstone.path,
        status: 'deleted',
        scope: '',
        reasons: [`已于 ${tombstone.deleted_at} 被永久删除（留下删除标记以防止复活）。`],
      };
    }
    return { found: false, id, path: '', status: '', scope: '', reasons: ['库中不存在该 id。'] };
  }

  private exclusionReasons(record: MemoryRecord): string[] {
    const reasons: string[] = [];
    if (this.tombstones.has(record.meta.id)) reasons.push('命中删除标记，不参与召回。');
    if (record.meta.status === 'pending') reasons.push('状态为 pending（待确认），默认不进入已确认事实查询。');
    if (record.meta.status === 'archived') reasons.push('状态为 archived（已遗忘），不参与召回但保留历史。');
    if (record.meta.status === 'superseded') reasons.push('已被新版本替代，默认不参与召回。');
    if (record.meta.status === 'disputed') reasons.push('存在争议，需人工解决后才回到召回。');
    if (record.meta.scope !== 'personal') {
      reasons.push(`范围是 ${record.meta.scope}:${record.meta.scope_ref || '（未指定）'}，未在查询中被授权。`);
    }
    const until = Date.parse(record.meta.valid_until);
    if (Number.isFinite(until) && until < this.now()) {
      reasons.push(`有效期已于 ${record.meta.valid_until} 结束。`);
    }
    if (record.meta.allow_model === false) reasons.push('allow_model 为 false，不会发送给模型。');
    if (reasons.length === 0) reasons.push('当前条件下可被正常检索。');
    return reasons;
  }

  private conflictOutcome(
    id: string,
    stored: StoredRecord,
    result: Extract<WriteResult, { status: 'conflict' }>,
  ): CommitResult {
    const code =
      result.reason === 'content_changed'
        ? '内容自读取后已被修改（可能是人工编辑），本次写入已取消，建议重新读取后再提交。'
        : result.reason === 'missing'
          ? '文件已不存在，本次写入已取消。'
          : result.reason === 'already_exists'
            ? '目标文件已存在，未覆盖任何内容。'
            : 'revision 与磁盘不一致，本次写入已取消。';
    return {
      ...failure(id, stored.record.path, code),
      conflict: true,
      conflictHash: result.actualHash,
      revision: result.actualRevision ?? stored.record.meta.revision,
    };
  }

  private async persistState(): Promise<void> {
    const text = serializeState(this.state, this.now());
    await this.writeStateFile('state.json', text);
  }

  /** 选择落盘路径：分类目录 + 稳定文件名，冲突时加序号。 */
  private choosePath(kind: MemoryKind, title: string, id: string): string {
    const dir = CATEGORY_DIRS[categoryOf(kind)] ?? CATEGORY_DIRS.inbox!;
    const relativeDir = assertSafeRelativePath(dir, '分类目录');
    const base = memoryFileName(id, title);
    let candidate = `${relativeDir}/${base}`;
    let index = 2;
    while (this.byPath.has(candidate) || this.pathTaken(candidate)) {
      candidate = `${relativeDir}/${base.replace(/\.md$/, '')}-${index}.md`;
      index += 1;
      if (index > 99) break;
    }
    assertNotReserved(candidate);
    return resolveInsideRoot(this.root, candidate, '记忆路径');
  }

  private pathTaken(path: string): boolean {
    for (const entry of this.records.values()) {
      if (entry.record.path === path) return true;
    }
    return false;
  }
}

function defaultState(now: number): StoreState {
  return {
    version: STATE_VERSION,
    processed_events: {},
    applied_operations: {},
    index_version: 1,
    last_sync_at: new Date(now).toISOString(),
    cursor: '',
  };
}

function parseState(raw: string | null): StoreState {
  if (raw === null || raw.trim() === '') return defaultState(Date.now());
  try {
    const parsed = JSON.parse(raw) as Partial<StoreState>;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : STATE_VERSION,
      processed_events:
        parsed.processed_events && typeof parsed.processed_events === 'object' ? parsed.processed_events : {},
      applied_operations:
        parsed.applied_operations && typeof parsed.applied_operations === 'object' ? parsed.applied_operations : {},
      index_version: typeof parsed.index_version === 'number' ? parsed.index_version : 1,
      last_sync_at: typeof parsed.last_sync_at === 'string' ? parsed.last_sync_at : '',
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
    };
  } catch {
    return defaultState(Date.now());
  }
}

function serializeState(state: StoreState, now: number): string {
  return `${JSON.stringify({ ...state, version: STATE_VERSION, last_sync_at: new Date(now).toISOString() }, null, 2)}\n`;
}

function categoryOf(kind: MemoryKind): string {
  switch (kind) {
    case 'preference':
    case 'fact':
      return 'about-me';
    case 'person':
      return 'people';
    case 'project':
    case 'decision':
      return 'projects';
    case 'knowledge':
      return 'knowledge';
    case 'event':
      return 'journal';
    default:
      return 'inbox';
  }
}

function describeSource(kind: SourceKind): string {
  switch (kind) {
    case 'user_explicit':
      return '用户明确要求';
    case 'user_selection':
      return '用户选中内容';
    case 'ai_extraction':
      return 'AI 提取（待确认）';
    case 'session_commit':
      return '会话提交';
    case 'derived':
      return '派生';
    default:
      return '插件维护';
  }
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim();
}

function inferTitle(draft: MemoryDraft, body: string): string {
  if (draft.title && draft.title.trim() !== '') return draft.title.trim();
  const firstLine = body.split('\n').find(line => line.trim() !== '') ?? '';
  const cleaned = firstLine.replace(/^#+\s*/, '').trim();
  if (cleaned !== '' && cleaned.length <= 60) return cleaned;
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : '未命名记忆';
}

function renderBody(title: string, body: string): string {
  const withoutHeading = body.replace(/^\s*#\s+[^\n]*\n?/, '');
  return `# ${title}\n\n${withoutHeading.trim()}`;
}

function stripTitle(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n?/, '').trim();
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

function failure(id: string, path: string, message: string): CommitResult {
  return { ok: false, id, path, revision: 0, conflict: false, changed: false, message };
}

function cloneRecord(record: MemoryRecord): MemoryRecord {
  return {
    path: record.path,
    body: record.body,
    sources: record.sources.map(source => ({ ...source })),
    meta: {
      ...record.meta,
      supersedes: [...record.meta.supersedes],
      derived_from: [...record.meta.derived_from],
      tags: [...record.meta.tags],
      aliases: [...record.meta.aliases],
    },
  };
}

/** 判断一次 patch 是否真的改变了可见内容。 */
function diffDetected(
  next: { body: string; meta: MemoryMeta; sources: SourceRef[] },
  current: MemoryRecord,
): boolean {
  if (next.body.trim() !== current.body.trim()) return true;
  if (next.meta.status !== current.meta.status) return true;
  if (next.meta.scope !== current.meta.scope) return true;
  if (next.meta.scope_ref !== current.meta.scope_ref) return true;
  if (next.meta.valid_until !== current.meta.valid_until) return true;
  if (next.meta.review_after !== current.meta.review_after) return true;
  if (next.meta.allow_model !== current.meta.allow_model) return true;
  if (!sameList(next.meta.tags, current.meta.tags)) return true;
  if (!sameList(next.meta.aliases, current.meta.aliases)) return true;
  if (JSON.stringify(next.sources) !== JSON.stringify(current.sources)) return true;
  return false;
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 便捷再导出：让只用 `store.js` 的调用方也能拿到这些工具。 */
export { slugify, shortHash, extractTitle, splitBody, CHANGELOG_HEADING, STATE_DIR, DEFAULT_ROOT, compareExpectation };
export type { SearchNote, SearchResult, SearchRequest };

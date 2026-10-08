/**
 * 写请求队列服务（插件侧 = 权威提交者）。
 *
 * 外部入口（CLI / MCP）把请求写进 `<记忆根>/.memory/requests/`。
 * 这里是唯一真正提交 Markdown 的地方：用 `Vault.process` 的同步回调
 * 比较当前原文，冲突就拒绝，然后写回执。
 *
 * ## 路径（只有一种写法）
 *
 * 本服务内部一律使用**含记忆根**的 Vault 相对路径
 * （`Brain/.memory/requests/req_x.md`），与 `VaultFileStore`/核心完全一致。
 * 需要「相对记忆根」的地方（`store.create`/`vault.create` 等接受
 * `resolveInsideRoot(root, rel)` 的 API）用 `stripMemoryRoot` 降级一次，
 * 降级同样会做越界与 `..` 校验。
 *
 * ## 处理顺序（崩溃安全）
 *
 * 1. **认领**：`adapter.rename` 把请求改名成 `xxx.md.claimed.<owner>.md`。
 *    这是文件系统级的原子动作，两个提交者不会处理同一条。
 * 2. **提交**：走核心的提交入口（内部仍是 `Vault.process` 比较-写入）。
 *    提交前先问「这次提交是不是已经发生过」（持久事务标记），
 *    因此崩在「提交成功」与「回执落盘」之间时不会产生第二条记忆。
 * 3. **回执先落地**：回执写成功之后才删除请求。
 *    反过来（先删请求再写回执）会在崩溃时留下「请求没了、回执也没有」的黑洞。
 *
 * 认领过的请求如果一直没被处理（插件崩溃），下次启动时会**接着处理**：
 * 处理顺序是先认领、再提交、再回执、最后删请求，因此认领态本身是可恢复的。
 */

import type { App } from 'obsidian';
import {
  QUEUE_PROTOCOL_VERSION,
  assertVaultRelativePath,
  claimedPath,
  findExistingReceipt,
  isClaimedRequestPath,
  isReceiptPath,
  isRequestPath,
  makeRequestId,
  parseReceipt,
  parseRequestEnvelope,
  processRequest,
  RECEIPT_DIR,
  receiptDirPath,
  receiptPath,
  requestDirPath,
  requestFingerprint,
  requestIdFromPath,
  requestPath,
  serializeReceipt,
  serializeRequest,
  validateReceipt,
  validateRequest,
  type CommitOutcome,
  type ProcessResult,
  type QueueReceipt,
  type QueueRequest,
  type ReceiptStatus,
} from '@mom/core';
import type { VaultFileStore } from './vault-store.js';

export interface QueueCommitHandler {
  /** 提交一条请求；实现里必须保证「比较-提交」在同一原子区。 */
  commit: (request: QueueRequest) => Promise<CommitOutcome>;
  /** 从持久事务标记恢复一次已经发生的提交；无法确认时返回 null。 */
  findCommitted?: (request: QueueRequest) => Promise<CommitOutcome | null>;
}

export interface QueueServiceOptions {
  app: App;
  store: VaultFileStore;
  /** 记忆根目录（Vault 相对路径）；必须与核心使用同一个值。 */
  memoryRoot: string;
  /** 提交者身份（写进回执，便于对账）。 */
  owner: string;
  now: () => number;
  random: () => number;
  commit: QueueCommitHandler['commit'];
  findCommitted?: QueueCommitHandler['findCommitted'];
  /** 默认请求存活期。 */
  ttlMs?: number;
}

export interface QueueScanResult {
  /** 本次真正处理过的请求。 */
  processed: QueueReceipt[];
  /** 因为已有回执而跳过的请求（幂等命中）。 */
  skipped: QueueReceipt[];
  /** 结构不合法、无法处理的文件。 */
  malformed: Array<{ path: string; errors: string[] }>;
  /** 回执没能落盘、请求被保留的条目。 */
  retained: Array<{ requestId: string; reason: string }>;
  /** 回执写失败但请求已被认领、留在原地待重试的条目。 */
  deferred: Array<{ requestId: string; path: string; reason: string }>;
}

export class QueueService {
  private readonly app: App;
  private readonly store: VaultFileStore;
  private readonly root: string;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly commit: QueueCommitHandler['commit'];
  private readonly findCommitted: QueueCommitHandler['findCommitted'];
  private readonly ttlMs: number;
  /** 进程内防重入：同一时刻只跑一次扫描。 */
  private scanning: Promise<QueueScanResult> | null = null;

  /**
   * 队列此刻是否正在处理请求。
   *
   * 索引刷新用它来决定「能不能现在重载」：提交过程中的中间态不应该被读进内存。
   * 这是给调用方的只读观察，不是锁——不要在它上面做互斥。
   */
  busy(): boolean {
    return this.scanning !== null || this.handling > 0;
  }

  /** 正在提交的请求数（提交是同步 CAS，但前后有异步落盘与回执）。 */
  private handling = 0;

  constructor(options: QueueServiceOptions) {
    this.app = options.app;
    this.store = options.store;
    this.root = assertVaultRelativePath(options.memoryRoot, options.memoryRoot, '记忆根目录');
    this.owner = options.owner;
    this.now = options.now;
    this.random = options.random;
    this.commit = options.commit;
    this.findCommitted = options.findCommitted;
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  get memoryRoot(): string {
    return this.root;
  }

  /** 请求目录（含记忆根）。 */
  get requestsDir(): string {
    return requestDirPath(this.root);
  }

  /** 回执目录（含记忆根）。 */
  get receiptsDir(): string {
    return receiptDirPath(this.root);
  }

  /**
   * 入队：把请求持久落盘。返回 `accepted`（**不等于**已提交）。
   *
   * 校验在**写盘之前**做：非法请求不会被写进队列，
   * 也不会在提交端才被发现是坏信封。
   */
  async enqueue(
    request: Omit<QueueRequest, 'protocol' | 'id' | 'createdAt' | 'expiresAt'> & {
      id?: string;
      ttlMs?: number;
    },
  ): Promise<{ accepted: boolean; requestId: string; path: string; fingerprint: string; error?: string }> {
    const id = request.id ?? makeRequestId(this.now(), this.random);
    const createdAt = new Date(this.now()).toISOString();
    const ttl = request.ttlMs ?? this.ttlMs;
    const full: QueueRequest = {
      protocol: QUEUE_PROTOCOL_VERSION,
      id,
      operation: request.operation,
      payload: request.payload,
      target: request.target,
      expectedHash: request.expectedHash,
      expectedRevision: request.expectedRevision,
      requester: request.requester,
      createdAt,
      expiresAt: new Date(this.now() + ttl).toISOString(),
      idempotencyKey: request.idempotencyKey,
    };
    const validation = validateRequest(full, { root: this.root });
    const fingerprint = validation.ok ? requestFingerprint(full) : '';
    if (!validation.ok) {
      return {
        accepted: false,
        requestId: id,
        path: '',
        fingerprint,
        error: `请求不合法，未入队：${validation.errors.join('；')}`,
      };
    }

    let relative: string;
    try {
      relative = requestPath(this.root, id);
    } catch (error) {
      return {
        accepted: false,
        requestId: id,
        path: '',
        fingerprint,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      await this.store.ensureDir(this.requestsDir);
      const existingRaw = await this.store.readFile(relative);
      if (existingRaw !== null) {
        /**
         * 同 id 的请求已经存在：只在**指纹完全相同**时才算重复入队成功
         * （调用方重发同一条请求）。内容不同必须报错，绝不覆盖。
         */
        const parsed = parseRequestEnvelope(existingRaw, { root: this.root });
        if (parsed.request !== null && requestFingerprint(parsed.request) === fingerprint) {
          return { accepted: true, requestId: id, path: relative, fingerprint };
        }
        return {
          accepted: false,
          requestId: id,
          path: relative,
          fingerprint,
          error: '同一 requestId 已有不同内容的请求，拒绝覆盖；请换一个 requestId。',
        };
      }
      await this.app.vault.create(relative, serializeRequest(full));
      return { accepted: true, requestId: id, path: relative, fingerprint };
    } catch (error) {
      return {
        accepted: false,
        requestId: id,
        path: relative,
        fingerprint,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 读取全部回执（用于对账与「我的请求怎么样了」）。 */
  async readReceipts(): Promise<QueueReceipt[]> {
    const receipts: QueueReceipt[] = [];
    const files = await this.store.listFiles(this.receiptsDir, ['.md']);
    for (const file of files) {
      if (!isReceiptPath(this.root, file.path)) continue;
      const raw = await this.store.readFile(file.path);
      if (raw === null) continue;
      const parsed = parseReceipt(raw, { root: this.root });
      if (parsed.receipt !== null) receipts.push(parsed.receipt);
    }
    return receipts;
  }

  /**
   * 读取一条回执。
   *
   * 坏回执**不返回**：它不能作为幂等依据，也不能让调用方以为成功了。
   */
  async readReceipt(requestId: string): Promise<{ receipt: QueueReceipt | null; errors: string[] }> {
    let relative: string;
    try {
      relative = receiptPath(this.root, requestId);
    } catch (error) {
      return { receipt: null, errors: [error instanceof Error ? error.message : String(error)] };
    }
    const raw = await this.store.readFile(relative);
    if (raw === null) return { receipt: null, errors: [] };
    return parseReceipt(raw, { root: this.root });
  }

  /**
   * 等待某条请求的回执出现；超时返回 null（**不**代表失败）。
   *
   * 超时是有意义的独立结果：请求可能还排在队列里，也可能提交者没运行。
   * 调用方必须自己区分，界面文案也要说清楚。
   */
  async waitForReceipt(requestId: string, timeoutMs: number): Promise<QueueReceipt | null> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const { receipt } = await this.readReceipt(requestId);
      if (receipt !== null) return receipt;
      if (this.now() > deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /** 待处理请求（含上次崩溃留下的认领态）。 */
  async listPending(): Promise<Array<{ path: string; claimed: boolean }>> {
    const files = await this.store.listFiles(this.requestsDir, ['.md']);
    const out: Array<{ path: string; claimed: boolean }> = [];
    for (const file of files) {
      if (!isRequestPath(this.root, file.path)) continue;
      out.push({ path: file.path, claimed: isClaimedRequestPath(this.root, file.path) });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /**
   * 扫描并处理一次队列。
   *
   * 幂等：同一时刻只跑一次；已有回执（且指纹一致）的请求直接跳过。
   */
  async processOnce(): Promise<QueueScanResult> {
    if (this.scanning !== null) return this.scanning;
    const run = this.processOnceInternal();
    this.scanning = run;
    try {
      return await run;
    } finally {
      this.scanning = null;
    }
  }

  private async processOnceInternal(): Promise<QueueScanResult> {
    const result: QueueScanResult = { processed: [], skipped: [], malformed: [], retained: [], deferred: [] };
    const receipts = await this.readReceipts();
    this.setReceiptsSnapshot(receipts);
    try {
      return await this.scanWithReceipts(result, receipts);
    } finally {
      this.receiptsCache = null;
    }
  }

  private async scanWithReceipts(result: QueueScanResult, receipts: QueueReceipt[]): Promise<QueueScanResult> {
    const pending = await this.listPending();
    for (const entry of pending) {
      const raw = await this.store.readFile(entry.path);
      if (raw === null) continue;
      const parsed = parseRequestEnvelope(raw, { root: this.root });
      if (parsed.request === null) {
        result.malformed.push({ path: entry.path, errors: parsed.errors });
        continue;
      }
      const request = parsed.request;
      /**
       * 文件名与信封 id 必须一致。请求 id 是队列的持久身份：
       * 两者不一致时回执会写到另一个名字下，重放判定也会错位，
       * 因此直接按「结构不合法」处理并保留文件，绝不猜哪个才是真身。
       */
      const fileId = requestIdFromPath(this.root, entry.path);
      if (fileId !== request.id) {
        result.malformed.push({
          path: entry.path,
          errors: [
            `文件名与信封 id 不一致：文件名推出「${fileId ?? '（无法识别）'}」，信封写的是「${request.id}」。`,
          ],
        });
        continue;
      }
      const existing = findExistingReceipt(receipts, request);
      if (existing.kind === 'found') {
        /**
         * 已有回执且指纹一致：这条请求已经处理过（可能上次崩溃在删请求之前）。
         * 回执是权威记录，请求可以清掉。
         */
        await this.store.removeFile(entry.path, {}).catch(() => undefined);
        result.skipped.push(existing.receipt);
        continue;
      }
      if (existing.kind === 'fingerprint_mismatch') {
        /**
         * 同名不同内容：绝不静默当作已处理，也绝不覆盖。交给状态机写冲突回执。
         */
        const outcome = await this.withHandling(() => this.handle(request, entry.path, entry.claimed));
        this.collect(result, request, outcome);
        continue;
      }
      const outcome = await this.withHandling(() => this.handle(request, entry.path, entry.claimed));
      this.collect(result, request, outcome);
    }
    return result;
  }

  /** 把一次提交标记为「处理中」，供索引刷新判断能否安全重载。 */
  private async withHandling<T>(work: () => Promise<T>): Promise<T> {
    this.handling += 1;
    try {
      return await work();
    } finally {
      this.handling -= 1;
    }
  }

  private collect(
    result: QueueScanResult,
    request: QueueRequest,
    outcome: { receipt: QueueReceipt | null; receiptDurable: boolean; idempotent: boolean; recovered: boolean; claimedPath: string | null },
  ): void {
    if (outcome.receipt === null) {
      result.deferred.push({
        requestId: request.id,
        path: outcome.claimedPath ?? '',
        reason: '认领失败，请求留在原地等待下一轮。',
      });
      return;
    }
    if (!outcome.receiptDurable) {
      result.retained.push({
        requestId: request.id,
        reason: '回执未能落盘，请求被保留以便重试。',
      });
      return;
    }
    if (outcome.idempotent) result.skipped.push(outcome.receipt);
    else result.processed.push(outcome.receipt);
  }

  private async handle(
    request: QueueRequest,
    relative: string,
    alreadyClaimed: boolean,
  ): Promise<{
    receipt: QueueReceipt | null;
    receiptDurable: boolean;
    idempotent: boolean;
    recovered: boolean;
    claimedPath: string | null;
  }> {
    let claimRelative = relative;
    if (!alreadyClaimed) {
      try {
        claimRelative = claimedPath(this.root, relative, this.owner);
        await this.store.rename(relative, claimRelative);
      } catch (error) {
        return {
          receipt: null,
          receiptDurable: false,
          idempotent: false,
          recovered: false,
          claimedPath: null,
        };
      }
    }

    const outcome: ProcessResult = await processRequest(request, {
      now: this.now,
      committedBy: this.owner,
      root: this.root,
      findReceipt: current => findExistingReceipt(this.receiptsCache ?? [], current),
      findCommitted:
        this.findCommitted === undefined
          ? undefined
          : async current => (await this.findCommitted!(current)) ?? null,
      commit: this.commit,
      writeReceipt: async receipt => this.writeReceipt(receipt),
    });

    if (outcome.receiptDurable && outcome.receipt !== null) {
      /**
       * 回执落地之后才删请求。删除失败也没关系：
       * 下一轮会因为「已有回执」而把残留请求清掉，不会重复提交。
       */
      await this.store.removeFile(claimRelative, {}).catch(() => undefined);
    }
    return {
      receipt: outcome.receipt,
      receiptDurable: outcome.receiptDurable,
      idempotent: outcome.idempotent,
      recovered: outcome.recovered,
      claimedPath: claimRelative,
    };
  }

  /** 扫描开始时读到的回执集合（避免每条请求都重新枚举目录）。 */
  private receiptsCache: QueueReceipt[] | null = null;

  /**
   * 写回执。
   *
   * 已有回执时**必须读取并比对**：只有指纹相同才算「已经写过」；
   * 内容不同或回执本身不合法时返回 false，让请求留在队列里等人看见。
   */
  private async writeReceipt(receipt: QueueReceipt): Promise<boolean> {
    const validation = validateReceipt(receipt, { root: this.root });
    if (!validation.ok) return false;
    let relative: string;
    try {
      relative = receiptPath(this.root, receipt.requestId);
    } catch {
      return false;
    }
    const serialized = serializeReceipt(receipt);
    try {
      await this.store.ensureDir(this.receiptsDir);
      const existing = await this.store.readFile(relative);
      if (existing === null) {
        await this.app.vault.create(relative, serialized);
        return true;
      }
      const parsed = parseReceipt(existing, { root: this.root });
      if (parsed.receipt !== null && parsed.receipt.fingerprint === receipt.fingerprint) {
        // 回执只写一次；内容完全一致时视为已经落地，不覆盖。
        return true;
      }
      /**
       * 已有回执但指纹不同：回执是**只读证据**，绝对不能覆盖。
       *
       * 但也不能就此返回 false——那会让这条请求永远处理不完（回执写不进去，
       * 请求又不敢删）。正确的做法是把这次冲突**另存为一份争议证据**：
       * 原回执保持不动，冲突现场可见，请求留在原地等人工处理。
       */
      const dispute = receiptPath(this.root, receipt.requestId).replace(
        /\.md$/,
        `.conflict.${this.now()}.md`,
      );
      const note = [
        serializeReceipt(receipt),
        '',
        '## 为什么另存',
        '',
        '同名请求此前已有一份**指纹不同**的回执。回执是只读证据，本插件不会覆盖它。',
        `已有指纹：${parsed.receipt?.fingerprint ?? '（原回执无法解析）'}`,
        `本次指纹：${receipt.fingerprint}`,
        '',
        '请人工判断：要么换一个 requestId 重新排队，要么确认原回执才是想要的。',
        '',
      ].join('\n');
      await this.app.vault.create(dispute, note);
      return false;
    } catch {
      return false;
    }
  }

  /** 内部：给一次扫描设置回执快照（避免每条请求都重新枚举目录）。 */
  private setReceiptsSnapshot(receipts: QueueReceipt[]): void {
    this.receiptsCache = receipts;
  }

  /** 供 UI：队列概览。 */
  async overview(): Promise<{
    pending: number;
    claimed: number;
    receipts: number;
    offIndex: string[];
    listingMode: string;
  }> {
    const pending = await this.listPending();
    const receipts = await this.readReceipts();
    return {
      pending: pending.filter(entry => !entry.claimed).length,
      claimed: pending.filter(entry => entry.claimed).length,
      receipts: receipts.length,
      offIndex: this.store.offIndex,
      listingMode: this.store.listingMode,
    };
  }
}

/** 供 UI 展示：状态的中文标签与是否算「成功」。 */
export const RECEIPT_LABELS: Record<ReceiptStatus, string> = {
  completed: '已提交',
  conflict: '冲突（未提交）',
  failed: '失败（未提交）',
  expired: '已过期（未提交）',
};

/** 该回执是否代表记忆真的变了。 */
export function receiptIsCommit(status: ReceiptStatus): boolean {
  return status === 'completed';
}

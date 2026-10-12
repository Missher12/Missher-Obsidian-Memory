/**
 * 把队列表里的操作载荷翻译成核心 API 调用。
 *
 * 队列里的载荷是**外部输入**，与模型输出同级：它可以来自 CLI、脚本或
 * MCP 客户端。因此这里的规则是**先校验、再执行**，任何类型不对、
 * 缺失或越界的字段都变成 `failed` 回执，而不是猜测默认值。
 *
 * ## 身份与权限（本轮的关键修正）
 *
 * - **队列请求 = 用户在别处的明确请求**，因此它可以使用用户入口的语义，
 *   但必须**同时**满足两个保护条件：目标明确、且带上 `expectedHash`。
 *   期望值缺一不可——「不管现在是什么都改」不是用户的明确请求。
 * - 外部入口仍然**不能**做 AI 也不能做的事：把候选直接标成 confirmed。
 * - `update` 走 `store.update`（actor `user`，因为它是显式用户请求，
 *   并且有期望值保护）；`correct` 走 `store.correct`（受保护的显式更正）。
 *   两条路径都由 `Vault.process` 的同步比较兜底：人工编辑不会被覆盖。
 *
 * ## 持久幂等（不许靠可选字段）
 *
 * - 创建类操作把 `请求 id` 映射成稳定的 `eventId`（`queue:<requestId>`），
 *   核心在**正文的 `event_ids`** 里记着它，因此重放不会产生第二条记忆；
 * - 所有操作在成功后把「这一次提交」写进核心的持久事务表
 *   （`rememberTransaction`），`findCommitted` 可以在回执丢失时恢复结果，
 *   而不是再执行一遍副作用；
 * - 回执带**真实落地证据**：内容哈希 + revision，或删除标记 + 被删内容哈希。
 */

import type {
  CommitOutcome,
  MemoryDraft,
  MemoryStore,
  QueueRequest,
  ReceiptEvidence,
  SessionEvent,
  SourceRef,
} from '@mom/core';
import { evaluateGuard, requestFingerprint, sha256Hex } from '@mom/core';

/** 载荷取值助手：类型不对就记一条错误，绝不静默兜底。 */
class PayloadReader {
  readonly errors: string[] = [];
  private readonly payload: Record<string, unknown>;

  constructor(payload: Record<string, unknown>) {
    this.payload = payload;
  }

  /** 原始取值（结构复杂的字段自己校验，例如 events 数组）。 */
  raw(key: string): unknown {
    return this.payload[key];
  }

  string(key: string, options: { required?: boolean; maxLength?: number } = {}): string | undefined {
    const value = this.payload[key];
    if (value === undefined || value === null) {
      if (options.required) this.errors.push(`缺少必填字段 ${key}`);
      return undefined;
    }
    if (typeof value !== 'string') {
      this.errors.push(`字段 ${key} 必须是字符串`);
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      if (options.required) this.errors.push(`字段 ${key} 不能为空`);
      return undefined;
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      this.errors.push(`字段 ${key} 超过长度上限 ${options.maxLength}`);
      return undefined;
    }
    return value;
  }

  stringAlias(keys: readonly string[], options: { required?: boolean; maxLength?: number } = {}): string | undefined {
    for (const key of keys) {
      const value = this.string(key, options);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** 布尔别名取值：两个键都给了就必须一致，否则记一条错误（不做「后者覆盖前者」的隐式选择）。 */
  booleanAlias(keys: readonly string[]): boolean | undefined {
    const values = keys.map(key => this.boolean(key)).filter((value): value is boolean => value !== undefined);
    if (values.length === 0) return undefined;
    if (values.some(value => value !== values[0])) {
      this.errors.push(`${keys.join(' / ')} 给出了互相矛盾的取值。`);
      return undefined;
    }
    return values[0];
  }

  boolean(key: string): boolean | undefined {
    const value = this.payload[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
      this.errors.push(`字段 ${key} 必须是布尔值`);
      return undefined;
    }
    return value;
  }

  stringList(key: string): string[] | undefined {
    const value = this.payload[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      this.errors.push(`字段 ${key} 必须是字符串数组`);
      return undefined;
    }
    return value as string[];
  }

  sourceList(key: string): SourceRef[] | undefined {
    const value = this.payload[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      this.errors.push(`字段 ${key} 必须是数组`);
      return undefined;
    }
    const out: SourceRef[] = [];
    for (const item of value) {
      if (item === null || typeof item !== 'object') {
        this.errors.push(`字段 ${key} 的条目必须是对象`);
        return undefined;
      }
      const raw = item as Record<string, unknown>;
      if (typeof raw.kind !== 'string' || typeof raw.ref !== 'string') {
        this.errors.push(`字段 ${key} 的条目缺少 kind/ref`);
        return undefined;
      }
      out.push({
        kind: raw.kind as SourceRef['kind'],
        ref: raw.ref,
        observed_at: typeof raw.observed_at === 'string' ? raw.observed_at : '',
        excerpt: typeof raw.excerpt === 'string' ? raw.excerpt : '',
      });
    }
    return out;
  }
}

const MEMORY_ID = /^mem_[0-9a-zA-Z_]{4,40}$/;

/** 操作结果里的落地信息（核心的 `CommitResult` 是它的超集）。 */
interface LandingResult {
  ok: boolean;
  id: string;
  path: string;
  revision: number;
  conflict: boolean;
  changed: boolean;
  message: string;
  requiresReview?: boolean;
  conflictHash?: string;
  contentHash?: string;
  tombstoneId?: string;
  previousHash?: string;
}

/* ------------------------------------------------------------------ *
 * 持久幂等身份
 * ------------------------------------------------------------------ */

/**
 * 把请求 id 映射成稳定的来源事件 id。
 *
 * 这是创建类操作的**持久**幂等身份：它写进记忆正文的 `event_ids`，
 * 因此即使状态文件落后、插件重启，重放同一条请求也不会产生第二条记忆。
 * 刻意不依赖调用方自报的 `payload.event_id`。
 */
export function queueEventId(requestId: string): string {
  return `queue:${requestId}`;
}

/** 事务指纹：与请求指纹同源，用于核心的持久事务表。 */
export function queueTransactionFingerprint(request: QueueRequest): string {
  return requestFingerprint(request);
}

/** 由请求构造 `MemoryDraft`；来源种类固定为 `user_explicit`（队列=用户入口）。 */
function draftFrom(request: QueueRequest, reader: PayloadReader): MemoryDraft | null {
  const body = reader.string('body', { required: true, maxLength: 200_000 });
  if (body === undefined) return null;
  const draft: MemoryDraft = {
    body,
    sourceKind: 'user_explicit',
    sourceRef: reader.stringAlias(['source_ref', 'sourceRef']) ?? `queue:${request.requester}`,
    /** 持久幂等身份：请求 id 优先，绝不被调用方自报的事件 id 顶掉。 */
    eventId: queueEventId(request.id),
  };
  const title = reader.string('title', { maxLength: 300 });
  if (title !== undefined) draft.title = title;
  const kind = reader.string('kind');
  if (kind !== undefined) draft.kind = kind as MemoryDraft['kind'];
  const category = reader.string('category');
  if (category !== undefined) draft.category = category as MemoryDraft['category'];
  const scope = reader.string('scope');
  if (scope !== undefined) draft.scope = scope as MemoryDraft['scope'];
  const scopeRef = reader.stringAlias(['scope_ref', 'scopeRef']);
  if (scopeRef !== undefined) draft.scopeRef = scopeRef;
  const tags = reader.stringList('tags');
  if (tags !== undefined) draft.tags = tags;
  const aliases = reader.stringList('aliases');
  if (aliases !== undefined) draft.aliases = aliases;
  const validUntil = reader.stringAlias(['valid_until', 'validUntil']);
  if (validUntil !== undefined) draft.validUntil = validUntil;
  const reviewAfter = reader.stringAlias(['review_after', 'reviewAfter']);
  if (reviewAfter !== undefined) draft.reviewAfter = reviewAfter;
  const allowModel = reader.booleanAlias(['allow_model', 'allowModel']);
  if (allowModel !== undefined) draft.allowModel = allowModel;
  const sources = reader.sourceList('sources');
  if (sources !== undefined) draft.sources = sources;
  return draft;
}

/** 目标路径里的文件主名就是记忆 id（`mem_xxx.md`）。 */
function memoryIdFromTarget(target: string): string | null {
  const base = target.split('/').pop() ?? '';
  if (!base.endsWith('.md')) return null;
  const id = base.slice(0, -3);
  return MEMORY_ID.test(id) ? id : null;
}

/**
 * 解析操作目标。
 *
 * 路径是**权威**的（它指向真实文件），载荷里的 `id` 只作为一致性检查：
 * 两者都给出且不一致时拒绝，而不是随便挑一个。
 *
 * 注意：记忆文件名是「短哈希-标题.md」，**不是** id，因此路径优先交给
 * 存储层按 frontmatter 解析（`idAtPath`）；只有在解析不到时才退回
 * 「文件名就是 mem_xxx」这种老式命名。
 */
async function resolveTarget(
  store: MemoryStore,
  request: QueueRequest,
  reader: PayloadReader,
): Promise<{ id: string | null; error: string | null }> {
  let fromTarget: string | null = null;
  if (request.target !== '') {
    fromTarget = store.idAtPath(request.target);
    if (fromTarget === null) fromTarget = memoryIdFromTarget(request.target);
  }
  const fromPayload = reader.string('id');
  if (fromPayload !== undefined && !MEMORY_ID.test(fromPayload)) {
    return { id: null, error: `载荷里的 id 形状不对（应为 mem_xxxxxxxx）：${fromPayload}` };
  }
  if (fromTarget !== null && fromPayload !== undefined && fromTarget !== fromPayload) {
    return {
      id: null,
      error: `target（${fromTarget}）与载荷 id（${fromPayload}）不一致，拒绝执行。`,
    };
  }
  const id = fromTarget ?? fromPayload ?? null;
  if (id === null) {
    return {
      id: null,
      error:
        '必须给出目标记忆：target 指向记忆根内的 .md 文件（按 frontmatter 的 id 识别），' +
        '或在载荷里给出 id。路径解析不到记忆时不会猜。',
    };
  }
  return { id, error: null };
}

function toEvidence(result: LandingResult): ReceiptEvidence | null {
  if (!result.ok) return null;
  if (typeof result.tombstoneId === 'string' && result.tombstoneId !== '' && typeof result.previousHash === 'string') {
    return {
      kind: 'deletion',
      previousHash: result.previousHash,
      tombstoneId: result.tombstoneId,
      revision: result.revision > 0 ? result.revision : null,
    };
  }
  if (typeof result.contentHash === 'string' && result.contentHash !== '') {
    return {
      kind: 'content',
      contentHash: result.contentHash,
      revision: result.revision > 0 ? result.revision : 1,
    };
  }
  return null;
}

/**
 * 把核心结果翻译成回执结果。
 *
 * `contentHash` 缺失时从存储层**重新取一次真实落盘哈希**：核心的某些幂等路径
 * （例如事件已处理过而直接返回既有记忆）不会再计算哈希，但落地证据不能因此
 * 缺失——否则一次真实存在的提交会被报成失败，调用方永远拿不到回执。
 */
function commitResultToOutcome(
  result: LandingResult,
  fallbackPath: string | null,
  hashFallback?: (id: string) => string,
): CommitOutcome {
  if (result.ok) {
    const filled: LandingResult =
      (result.contentHash === undefined || result.contentHash === '') &&
      (result.tombstoneId === undefined || result.tombstoneId === '') &&
      typeof hashFallback === 'function' &&
      result.id !== ''
        ? { ...result, contentHash: hashFallback(result.id) }
        : result;
    const evidence = toEvidence(filled);
    const status = evidence === null ? 'failed' : 'completed';
    return {
      status,
      message:
        evidence === null
          ? `${result.message}（但核心没有返回落地哈希，因此不能确认为已提交；请求保留。）`
          : result.message,
      revision: filled.revision,
      evidence,
      contentHash: evidence !== null && evidence.kind === 'content' ? evidence.contentHash : null,
      memoryId: filled.id === '' ? null : filled.id,
      path: filled.path === '' ? fallbackPath : filled.path,
      actualHash: null,
    };
  }
  return {
    status: result.conflict ? 'conflict' : 'failed',
    message: result.message,
    revision: null,
    evidence: null,
    contentHash: null,
    memoryId: result.id === '' ? null : result.id,
    path: result.path === '' ? fallbackPath : result.path,
    actualHash: result.conflictHash ?? null,
  };
}

/**
 * 建立提交处理器。
 *
 * 所有提交都走 `MemoryStore` 的公开方法——也就是插件 UI 用的同一套路径。
 * 队列不是特权通道。
 */
export function createCommitHandler(store: MemoryStore): (request: QueueRequest) => Promise<CommitOutcome> {
  return async (request: QueueRequest): Promise<CommitOutcome> => {
    const reader = new PayloadReader(request.payload);
    const fail = (message: string): CommitOutcome => ({
      status: 'failed',
      message,
      revision: null,
      evidence: null,
      contentHash: null,
      memoryId: null,
      path: request.target === '' ? null : request.target,
      actualHash: null,
    });

    const outcome = await run(request, reader, store, fail);
    /**
     * 成功的提交立刻把「这一次提交」写进核心的持久事务表。
     * 顺序很关键：**先有提交，再有事务记录**；记录写失败不影响本次回执，
     * 但会让重放退回「创建类操作的 eventId 幂等」这一层保护。
     */
    if (outcome.status === 'completed') {
      try {
        await store.rememberTransaction(queueTransactionFingerprint(request), {
          at: new Date().toISOString(),
          operation: request.operation,
          memory_id: outcome.memoryId ?? '',
          path: outcome.path ?? '',
          revision: outcome.revision ?? 0,
          content_hash:
            outcome.evidence !== null && outcome.evidence.kind === 'content'
              ? outcome.evidence.contentHash
              : outcome.contentHash ?? '',
          ...(outcome.evidence !== null && outcome.evidence.kind === 'deletion'
            ? { tombstone_id: outcome.evidence.tombstoneId, previous_hash: outcome.evidence.previousHash }
            : {}),
        });
      } catch {
        /* 事务表写失败：如实留给下一层幂等保护，不掩盖本次成功。 */
      }
    }
    return outcome;
  };
}

async function run(
  request: QueueRequest,
  reader: PayloadReader,
  store: MemoryStore,
  fail: (message: string) => CommitOutcome,
): Promise<CommitOutcome> {
  const requireTarget = async (): Promise<{ id: string | null; error: string | null }> => {
    if (!store.isLoaded) await store.load();
    return resolveTarget(store, request, reader);
  };
  const requireExpectedHash = (): string | null => {
    if (typeof request.expectedHash !== 'string' || request.expectedHash === '') {
      return null;
    }
    return request.expectedHash;
  };
  /**
   * 幂等路径返回既有记忆时核心不会再算哈希，这里从存储层重新取一次真实
   * 落盘哈希：落地证据不能因为“走的是幂等分支”而缺失。
   */
  const hashFallback = (id: string): string => {
    const raw = store.rawOf(id);
    return raw === null ? '' : sha256Hex(raw);
  };
  void requireExpectedHash;

  switch (request.operation) {
    case 'remember':
    case 'propose': {
      const draft = draftFrom(request, reader);
      if (reader.errors.length > 0 || draft === null) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const result = request.operation === 'propose' ? await store.propose(draft) : await store.remember(draft);
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'update': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const body = reader.string('body', { maxLength: 200_000 });
      const title = reader.string('title', { maxLength: 300 });
      const tags = reader.stringList('tags');
      const kind = reader.string('kind');
      const scope = reader.string('scope');
      const scopeRef = reader.stringAlias(['scope_ref', 'scopeRef']);
      const validUntil = reader.stringAlias(['valid_until', 'validUntil']);
      const reviewAfter = reader.stringAlias(['review_after', 'reviewAfter']);
      /**
       * 可见性开关（`allow_model`）。
       *
       * 同一个开关必须在 `remember` 与 `update` 两条路上都生效：
       * 用户把一条已经存在的记忆改成「不给模型看」，
       * 走的就是更新这条路——只认创建时的字段就等于开关失灵。
       */
      const allowModel = reader.booleanAlias(['allow_model', 'allowModel']);
      const reason = reader.string('reason') ?? `经外部入口（${request.requester}）提交的修正`;
      if (reader.errors.length > 0) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const expectedHash = requireExpectedHash();
      if (expectedHash === null) {
        return fail(
          '修正已确认记忆必须附带 expectedHash：外部入口不能做「不管现在是什么都改」的写入。' +
            '请先读取当前内容与哈希，再提交。',
        );
      }
      const patch: Parameters<MemoryStore['update']>[1] = {
        reason,
        /**
         * 队列请求是**用户在别处的明确请求**（并且已经带期望值保护），
         * 因此按 `user` 记账：受控的显式更正应当生效，而不是被一律拒绝。
         * 即便如此，真正的写入仍由 `Vault.process` 的同步比较兜底——
         * 人工编辑不会被覆盖，只会得到冲突。
         */
        actor: 'user',
        expectedHash,
      };
      if (body !== undefined) patch.body = body;
      if (title !== undefined) patch.title = title;
      if (tags !== undefined) patch.tags = tags;
      void kind;
      if (scope !== undefined) patch.scope = scope as NonNullable<typeof patch.scope>;
      if (scopeRef !== undefined) patch.scopeRef = scopeRef;
      if (validUntil !== undefined) patch.validUntil = validUntil;
      if (reviewAfter !== undefined) patch.reviewAfter = reviewAfter;
      if (allowModel !== undefined) patch.allowModel = allowModel;
      const result = await store.update(id, patch);
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'correct': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const replacement = reader.string('replacement', { required: true, maxLength: 200_000 });
      const reason = reader.string('reason') ?? `经外部入口（${request.requester}）提交的纠错`;
      const title = reader.string('title', { maxLength: 300 });
      if (reader.errors.length > 0 || replacement === undefined) {
        return fail(`载荷不合法：${reader.errors.join('；')}`);
      }
      const expectedHash = requireExpectedHash();
      if (expectedHash === null) {
        return fail(
          '纠错必须附带 expectedHash（你读到的当前内容哈希）。没有它就无法保证不覆盖人工编辑。',
        );
      }
      /**
       * `correct` 是**受保护的显式更正**：期望值是必填，核心按 user 记账并
       * 立即生效，同时保留旧版本历史。这与「AI 提议进入待审补丁」是两条
       * 不同的路径——外部工具不能因为自报身份就获得 AI 事实权限，
       * 但也不该把用户的明确更正一律丢成 failed。
       */
      const result = await store.correct(id, {
        replacement,
        reason,
        expectedHash,
        ...(title === undefined ? {} : { title }),
      });
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'supersede': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const draft = draftFrom(request, reader);
      const reason = reader.string('reason') ?? `经外部入口（${request.requester}）提交的替代`;
      if (reader.errors.length > 0 || draft === null) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const result = await store.supersede(id, { ...draft, reason });
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'forget': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const expectedHash = requireExpectedHash();
      const options: { reason?: string; expectedHash?: string } = {};
      const reason = reader.string('reason');
      if (reason !== undefined) options.reason = reason;
      if (expectedHash !== null) options.expectedHash = expectedHash;
      if (reader.errors.length > 0) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const result = await store.forget(id, options);
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'delete': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const expectedHash = requireExpectedHash();
      if (expectedHash === null) {
        return fail('永久删除必须附带 expectedHash：请先读取当前内容再提交。');
      }
      reader.string('reason');
      if (reader.errors.length > 0) return fail(`载荷不合法：${reader.errors.join('；')}`);
      // 删除理由会写进墓碑；外部入口只能标记为「删除文件」这一类。
      const result = await store.deletePermanently(id, { reason: 'user_delete_file', expectedHash });
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'confirm': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const options: { expectedHash?: string; note?: string } = {};
      const note = reader.string('note');
      if (note !== undefined) options.note = note;
      const expectedHash = requireExpectedHash();
      if (expectedHash !== null) options.expectedHash = expectedHash;
      if (reader.errors.length > 0) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const result = await store.confirm(id, options);
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'reject': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const options: { expectedHash?: string; note?: string } = {};
      const note = reader.string('note');
      if (note !== undefined) options.note = note;
      const expectedHash = requireExpectedHash();
      if (expectedHash !== null) options.expectedHash = expectedHash;
      if (reader.errors.length > 0) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const result = await store.reject(id, options);
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    case 'session_commit': {
      /**
       * 会话事件批量提交（队列版）。
       *
       * 与 CLI 的 `session-commit` 语义完全一致，只是提交者变成插件：
       * 逐条事件都跑一次**护栏**，`explicit` 不是由调用方自报，而是要看
       * 「这是不是用户当前回合的文本」。因此从外部入口进来的历史回放
       * 只会得到**待确认候选**，不会变成已确认事实。
       */
      const rawEvents = reader.raw('events');
      if (!Array.isArray(rawEvents)) return fail('载荷不合法：events 必须是数组。');
      const events: SessionEvent[] = [];
      for (const [index, item] of rawEvents.entries()) {
        if (item === null || typeof item !== 'object') return fail(`载荷不合法：events[${index}] 不是对象。`);
        const event = item as Record<string, unknown>;
        const text = typeof event.text === 'string' ? event.text : '';
        if (text.trim() === '') return fail(`载荷不合法：events[${index}].text 为空。`);
        const live = event.live_user_turn === true || event.liveUserTurn === true;
        const verdict = evaluateGuard({ text, sourceKind: 'session_commit', isLiveUserTurn: live });
        const eventId =
          typeof event.event_id === 'string' && event.event_id !== ''
            ? event.event_id
            : typeof event.eventId === 'string' && event.eventId !== ''
              ? event.eventId
              : `queue:${request.id}:${index}`;
        const sourceRef =
          typeof event.source_ref === 'string' && event.source_ref !== ''
            ? event.source_ref
            : typeof event.sourceRef === 'string' && event.sourceRef !== ''
              ? event.sourceRef
              : `queue:${request.requester}`;
        events.push({
          eventId,
          text,
          explicit: verdict.explicit,
          sourceKind: 'session_commit',
          sourceRef,
          cursor: typeof event.cursor === 'string' ? event.cursor : undefined,
          ...(typeof event.kind === 'string' ? { kind: event.kind as SessionEvent['kind'] } : {}),
          ...(typeof event.observed_at === 'string'
            ? { observedAt: event.observed_at }
            : typeof event.observedAt === 'string'
              ? { observedAt: event.observedAt }
              : {}),
          ...(Array.isArray(event.tags) ? { tags: event.tags.map(String) } : {}),
        });
      }
      if (reader.errors.length > 0) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const outcome = await store.commitSession(events);
      const cursor = reader.string('cursor');
      if (cursor !== undefined) await store.setCursor(cursor);
      const accepted = outcome.results.filter(item => item.outcome.ok && item.outcome.changed).length;
      const duplicates = outcome.results.filter(item => item.outcome.idempotent).length;
      const failed = outcome.results.filter(item => !item.outcome.ok).length;
      /**
       * 直接确认成事实的事件数。
       *
       * 不按调用方自报的 `explicit` 数，而是**回读真正落盘的状态**：
       * 核心自己有一条「会话事件不能自我确认」的规则，实际结果以记录为准。
       */
      const confirmed = outcome.results.filter(item => {
        const record = store.get(item.outcome.id);
        return record !== null && record.meta.status === 'confirmed';
      }).length;
      /**
       * 落地证据。
       *
       * 一次会话提交会落成**多条**记忆，回执只有一行，所以取第一条真正
       * 落地的结果作为证据（重复命中同样算落地——那条记录确实存在）。
       *
       * 之前这里一律填 null：回执读回时因为「completed 必须带落地证据」
       * 被判无效，用户在外部只看到一条 failed 回执，
       * 而记忆其实已经写进去了——「写成功却报失败」比不写更糟。
       */
      const anchored = outcome.results.find(item => item.outcome.ok && store.get(item.outcome.id) !== null);
      const anchoredResult = anchored === undefined ? null : commitResultToOutcome(anchored.outcome, null, hashFallback);
      return {
        status: failed > 0 && accepted === 0 && duplicates === 0 ? 'failed' : 'completed',
        message:
          `受理 ${outcome.results.length} 个会话事件：新建/更新 ${accepted}，重复（幂等）${duplicates}，失败 ${failed}；` +
          `其中直接确认为事实的 ${confirmed} 条（其余为待确认候选）。`,
        revision: anchoredResult?.revision ?? null,
        evidence: anchoredResult?.evidence ?? null,
        contentHash: anchoredResult?.contentHash ?? null,
        memoryId: anchoredResult?.memoryId ?? null,
        path: anchoredResult?.path ?? (request.target === '' ? null : request.target),
        actualHash: null,
      };
    }
    case 'restore': {
      const { id, error } = await requireTarget();
      if (id === null) return fail(`载荷不合法：${error ?? reader.errors.join('；')}`);
      const reason = reader.string('reason') ?? `经外部入口（${request.requester}）提交的恢复`;
      if (reader.errors.length > 0) return fail(`载荷不合法：${reader.errors.join('；')}`);
      const result = await store.restore(id, reason);
      return commitResultToOutcome(result, request.target || null, hashFallback);
    }
    default:
      return fail(`不支持的队列操作：${String(request.operation)}`);
  }
}

/**
 * 从持久事务表恢复一次已经发生的提交（回执丢失时的补写路径）。
 *
 * 返回 null 表示「无法确认这次提交是否发生过」——那时才允许真正提交。
 */
export function createCommitRecovery(store: MemoryStore): (request: QueueRequest) => Promise<CommitOutcome | null> {
  return async (request: QueueRequest): Promise<CommitOutcome | null> => {
    const fingerprint = queueTransactionFingerprint(request);
    const transaction = store.findTransaction(fingerprint);
    if (transaction === null) {
      /**
       * 事务表没有记录时再看**创建类操作的正文幂等索引**：
       * 请求 id 映射的 eventId 如果已经在某条记忆的 `event_ids` 里，
       * 说明那次创建确实发生过，只是回执/事务表没写下来。
       */
      const eventId = queueEventId(request.id);
      const existingId = store.findByEventId(eventId);
      if (existingId === null) return null;
      const record = store.get(existingId);
      if (record === null) return null;
      const raw = store.rawOf(existingId);
      const hash = raw === null ? '' : sha256Hex(raw);
      return {
        status: 'completed',
        message:
          `该请求此前已经提交（正文里的 event_ids 记录了 ${eventId}），` +
          '本次只补写回执，没有再次执行写入。',
        revision: record.meta.revision,
        evidence: { kind: 'content', contentHash: hash, revision: record.meta.revision },
        contentHash: hash,
        memoryId: existingId,
        path: record.path,
        actualHash: null,
        recovered: true,
      };
    }
    if (typeof transaction.tombstone_id === 'string' && transaction.tombstone_id !== '') {
      return {
        status: 'completed',
        message: '该请求此前已经执行永久删除，本次只补写回执（删除标记为证），没有再次执行。',
        revision: transaction.revision,
        evidence: {
          kind: 'deletion',
          previousHash: transaction.previous_hash ?? '',
          tombstoneId: transaction.tombstone_id,
          revision: transaction.revision > 0 ? transaction.revision : null,
        },
        contentHash: null,
        memoryId: transaction.memory_id,
        path: transaction.path,
        actualHash: null,
        recovered: true,
      };
    }
    /**
     * 持久事务表命中。这里只报告**当时记录下来的**结果，不重新推导：
     * 如果那之后还有别的改动，那是另一次提交，不该改写这一次的回执。
     */
    return {
      status: 'completed',
      message: '该请求此前已经提交（持久事务表为证），本次只补写回执，没有再次执行写入。',
      revision: transaction.revision,
      evidence: {
        kind: 'content',
        contentHash: transaction.content_hash,
        revision: transaction.revision > 0 ? transaction.revision : 1,
      },
      contentHash: transaction.content_hash,
      memoryId: transaction.memory_id,
      path: transaction.path,
      actualHash: null,
      recovered: true,
    };
  };
}

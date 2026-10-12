/**
 * 队列处理器：把「写请求」变成「回执」。
 *
 * 纯逻辑，不做 IO：调用方（Obsidian 插件）提供读取与提交能力。
 * 这样同一套状态机可以被插件复用，也可以在测试里用内存存储驱动，
 * 不必真的起一个 Obsidian。
 *
 * ## 提交者的职责（顺序不可颠倒）
 *
 * 1. 取件：把请求文件改名认领，避免两个提交者重复处理同一条；
 * 2. 校验：结构不合法就写 `failed` 回执，并保留请求原件；
 * 3. 提交：**在 `Vault.process` 的同步回调里**比较当前原文与期望值，
 *    不一致就返回冲突（`conflict`），绝不覆盖；
 * 4. 回执：无论结果如何都写回执，且**先写回执再删请求**——
 *    如果顺序反过来，崩溃会留下「请求没了、回执也没有」的黑洞。
 *
 * ## 幂等与恢复（三层，缺一不可）
 *
 * 1. **已有回执**：`requestId` 或 `idempotencyKey` 命中回执，**且指纹相同**
 *    → 直接返回原回执，不再提交。指纹不同 → `conflict`，
 *    因为「同名不同内容」绝不能拿到旧操作的成功回执。
 * 2. **已提交但回执丢了**：`findCommitted` 从权威存储的持久事务标记
 *    （`event_ids` / 删除账本）恢复出**同一次提交**的结果，直接补写回执，
 *    不再次执行副作用。
 * 3. 只有上面两条都不成立时才真正提交。
 *
 * 回执在**复用与持久化之前**都过一遍 `validateReceipt`：缺失落地证据的
 * 回执不能当作成功，更不能据它删掉请求。
 */

import { sha256Hex } from './hash.js';
import { normalizePath } from './paths.js';
import {
  QUEUE_PROTOCOL_VERSION,
  isRequestExpired,
  requestFingerprint,
  validateOperationPayload,
  validateReceipt,
  validateRequest,
  type QueueReceipt,
  type QueueRequest,
  type QueueValidation,
  type QueueValidationOptions,
  type ReceiptEvidence,
  type ReceiptStatus,
  type WriteOperation,
} from './queue.js';

/** 解析结果：要么是结构完整的请求，要么带着明确原因被拒绝。 */
export interface ParsedEnvelope {
  request: QueueRequest | null;
  errors: string[];
}

const OPERATIONS: readonly WriteOperation[] = [
  'remember',
  'propose',
  'update',
  'correct',
  'supersede',
  'forget',
  'delete',
  'confirm',
  'reject',
  'restore',
  'session_commit',
];

/**
 * 序列化请求信封。
 *
 * 头部是 YAML frontmatter（Obsidian 里可读、可搜索、可用属性视图筛选），
 * 正文是操作载荷的 JSON。`payload` 单独放正文，是因为它可能包含
 * 多行文本（新正文、说明），塞进 YAML 会很难读也很难核对。
 */
export function serializeRequest(request: QueueRequest): string {
  const lines: string[] = ['---'];
  const scalar = (key: string, value: string | number | null): void => {
    lines.push(`${key}: ${value === null ? 'null' : JSON.stringify(value)}`);
  };
  scalar('protocol', request.protocol);
  scalar('id', request.id);
  scalar('operation', request.operation);
  scalar('target', request.target);
  scalar('expected_hash', request.expectedHash);
  scalar('expected_revision', request.expectedRevision);
  scalar('requester', request.requester);
  scalar('created_at', request.createdAt);
  scalar('expires_at', request.expiresAt);
  scalar('idempotency_key', request.idempotencyKey);
  scalar('fingerprint', requestFingerprint(request));
  lines.push('---', '', '## 载荷', '', '```json', JSON.stringify(request.payload, null, 2), '```', '');
  return lines.join('\n');
}

/** 解析请求信封；任何结构问题都进 `errors`，不猜测、不补默认值。 */
export function parseRequestEnvelope(raw: string, options: QueueValidationOptions = {}): ParsedEnvelope {
  const errors: string[] = [];
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    return { request: null, errors: ['请求文件缺少 YAML 头（---）。'] };
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { request: null, errors: ['请求文件的 YAML 头没有结束标记。'] };
  const head = text.slice(3, end);
  const body = text.slice(end + 4);

  const fields = new Map<string, string>();
  for (const rawLine of head.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) {
      errors.push(`无法解析的头部行：${line.slice(0, 60)}`);
      continue;
    }
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const readString = (key: string): string | null => {
    const value = fields.get(key);
    if (value === undefined) return null;
    if (value === 'null' || value === '~') return null;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        return JSON.parse(value) as string;
      } catch {
        errors.push(`字段 ${key} 的引号写法无法解析。`);
        return value.slice(1, -1);
      }
    }
    return value;
  };
  const readNumber = (key: string): number | null => {
    const value = fields.get(key);
    if (value === undefined) return null;
    if (value === 'null' || value === '~') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      errors.push(`字段 ${key} 不是数字：${value.slice(0, 40)}`);
      return null;
    }
    return parsed;
  };

  const payload = parsePayload(body, errors);
  const request: QueueRequest = {
    protocol: readNumber('protocol') ?? 0,
    id: readString('id') ?? '',
    operation: (readString('operation') ?? '') as WriteOperation,
    payload,
    target: readString('target') ?? '',
    expectedHash: readString('expected_hash'),
    expectedRevision: readNumber('expected_revision'),
    requester: readString('requester') ?? '',
    createdAt: readString('created_at') ?? '',
    expiresAt: readString('expires_at') ?? '',
    idempotencyKey: readString('idempotency_key') ?? '',
  };
  const validation = validateRequest(request, options);
  if (!validation.ok) errors.push(...validation.errors);
  return { request: errors.length === 0 ? request : null, errors };
}

function parsePayload(body: string, errors: string[]): Record<string, unknown> {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!match) {
    errors.push('请求正文里没有 ```json 载荷块。');
    return {};
  }
  if (match[1]!.length > 256 * 1024) {
    errors.push('载荷过长，超过本协议上限。');
    return {};
  }
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('载荷必须是 JSON 对象。');
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    errors.push(`载荷不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/** 序列化回执。回执是**只读证据**：解析失败时绝不覆盖，只报告。 */
export function serializeReceipt(receipt: QueueReceipt): string {
  const lines: string[] = ['---'];
  const scalar = (key: string, value: string | number | null): void => {
    lines.push(`${key}: ${value === null ? 'null' : JSON.stringify(value)}`);
  };
  scalar('protocol', receipt.protocol);
  scalar('request_id', receipt.requestId);
  scalar('status', receipt.status);
  scalar('fingerprint', receipt.fingerprint);
  scalar('committed_by', receipt.committedBy);
  scalar('committed_at', receipt.committedAt);
  scalar('revision', receipt.revision);
  scalar('content_hash', receipt.contentHash);
  scalar('memory_id', receipt.memoryId);
  scalar('path', receipt.path);
  scalar('actual_hash', receipt.actualHash);
  scalar('idempotency_key', receipt.idempotencyKey);
  lines.push('---', '', '## 落地证据', '', '```json', JSON.stringify(receipt.evidence, null, 2), '```', '');
  lines.push('## 说明', '', receipt.message, '');
  return lines.join('\n');
}

/** 解析回执；结构不完整时返回带原因的 `null`，不猜测。 */
export function parseReceipt(raw: string, options: QueueValidationOptions = {}): { receipt: QueueReceipt | null; errors: string[] } {
  const errors: string[] = [];
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return { receipt: null, errors: ['回执缺少 YAML 头。'] };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { receipt: null, errors: ['回执的 YAML 头没有结束标记。'] };
  const head = text.slice(3, end);
  const body = text.slice(end + 4);

  const fields = new Map<string, string>();
  for (const rawLine of head.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const readString = (key: string): string | null => {
    const value = fields.get(key);
    if (value === undefined || value === 'null' || value === '~') return null;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }
    return value;
  };
  const readNumber = (key: string): number | null => {
    const value = fields.get(key);
    if (value === undefined || value === 'null' || value === '~') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const message = /##\s*说明\s*\n+([\s\S]*?)\s*$/.exec(body)?.[1]?.trim() ?? '';
  const evidence = parseEvidence(body, errors);
  const receipt: QueueReceipt = {
    protocol: readNumber('protocol') ?? 0,
    requestId: readString('request_id') ?? '',
    status: (readString('status') ?? '') as ReceiptStatus,
    fingerprint: readString('fingerprint') ?? '',
    committedBy: readString('committed_by') ?? '',
    committedAt: readString('committed_at') ?? '',
    revision: readNumber('revision'),
    evidence,
    contentHash: readString('content_hash'),
    memoryId: readString('memory_id'),
    path: readString('path'),
    message,
    actualHash: readString('actual_hash'),
    idempotencyKey: readString('idempotency_key') ?? '',
  };
  /**
   * 解析出来的回执**必须自己过一遍校验**：类型声明不是运行时保证。
   * 缺失落地证据的 `completed` 如果被当作权威，就会把没落地的事说成已完成。
   */
  const validation = validateReceipt(receipt, options);
  if (!validation.ok) errors.push(...validation.errors);
  return { receipt: errors.length === 0 ? receipt : null, errors };
}

function parseEvidence(body: string, errors: string[]): ReceiptEvidence | null {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    /**
     * `null` 是**合法**证据，不是错误。
     *
     * `serializeReceipt` 对 conflict / failed / expired 这三种「没有落地」
     * 的结果就是写 `null`（它们本来就没有可核验的落地内容）。
     * 修复前这里把 `null` 当成「证据类型不对」推入 errors，
     * 于是 `parseReceipt` 返回 `receipt: null`——回执明明写成功了，
     * 任何读回它的入口（CLI `receipts`、界面、外部对账）都看不到它，
     * 用户看到的现象是「提交冲突了，但查不到那条冲突回执」。
     *
     * 这里只负责把 JSON 解析出来；「completed 必须带落地证据」由
     * `validateReceipt` 负责，那个校验**没有**被放宽。
     */
    if (parsed === null) return null;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('落地证据必须是 JSON 对象或 null。');
      return null;
    }
    return parsed as ReceiptEvidence;
  } catch (error) {
    errors.push(`落地证据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 提交者要执行的一次提交；成功时回传落地信息。
 * `expired` 由状态机自己判定，提交者不会返回它。
 */
export interface CommitOutcome {
  status: Extract<ReceiptStatus, 'completed' | 'conflict' | 'failed'>;
  message: string;
  revision: number | null;
  /** 落地证据：创建/修改是内容哈希，永久删除是删除标记。 */
  evidence: ReceiptEvidence | null;
  contentHash: string | null;
  memoryId: string | null;
  path: string | null;
  actualHash: string | null;
  /** 结果是否来自「已经提交过」的持久记录（恢复，不重复执行副作用）。 */
  recovered?: boolean;
}

/** 已有回执的查询结果（要区分「没有」「命中」「指纹冲突」）。 */
export type ReceiptLookup =
  | { kind: 'none' }
  | { kind: 'found'; receipt: QueueReceipt }
  | { kind: 'fingerprint_mismatch'; receipt: QueueReceipt; expected: string; actual: string };

export interface ProcessContext extends QueueValidationOptions {
  /** 现在（毫秒时间戳）。 */
  now: () => number;
  /** 提交者身份（写入回执，便于对账）。 */
  committedBy: string;
  /** 已有回执查询（按 requestId 或 idempotencyKey）。 */
  findReceipt: (request: QueueRequest) => ReceiptLookup;
  /**
   * 从权威存储的**持久事务标记**恢复出一次已经发生的提交。
   * 返回 null 表示无法确认——此时才允许再次提交。
   */
  findCommitted?: (request: QueueRequest) => Promise<CommitOutcome | null> | CommitOutcome | null;
  /** 真正执行提交。必须自己保证「比较-提交」在同一原子区内。 */
  commit: (request: QueueRequest) => Promise<CommitOutcome> | CommitOutcome;
  /** 写回执。返回 false 表示回执没能落地（调用方必须保留请求）。 */
  writeReceipt: (receipt: QueueReceipt) => Promise<boolean> | boolean;
  /** 记忆根（Vault 相对路径）；用于校验 target 与回执 path。 */
  root?: string;
}

export interface ProcessResult {
  requestId: string;
  receipt: QueueReceipt | null;
  /** 是否命中了已有回执（幂等短路，没有再次提交）。 */
  idempotent: boolean;
  /** 是否从持久事务标记恢复了已经发生的提交（没有再次执行副作用）。 */
  recovered: boolean;
  /** 回执是否成功落盘；false 时调用方**不得**删除请求。 */
  receiptDurable: boolean;
}

/**
 * 处理一条请求。
 *
 * 调用方负责「认领」请求文件（改名）与在 `receiptDurable` 为真时删除请求。
 * 这里刻意不碰文件系统：状态机与存储分开，才能在测试里复现崩溃顺序。
 */
export async function processRequest(
  request: QueueRequest,
  context: ProcessContext,
): Promise<ProcessResult> {
  const validationOptions: QueueValidationOptions = { root: context.root, organization: context.organization };
  const requestId = typeof request.id === 'string' && request.id !== '' ? request.id : '(非法请求)';

  /* 1. 先校验：非法请求绝不进入幂等短路，也绝不提交。 */
  const validation = validateRequest(request, validationOptions);
  if (!validation.ok) {
    const receipt = buildReceipt(request, context, {
      status: 'failed',
      message: `请求结构不合法，未提交：${validation.errors.join('；')}`,
      revision: null,
      evidence: null,
      contentHash: null,
      memoryId: null,
      path: request.target === '' ? null : request.target,
      actualHash: null,
    });
    return {
      requestId,
      receipt,
      idempotent: false,
      recovered: false,
      receiptDurable: await this_write(context, receipt),
    };
  }

  /* 2. 已有回执：只有指纹一致才允许复用。 */
  const lookup = context.findReceipt(request);
  if (lookup.kind === 'found') {
    const check = validateReceipt(lookup.receipt, validationOptions);
    if (check.ok) {
      return { requestId, receipt: lookup.receipt, idempotent: true, recovered: false, receiptDurable: true };
    }
    /**
     * 已有回执本身不合法（缺落地证据等）：不能当作成功，也不能据此删请求。
     * 写成 `failed` 并保留请求，让人看见坏回执。
     */
    const receipt = buildReceipt(request, context, {
      status: 'failed',
      message: `已有回执无法通过校验，未提交：${check.errors.join('；')}。请人工检查该回执文件。`,
      revision: null,
      evidence: null,
      contentHash: null,
      memoryId: null,
      path: null,
      actualHash: null,
    });
    return {
      requestId,
      receipt,
      idempotent: false,
      recovered: false,
      receiptDurable: await this_write(context, receipt),
    };
  }
  if (lookup.kind === 'fingerprint_mismatch') {
    const receipt = buildReceipt(request, context, {
      status: 'conflict',
      message:
        '同一个 requestId / 幂等键已有一份**不同内容**的回执，因此拒绝复用：' +
        `期望指纹 ${lookup.expected.slice(0, 12)}…，已有指纹 ${lookup.actual.slice(0, 12)}…。` +
        '请换一个 requestId 或幂等键重新排队。',
      revision: null,
      evidence: null,
      contentHash: null,
      memoryId: null,
      path: null,
      actualHash: null,
    });
    return {
      requestId,
      receipt,
      idempotent: false,
      recovered: false,
      receiptDurable: await this_write(context, receipt),
    };
  }

  /**
   * 3. 过期请求不提交，但**也不会被删掉**：它留在磁盘上等人判断。
   * 自动重试或自动丢弃都会让「到底发生过什么」变得不可查。
   */
  if (isRequestExpired(request, context.now())) {
    const receipt = buildReceipt(request, context, {
      status: 'expired',
      message: `请求已超过存活期（${request.expiresAt}），未提交；请求文件保留，等待人工判断。`,
      revision: null,
      evidence: null,
      contentHash: null,
      memoryId: null,
      path: request.target === '' ? null : request.target,
      actualHash: null,
    });
    return {
      requestId,
      receipt,
      idempotent: false,
      recovered: false,
      receiptDurable: await this_write(context, receipt),
    };
  }

  /**
   * 4. 先问「这次提交是不是已经发生过」。
   *
   * 崩在「提交成功」与「回执落盘」之间时，请求会被保留；如果直接重放，
   * 就会产生第二条记忆。因此重放之前必须在权威存储里找同一次提交的持久标记。
   */
  let recoveredOutcome: CommitOutcome | null = null;
  if (context.findCommitted !== undefined) {
    try {
      recoveredOutcome = await context.findCommitted(request);
    } catch {
      recoveredOutcome = null;
    }
  }
  if (recoveredOutcome !== null) {
    const receipt = buildReceipt(request, context, { ...recoveredOutcome, recovered: true });
    return {
      requestId,
      receipt,
      idempotent: false,
      recovered: true,
      receiptDurable: validateReceipt(receipt, validationOptions).ok && await this_write(context, receipt),
    };
  }

  /* 5. 真正提交。 */
  let outcome: CommitOutcome;
  try {
    outcome = await context.commit(request);
  } catch (error) {
    outcome = {
      status: 'failed',
      message: `提交时抛出异常：${error instanceof Error ? error.message : String(error)}`,
      revision: null,
      evidence: null,
      contentHash: null,
      memoryId: null,
      path: request.target === '' ? null : request.target,
      actualHash: null,
    };
  }
  const receipt = buildReceipt(request, context, outcome);
  if (outcome.status === 'completed') {
    /**
     * `validateReceipt` 的 completed 分支就是**唯一**的落地证据关：evidence、
     * contentHash、revision、memoryId、path 逐项要求。一个自报 completed 却拿不出
     * 证据的提交者（第三方适配器、未来的重构）在这里被拒，回执降级为 failed。
     *
     * 这里**不再重复**一份「缺哪个字段」的检查：那只会多一套判断而没有多一分保障，
     * 而且会让后来的人以为校验有两处、可以放宽其中一处。契约只有一处。
     */
    const check = validateReceipt(receipt, validationOptions);
    if (!check.ok) {
      /**
       * 提交成功了，但回执缺少落地证据：这不能算「已完成」——
       * 否则调用方会拿到一个无法核验的成功。保留请求，让人看到问题。
       */
      const failed = buildReceipt(request, context, {
        status: 'failed',
        message: `提交已执行，但结果缺少落地证据，未落回执：${check.errors.join('；')}。请求已保留。`,
        revision: outcome.revision,
        evidence: outcome.evidence,
        contentHash: outcome.contentHash,
        memoryId: outcome.memoryId,
        path: outcome.path,
        actualHash: outcome.actualHash,
      });
      return {
        requestId,
        receipt: failed,
        idempotent: false,
        recovered: false,
        receiptDurable: await this_write(context, failed),
      };
    }
  }
  return {
    requestId,
    receipt,
    idempotent: false,
    recovered: false,
    receiptDurable: await this_write(context, receipt),
  };
}

/** 写回执；任何异常都算「没落地」。 */
async function this_write(context: ProcessContext, receipt: QueueReceipt): Promise<boolean> {
  try {
    return await context.writeReceipt(receipt);
  } catch {
    return false;
  }
}

function buildReceipt(
  request: QueueRequest,
  context: ProcessContext,
  outcome: Omit<CommitOutcome, 'status'> & { status: ReceiptStatus },
): QueueReceipt {
  return {
    protocol: QUEUE_PROTOCOL_VERSION,
    requestId: typeof request.id === 'string' && request.id !== '' ? request.id : '(非法请求)',
    status: outcome.status,
    fingerprint: fingerprintOrEmpty(request),
    committedBy: context.committedBy,
    committedAt: new Date(context.now()).toISOString(),
    revision: outcome.revision,
    evidence: outcome.evidence,
    contentHash: outcome.contentHash,
    memoryId: outcome.memoryId,
    path: outcome.path === null ? null : normalizePath(outcome.path),
    message: outcome.message,
    actualHash: outcome.actualHash,
    idempotencyKey: typeof request.idempotencyKey === 'string' ? request.idempotencyKey : '',
  };
}

/** 指纹计算不能因为坏信封而抛异常；算不出来时返回带原因的哨兵值。 */
function fingerprintOrEmpty(request: QueueRequest): string {
  try {
    return requestFingerprint(request);
  } catch {
    return `invalid:${sha256Hex(String(request.id ?? '')).slice(0, 16)}`;
  }
}

/**
 * 从已有回执集合里找出与某请求对应的回执。
 *
 * 返回类型刻意区分三种情况：没有、命中、**指纹冲突**。
 * 把「不同内容的同名请求」当成命中，会让调用方拿到别人的成功回执。
 */
export function findExistingReceipt(
  receipts: readonly QueueReceipt[],
  request: QueueRequest,
): ReceiptLookup {
  const wanted = fingerprintOrEmpty(request);
  const byId = receipts.find(receipt => receipt.requestId === request.id);
  if (byId) {
    return byId.fingerprint === wanted
      ? { kind: 'found', receipt: byId }
      : { kind: 'fingerprint_mismatch', receipt: byId, expected: wanted, actual: byId.fingerprint };
  }
  if (typeof request.idempotencyKey === 'string' && request.idempotencyKey !== '') {
    for (const receipt of receipts) {
      if (receipt.idempotencyKey !== request.idempotencyKey) continue;
      if (receipt.fingerprint === wanted) return { kind: 'found', receipt };
      if (receipt.fingerprint === '') continue;
      return {
        kind: 'fingerprint_mismatch',
        receipt,
        expected: wanted,
        actual: receipt.fingerprint,
      };
    }
  }
  return { kind: 'none' };
}

/** 调用方给出的期望值描述，用于回执里的人可读说明。 */
export function describeExpectation(request: QueueRequest): string {
  if (request.expectedHash === null) return '调用方未给出期望哈希（允许新建或按规则覆盖）';
  return `期望哈希 ${request.expectedHash.slice(0, 12)}…`;
}

/** 供 UI 展示：操作名的中文标签。 */
export const OPERATION_LABELS: Record<WriteOperation, string> = {
  remember: '记住',
  propose: '提交候选',
  update: '修正',
  correct: '纠错',
  supersede: '替代',
  forget: '停止使用',
  delete: '永久删除',
  confirm: '确认',
  reject: '忽略',
  restore: '恢复',
  session_commit: '会话提交',
};

/** 该操作是否属于破坏性操作（UI 要二次确认）。 */
export function isDestructive(operation: WriteOperation): boolean {
  return operation === 'delete' || operation === 'forget' || operation === 'supersede';
}

/** 校验操作名，供入队前早失败。 */
export function isWriteOperation(value: string): value is WriteOperation {
  return (OPERATIONS as readonly string[]).includes(value);
}

/** 该操作是否会永久移除内容（决定回执要不要删除标记）。 */
export function isPermanentDelete(operation: WriteOperation): boolean {
  return operation === 'delete';
}

/** 校验一次提交结果是否满足操作对应的落地证据要求（供提交者自查）。 */
export function checkCommitEvidence(
  operation: WriteOperation,
  outcome: Pick<CommitOutcome, 'status' | 'evidence' | 'revision' | 'contentHash' | 'memoryId' | 'path'>,
): QueueValidation {
  if (outcome.status !== 'completed') return { ok: true, errors: [] };
  const errors: string[] = [];
  if (outcome.evidence === null) errors.push('completed 必须带落地证据');
  if (typeof outcome.memoryId !== 'string' || outcome.memoryId === '') errors.push('completed 必须带 memoryId');
  if (typeof outcome.path !== 'string' || outcome.path === '') errors.push('completed 必须带 path');
  if (isPermanentDelete(operation)) {
    if (outcome.evidence !== null && outcome.evidence.kind !== 'deletion') {
      errors.push('永久删除必须用删除标记作为落地证据，而不是内容哈希');
    }
  } else if (outcome.evidence !== null && outcome.evidence.kind !== 'content') {
    errors.push('非删除操作必须用内容哈希作为落地证据');
  }
  return { ok: errors.length === 0, errors };
}

/** 对操作载荷做一次显式校验（供 CLI/MCP 入队前早失败）。 */
export function validatePayloadForOperation(
  operation: WriteOperation,
  payload: Record<string, unknown>,
): QueueValidation {
  return validateOperationPayload(operation, payload);
}

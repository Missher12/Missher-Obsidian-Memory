/**
 * 写请求队列协议（外部入口 ↔ 权威提交者）。
 *
 * ## 为什么需要它
 *
 * 手工编辑、第三方同步工具**不参加**任何本产品能提供的锁。在 Node 端
 * 「读 → 比较 → rename」无法变成跨软件的原子 CAS，因此**默认不允许
 * 外部入口直接写 Markdown**：CLI 与 MCP 把写请求放进 `<记忆根>/.memory/requests/`，
 * 由 Obsidian 插件（权威 Markdown 写入者）用 `Vault.process` 在**同步回调**里
 * 比较当前原文并提交，然后把回执写到 `<记忆根>/.memory/receipts/`。
 *
 * ## 路径契约（全项目唯一一种，不许有第二种）
 *
 * **所有 `FileStore` 的输入与输出都是「Vault 相对路径，并且已经包含记忆根」。**
 * 例：记忆根为 `Brain` 时，状态文件是 `Brain/.memory/state.json`，
 * 请求是 `Brain/.memory/requests/req_x.md`。
 *
 * - 核心传出的路径已经含根（`store.ts` 的 `SCOPE_ROOT`/`statePath`/`listFiles`）；
 * - 适配器（Vault / Node）**不再前置任何根**，只做校验与转发；
 * - 队列协议里的 `REQUEST_DIR`/`RECEIPT_DIR` 是**相对记忆根**的常量，
 *   本模块的 `*Path()` 系列函数接收 `root` 参数，**只在边界接一次根**。
 *
 * 校验在拼接**之前**做：绝对路径、`..`、`.`、盘符、UNC、`~`、空字节、
 * 保留目录名（`.obsidian`/`.git`/`node_modules`）一律**拒绝**。
 * 刻意不做「先 normalize 再检查」——那会把攻击写法抹平后放行。
 *
 * ## 状态语义（不许混为一谈）
 *
 * - `accepted`：请求已经**持久落盘**，排队等待权威提交者。
 *   这只说明「请求不会丢」，**不说明**记忆已经写入。
 * - `completed`：权威提交者确认提交成功，回执带 revision 与落地证据
 *   （内容哈希，或永久删除的删除标记）。
 * - `conflict`：提交时目标内容与请求的期望值不一致（人工编辑、并发写入、
 *   过期 revision）——请求**没有**生效，回执说明现场。
 * - `failed`：提交者明确报告失败原因（校验不通过、范围不允许等）。
 * - `expired`：请求超过存活期仍未被处理；它**留在磁盘上**等待人工判断，
 *   本产品不会自动重试或自动删除。
 *
 * 本模块是纯核心：不依赖 Obsidian、Node 或任何 IO。
 */

import { sha256Hex } from './hash.js';
import { assertSafeRelativePath, assertSafeRoot, normalizePath, PathError } from './paths.js';
import { SCOPE_KINDS } from './types.js';

/** 请求队列目录（**相对记忆根**）。 */
export const REQUEST_DIR = '.memory/requests';
/** 回执目录（**相对记忆根**）。 */
export const RECEIPT_DIR = '.memory/receipts';
/** 被提交者取走的请求会被改名，加这个后缀，避免第二个提交者重复处理。 */
export const CLAIM_SUFFIX = '.claimed';
/** 协议版本；两端不一致时拒绝处理，而不是猜测。 */
export const QUEUE_PROTOCOL_VERSION = 1;
/** 请求默认存活期（毫秒）：超过后被标记为 `expired`，不自动删除。 */
export const DEFAULT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 请求/回执正文长度上限：超过就不是本协议的信封，按结构错误拒绝。 */
export const MAX_ENVELOPE_CHARS = 256 * 1024;
/** 单个字段（正文、说明等）的最大长度。 */
export const MAX_TEXT_FIELD_CHARS = 64 * 1024;

/**
 * 一次会话提交最多带多少事件。
 *
 * 有界是必须的：一次请求会变成一个文件载荷，没有上限就等于给了外部入口
 * 一个「往队列里塞任意大 JSON」的口子。
 */
export const MAX_SESSION_EVENTS = 500;
/** 请求 id 的合法形状：单一安全 basename。 */
const REQUEST_ID_PATTERN = /^req_[0-9A-Za-z_-]{1,64}$/;

export type WriteOperation =
  | 'remember'
  | 'propose'
  | 'update'
  | 'correct'
  | 'supersede'
  | 'forget'
  | 'delete'
  | 'confirm'
  | 'reject'
  | 'restore'
  /** 会话事件批量提交（外部入口也要能走队列，见 `validateOperationPayload`）。 */
  | 'session_commit';

export interface QueueRequest {
  protocol: number;
  id: string;
  operation: WriteOperation;
  /** 操作载荷：字段由 operation 决定，`validateOperationPayload` 逐项校验。 */
  payload: Record<string, unknown>;
  /** Vault 相对路径（含记忆根）的目标记忆文件；新建操作为空字符串。 */
  target: string;
  /** 调用方读取到的内容哈希（乐观并发）；无期望值时为 null。 */
  expectedHash: string | null;
  /** 调用方读取到的 revision；未知时为 null。 */
  expectedRevision: number | null;
  /** 调用方身份标签，仅用于展示与审计（不是身份认证）。 */
  requester: string;
  /** 创建与过期时间（ISO 字符串）。 */
  createdAt: string;
  expiresAt: string;
  /** 幂等键：同一键**且同一逻辑请求**重复入队只应产生一次效果。 */
  idempotencyKey: string;
}

export type ReceiptStatus = 'completed' | 'conflict' | 'failed' | 'expired';

/**
 * 落地的证据。
 *
 * 创建/修改类操作必须给出**新内容的哈希**；永久删除没有新内容，
 * 必须给出**删除标记**（含被删内容的哈希与墓碑 id），
 * 而不是伪造一个内容哈希来骗过校验。
 */
export type ReceiptEvidence =
  | { kind: 'content'; contentHash: string; revision: number }
  | { kind: 'deletion'; previousHash: string; tombstoneId: string; revision: number | null };

export interface QueueReceipt {
  protocol: number;
  /** 与被处理请求的 `id` 相同。 */
  requestId: string;
  status: ReceiptStatus;
  /** 请求指纹：绑定的操作身份，防止不同请求复用同一回执。 */
  fingerprint: string;
  /** 提交者身份（插件进程随机标识或用户可见名称）。 */
  committedBy: string;
  /** 处理时刻（ISO 字符串）。 */
  committedAt: string;
  /** 提交成功后记忆的 revision；未提交时为 null。 */
  revision: number | null;
  /** 落地证据；未提交时为 null。 */
  evidence: ReceiptEvidence | null;
  /** 提交后落盘内容的哈希；未提交或删除时为 null。 */
  contentHash: string | null;
  /** 记忆 id（提交后可能新建）。 */
  memoryId: string | null;
  /** 目标路径（Vault 相对，含记忆根）。 */
  path: string | null;
  /** 人可读说明：冲突时写明现场，失败时写明原因。 */
  message: string;
  /** 冲突现场的磁盘哈希（冲突时有值）。 */
  actualHash: string | null;
  /** 幂等键回填，便于调用方对账。 */
  idempotencyKey: string;
}

export interface QueueValidation {
  ok: boolean;
  /** 不通过的原因（结构层面）；`ok` 为 true 时为空数组。 */
  errors: string[];
}

const WRITE_OPERATIONS = new Set<WriteOperation>([
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
  /**
   * 会话事件批量提交。
   *
   * 它是**外部入口必须走队列**的最后一环：没有它，会话提交就只能由
   * 插件进程自己或直写路径完成，外部 AI 客户端要么写不进去，要么绕过队列。
   * 走队列之后，事件仍然由插件在 `Vault.process` 的比较窗口里逐条提交，
   * 并且默认只能产生**待确认候选**（除非事件被明确标记为用户当前回合的命令）。
   */
  'session_commit',
]);

const RECEIPT_STATUSES = new Set<ReceiptStatus>(['completed', 'conflict', 'failed', 'expired']);

/** 保留目录名：这些是工具自己的地盘，记忆文件不许落进去。 */
const RESERVED_SEGMENTS = new Set(['.obsidian', '.git', '.trash', 'node_modules']);

/* ------------------------------------------------------------------ *
 * 路径边界：唯一一处接根的地方
 * ------------------------------------------------------------------ */

/**
 * 校验 `FileStore` 的路径契约：Vault 相对路径，且必须位于记忆根之内。
 *
 * 这是适配器与调用方共用的同一份规则。检查发生在**拼接之前**，
 * 因此 `../x`、绝对路径、保留目录名都会被拒绝，而不是被 normalize 抹平。
 */
export function assertVaultRelativePath(root: string, path: string, label = '路径'): string {
  const safeRoot = assertSafeRoot(root);
  if (typeof path !== 'string') throw new PathError('not_string', `${label}必须是字符串。`);
  const raw = path.trim();
  if (raw === '') throw new PathError('empty', `${label}为空。`);
  // 先看原始写法：绝对、~、盘符、UNC、空字节一律拒绝（归一化会抹掉这些前缀）。
  if (raw.includes('\u0000')) throw new PathError('null_byte', `${label}包含空字节。`);
  if (raw.startsWith('~')) throw new PathError('home', `${label}不允许使用 ~ 家目录写法。`);
  if (/^[a-zA-Z]:/.test(raw)) throw new PathError('drive', `${label}不允许使用盘符写法。`);
  if (raw.startsWith('\\\\')) throw new PathError('unc', `${label}不允许使用 UNC 路径。`);
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new PathError('absolute', `${label}不允许使用绝对路径（本产品的路径都是 Vault 相对路径）。`);
  }
  const safe = assertSafeRelativePath(raw, label);
  const rootSegments = safeRoot.split('/');
  const pathSegments = safe.split('/');
  if (pathSegments.length < rootSegments.length) {
    throw new PathError('outside_root', `${label}不在记忆根 ${safeRoot} 之内：${path}`);
  }
  for (let i = 0; i < rootSegments.length; i += 1) {
    if (pathSegments[i] !== rootSegments[i]) {
      throw new PathError('outside_root', `${label}不在记忆根 ${safeRoot} 之内：${path}`);
    }
  }
  for (const segment of pathSegments.slice(rootSegments.length)) {
    if (RESERVED_SEGMENTS.has(segment.toLowerCase())) {
      throw new PathError('reserved', `${label}落在保留目录 ${segment} 里：${path}`);
    }
  }
  return safe;
}

/** 校验「含记忆根的 Vault 相对路径」，只返回布尔（用于过滤目录枚举结果）。 */
export function isVaultRelativePathInside(root: string, path: string): boolean {
  try {
    assertVaultRelativePath(root, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把「含记忆根的整体路径」转成「相对记忆根」的写法。
 *
 * 这是与 `assertVaultRelativePath` 配对的唯一降级函数：只在真正需要
 * 「相对根」的 API 边界用一次，并且同样拒绝越界、`..` 与保留目录。
 */
export function stripMemoryRoot(root: string, path: string, label = '路径'): string {
  const safeRoot = assertSafeRoot(root);
  const safe = assertVaultRelativePath(safeRoot, path, label);
  if (safe === safeRoot) return '';
  return safe.slice(safeRoot.length + 1);
}

/** 记忆根内的队列子目录（相对**整体**的 Vault 路径）。 */
export function requestDirPath(root: string): string {
  return `${assertSafeRoot(root)}/${REQUEST_DIR}`;
}

/** 记忆根内的回执子目录（相对**整体**的 Vault 路径）。 */
export function receiptDirPath(root: string): string {
  return `${assertSafeRoot(root)}/${RECEIPT_DIR}`;
}

/** 生成请求 id：时间前缀便于人工按序查看，随机段避免碰撞。 */
export function makeRequestId(now: number, random: () => number): string {
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const tail = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `req_${stamp}_${tail}`;
}

/** 请求文件名（**含记忆根**的 Vault 相对路径）。 */
export function requestPath(root: string, id: string): string {
  const safe = assertRequestId(id);
  return `${requestDirPath(root)}/${safe}.md`;
}

/** 回执文件名（**含记忆根**的 Vault 相对路径）。 */
export function receiptPath(root: string, requestId: string): string {
  const safe = assertRequestId(requestId);
  return `${receiptDirPath(root)}/${safe}.md`;
}

/**
 * 请求被取走后的文件名。
 *
 * `requestPathValue` 必须是本模块 `requestPath()` 产出的**含根路径**；
 * 这里会重新校验它属于 `root` 的请求目录，避免调用方传进任意路径。
 */
export function claimedPath(root: string, requestPathValue: string, owner: string): string {
  const safe = assertVaultRelativePath(root, requestPathValue, '请求路径');
  const safeOwner = assertSafeRelativePath(owner, '提交者标识');
  const name = safe.slice(`${requestDirPath(root)}/`.length);
  if (!name.endsWith('.md')) {
    throw new PathError('not_request', `请求路径必须以 .md 结尾：${requestPathValue}`);
  }
  return `${requestDirPath(root)}/${name}${CLAIM_SUFFIX}.${safeOwner}.md`;
}

/** 校验请求 id：必须是单一安全 basename，且符合协议命名。 */
export function assertRequestId(id: unknown): string {
  if (typeof id !== 'string') throw new PathError('not_string', '请求 id 必须是字符串。');
  const trimmed = id.trim();
  if (trimmed === '') throw new PathError('empty', '请求 id 为空。');
  if (trimmed !== id) throw new PathError('whitespace', `请求 id 前后有空白：${JSON.stringify(id)}`);
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new PathError('separator', `请求 id 不允许包含路径分隔符：${id}`);
  }
  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    throw new PathError(
      'bad_id',
      `请求 id 只允许 req_ 前缀 + 字母数字下划线连字符（1–64 位）：${id}`,
    );
  }
  return trimmed;
}

/** 从队列路径提取请求 id（含被取走的形态）；不属于队列则返回 null。 */
export function requestIdFromPath(root: string, path: string): string | null {
  let prefix: string;
  try {
    prefix = `${requestDirPath(root)}/`;
  } catch {
    return null;
  }
  const safe = normalizePath(path);
  if (!safe.startsWith(prefix)) return null;
  const name = safe.slice(prefix.length);
  if (name.includes('/')) return null;
  let base = name;
  const claimedIndex = base.indexOf(`${CLAIM_SUFFIX}.`);
  if (claimedIndex >= 0) base = base.slice(0, claimedIndex);
  if (!base.endsWith('.md')) return null;
  const id = base.slice(0, -3);
  try {
    assertRequestId(id);
    return id;
  } catch {
    return null;
  }
}

/** 该路径是否位于（某记忆根的）请求目录（含被取走的请求）。 */
export function isRequestPath(root: string, path: string): boolean {
  return requestIdFromPath(root, path) !== null;
}

/** 该路径是否位于（某记忆根的）回执目录，且文件名是合法请求 id。 */
export function isReceiptPath(root: string, path: string): boolean {
  let prefix: string;
  try {
    prefix = `${receiptDirPath(root)}/`;
  } catch {
    return false;
  }
  const safe = normalizePath(path);
  if (!safe.startsWith(prefix)) return false;
  const name = safe.slice(prefix.length);
  if (name.includes('/') || !name.endsWith('.md')) return false;
  try {
    assertRequestId(name.slice(0, -3));
    return true;
  } catch {
    return false;
  }
}

/** 该路径是不是被取走的请求（认领态）。 */
export function isClaimedRequestPath(root: string, path: string): boolean {
  return isRequestPath(root, path) && normalizePath(path).includes(`${CLAIM_SUFFIX}.`);
}

/**
 * 队列路径的安全校验：任何进入队列的路径都要过这里。
 * 拒绝越界、非队列路径与非法请求 id。
 */
export function assertQueuePath(root: string, path: string, label = '队列路径'): string {
  const safe = assertVaultRelativePath(root, path, label);
  if (!isRequestPath(root, safe) && !isReceiptPath(root, safe)) {
    throw new PathError('not_queue_path', `${label}不在请求/回执目录内：${path}`);
  }
  return safe;
}

/* ------------------------------------------------------------------ *
 * 请求结构校验
 * ------------------------------------------------------------------ */

/** 允许出现幂等键以外的空字符串字段？不。这些字段必须有内容。 */
function requireString(
  value: unknown,
  field: string,
  errors: string[],
  options: { max?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串`);
    return '';
  }
  if (!options.allowEmpty && value.trim() === '') errors.push(`${field} 不能为空`);
  const max = options.max ?? MAX_TEXT_FIELD_CHARS;
  if (value.length > max) errors.push(`${field} 过长（${value.length} > ${max}）`);
  return value;
}

function requireIsoTime(value: unknown, field: string, errors: string[]): string {
  const text = requireString(value, field, errors, { max: 40 });
  if (text !== '' && !Number.isFinite(Date.parse(text))) errors.push(`${field} 不是有效时间：${text}`);
  return text;
}

/**
 * 逐操作校验载荷。
 *
 * 只校验**结构与边界**：字段名、类型、是否必须、长度上限。
 * 权限与当前现场由提交者在提交时再次判定，绝不从 requester 自报值获得授权。
 */
export function validateOperationPayload(
  operation: WriteOperation,
  payload: Record<string, unknown>,
): QueueValidation {
  const errors: string[] = [];
  const readString = (
    field: string,
    options: { required?: boolean; max?: number; oneOf?: readonly string[] } = {},
  ): void => {
    const value = payload[field];
    if (value === undefined || value === null) {
      if (options.required) errors.push(`payload.${field} 必填`);
      return;
    }
    requireString(value, `payload.${field}`, errors, { max: options.max });
    /**
     * 枚举字段在**入队时**就拒绝未知值（Q01 反例：`scope: 'all'`）。
     *
     * 记录层（`record.ts`）对未知 `scope` 已经是 fail-closed：隔离检索并标 `unknown_scope`。
     * 但那条路只在插件处理队列时才走到——非法请求会先被持久接受、拿到 accepted 回执，
     * 再在提交阶段变成一条「不可检索但确实写进了库」的记忆。
     * 对写入口来说这太晚了：这样的请求根本不该被接受。
     *
     * 这里只做**枚举**判定，不替调用方决定权限：scope 的具体含义与可见范围
     * 仍由提交者在提交时按现场判定。
     */
    if (options.oneOf && typeof value === 'string' && !options.oneOf.includes(value)) {
      errors.push(`payload.${field} 只能是 ${options.oneOf.join('/')} 之一`);
    }
  };
  const readBoolean = (field: string): void => {
    const value = payload[field];
    if (value !== undefined && value !== null && typeof value !== 'boolean') {
      errors.push(`payload.${field} 必须是布尔值`);
    }
  };
  const readStringArray = (field: string): void => {
    const value = payload[field];
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) {
      errors.push(`payload.${field} 必须是字符串数组`);
      return;
    }
    value.forEach((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`payload.${field}[${index}] 必须是非空字符串`);
      }
    });
  };
  const rejectUnknown = (allowed: readonly string[]): void => {
    for (const key of Object.keys(payload)) {
      if (!allowed.includes(key)) errors.push(`payload 出现未定义字段：${key}`);
    }
  };

  switch (operation) {
    case 'remember':
    case 'propose':
      rejectUnknown([
        'body',
        'kind',
        'scope',
        'scope_ref',
        'scopeRef',
        'tags',
        'source_ref',
        'sourceRef',
        'event_id',
        'eventId',
        /**
         * 「不发送给模型」也要能从外部入口表达。
         *
         * 少了它，外部排队写进来的内容永远是 allow_model=true，
         * 用户就没有办法在入队时声明「这条不想给模型看」。
         */
        'allow_model',
        'allowModel',
      ]);
      readString('body', { required: true, max: MAX_TEXT_FIELD_CHARS });
      readString('kind', { max: 40 });
      readString('scope', { max: 40, oneOf: SCOPE_KINDS });
      readString('scope_ref', { max: 200 });
      readString('scopeRef', { max: 200 });
      readString('source_ref', { max: 400 });
      readString('sourceRef', { max: 400 });
      readString('event_id', { max: 200 });
      readString('eventId', { max: 200 });
      readStringArray('tags');
      readBoolean('allow_model');
      readBoolean('allowModel');
      break;
    case 'update':
      rejectUnknown([
        'body',
        'title',
        'tags',
        'kind',
        'scope',
        'scope_ref',
        'scopeRef',
        'reason',
        'valid_until',
        'validUntil',
        'review_after',
        'reviewAfter',
        /**
         * 更新也能改可见性：把一条已经存在的记忆改成「不给模型看」
         * 走的就是这条路。少了它，外部入口只能创建时声明，之后改不了。
         */
        'allow_model',
        'allowModel',
      ]);
      readString('body', { max: MAX_TEXT_FIELD_CHARS });
      readString('title', { max: 300 });
      readString('kind', { max: 40 });
      readString('scope', { max: 40, oneOf: SCOPE_KINDS });
      readString('scope_ref', { max: 200 });
      readString('scopeRef', { max: 200 });
      readString('reason', { max: 2000 });
      readString('valid_until', { max: 40 });
      readString('validUntil', { max: 40 });
      readString('review_after', { max: 40 });
      readString('reviewAfter', { max: 40 });
      readStringArray('tags');
      readBoolean('allow_model');
      readBoolean('allowModel');
      if (
        ['body', 'title', 'tags', 'kind', 'scope', 'scope_ref', 'scopeRef', 'valid_until', 'validUntil', 'review_after', 'reviewAfter', 'allow_model', 'allowModel'].every(
          field => payload[field] === undefined || payload[field] === null,
        )
      ) {
        errors.push('payload 至少要有一个要修改的字段（body/title/tags/kind/scope/valid_until/review_after/allow_model）');
      }
      break;
    case 'correct':
      rejectUnknown(['replacement', 'reason', 'title']);
      readString('replacement', { required: true, max: MAX_TEXT_FIELD_CHARS });
      readString('reason', { max: 2000 });
      readString('title', { max: 300 });
      break;
    case 'supersede':
      rejectUnknown(['body', 'reason', 'kind', 'scope', 'scope_ref', 'scopeRef', 'tags']);
      readString('body', { required: true, max: MAX_TEXT_FIELD_CHARS });
      readString('reason', { max: 2000 });
      readString('kind', { max: 40 });
      readString('scope', { max: 40, oneOf: SCOPE_KINDS });
      readString('scope_ref', { max: 200 });
      readString('scopeRef', { max: 200 });
      readStringArray('tags');
      break;
    case 'forget':
      rejectUnknown(['reason']);
      readString('reason', { max: 2000 });
      break;
    case 'delete':
      rejectUnknown(['reason']);
      readString('reason', { max: 2000 });
      break;
    case 'session_commit': {
      rejectUnknown(['events', 'cursor']);
      const events = payload.events;
      if (!Array.isArray(events)) {
        errors.push('payload.events 必须是数组');
        break;
      }
      if (events.length === 0) {
        errors.push('payload.events 不能是空数组');
        break;
      }
      if (events.length > MAX_SESSION_EVENTS) {
        errors.push(`payload.events 一次最多 ${MAX_SESSION_EVENTS} 条，收到 ${events.length} 条`);
      }
      events.forEach((item, index) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`payload.events[${index}] 必须是对象`);
          return;
        }
        const event = item as Record<string, unknown>;
        for (const key of Object.keys(event)) {
          if (!['event_id', 'eventId', 'text', 'live_user_turn', 'liveUserTurn', 'source_ref', 'sourceRef', 'kind', 'observed_at', 'observedAt', 'tags', 'cursor'].includes(key)) {
            errors.push(`payload.events[${index}] 出现未定义字段：${key}`);
          }
        }
        const text = event.text;
        if (typeof text !== 'string' || text.trim() === '') {
          errors.push(`payload.events[${index}].text 必须是非空字符串`);
        } else if (text.length > MAX_TEXT_FIELD_CHARS) {
          errors.push(`payload.events[${index}].text 超过 ${MAX_TEXT_FIELD_CHARS} 字符上限`);
        }
        /**
         * `live_user_turn` 决定这条事件能不能被当成用户命令。
         * 它必须显式给出，且只能是布尔值——不允许「没写就算真」这种默认。
         */
        const live = event.live_user_turn ?? event.liveUserTurn;
        if (live !== undefined && typeof live !== 'boolean') {
          errors.push(`payload.events[${index}].live_user_turn 必须是布尔值`);
        }
      });
      readString('cursor', { max: 200 });
      break;
    }
    case 'confirm':
    case 'reject':
      rejectUnknown(['reason', 'note']);
      readString('reason', { max: 2000 });
      readString('note', { max: 2000 });
      break;
    case 'restore':
      rejectUnknown(['reason']);
      readString('reason', { max: 2000 });
      break;
    default:
      errors.push(`未知操作：${String(operation)}`);
  }
  return { ok: errors.length === 0, errors };
}

/** 这些操作必须写明目标路径（修改既有记忆）。 */
const NEEDS_TARGET: ReadonlySet<WriteOperation> = new Set<WriteOperation>([
  'update',
  'correct',
  'supersede',
  'forget',
  'delete',
  'confirm',
  'reject',
  'restore',
]);

/** 这些操作会改动既有内容，因此**必须**给出期望哈希。 */
const NEEDS_EXPECTED_HASH: ReadonlySet<WriteOperation> = new Set<WriteOperation>([
  'update',
  'correct',
  'supersede',
  'forget',
  'delete',
  'confirm',
  'reject',
  'restore',
]);

/**
 * 校验请求结构。缺失、类型不对、越界或与操作不匹配一律不通过——
 * 宁可拒绝，也不猜。
 */
export function validateRequest(request: unknown, options: { root?: string } = {}): QueueValidation {
  const errors: string[] = [];
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, errors: ['请求不是对象'] };
  }
  const value = request as Partial<QueueRequest>;
  if (value.protocol !== QUEUE_PROTOCOL_VERSION) {
    errors.push(`协议版本不支持：${String(value.protocol)}（本实现为 ${QUEUE_PROTOCOL_VERSION}）`);
  }

  let id = '';
  try {
    id = assertRequestId(value.id);
  } catch (error) {
    errors.push(`id 不合法：${error instanceof Error ? error.message : String(error)}`);
  }

  const operation = value.operation;
  if (typeof operation !== 'string' || !WRITE_OPERATIONS.has(operation as WriteOperation)) {
    errors.push(`未知操作：${String(value.operation)}`);
  }

  let payload: Record<string, unknown> = {};
  if (value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    errors.push('payload 必须是对象');
  } else {
    payload = value.payload as Record<string, unknown>;
  }

  const target = typeof value.target === 'string' ? value.target : '';
  if (typeof value.target !== 'string') errors.push('target 必须是字符串');
  if (target !== '' && options.root !== undefined) {
    try {
      assertVaultRelativePath(options.root, target, 'target');
    } catch (error) {
      errors.push(`target 不合法：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (target !== '') {
    try {
      assertSafeRelativePath(target, 'target');
    } catch (error) {
      errors.push(`target 不合法：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (typeof operation === 'string' && NEEDS_TARGET.has(operation as WriteOperation) && target === '') {
    errors.push(`操作 ${operation} 必须写明 target`);
  }
  if (target !== '' && options.root !== undefined && typeof operation === 'string') {
    // 目标必须落在记忆根内（新建操作不写 target，故不检查）。
    if (isRequestPath(options.root, target) || isReceiptPath(options.root, target)) {
      errors.push('target 指向队列自己的文件，拒绝处理');
    }
  }

  if (value.expectedHash !== null && typeof value.expectedHash !== 'string') {
    errors.push('expectedHash 必须是字符串或 null');
  } else if (typeof value.expectedHash === 'string') {
    if (!/^[0-9a-f]{8,128}$/i.test(value.expectedHash)) {
      errors.push('expectedHash 必须是十六进制哈希');
    }
  }
  if (typeof operation === 'string' && NEEDS_EXPECTED_HASH.has(operation as WriteOperation)) {
    if (typeof value.expectedHash !== 'string' || value.expectedHash === '') {
      errors.push(`操作 ${operation} 必须给出 expectedHash（乐观并发；否则可能覆盖人工编辑）`);
    }
  }

  if (
    value.expectedRevision !== null &&
    !(
      typeof value.expectedRevision === 'number' &&
      Number.isInteger(value.expectedRevision) &&
      value.expectedRevision >= 1
    )
  ) {
    errors.push('expectedRevision 必须是正整数或 null');
  }

  requireString(value.requester, 'requester', errors, { max: 200 });
  requireIsoTime(value.createdAt, 'createdAt', errors);
  requireIsoTime(value.expiresAt, 'expiresAt', errors);
  requireString(value.idempotencyKey, 'idempotencyKey', errors, { max: 200 });

  if (
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
  ) {
    errors.push('expiresAt 必须晚于 createdAt');
  }

  if (typeof operation === 'string' && WRITE_OPERATIONS.has(operation as WriteOperation)) {
    const payloadValidation = validateOperationPayload(operation as WriteOperation, payload);
    errors.push(...payloadValidation.errors);
  }

  void id;
  return { ok: errors.length === 0, errors };
}

/** 校验回执结构。 */
export function validateReceipt(receipt: unknown, options: { root?: string } = {}): QueueValidation {
  const errors: string[] = [];
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, errors: ['回执不是对象'] };
  }
  const value = receipt as Partial<QueueReceipt>;
  if (value.protocol !== QUEUE_PROTOCOL_VERSION) {
    errors.push(`协议版本不支持：${String(value.protocol)}`);
  }
  let requestId = '';
  try {
    requestId = assertRequestId(value.requestId);
  } catch (error) {
    errors.push(`requestId 不合法：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value.status !== 'string' || !RECEIPT_STATUSES.has(value.status as ReceiptStatus)) {
    errors.push(`未知回执状态：${String(value.status)}`);
  }
  requireString(value.fingerprint, 'fingerprint', errors, { max: 128 });
  requireString(value.committedBy, 'committedBy', errors, { max: 200 });
  requireIsoTime(value.committedAt, 'committedAt', errors);
  if (typeof value.message !== 'string') errors.push('message 必须是字符串');
  else if (value.message.length > MAX_TEXT_FIELD_CHARS) errors.push('message 过长');
  if (typeof value.idempotencyKey !== 'string') errors.push('idempotencyKey 必须是字符串');
  if (value.path !== null && value.path !== undefined && typeof value.path !== 'string') {
    errors.push('path 必须是字符串或 null');
  } else if (typeof value.path === 'string' && value.path !== '' && options.root !== undefined) {
    try {
      assertVaultRelativePath(options.root, value.path, 'path');
    } catch (error) {
      errors.push(`path 不合法：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (value.actualHash !== null && value.actualHash !== undefined && typeof value.actualHash !== 'string') {
    errors.push('actualHash 必须是字符串或 null');
  }

  if (value.status === 'completed') {
    const evidence = value.evidence;
    if (evidence === null || evidence === undefined || typeof evidence !== 'object') {
      errors.push('completed 回执必须带落地证据（evidence）');
    } else if (evidence.kind === 'content') {
      if (typeof evidence.contentHash !== 'string' || !/^[0-9a-f]{8,128}$/i.test(evidence.contentHash)) {
        errors.push('completed 回执的内容证据必须带合法 contentHash');
      }
      if (typeof evidence.revision !== 'number' || !Number.isInteger(evidence.revision) || evidence.revision < 1) {
        errors.push('completed 回执的内容证据必须带正整数 revision');
      }
    } else if (evidence.kind === 'deletion') {
      if (typeof evidence.previousHash !== 'string' || !/^[0-9a-f]{8,128}$/i.test(evidence.previousHash)) {
        errors.push('completed 删除回执必须带被删内容的 previousHash');
      }
      if (typeof evidence.tombstoneId !== 'string' || evidence.tombstoneId.trim() === '') {
        errors.push('completed 删除回执必须带 tombstoneId（删除标记）');
      }
      if (
        evidence.revision !== null &&
        !(typeof evidence.revision === 'number' && Number.isInteger(evidence.revision) && evidence.revision >= 1)
      ) {
        errors.push('completed 删除回执的 revision 必须是正整数或 null');
      }
    } else {
      errors.push(`未知的落地证据类型：${String((evidence as { kind?: unknown }).kind)}`);
    }
    if (typeof value.memoryId !== 'string' || value.memoryId.trim() === '') {
      errors.push('completed 回执必须带 memoryId');
    }
    if (typeof value.path !== 'string' || value.path.trim() === '') {
      errors.push('completed 回执必须带 path');
    }
  }
  void requestId;
  return { ok: errors.length === 0, errors };
}

/** 请求是否已超过存活期。 */
export function isRequestExpired(request: Pick<QueueRequest, 'expiresAt'>, now: number): boolean {
  const at = Date.parse(request.expiresAt);
  return Number.isFinite(at) && at < now;
}

/* ------------------------------------------------------------------ *
 * 幂等身份
 * ------------------------------------------------------------------ */

/**
 * 规范化 JSON：对象键排序、拒绝非有限数字与 undefined。
 * 指纹必须对**同一逻辑请求**稳定，因此不能依赖键的书写顺序。
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value as number)) throw new PathError('bad_number', '指纹里出现非有限数字。');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new PathError('bad_value', `指纹里出现不可序列化的值：${type}`);
}

/**
 * 请求指纹：规范化后的**完整操作身份**。
 *
 * 包含操作名、目标、载荷与全部 CAS 条件（expectedHash / expectedRevision），
 * 且**不含**请求 id 与时间戳——同一个逻辑请求换一个 id 重发时指纹必须相同，
 * 而「同名不同内容」的请求必须产生不同指纹，从而被拒绝而不是复用旧回执。
 */
export function requestFingerprint(
  request: Pick<QueueRequest, 'operation' | 'target' | 'payload' | 'expectedHash' | 'expectedRevision'>,
): string {
  return sha256Hex(
    canonicalJson({
      v: QUEUE_PROTOCOL_VERSION,
      operation: request.operation,
      target: request.target === '' ? '' : normalizePath(request.target),
      payload: request.payload,
      expectedHash: request.expectedHash,
      expectedRevision: request.expectedRevision,
    }),
  );
}

/**
 * 幂等判定：给定已有请求列表，判断新请求是否与其中之一**完全等价**。
 *
 * 等价＝相同 `idempotencyKey`、相同 `operation`、**且相同指纹**。
 * 只比 key/operation 会让「同名不同内容」的新请求被静默丢弃。
 */
export function findIdempotentMatch(
  existing: ReadonlyArray<Pick<QueueRequest, 'id' | 'idempotencyKey' | 'operation' | 'target' | 'payload' | 'expectedHash' | 'expectedRevision'>>,
  candidate: Pick<QueueRequest, 'idempotencyKey' | 'operation' | 'target' | 'payload' | 'expectedHash' | 'expectedRevision'>,
): string | null {
  const wanted = requestFingerprint(candidate);
  for (const request of existing) {
    if (request.idempotencyKey !== candidate.idempotencyKey) continue;
    if (request.operation !== candidate.operation) continue;
    if (requestFingerprint(request) !== wanted) continue;
    return request.id;
  }
  return null;
}

/** 供 UI 展示：状态的中文标签。 */
export const RECEIPT_LABELS_ZH: Record<ReceiptStatus, string> = {
  completed: '已提交',
  conflict: '冲突（未提交）',
  failed: '失败（未提交）',
  expired: '已过期（未提交）',
};

/** 该回执是否代表记忆真的变了。 */
export function receiptIsCommit(receipt: Pick<QueueReceipt, 'status'>): boolean {
  return receipt.status === 'completed';
}

#!/usr/bin/env node
/**
 * `mom-memory-mcp` —— MCP（Model Context Protocol）stdio 服务器。
 *
 * 这是给「别的 AI 客户端」用的入口：Claude Desktop、Cursor、任意支持 MCP 的宿主
 * 都能通过它读写同一份记忆库。它与 CLI **共用同一个核心与同一套队列契约**：
 *
 * - 读操作（search / get / explain / status / receipts / queue_status）直接读，不排队；
 * - 写操作默认**只排队**到 `<记忆根>/.memory/requests/`，由 Obsidian 插件提交；
 *   这样做是因为「同时只有一个 Markdown 写入者」——外部进程不直接改笔记文件。
 * - `accepted`（已排队）与 `completed`（已提交）是两个不同状态，回执里写清楚。
 *
 * 边界：
 * - 必须给 `--vault`（或环境变量 MOM_VAULT）；不给就报错退出，不猜用户库。
 * - 不提供任意文件读写工具：目录范围由本地启动配置确定，工具不能自行扩大。
 * - 不支持 `--direct`：MCP 面向 AI 客户端，不能给它绕过队列直写用户笔记的能力。
 *   需要直写的人请用 CLI，并在命令行上显式承担风险。
 *
 * 传输：stdin/stdout 上的换行分隔 JSON-RPC 2.0（MCP stdio 传输）。
 * 日志一律走 stderr，绝不污染协议流。
 */

import path from 'node:path';
import {
  DEFAULT_ROOT,
  MEMORY_CATEGORIES,
  MemoryStore,
  SCOPE_KINDS,
  evaluateGuard,
  readTitle,
  sha256Hex,
  type GuardSourceKind,
  type MemoryRecord,
  type OrganizationSettings,
  type QueueReceipt,
  type ScopeFilter,
  type ScopeKind,
} from '@mom/core';
import { NodeFileStore } from './node-store.js';
import { ExternalQueueClient, RECEIPT_LABELS } from './external-queue.js';
import { categoryFrom, organizationFromStartup } from './organization-options.js';

const NAME = 'missher-obsidian-memory';
/**
 * 版本身份。
 *
 * `__MOM_VERSION__` 由 `scripts/build.mjs` 从根 `package.json` 注入
 * （esbuild `define`）；下面的声明既让 TypeScript 通过，也让
 * 「忘了用构建脚本、直接跑源码」时退到一个明确标记的占位值，
 * 而不是悄悄报出一个看似真实的版本号。
 */
declare const __MOM_VERSION__: string | undefined;
const VERSION = typeof __MOM_VERSION__ === 'string' ? __MOM_VERSION__ : '0.0.0-unbuilt';
const PROTOCOL_VERSION = '2024-11-05';

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): { vault: string; root: string; organization: OrganizationSettings } {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const rawKey = separator < 0 ? body : body.slice(0, separator);
    const inline = separator < 0 ? undefined : body.slice(separator + 1);
    const value = inline ?? argv[index + 1] ?? '';
    if (inline === undefined) index += 1;
    flags.set(rawKey ?? '', value);
  }
  const vaultFlag = flags.get('vault') ?? process.env.MOM_VAULT ?? '';
  const vault = typeof vaultFlag === 'string' ? vaultFlag : '';
  if (vault.trim() === '') {
    throw new Error(
      'MCP 服务器需要 --vault <库目录>（或环境变量 MOM_VAULT）。没有默认值：不会猜你的库在哪。',
    );
  }
  const rootFlag = flags.get('root') ?? process.env.MOM_ROOT ?? DEFAULT_ROOT;
  return {
    vault: path.resolve(vault),
    root: typeof rootFlag === 'string' ? rootFlag : DEFAULT_ROOT,
    organization: organizationFromStartup(flags),
  };
}

/* ------------------------------------------------------------------ */
/* 由参数构造的运行时上下文                                            */
/* ------------------------------------------------------------------ */

const config = parseArgs(process.argv.slice(2));

/**
 * 解析范围参数。
 *
 * 规则来自核心的 `SCOPE_KINDS`（personal / project / context），
 * **不使用任何强制类型转换**：跨层不一致（比如这里多写一个 team）
 * 应当直接报错，而不是被 `as ScopeKind` 掩盖过去，
 * 更不该被当成某个合法范围和别的记录混在一起。
 *
 * - 省略 → `null`（调用方按「只看 personal」处理）；
 * - `personal` → 个人范围，不接受 ref；
 * - `project:<名称>` / `context:<名称>` → 必须有非空 ref；
 * - 其余一律拒绝，并在错误里列出真正可用的取值。
 */
const scopeFrom = (args: Record<string, unknown> | undefined): ScopeFilter | null => {
  const raw = args?.scope;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error('scope 必须是字符串，例如 personal 或 project:我的项目。');
  const value = raw.trim();
  if (value === '') return null;
  const separator = value.indexOf(':');
  const kind = separator < 0 ? value : value.slice(0, separator);
  const ref = separator < 0 ? '' : value.slice(separator + 1).trim();
  if (!(SCOPE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `未知范围「${kind}」；可用取值：${SCOPE_KINDS.join(' / ')}（项目与情境范围写成 project:<名称>、context:<名称>）。`,
    );
  }
  if (kind === 'personal') {
    if (ref !== '') throw new Error('personal 范围不接受 ref；项目范围请写 project:<名称>。');
    return { scope: 'personal' };
  }
  if (ref === '') {
    throw new Error(`${kind} 范围必须带名称，例如 ${kind}:<名称>；不带名称会跨所有${kind}范围读取。`);
  }
  return { scope: kind as ScopeKind, ref };
};

/**
 * 建立一次调用所需的运行时。
 *
 * `NodeFileStore.open` 会做真实的路径校验（库是否存在、记忆根是否安全），
 * 并且**默认不允许直写**——MCP 没有 `--direct` 开关，写请求只能排队。
 */
const context = async (): Promise<{ store: MemoryStore; queue: ExternalQueueClient }> => {
  const fileStore = await NodeFileStore.open({ vaultRoot: config.vault, memoryRoot: config.root, organization: config.organization });
  const store = new MemoryStore({ store: fileStore, root: config.root, organization: config.organization });
  await store.load();
  const queue = new ExternalQueueClient({ vaultRoot: fileStore.resolvedVaultRoot, memoryRoot: config.root, organization: config.organization });
  return { store, queue };
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一条记录是否**允许发送给模型**。
 *
 * MCP 是给 AI 用的入口，因此立场很硬：`allow_model: false` 的记录
 * （以及无效、未确认、已撤回、过期、被替代的记录）**任何参数组合都取不到**——
 * 搜索不给片段、知道 id 也不给正文、诊断不给路径。
 *
 * 有一条曾经存在、现在**明确删除**的设计要说明：早先有一个
 * `includePrivate: true` 参数，本意是「人自己开个后门」。
 * 它被删掉是因为工具参数是**调用方（AI）自己填的**：
 * 让参数决定权限，等于让 AI 给自己发授权。权限只能来自本地配置或用户在
 * Obsidian 界面里的修改（改记录的模型许可），不能来自请求本身。
 *
 * 运行时同样拒绝：即使有人手工构造 `includePrivate: true` 去调，
 * 下面的判断也不看这个字段（它读都不读），一律按 allow_model 处理。
 */
interface Admission {
  allowed: boolean;
  reason: string;
}

const admitForModel = (store: MemoryStore, record: MemoryRecord): Admission => {
  if (!store.isOperational) {
    return { allowed: false, reason: `存储不可操作：${store.operationalBlockReason ?? '存在致命读盘问题'}` };
  }
  if (record.invalid === true) return { allowed: false, reason: '元数据无法解释（invalid）' };
  if (record.meta.category === 'template') return { allowed: false, reason: '模板仅用于结构参考，不作为已确认事实发送给模型' };
  if (record.meta.status !== 'confirmed') {
    return { allowed: false, reason: `状态是 ${record.meta.status}，不是已确认事实` };
  }
  const from = Date.parse(record.meta.valid_from);
  if (Number.isFinite(from) && from > Date.now()) return { allowed: false, reason: '尚未生效' };
  const until = Date.parse(record.meta.valid_until);
  if (Number.isFinite(until) && until <= Date.now()) return { allowed: false, reason: '已过有效期' };
  if (record.meta.allow_model !== true) {
    return { allowed: false, reason: '设置为不发送给模型（allow_model=false）' };
  }
  return { allowed: true, reason: '允许' };
};

/** 按范围过滤：不指定时只看个人范围，绝不隐式跨项目。 */
const inScope = (record: MemoryRecord, scope: ScopeFilter | null): boolean => {
  if (scope === null) return record.meta.scope === 'personal';
  if (record.meta.scope !== scope.scope) return false;
  if (scope.scope === 'personal') return true;
  return record.meta.scope_ref === (scope.ref ?? '');
};

/* ------------------------------------------------------------------ */
/* 回执的可见性投影                                                    */
/* ------------------------------------------------------------------ */

/**
 * 回执也要过**同一套当前可见性规则**。
 *
 * 为什么这是必须的：回执里的 `path` 含原文标题，
 * `message` 形如「已记住：<含标题路径>」，`memoryId` 直接指向记录。
 * 如果回执原样返回，那么「把记录改成 `allow_model: false`」「删除记录」
 * 「换成别的项目范围」之后，AI 仍然能从**历史回执**里取回标题片段——
 * 搜索、读取、诊断三条路都堵住了，却从第四条路漏了出去。
 *
 * 三条同时成立才允许返回完整细节：
 * 1. 回执真的指向一条当前还能读到的记录（`memoryId` 存在）；
 * 2. 那条记录通过 `admitForModel`（许可、状态、有效期、存储可操作）；
 * 3. 那条记录落在调用方声明的范围内。
 *
 * 不满足时**只保留请求状态**：`completed` 仍然是 `completed`、
 * `conflict` 仍然是 `conflict`。脱敏绝不能把「已完成」改写成「待处理」——
 * 那是另一种撒谎，而且会让调用方做出错误决定。
 *
 * 没有 `memoryId` 的回执（conflict / failed / expired）天然没有可出现的细节：
 * 它们本来就没写进任何笔记，因此不返回路径与原始 message。
 */
const REDACTION_REASON_TEXT: Record<string, string> = {
  missing: '这条回执没有对应的记忆记录（本次写入未生效）。',
  unknown: '记录当前取不到（可能已被删除或尚未载入索引）。',
  hidden: '记录当前不允许发送给模型（allow_model=false）或状态不再可见。',
  out_of_scope: '记录不在本次声明的范围内。',
  store_down: '记忆库当前不可操作，为避免泄漏内容已隐藏细节。',
};

interface ReceiptView {
  requestId: string;
  status: QueueReceipt['status'];
  label: string;
  committedAt: string;
  /** 细节是否被隐藏。true 时其余字段是固定文案，不含原文。 */
  detailsHidden: boolean;
  /** 隐藏原因（不含任何原文片段）。 */
  reason: string;
  memoryId?: string | null;
  memoryPath?: string | null;
  revision?: number | null;
  message?: string;
}

/**
 * 判断一条回执现在能不能带着细节返回。
 *
 * 单独抽出来是为了让**单条等待**和**批量列出**走同一条判断——
 * 两处各写一遍，迟早会出现「单条堵住了、批量还漏着」。
 */
const receiptVisibility = (
  store: MemoryStore,
  receipt: QueueReceipt,
  scope: ScopeFilter | null,
): { visible: boolean; reason: string; detail: string } => {
  if (!store.isOperational) {
    return { visible: false, reason: REDACTION_REASON_TEXT.store_down!, detail: 'store_down' };
  }
  const memoryId = receipt.memoryId;
  if (memoryId === null || memoryId === undefined || memoryId === '') {
    return { visible: false, reason: REDACTION_REASON_TEXT.missing!, detail: 'missing' };
  }
  const record = store.get(memoryId);
  if (record === null || record === undefined) {
    return { visible: false, reason: REDACTION_REASON_TEXT.unknown!, detail: 'unknown' };
  }
  const admission = admitForModel(store, record);
  if (!admission.allowed) {
    return { visible: false, reason: REDACTION_REASON_TEXT.hidden!, detail: 'hidden' };
  }
  if (!inScope(record, scope)) {
    return { visible: false, reason: REDACTION_REASON_TEXT.out_of_scope!, detail: 'out_of_scope' };
  }
  return { visible: true, reason: '', detail: 'full' };
};

/** 把一条回执投影成可返回的视图：要么全细节，要么只有状态与固定原因。 */
const projectReceipt = (
  store: MemoryStore,
  receipt: QueueReceipt,
  scope: ScopeFilter | null,
): ReceiptView => {
  const visibility = receiptVisibility(store, receipt, scope);
  const base: ReceiptView = {
    requestId: receipt.requestId,
    status: receipt.status,
    label: RECEIPT_LABELS[receipt.status] ?? receipt.status,
    committedAt: receipt.committedAt,
    detailsHidden: !visibility.visible,
    reason: visibility.reason,
  };
  if (!visibility.visible) return base;
  return {
    ...base,
    memoryId: receipt.memoryId ?? null,
    memoryPath: receipt.path ?? null,
    revision: receipt.revision,
    message: receipt.message,
  };
};

/** 读盘故障时读工具也要如实报告，而不是返回空的「没找到」。 */
const guardRead = (store: MemoryStore): void => {
  if (!store.isOperational) {
    throw new Error(
      `记忆库当前不可操作：${store.operationalBlockReason ?? '存在致命读盘问题'}。` +
        '为避免把「读不到」说成「没有记录」，本次读取已中止；请先在 Obsidian 里处理这些问题。',
    );
  }
};

const limitFrom = (args: Record<string, unknown> | undefined, fallback = 8): number => {
  const raw = Number(args?.limit ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(50, Math.floor(raw));
};

const TOOLS = [
  {
    name: 'memory_search',
    description:
      '在记忆库里按关键词检索。默认只看 personal 范围与已确认事实，不传 scope 时不会跨项目。' +
      '返回 id、路径、标题与命中原因。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '检索词。' },
        scope: { type: 'string', description: '范围，如 personal 或 project:<名称>。省略即只看 personal。' },
        limit: { type: 'number', description: '最多返回几条（默认 8，上限 50）。' },
        includeExpired: { type: 'boolean', description: '是否包含已过期记录（默认否）。' },
        includeNonConfirmed: { type: 'boolean', description: '是否包含待确认/已撤回记录（默认否）。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_get',
    description:
      '按 id 读取一条记忆的正文。默认只返回「已确认 + 在范围内 + 允许发送给模型」的记录；' +
      '其余情况一律返回同一个「取不到」的回答（不区分存在与否，避免被用来探测记录）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id，形如 mem_xxx。' },
        scope: { type: 'string', description: '范围：省略即只看 personal，项目写 project:<名称>、情境写 context:<名称>。' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_explain',
    description: '解释某条候选内容为什么会被允许写入（命中哪条守卫、需要什么确认）。只做判断，不写盘。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '候选正文。' },
        sourceKind: { type: 'string', description: '来源类型，如 user_explicit、session_event。' },
        scope: { type: 'string', description: '拟写入范围。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_status',
    description: '记忆库整体状态：条数、按状态分布、索引是否可用、读盘问题、队列与回执概况。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_remember',
    description:
      '**排队**一条记忆写入请求（与 CLI 的 remember/propose 同一契约）。\n' +
      '语义必须看清楚：accepted 表示「已排队」，**不等于**「已提交」；真正落盘由 Obsidian 插件完成。\n' +
      '`pending: false`（默认）→ 队列操作 remember：插件提交后是一条**已确认事实**。\n' +
      '`pending: true` → 队列操作 propose：插件提交后是**待用户确认的候选**，不会直接生效。\n' +
      '外部 AI 客户端若不确定用户是否真的想长期记住，应当用 pending: true。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆正文（必填）。' },
        title: { type: 'string', minLength: 1, maxLength: 300, description: '可选短标题（最多 300 字符）；正文保留完整内容。' },
        pending: {
          type: 'boolean',
          description: 'true 表示只生成待确认候选（队列操作 propose），默认 false（remember）。',
        },
        kind: { type: 'string', description: '记忆类型，如 fact、decision、preference、todo。' },
        category: { type: 'string', enum: MEMORY_CATEGORIES, description: '内容分类；目录由本地启动配置决定，不能在工具中指定路径。' },
        scope: { type: 'string', description: '范围，默认 personal；项目范围写 project:<名称>。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
        sourceRef: { type: 'string', description: '来源引用（可追溯用），例如文档地址或会话 id。' },
        idempotencyKey: { type: 'string', description: '幂等键：同键同内容不会重复排队。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_update',
    description:
      '**排队**一次修正请求。必须同时给出 id 与 hash（hash 来自 memory_get）：' +
      '没有它们就等于「不管现在是什么都改」，队列会直接拒绝。' +
      '提交前会核对当前内容，人工编辑不会被覆盖，只会得到 conflict 回执。' +
      '如果只是想提出一个看法让用户决定，用 memory_remember 的 pending: true。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要修正的记忆 id。' },
        hash: { type: 'string', description: '你读到的当前内容哈希（memory_get 返回值里的 hash）。' },
        text: { type: 'string', description: '新的正文。' },
        title: { type: 'string', description: '新的标题（可选）。' },
        tags: { type: 'array', items: { type: 'string' }, description: '新的标签（可选，整体替换）。' },
        reason: { type: 'string', description: '这次修正的理由（会写进记录）。' },
      },
      required: ['id', 'hash'],
    },
  },
  {
    name: 'memory_forget',
    description:
      '**排队**一次「停止使用」请求（归档，保留历史，不删文件）。这是破坏性操作的入口，' +
      '因此默认要求给出 hash；确认移除由用户在 Obsidian 界面里完成。' +
      '永久删除（delete）**没有** MCP 工具：那需要人在本机界面里操作。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要停止使用的记忆 id。' },
        hash: { type: 'string', description: '你读到的当前内容哈希（memory_get 返回值里的 hash）。' },
        reason: { type: 'string', description: '停止使用的原因。' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_session_commit',
    description:
      '**排队**一批会话事件（每行一条记录的结构化版本），由 Obsidian 插件逐条提交。' +
      '与 CLI 的 session-commit 同一契约：事件默认成为**待确认候选**；' +
      '只有把 live_user_turn 标为 true（表示这是用户当前回合的原话）才可能直接确认——' +
      '而且护栏仍然会独立校验，自报不能绕过。' +
      '`explicit` 不是由调用方声明的字段，别在事件里传它。',
    inputSchema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          description: '事件数组（最多 500 条）。',
          items: {
            type: 'object',
            properties: {
              eventId: { type: 'string', description: '稳定事件 id：同 id 重复提交不会产生第二条。' },
              text: { type: 'string', description: '事件文本。' },
              liveUserTurn: {
                type: 'boolean',
                description: 'true 表示这是用户当前回合的原话（可能被确认为事实）。省略视为 false。',
              },
              sourceRef: { type: 'string', description: '来源引用，例如会话 id。' },
              kind: { type: 'string', description: '记忆类型，可选。' },
              observedAt: { type: 'string', description: '观察时间（ISO 字符串），可选。' },
              tags: { type: 'array', items: { type: 'string' }, description: '标签，可选。' },
            },
            required: ['text'],
          },
        },
        cursor: { type: 'string', description: '处理游标（成功提交后写入），可选。' },
      },
      required: ['events'],
    },
  },
  {
    name: 'memory_wait_receipt',
    description:
      '等待某个排队请求的回执（最长 timeoutSeconds 秒，默认 30，上限 120）。' +
      '状态照实返回：completed / conflict / failed / expired；超时则说明请求仍在队列里。' +
      '只有当回执指向的记录**当前仍可见**（未删除、允许发送给模型、在声明范围内）时才附带' +
      '路径与说明；否则只返回状态与固定原因（detailsHidden=true），不返回标题、路径或正文片段。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '请求 id，形如 req_xxx。' },
        timeoutSeconds: { type: 'number', description: '等待秒数，默认 30。' },
        scope: { type: 'string', description: '范围：省略即只看 personal，项目写 project:<名称>、情境写 context:<名称>。' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_receipts',
    description:
      '列出最近的写入回执（状态、时间、失败/冲突原因）。' +
      '回执指向的记录若当前不可见（已删除、allow_model=false、不在范围内），' +
      '该条只返回状态与固定原因，不返回路径或标题。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回几条（默认 20）。' },
        scope: { type: 'string', description: '范围：省略即只看 personal，项目写 project:<名称>、情境写 context:<名称>。' },
      },
    },
  },
  {
    name: 'memory_queue_status',
    description: '查看写入队列：排队中多少条、已过期多少条、最近一条回执时间。',
    inputSchema: { type: 'object', properties: {} },
  },
];

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  for (const key of ['organization', 'layout', 'placement', 'folders', 'folders-json', 'root', 'vault']) {
    if (Object.hasOwn(args, key)) throw new Error(`${key} 只能由本地启动配置指定，工具调用不能改变目录范围。`);
  }
  const { store, queue } = await context();
  switch (name) {
    case 'memory_search': {
      guardRead(store);
      const scope = scopeFrom(args);
      const result = await store.search({
        text: String(args?.text ?? ''),
        limit: limitFrom(args),
        includeExpired: args?.includeExpired === true,
        includeNonConfirmed: args?.includeNonConfirmed === true,
        ...(scope === null ? {} : { scopes: [scope] }),
      });
      /**
       * 逐个命中判准入，**先过滤再输出**。
       *
       * 过滤在同一个同步块里完成（中间没有 await），因此不会出现
       * 「取列表时允许、输出时已经改成不允许」这种时间差；
       * 命中被拦下时只报数量与类别，不回 id、不回路径、不回片段——
       * 否则「不能发送的内容」仍然会通过存在性泄出去。
       */
      const visible: Array<Record<string, unknown>> = [];
      const hidden: Record<string, number> = {};
      for (const hit of result.hits) {
        const record = store.get(hit.id);
        if (record === null) {
          hidden['记录已不存在'] = (hidden['记录已不存在'] ?? 0) + 1;
          continue;
        }
        if (!inScope(record, scope)) {
          hidden['不在请求范围内'] = (hidden['不在请求范围内'] ?? 0) + 1;
          continue;
        }
        const admission = admitForModel(store, record);
        if (!admission.allowed) {
          hidden[admission.reason] = (hidden[admission.reason] ?? 0) + 1;
          continue;
        }
        visible.push({
          id: hit.id,
          path: hit.path,
          title: hit.title,
          kind: hit.kind,
          status: hit.status,
          scope: hit.scope_ref === '' ? hit.scope : `${hit.scope}:${hit.scope_ref}`,
          reasons: hit.reasons,
          snippet: hit.snippets[0]?.text ?? '',
        });
      }
      return text({
        note: args?.scope === undefined ? '未指定范围：按默认只看 personal。' : undefined,
        hits: visible,
        /** 被拦下的只给数量与类别：不泄露有哪些记录、也不泄露它们的内容。 */
        hidden: Object.keys(hidden).length === 0 ? undefined : hidden,
        hiddenNote:
          Object.keys(hidden).length === 0
            ? undefined
            : '这些记录没有被发送，也不会在这里给出标识或片段。需要查看请在本机的 Obsidian 界面里打开。',
        diagnosis: {
          candidates: result.diagnosis.candidates,
          excludedByScope: result.diagnosis.excludedByScope,
          excludedByStatus: result.diagnosis.excludedByStatus,
          excludedByExpired: result.diagnosis.excludedByExpired,
        },
      });
    }
    case 'memory_get': {
      guardRead(store);
      const scope = scopeFrom(args);
      const record = store.get(String(args?.id ?? ''));
      /**
       * 统一的「看不到」回答。
       *
       * 找不到、不在范围内、不允许发送——对外**一律同样的回答**。
       * 分开写会变成探测器：模型可以拿 id 逐个试，从错误文案的差别里
       * 推断出「这条记录存在但不能发给我」。
       */
      const unavailable = {
        found: false,
        message:
          '在当前范围与准入条件下取不到这条记忆。可能是不存在、不在请求范围内、' +
          '不是已确认事实，或设置为不发送给模型。需要确认请在本机的 Obsidian 界面里查看。',
      };
      if (record === null) return text(unavailable);
      if (!inScope(record, scope)) return text(unavailable);
      const admission = admitForModel(store, record);
      if (!admission.allowed) return text(unavailable);
      return text({
        found: true,
        id: record.meta.id,
        path: record.path,
        /** 标题由核心从正文推导，与界面显示的完全一致。 */
        title: readTitle(record),
        body: record.body,
        /** 只给可用于「接下来要更新它」的并发控制字段，不给完整元数据。 */
        revision: record.meta.revision,
        hash: store.hashOf(record.meta.id),
        kind: record.meta.kind,
        scope: record.meta.scope_ref === '' ? record.meta.scope : `${record.meta.scope}:${record.meta.scope_ref}`,
        tags: record.meta.tags,
        updatedAt: record.meta.updated_at,
        sources: record.sources.map(source => ({ kind: source.kind, ref: source.ref, observed_at: source.observed_at })),
      });
    }
    case 'memory_explain': {
      guardRead(store);
      const scope = scopeFrom(args);
      /**
       * 这里解释的是**护栏**判决：这段文本会不会被当成「用户明确要求记住」。
       *
       * 语义很容易被误读，所以明确写清楚：`explicit: false` **不等于**「不允许保存」，
       * 只表示它不是一条显式命令，因此不能走「用户动作直接授权」那条路，
       * 而应当作为待确认候选。外部客户端来的文本永远属于这一档。
       */
      const verdict = evaluateGuard({
        text: String(args?.text ?? ''),
        sourceKind: (typeof args?.sourceKind === 'string' ? args.sourceKind : 'external_document') as GuardSourceKind,
        isLiveUserTurn: args?.isLiveUserTurn === true,
      });
      return text({
        explicit: verdict.explicit,
        reason: verdict.reason,
        matches: verdict.matches,
        wouldNeedConfirmation: !verdict.explicit,
        note:
          '这只是判断结果，没有写入任何文件。写盘仍需通过 memory_remember 排队；' +
          'explicit=false 表示「不是用户的显式命令」，会作为待确认候选而不是被拒绝。',
      });
    }
    case 'memory_status': {
      const all = store.all();
      const byStatus: Record<string, number> = {};
      for (const record of all) byStatus[record.meta.status] = (byStatus[record.meta.status] ?? 0) + 1;
      const receipts = await queue.listReceipts(50);
      const pending = await queue.pendingCount();
      return text({
        vault: config.vault,
        memoryRoot: config.root,
        operational: store.isOperational,
        blockReason: store.operationalBlockReason,
        total: all.length,
        byStatus,
        patches: store.allPatches().length,
        queue: { pending: pending.pending, expired: pending.expired, recentReceipts: receipts.length },
        version: VERSION,
      });
    }
    case 'memory_remember': {
      const body = String(args?.text ?? '');
      if (body.trim() === '') throw new Error('memory_remember 需要非空的 text。');
      const scope = scopeFrom(args);
      const kind = typeof args?.kind === 'string' ? args.kind : undefined;
      const category = categoryFrom(args?.category);
      const scopePart = scope === null ? 'personal' : `${scope.scope}:${scope.ref ?? ''}`;
      /**
       * `pending: true` 走 propose（候选，需要用户确认），否则走 remember（已确认事实）。
       *
       * 两张票都只是**排队**：真正的写入由 Obsidian 插件完成，
       * 而队列本身设定了「sourceKind = user_explicit」的来源记号——
       * 那表示「入库这件事由用户授权」，不表示「模型可以自己决定什么算事实」。
       * 因此对不确定的内容应当明确用 pending: true，让用户在界面上决定。
       */
      const pending = args?.pending === true;
      const result = await queue.enqueue({
        operation: pending ? 'propose' : 'remember',
        payload: {
          body,
          ...(args?.title === undefined ? {} : { title: args.title }),
          ...(kind === undefined ? {} : { kind }),
          ...(category === undefined ? {} : { category }),
          ...(Array.isArray(args?.tags) && args.tags.length > 0 ? { tags: args.tags.map(String) } : {}),
          ...(scope === null ? {} : { scope: scope.scope, scope_ref: scope.ref ?? '' }),
          ...(typeof args?.sourceRef === 'string' && args.sourceRef.trim() !== ''
            ? { source_ref: args.sourceRef }
            : {}),
        },
        requester: 'mcp',
        /**
         * 幂等键：默认由范围与内容决定，客户端重试不会排出两条一样的请求。
         * 客户端也可以自己给一个覆盖默认值。
         */
        idempotencyKey:
          typeof args?.idempotencyKey === 'string' && args.idempotencyKey.trim() !== ''
            ? args.idempotencyKey
            : `mcp:remember:${scopePart}:${category === undefined ? '' : `${category}:`}${body}`,
      });
      if (!result.accepted) throw new Error(`请求未被受理：${result.error ?? '未知原因'}`);
      return text({
        status: 'accepted',
        meaning: '已排队 ≠ 已提交：真正落盘由 Obsidian 插件完成。',
        operation: pending ? 'propose（待确认候选）' : 'remember（已确认事实）',
        requestId: result.requestId,
        requestPath: result.path,
        duplicate: result.duplicate,
        next: `用 memory_wait_receipt 传 id=${result.requestId} 等待结果，或在 Obsidian 里查看回执。`,
      });
    }
    case 'memory_update': {
      const id = String(args?.id ?? '');
      const hash = typeof args?.hash === 'string' ? args.hash.trim() : '';
      if (id === '' || hash === '') {
        throw new Error(
          'memory_update 需要 id 与 hash：先用 memory_get 读到当前内容与哈希，再提交修正。' +
            '没有哈希就无法保证不覆盖人工编辑。',
        );
      }
      const record = store.get(id);
      if (record === null) throw new Error(`取不到记忆 ${id}：不存在、不在范围内或不允许发送给模型。`);
      /**
       * 调用方给的 hash 必须与当前内容一致。
       *
       * 不一致有两种可能，两种都不该继续：内容已经变了（你手上是过期版本），
       * 或者你在拿一个猜的哈希试探。无论如何先让调用方重新读一次。
       */
      const currentHash = store.hashOf(id) ?? '';
      if (hash !== currentHash) {
        throw new Error(
          `你给出的 hash 与当前内容不一致（当前是 ${currentHash.slice(0, 12)}…）。` +
            '请先用 memory_get 重新读取，确认要改的是哪一版，再提交修正。',
        );
      }
      const body = typeof args?.text === 'string' ? args.text : undefined;
      const title = typeof args?.title === 'string' ? args.title : undefined;
      const tags = Array.isArray(args?.tags) ? args.tags.map(String) : undefined;
      if (body === undefined && title === undefined && tags === undefined) {
        throw new Error('memory_update 至少要给出 text / title / tags 中的一项，否则没有任何改动。');
      }
      const result = await queue.enqueue({
        operation: 'update',
        /** 目标路径来自服务端解析（不是调用方给的字符串）：不接受任意路径。 */
        target: record.path,
        /**
         * 期望哈希用**服务端此刻读到的值**。
         *
         * 为什么不直接用调用方给的 hash？那样就等于允许「改一个我知道的旧版本」。
         * 调用方给的 hash 用来核对「你看到的和我现在看到的是不是同一版」，
         * 一旦不一致就直接拒绝，让模型重新读一次，而不是拿着旧哈希去写。
         */
        expectedHash: currentHash,
        expectedRevision: record.meta.revision,
        payload: {
          ...(body === undefined ? {} : { body }),
          ...(title === undefined ? {} : { title }),
          ...(tags === undefined ? {} : { tags }),
          reason: typeof args?.reason === 'string' ? args.reason : '经 MCP 提交的修正',
        },
        requester: 'mcp',
        idempotencyKey: `mcp:update:${id}:${currentHash}:${body ?? ''}`,
      });
      if (!result.accepted) throw new Error(`请求未被受理：${result.error ?? '未知原因'}`);
      return text({
        status: 'accepted',
        meaning: '已排队 ≠ 已提交：真正落盘由 Obsidian 插件完成。',
        requestId: result.requestId,
        duplicate: result.duplicate,
        expectedHash: currentHash,
        next:
          '用 memory_wait_receipt 看结果：completed 表示已按这一版写入；' +
          'conflict 表示期间有人改过，需要重新读取后再决定。',
      });
    }
    case 'memory_forget': {
      const id = String(args?.id ?? '');
      const record = store.get(id);
      if (record === null) throw new Error(`取不到记忆 ${id}：不存在、不在范围内或不允许发送给模型。`);
      const hash = typeof args?.hash === 'string' ? args.hash.trim() : '';
      if (hash !== '' && hash !== store.hashOf(id)) {
        throw new Error('你给出的 hash 与当前内容不一致：请先用 memory_get 重新读取，再提交停止使用。');
      }
      const result = await queue.enqueue({
        operation: 'forget',
        target: record.path,
        expectedHash: hash === '' ? null : store.hashOf(id),
        expectedRevision: record.meta.revision,
        payload: {
          reason: typeof args?.reason === 'string' ? args.reason : '经 MCP 请求停止使用',
        },
        requester: 'mcp',
        idempotencyKey: `mcp:forget:${id}`,
      });
      if (!result.accepted) throw new Error(`请求未被受理：${result.error ?? '未知原因'}`);
      return text({
        status: 'accepted',
        meaning:
          '已排队 ≠ 已提交：停止使用由 Obsidian 插件提交。这是归档语义——历史保留，文件不删；' +
          '永久删除只能在 Obsidian 界面里由人操作。',
        requestId: result.requestId,
        duplicate: result.duplicate,
        next: `用 memory_wait_receipt 传 id=${result.requestId} 等待结果。`,
      });
    }
    case 'memory_session_commit': {
      const raw = args?.events;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('memory_session_commit 需要非空的 events 数组。');
      }
      /**
       * 事件载荷按队列契约整理。
       *
       * 注意这里**不接受**调用方传 `explicit`：是不是用户命令由护栏判断，
       * 调用方只能声明「这是用户当前回合的原话」（liveUserTurn）。
       */
      const events = raw.map((item, index) => {
        const event = (item ?? {}) as Record<string, unknown>;
        const text = typeof event.text === 'string' ? event.text : '';
        if (text.trim() === '') throw new Error(`events[${index}].text 不能为空。`);
        return {
          /**
           * 默认事件 id 必须**稳定且不含原文**：
           *
           * - 稳定：同一个事件重放要命中同一条记忆（正文里的 `event_ids`
           *   是崩溃后的幂等依据），所以不能带时间戳或随机数；
           * - 不含原文：事件 id 会写进每条记忆的元数据与状态文件，
           *   把正文前 40 字塞进去等于**在没有许可的地方复制了一份正文**——
           *   记录后来被改成 `allow_model: false` 也删不掉它。
           *
           * 调用方显式给 `eventId` 时原样采用（契约不变）。
           */
          event_id:
            typeof event.eventId === 'string' && event.eventId !== ''
              ? event.eventId
              : `mcp:${index}:${sha256Hex(`${index}\u0000${text}`).slice(0, 32)}`,
          text,
          live_user_turn: event.liveUserTurn === true,
          ...(typeof event.sourceRef === 'string' && event.sourceRef !== ''
            ? { source_ref: event.sourceRef }
            : { source_ref: 'mcp-session' }),
          ...(typeof event.kind === 'string' ? { kind: event.kind } : {}),
          ...(typeof event.observedAt === 'string' ? { observed_at: event.observedAt } : {}),
          ...(Array.isArray(event.tags) ? { tags: event.tags.map(String) } : {}),
        };
      });
      const result = await queue.enqueue({
        operation: 'session_commit',
        payload: {
          events,
          ...(typeof args?.cursor === 'string' && args.cursor !== '' ? { cursor: args.cursor } : {}),
        },
        requester: 'mcp',
        idempotencyKey: `mcp:session:${events.map(event => event.event_id).join(',')}`,
      });
      if (!result.accepted) throw new Error(`请求未被受理：${result.error ?? '未知原因'}`);
      return text({
        status: 'accepted',
        meaning:
          '已排队 ≠ 已提交：事件由 Obsidian 插件逐条提交，默认成为待确认候选；' +
          '只有被护栏认定为用户当前回合命令的事件才可能直接确认。',
        count: events.length,
        requestId: result.requestId,
        duplicate: result.duplicate,
        next: `用 memory_wait_receipt 传 id=${result.requestId} 看逐条结果。`,
      });
    }
    case 'memory_wait_receipt': {
      const id = String(args?.id ?? '');
      const seconds = Math.min(120, Math.max(1, Number(args?.timeoutSeconds ?? 30)));
      const scope = scopeFrom(args);
      guardRead(store);
      const receipt = await queue.waitForReceipt(id, { timeoutMs: seconds * 1000 });
      /**
       * 等待期间世界会变：这条记录可能被撤回、被改成 `allow_model: false`、
       * 被删除，或者**刚刚**才被插件提交进库。
       *
       * 因此返回前必须**重新读盘再判断可见性**：
       * 用等待前的快照判断，会同时犯两种错——
       * 记录刚被禁发却仍然返回标题（泄漏），
       * 或者记录刚被提交却报告「取不到」（编造）。
       *
       * `force: true` 是必须的：不加它，已加载过的 store 会直接返回空报告，
       * 于是「重新 load」变成一句没有效果的注释。
       */
      const storeDown = await store
        .load({ force: true })
        .then(() => false)
        .catch(() => true);
      if (receipt === null) {
        return text({
          status: 'pending',
          requestId: id,
          message: `等待 ${seconds} 秒仍未收到回执；请求仍在队列里，Obsidian 打开后会被处理。`,
        });
      }
      if (storeDown) {
        return text({
          requestId: id,
          status: receipt.status,
          label: RECEIPT_LABELS[receipt.status] ?? receipt.status,
          committedAt: receipt.committedAt,
          detailsHidden: true,
          reason: REDACTION_REASON_TEXT.store_down,
        });
      }
      /*
       * 已知 requestId 的调用必须能**准确**知道 completed / conflict / failed；
       * 这里只按当前可见性决定「带不带细节」，绝不改写状态。
       */
      return text(projectReceipt(store, receipt, scope));
    }
    case 'memory_receipts': {
      const scope = scopeFrom(args);
      guardRead(store);
      /**
       * 同样重新读盘：批量列举尤其容易用一份陈旧快照判断一整页回执，
       * 那条刚被禁发/删除的记录就会在这一页里露出来。
       */
      await store.load({ force: true });
      const receipts = await queue.listReceipts(limitFrom(args, 20));
      /*
       * 批量回执照样**先过范围与许可，再做投影**：不能先拼出完整列表、
       * 再在展示层删字段——那样中间结构里已经有原文标题了。
       */
      return text(receipts.map(receipt => projectReceipt(store, receipt, scope)));
    }
    case 'memory_queue_status': {
      const counts = await queue.pendingCount();
      const latest = await queue.listReceipts(1);
      return text({
        pending: counts.pending,
        expired: counts.expired,
        lastReceiptAt: latest[0]?.committedAt ?? null,
        note: '排队中的请求只有被 Obsidian 插件处理之后才会变成已提交的记忆。',
      });
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC over stdio                                                 */
/* ------------------------------------------------------------------ */

const log = (...parts: string[]): void => {
  process.stderr.write(`[${NAME}] ${parts.join(' ')}\n`);
};

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** 一条 JSON-RPC 请求（只用到这么几个字段，其他原样忽略）。 */
interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

async function handle(request: JsonRpcRequest): Promise<unknown> {
  const { id = null, method, params } = request;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NAME, version: VERSION },
          instructions:
            '这是 Missher Obsidian Memory 的 MCP 入口。读操作直接读；写操作用 memory_remember **排队**，' +
            '由 Obsidian 插件提交，回执里区分 completed/conflict/failed/expired。没有直写工具。',
        },
      };
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = params?.name ?? '';
      if (name === '') {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call 需要 name。' } };
      }
      try {
        const result = await callTool(name, params?.arguments ?? {});
        return { jsonrpc: '2.0', id, result };
      } catch (error) {
        // 工具级错误按 MCP 约定放在 result 里（isError），而不是 JSON-RPC error。
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          },
        };
      }
    }
    case 'shutdown':
      return { jsonrpc: '2.0', id, result: null };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } };
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (line === '') continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      log('收到无法解析的一行，已忽略。');
      continue;
    }
    void handle(request)
      .then(response => {
        if (response !== null && response !== undefined) send(response);
        if (request.method === 'shutdown') process.exit(0);
      })
      .catch(error => {
        log(`处理 ${request.method} 时出错：${error instanceof Error ? error.message : String(error)}`);
        send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } });
      });
  }
});

process.stdin.on('end', () => process.exit(0));
log(`已启动 v${VERSION}；库=${config.vault}；记忆根=${config.root}。写请求默认排队，由 Obsidian 插件提交。`);

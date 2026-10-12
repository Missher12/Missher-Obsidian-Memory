#!/usr/bin/env node
/**
 * `mom-memory` —— 独立 AI 接入口（命令行）。
 *
 * 与 Obsidian 插件共用 `@mom/core`，因此状态机、幂等、范围与遗忘语义完全一致，
 * 不存在“外部入口另一套逻辑”。
 *
 * 边界（全部在代码里强制，不只是文档）：
 * - 必须显式指定 `--vault`（或环境变量 `MOM_VAULT`）；没有默认值，不会猜用户的库。
 * - 所有路径相对 Vault，拒绝 `..`、绝对路径与符号链接逃逸。
 * - `--scope` 决定可见范围；**不传时只看 personal**，不会跨项目。
 * - 显式 `remember` 是用户动作授权（等价于 UI 上的按钮），不经过文本关键词猜测。
 * - 不提供任意文件访问：目录范围来自明确的本地启动配置。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_ROOT,
  MemoryStore,
  SCOPE_KINDS,
  buildProfileView,
  computeDedupeKey,
  contentHashOf,
  evaluateGuard,
  extractExplicitContent,
  isInsideRoot,
  normalizePath,
  OpenAiCompatibleProvider,
  renderProfileMarkdown,
  resolveInsideRoot,
  runLocalReview,
  type MemoryKind,
  type OrganizationSettings,
  type MemoryStatus,
  type WriteOperation,
  type ScopeFilter,
  type ScopeKind,
} from '@mom/core';
import { NodeFileStore } from './node-store.js';
import { ExternalQueueClient, RECEIPT_LABELS } from './external-queue.js';
import { categoryFrom, organizationFromStartup } from './organization-options.js';

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
  /** 允许重复出现的 flag。 */
  repeated: Map<string, string[]>;
}

const COMMANDS = [
  'receipts',
  'queue-status',
  'wait-receipt',
  'remember',
  'propose',
  'search',
  'get',
  'update',
  'forget',
  'delete',
  'confirm',
  'reject',
  'restore',
  'correct',
  'supersede',
  'pending',
  'review',
  'profile',
  'export',
  'import',
  'session-commit',
  'rebuild',
  'stats',
  'explain',
  'mse-candidate',
  'packet-verify',
  'issue-set',
  'help',
  'version',
] as const;

const REPEATED_FLAGS = new Set(['scope', 'tag', 'kind', 'status', 'alias', 'source']);

/** 只读命令：可以（也应当）直接读文件，不需要插件在运行。 */
const READ_ONLY_COMMANDS = new Set([
  'search',
  'get',
  'explain',
  'pending',
  'review',
  'profile',
  'export',
  'rebuild',
  'stats',
  'mse-candidate',
  'packet-verify',
  'issue-set',
  'receipts',
  'queue-status',
  'wait-receipt',
]);

/**
 * 写命令的运行时上下文。
 *
 * ## 默认行为：排队，不直写
 *
 * 本产品的普通 Markdown 写入者只有 Obsidian 插件一个（它在 `Vault.process`
 * 的同步回调里做比较-写入）。CLI 没有这个 API，因此写操作**默认**只是把请求
 * 持久排队，由插件真正提交；`accepted`（已排队）绝不等于 `completed`（已提交）。
 *
 * `--direct` 是给本仓库自己的测试与内部工具用的逃生门：它会打印明确警告，
 * 并且要求 `NodeFileStore` 显式允许直写。日常使用不要加它。
 */
interface WriteContext {
  queue: ExternalQueueClient;
  args: ParsedArgs;
  json: boolean;
  /** 直写模式（默认 false）。 */
  direct: boolean;
  store: MemoryStore;
  /** 目标记忆的 Vault 相对路径（含记忆根）。 */
  pathOf: (id: string) => string | null;
}

async function submitWrite(
  context: WriteContext,
  input: { operation: WriteOperation; payload: Record<string, unknown>; targetId?: string; reason?: string },
): Promise<number> {
  const targetId = input.targetId ?? null;
  /**
   * 针对某条记忆的写入必须先载入索引。
   *
   * 排队时要把「我当时看到的路径/哈希/版本」记进请求，插件将来才能据此判断
   * 期间有没有人工编辑。索引没载入的话这三样会全是 null，请求会被插件以
   * 「缺少 expectedHash」拒绝——外部看到的现象是「命令说排队成功、处理却失败」。
   * 所以这里按需载入，只在这类写入上付出一次读取成本。
   */
  if (targetId !== null) await context.store.load();
  const target = targetId === null ? '' : context.pathOf(targetId);
  if (targetId !== null && target === null) {
    fail(`未找到记忆 ${targetId}（或尚未载入）；未排队任何请求。`);
    return 1;
  }
  /**
   * 期望值：调用者给了就用调用者的，没给才现查。
   *
   * `--expected-hash` 是公开帮助里就写着的能力，语义是「我知道我读的是哪一版，
   * 就按这一版提交」——用来表达「我读到的是旧版」这类故意过期的预期。
   * 如果排队时用刚查到的当前值把它盖掉，这个参数就变成摆设：用户明确说的
   * 「按我读到的那版改」会被悄悄替换成「按现在的最新版改」，
   * 而人工编辑恰好在那之后发生时就变成静默覆盖。
   * 因此这里的优先级是：显式参数 > 现查；显示传空串则视为没有预期。
   */
  const explicitHash = targetId === null ? null : (context.args.flags.get('expected-hash') ?? '').trim();
  const expectedHash =
    targetId === null
      ? null
      : explicitHash !== ''
        ? explicitHash
        : context.store.hashOf(targetId) ?? null;
  const explicitRevisionRaw = targetId === null ? undefined : context.args.flags.get('expected-revision');
  const explicitRevision =
    explicitRevisionRaw === undefined || explicitRevisionRaw.trim() === ''
      ? undefined
      : Number(explicitRevisionRaw);
  if (explicitRevision !== undefined && !Number.isFinite(explicitRevision)) {
    fail(`--expected-revision 必须是数字，收到「${explicitRevisionRaw}」。`);
    return 2;
  }
  const expectedRevision =
    targetId === null
      ? null
      : explicitRevision ?? context.store.get(targetId)?.meta.revision ?? null;
  const idempotencyKey =
    context.args.flags.get('idempotency-key') ??
    `${input.operation}:${targetId ?? 'new'}:${expectedHash ?? 'none'}:${input.payload.category === undefined ? '' : `${String(input.payload.category)}:`}${String(input.payload.body ?? input.payload.replacement ?? '').slice(0, 64)}`;

  const outcome = await context.queue.enqueue({
    operation: input.operation,
    payload: input.payload,
    target: target ?? '',
    expectedHash,
    expectedRevision,
    requester: context.args.flags.get('requester') ?? 'cli',
    idempotencyKey,
    ...(context.args.flags.get('request-id') === undefined ? {} : { id: context.args.flags.get('request-id')! }),
  });
  if (!outcome.accepted) {
    fail(`请求未被受理：${outcome.error ?? '未知原因'}`);
    return 1;
  }
  const accepted = {
    accepted: true,
    requestId: outcome.requestId,
    path: outcome.path,
    duplicate: outcome.duplicate,
    status: 'queued' as const,
    note:
      '已持久排队。它还不是已提交的记忆：真正的写入由 Obsidian 插件在下一次处理时完成，' +
      '届时会写入 .memory/receipts/ 里的回执。',
  };
  if (context.json) process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
  else {
    process.stdout.write(`✓ 已排队 ${outcome.requestId}\n`);
    process.stdout.write(`  请求文件：${outcome.path}\n`);
    if (outcome.duplicate) process.stdout.write('  （同样的请求已经在队列里，本次没有重复落盘。）\n');
    process.stdout.write('  注意：已排队 ≠ 已提交。请用 `mom-memory wait-receipt <id>` 或打开 Obsidian 后查看回执。\n');
  }

  const wantWait = context.args.flags.get('wait') === 'true';
  if (!wantWait) return 0;
  const timeoutMs = Number.parseInt(context.args.flags.get('wait-timeout') ?? '30000', 10);
  const receipt = await context.queue.waitForReceipt(outcome.requestId, {
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30_000,
  });
  if (receipt === null) {
    const message =
      `等待 ${String(Math.round((Number.isFinite(timeoutMs) ? timeoutMs : 30_000) / 1000))} 秒仍未收到回执。` +
      '这不代表失败：请求仍在队列里，Obsidian 打开时会处理。';
    if (context.json) process.stdout.write(`${JSON.stringify({ ...accepted, status: 'waiting', note: message }, null, 2)}\n`);
    else process.stdout.write(`  ${message}\n`);
    return 0;
  }
  if (context.json) process.stdout.write(`${JSON.stringify({ ...accepted, status: receipt.status, receipt }, null, 2)}\n`);
  else {
    process.stdout.write(`  ${RECEIPT_LABELS[receipt.status]}：${receipt.message}\n`);
    if (receipt.revision !== null) process.stdout.write(`  rev ${receipt.revision}\n`);
  }
  return receipt.status === 'completed' ? 0 : 1;
}

/** 直写逃生门：明确警告，且只在调用方显式要求时使用。 */
function warnDirectWrite(): void {
  process.stderr.write(
    '⚠ --direct：本次由本进程直接写 Markdown。\n' +
      '  它与 Obsidian 的人工编辑之间**没有**跨软件原子比较，可能覆盖别人刚写的内容。\n' +
      '  日常使用请去掉 --direct，让插件提交（默认行为）。\n',
  );
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === '' || args.command === 'help' || args.flags.has('help')) {
    printHelp();
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write('mom-memory 0.2.0\n');
    return 0;
  }
  if (!(COMMANDS as readonly string[]).includes(args.command)) {
    fail(`未知命令「${args.command}」。运行 mom-memory help 查看可用命令。`);
    return 2;
  }

  const vault = args.flags.get('vault') ?? process.env.MOM_VAULT ?? '';
  if (vault === '') {
    fail('必须指定 --vault <路径>（或设置环境变量 MOM_VAULT）。不会自动猜测用户的库。');
    return 2;
  }
  const root = args.flags.get('root') ?? process.env.MOM_ROOT ?? DEFAULT_ROOT;

  let fileStore: NodeFileStore;
  let organization: OrganizationSettings;
  try {
    organization = organizationFromStartup(args.flags);
    categoryFrom(args.flags.get('category'));
    fileStore = await NodeFileStore.open({ vaultRoot: vault, memoryRoot: root, organization });
  } catch (error) {
    fail(messageOf(error));
    return 2;
  }

  const store = new MemoryStore({ store: fileStore, root, organization });
  const scopeFilters = parseScopeFilters(args);
  const json = args.flags.get('json') === 'true';
  const direct = args.flags.get('direct') === 'true';
  if (direct) warnDirectWrite();
  const writeContext: WriteContext = {
    queue: new ExternalQueueClient({ vaultRoot: fileStore.resolvedVaultRoot, memoryRoot: root, organization }),
    args,
    json,
    direct,
    store,
    pathOf: id => {
      const record = store.get(id);
      return record === null ? null : record.path;
    },
  };

  try {
    if (READ_ONLY_COMMANDS.has(args.command)) {
      switch (args.command) {
        case 'search':
          return await cmdSearch(store, args, json, scopeFilters);
        case 'get':
          return await cmdGet(store, args, json);
        case 'explain':
          return await cmdExplain(store, args, json);
        case 'pending':
          return await cmdPending(store, args, json);
        case 'review':
          return await cmdReview(store, args, json);
        case 'profile':
          return await cmdProfile(store, args, json);
        case 'export':
          return await cmdExport(store, args, json);
        case 'rebuild':
          return await cmdRebuild(store, json);
        case 'stats':
          return await cmdStats(store, json);
        case 'mse-candidate':
          return await cmdMseCandidate(store, args, json);
        case 'packet-verify':
          return await cmdPacketVerify(args, json);
        case 'issue-set':
          return await cmdIssueSet(store, args, json);
        case 'receipts':
          return await cmdReceipts(writeContext);
        case 'queue-status':
          return await cmdQueueStatus(writeContext);
        case 'wait-receipt':
          return await cmdWaitReceipt(writeContext);
        default:
          printHelp();
          return 0;
      }
    }
    /**
     * 写命令：默认只排队到 `<记忆根>/.memory/requests/`。
     * `--direct` 才走本进程直写（内部/测试用途，会先打印警告）。
     */
    if (!direct) {
      switch (args.command) {
        case 'remember':
          return await submitWrite(writeContext, {
            operation: 'remember',
            payload: {
              body: requireText(args),
              ...(args.flags.get('title') === undefined ? {} : { title: args.flags.get('title')! }),
              ...(args.flags.get('category') === undefined ? {} : { category: categoryFrom(args.flags.get('category')) }),
              ...(args.flags.get('kind') === undefined ? {} : { kind: args.flags.get('kind')! }),
              ...(args.flags.get('scope') === undefined ? {} : { scope: args.flags.get('scope')! }),
              ...(args.flags.get('scope-ref') === undefined ? {} : { scope_ref: args.flags.get('scope-ref')! }),
              ...(args.repeated.get('tag') === undefined ? {} : { tags: args.repeated.get('tag')! }),
              ...(args.flags.get('source-ref') === undefined ? {} : { source_ref: args.flags.get('source-ref')! }),
              /**
               * 默认允许发送给模型（与界面上的默认一致）；
               * `--no-allow-model` 明确声明「这条不要给模型看」。
               */
              ...(args.flags.get('no-allow-model') === 'true' ? { allow_model: false } : {}),
            },
          });
        case 'propose':
          return await submitWrite(writeContext, {
            operation: 'propose',
            payload: {
              body: requireText(args), kind: args.flags.get('kind') ?? 'note',
              ...(args.flags.get('title') === undefined ? {} : { title: args.flags.get('title')! }),
              ...(args.flags.get('category') === undefined ? {} : { category: categoryFrom(args.flags.get('category')) }),
              ...(args.flags.get('no-allow-model') === 'true' ? { allow_model: false } : {}),
            },
          });
        case 'update':
          return await submitWrite(writeContext, {
            operation: 'update',
            targetId: requireId(args),
            payload: {
              ...(args.flags.get('text') === undefined ? {} : { body: args.flags.get('text')! }),
              ...(args.flags.get('title') === undefined ? {} : { title: args.flags.get('title')! }),
              ...(args.repeated.get('tag') === undefined ? {} : { tags: args.repeated.get('tag')! }),
              /**
               * 与 `remember` 同一个开关：更新时也能把一条记录改成「不给模型看」。
               *
               * 少了这一行，`--no-allow-model` 会被**静默忽略**——
               * 命令成功、文件也变了，但可见性没有任何变化，
               * 调用方以为关掉了外发，实际上什么都没发生。
               */
              ...(args.flags.get('no-allow-model') === 'true' ? { allow_model: false } : {}),
              reason: args.flags.get('reason') ?? '通过 CLI 更新',
            },
          });
        case 'correct':
          return await submitWrite(writeContext, {
            operation: 'correct',
            targetId: requireId(args),
            payload: { replacement: requireText(args), reason: args.flags.get('reason') ?? '用户明确纠错（CLI）' },
          });
        case 'supersede':
          return await submitWrite(writeContext, {
            operation: 'supersede',
            targetId: requireId(args),
            payload: { body: requireText(args), reason: args.flags.get('reason') ?? '用新内容替代（CLI）' },
          });
        case 'forget':
        case 'delete':
          return await submitWrite(writeContext, {
            operation: args.command === 'delete' ? 'delete' : 'forget',
            targetId: requireId(args),
            payload: { reason: args.flags.get('reason') ?? (args.command === 'delete' ? '用户要求永久删除（CLI）' : '用户要求忘记（CLI）') },
          });
        case 'confirm':
        case 'reject':
        case 'restore':
          return await submitWrite(writeContext, {
            operation: args.command,
            targetId: requireId(args),
            payload: { reason: args.flags.get('reason') ?? `通过 CLI ${args.command}` },
          });
        case 'session-commit':
          return await submitWrite(writeContext, {
            operation: 'remember',
            payload: {
              body: requireText(args),
              ...(args.flags.get('kind') === undefined ? {} : { kind: args.flags.get('kind')! }),
              ...(args.flags.get('event-id') === undefined ? {} : { event_id: args.flags.get('event-id')! }),
              ...(args.flags.get('source-ref') === undefined ? {} : { source_ref: args.flags.get('source-ref')! }),
            },
          });
        case 'import':
          return await cmdImportQueue(writeContext, args, json);
        default:
          break;
      }
    }
    switch (args.command) {
      case 'remember':
        return await cmdRemember(store, args, json, false);
      case 'propose':
        return await cmdRemember(store, args, json, true);
      case 'update':
        return await cmdUpdate(store, args, json);
      case 'correct':
        return await cmdCorrect(store, args, json);
      case 'supersede':
        return await cmdSupersede(store, args, json);
      case 'forget':
      case 'delete':
        return await cmdForget(store, args, json, args.command === 'delete');
      case 'confirm':
      case 'reject':
      case 'restore':
        return await cmdStatusChange(store, args, json, args.command);
      case 'import':
        return await cmdImportQueue(writeContext, args, json);
      case 'session-commit':
        return await cmdSessionCommitDirect(store, args, json);
      default:
        printHelp();
        return 0;
    }
  } catch (error) {
    fail(messageOf(error));
    return 1;
  }
}

/** 读写操作的正文来源：`--text` 或 `--file`。 */
function requireText(args: ParsedArgs): string {
  const inline = args.flags.get('text');
  const text = inline ?? (args.flags.has('file') ? readFileSyncSafe(args.flags.get('file')!) : '');
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`${args.command} 需要 --text 或 --file 提供正文。`);
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const positionals: string[] = [];
  let command = '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      let key: string;
      let value: string;
      if (eq >= 0) {
        key = body.slice(0, eq);
        value = body.slice(eq + 1);
      } else {
        key = body;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = 'true';
        }
      }
      if (REPEATED_FLAGS.has(key)) {
        const list = repeated.get(key) ?? [];
        list.push(...value.split(',').map(item => item.trim()).filter(Boolean));
        repeated.set(key, list);
      }
      flags.set(key, value);
      continue;
    }
    if (command === '') command = token;
    else positionals.push(token);
  }
  return { command, flags, positionals, repeated };
}

/** 解析 --scope；缺省时**只**返回 personal，绝不隐式跨项目。 */
/**
 * 解析 `--scope`。
 *
 * 取值来自核心的 `SCOPE_KINDS`（personal / project / context），
 * 不做强制类型转换：多写一个不存在的范围要直接报错，
 * 而不是被 `as ScopeKind` 掩盖成某个看起来合法的值。
 *
 * `project` / `context` **必须带名称**：不带名称的范围过滤等价于
 * 「所有这些范围都可见」，那是扩大可见面，绝不能靠省略参数就发生。
 */
function parseScopeFilters(args: ParsedArgs): ScopeFilter[] {
  const raw = args.repeated.get('scope') ?? [];
  if (raw.length === 0) return [{ scope: 'personal' }];
  const filters: ScopeFilter[] = [];
  for (const item of raw) {
    const separator = item.indexOf(':');
    const kindRaw = (separator < 0 ? item : item.slice(0, separator)).trim();
    const ref = separator < 0 ? '' : item.slice(separator + 1).trim();
    if (!(SCOPE_KINDS as readonly string[]).includes(kindRaw)) {
      throw new Error(
        `--scope 只接受 ${SCOPE_KINDS.join(' / ')}（项目与情境写成 project:<名称>、context:<名称>），收到「${item}」。`,
      );
    }
    if (kindRaw === 'personal') {
      if (ref !== '') throw new Error(`--scope personal 不接受名称，收到「${item}」。`);
      filters.push({ scope: 'personal' });
      continue;
    }
    if (ref === '') {
      throw new Error(
        `--scope ${kindRaw} 必须带名称（例如 --scope ${kindRaw}:我的项目）：不带名称会读取全部${kindRaw}范围。`,
      );
    }
    filters.push({ scope: kindRaw as ScopeKind, ref });
  }
  return filters;
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

async function cmdRemember(store: MemoryStore, args: ParsedArgs, json: boolean, propose: boolean): Promise<number> {
  const text = readTextInput(args);
  if (text === null) {
    fail('缺少内容。使用 --text "..."、--file <路径> 或通过标准输入传入。');
    return 2;
  }
  await store.load();

  /**
   * 显式 `remember` 由用户动作授权（等价于 UI 按钮），不做关键词猜测。
   * `--from-history` 表示这是回放的历史文本，此时才启用护栏，并且预期会被拒绝。
   */
  if (args.flags.get('from-history') === 'true' && !propose) {
    const verdict = evaluateGuard({ text, sourceKind: 'session_commit', isLiveUserTurn: false });
    if (!verdict.explicit) {
      fail(`历史文本不会被当作新的用户确认（原因：${verdict.reason}）。如需保存请直接使用 remember，或改用 propose 生成待确认候选。`);
      return 3;
    }
  }

  const body = args.flags.get('raw') === 'true' ? text.trim() : extractExplicitContent(text);
  const kind = (args.flags.get('kind') ?? 'note') as MemoryKind;
  const scope = (args.flags.get('scope-kind') ?? 'personal') as ScopeKind;
  const scopeRef = args.flags.get('scope-ref') ?? '';

  const draft = {
    body,
    category: categoryFrom(args.flags.get('category')),
    title: args.flags.get('title'),
    kind,
    scope,
    scopeRef,
    sourceKind: (propose ? 'ai_extraction' : 'user_explicit') as 'ai_extraction' | 'user_explicit',
    sourceRef: args.flags.get('source') ?? 'cli',
    tags: args.repeated.get('tag') ?? [],
    aliases: args.repeated.get('alias') ?? [],
    validUntil: args.flags.get('valid-until') ?? '',
    eventId: args.flags.get('event-id') ?? '',
  };
  const result = propose ? await store.propose(draft) : await store.remember(draft);
  if (result.ok) await store.setCursor(`cli:${new Date().toISOString()}`);
  return reportResult(result, json, result.ok ? 0 : 1);
}

function readTextInput(args: ParsedArgs): string | null {
  const inline = args.flags.get('text');
  if (inline !== undefined && inline !== '' && inline !== 'true') return inline;
  const fromFile = args.flags.get('file');
  if (fromFile !== undefined && fromFile !== 'true') {
    // 文件路径必须由用户显式给出，且读取失败要如实报错。
    return readFileSyncSafe(fromFile);
  }
  if (args.positionals.length > 0) return args.positionals.join(' ');
  if (args.flags.get('stdin') === 'true') return readStdinSync();
  return null;
}

async function cmdSearch(
  store: MemoryStore,
  args: ParsedArgs,
  json: boolean,
  scopes: ScopeFilter[],
): Promise<number> {
  const query = args.flags.get('text') ?? args.positionals.join(' ');
  await store.load();
  const result = await store.search({
    text: query ?? '',
    scopes,
    limit: Number(args.flags.get('limit') ?? 10),
    includeNonConfirmed: args.flags.get('include-pending') === 'true',
    statuses: args.repeated.get('status') as MemoryStatus[] | undefined,
    kinds: args.repeated.get('kind') as MemoryKind[] | undefined,
    tags: args.repeated.get('tag'),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({ hits: result.hits, diagnosis: result.diagnosis }, null, 2)}\n`);
    return 0;
  }
  if (result.hits.length === 0) {
    process.stdout.write(`没有找到匹配「${query ?? ''}」的记忆。\n`);
    const d = result.diagnosis;
    process.stdout.write(
      `诊断：候选 ${d.candidates} 条；范围排除 ${d.excludedByScope}；状态排除 ${d.excludedByStatus}；关键词不匹配 ${d.excludedByTerms}。\n`,
    );
    for (const note of d.notes.slice(0, 20)) {
      process.stdout.write(`  - ${note.title}：${note.reason}\n`);
    }
    return 0;
  }
  for (const hit of result.hits) {
    process.stdout.write(`[${hit.score.toFixed(2)}] ${hit.title}\n`);
    process.stdout.write(`  id=${hit.id} rev=${hit.revision} status=${hit.status} scope=${scopeLabel(hit.scope, hit.scope_ref)}\n`);
    process.stdout.write(`  文件：${hit.path}\n`);
    for (const snippet of hit.snippets) process.stdout.write(`  > ${snippet.text}\n`);
  }
  process.stdout.write(`\n共 ${result.hits.length} 条（候选 ${result.diagnosis.candidates} 条）。\n`);
  return 0;
}

async function cmdGet(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const id = requireId(args);
  await store.load();
  const record = store.get(id);
  if (!record) {
    fail(`未找到记忆 ${id}。`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ record, hash: store.hashOf(id) }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(store.rawOf(id) ?? '');
  return 0;
}

async function cmdExplain(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const id = requireId(args);
  await store.load();
  const explanation = store.explain(id);
  if (json) {
    process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${explanation.found ? '已找到' : '未找到'}：${explanation.id}\n`);
  if (explanation.path) process.stdout.write(`文件：${explanation.path}\n`);
  process.stdout.write('是否参与召回的理由：\n');
  for (const reason of explanation.reasons) process.stdout.write(`  - ${reason}\n`);
  return 0;
}

/**
 * `--direct` 下的更新：**仅供本仓库测试与内部工具**。
 *
 * 它明确承认自己不是通用 CAS：与 Obsidian 里的人工编辑之间没有原子比较窗口。
 * 日常使用应当走默认的排队路径。
 */
async function cmdUpdate(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const id = requireId(args);
  const rawBody = args.flags.get('text') ?? (args.flags.has('file') ? readFileSyncSafe(args.flags.get('file')!) : undefined);
  const body = typeof rawBody === 'string' ? rawBody : undefined;
  await store.load();
  const current = store.hashOf(id);
  if (current === null) {
    fail(`未找到记忆 ${id}。`);
    return 1;
  }
  const result = await store.update(id, {
    body,
    title: args.flags.get('title'),
    tags: args.repeated.get('tag'),
    aliases: args.repeated.get('alias'),
    status: args.flags.get('status') as MemoryStatus | undefined,
    expectedHash: args.flags.get('expected-hash') ?? current,
    reason: args.flags.get('reason') ?? '通过 CLI 更新',
    actor: args.flags.get('actor') === 'ai' ? 'ai' : 'user',
  });
  return reportResult(result, json, result.ok ? 0 : 1);
}

async function cmdCorrect(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const id = requireId(args);
  const rawReplacement = args.flags.get('text') ?? (args.flags.has('file') ? readFileSyncSafe(args.flags.get('file')!) : '');
  const replacement = typeof rawReplacement === 'string' ? rawReplacement : '';
  if (replacement.trim() === '') {
    fail('correct 需要 --text 或 --file 提供新的正确内容。');
    return 2;
  }
  await store.load();
  const result = await store.correct(id, {
    replacement,
    reason: args.flags.get('reason') ?? '用户明确纠错（CLI）',
    expectedHash: args.flags.get('expected-hash') ?? store.hashOf(id) ?? undefined,
  });
  return reportResult(result, json, result.ok ? 0 : 1);
}

async function cmdSupersede(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const id = requireId(args);
  const body = args.flags.get('text') ?? '';
  if (body.trim() === '') {
    fail('supersede 需要 --text 提供替代后的新内容。');
    return 2;
  }
  await store.load();
  const result = await store.supersede(id, {
    body,
    title: args.flags.get('title'),
    kind: (args.flags.get('kind') ?? store.get(id)?.meta.kind ?? 'note') as MemoryKind,
    sourceKind: 'user_explicit',
    sourceRef: args.flags.get('source') ?? 'cli',
    reason: args.flags.get('reason') ?? '用户确认替代旧版本',
  });
  return reportResult(result, json, result.ok ? 0 : 1);
}

async function cmdForget(store: MemoryStore, args: ParsedArgs, json: boolean, hard: boolean): Promise<number> {
  const id = requireId(args);
  await store.load();
  const result = hard
    ? await store.deletePermanently(id, { expectedHash: args.flags.get('expected-hash') ?? store.hashOf(id) ?? undefined })
    : await store.forget(id, {
        reason: args.flags.get('reason') ?? '用户要求忘记（CLI）',
        expectedHash: args.flags.get('expected-hash') ?? store.hashOf(id) ?? undefined,
      });
  return reportResult(result, json, result.ok ? 0 : 1);
}

async function cmdStatusChange(
  store: MemoryStore,
  args: ParsedArgs,
  json: boolean,
  action: 'confirm' | 'reject' | 'restore',
): Promise<number> {
  const id = requireId(args);
  await store.load();
  const expectedHash = args.flags.get('expected-hash') ?? store.hashOf(id) ?? undefined;
  const result =
    action === 'confirm'
      ? await store.confirm(id, { expectedHash })
      : action === 'reject'
        ? await store.reject(id, { expectedHash })
        : await store.restore(id, args.flags.get('reason') ?? '通过 CLI 恢复');
  return reportResult(result, json, result.ok ? 0 : 1);
}

/** 列出最近的回执（只读；不需要 Obsidian 在运行）。 */
async function cmdReceipts(context: WriteContext): Promise<number> {
  const limit = Number.parseInt(context.args.flags.get('limit') ?? '20', 10);
  const receipts = await context.queue.listReceipts(Number.isFinite(limit) ? limit : 20);
  if (context.json) {
    process.stdout.write(`${JSON.stringify(receipts, null, 2)}\n`);
    return 0;
  }
  if (receipts.length === 0) {
    process.stdout.write('还没有任何回执（外部请求只能由 Obsidian 插件真正提交）。\n');
    return 0;
  }
  for (const receipt of receipts) {
    process.stdout.write(
      `${receipt.requestId}  ${RECEIPT_LABELS[receipt.status]}  ${receipt.committedAt}\n    ${receipt.message}\n`,
    );
  }
  return 0;
}

/** 队列概览：多少请求在等、多少已过期（只读）。 */
async function cmdQueueStatus(context: WriteContext): Promise<number> {
  const counts = await context.queue.pendingCount();
  const receipts = await context.queue.listReceipts(1);
  const payload = {
    pending: counts.pending,
    expired: counts.expired,
    latestReceiptAt: receipts[0]?.committedAt ?? null,
    note: '排队中的请求只有被 Obsidian 插件处理之后才会变成已提交的记忆。',
  };
  if (context.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`排队中：${payload.pending} 条（其中 ${payload.expired} 条已过期但仍保留）\n`);
    process.stdout.write(`最近一条回执时间：${payload.latestReceiptAt ?? '（还没有）'}\n`);
    process.stdout.write(`${payload.note}\n`);
  }
  return 0;
}

/** 等一条回执（只读轮询；超时不代表失败）。 */
async function cmdWaitReceipt(context: WriteContext): Promise<number> {
  const id = context.args.positionals[0] ?? context.args.flags.get('id') ?? '';
  if (id === '') {
    fail('wait-receipt 需要请求 id：mom-memory wait-receipt <requestId>');
    return 2;
  }
  const timeoutMs = Number.parseInt(context.args.flags.get('timeout') ?? '30000', 10);
  const receipt = await context.queue.waitForReceipt(id, { timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30_000 });
  if (receipt === null) {
    const message = `等待 ${String(Math.round((Number.isFinite(timeoutMs) ? timeoutMs : 30_000) / 1000))} 秒仍未收到回执；请求仍在队列里，Obsidian 打开后会被处理。`;
    if (context.json) process.stdout.write(`${JSON.stringify({ requestId: id, status: 'waiting', note: message }, null, 2)}\n`);
    else process.stdout.write(`${message}\n`);
    return 0;
  }
  if (context.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else {
    process.stdout.write(`${RECEIPT_LABELS[receipt.status]}：${receipt.message}\n`);
    if (receipt.revision !== null) process.stdout.write(`rev ${receipt.revision}\n`);
  }
  return receipt.status === 'completed' ? 0 : 1;
}

/**
 * `import` 的排队版本：每一行都排成一条 remember 请求。
 *
 * 导入**不做任何捷径**：它和手工 remember 走同一条队列、同一套校验，
 * 因此不会出现「导入路径绕过了确认规则」这种事。
 */
async function cmdImportQueue(context: WriteContext, args: ParsedArgs, json: boolean): Promise<number> {
  const file = args.flags.get('file');
  if (file === undefined || file === '') {
    fail('import 需要 --file <路径>（每行一条记忆正文；空行与 # 开头的行忽略）。');
    return 2;
  }
  const raw = readFileSyncSafe(file) ?? '';
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
  if (lines.length === 0) {
    process.stdout.write('文件里没有可导入的内容。\n');
    return 0;
  }
  const results: Array<{ requestId: string; accepted: boolean; error?: string }> = [];
  for (const [index, line] of lines.entries()) {
    const outcome = await context.queue.enqueue({
      operation: 'remember',
      payload: { body: line, kind: args.flags.get('kind') ?? 'note', source_ref: args.flags.get('source-ref') ?? file },
      requester: 'cli:import',
      idempotencyKey: `import:${file}:${String(index)}:${line.slice(0, 48)}`,
    });
    results.push({ requestId: outcome.requestId, accepted: outcome.accepted, ...(outcome.error === undefined ? {} : { error: outcome.error }) });
  }
  const accepted = results.filter(item => item.accepted).length;
  if (json) process.stdout.write(`${JSON.stringify({ total: lines.length, accepted, results }, null, 2)}\n`);
  else {
    process.stdout.write(`已排队 ${accepted}/${lines.length} 条（导入同样是「先排队、后由插件提交」）。\n`);
    for (const item of results.filter(entry => !entry.accepted)) {
      process.stdout.write(`  ✗ ${item.requestId}：${item.error ?? '未知原因'}\n`);
    }
  }
  return accepted === lines.length ? 0 : 1;
}

async function cmdPending(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  await store.load();
  const pending = store.pending();
  if (json) {
    process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
    return 0;
  }
  if (pending.length === 0) {
    process.stdout.write('没有待确认候选。\n');
    return 0;
  }
  for (const record of pending) {
    process.stdout.write(`- ${record.meta.id}  ${titleOf(record.path, record.body)}\n  ${record.path}\n`);
  }
  process.stdout.write(`\n共 ${pending.length} 条待确认。\n`);
  return 0;
}

async function cmdReview(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  await store.load();
  const fileStore = (store as unknown as { store: NodeFileStore }).store;
  const suggestions = await runLocalReview(store.all(), {
    now: Date.now(),
    readSource: async ref => {
      // 只允许读 Vault 内、记忆根目录内的来源文件。
      try {
        if (!isInsideRoot(store.root, normalizePath(ref))) return null;
        return await fileStore.readFile(ref);
      } catch {
        return null;
      }
    },
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({ suggestions }, null, 2)}\n`);
    return 0;
  }
  if (suggestions.length === 0) {
    process.stdout.write('本地复盘没有发现需要处理的问题。\n');
    return 0;
  }
  for (const suggestion of suggestions) {
    process.stdout.write(`[${suggestion.kind}] ${suggestion.title}\n  ${suggestion.detail}\n`);
    for (const evidence of suggestion.evidence) {
      process.stdout.write(`  证据 ${evidence.ref}：${evidence.detail}\n`);
    }
    process.stdout.write(`  建议动作：${suggestion.action.type}\n`);
  }
  process.stdout.write(`\n共 ${suggestions.length} 条建议（本地确定性检查，未调用模型）。\n`);
  return 0;
}

async function cmdProfile(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  await store.load();
  const view = buildProfileView(store.all(), { now: Date.now() });
  if (json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return 0;
  }
  const markdown = renderProfileMarkdown(view);
  const out = args.flags.get('out');
  if (out !== undefined && out !== 'true') {
    const target = resolveInsideRoot(store.root, out, '输出路径');
    await store.writeStateFile ? undefined : undefined;
    await (store as unknown as { store: NodeFileStore }).store.ensureDir(dirOf(target));
    await (store as unknown as { store: NodeFileStore }).store.writeFile(target, markdown, {});
    process.stdout.write(`已写入 ${target}\n`);
    return 0;
  }
  process.stdout.write(markdown);
  return 0;
}

async function cmdExport(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  await store.load();
  const format = args.flags.get('format') ?? 'jsonl';
  const records = store.all();
  const rows = records.map(record => ({
    id: record.meta.id,
    kind: record.meta.kind,
    status: record.meta.status,
    scope: record.meta.scope,
    scope_ref: record.meta.scope_ref,
    revision: record.meta.revision,
    observed_at: record.meta.observed_at,
    updated_at: record.meta.updated_at,
    valid_until: record.meta.valid_until,
    tags: record.meta.tags,
    source_kind: record.meta.source_kind,
    source_ref: record.meta.source_ref,
    path: record.path,
    title: titleOf(record.path, record.body),
    body: record.body,
  }));
  const text =
    format === 'json'
      ? `${JSON.stringify(rows, null, 2)}\n`
      : `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
  const out = args.flags.get('out');
  if (out !== undefined && out !== 'true') {
    const target = resolveInsideRoot(store.root, out, '导出路径');
    const fileStore = (store as unknown as { store: NodeFileStore }).store;
    await fileStore.ensureDir(dirOf(target));
    await fileStore.writeFile(target, text, {});
    process.stdout.write(`已导出 ${rows.length} 条到 ${target}（格式 ${format}）。\n`);
    return 0;
  }
  if (json) process.stdout.write(`${JSON.stringify({ count: rows.length, format })}\n`);
  process.stdout.write(text);
  return 0;
}

async function cmdImport(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const file = args.flags.get('file');
  if (file === undefined || file === 'true') {
    fail('import 需要 --file <jsonl 路径>。');
    return 2;
  }
  const raw = readFileSyncSafe(file);
  if (raw === null) {
    fail(`无法读取文件：${file}`);
    return 1;
  }
  await store.load();
  const results: Array<{ line: number; ok: boolean; message: string; id?: string }> = [];
  const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '');
  for (let i = 0; i < lines.length; i += 1) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch (error) {
      results.push({ line: i + 1, ok: false, message: `JSON 解析失败：${messageOf(error)}` });
      continue;
    }
    const body = typeof parsed.body === 'string' ? parsed.body : '';
    if (body.trim() === '') {
      results.push({ line: i + 1, ok: false, message: '缺少 body。' });
      continue;
    }
    const status = typeof parsed.status === 'string' ? (parsed.status as MemoryStatus) : 'pending';
    const outcome = await store.commit(
      {
        body,
        title: typeof parsed.title === 'string' ? parsed.title : undefined,
        kind: (typeof parsed.kind === 'string' ? parsed.kind : 'note') as MemoryKind,
        scope: (typeof parsed.scope === 'string' ? parsed.scope : 'personal') as ScopeKind,
        scopeRef: typeof parsed.scope_ref === 'string' ? parsed.scope_ref : '',
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((x): x is string => typeof x === 'string') : [],
        aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((x): x is string => typeof x === 'string') : [],
        sourceKind: 'session_commit',
        sourceRef: typeof parsed.source_ref === 'string' ? parsed.source_ref : 'cli-import',
        eventId: typeof parsed.event_id === 'string' ? parsed.event_id : `import:${i + 1}:${computeDedupeKey('session_commit', 'cli-import', body)}`,
      },
      { status: status === 'confirmed' ? 'confirmed' : 'pending' },
    );
    results.push({ line: i + 1, ok: outcome.ok, message: outcome.message, id: outcome.id });
  }
  const failed = results.filter(result => !result.ok);
  if (json) {
    process.stdout.write(`${JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2)}\n`);
  } else {
    process.stdout.write(`导入 ${results.length} 条，成功 ${results.length - failed.length} 条，失败 ${failed.length} 条。\n`);
    for (const failure of failed) process.stdout.write(`  第 ${failure.line} 行：${failure.message}\n`);
    process.stdout.write('注意：导入内容默认回到待确认状态，不会冒充用户已确认的事实。\n');
  }
  return failed.length > 0 ? 1 : 0;
}

async function cmdSessionCommitDirect(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const file = args.flags.get('file');
  if (file === undefined || file === 'true') {
    fail('session-commit 需要 --file <事件 JSONL 路径>。每行：{"event_id","text","explicit","source_ref"}');
    return 2;
  }
  const raw = readFileSyncSafe(file);
  if (raw === null) {
    fail(`无法读取文件：${file}`);
    return 1;
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (text.trim() === '') continue;
    /**
     * 事件里的“explicit”不是由调用方随便声明的：可能是历史回放，
     * 因此这里仍然跑一次护栏；护栏要求 isLiveUserTurn，历史文本必然被拒。
     */
    const verdict = evaluateGuard({
      text,
      sourceKind: 'session_commit',
      isLiveUserTurn: parsed.live_user_turn === true,
    });
    events.push({
      eventId: typeof parsed.event_id === 'string' ? parsed.event_id : `evt:${computeDedupeKey('session_commit', 'session', text)}`,
      text,
      explicit: verdict.explicit,
      sourceKind: 'session_commit' as const,
      sourceRef: typeof parsed.source_ref === 'string' ? parsed.source_ref : 'cli-session',
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : undefined,
    });
  }
  await store.load();
  const outcome = await store.commitSession(events);
  if (json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else {
    process.stdout.write(
      `受理 ${outcome.results.length} 个事件：新建/更新 ${outcome.accepted}，重复（幂等）${outcome.duplicates}，失败 ${outcome.failed}。\n`,
    );
    process.stdout.write(`处理游标：${outcome.cursor || '（未推进）'}\n`);
    process.stdout.write('提醒：会话事件默认进入待确认；只有当前用户回合的明确命令才会直接确认。\n');
  }
  return outcome.failed > 0 ? 1 : 0;
}

async function cmdRebuild(store: MemoryStore, json: boolean): Promise<number> {
  const report = await store.rebuild();
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `索引已重建：扫描 ${report.scanned}，有效 ${report.valid}，无效 ${report.invalid}，新增 ${report.added}，更新 ${report.updated}，移除 ${report.removed}。\n`,
  );
  for (const problem of report.problems.slice(0, 20)) {
    process.stdout.write(`  问题 ${problem.path}：${problem.issues.map(issue => issue.message).join('；')}\n`);
  }
  return 0;
}

async function cmdStats(store: MemoryStore, json: boolean): Promise<number> {
  await store.load();
  const summary = store.statsSummary();
  if (json) {
    process.stdout.write(`${JSON.stringify({ summary, runtime: store.runtimeStats, root: store.root }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`记忆根目录：${store.root}\n`);
  process.stdout.write(`总计 ${summary.total} 条；已确认 ${summary.byStatus.confirmed}，待确认 ${summary.byStatus.pending}，争议 ${summary.byStatus.disputed}，已替代 ${summary.byStatus.superseded}，已归档 ${summary.byStatus.archived}。\n`);
  process.stdout.write(`过期 ${summary.expired}，到期待复查 ${summary.dueReview}，删除标记 ${summary.forgotten}，数据问题 ${summary.problems}。\n`);
  return 0;
}

async function cmdMseCandidate(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const id = requireId(args);
  await store.load();
  const record = store.get(id);
  if (!record) {
    fail(`未找到记忆 ${id}。`);
    return 1;
  }
  const { buildMethodCandidate, validatePacket, describeBridgeItem, newBridgeItem } = await import('@mom/core');
  const instruction = args.flags.get('instruction') ?? `在遇到「${titleOf(record.path, record.body)}」这类问题时，先核对来源版本再修改。`;
  const { envelope, packet } = buildMethodCandidate({
    memory: {
      id: record.meta.id,
      revision: record.meta.revision,
      scope: record.meta.scope,
      scopeRef: record.meta.scope_ref,
    },
    problem: {
      kind: args.flags.get('problem') ?? 'unknown',
      ref: record.meta.id,
      excerptHash: contentHashOf(record.body).slice(0, 32),
      excerptLength: record.body.length,
    },
    method: {
      instruction,
      applicability: args.flags.get('applicability') ?? '',
      exclusions: args.flags.get('exclusions') ?? '',
    },
    originEventId: args.flags.get('event-id') ?? `mse:${record.meta.id}@${record.meta.revision}`,
    proposalId: `prop_${record.meta.id.slice(4, 12)}_${record.meta.revision}`,
    now: Date.now(),
  });
  const validation = validatePacket(packet);
  const item = newBridgeItem({ envelope, now: Date.now() });
  const summary = describeBridgeItem({ ...item, delivery: { state: 'not_sent', detail: '仅生成，未发送（默认关闭 MSE 联动）。' } });
  const payload = { envelope, packet, validation, status: summary, note: '本地生成 + 本地校验；未与任何 MSE 实例通信。' };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`候选包（${validation.ok ? '本地校验通过，兼容 mse-method-v1' : '本地校验失败'}）\n`);
    for (const reason of validation.reasons) process.stdout.write(`  ✗ ${reason}\n`);
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    process.stdout.write(`\n状态：${summary.headline}\n`);
    for (const caution of summary.cautions) process.stdout.write(`  · ${caution}\n`);
  }
  return validation.ok ? 0 : 1;
}

async function cmdPacketVerify(args: ParsedArgs, json: boolean): Promise<number> {
  const input = args.flags.get('file');
  if (input === undefined || input === 'true') {
    fail('packet-verify 需要 --file <包 JSON 路径>。');
    return 2;
  }
  const raw = readFileSyncSafe(input);
  if (raw === null) {
    fail(`无法读取文件：${input}`);
    return 1;
  }
  const { validatePacket } = await import('@mom/core');
  const parsed = JSON.parse(raw) as unknown;
  const candidates = Array.isArray((parsed as { packets?: unknown }).packets)
    ? ((parsed as { packets: unknown[] }).packets as unknown[])
    : [parsed];
  let allOk = true;
  const results = candidates.map((packet, index) => {
    const validation = validatePacket(packet);
    if (!validation.ok) allOk = false;
    return { index, ok: validation.ok, reasons: validation.reasons };
  });
  if (json) process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  else {
    for (const result of results) {
      process.stdout.write(`#${result.index}: ${result.ok ? '通过' : '失败'}\n`);
      for (const reason of result.reasons) process.stdout.write(`  ✗ ${reason}\n`);
    }
  }
  return allOk ? 0 : 1;
}

async function cmdIssueSet(store: MemoryStore, args: ParsedArgs, json: boolean): Promise<number> {
  const file = args.flags.get('file');
  if (file === undefined || file === 'true') {
    fail('issue-set 需要 --file <问题集 JSON 路径>。');
    return 2;
  }
  const raw = readFileSyncSafe(file);
  if (raw === null) {
    fail(`无法读取文件：${file}`);
    return 1;
  }
  const { runIssueSet } = await import('@mom/core');
  const cases = JSON.parse(raw) as Array<{
    id: string;
    query: string;
    expectIds?: string[];
    forbidIds?: string[];
    category?: string;
  }>;
  await store.load();
  const outcome = await runIssueSet(
    cases.map(item => ({
      id: item.id,
      query: item.query,
      expectIds: item.expectIds ?? [],
      forbidIds: item.forbidIds ?? [],
      category: item.category as never,
    })),
    async (query, limit) => {
      const result = await store.search({ text: query, limit });
      return result.hits.map(hit => hit.id);
    },
  );
  if (json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  else {
    for (const row of outcome.outcomes) {
      process.stdout.write(
        `${row.violated ? '✗' : row.recalled || row.returnedIds.length === 0 ? '✓' : '·'} ${row.id}：${row.note}\n`,
      );
    }
    process.stdout.write(
      `\n合计 ${outcome.summary.total} 例；找回 ${outcome.summary.recalled}；守卫失败 ${outcome.summary.violated}；平均噪声 ${outcome.summary.averageNoise.toFixed(2)}。\n`,
    );
  }
  return outcome.summary.violated > 0 ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function requireId(args: ParsedArgs): string {
  const id = args.flags.get('id') ?? args.positionals[0] ?? '';
  if (id === '') throw new Error('缺少 --id（或第一个位置参数）。');
  return id;
}

function reportResult(result: { ok: boolean; message: string; id?: string; path?: string; conflict?: boolean; revision?: number }, json: boolean, exitCode: number): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return exitCode;
  }
  process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.message}\n`);
  if (result.conflict) {
    process.stdout.write('  （检测到并发修改或人工编辑，本次写入已取消；请重新读取后再提交。）\n');
  }
  return exitCode;
}

function scopeLabel(scope: string, ref: string): string {
  return scope === 'personal' ? 'personal' : `${scope}:${ref || '（未指定）'}`;
}

function titleOf(path: string, body: string): string {
  const match = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (match && match[1]) return match[1].trim();
  return path.split('/').pop()?.replace(/\.md$/, '') ?? '';
}

function dirOf(target: string): string {
  const index = target.lastIndexOf('/');
  return index < 0 ? '' : target.slice(0, index);
}

function readFileSyncSafe(file: string): string | null {
  try {
    // 同步读取只用于用户显式给出的输入文件；核心不依赖它。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readStdinSync(): string | null {
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): void {
  process.stderr.write(`错误：${message}\n`);
}

function printHelp(): void {
  process.stdout.write(`mom-memory 0.2.0 —— Missher Obsidian Memory 的独立命令行入口

用法：
  mom-memory <命令> --vault <Vault绝对路径> [选项]

必需参数：
  --vault <路径>        Vault（或任意受控目录）的绝对路径。也可用环境变量 MOM_VAULT。
  --root <相对路径>     记忆根目录，默认 ${DEFAULT_ROOT}。也可用 MOM_ROOT。
  --layout legacy|missher  文件组织预设，默认 legacy。也可用 MOM_LAYOUT。
  --placement root|vault  分类放在记忆根内或 Vault 并列目录，默认 root。也可用 MOM_PLACEMENT。
  --folders-json <JSON>   分类到相对目录的覆盖对象，也可用 MOM_FOLDERS_JSON；须与插件配置一致。

范围控制（默认只查 personal，绝不隐式跨项目）：
  --scope personal | project:<名称> | context:<名称>   （可重复）

命令：
  remember      显式记住一段内容（用户动作授权，直接 confirmed）
                  --text "..." | --file <路径> | --stdin
                  --from-history   标记为回放历史：会经过护栏并被拒绝
  propose       生成待确认候选（AI/外部输入用），默认 pending
                  remember/propose 可加 --category <分类标识>，如 memory、profile、workflow、lesson。
                  --title <短标题> 可单独指定标题（最多 300 字符）。
  search        检索（默认排除 pending 与过期）
                  --text "..." --limit N --include-pending --tag X --kind fact
  get           输出某条记忆的原始 Markdown          --id <id>
  explain       说明某条记忆为什么被/不被召回      --id <id>
  update        更新内容                            --id <id> --text "..." --expected-hash <hash>
  correct       用户明确纠错，立即生效并提升版本    --id <id> --text "新内容"
  supersede     用新记忆替代旧记忆                  --id <旧id> --text "新内容"
  forget        停止使用（归档，保留历史）          --id <id>
  delete        永久删除（留下不含正文的标记）      --id <id>
  confirm/reject/restore                             --id <id>
  pending       列出待确认候选
  review        本地确定性复盘（不调用模型）
  profile       生成个人概览（派生视图）            --out <相对路径>
  export        导出记忆                            --format json|jsonl --out <相对路径>
  import        导入 JSONL（默认回到 pending）      --file <路径>
  session-commit 提交会话事件（JSONL，按事件 id 幂等）--file <路径>
  rebuild       重建派生索引
  stats         统计概览
  queue-status  队列里还有多少没处理的请求（只读）
  wait-receipt  等某条请求的回执（只读轮询）        <请求id> --timeout <毫秒>
  mse-candidate 生成兼容 mse-method-v1 的方法候选包（不发送）--id <id>
  packet-verify 本地校验 mse-method-v1 包            --file <路径>
  issue-set     运行问题集并报告分层结果            --file <路径>

通用选项：
  --json        以 JSON 输出（便于程序消费）
  --help        显示本帮助
  --version     显示版本

安全边界：
  · 所有路径相对 Vault，拒绝 ..、绝对路径与符号链接逃逸。
  · 只访问记忆根及启动时明确配置的分类目录；状态与队列仍在记忆根内。
  · 与 Obsidian 插件共用同一核心与同一套写入比较逻辑。
`);
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;

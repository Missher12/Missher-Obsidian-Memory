/**
 * 有界持久作业队列（纯状态机部分）。
 *
 * 与产品状态的区分是硬要求：
 * - 作业的 `queued / running / completed / partial / failed / cancelled` 是**调度状态**
 * - 记忆的 `pending / confirmed` 是**内容状态**
 * 两者绝不互相冒充。“已受理”不等于“已完成”；部分成功必须逐项能读出失败。
 *
 * 关键约束：
 * - 崩溃后**未知的付费请求不自动重放**：调用方必须显式把它标记为 `unknown`。
 * - 暂停/取消/版本变更后到达的迟到结果不得写入（`mayCommit` 判定）。
 * - 游标只越过已可靠记录的结果，失败区间可单独重试。
 */

export type JobKind =
  | 'extract_session'
  | 'ai_review'
  | 'periodic_daily'
  | 'periodic_weekly'
  | 'index_rebuild'
  | 'mse_bridge_push';

export type JobStatus =
  /** 已受理，等待执行 */
  | 'queued'
  /** 正在执行 */
  | 'running'
  /** 全部子项成功 */
  | 'completed'
  /** 部分子项失败（必须逐项报告） */
  | 'partial'
  /** 全部失败 */
  | 'failed'
  /** 用户取消（可能已提交一部分） */
  | 'cancelled'
  /** 崩溃/超时导致结果未知：不得自动重放 */
  | 'unknown'
  /** 被暂停而中断，可恢复 */
  | 'paused';

export interface JobItemResult {
  /** 子项标识（事件 id / 记忆 id / 问题 id）。 */
  ref: string;
  ok: boolean;
  /** 实际发生的动作。 */
  action: 'created' | 'updated' | 'skipped' | 'failed' | 'blocked';
  message: string;
  /** 产出物引用（记忆 id 等）。 */
  produced?: string;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** 幂等键：同一区间/同一事件集重复触发只补未处理区间。 */
  scope: string;
  /** 本次作业覆盖的输入区间（起止标记）。 */
  cursorFrom: string;
  cursorTo: string;
  /** 输入指纹，用于判断“没有新增证据就跳过模型”。 */
  inputHash: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt: string;
  /** 是否已经发出过“可能计费”的模型请求。 */
  billableRequestSent: boolean;
  /** 逐项结果。 */
  items: JobItemResult[];
  /** 错误说明（人类可读）。 */
  error: string;
  /** 调度来源，便于 UI 解释“为什么这时跑了”。 */
  trigger: 'explicit' | 'session_end' | 'idle' | 'daily' | 'weekly' | 'manual';
  /** 该作业开始时读到的记忆版本快照，用于提交前核对。 */
  targets: Array<{ id: string; revision: number; hash: string }>;
}

/**
 * 预算用量。
 *
 * 必须**进持久状态**：审计复现（修复前）预算只活在内存里，
 * 于是重启能重置当日限额，而「付费请求已发出」这件事也可能伴随进程一起消失。
 */
export interface BudgetState {
  /** 记账日期（UTC，`YYYY-MM-DD`）。 */
  day: string;
  calls: number;
  tokens: number;
}

/**
 * 一次**尚未对账**的预算预占。
 *
 * 为什么预占必须自己记住「它属于哪一天」：
 * 预算日账（`BudgetState`）在跨 UTC 日时会被重置成新的一天。
 * 如果结算只按 `reservedTokens` 的数字去减退，那么一条**昨日**的迟到结果
 * 会去冲减**今天**的账——实测复现：昨日预占 1241、今日另预占 1241，
 * 昨日迟到的 usage 10 结算后把今日账目写成 `tokens: 10`，
 * 于是今天那笔还没结算的预占凭空消失，用户可以超额调用。
 * 因此预占按 id 记账，结算时先核对它属于哪一天，跨日就**不动今天的账**。
 */
export interface BudgetReservation {
  /** 预占所在的 UTC 记账日（`YYYY-MM-DD`）。 */
  day: string;
  /** 预占的 token（保守估算）。 */
  tokens: number;
  /** 预占时刻（用于清理历史条目）。 */
  at: number;
}

export interface JobQueueState {
  version: number;
  jobs: JobRecord[];
  /** 当日模型调用与 token 用量。 */
  budget: BudgetState;
  /**
   * 未对账的预占：`reservationId → { day, tokens, at }`。
   *
   * 进持久状态的理由：进程重启后迟到的结果仍然要对账，
   * 而那时**内存里没有**这条预占属于哪一天的信息，
   * 只能去猜——猜错就是跨日冲账。
   */
  reservations: Record<string, BudgetReservation>;
  /** 处理游标：每个 scope 的已可靠处理位置。 */
  cursors: Record<string, string>;
  /** 上次各触发器执行时间。 */
  lastRun: Record<string, string>;
  /** 暂停开关。 */
  paused: boolean;
  /** 版本标识：插件升级后，旧作业的迟到结果一律拒绝。 */
  instanceId: string;
}

export const QUEUE_VERSION = 1;

/**
 * 记账日界：**UTC 日**（`YYYY-MM-DD`）。
 *
 * 明确采用 UTC 而不是本地时区，理由是账目要能被跨时区复核：
 * 同一个时刻在任何机器上都落在同一个记账日，不会因为用户出差换时区
 * 而出现「同一笔调用算进两天」或反过来「一天变成 25 小时额度」。
 * 代价是日界不在本地午夜——界面文案必须这么写，不能让用户以为零点重置。
 */
export function utcDayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * 保守的 token 估算（**不是**实测用量）。
 *
 * 本产品不实现厂商各自的 tokenizer：那需要下载模型词表，而且不同厂商
 * 对同一条文本的切分本来就不一样。这里的取值刻意偏大——
 * 预算宁可提前拦住，也不要先花了钱再发现超额。
 *
 * 规则：CJK 字符按 1 字≈1 token；其余字符按 4 字符≈1 token；
 * 每个消息再加少量固定开销（角色标记等）。调用方应当用**实际发出的文本**来估算。
 */
export function estimateTokensFromText(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    // CJK 统一表意文字、假名、谚文、全角标点：这些基本是 1 字 ≈ 1 token。
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 一次模型调用的 token 估算（输入 + 预留输出）。 */
export function estimateModelCallTokens(input: { promptText: string; maxOutputTokens: number; messages?: number }): number {
  const perMessage = 8;
  const prompt = estimateTokensFromText(input.promptText) + perMessage * (input.messages ?? 1);
  return Math.max(1, prompt + Math.max(0, input.maxOutputTokens));
}

export function emptyQueueState(instanceId: string, now: number): JobQueueState {
  return {
    version: QUEUE_VERSION,
    jobs: [],
    budget: { day: utcDayOf(now), calls: 0, tokens: 0 },
    reservations: {},
    cursors: {},
    lastRun: {},
    paused: false,
    instanceId,
    ...{ _createdAt: new Date(now).toISOString() },
  } as JobQueueState;
}

export function parseQueueState(raw: string | null, instanceId: string): { state: JobQueueState; error: string | null } {
  if (raw === null || raw.trim() === '') return { state: emptyQueueState(instanceId, Date.now()), error: null };
  try {
    const parsed = JSON.parse(raw) as Partial<JobQueueState>;
    const jobs: JobRecord[] = Array.isArray(parsed.jobs) ? parsed.jobs.filter(isJobRecord) : [];
    const rawBudget = parsed.budget as Partial<BudgetState> | undefined;
    const today = utcDayOf(Date.now());
    const budget: BudgetState =
      rawBudget !== undefined && typeof rawBudget === 'object' && typeof rawBudget.day === 'string'
        ? {
            day: rawBudget.day,
            calls: typeof rawBudget.calls === 'number' ? rawBudget.calls : 0,
            tokens: typeof rawBudget.tokens === 'number' ? rawBudget.tokens : 0,
          }
        : { day: today, calls: 0, tokens: 0 };
    /**
     * 跨天时把计数滚回零。
     *
     * 判定放在**读取**这一侧：进程可能在跨天之后才第一次启动，
     * 那时不能把昨天的用量当成今天的（也就不会莫名其妙地“超预算”）。
     */
    if (budget.day !== today) {
      budget.day = today;
      budget.calls = 0;
      budget.tokens = 0;
    }
    /**
     * 未对账的预占。只保留**今天与昨天**：
     * 更早的条目对应的记账日已经翻过去两轮，结算时本来就不该再动账，
     * 留着只会让状态文件无限增长。
     */
    const rawReservations = parsed.reservations as Record<string, unknown> | undefined;
    const reservations: Record<string, BudgetReservation> = {};
    if (rawReservations !== undefined && typeof rawReservations === 'object' && rawReservations !== null) {
      const yesterday = utcDayOf(Date.now() - 24 * 60 * 60 * 1000);
      for (const [id, value] of Object.entries(rawReservations)) {
        const entry = value as Partial<BudgetReservation> | undefined;
        if (entry === undefined || typeof entry !== 'object') continue;
        if (typeof entry.day !== 'string' || (entry.day !== today && entry.day !== yesterday)) continue;
        reservations[id] = {
          day: entry.day,
          tokens: typeof entry.tokens === 'number' && entry.tokens > 0 ? entry.tokens : 0,
          at: typeof entry.at === 'number' ? entry.at : 0,
        };
      }
    }
    return {
      state: {
        version: typeof parsed.version === 'number' ? parsed.version : QUEUE_VERSION,
        jobs,
        budget,
        reservations,
        cursors: isStringMap(parsed.cursors) ? parsed.cursors : {},
        lastRun: isStringMap(parsed.lastRun) ? parsed.lastRun : {},
        paused: parsed.paused === true,
        instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : instanceId,
      },
      error: null,
    };
  } catch (error) {
    return {
      state: emptyQueueState(instanceId, Date.now()),
      error: `作业队列文件损坏，已按空队列处理（原文件不会被自动覆盖）：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function serializeQueueState(state: JobQueueState): string {
  const jobs = state.jobs.slice(-400);
  return `${JSON.stringify({ ...state, version: QUEUE_VERSION, jobs }, null, 2)}\n`;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false;
  for (const v of Object.values(value as Record<string, unknown>)) if (typeof v !== 'string') return false;
  return true;
}

function isJobRecord(value: unknown): value is JobRecord {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<JobRecord>;
  return typeof job.id === 'string' && typeof job.kind === 'string' && typeof job.status === 'string';
}

/** 终态：不会再有新的结果写入。 */
export function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled' || status === 'unknown';
}

/** 是否可以被用户取消（正在排队或运行）。 */
export function isCancellable(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'paused';
}

export function createJob(input: {
  id: string;
  kind: JobKind;
  scope: string;
  cursorFrom?: string;
  cursorTo?: string;
  inputHash?: string;
  trigger: JobRecord['trigger'];
  now: number;
  maxAttempts?: number;
  targets?: JobRecord['targets'];
}): JobRecord {
  const at = new Date(input.now).toISOString();
  return {
    id: input.id,
    kind: input.kind,
    status: 'queued',
    scope: input.scope,
    cursorFrom: input.cursorFrom ?? '',
    cursorTo: input.cursorTo ?? '',
    inputHash: input.inputHash ?? '',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 2,
    createdAt: at,
    updatedAt: at,
    startedAt: '',
    finishedAt: '',
    billableRequestSent: false,
    items: [],
    error: '',
    trigger: input.trigger,
    targets: input.targets ?? [],
  };
}

/**
 * 判断一个作业结果现在是否还允许提交。
 *
 * 这是“暂停/取消/升级后迟到结果不得写入”的唯一判定入口。
 */
export function mayCommit(
  job: JobRecord,
  context: {
    instanceId: string;
    currentInstanceId: string;
    capturedAt: number;
    now: number;
    maxAgeMs?: number;
    /** 队列当前是否被暂停；暂停时任何迟到结果都不得提交。 */
    queuePaused?: boolean;
    /** 该结果携带的运行代次；与作业当前 attempts 不一致即为过期结果。 */
    attempt?: number;
  },
): { allowed: boolean; reason: string } {
  if (job.status === 'cancelled') return { allowed: false, reason: '作业已被取消，迟到结果被拒绝。' };
  if (job.status === 'unknown') return { allowed: false, reason: '作业结果未知（可能已产生费用），需要人工确认后才能提交。' };
  /**
   * A2：暂停也是禁止提交的状态。
   *
   * 审计复现（修复前）：`job.status === 'paused'` 时 `mayCommit` 返回
   * `{allowed:true}`——与模块“暂停/取消/升级后迟到结果不得写入”的契约矛盾。
   * 队列级暂停（`state.paused`）同样纳入判定。
   */
  if (job.status === 'paused') return { allowed: false, reason: '作业已被暂停，迟到结果被拒绝；恢复后需要重新发起或由用户确认提交。' };
  if (job.status === 'queued') return { allowed: false, reason: '作业已回到排队状态，旧结果被拒绝。' };
  if (job.status !== 'running') return { allowed: false, reason: `作业当前状态为 ${job.status}，不接受提交。` };
  if (context.queuePaused === true) return { allowed: false, reason: '作业队列处于暂停状态，迟到结果被拒绝。' };
  if (context.attempt !== undefined && context.attempt !== job.attempts) {
    return {
      allowed: false,
      reason: `结果来自第 ${context.attempt} 次尝试，作业当前是第 ${job.attempts} 次，代次不匹配，被拒绝。`,
    };
  }
  if (context.instanceId !== context.currentInstanceId) {
    return { allowed: false, reason: '作业来自上一个插件实例（版本或会话已变化），迟到结果被拒绝。' };
  }
  const maxAge = context.maxAgeMs ?? 15 * 60_000;
  if (context.now - context.capturedAt > maxAge) {
    return { allowed: false, reason: `结果在 ${Math.round((context.now - context.capturedAt) / 1000)} 秒后才到达，超出允许窗口，被拒绝。` };
  }
  return { allowed: true, reason: '允许提交。' };
}

/**
 * 归类一次执行结果。
 * 只要有任何子项失败，就不是 completed。
 */
export function classifyOutcome(items: readonly JobItemResult[]): JobStatus {
  if (items.length === 0) return 'completed';
  const failed = items.filter(item => !item.ok).length;
  if (failed === 0) return 'completed';
  if (failed === items.length) return 'failed';
  return 'partial';
}

/** 调度器：决定某个触发器现在该不该跑。 */
export interface TriggerConfig {
  /** 闲置多久后检查（分钟）。0 表示关闭。 */
  idleMinutes: number;
  /** 每日维护间隔（小时）。0 表示关闭。 */
  dailyHours: number;
  /** 每周维护间隔（小时）。0 表示关闭。 */
  weeklyHours: number;
}

export const DEFAULT_TRIGGERS: TriggerConfig = { idleMinutes: 10, dailyHours: 24, weeklyHours: 168 };

export type TriggerDecision =
  | { run: true; trigger: JobRecord['trigger']; reason: string }
  | { run: false; reason: string };

/**
 * 纯函数式调度判定。
 *
 * 注意：`idle` 只是**检查点**，不代表用户上一件事成功了。
 * 而且“应用关闭时不会常驻”——退出期间到期的任务会在下次启动时合并处理，
 * 调用方必须把 `missedWhileClosed` 如实显示给用户。
 */
export function decideTrigger(input: {
  now: number;
  lastActivityAt: number;
  hasNewEvidence: boolean;
  config: TriggerConfig;
  lastRun: { idle?: number; daily?: number; weekly?: number };
  missedWhileClosed: boolean;
}): TriggerDecision {
  const { config } = input;
  if (!input.hasNewEvidence) {
    return { run: false, reason: '没有新增证据，跳过模型调用。' };
  }
  const sinceActivity = input.now - input.lastActivityAt;
  if (config.weeklyHours > 0) {
    const last = input.lastRun.weekly ?? 0;
    if (input.now - last >= config.weeklyHours * 3_600_000) {
      return {
        run: true,
        trigger: 'weekly',
        reason: input.missedWhileClosed ? '退出期间到期的每周维护，已在本次启动合并处理。' : '到达每周维护间隔。',
      };
    }
  }
  if (config.dailyHours > 0) {
    const last = input.lastRun.daily ?? 0;
    if (input.now - last >= config.dailyHours * 3_600_000) {
      return {
        run: true,
        trigger: 'daily',
        reason: input.missedWhileClosed ? '退出期间到期的每日维护，已在本次启动合并处理。' : '到达每日维护间隔。',
      };
    }
  }
  if (config.idleMinutes > 0 && sinceActivity >= config.idleMinutes * 60_000) {
    const last = input.lastRun.idle ?? 0;
    if (input.now - last >= config.idleMinutes * 60_000) {
      return {
        run: true,
        trigger: 'idle',
        reason: `已闲置 ${Math.round(sinceActivity / 60_000)} 分钟（闲置只是检查点，不代表上一件事成功）。`,
      };
    }
  }
  return { run: false, reason: '未到达任何触发条件。' };
}

/** 队列管理器：纯内存状态操作。 */
export class JobQueue {
  private state: JobQueueState;

  constructor(state: JobQueueState) {
    this.state = state;
  }

  get snapshot(): JobQueueState {
    return this.state;
  }

  get paused(): boolean {
    return this.state.paused;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
  }

  add(job: JobRecord): void {
    this.state.jobs.push(job);
    if (this.state.jobs.length > 400) this.state.jobs.splice(0, this.state.jobs.length - 400);
  }

  get(id: string): JobRecord | undefined {
    return this.state.jobs.find(job => job.id === id);
  }

  byStatus(status: JobStatus): JobRecord[] {
    return this.state.jobs.filter(job => job.status === status);
  }

  /** 取下一个可执行作业（队列被暂停时返回 null）。 */
  next(now: number): JobRecord | null {
    if (this.state.paused) return null;
    void now;
    return this.state.jobs.find(job => job.status === 'queued') ?? null;
  }

  /**
   * 启动一个作业。
   * 如果该作业此前已经发出过计费请求而结果未知，调用方必须先处理 `unknown`，
   * 所以这里对 `unknown` 状态直接拒绝。
   */
  start(id: string, now: number): { ok: boolean; reason: string } {
    const job = this.get(id);
    if (!job) return { ok: false, reason: `未找到作业 ${id}。` };
    if (job.status === 'unknown') return { ok: false, reason: '该作业结果未知，禁止自动重放。' };
    /**
     * 双保险：即使某条历史数据把“已计费但结果未知”的作业留在了 paused，
     * 也不允许通过普通继续操作重新发出。必须走显式的未知请求处理流程。
     */
    if (job.billableRequestSent && job.status === 'paused') {
      return {
        ok: false,
        reason: '该作业此前已发出付费请求且结果未知，不能用普通继续操作重放；请先显式处理未知请求。',
      };
    }
    if (job.status === 'cancelled') return { ok: false, reason: '该作业已取消。' };
    if (job.status === 'running') return { ok: false, reason: '该作业正在运行。' };
    if (isTerminal(job.status) && job.status !== 'paused') return { ok: false, reason: '该作业已结束。' };
    job.status = 'running';
    job.attempts += 1;
    job.startedAt = new Date(now).toISOString();
    job.updatedAt = job.startedAt;
    return { ok: true, reason: '已开始。' };
  }

  /** 标记已发出计费请求（用于崩溃后判定“未知请求”）。 */
  markBillable(id: string): void {
    const job = this.get(id);
    if (job) job.billableRequestSent = true;
  }

  /**
   * 暂停单个作业（不是暂停整个队列）。
   *
   * 暂停后：`mayCommit` 一律拒绝该作业的迟到结果，`start` 也不能把它
   * 当作“普通暂停”直接继续——除非它从未发出过计费请求。
   */
  pause(id: string, reason: string, now: number): { ok: boolean; reason: string } {
    const job = this.get(id);
    if (!job) return { ok: false, reason: `未找到作业 ${id}。` };
    if (isTerminal(job.status)) return { ok: false, reason: '该作业已结束，无需暂停。' };
    job.status = 'paused';
    job.error = reason;
    job.updatedAt = new Date(now).toISOString();
    return { ok: true, reason: '已暂停。' };
  }

  /** 整个队列的暂停开关。 */
  setQueuePaused(paused: boolean): void {
    this.setPaused(paused);
  }

  queuePaused(): boolean {
    return this.state.paused;
  }

  finish(
    id: string,
    outcome: { status: JobStatus; items: JobItemResult[]; error?: string; cursorTo?: string },
    now: number,
  ): JobRecord | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    job.status = outcome.status;
    job.items = [...job.items, ...outcome.items];
    job.error = outcome.error ?? '';
    job.finishedAt = new Date(now).toISOString();
    job.updatedAt = job.finishedAt;
    if (outcome.cursorTo && outcome.status === 'completed') {
      this.state.cursors[job.scope] = outcome.cursorTo;
    }
    return job;
  }

  cancel(id: string, now: number, reason: string): { ok: boolean; reason: string; job?: JobRecord } {
    const job = this.get(id);
    if (!job) return { ok: false, reason: `未找到作业 ${id}。` };
    if (!isCancellable(job.status)) return { ok: false, reason: `作业状态为 ${job.status}，无法取消。` };
    job.status = 'cancelled';
    job.error = reason;
    job.updatedAt = new Date(now).toISOString();
    job.finishedAt = job.updatedAt;
    return { ok: true, reason: '已取消；已提交的部分保留，未提交的不再写入。', job };
  }

  /**
   * 把“运行中发现进程可能已崩溃”的作业标记为 unknown。
   * 恢复时不得自动重放，必须由用户决定。
   */
  markUnknown(id: string, now: number, reason: string): void {
    const job = this.get(id);
    if (!job) return;
    job.status = 'unknown';
    job.error = reason;
    job.updatedAt = new Date(now).toISOString();
  }

  /** 启动时调用：把上次运行遗留的 running 作业归类。 */
  /**
   * 启动恢复。
   *
   * A3：**计费未知的作业永远是 unknown**，与 `resumeRunning` 无关。
   *
   * 审计复现（修复前）：一个 `billableRequestSent === true` 的 running 作业，
   * 在 `resumeRunning: false` 时被归类为普通 `paused`，而 `start()` 接受
   * paused —— 于是“结果未知的付费请求”可以被一次普通的“继续”操作
   * 抹平区别并重新发出。这是不可接受的：未知就是未知。
   *
   * `resumeRunning` 只影响**没有发出计费请求**的中断作业。
   */
  recoverOnStartup(now: number, opts: { resumeRunning: boolean }): JobRecord[] {
    const touched: JobRecord[] = [];
    for (const job of this.state.jobs) {
      if (job.status !== 'running') continue;
      if (job.billableRequestSent) {
        job.status = 'unknown';
        job.updatedAt = new Date(now).toISOString();
        job.error = '上次运行中断前已发出付费模型请求，结果未知；不会自动重放，也不会因“继续”而降级为普通暂停。';
      } else if (opts.resumeRunning) {
        job.status = 'queued';
        job.updatedAt = new Date(now).toISOString();
        job.error = '上次运行中断，且未发出计费请求，已重新排队。';
      } else {
        job.status = 'paused';
        job.updatedAt = new Date(now).toISOString();
        job.error = '上次运行中断（未发出计费请求），已暂停，等待用户决定是否继续。';
      }
      touched.push(job);
    }
    return touched;
  }

  /** 当日预算用量。 */
  get budget(): BudgetState {
    return this.state.budget;
  }

  /**
   * 记账一次真实调用。
   *
   * 调用方必须在**发出请求之前**先把「已发出付费请求」与预算一起落盘：
   * 只记在内存里的话，崩溃或重启就会让「这次调用已经发生」这件事消失。
   */
  recordCall(tokens: number, now: number): void {
    this.refreshBudgetDay(now);
    this.state.budget.calls += 1;
    this.state.budget.tokens += Math.max(0, tokens);
  }

  /**
   * 按日界刷新预算。
   *
   * 为什么必须有这个方法：跨天判定原先只发生在 `parseQueueState`（启动时）
   * 与 `recordCall`（调用发生时）。于是一个**一直开着**的实例只要昨天的额度用尽，
   * 今天就会卡在 `remainingCalls() <= 0` 上直接拒绝，永远走不到刷新那一步——
   * 表现成「明明到了新的一天，却还是说额度用完」。
   * 因此所有预算判断之前都要先调用它，并让调用方把结果持久化。
   *
   * 返回是否真的翻页了（调用方据此决定要不要落盘，而不是每次判断都写盘）。
   */
  refreshBudgetDay(now: number): boolean {
    const today = utcDayOf(now);
    if (this.state.budget.day === today) return false;
    this.state.budget = { day: today, calls: 0, tokens: 0 };
    return true;
  }

  /**
   * 只补记 token（不增加调用次数）。
   *
   * 用于「预占已经记了这一次调用、真实用量回来之后把估算换成实测」的对账：
   * 调用次数不能重复加，token 要按实际补差。
   */
  recordTokens(tokens: number): void {
    this.state.budget.tokens = Math.max(0, this.state.budget.tokens + Math.round(tokens));
  }

  /**
   * 退回一次尚未真正发生的预占。
   *
   * 只用于「预占已经落盘、但模型最终没有被调用」的情况：
   * 例如作业走到了最后发现不需要模型，或者供应商在发出前就拒绝了。
   * 已经完成的调用**不能**用它退款——那会把真实的账抹掉。
   */
  refund(calls: number, tokens: number): void {
    this.state.budget.calls = Math.max(0, this.state.budget.calls - Math.max(0, calls));
    this.state.budget.tokens = Math.max(0, this.state.budget.tokens - Math.max(0, tokens));
  }

  /**
   * 登记一次预占，并返回它的 id。
   *
   * 预占必须记住**自己属于哪一天**：结算可能发生在跨日之后
   * （迟到结果、重启恢复），那时今天的账目已经和昨天无关了，
   * 按数字直接减退会把今天另一笔预占冲掉。
   */
  openReservation(tokens: number, now: number): { id: string; day: string } {
    const day = utcDayOf(now);
    const id = `rsv_${day.replace(/-/g, '')}_${(this.state.jobs.length + 1).toString(36)}_${Math.abs(
      Math.round(tokens),
    ).toString(36)}`;
    /**
     * id 在同一毫秒内可能重复（同一天、同样的作业数与 token 数）：
     * 用「已存在就加序号」保证唯一，避免两条预占互相覆盖。
     */
    let unique = id;
    let suffix = 1;
    while (this.state.reservations[unique] !== undefined) {
      suffix += 1;
      unique = `${id}_${suffix}`;
    }
    this.state.reservations[unique] = { day, tokens: Math.max(0, Math.round(tokens)), at: now };
    return { id: unique, day };
  }

  /** 一次预占属于哪一天（找不到返回 null——例如它已经被对账或早于保留窗口）。 */
  reservationDay(id: string): string | null {
    return this.state.reservations[id]?.day ?? null;
  }

  /** 一次预占登记的 token（找不到返回 0）。 */
  reservationTokens(id: string): number {
    return this.state.reservations[id]?.tokens ?? 0;
  }

  /** 关闭一条预占（已对账或已退回）。 */
  closeReservation(id: string): void {
    delete this.state.reservations[id];
  }

  /**
   * 结算用的记账调整：把某一天的预占换成实测值。
   *
   * 与 `refund` + `recordTokens` 的区别是**它会先核对预占属于哪一天**：
   * 预占不在当前记账日时**不做任何调整**并返回 false——
   * 昨天的账已经随昨日的日账一起翻页了，不能拿它冲减今天。
   */
  settleAgainstReservation(id: string, measuredTokens: number, now: number): boolean {
    const reservation = this.state.reservations[id];
    if (reservation === undefined) return false;
    const today = utcDayOf(now);
    if (reservation.day !== today || this.state.budget.day !== today) {
      // 跨日迟到：只关掉这条预占，不动今天的账。
      this.closeReservation(id);
      return false;
    }
    this.state.budget.tokens = Math.max(0, this.state.budget.tokens - reservation.tokens);
    this.state.budget.tokens = Math.max(0, this.state.budget.tokens + Math.max(0, Math.round(measuredTokens)));
    this.closeReservation(id);
    return true;
  }

  setCursor(scope: string, cursor: string): void {
    this.state.cursors[scope] = cursor;
  }

  cursor(scope: string): string {
    return this.state.cursors[scope] ?? '';
  }

  markRun(trigger: string, now: number): void {
    this.state.lastRun[trigger] = new Date(now).toISOString();
  }

  lastRunAt(trigger: string): number {
    const value = this.state.lastRun[trigger];
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** 未解决问题计数，用于工作台徽标。 */
  openProblems(): { queued: number; running: number; partial: number; failed: number; unknown: number; paused: number } {
    const count = (status: JobStatus): number => this.state.jobs.filter(job => job.status === status).length;
    return {
      queued: count('queued'),
      running: count('running'),
      partial: count('partial'),
      failed: count('failed'),
      unknown: count('unknown'),
      paused: count('paused'),
    };
  }
}

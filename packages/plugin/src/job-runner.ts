/**
 * AI 作业运行器：调度、预算、暂停/取消、迟到拒绝、崩溃恢复。
 *
 * ## 这一层存在的理由
 *
 * 「设置里有开关」不等于功能存在。这个运行器把模型有关的作业接成一条
 * 真实可走的路：什么时候跑、跑多少、钱花到哪、被取消之后迟到的结果怎么办、
 * 应用关掉再打开怎么补上没处理的区间。
 *
 * ## 五条硬规则
 *
 * 1. **没有新证据就不调模型**。输入指纹没变就直接 `skipped` 并写清原因，
 *    绝不为「跑一次」而花一次钱。
 * 2. **预算先于调用**。按天计调用次数与 token；超预算就停下并说明原因，
 *    下一次触发才可能继续。
 * 3. **暂停 / 取消 / 卸载一律拒绝迟到结果**。判定入口是核心的 `mayCommit`：
 *    运行代次（attempt）、实例代次、结果年龄、队列暂停全部参与。
 * 4. **崩溃后不重放未知付费请求**。启动恢复把「已发出计费请求」的作业
 *    固定为 `unknown`，必须由用户显式处理，不会因为一次“继续”而重发。
 * 5. **提交前逐项核对**（`validateCandidate`）：范围、`allow_model`、
 *    已确认状态、有效期、来源失效都在提交那一刻重新检查——
 *    因为排队期间用户可能已经改过设置或改过记忆。
 *
 * 这一层不认识 Obsidian：它只依赖核心与注入的回调，因此可以在测试里
 * 用真实 `MemoryStore` 直接跑。
 */

import {
  JobQueue,
  classifyOutcome,
  createId,
  decideTrigger,
  emptyQueueState,
  estimateModelCallTokens,
  mayCommit,
  parseQueueState,
  serializeQueueState,
  type BudgetState,
  type JobItemResult,
  type JobKind,
  type JobQueueState,
  type JobRecord,
  type MemoryRecord,
  type MemoryStore,
  type TriggerConfig,
} from '@mom/core';

/** 作业种类到中文说明（界面直接显示这个）。 */
export const JOB_LABELS: Record<JobKind, string> = {
  extract_session: '从会话/新内容里提取候选（会调用模型）',
  ai_review: '语义复盘：找矛盾与过期（会调用模型）',
  periodic_daily: '每日维护检查点',
  periodic_weekly: '每周维护检查点',
  index_rebuild: '重建索引（本地，不调用模型）',
  mse_bridge_push: '整理 MSE 方法候选（离线导出，不发送）',
};

/** 这个作业种类是否必须要有新证据才允许调用模型。 */
export function jobNeedsNewEvidence(kind: JobKind): boolean {
  return kind === 'extract_session' || kind === 'ai_review';
}

export interface JobRunnerConfig {
  /** 每次触发允许的最大模型调用次数（默认 3）。 */
  maxCallsPerRun: number;
  /** 每天允许的最大模型调用次数（默认 20）。0 表示不限制。 */
  maxCallsPerDay: number;
  /** 每天允许的最大 token（默认 200000）。0 表示不限制。 */
  maxTokensPerDay: number;
  /**
   * 单次调用预留的最大输出 token（默认 2000）。
   *
   * 预算是**按最坏情况预占**的：请求里声明的输出上限也算进去，
   * 否则「一次把额度用光」的请求能在记账前溜过去。真实用量回来后再对账。
   */
  maxTokensPerRun: number;
  /** 结果允许提交的最大年龄（毫秒，默认 15 分钟）。 */
  maxResultAgeMs: number;
  /** 单次模型等待上限（毫秒）。 */
  timeoutMs: number;
  /** 空闲触发（分钟）；0 关闭。 */
  idleMinutes: number;
  /** 每日维护间隔（小时）；0 关闭。 */
  dailyHours: number;
  /** 每周维护间隔（小时）；0 关闭。 */
  weeklyHours: number;
}

export const DEFAULT_JOB_RUNNER_CONFIG: JobRunnerConfig = {
  maxCallsPerRun: 3,
  maxCallsPerDay: 20,
  maxTokensPerDay: 200_000,
  maxTokensPerRun: 2000,
  maxResultAgeMs: 15 * 60_000,
  timeoutMs: 60_000,
  idleMinutes: 10,
  dailyHours: 24,
  weeklyHours: 168,
};

/** 预算用量就是持久状态里的那一份，不再另存一份内存副本。 */
export type BudgetUsage = BudgetState;

export interface JobInputItem {
  id: string;
  title: string;
  text: string;
  revision: number;
}

export interface JobCandidate {
  title: string;
  body: string;
  kind: string;
  tags: string[];
  scope: string;
  evidence: string[];
  confidence: number;
}

export interface JobWorkResult {
  ok: boolean;
  /** 人类可读结论（写进作业记录，界面直接显示）。 */
  message: string;
  candidates?: JobCandidate[];
  /** 想改已确认事实的修改建议：只会落成待审补丁。 */
  patches?: Array<{ targetId: string; fields: Record<string, unknown>; reason: string }>;
  /**
   * 供应商在响应里报的真实用量（没有就不填）。
   *
   * 修复前真实入口一直不传它，于是 token 账永远是 0；现在提取与复盘都会透传，
   * 由 `settleModelCall` 对账。**不要在这里填估算值**：估算由闸门负责，
   * 两者混在一起就再也分不清「实测」和「保守估算」了。
   */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** 结果是否真实通过模型（false = 本地完成，没有发送）。 */
  modelUsed: boolean;
}

export interface JobRunResult {
  jobId: string;
  status: JobRecord['status'] | 'skipped' | 'refused';
  message: string;
  items: JobItemResult[];
}

type Clock = () => number;

export class AiJobRunner {
  private readonly store: MemoryStore;
  private readonly queue: JobQueue;
  private readonly instanceId: string;
  private readonly now: Clock;
  private readonly persist: ((state: JobQueueState) => Promise<boolean>) | null;
  private config: JobRunnerConfig;
  /** 上一次有**真实输入**的时间（用于空闲触发）。 */
  private lastInputAt = 0;
  /** 用户切走了 / 卸载了：所有在跑的作业从此拒绝提交。 */
  private unloaded = false;
  private persistenceError = '';
  /**
   * 最近一次模型调用用了哪种记账（实测 / 保守估算）。
   *
   * 界面必须能区分这两者：把估算显示成实测 token 等于对用户谎报账目。
   */
  /**
   * 最近一次打开、还没对账的预占。
   *
   * **只用于退回**（`releaseReservation` 省略 id 时的兜底）：
   * 「模型根本没被调用」是安全的退款——退回的是刚刚那次调用预占的
   * 调用次数与估算，不会碰到别人。
   *
   * 结算**不用它**：结算要动真实账目，必须由调用方给出预占 id，
   * 否则宁可拒绝记账（见 `settleModelCall`）。
   */
  private openReservationId: string | null = null;

  private lastSettlement: {
    accounted: 'measured' | 'estimated' | 'refunded' | 'refused';
    tokens: number;
    /** 这次结算属于别的记账日（迟到结果），因此没有改动今天的账。 */
    staleDay?: boolean;
  } | null = null;
  private running: string | null = null;
  private readonly inFlight = new Set<AbortController>();

  constructor(options: {
    store: MemoryStore;
    instanceId: string;
    /** 持久化回调：写 `<记忆根>/.memory/jobs.json`。缺省则只在内存里。 */
    persist?: (state: JobQueueState) => Promise<boolean>;
    load?: () => Promise<string | null>;
    config?: Partial<JobRunnerConfig>;
    now?: Clock;
  }) {
    this.store = options.store;
    this.instanceId = options.instanceId;
    this.now = options.now ?? (() => Date.now());
    this.persist = options.persist ?? null;
    this.config = { ...DEFAULT_JOB_RUNNER_CONFIG, ...options.config };
    this.queue = new JobQueue(emptyQueueState(options.instanceId, this.now()));
  }

  /** 当前设置（界面只读展示）。 */
  configSnapshot(): JobRunnerConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<JobRunnerConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** 队列状态（界面展示）。 */
  get jobs(): JobQueue {
    return this.queue;
  }

  budgetSnapshot(): BudgetUsage {
    // 预算来自持久状态：重启不会重置当日限额。
    return { ...this.queue.budget };
  }

  /**
   * 从磁盘恢复队列状态。
   *
   * 恢复时做两件事：把上次遗留的 `running` 作业按「是否已发出计费请求」
   * 归类（付费未知 → `unknown`，绝不自动重放），然后返回这次恢复改动的作业，
   * 供界面提示用户。
   */
  async load(persisted: string | null, options: { resumeRunning: boolean } = { resumeRunning: false }): Promise<JobRecord[]> {
    const parsed = parseQueueState(persisted, this.instanceId);
    const state = parsed.state;
    const queue = new JobQueue(state);
    const touched = queue.recoverOnStartup(this.now(), options);
    // 用恢复后的状态替换内部队列：JobQueue 没有「就地替换」接口，直接重建。
    this.replaceQueue(queue);
    if (parsed.error !== null) this.persistenceError = parsed.error;
    await this.save();
    return touched;
  }

  private replaceQueue(queue: JobQueue): void {
    Reflect.set(this, 'queue', queue);
  }

  /**
   * 保存队列状态。
   *
   * 返回**是否真的写成功**：调用方在发出付费请求之前必须拿到 `true`，
   * 否则「这次调用已经发生」在崩溃后会消失，用户既看不到记录也无法查账。
   */
  private async save(): Promise<boolean> {
    if (this.persist === null) {
      this.persistenceError = '没有配置持久化：作业状态只在本进程内存里，重启即丢失。';
      return false;
    }
    try {
      const ok = await this.persist(this.queue.snapshot);
      this.persistenceError = ok ? '' : '作业状态写入失败（磁盘或权限问题）。';
      return ok;
    } catch (error) {
      this.persistenceError = `作业状态写入异常：${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  /** 最近一次持久化的结论（界面与测试都用它，而不是猜）。 */
  lastPersistenceError(): string {
    return this.persistenceError;
  }

  /** 序列化当前队列（供调用方写入 Vault）。 */
  serialize(): string {
    return serializeQueueState(this.queue.snapshot);
  }

  /** 人工暂停 / 恢复整个队列。 */
  async setPaused(paused: boolean, reason: string): Promise<void> {
    this.queue.setPaused(paused);
    for (const job of this.queue.byStatus('running')) {
      if (paused) this.queue.pause(job.id, reason, this.now());
    }
    await this.save();
  }

  /** 取消一个作业。已提交的部分保留，未提交的不再写入。 */
  async cancel(jobId: string, reason: string): Promise<{ ok: boolean; reason: string }> {
    const result = this.queue.cancel(jobId, this.now(), reason);
    if (result.ok) await this.save();
    return { ok: result.ok, reason: result.reason };
  }

  /** 处理一个 `unknown`（可能已计费）的作业：只允许用户显式放弃或重新排队。 */
  async resolveUnknown(jobId: string, action: 'discard' | 'requeue'): Promise<{ ok: boolean; reason: string }> {
    const job = this.queue.get(jobId);
    if (!job) return { ok: false, reason: `未找到作业 ${jobId}。` };
    if (job.status !== 'unknown') return { ok: false, reason: `作业 ${jobId} 当前不是“结果未知”状态。` };
    const now = this.now();
    if (action === 'discard') {
      job.status = 'cancelled';
      job.error = '用户确认：不再尝试这次作业（可能已经产生费用，不重发）。';
      job.finishedAt = new Date(now).toISOString();
      job.updatedAt = job.finishedAt;
    } else {
      job.status = 'queued';
      job.billableRequestSent = false;
      job.error = '用户确认重新排队；这是一次**新的**调用，可能再次产生费用。';
      job.updatedAt = new Date(now).toISOString();
    }
    await this.save();
    return { ok: true, reason: job.error };
  }

  /** 插件卸载 / 切库：此后所有在跑作业的结果一律拒绝提交。 */
  /** 是否已经卸载/切库（问答入口用它判断「还能不能发请求」）。 */
  isUnloaded(): boolean {
    return this.unloaded;
  }

  unload(): void {
    this.unloaded = true;
    for (const controller of this.inFlight) {
      try {
        controller.abort();
      } catch {
        /* 中止失败不影响“不再提交”的事实 */
      }
    }
  }

  /** 记录有新输入（用户刚写了内容）。 */
  noticeInput(at?: number): void {
    this.lastInputAt = at ?? this.now();
  }

  /**
   * 调度判定：现在该不该跑某个触发器。
   *
   * 只做判定，不执行——界面用同一次判定解释「为什么这时跑了 / 为什么没跑」。
   */
  decide(): Array<{ kind: JobKind; trigger: JobRecord['trigger']; reason: string; allowed: boolean }> {
    const now = this.now();
    const triggers: TriggerConfig = {
      idleMinutes: this.config.idleMinutes,
      dailyHours: this.config.dailyHours,
      weeklyHours: this.config.weeklyHours,
    };
    const out: Array<{ kind: JobKind; trigger: JobRecord['trigger']; reason: string; allowed: boolean }> = [];
    const lastInput = this.lastInputAt === 0 ? now : this.lastInputAt;
    /**
     * 每日 / 每周是**维护检查点**：即使没有新证据也必须真实执行并收敛到终态
     * （重建索引、核对账本、报告未知付费作业）。它们不是「提取」，
     * 因此不能被 `hasNewEvidence` 挡掉——挡掉就等于这次维护从未发生。
     */
    const hasNew = this.hasPendingWork();
    for (const [trigger, hours] of [
      ['weekly', triggers.weeklyHours],
      ['daily', triggers.dailyHours],
    ] as const) {
      if (hours <= 0) continue;
      const last = this.queue.lastRunAt(trigger);
      if (now - last >= hours * 3_600_000) {
        out.push({
          kind: trigger === 'weekly' ? 'periodic_weekly' : 'periodic_daily',
          trigger,
          reason: this.lastInputAt === 0
            ? `${trigger === 'weekly' ? '每周' : '每日'}维护检查点已到期（退出期间到期的任务在本次启动合并处理）。`
            : `${trigger === 'weekly' ? '每周' : '每日'}维护检查点已到期。`,
          allowed: true,
        });
      }
    }
    const decision = decideTrigger({
      now,
      lastActivityAt: lastInput,
      hasNewEvidence: hasNew,
      config: triggers,
      lastRun: {
        idle: this.queue.lastRunAt('idle'),
        daily: this.queue.lastRunAt('daily'),
        weekly: this.queue.lastRunAt('weekly'),
      },
      /**
       * 「应用没开着的时候到期的任务」在下一次启动合并处理。
       * 这里如实报告，因为它意味着结果比预期晚。
       */
      missedWhileClosed: this.lastInputAt === 0,
    });
    if (decision.run) {
      const kind: JobKind =
        decision.trigger === 'weekly'
          ? 'periodic_weekly'
          : decision.trigger === 'daily'
            ? 'periodic_daily'
            : 'extract_session';
      // 同一触发器已经在上面的维护检查点里排过就不再重复。
      if (!out.some(item => item.trigger === decision.trigger)) {
        out.push({ kind, trigger: decision.trigger, reason: decision.reason, allowed: true });
      }
    }
    if (out.length === 0) {
      return [{ kind: 'extract_session', trigger: 'idle', reason: decision.reason, allowed: false }];
    }
    return out;
  }

  /**
   * 是否存在需要处理的新证据。
   *
   * 指纹只看**与提取有关的内容**（每条记忆的 id + revision + 来源），
   * 因此「用户改了设置」或「插件重启」都不会伪造出“有新证据”。
   */
  hasPendingWork(): boolean {
    return this.inputFingerprint() !== this.queue.cursor('extract');
  }

  /** 当前输入指纹（与游标同构，便于比较）。 */
  inputFingerprint(): string {
    const records = this.store.all();
    const parts = records
      .filter(record => record.meta.status !== 'archived')
      .map(record => `${record.meta.id}@${record.meta.revision}:${record.meta.source_kind}`)
      .sort();
    // 长度 + 内容一起进指纹：只有长度会漏掉「换了一条」的情况。
    return `${parts.length}#${parts.join('|')}`;
  }

  /** 创建（并持久化）一个作业，不执行。 */
  async enqueue(input: {
    kind: JobKind;
    scope: string;
    trigger: JobRecord['trigger'];
    cursorFrom?: string;
    cursorTo?: string;
  }): Promise<JobRecord> {
    const job = createId('job', Math.random);
    const record: JobRecord = {
      id: job,
      kind: input.kind,
      status: 'queued',
      scope: input.scope,
      cursorFrom: input.cursorFrom ?? this.queue.cursor(input.scope),
      cursorTo: input.cursorTo ?? this.inputFingerprint(),
      inputHash: this.inputFingerprint(),
      attempts: 0,
      maxAttempts: 2,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      startedAt: '',
      finishedAt: '',
      billableRequestSent: false,
      items: [],
      error: '',
      trigger: input.trigger,
      targets: [],
    };
    this.queue.add(record);
    await this.save();
    return record;
  }

  /**
   * 执行一个作业。
   *
   * `work` 由调用方注入（它才知道要读哪些内容、给模型什么提示），
   * 运行器负责其余全部判定：预算、输入指纹、暂停/取消、迟到拒绝、
   * 提交前逐项核对、以及落盘。
   */
  async run(
    jobId: string,
    work: (context: {
      job: JobRecord;
      signal: { aborted: boolean };
      /** 逐项核对（范围 / allow_model / confirmed / 有效期）。 */
      validate: (record: MemoryRecord) => { allowed: boolean; reason: string };
      /** 预算里还剩多少次调用。 */
      remainingCalls: number;
      /** 本次已经预占的 token（保守估算），供 work 生成有界请求。 */
      tokensReserved: number;
      now: number;
      /**
       * 登记的**模型真实用量**。
       *
       * work 回调在拿到供应商响应后必须调用它（有 usage 就传，没有就不传）。
       * 不登记也不会漏账：闸门预占的保守估算会被保留并在界面上标注为估算，
       * 但真实用量能报就报，否则用户看到的 token 数永远是估的。
       */
      reportUsage: (usage: { promptTokens?: number; completionTokens?: number } | undefined) => void;
    }) => Promise<JobWorkResult>,
    /**
     * 本次作业**实际会发出去的文本**（可选，但真实入口必须给）。
     *
     * 闸门要用它做保守的 token 预占。不给的话只能拿输入指纹凑数——
     * 那不是估算，那是猜：预占会远小于真实请求，token 上限就形同没有。
     */
    promptPreview?: () => string,
  ): Promise<JobRunResult> {
    const now = this.now();
    const job = this.queue.get(jobId);
    if (!job) {
      return { jobId, status: 'refused', message: `未找到作业 ${jobId}。`, items: [] };
    }
    if (this.unloaded) {
      return { jobId, status: 'refused', message: '插件已卸载/切库，作业不再执行。', items: [] };
    }
    if (this.running !== null) {
      return { jobId, status: 'refused', message: `已有作业 ${this.running} 在运行，本产品不并发跑模型。`, items: [] };
    }
    const start = this.queue.start(jobId, now);
    if (!start.ok) {
      return { jobId, status: 'refused', message: start.reason, items: [] };
    }

    const fingerprint = this.inputFingerprint();
    const cached = this.store.all().length;
    /**
     * 规则 1：没有新证据不调模型。
     * 这里返回 `skipped` 而不是 `completed`：跳过不是完成，界面上必须能区分。
     */
    if (jobNeedsNewEvidence(job.kind) && fingerprint === this.queue.cursor(job.scope)) {
      this.queue.finish(jobId, { status: 'completed', items: [], cursorTo: fingerprint }, now);
      job.error = `输入自上次处理以来没有变化（${cached} 条记忆），未调用模型、未产生费用。`;
      await this.save();
      return { jobId, status: 'skipped', message: job.error, items: [] };
    }
    /**
     * **先过统一闸门、先落盘记账，再发请求。**
     *
     * 闸门本身（日界刷新 + 次数/token 上限 + 预占落盘）在 `beginModelCall()` 里，
     * 与插件问答走的是同一份代码——两条真实入口不能各记各的账。
     *
     * 审计复现（修复前）：请求已经真的发出去了，`jobs.json` 里仍是 `queued`
     * 且 `billableRequestSent: false`——模拟重启后作业又被当成“从没跑过”，
     * 于是「付费未知」这件事在恢复时消失，还可能被重放。因此
     * `billableRequestSent` 仍然在**发请求之前**写进作业记录。
     */
    const localOnly = job.kind === 'periodic_daily' || job.kind === 'periodic_weekly' || job.kind === 'index_rebuild';
    if (!localOnly) this.queue.markBillable(jobId);
    let promptText = this.inputFingerprint() || job.kind;
    if (promptPreview !== undefined) {
      try {
        promptText = promptPreview();
      } catch {
        /* 预览失败不改变闸门的存在：退回指纹估算，照样是有界的。 */
      }
    }
    const gate = localOnly
      ? { ok: true as const, reservedTokens: 0, reservationId: '' }
      : await this.beginModelCall({
      purpose: `作业「${job.kind}」`,
      promptText,
      /**
       * 作业侧不知道具体请求体（由 work 回调自己组装），因此输出部分用配置里的
       * 单次上限做保守预留；真实用量回来后再对账。
       */
      maxOutputTokens: Math.max(1, Number(this.config.maxTokensPerRun ?? 2000)),
    });
    if (!gate.ok) {
      this.queue.finish(jobId, { status: 'failed', items: [], error: gate.reason }, this.now());
      await this.save();
      return { jobId, status: 'refused', message: gate.reason, items: [] };
    }
    const reservedTokens = gate.reservedTokens;
    const budgetLeft = this.remainingCalls();

    /** 本次 work 登记的模型真实用量（没有就是 undefined → 记账按保守估算）。 */
    let reportedUsage: { promptTokens?: number; completionTokens?: number } | undefined;

    const controller = new AbortController();
    this.inFlight.add(controller);
    this.running = jobId;
    const attempt = job.attempts;
    /**
     * 作业级超时：到点就发出中止信号。**停止等待不等于远端停止计费**，
     * 因此结果里一律保留「请求已发出、计费未知」的事实。
     */
    const timer =
      this.config.timeoutMs > 0
        ? setTimeout(() => {
            try {
              controller.abort();
            } catch {
              /* 中止失败不改变“本端已停止等待”的事实 */
            }
          }, this.config.timeoutMs)
        : null;
    try {
      const result = await work({
        job,
        signal: controller.signal,
        validate: record => this.validateTarget(record),
        remainingCalls: budgetLeft,
        tokensReserved: reservedTokens,
        now,
        reportUsage: usage => {
          if (usage !== undefined) reportedUsage = usage;
        },
      });
      if (timer !== null) clearTimeout(timer);
      /**
       * 迟到 / 暂停 / 取消 / 代次不匹配的判定统一走核心的 `mayCommit`。
       * 只要它说不允许，就地拒绝，**不写入任何东西**。
       */
      const commitGate = mayCommit(job, {
        instanceId: this.instanceId,
        currentInstanceId: this.instanceId,
        capturedAt: now,
        now: this.now(),
        maxAgeMs: this.config.maxResultAgeMs,
        queuePaused: this.queue.queuePaused(),
        attempt,
      });
      if (!commitGate.allowed || this.unloaded) {
        /**
         * 迟到/暂停/卸载被拒：请求**已经发出去了**，因此预占不能退——
         * 退了就等于宣称这笔钱没花。保留预占并如实记为估算。
         */
        job.status = this.queue.queuePaused() ? 'paused' : job.status;
        job.error = commitGate.allowed ? '插件已卸载，结果被拒绝。' : commitGate.reason;
        if (!localOnly) await this.settleModelCall({
          reservedTokens,
          reservationId: gate.reservationId,
          usage: result.usage,
        });
        await this.save();
        return { jobId, status: 'refused', message: job.error, items: [] };
      }

      const items: JobItemResult[] = [];
      /**
       * 用量对账（调用次数与预占在发出前已经落盘）：
       * - 供应商报了 usage：换成实测值；
       * - 没报：保留保守估算（**不是**实测，也不是 0 费用）；
       * - 模型根本没被调用：退回预占——预占是为了崩溃后能对账，
       *   不是为了多算用户的钱。
       */
      if (localOnly && result.modelUsed) throw new Error('本地维护不能提交模型结果。');
      if (!localOnly && result.modelUsed) {
        // work 登记的用法优先；`result.usage` 是它同时回传的副本。
        this.lastSettlement = await this.settleModelCall({
          reservedTokens,
          reservationId: gate.reservationId,
          usage: reportedUsage ?? result.usage,
        });
      } else if (!localOnly) {
        await this.releaseReservation(reservedTokens, gate.reservationId);
        this.lastSettlement = { accounted: 'refunded', tokens: 0 };
      }

      const observedAt = new Date(now).toISOString();
      for (const candidate of result.candidates ?? []) {
        const created = await this.store.propose({
          body: candidate.body,
          title: candidate.title,
          kind: candidate.kind as Parameters<MemoryStore['propose']>[0]['kind'],
          tags: candidate.tags,
          sources: candidate.evidence.map(text => ({
            kind: 'note' as const,
            ref: `ai:${job.id}`,
            excerpt: text,
            observed_at: observedAt,
          })),
          sourceKind: 'ai_extraction',
          sourceRef: `job:${job.id}`,
        });
        items.push({
          ref: `cand_${items.length}`,
          ok: created.ok,
          action: created.ok ? 'created' : 'failed',
          message: created.ok ? `候选已建立（仍是待确认）：${created.message}` : `候选未建立：${created.message}`,
          ...(created.ok ? { produced: created.id } : {}),
        });
      }
      for (const patch of result.patches ?? []) {
        const proposed = await this.store.proposePatch({
          targetId: patch.targetId,
          fields: patch.fields as Parameters<MemoryStore['proposePatch']>[0]['fields'],
          author: `ai:${job.kind}`,
          reason: patch.reason,
        });
        items.push({
          ref: `patch_${items.length}`,
          ok: proposed.ok,
          action: proposed.ok ? 'created' : 'blocked',
          message: proposed.ok ? `已记录待审补丁：${proposed.message}` : `待审补丁未记录：${proposed.message}`,
          ...(proposed.ok ? { produced: proposed.id } : {}),
        });
      }
      if (items.length === 0) {
        items.push({ ref: 'summary', ok: result.ok, action: 'skipped', message: result.message });
      }
      const status = classifyOutcome(items);
      this.queue.finish(jobId, { status, items, cursorTo: fingerprint }, this.now());
      this.cursorAdvance(job.scope, fingerprint);
      job.error = result.message;
      if (!localOnly) this.lastInputAt = 0;
      await this.save();
      return { jobId, status, message: result.message, items };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.queue.finish(jobId, { status: 'failed', items: [], error: message }, this.now());
      await this.save();
      return { jobId, status: 'failed', message, items: [] };
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.running = null;
      this.inFlight.delete(controller);
    }
  }

  private cursorAdvance(scope: string, value: string): void {
    this.queue.setCursor(scope, value);
  }

  /** 逐项核对一条记忆现在是否仍然允许参与这次作业。 */
  private validateTarget(record: MemoryRecord): { allowed: boolean; reason: string } {
    if (!this.store.isOperational) {
      return { allowed: false, reason: `存储当前不可操作：${this.store.operationalBlockReason}` };
    }
    if (record.invalid === true) {
      return { allowed: false, reason: '记录的元数据无法解释（invalid），不参与。' };
    }
    if (record.meta.allow_model !== true) {
      return { allowed: false, reason: '该记录设置为不发送给模型（allow_model=false）。' };
    }
    if (record.meta.status !== 'confirmed') {
      return { allowed: false, reason: `状态为 ${record.meta.status}，只有已确认事实参与。` };
    }
    const until = Date.parse(record.meta.valid_until);
    if (Number.isFinite(until) && until <= this.now()) {
      return { allowed: false, reason: `已过有效期（${record.meta.valid_until}）。` };
    }
    const from = Date.parse(record.meta.valid_from);
    if (Number.isFinite(from) && from > this.now()) {
      return { allowed: false, reason: `尚未生效（${record.meta.valid_from}）。` };
    }
    return { allowed: true, reason: '允许。' };
  }

  /** 今日还能调用几次（0 表示不限制时给一个够大的数）。 */
  remainingCalls(): number {
    const perRun = Math.max(1, this.config.maxCallsPerRun);
    if (this.config.maxCallsPerDay <= 0) return perRun;
    this.queue.refreshBudgetDay(this.now());
    return Math.max(0, Math.min(perRun, this.config.maxCallsPerDay - this.queue.budget.calls));
  }

  /** 今日还剩多少 token 额度；`maxTokensPerDay <= 0` 表示不限制（返回 Infinity）。 */
  remainingTokens(): number {
    this.queue.refreshBudgetDay(this.now());
    if (this.config.maxTokensPerDay <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.config.maxTokensPerDay - this.queue.budget.tokens);
  }

  /**
   * **所有模型调用的统一闸门。**
   *
   * 修复前的漏洞：闸门只长在 `run()` 里，于是真实入口分成了两半——
   * 作业走预算，而插件里的问答（`askWithSources`）自己 `createProvider()`
   * 直接发请求，既不计数也不受上限约束。设置页却写着「达到上限后新的模型调用
   * 会被拒绝」，两者对不上。现在两条真实路径都必须先过这里。
   *
   * 规则（与作业路径完全一致）：
   * 1. 先按日界刷新（跨天恢复额度），再判断——顺序反了就会出现
   *    「昨天用尽、今天仍被拒」的死结；
   * 2. 次数上限与 token 上限都要看；
   * 3. **预占先落盘，写不进去就不调用模型**：宁可不回答，也不留下
   *    无法对账的付费请求；
   * 4. token 预占用的是保守估算（见 `estimateModelCallTokens`），
   *    真实用量回来之后由 `settleModelCall` 对账。
   *
   * 返回 `ok:false` 时调用方**不得**发出任何请求，并应把 `reason` 原样展示给用户。
   */
  async beginModelCall(input: {
    /** 用途，进日志与界面文案（例如「问答」「会话提取」）。 */
    purpose: string;
    /** 实际要发出去的文本，用来做保守估算。 */
    promptText: string;
    /** 请求里声明的最大输出 token。 */
    maxOutputTokens: number;
    /** 消息条数（估算固定开销用）。 */
    messages?: number;
  }): Promise<
    | {
        ok: true;
        reservedTokens: number;
        /** 预占 id：结算时靠它核对「这笔预占属于哪一天」。 */
        reservationId: string;
        /** 预占所在的 UTC 记账日。 */
        day: string;
        remainingCalls: number;
        remainingTokens: number;
      }
    | { ok: false; reason: string; refused: 'budget_calls' | 'budget_tokens' | 'persistence' }
  > {
    const now = this.now();
    // 1) 日界刷新（跨天恢复额度），翻页了就落盘。
    const rolled = this.queue.refreshBudgetDay(now);
    if (rolled) await this.save();

    // 2) 次数上限。
    if (this.config.maxCallsPerDay > 0 && this.queue.budget.calls >= this.config.maxCallsPerDay) {
      const reason =
        `今天（UTC ${this.queue.budget.day}）的模型调用已达上限：` +
        `${this.queue.budget.calls}/${this.config.maxCallsPerDay} 次。` +
        `${input.purpose}没有发送，也没有产生费用；可在设置里调整上限，或等下一个 UTC 日。`;
      return { ok: false, reason, refused: 'budget_calls' };
    }

    // 3) token 上限（用保守估算预占）。
    const reservedTokens = estimateModelCallTokens({
      promptText: input.promptText,
      maxOutputTokens: input.maxOutputTokens,
      messages: input.messages,
    });
    if (this.config.maxTokensPerDay > 0) {
      const left = Math.max(0, this.config.maxTokensPerDay - this.queue.budget.tokens);
      if (reservedTokens > left) {
        const reason =
          `本次${input.purpose}保守估算需要约 ${reservedTokens} token，` +
          `但今天（UTC ${this.queue.budget.day}）只剩 ${left}（上限 ${this.config.maxTokensPerDay}）。` +
          '为避免超支，本次没有发送任何请求，也没有产生费用；' +
          '可调高上限、缩短输入，或等下一个 UTC 日。';
        return { ok: false, reason, refused: 'budget_tokens' };
      }
    }

    // 4) 预占并落盘：写不进去就不调用模型。
    this.queue.recordCall(reservedTokens, now);
    /**
     * 预占在账本里登记一次，记下它属于哪一天。
     * 结算发生在跨日之后时（迟到结果、重启恢复），
     * 账本会告诉我们对账该不该动今天的账。
     */
    const reservation = this.queue.openReservation(reservedTokens, now);
    const persisted = await this.save();
    if (!persisted) {
      this.queue.refund(1, reservedTokens);
      this.queue.closeReservation(reservation.id);
      return {
        ok: false,
        reason:
          `调用前的预算预占没有持久化成功（${this.persistenceError}），` +
          `为避免无法对账的付费请求，本次${input.purpose}没有发送。`,
        refused: 'persistence',
      };
    }
    this.openReservationId = reservation.id;
    return {
      ok: true,
      reservedTokens,
      reservationId: reservation.id,
      day: reservation.day,
      remainingCalls: Math.max(0, this.config.maxCallsPerDay - this.queue.budget.calls),
      remainingTokens: this.config.maxTokensPerDay > 0
        ? Math.max(0, this.config.maxTokensPerDay - this.queue.budget.tokens)
        : Number.POSITIVE_INFINITY,
    };
  }

  /**
   * 用量回来之后对账。
   *
   * - 供应商报了 usage：把预占的估算**换成**真实值（多退少补）；
   *   真实值比估算大也照实记——账不能因为超了估算就美化。
   * - 供应商没报 usage（中断、超时、非标准实现）：**保留**预占的保守估算。
   *   这不是实测 token，也不是 0 费用，界面必须按「估算」展示。
   *
   * 返回值说明这次记账用的是哪一种，供调用方如实展示。
   */
  /**
   * 用量回来之后对账。
   *
   * - 供应商报了 usage：把预占的估算**换成**真实值（多退少补）；
   *   真实值比估算大也照实记——账不能因为超了估算就美化。
   * - 供应商没报 usage（中断、超时、非标准实现）：**保留**预占的保守估算。
   *   这不是实测 token，也不是 0 费用，界面必须按「估算」展示。
   *
   * **必须带 `reservationId`**（`beginModelCall` 的返回值里就有）。
   * 带上它才能核对「这笔预占属于哪一天」：昨日预占的迟到结果
   * 绝不能去冲减今天的账。
   *
   * 不带、或者带了一个账本里没有的 id 时**不做任何记账调整**，
   * 返回 `refused: 'unmatched_reservation'` 并保留预占与消耗——
   * 宁可让账偏保守，也不能去动别的请求的预占。
   */
  async settleModelCall(input: {
    reservedTokens: number;
    /** 预占 id（来自 `beginModelCall`）。缺少它就无法安全对账。 */
    reservationId?: string;
    usage?: { promptTokens?: number; completionTokens?: number } | undefined;
  }): Promise<{
    accounted: 'measured' | 'estimated' | 'refused';
    tokens: number;
    /** 这次结算属于别的记账日（迟到结果），因此没有改动今天的账。 */
    staleDay?: boolean;
    /** 拒绝记账的原因（只有 `accounted: 'refused'` 时才有）。 */
    reason?: string;
    refused?: 'unmatched_reservation';
  }> {
    const measured =
      input.usage === undefined
        ? null
        : (input.usage.promptTokens ?? 0) + (input.usage.completionTokens ?? 0);
    const now = this.now();
    const reservationId = input.reservationId;

    /**
     * 没有预占 id：**不下账**。
     *
     * 不能靠「估算值相同」去猜是哪一笔——并发或乱序返回时，
     * 同一天里两笔估算相同的请求完全可能，猜错就是动了别人的预占。
     */
    if (reservationId === undefined || this.queue.reservationDay(reservationId) === null) {
      return {
        accounted: 'refused',
        tokens: input.reservedTokens,
        refused: 'unmatched_reservation',
        reason:
          '缺少可核对的预占 id（或该预占已不在账本里），本次没有做任何记账调整；' +
          '预占与已消耗的调用次数保持不变，避免误动其他请求的额度。',
      };
    }

    /**
     * 没有真实用量（供应商没报、或超时中断）：**保留预占**，如实标成估算。
     * 这一步必须在任何账本调整**之前**——否则「没报用量」会被执行成
     * 「把预占改成 0」，看起来像是这次调用没花钱。
     */
    if (measured === null || !Number.isFinite(measured) || measured <= 0) {
      const day = this.queue.reservationDay(reservationId);
      /**
       * 跨日迟到且没有实测用量：这笔预占属于昨天，**只关掉账本条目**，
       * 今天那笔还没结算的预占原样保留。
       */
      if (day !== null && day !== this.queue.budget.day) {
        this.queue.closeReservation(reservationId);
        await this.save();
        return { accounted: 'estimated', tokens: input.reservedTokens, staleDay: true };
      }
      return { accounted: 'estimated', tokens: input.reservedTokens };
    }

    /**
     * 跨日迟到：这笔预占不在今天的账上，**一个 token 都不许动**。
     *
     * 审计复现实例：昨日预占 1241、今日另预占 1241；
     * 昨日的迟到 usage 10 结算后把今日的 `tokens` 写成了 10，
     * 把今天那笔还没结算的预占整个冲掉，于是今天可以超额调用。
     */
    if (!this.queue.settleAgainstReservation(reservationId, measured, now)) {
      await this.save();
      return { accounted: 'measured', tokens: input.reservedTokens, staleDay: true };
    }
    await this.save();
    return { accounted: 'measured', tokens: Math.round(measured) };
  }

  /** 模型最终没被调用（例如输入侧就被拒绝）：退回预占。 */
  async releaseReservation(tokens = 0, reservationId?: string): Promise<void> {
    const target = reservationId ?? this.openReservationId ?? undefined;
    if (target !== undefined) {
      this.queue.closeReservation(target);
      if (this.openReservationId === target) this.openReservationId = null;
    }
    this.queue.refund(1, tokens);
    await this.save();
  }

  /**
   * 最近一次模型调用的记账方式（实测 / 保守估算）。
   *
   * 设置页与工作台据此如实展示，不能把估算当实测。
   */
  lastSettlementReport(): {
    accounted: 'measured' | 'estimated' | 'refunded' | 'refused';
    tokens: number;
    staleDay?: boolean;
    reason?: string;
  } | null {
    return this.lastSettlement === null ? null : { ...this.lastSettlement };
  }

  /** 界面用的汇总（不含任何正文）。 */
  overview(): {
    paused: boolean;
    running: string | null;
    open: ReturnType<JobQueue['openProblems']>;
    budget: BudgetUsage;
    limits: { maxCallsPerDay: number; maxTokensPerDay: number };
    pendingWork: boolean;
    nextTrigger: { kind: JobKind; trigger: string; reason: string; allowed: boolean } | null;
  } {
    const decision = this.decide()[0] ?? null;
    return {
      paused: this.queue.queuePaused(),
      running: this.running,
      open: this.queue.openProblems(),
      budget: this.budgetSnapshot(),
      limits: { maxCallsPerDay: this.config.maxCallsPerDay, maxTokensPerDay: this.config.maxTokensPerDay },
      pendingWork: this.hasPendingWork(),
      nextTrigger: decision,
    };
  }
}

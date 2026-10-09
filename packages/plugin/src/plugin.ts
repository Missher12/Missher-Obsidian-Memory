/**
 * 插件入口。
 *
 * 职责边界：
 * - **权威 Markdown 写入者**：所有提交都经由 `MemoryService` → 核心 → `Vault.process`；
 * - 外部请求队列的处理者：CLI/MCP 只排队，本插件开机、定时与手动触发处理；
 * - 界面：工作台视图、命令、设置页。
 *
 * 刻意不做的事：
 * - 不启动第二个文件系统写入通道（不使用任意 `fs`）；
 * - 不在没有用户明确动作时改写权威正文；
 * - 不在缺少模型配置时假装 AI 可用。
 */

import { Notice, Plugin, TFile, type TAbstractFile, type WorkspaceLeaf } from 'obsidian';
import {
  DEFAULT_ROOT,
  assertSafeRoot,
  mergeSettings,
  defaultSettings,
  readTitle,
  runAiReview,
  runLocalReview,
  type MemoryRecord,
  type JobRecord,
  type PluginSettings,
  type ReviewSuggestion,
  type ScopeFilter,
} from '@mom/core';

/** 一次问答实际发送了哪些来源、挡下了哪些、为什么。 */
export interface SendScopeReport {
  asked: number;
  allowed: number;
  blocked: Array<{ id: string; reason: string }>;
  defaultScope: ScopeFilter;
}
import { MemoryService } from './memory-service.js';
import { IndexRefreshMonitor } from './index-refresh.js';
import { WorkbenchView, VIEW_TYPE_WORKBENCH, activateWorkbench } from './view-workbench.js';
import { QuickCaptureModal, RecordDetailModal, SearchModal, SuggestionModal } from './modals.js';
import { MemorySettingTab } from './settings-tab.js';
import { acceptSuggestion, ignoreSuggestion } from './review-actions.js';
import { confirmReload } from './modals.js';
import { buildMethodCandidateDraft, renderMethodCandidateFile } from './mse-candidate.js';
import {
  REVIEW_STATE_FILE,
  emptyReviewState,
  filterHandled,
  parseReviewState,
  recordDecision,
  serializeReviewState,
  type ReviewStateFile,
} from './review-state.js';

/** 队列自动处理间隔（毫秒）。外部请求即使 Obsidian 刚打开也会被及时处理。 */
const QUEUE_POLL_MS = 15_000;

export default class MissherMemoryPlugin extends Plugin {
  service!: MemoryService;
  /** 记忆插件自己的设置；刻意不叫 `settings`（Obsidian 基类占用了那个名字）。 */
  private momSettings!: PluginSettings;
  private settingsWarnings: string[] = [];
  private queueTimer: number | null = null;
  private jobTimer: number | null = null;
  /**
   * 复盘建议的用户处理状态（接受 / 忽略）。
   *
   * 持久化在 `<记忆根>/.memory/review-state.json`，按「问题身份 + 版本」索引：
   * 重启后不会重复弹同一条已经处理过的建议，不同的问题也不会被互相掩盖。
   */
  private reviewState: ReviewStateFile = emptyReviewState(Date.now());
  private reviewStateUnreadable = '';
  /**
   * 建议在**展示那一刻**捕获的每一条受影响记忆的哈希。
   *
   * 用户点「接受」时用的是这里的值，而不是接受瞬间重新读一遍：
   * 中途有人工编辑就冲突，而不是把用户没看过的版本写下去。
   */
  /**
   * 展示那一刻捕获的记忆哈希，键是**具体那条建议**（而不是记忆 id）。
   *
   * 审计复现（修复前是一个全局 `Map<记忆id, 哈希>`）：
   * 展示旧建议 A → 人工编辑了 A 涉及的记忆 → 工作台刷新 `allSuggestions()`，
   * 同一条记忆的**新**哈希把 A 展示时的哈希覆盖掉 →
   * 此时点击 A 的「接受」，用的是刷新后的新哈希，前置条件当然通过，
   * 于是写回旧建议的内容，把人工编辑覆盖掉（revision 涨到 3）。
   *
   * 键改成建议实例之后，每条建议只认自己展示时的哈希；
   * 记忆在展示之后被改过，接受时前置条件对不上，提交自然被拒。
   */
  private readonly capturedHashes = new Map<string, Map<string, string>>();
  /** 上次活动时间（用户写入或打开工作台），用于闲置触发。 */
  private lastActivityAt = 0;
  private scheduling = false;
  /** 最近一次问答的发送范围报告（含被挡下的条目与原因）。 */
  private lastSendScope: SendScopeReport | null = null;
  /** 最近一次问答的预算闸门结论（null = 还没问过）。 */
  private lastModelGate: { blocked: boolean; reason: string } | null = null;
  /** 最近一次问答的记账方式（实测 / 保守估算）。 */
  /**
   * 最近一次模型调用的记账结论。
   *
   * `refused` 表示**没有记账**：调用方没给出可核对的预占 id，运行器宁可让账
   * 偏保守，也不去动别的请求的预占。界面必须照实说，不能当成估算。
   */
  private lastModelSettlement: {
    accounted: 'measured' | 'estimated' | 'refunded' | 'refused';
    tokens: number;
    staleDay?: boolean;
    reason?: string;
  } | null = null;
  /** 索引跟随刷新：有界合并、跳过自触发、不与提交抢（逻辑在 index-refresh.ts）。 */
  private indexMonitor!: IndexRefreshMonitor;

  override async onload(): Promise<void> {
    const merged = mergeSettings(await this.loadData());
    this.momSettings = merged.settings;
    this.settingsWarnings = merged.warnings;

    this.service = new MemoryService({
      app: this.app,
      memoryRoot: this.momSettings.root || DEFAULT_ROOT,
      instanceId: `plugin_${Math.random().toString(36).slice(2, 10)}`,
      getSettings: () => this.momSettings,
      /**
       * 自己写下去的文件登记在案（含写下的内容哈希）。
       *
       * 之后 Vault 事件会**比对当前内容**再决定跳过还是刷新：
       * 只按时间窗跳过会把「写完 5 秒内的人工编辑」一起吃掉。
       */
      onSelfWrite: (path, content) => this.noteSelfWrite(path, content),
    });
    this.applySettingsToRuntime();

    /**
     * 索引跟随刷新。
     *
     * - `isBusy` 问的是队列：提交进行中就推迟重载，免得把中间态读进内存；
     * - 刷新完成后通知各视图重绘，否则用户看到的还是旧列表。
     */
    this.indexMonitor = new IndexRefreshMonitor({
      memoryRoot: this.service.memoryRoot,
      refresh: async () => {
        await this.service.load(true);
      },
      isBusy: () => this.service.writeQueue.busy(),
      onError: message => new Notice(`记忆库跟随改动刷新失败：${message}`, 8_000),
      onRefreshed: () => {
        this.noticeActivity();
        void this.refreshViews();
      },
    });

    this.registerView(VIEW_TYPE_WORKBENCH, (leaf: WorkspaceLeaf) => new WorkbenchView(leaf, this));
    this.addRibbonIcon('brain', '记忆工作台', () => {
      void activateWorkbench(this.app, this);
    });

    this.registerCommands();
    this.addSettingTab(new MemorySettingTab(this.app, this));

    // 先载入，再处理队列：队列提交依赖索引与删除账本已经就绪。
    try {
      const report = await this.service.load();
      if (report.problems.length > 0) {
        new Notice(
          `记忆库载入完成，但有 ${report.problems.length} 个文件存在问题。请在「记忆工作台 → 检索」查看诊断。`,
        );
      }
    } catch (error) {
      new Notice(`记忆库载入失败：${error instanceof Error ? error.message : String(error)}`);
    }

    // 用户处理状态：读不出来就如实提示，不假装「没有处理记录」。
    try {
      const rawState = await this.service.store.readStateText(REVIEW_STATE_FILE);
      const parsed = parseReviewState(rawState ?? null);
      this.reviewState = parsed.file;
      this.reviewStateUnreadable = parsed.error ?? '';
    } catch (error) {
      this.reviewStateUnreadable = error instanceof Error ? error.message : String(error);
    }

    this.watchVaultChanges();

    this.app.workspace.onLayoutReady(() => {
      void this.drainQueue('启动');
      this.startQueuePolling();
      /**
       * 作业队列恢复 + 补上「应用没开着时错过的区间」。
       *
       * 这里只记录与调度；真正的模型调用发生在调度判定允许之后。
       */
      void this.restoreJobsAndResume();
      this.startJobScheduling();
    });
  }

  /**
   * 恢复作业队列并处理退出期间错过的区间。
   *
   * 关键诚实点：应用关闭时**不会常驻**。退出期间到期的任务在下一次启动
   * 合并处理，界面会如实说明；「已经跑过了」这种说法在没有证据时不许出现。
   */
  async restoreJobsAndResume(): Promise<void> {
    try {
      const restored = await this.service.restoreJobs();
      if (restored.unknown > 0) {
        new Notice(
          `有 ${restored.unknown} 个 AI 作业上次中断时可能已经产生费用，结果未知。` +
            '它们不会自动重放，请在「记忆工作台 → 外部请求/作业」里显式处理。',
          10_000,
        );
      }
      const closed = this.service.jobs.configSnapshot().dailyHours > 0;
      if (restored.touched > 0 && closed) {
        this.service.notify(`已恢复 ${restored.touched} 个作业；退出期间到期的检查点会合并到本次启动处理。`);
      }
    } catch (error) {
      this.service.notify(`作业队列恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 启动作业调度。
   *
   * 每 60 秒只看一次时钟：不调用模型、不读正文，只是判定「该不该跑」。
   * 判定通过时才创建作业并执行——没有新证据的轮次连作业都不会建。
   */
  private startJobScheduling(): void {
    if (this.jobTimer !== null) return;
    this.jobTimer = window.setInterval(() => {
      void this.tickJobs();
    }, 60_000);
    this.registerInterval(this.jobTimer);
  }

  /**
   * 一次调度判定；只有允许时才真正执行。
   *
   * 每个被允许的触发器都会**真的执行**并收敛到终态：
   * 提取走模型、维护走本地检查。绝不出现「排了队、标了时间、然后什么也没做」。
   */
  async tickJobs(): Promise<void> {
    const runner = this.service.jobs;
    if (this.scheduling || !this.momSettings.review.autoReview || runner.jobs.queuePaused() || runner.isUnloaded()) return;
    this.scheduling = true;
    try {
      for (const decision of runner.decide()) {
        if (!this.momSettings.review.autoReview || runner.jobs.queuePaused() || runner.isUnloaded()) break;
        if (!decision.allowed) continue;
        if (decision.trigger !== 'idle' || runner.jobs.cursor('local-review') !== runner.inputFingerprint()) {
          await this.runMaintenanceJob(
            decision.kind === 'periodic_weekly' ? 'periodic_weekly' : 'periodic_daily',
            decision.trigger,
            decision.reason,
          );
        }
        // 本地复盘不要求模型。既有闲置提取仅在模型明确配置后继续。
        if (decision.kind === 'extract_session' && this.momSettings.review.autoReview && !runner.jobs.queuePaused() && !runner.isUnloaded() && this.service.aiConfigured()) {
          const job = await runner.enqueue({ kind: decision.kind, scope: 'extract', trigger: decision.trigger });
          await this.runExtractJob(job.id);
        }
      }
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * 维护作业：**真实执行**本地检查并留下终态结果。
   *
   * 做三件事（都不调用模型、不产生费用）：
   * 1. 重新载入并核对账本与索引（读盘故障会被如实报告，不当作空库）；
   * 2. 报告待确认候选、待审补丁、未知付费作业的数量；
   * 3. 把这次检查的时间记进队列状态，避免同一检查点被反复触发。
   *
   * 它不写任何记忆正文——发现的问题留给用户在工作台处理。
   */
  async runMaintenanceJob(
    kind: 'periodic_daily' | 'periodic_weekly',
    trigger: JobRecord['trigger'],
    reason: string,
  ): Promise<string> {
    const runner = this.service.jobs;
    const job = await runner.enqueue({
      kind,
      scope: trigger === 'idle' ? 'local-review' : kind,
      trigger,
    });
    const outcome = await runner.run(job.id, async () => {
      const problems: string[] = [];
      let fatal = 0;
      try {
        const report = await this.service.load(true);
        fatal = report.problems.filter(problem => problem.issues.some(issue => issue.fatal)).length;
        if (report.problems.length > 0) {
          problems.push(`载入报告 ${report.problems.length} 个问题文件（其中 ${fatal} 个是致命问题）`);
        }
      } catch (error) {
        problems.push(`载入失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const suggestions = problems.length === 0 ? await this.runLocalReview() : [];
      const pending = this.service.store.all().filter(record => record.meta.status === 'pending').length;
      const patches = this.service.store.pendingPatches().length;
      const unknownJobs = runner.jobs.byStatus('unknown').length;
      return {
        ok: problems.length === 0,
        modelUsed: false,
        message:
          `${reason} 本地复盘建议 ${suggestions.length} 条 · 检查结果：待确认候选 ${pending} 条 · 待审补丁 ${patches} 条 · ` +
          `结果未知的付费作业 ${unknownJobs} 个` +
          (problems.length === 0 ? ' · 载入无问题' : ` · ${problems.join('；')}`),
      };
    });
    // 记下检查点时间：这样每日/每周不会在同一天里反复触发。
    runner.jobs.markRun(trigger, Date.now());
    await this.service.persistJobs();
    await this.refreshViews();
    return outcome.message;
  }

  /**
   * 执行一次提取作业。
   *
   * 发送前逐个核对：范围、`allow_model`、已确认状态、有效期、来源失效——
   * 只把通过核对的内容送进模型；提交时再由运行器核对一次
   * （排到队里之后用户可能已经改过设置或改过记忆）。
   */
  async runExtractJob(jobId: string): Promise<string> {
    const provider = this.service.createProvider();
    const settings = this.momSettings;
    const outcome = await this.service.jobs.run(jobId, async context => {
      const eligible = this.service.store
        .all()
        .filter(record => context.validate(record).allowed && this.maySendToModel(record).allowed)
        .filter(record => record.meta.source_kind !== 'ai_extraction');
      if (eligible.length === 0) {
        return { ok: true, message: '没有允许发送给模型的已确认内容，未发送任何请求。', modelUsed: false };
      }
      const maxChars = Math.max(200, settings.review.maxExcerptChars * 8 || 6000);
      const chunks: string[] = [];
      let used = 0;
      for (const record of eligible) {
        const text = `### ${record.meta.id}（rev ${record.meta.revision}）
${record.body}`;
        if (used + text.length > maxChars) break;
        chunks.push(text);
        used += text.length;
      }
      if (chunks.length === 0) {
        return { ok: true, message: '本次允许发送的内容超过预算，未发送任何请求。', modelUsed: false };
      }
      this.service.notify(`正在把 ${chunks.length} 条已确认记忆的正文发送给模型（预算 ${used} 字符）。`);
      const { extractCandidates } = await import('@mom/core');
      const extracted = await extractCandidates({
        text: chunks.join('\n\n'),
        title: '记忆库复核',
        provider,
        maxCandidates: 6,
        maxChars,
        signal: context.signal,
      });
      /**
       * 真实用量登记：闸门预占的是保守估算，供应商报了 usage 就换成实测。
       * 没有 usage 时什么都不登记，闸门会保留估算并在界面标注为「估算」。
       */
      context.reportUsage(extracted.usage);
      if (!extracted.ok) {
        return {
          ok: false,
          message: `提取未完成：${extracted.error ?? '未知原因'}`,
          modelUsed: extracted.modelUsed,
          ...(extracted.usage === undefined ? {} : { usage: extracted.usage }),
        };
      }
      return {
        ok: true,
        message:
          `模型返回 ${extracted.candidates.length} 条候选、拒绝 ${extracted.rejected.length} 条` +
          `${extracted.rejected.length > 0 ? `（${extracted.rejected[0]!.reason}）` : ''}。` +
          '候选中没有任何一条会被自动确认。',
        modelUsed: true,
        ...(extracted.usage === undefined ? {} : { usage: extracted.usage }),
        candidates: extracted.candidates.map(candidate => ({
          title: candidate.title,
          body: candidate.body,
          kind: candidate.kind,
          tags: candidate.tags,
          scope: 'personal',
          evidence: candidate.evidence,
          confidence: candidate.confidence,
        })),
      };
    });
    await this.service.persistJobs();
    if (outcome.status !== 'skipped') new Notice(`AI 提取作业：${outcome.message}`, 8000);
    await this.refreshViews();
    return outcome.message;
  }

  /**
   * 跟随 Vault 变化刷新内存索引。
   *
   * 判定逻辑（是否在根内、是否自己写入、合并窗口、忙则推迟、不重入）都在
   * `IndexRefreshMonitor` 里，这里只负责把 Obsidian 的事件接上去。
   * 拆开的原因是：这些性质必须能被确定性地测试，而不是靠读代码相信。
   */
  private watchVaultChanges(): void {
    const handle = (file: TAbstractFile | null | undefined): void => {
      this.indexMonitor.onVaultEvent(file?.path ?? '');
    };
    this.registerEvent(this.app.vault.on('create', handle));
    this.registerEvent(this.app.vault.on('modify', handle));
    this.registerEvent(this.app.vault.on('delete', handle));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        /**
         * 记忆根被整体改名：那等于换了根，刷新救不了——服务绑定的仍是旧路径。
         * 如实提示并请用户去设置里改，而不是假装一切正常。
         */
        if (oldPath === this.service.memoryRoot || (file?.path ?? '') === this.service.memoryRoot) {
          new Notice(
            `记忆根目录「${oldPath}」被改名。插件仍指向旧路径，请到设置里改成新路径并重载插件。`,
            10_000,
          );
          return;
        }
        // 改名可能涉及新旧两个路径，两个都处理。
        this.indexMonitor.onVaultEvent(oldPath);
        handle(file);
      }),
    );
  }

  /**
   * 记录一次本插件的写入，供 Vault 事件去重。
   *
   * `content` 是这次写下的内容（可选）：有它才能**比对当前内容**判断
   * 「事件是自写造成的还是人工编辑造成的」。缺它时判定退化为刷新。
   */
  noteSelfWrite(path: string, content?: string): void {
    this.indexMonitor.noteSelfWrite(path, content);
    if (path.endsWith('.md') && !path.includes('/.memory/')) this.noticeActivity();
  }

  /** 索引跟随刷新的统计（设置页展示，也用于测试断言）。 */
  indexRefreshStats(): ReturnType<IndexRefreshMonitor['stats']> {
    return this.indexMonitor.stats();
  }

  override onunload(): void {
    // 先停掉待执行的刷新回调，避免它打到已经卸载的插件上。
    this.indexMonitor?.dispose();
    if (this.queueTimer !== null) {
      window.clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    if (this.jobTimer !== null) {
      window.clearInterval(this.jobTimer);
      this.jobTimer = null;
    }
    /**
     * 卸载即拒绝：所有在跑的作业从此不得提交结果。
     * 正在等待的模型响应会被本端中止（不是「远端已停止计费」）。
     */
    this.service.jobs.unload();
    this.capturedHashes.clear();
  }

  /** 当前设置（只读快照）。 */
  currentSettings(): PluginSettings {
    return this.momSettings;
  }

  settingWarnings(): string[] {
    return this.settingsWarnings;
  }

  /**
   * 保存设置并**真的应用**需要立即生效的部分。
   *
   * 预算、超时、触发间隔都要写进作业运行器：设置项如果只被保存、
   * 不被消费，那它就是一个骗人的开关。
   *
   * 同时明确一件事：**记忆根目录不在这里生效**。改根意味着换一个库，
   * 服务是在构造时绑定根目录的，所以必须走 `applyRoot()`（保存 + 重载插件），
   * 不能靠一句「已保存并生效」让人以为已经换了地方。
   */
  async updateSettings(patch: Partial<PluginSettings>, options: { quiet?: boolean } = {}): Promise<void> {
    this.momSettings = { ...this.momSettings, ...patch };
    await this.saveData(this.momSettings);
    this.applySettingsToRuntime();
    if (options.quiet !== true) this.service.notify('设置已保存并生效。');
  }

  /**
   * 切换记忆根目录。
   *
   * 语义边界（写进提示，也写在这里，避免将来被"顺手"改成静默迁移）：
   * - **不搬迁、不删除、不合并**任何旧目录里的文件；旧目录原样留在库里；
   * - 新根先做校验（相对路径、非保留目录）；
   * - 真正生效靠重载插件：服务在构造时绑定根目录与状态目录，
   *   原地换根会让「索引来自旧库、写入落到新库」这种半截状态出现；
   * - 用户取消重载时，设置**不落盘**，本次运行继续用旧根（界面显示的就是它）。
   */
  async applyRoot(nextRoot: string): Promise<{ ok: boolean; message: string; reloading: boolean }> {
    let safe = '';
    try {
      safe = assertSafeRoot(nextRoot);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), reloading: false };
    }
    const active = this.service.memoryRoot;
    if (safe === active) {
      return { ok: true, message: `记忆根目录没有变化，继续使用「${active}」。`, reloading: false };
    }
    if (safe !== nextRoot.trim()) {
      // 规范化之后与用户输入不同：先让用户看到到底会写到哪，再决定。
      this.service.notify(`路径已规范化为「${safe}」，请确认后再次点击「应用」。`);
      return { ok: false, message: `路径会被规范化为「${safe}」。确认后再次点击「应用」。`, reloading: false };
    }
    /**
     * 先落盘、再重载：如果用户拒绝重载，我们要把设置改回去，
     * 否则下次启动会悄悄用新根，而用户以为自己取消了。
     */
    const previous = this.momSettings.root;
    await this.updateSettings({ root: safe }, { quiet: true });
    const confirmed = await confirmReload(
      this.app,
      `记忆根目录将从「${active}」改为「${safe}」。\n\n` +
        '旧目录不会被搬迁或删除，仍留在库里。\n' +
        '换根需要重载插件才能真正生效（否则会出现索引与写入指向不同目录的半截状态）。\n\n' +
        '现在重载插件吗？选择「取消」将放弃这次改动，继续使用原目录。',
    );
    if (!confirmed) {
      await this.updateSettings({ root: previous }, { quiet: true });
      return {
        ok: false,
        message: `已放弃改动，继续使用「${active}」。`,
        reloading: false,
      };
    }
    const reload = (this.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands
      ?.executeCommandById;
    if (typeof reload === 'function') {
      reload.call((this.app as unknown as { commands: unknown }).commands, 'app:reload');
      return { ok: true, message: `正在重载插件以使用「${safe}」…`, reloading: true };
    }
    // 拿不到重载命令时如实说：设置已保存，但要用户自己重启 Obsidian。
    return {
      ok: true,
      message: `设置已保存为「${safe}」，但无法自动重载插件：请手动用「重新加载应用」或重启 Obsidian 使其生效。`,
      reloading: false,
    };
  }

  private applySettingsToRuntime(): void {
    const settings = this.momSettings;
    this.service.jobs.updateConfig({
      maxCallsPerDay: settings.ai.dailyCallBudget,
      maxTokensPerDay: settings.ai.dailyTokenBudget,
      timeoutMs: settings.ai.timeoutMs,
      idleMinutes: settings.review.triggers.idleMinutes,
      dailyHours: settings.review.triggers.dailyHours,
      weeklyHours: settings.review.triggers.weeklyHours,
    });
  }

  /** 重绘所有工作台视图。 */
  async refreshViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)) {
      const view = leaf.view;
      if (view instanceof WorkbenchView) await view.refresh();
    }
  }

  /** 处理一次外部写请求队列。 */
  async drainQueue(trigger: string): Promise<void> {
    try {
      const result = await this.service.drainQueue();
      if (result.processed.length === 0 && result.skipped.length === 0 && result.malformed.length === 0) {
        return;
      }
      for (const receipt of result.processed) {
        const label = receipt.status === 'completed' ? '已提交' : receipt.status === 'conflict' ? '冲突，未提交' : '失败';
        new Notice(`外部请求 ${receipt.requestId}：${label}——${receipt.message}`);
      }
      for (const bad of result.malformed) {
        new Notice(`请求文件无法解析（已保留）：${bad.path}——${bad.errors[0] ?? '未知原因'}`);
      }
      for (const kept of result.retained) {
        new Notice(`回执未能写入，请求已保留以便重试：${kept.requestId}`);
      }
      void trigger;
      await this.refreshViews();
    } catch (error) {
      new Notice(`处理外部请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startQueuePolling(): void {
    if (this.queueTimer !== null) return;
    this.queueTimer = window.setInterval(() => {
      void this.drainQueue('轮询');
    }, QUEUE_POLL_MS);
    this.registerInterval(this.queueTimer);
  }

  /**
   * 本地复盘（不调用模型）。
   *
   * 结果按「问题身份 + 版本」过滤已处理项：换一组完全不同的记忆出现同类
   * 问题时不会被上一组的「忽略」掩盖；同一条问题的记忆版本变了会重新开放。
   */
  async runLocalReview(): Promise<ReviewSuggestion[]> {
    const suggestions = await runLocalReview(this.service.store.all());
    for (const suggestion of suggestions) this.captureHashes(suggestion);
    return filterHandled(suggestions, this.reviewState);
  }

  /** 全部建议（含已处理的），界面用状态标记区分。 */
  async allSuggestions(): Promise<ReviewSuggestion[]> {
    const suggestions = await runLocalReview(this.service.store.all());
    for (const suggestion of suggestions) this.captureHashes(suggestion);
    return suggestions;
  }

  /** 一条建议当前是否已处理（以及处理方式）。 */
  suggestionDecision(suggestion: ReviewSuggestion): 'accepted' | 'ignored' | null {
    const record = this.reviewState.items[suggestion.id];
    if (record === undefined) return null;
    const current = this.capturedHashes.size === 0 ? '' : this.versionIdentity(suggestion);
    // 版本变了就重新开放：旧决定不遮蔽新情况。
    return record.identity === current ? record.decision : null;
  }

  /** 建议实例的键：建议身份 + 受影响记忆的版本，与已处理判定用的是同一个身份。 */
  private suggestionKey(suggestion: ReviewSuggestion): string {
    return this.versionIdentity(suggestion);
  }

  private versionIdentity(suggestion: ReviewSuggestion): string {
    const parts = suggestion.impact.memoryIds
      .map(id => {
        const evidence = suggestion.evidence.find(item => item.detail.includes(id));
        const revision = /rev (\d+)/.exec(evidence?.detail ?? '')?.[1] ?? '?';
        return `${id}@${revision}`;
      })
      .sort();
    return `${suggestion.id}|${parts.join(',')}`;
  }

  /**
   * 展示那一刻捕获受影响记忆的哈希（接受时用它做前置条件）。
   *
   * 只写进**这条建议自己的**那一格：别的建议（哪怕是同一批记忆）刷新时
   * 不会碰到它，因此旧建议永远拿着旧哈希。
   */
  private captureHashes(suggestion: ReviewSuggestion): void {
    const key = this.suggestionKey(suggestion);
    const slot = this.capturedHashes.get(key) ?? new Map<string, string>();
    for (const id of suggestion.impact.memoryIds) {
      const hash = this.service.store.hashOf(id);
      if (typeof hash === 'string' && hash !== '') slot.set(id, hash);
    }
    if (slot.size > 0) this.capturedHashes.set(key, slot);
  }

  async acceptSuggestion(suggestion: ReviewSuggestion): Promise<string> {
    /**
     * **不在这里重新捕获哈希。**
     *
     * 展示那一刻记下的哈希就是用户看到并批准的那一版；如果在点击瞬间重新读一次，
     * 「现查新哈希」会变成通过前置条件的捷径——用户看到旧内容、系统却拿新哈希去写，
     * 结果是覆盖掉别人（或自己）刚刚的人工编辑。
     * 拿不到展示时的哈希就不提交，先让用户重新复盘。
     */
    const slot = this.capturedHashes.get(this.suggestionKey(suggestion));
    const captured = new Map<string, string>();
    for (const id of suggestion.impact.memoryIds) {
      const hash = slot?.get(id);
      if (typeof hash === 'string' && hash !== '') captured.set(id, hash);
    }
    if (captured.size === 0) {
      const message =
        '这条建议缺少展示时捕获的版本哈希（例如插件刚重启，或页面是旧状态）。' +
        '为避免用过期的前置条件写入，本次没有提交任何改动；请刷新工作台后重新审核再接受。';
      new Notice(message, 10_000);
      return message;
    }
    const outcome = await acceptSuggestion(suggestion, {
      store: this.service.store,
      capturedHashOf: id => captured.get(id),
    });
    const note = outcome.needsReReview !== undefined ? ` ${outcome.needsReReview}` : '';
    if (outcome.ok) await this.recordDecision(suggestion, 'accepted', outcome.message);
    new Notice(`${outcome.message}${note}`, 8000);
    await this.refreshViews();
    return `${outcome.message}${note}`;
  }

  async ignoreSuggestion(suggestion: ReviewSuggestion): Promise<string> {
    const outcome = ignoreSuggestion(suggestion);
    await this.recordDecision(suggestion, 'ignored', outcome.message);
    new Notice(outcome.message);
    await this.refreshViews();
    return outcome.message;
  }

  /** 记录处理状态并落盘（写不进去就如实提示，不假装记住）。 */
  private async recordDecision(
    suggestion: ReviewSuggestion,
    decision: 'accepted' | 'ignored',
    note: string,
  ): Promise<void> {
    this.reviewState = recordDecision(this.reviewState, suggestion, decision, note, Date.now());
    try {
      await this.service.store.writeStateText(REVIEW_STATE_FILE, serializeReviewState(this.reviewState, Date.now()));
    } catch (error) {
      this.service.notify(
        `处理状态未能写入 ${REVIEW_STATE_FILE}：${error instanceof Error ? error.message : String(error)}` +
          '（本次运行内仍然生效，重启后会重新出现。）',
      );
    }
  }

  /** 用户处理状态是否可读（不可读时界面要如实说明）。 */
  reviewStateError(): string {
    return this.reviewStateUnreadable;
  }

  /** 语义复盘：调用模型，产出仍然只是建议。 */
  async runAiReviewNow(): Promise<string> {
    if (!this.service.aiConfigured()) {
      return '尚未配置模型接口与模型名（设置 → AI），因此没有发送任何内容。';
    }
    const job = await this.service.jobs.enqueue({
      kind: 'ai_review',
      scope: 'ai_review',
      trigger: 'explicit',
    });
    const provider = this.service.createProvider();
    /**
     * 复盘实际会发出去的片段（闸门据此预占 token）。
     * 与真正发送时用同一套筛选与截断，避免「估算一套、发送另一套」。
     */
    const reviewExcerpts = (): Array<{ id: string; title: string; text: string; revision: number }> => {
      const maxChars = Math.max(200, this.momSettings.review.maxExcerptChars * 8 || 6000);
      const eligible = this.service.store.all().filter(record => this.maySendToModel(record).allowed);
      const excerpts: Array<{ id: string; title: string; text: string; revision: number }> = [];
      let used = 0;
      for (const record of eligible.slice(0, 8)) {
        if (used + record.body.length > maxChars) break;
        excerpts.push({
          id: record.meta.id,
          title: readTitle(record) || record.body.slice(0, 20),
          text: record.body.slice(0, maxChars - used),
          revision: record.meta.revision,
        });
        used += record.body.length;
      }
      return excerpts;
    };
    const outcome = await this.service.jobs.run(job.id, async context => {
      const eligible = this.service.store.all().filter(record => context.validate(record).allowed);
      if (eligible.length === 0) {
        return { ok: true, message: '没有允许发送给模型的已确认内容，未发送任何请求。', modelUsed: false };
      }
      const excerpts = reviewExcerpts();
      const review = await runAiReview({
        provider,
        excerpts,
        memories: eligible.map(record => ({
          id: record.meta.id,
          title: readTitle(record) || record.body.slice(0, 20),
          status: record.meta.status,
          body: record.body.slice(0, 400),
        })),
        signal: context.signal,
        isStillValid: () => !context.signal.aborted && !this.service.jobs.jobs.queuePaused(),
      });
      /**
       * 真实用量登记（含迟到被拒的情况）：请求已经发出去了，
       * 供应商也报了 usage，就必须让持久账按实测记账，而不是留着估算。
       */
      context.reportUsage(review.usage);
      if (review.rejectedLate) {
        return {
          ok: false,
          message: review.error ?? '结果迟到，已拒绝。',
          modelUsed: true,
          ...(review.usage === undefined ? {} : { usage: review.usage }),
        };
      }
      if (!review.ok) {
        return {
          ok: false,
          message: `语义复盘未完成：${review.error ?? '未知原因'}`,
          modelUsed: true,
          ...(review.usage === undefined ? {} : { usage: review.usage }),
        };
      }
      /**
       * 语义复盘想改已确认事实时，一律落成**待审补丁**：
       * 界面上用户能对照当前内容与新内容，接受时用展示时的哈希做前置条件。
       */
      const patches: Array<{ targetId: string; fields: Record<string, unknown>; reason: string }> = [];
      for (const suggestion of review.suggestions) {
        if (suggestion.action.type === 'correct_memory') {
          patches.push({
            targetId: suggestion.action.targetId,
            fields: { body: suggestion.action.replacement },
            reason: `AI 语义复盘建议：${suggestion.title}`,
          });
        }
      }
      return {
        ok: true,
        message:
          `模型给出 ${review.suggestions.length} 条建议；其中 ${patches.length} 条涉及已确认事实，` +
          '已转成待审补丁（不会自动改动正文）。',
        modelUsed: true,
        ...(review.usage === undefined ? {} : { usage: review.usage }),
        patches,
      };
    }, () => reviewExcerpts().map(excerpt => excerpt.text).join('\n'));
    await this.service.persistJobs();
    await this.refreshViews();
    return outcome.message;
  }

  /**
   * 带来源问答（检索页使用）。
   *
   * 关键：**送进模型的每个来源都必须先过许可筛**。
   * 审计复现（修复前）：只传 `records`、不传 `allowIds`，于是检索到
   * `allow_model: false` 的记录时，正文照样被拼进提示词发出去了。
   * 现在先算出一个白名单（范围 + allow_model + 状态 + 有效期 + 已撤回），
   * 只把白名单里的内容交给 `buildContext`；其余条目会被记成“未发送”并展示原因。
   */
  async askWithSources(question: string, scope?: ScopeFilter): Promise<string> {
    /**
     * 真实逻辑全在 `askWithBoundedModel` 里（检索 → 许可筛 → 预算闸门 → 对账）。
     * 这里只做依赖注入，因此测试可以直接驱动同一份实现，
     * 而不是「测试里另写一条路径」。
     */
    const { askWithBoundedModel } = await import('./ask-gate.js');
    const result = await askWithBoundedModel(
      {
        store: this.service.store,
        jobs: this.service.jobs,
        createProvider: () => this.service.createProvider(),
        maySend: record => this.maySendToModel(record),
        maxContextChars: () => Math.max(200, this.momSettings.review.maxExcerptChars * 8 || 6000),
        isUnloaded: () => this.service.jobs.isUnloaded(),
      },
      question,
      scope,
    );
    this.lastSendScope = result.sendScope;
    this.lastModelGate = result.gate;
    this.lastModelSettlement = result.settlement;
    return result.answer;
  }

  /**
   * 模型调用账目（设置页只读展示）。
   *
   * 数据来自**持久状态**，不是内存副本：重启不会把它清零。
   * `accounted` 区分四种真实结论：实测 / 保守估算（供应商没报用量）/
   * 已退回（请求没发出去）/ 拒绝记账（缺少可核对的预占 id）。
   * 界面必须照实说，不能把估算或拒绝记账当成实测值展示。
   */
  modelUsageReport(): {
    day: string;
    calls: number;
    tokens: number;
    measured: boolean;
    /** 最近一次记账的结论；界面据此如实区分实测 / 估算 / 退回 / 拒绝记账。 */
    accounted: 'measured' | 'estimated' | 'refunded' | 'refused' | 'none';
    limits: { maxCallsPerDay: number; maxTokensPerDay: number };
  } {
    const budget = this.service.jobs.budgetSnapshot();
    const limits = this.service.jobs.configSnapshot();
    const settlement = this.lastModelSettlement ?? this.service.jobs.lastSettlementReport();
    return {
      day: budget.day,
      calls: budget.calls,
      tokens: budget.tokens,
      measured: settlement === null ? budget.tokens === 0 : settlement.accounted === 'measured',
      accounted: settlement?.accounted ?? 'none',
      limits: { maxCallsPerDay: limits.maxCallsPerDay, maxTokensPerDay: limits.maxTokensPerDay },
    };
  }

  /**
   * 把一条记忆导出成 MSE 方法候选包（`mse-method-v1`）到记忆根下的 `_exports/`。
   *
   * 说清楚三件事，因为这里最容易被误解：
   * 1. **只本地生成、只本地校验、只本地写文件**；
   * 2. 不连接任何 MSE 实例、不发网络请求、不写 MSE 的学习库；
   * 3. 不改变这条记忆的状态，也不把它变成「已发送」。
   *
   * 落盘用 `Vault.create` 而不是直接写 adapter：这样 Obsidian 会把它
   * 登记进索引、触发事件，用户能在库里直接看到导出了什么；
   * 文件已存在时**换名**而不是覆盖——覆盖会悄悄毁掉上一次的导出。
   */
  async exportMethodCandidateFor(record: MemoryRecord): Promise<{ path: string; ok: boolean; reasons: string[] }> {
    const draft = buildMethodCandidateDraft({ record, now: Date.now() });
    if (!draft.validation.ok) {
      return { path: '', ok: false, reasons: draft.validation.reasons };
    }
    const folder = `${this.service.memoryRoot}/_exports`;
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }
    /**
     * `create` 在文件已存在时会抛错，因此先探测再递增后缀。
     * 不生成时间戳后缀：同一 revision 重复导出应该得到可预测的名字，
     * 让用户能一眼看出「这条记忆导出过几次」。
     */
    let fileName = draft.suggestedName;
    let attempt = 1;
    while (await this.app.vault.adapter.exists(`${folder}/${fileName}`)) {
      attempt += 1;
      fileName = draft.suggestedName.replace(/\.json$/, `-${attempt}.json`);
    }
    const path = `${folder}/${fileName}`;
    await this.app.vault.create(path, renderMethodCandidateFile(draft));
    return { path, ok: true, reasons: [] };
  }

  /** 最近一次问答的预算闸门结论（界面据此说明「这次为什么没发出去」）。 */
  lastModelGateReport(): { blocked: boolean; reason: string } | null {
    return this.lastModelGate === null ? null : { ...this.lastModelGate };
  }

  /** 最近一次问答的记账方式（实测 / 保守估算 / 已退回 / 拒绝记账）。 */
  lastModelSettlementReport(): {
    accounted: 'measured' | 'estimated' | 'refunded' | 'refused';
    tokens: number;
    staleDay?: boolean;
    reason?: string;
  } | null {
    return this.lastModelSettlement === null ? null : { ...this.lastModelSettlement };
  }

  /** 最近一次问答的发送范围（界面展示「哪些没被发送、为什么」）。 */
  lastSendScopeReport(): SendScopeReport | null {
    return this.lastSendScope;
  }

  /**
   * 一条记录现在是否允许进入模型上下文。
   *
   * 五个条件缺一不可：允许发送给模型、已确认、未撤回、在有效期内、
   * 以及存储本身处于可操作状态（读盘故障时不许把任何内容发出去）。
   */
  private maySendToModel(record: MemoryRecord): { allowed: boolean; reason: string } {
    if (!this.service.store.isOperational) {
      return { allowed: false, reason: `存储不可操作：${this.service.store.operationalBlockReason}` };
    }
    if (record.invalid === true) return { allowed: false, reason: '记录元数据无法解释（invalid）。' };
    if (record.meta.allow_model !== true) return { allowed: false, reason: '这条记录设置为不发送给模型（allow_model=false）。' };
    if (record.meta.status !== 'confirmed') return { allowed: false, reason: `状态是 ${record.meta.status}，不是已确认事实。` };
    const until = Date.parse(record.meta.valid_until);
    if (Number.isFinite(until) && until <= Date.now()) {
      return { allowed: false, reason: `已过有效期（${record.meta.valid_until}）。` };
    }
    const from = Date.parse(record.meta.valid_from);
    if (Number.isFinite(from) && from > Date.now()) {
      return { allowed: false, reason: `尚未生效（${record.meta.valid_from}）。` };
    }
    return { allowed: true, reason: '允许发送。' };
  }

  currentReviewState(): ReviewStateFile {
    return this.reviewState;
  }

  /** 供界面/测试使用的作业运行器。 */
  get jobs() {
    return this.service.jobs;
  }

  /** 记录用户活动（写入内容时调用），用于闲置触发判定。 */
  noticeActivity(): void {
    this.lastActivityAt = Date.now();
    this.service.jobs.noticeInput(this.lastActivityAt);
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'mom-quick-capture',
      name: '快速记住…',
      callback: () => new QuickCaptureModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'mom-search',
      name: '搜索记忆…',
      callback: () => new SearchModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'mom-open-workbench',
      name: '打开记忆工作台',
      callback: () => {
        void activateWorkbench(this.app, this);
      },
    });

    this.addCommand({
      id: 'mom-remember-selection',
      name: '记住选中的文字',
      editorCallback: async editor => {
        const selection = editor.getSelection().trim();
        if (selection === '') {
          new Notice('没有选中任何文字。');
          return;
        }
        const result = await this.service.store.remember({
          body: selection,
          sourceKind: 'user_selection',
          sourceRef: this.app.workspace.getActiveFile()?.path ?? 'editor',
        });
        new Notice(result.message);
        await this.refreshViews();
      },
    });

    this.addCommand({
      id: 'mom-remember-clipboard',
      name: '记住剪贴板内容',
      callback: async () => {
        const text = await navigator.clipboard.readText().catch(() => '');
        if (text.trim() === '') {
          new Notice('剪贴板为空或读取被拒绝。');
          return;
        }
        const result = await this.service.store.remember({
          body: text.trim(),
          sourceKind: 'user_explicit',
          sourceRef: 'clipboard',
        });
        new Notice(result.message);
        await this.refreshViews();
      },
    });

    this.addCommand({
      id: 'mom-drain-queue',
      name: '处理外部写请求队列',
      callback: () => {
        void this.drainQueue('手动');
      },
    });

    this.addCommand({
      id: 'mom-rebuild-index',
      name: '重建检索索引',
      callback: async () => {
        this.service.store.rebuildIndex();
        await this.service.load(true);
        new Notice('索引已重建（索引是派生物，随时可重建）。');
        await this.refreshViews();
      },
    });

    this.addCommand({
      id: 'mom-show-record-detail',
      name: '查看当前笔记的记忆详情',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile)) return false;
        if (checking) return true;
        const record = this.service.store
          .all()
          .find(item => item.path === file.path);
        if (record === undefined) {
          new Notice('当前笔记不属于记忆库（或还未载入）。');
          return;
        }
        new RecordDetailModal(this.app, this, record).open();
        return true;
      },
    });

    this.addCommand({
      id: 'mom-export-mse-candidate',
      name: '把当前笔记导出为 MSE 方法候选包（仅本地生成）',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile)) return false;
        const record = this.service.store.all().find(item => item.path === file.path);
        if (record === undefined) return false;
        if (checking) return true;
        void this.exportMethodCandidateFor(record).then(result => {
          new Notice(
            result.ok
              ? `已生成候选包（未发送，未改动记忆）：${result.path}`
              : `候选包本地校验未通过，没有写出文件：${result.reasons.join('；')}`,
          );
        });
        return true;
      },
    });

    this.addCommand({
      id: 'mom-suggestion-detail',
      name: '查看复盘建议详情…',
      callback: async () => {
        const suggestions = await this.runLocalReview();
        if (suggestions.length === 0) {
          new Notice('本地检查没有发现问题。');
          return;
        }
        const first = suggestions[0];
        if (first !== undefined) new SuggestionModal(this.app, this, first).open();
      },
    });
  }
}

/** 供测试与其它模块使用的默认设置导出（避免重复字面量）。 */
export const PLUGIN_DEFAULTS = defaultSettings();

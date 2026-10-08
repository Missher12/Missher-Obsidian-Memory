/**
 * 工作台视图：一个侧栏面板，回答三件事。
 *
 * 1. **现在有哪些记忆**（检索 + 概览），以及**为什么某条没被召回**；
 * 2. **待确认的候选**（AI 提取与复盘建议）——确认/忽略的入口；
 * 3. **外部写请求队列**：CLI/MCP 排进来的请求，处理结果与冲突现场。
 *
 * 界面文字刻意区分「已排队」与「已提交」：队列里的请求在回执出现之前
 * 都只是**请求**，不是已经生效的记忆。
 */

import { ItemView, Notice, WorkspaceLeaf, setIcon, type App } from 'obsidian';
import { patchFieldSummary, readTitle, type PendingPatch, type QueueReceipt, type ReviewSuggestion } from '@mom/core';
import type MissherMemoryPlugin from './plugin.js';
import { QuickCaptureModal } from './modals.js';

export const VIEW_TYPE_WORKBENCH = 'mom-workbench';

type Tab = 'search' | 'pending' | 'queue' | 'review' | 'jobs' | 'patches';

export class WorkbenchView extends ItemView {
  private readonly plugin: MissherMemoryPlugin;
  private tab: Tab = 'search';
  private query = '';
  private status = '';

  constructor(leaf: WorkspaceLeaf, plugin: MissherMemoryPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_WORKBENCH;
  }

  override getDisplayText(): string {
    return '记忆工作台';
  }

  override getIcon(): string {
    return 'brain';
  }

  override async onOpen(): Promise<void> {
    await this.render();
  }

  /** 外部触发重绘（状态变化或队列处理完毕）。 */
  async refresh(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('mom-workbench');

    this.renderHeader(container);
    this.renderTabs(container);
    const body = container.createDiv({ cls: 'mom-body' });
    switch (this.tab) {
      case 'search':
        await this.renderSearch(body);
        break;
      case 'pending':
        await this.renderPending(body);
        break;
      case 'queue':
        await this.renderQueue(body);
        break;
      case 'review':
        await this.renderReview(body);
        break;
      case 'patches':
        await this.renderPatches(body);
        break;
      case 'jobs':
        await this.renderJobs(body);
        break;
    }
    if (this.status !== '') body.createDiv({ cls: 'mom-status', text: this.status });
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: 'mom-header' });
    const title = header.createDiv({ cls: 'mom-title', text: '记忆工作台' });
    title.setAttr('title', `记忆根：${this.plugin.service.memoryRoot}`);
    const actions = header.createDiv({ cls: 'mom-actions' });
    const capture = actions.createEl('button', { text: '快速记住' });
    capture.onclick = () => new QuickCaptureModal(this.app, this.plugin).open();
    const reload = actions.createEl('button', { text: '重新载入' });
    reload.onclick = async () => {
      const report = await this.plugin.service.load(true);
      this.status = `已载入 ${report.valid} 条（扫描 ${report.scanned}，新增 ${report.added}，更新 ${report.updated}，移除 ${report.removed}，问题 ${report.problems.length}）。`;
      await this.refresh();
    };
    const drain = actions.createEl('button', { text: '处理外部请求' });
    drain.onclick = async () => {
      const result = await this.plugin.service.drainQueue();
      this.status =
        `排队处理完成：提交 ${result.processed.length}，跳过 ${result.skipped.length}，` +
        `保留 ${result.retained.length}，格式问题 ${result.malformed.length}。`;
      await this.refresh();
      for (const receipt of result.processed) {
        new Notice(`${receipt.requestId}：${receiptStatusLabel(receipt.status)}——${receipt.message}`);
      }
    };
  }

  private renderTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: 'mom-tabs' });
    const items: Array<{ id: Tab; label: string }> = [
      { id: 'search', label: '检索' },
      { id: 'pending', label: '待确认' },
      { id: 'queue', label: '外部请求' },
      { id: 'review', label: '复盘' },
      { id: 'patches', label: '待审补丁' },
      { id: 'jobs', label: 'AI 作业' },
    ];
    for (const item of items) {
      const button = tabs.createEl('button', { text: item.label, cls: item.id === this.tab ? 'mom-tab active' : 'mom-tab' });
      button.onclick = async () => {
        this.tab = item.id;
        this.status = '';
        await this.refresh();
      };
    }
  }

  private async renderJobs(body: HTMLElement): Promise<void> {
    body.createDiv({ cls: 'mom-section-title', text: 'AI 作业（模型调用与预算）' });
    const runner = this.plugin.jobs;
    const overview = runner.overview();
    const config = runner.configSnapshot();
    body.createDiv({
      cls: 'mom-hint',
      text:
        '模型只在有**新证据**且预算允许时被调用；没有新证据的轮次连作业都不会建。' +
        '应用关闭时不常驻：退出期间到期的检查点会在下次启动合并处理。',
    });
    body.createDiv({
      cls: 'mom-card-meta',
      text:
        `队列状态：${overview.paused ? '已暂停' : '运行中'}` +
        `${overview.running === null ? '' : ` · 正在跑 ${overview.running}`} · ` +
        `今日调用 ${overview.budget.calls}/${overview.limits.maxCallsPerDay} 次 · ` +
        `今日 token ${overview.budget.tokens}/${overview.limits.maxTokensPerDay}`,
    });
    body.createDiv({
      cls: 'mom-card-meta',
      text:
        `待处理：排队 ${overview.open.queued} · 运行 ${overview.open.running} · 部分完成 ${overview.open.partial} · ` +
        `失败 ${overview.open.failed} · 结果未知 ${overview.open.unknown} · 暂停 ${overview.open.paused}`,
    });
    body.createDiv({
      cls: 'mom-card-meta',
      text:
        `有新证据：${overview.pendingWork ? '有' : '没有'} · ` +
        (overview.nextTrigger === null
          ? '下一次触发判定不可用'
          : `下一次触发：${overview.nextTrigger.trigger} —— ${overview.nextTrigger.reason}`),
    });
    const controls = body.createDiv({ cls: 'mom-card-actions' });
    const pause = controls.createEl('button', { text: overview.paused ? '恢复队列' : '暂停队列' });
    pause.onclick = async () => {
      await runner.setPaused(!overview.paused, '用户在界面上暂停了 AI 作业队列。');
      await this.plugin.service.persistJobs();
      new Notice(overview.paused ? '已恢复 AI 作业队列。' : '已暂停 AI 作业队列；此后迟到的模型结果一律拒绝提交。');
      await this.refresh();
    };
    const extract = controls.createEl('button', { text: '立即提取候选' });
    extract.onclick = async () => {
      if (!this.plugin.service.aiConfigured()) {
        new Notice('尚未配置模型接口与模型名（设置 → AI），未发送任何内容。');
        return;
      }
      const job = await runner.enqueue({ kind: 'extract_session', scope: 'extract', trigger: 'manual' });
      new Notice(await this.plugin.runExtractJob(job.id), 8000);
      await this.refresh();
    };
    const review = controls.createEl('button', { text: '立即语义复盘' });
    review.onclick = async () => {
      new Notice(await this.plugin.runAiReviewNow(), 8000);
      await this.refresh();
    };
    const rebuild = controls.createEl('button', { text: '重建索引（不调模型）' });
    rebuild.onclick = async () => {
      this.plugin.service.store.rebuildIndex();
      new Notice('索引已重建（本地操作，未调用模型）。');
      await this.refresh();
    };
    body.createDiv({ cls: 'mom-card-meta', text: `触发配置：闲置 ${config.idleMinutes} 分钟 · 每日 ${config.dailyHours} 小时 · 每周 ${config.weeklyHours} 小时（0 表示关闭）` });

    const jobs = runner.jobs.snapshot.jobs.slice(-15).reverse();
    if (jobs.length === 0) {
      body.createDiv({ cls: 'mom-empty', text: '还没有作业记录。' });
    }
    for (const job of jobs) {
      const card = body.createDiv({ cls: `mom-card mom-job-${job.status}` });
      card.createDiv({ cls: 'mom-card-title', text: `${JOB_TITLE[job.kind] ?? job.kind} · ${job.id}` });
      card.createDiv({
        cls: 'mom-card-meta',
        text:
          `状态 ${job.status} · 触发 ${job.trigger} · 尝试 ${job.attempts}/${job.maxAttempts} · ` +
          `已发出计费请求：${job.billableRequestSent ? '是' : '否'} · 更新 ${job.updatedAt}`,
      });
      if (job.error !== '') card.createDiv({ cls: 'mom-card-snippet', text: job.error });
      for (const item of job.items.slice(-5)) {
        card.createDiv({
          cls: 'mom-card-meta',
          text: `${item.ok ? '✓' : '✗'} ${item.ref}：${item.message}`,
        });
      }
      const actions = card.createDiv({ cls: 'mom-card-actions' });
      if (job.status === 'unknown') {
        card.createDiv({
          cls: 'mom-hint',
          text:
            '这次作业在中断前已经发出付费请求，结果未知：**不会自动重放**。' +
            '请先确认远端是否已经产生费用，再决定下面两个动作。',
        });
        const discard = actions.createEl('button', { text: '放弃这次作业' });
        discard.onclick = async () => {
          const result = await runner.resolveUnknown(job.id, 'discard');
          new Notice(result.reason);
          await this.plugin.service.persistJobs();
          await this.refresh();
        };
        const requeue = actions.createEl('button', { text: '确认重发（会再次计费）' });
        requeue.onclick = async () => {
          const result = await runner.resolveUnknown(job.id, 'requeue');
          new Notice(result.reason);
          await this.plugin.service.persistJobs();
          await this.refresh();
        };
      } else if (job.status === 'queued' || job.status === 'running' || job.status === 'paused') {
        const cancel = actions.createEl('button', { text: '取消作业' });
        cancel.onclick = async () => {
          const result = await runner.cancel(job.id, '用户在界面上取消。');
          new Notice(result.reason);
          await this.plugin.service.persistJobs();
          await this.refresh();
        };
      }
    }
  }

  private async renderPatches(body: HTMLElement): Promise<void> {
    body.createDiv({ cls: 'mom-section-title', text: '待审补丁（AI 想改的已确认事实）' });
    body.createDiv({
      cls: 'mom-hint',
      text:
        'AI 与外部工具**不能直接改写已确认事实**。它们只能提出补丁：这里对照当前内容与新内容，' +
        '由你决定接受或忽略。接受时用的是这条补丁提出时的版本哈希——中途有人工编辑会报冲突，' +
        '不会覆盖你刚写的内容。',
    });
    const patches = this.plugin.service.store.allPatches();
    if (patches.length === 0) {
      body.createDiv({ cls: 'mom-empty', text: '没有待审补丁。' });
    }
    for (const patch of patches.slice(-20).reverse()) {
      this.renderPatch(body, patch);
    }
  }

  private renderPatch(body: HTMLElement, patch: PendingPatch): void {
    const card = body.createDiv({ cls: `mom-card mom-patch-${patch.status}` });
    card.createDiv({ cls: 'mom-card-title', text: `${patch.target}` });
    card.createDiv({
      cls: 'mom-card-meta',
      text:
        `状态 ${patchStatusLabel(patch.status)} · 提议者 ${patch.author} · ` +
        `提出于 ${patch.createdAt} · 捕获 rev ${patch.capturedRevision}`,
    });
    card.createDiv({ cls: 'mom-card-snippet', text: `理由：${patch.reason}` });
    const current = this.plugin.service.store
      .all()
      .find(record => record.path === patch.target);
    card.createDiv({
      cls: 'mom-card-meta',
      text: current === undefined
        ? '当前内容：目标记忆已不存在（接受会报冲突并保留记录）。'
        : `当前 rev ${current.meta.revision} · ${readTitle(current)}`,
    });
    for (const field of patchFieldSummary(patch)) {
      card.createDiv({ cls: 'mom-card-meta', text: `将改为 ${field.field}：${field.value.slice(0, 300)}` });
    }
    if (current !== undefined) {
      card.createDiv({ cls: 'mom-card-snippet', text: `当前正文：${current.body.slice(0, 300)}` });
    }
    if (patch.note !== undefined && patch.note !== '') {
      card.createDiv({ cls: 'mom-card-meta', text: patch.note });
    }
    if (patch.status !== 'pending') return;
    const actions = card.createDiv({ cls: 'mom-card-actions' });
    const accept = actions.createEl('button', { text: '接受并应用' });
    accept.onclick = async () => {
      const result = await this.plugin.service.store.acceptPatch(patch.id, { handledBy: 'user' });
      new Notice(result.message, 8000);
      await this.plugin.service.load(true).catch(() => undefined);
      await this.refresh();
    };
    const ignore = actions.createEl('button', { text: '忽略' });
    ignore.onclick = async () => {
      const result = await this.plugin.service.store.ignorePatch(patch.id, { handledBy: 'user' });
      new Notice(result.message);
      await this.refresh();
    };
  }

  private async renderSearch(body: HTMLElement): Promise<void> {
    const row = body.createDiv({ cls: 'mom-search-row' });
    const input = row.createEl('input', { type: 'search', placeholder: '搜索记忆…' });
    input.value = this.query;
    const button = row.createEl('button', { text: '搜索' });
    const run = async (): Promise<void> => {
      this.query = input.value;
      const settings = this.plugin.currentSettings();
      const result = await this.plugin.service.store.search({
        text: this.query,
        limit: settings.search.defaultLimit,
        includeNonConfirmed: settings.search.includePendingByDefault,
        includeExpired: !settings.search.excludeExpiredByDefault,
      });
      this.status = `命中 ${result.hits.length} 条；因范围排除 ${result.diagnosis.excludedByScope}，` +
        `因状态排除 ${result.diagnosis.excludedByStatus}，因过期排除 ${result.diagnosis.excludedByExpired}，` +
        `因来源失效排除 ${result.diagnosis.excludedByDerived}。`;
      const list = body.querySelector('.mom-results');
      if (list instanceof HTMLElement) list.remove();
      const results = body.createDiv({ cls: 'mom-results' });
      if (result.hits.length === 0) {
        results.createDiv({ cls: 'mom-empty', text: '没有命中。上面的排除计数说明了为什么。' });
      }
      for (const hit of result.hits) {
        const card = results.createDiv({ cls: 'mom-card' });
        card.createDiv({ cls: 'mom-card-title', text: hit.title });
        card.createDiv({
          cls: 'mom-card-meta',
          text: `${hit.id} · rev ${hit.revision} · ${hit.status} · ${hit.scope}${hit.scope_ref ? `/${hit.scope_ref}` : ''}`,
        });
        for (const snippet of hit.snippets.slice(0, 2)) {
          card.createDiv({ cls: 'mom-card-snippet', text: snippet.text });
        }
        const open = card.createEl('button', { text: '打开' });
        open.onclick = async () => {
          await this.app.workspace.openLinkText(hit.path, '', false);
        };
      }
      const status = body.querySelector('.mom-status');
      if (status instanceof HTMLElement) status.setText(this.status);
      else body.createDiv({ cls: 'mom-status', text: this.status });
    };
    button.onclick = run;
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') void run();
    });
    await run();
  }

  private async renderPending(body: HTMLElement): Promise<void> {
    const pending = this.plugin.service.store.pending();
    body.createDiv({ cls: 'mom-section-title', text: `待确认候选 ${pending.length} 条` });
    if (pending.length === 0) {
      body.createDiv({ cls: 'mom-empty', text: '没有待确认的候选。AI 提取与复盘建议都会先落到这里。' });
      return;
    }
    for (const record of pending) {
      const card = body.createDiv({ cls: 'mom-card' });
      card.createDiv({ cls: 'mom-card-title', text: firstLine(record.body) });
      card.createDiv({ cls: 'mom-card-meta', text: `${record.meta.id} · rev ${record.meta.revision} · ${record.path}` });
      card.createDiv({
        cls: 'mom-card-snippet',
        text: record.body.length > 240 ? `${record.body.slice(0, 240)}…` : record.body,
      });
      const actions = card.createDiv({ cls: 'mom-card-actions' });
      const hash = this.plugin.service.store.hashOf(record.meta.id) ?? undefined;
      const confirm = actions.createEl('button', { text: '确认' });
      confirm.onclick = async () => {
        const result = await this.plugin.service.store.confirm(record.meta.id, { expectedHash: hash });
        new Notice(result.message);
        await this.refresh();
      };
      const reject = actions.createEl('button', { text: '忽略' });
      reject.onclick = async () => {
        const result = await this.plugin.service.store.reject(record.meta.id, { expectedHash: hash });
        new Notice(result.message);
        await this.refresh();
      };
      const open = actions.createEl('button', { text: '打开' });
      open.onclick = async () => {
        await this.app.workspace.openLinkText(record.path, '', false);
      };
    }
  }

  private async renderQueue(body: HTMLElement): Promise<void> {
    body.createDiv({ cls: 'mom-section-title', text: '外部写请求（CLI / MCP）' });
    body.createDiv({
      cls: 'mom-hint',
      text:
        '外部入口默认**只排队**：真正的 Markdown 提交发生在本插件里（Vault.process 同步比较）。' +
        '「已排队」不等于「已提交」；下面的回执才是结果。',
    });
    const receipts = await this.plugin.service.writeQueue.readReceipts();
    const overview = await this.plugin.service.writeQueue.overview();
    body.createDiv({
      cls: 'mom-card-meta',
      text:
        `当前排队中：${overview.pending} 条（另有 ${overview.claimed} 条处于认领态，` +
        `上次可能中断）；历史回执：${overview.receipts} 条。`,
    });
    body.createDiv({
      cls: 'mom-card-meta',
      text:
        `目录枚举方式：${overview.listingMode}（index=Obsidian 索引，adapter=真实文件系统，mixed=两者并集）。` +
        (overview.offIndex.length > 0 ? `其中 ${overview.offIndex.length} 个文件只有适配器可见（隐藏目录）。` : ''),
    });
    if (receipts.length === 0) {
      body.createDiv({ cls: 'mom-empty', text: '还没有任何回执。' });
    }
    for (const receipt of receipts.slice(-20).reverse()) {
      this.renderReceipt(body, receipt);
    }
  }

  private renderReceipt(body: HTMLElement, receipt: QueueReceipt): void {
    const card = body.createDiv({ cls: `mom-card mom-receipt-${receipt.status}` });
    card.createDiv({ cls: 'mom-card-title', text: `${receipt.requestId}` });
    card.createDiv({
      cls: 'mom-card-meta',
      text: `${receiptStatusLabel(receipt.status)} · ${receipt.committedAt} · 处理者 ${receipt.committedBy}` +
        (receipt.revision === null ? '' : ` · rev ${receipt.revision}`),
    });
    card.createDiv({ cls: 'mom-card-snippet', text: receipt.message });
    if (receipt.actualHash !== null) {
      card.createDiv({ cls: 'mom-card-meta', text: `冲突现场哈希：${receipt.actualHash}` });
    }
  }

  private async renderReview(body: HTMLElement): Promise<void> {
    body.createDiv({ cls: 'mom-section-title', text: '复盘建议' });
    body.createDiv({
      cls: 'mom-hint',
      text:
        '本地检查**不调用模型**；只有你点「立即语义复盘」才会把允许的已确认正文发给模型。' +
        '建议身份由「问题类型 + 受影响记忆 + 版本」决定：忽略一组不会掩盖另一组不同的问题，' +
        '重启后也不会重复弹出已经处理过的同一条。',
    });
    const stateError = this.plugin.reviewStateError();
    if (stateError !== '') {
      body.createDiv({ cls: 'mom-card-meta', text: `处理状态读取失败，本次显示可能重复：${stateError}` });
    }
    const all = await this.plugin.allSuggestions();
    const open = all.filter(item => this.plugin.suggestionDecision(item) === null);
    if (open.length === 0) {
      body.createDiv({
        cls: 'mom-empty',
        text: all.length === 0 ? '本地检查没有发现问题。' : `当前 ${all.length} 条建议都已处理（版本未变化时不再重复提示）。`,
      });
    }
    for (const suggestion of open) {
      this.renderSuggestion(body, suggestion);
    }
    const handled = all.filter(item => this.plugin.suggestionDecision(item) !== null);
    if (handled.length > 0) {
      const details = body.createEl('details');
      details.createEl('summary', { text: `已处理（${handled.length}）` });
      for (const suggestion of handled) {
        details.createDiv({
          cls: 'mom-card-meta',
          text: `${suggestion.title} —— ${this.plugin.suggestionDecision(suggestion) === 'accepted' ? '已接受' : '已忽略'}`,
        });
      }
    }
  }

  private renderSuggestion(body: HTMLElement, suggestion: ReviewSuggestion): void {
    const card = body.createDiv({ cls: 'mom-card' });
    card.createDiv({ cls: 'mom-card-title', text: suggestion.title });
    card.createDiv({ cls: 'mom-card-meta', text: `${suggestion.kind} · ${suggestion.status} · ${suggestion.id}` });
    card.createDiv({ cls: 'mom-card-snippet', text: suggestion.detail });
    const evidence = card.createDiv({ cls: 'mom-evidence' });
    for (const item of suggestion.evidence) {
      evidence.createDiv({
        cls: item.verified === false ? 'mom-evidence-item unverified' : 'mom-evidence-item',
        text: `${item.kind} ${item.ref}：${item.detail}${item.verified === false ? '（未能核对）' : ''}`,
      });
    }
    card.createDiv({
      cls: 'mom-card-meta',
      text: `动作：${actionLabel(suggestion)}（按用户权限提交，并使用上面这一版的哈希做前置条件）`,
    });
    const actions = card.createDiv({ cls: 'mom-card-actions' });
    const ic = actions.createEl('span');
    setIcon(ic, 'info');
    const accept = actions.createEl('button', { text: '接受建议' });
    accept.onclick = async () => {
      const outcome = await this.plugin.acceptSuggestion(suggestion);
      new Notice(outcome, 8000);
      await this.refresh();
    };
    const ignore = actions.createEl('button', { text: '忽略' });
    ignore.onclick = async () => {
      const outcome = await this.plugin.ignoreSuggestion(suggestion);
      new Notice(outcome);
      await this.refresh();
    };
  }
}

/** 建议动作的中文说明（界面用它告诉用户点下去会发生什么）。 */
function actionLabel(suggestion: ReviewSuggestion): string {
  const action = suggestion.action;
  switch (action.type) {
    case 'correct_memory':
      return '用新正文替换这一条（需要哈希一致）';
    case 'mark_disputed':
      return '标记为有争议：置为“停止使用”，退出默认召回（历史保留）';
    case 'expire':
      return '设置有效期到期';
    case 'schedule_review':
      return '安排复查时间';
    case 'propose_memory':
      return '新建一条待确认候选';
    case 'supersede':
      return '用新的候选替代（原条目保留历史）';
    case 'rebuild_index':
      return '重建索引（本地，不调模型）';
    case 'propose_method':
      return '整理 MSE 方法候选（离线，不发送）';
    default:
      return '不改动任何内容';
  }
}

/** 补丁状态的中文标签。 */
export function patchStatusLabel(status: PendingPatch['status']): string {
  switch (status) {
    case 'pending':
      return '等待审核';
    case 'accepted':
      return '已接受（已应用）';
    case 'ignored':
      return '已忽略（未改动）';
    case 'conflict':
      return '需要重新审核（目标已变化或不存在）';
  }
}

/** 作业种类的中文标题（与核心 JobKind 一一对应）。 */
const JOB_TITLE: Record<string, string> = {
  extract_session: '提取候选',
  ai_review: '语义复盘',
  periodic_daily: '每日维护',
  periodic_weekly: '每周维护',
  index_rebuild: '重建索引',
  mse_bridge_push: 'MSE 候选整理',
};

/** 取正文首行作为标题（核心没有单独的 title 字段）。 */
function firstLine(body: string): string {
  const line = body.split('\n').find(item => item.trim() !== '') ?? '';
  return line.replace(/^#\s*/, '').slice(0, 80) || '（无标题）';
}

/** 回执状态的中文标签（界面与通知共用一份）。 */
export function receiptStatusLabel(status: QueueReceipt['status']): string {
  switch (status) {
    case 'completed':
      return '已提交';
    case 'conflict':
      return '冲突（未提交，正文未改动）';
    case 'failed':
      return '失败（未提交）';
    case 'expired':
      return '已过期（未提交，请求保留）';
  }
}

/** 打开（或聚焦）工作台视图。 */
export async function activateWorkbench(app: App, plugin: MissherMemoryPlugin): Promise<void> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH);
  if (existing.length > 0) {
    await app.workspace.revealLeaf(existing[0]!);
    return;
  }
  const leaf = app.workspace.getRightLeaf(false);
  if (leaf === null) return;
  await leaf.setViewState({ type: VIEW_TYPE_WORKBENCH, active: true });
  await app.workspace.revealLeaf(leaf);
  void plugin;
}

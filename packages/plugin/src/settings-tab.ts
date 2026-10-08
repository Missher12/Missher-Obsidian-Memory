/**
 * 设置页。
 *
 * 三条不可动摇的界面规则：
 * 1. **密钥不落进 `data.json`**：只写 Obsidian 的 `SecretStorage`，
 *    并如实说明「不验证底层是否使用系统钥匙串，也不声称所有平台都加密」；
 * 2. **不夸大能力**：`requestUrl` 不能取消已发出的请求，这一句必须写在设置页上；
 * 3. 记忆根目录只能填 Vault 内的相对路径，且不能是 `.obsidian` / `.git` 这类保留目录。
 */

import { PluginSettingTab, Setting, type App } from 'obsidian';
import { DEFAULT_ROOT, type PluginSettings } from '@mom/core';
import type MissherMemoryPlugin from './plugin.js';

export class MemorySettingTab extends PluginSettingTab {
  private readonly plugin: MissherMemoryPlugin;

  constructor(app: App, plugin: MissherMemoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Missher Obsidian Memory 设置' });

    for (const warning of this.plugin.settingWarnings()) {
      containerEl.createDiv({ cls: 'mom-warning', text: `设置警告：${warning}` });
    }

    /* ---------------- 记忆根目录（显式应用） ---------------- */
    /**
     * 这里刻意**不做**「每敲一个字符就保存」。
     *
     * 记忆根目录是「用哪个库」这种级别的设置：输入过程中的半截路径
     * （`Bra`、`Brain/临时`）不该被写进设置，更不该被当成新目标去新建目录。
     * 所以流程是：输入 → 校验 → 点「应用」→ 确认重载。
     */
    const activeRoot = this.plugin.service.memoryRoot;
    const rootSetting = new Setting(containerEl)
      .setName('记忆根目录')
      .setDesc(
        `Vault 内的相对路径（默认 ${DEFAULT_ROOT}）。不能是绝对路径，也不能是 .obsidian / .git / node_modules 等保留目录。` +
          '改动需要点「应用」并重载插件才会生效。',
      );
    let rootDraft = activeRoot;
    rootSetting.addText(text => {
      text.setValue(activeRoot);
      text.onChange(value => {
        rootDraft = value;
      });
    });
    const rootHint = containerEl.createDiv({ cls: 'mom-hint' });
    const renderRootHint = (extra = ''): void => {
      const parts = [`当前正在使用：${this.plugin.service.memoryRoot}`];
      if (rootDraft.trim() !== '' && rootDraft.trim() !== this.plugin.service.memoryRoot) {
        parts.push(`待应用的输入：${rootDraft.trim()}（尚未生效）`);
      }
      if (extra !== '') parts.push(extra);
      rootHint.setText(parts.join('\n'));
    };
    renderRootHint();
    rootSetting.addButton(button =>
      button.setButtonText('应用').onClick(async () => {
        const result = await this.plugin.applyRoot(rootDraft);
        renderRootHint(result.message);
        if (result.ok) this.display();
      }),
    );
    rootSetting.addExtraButton(button =>
      button
        .setIcon('reset')
        .setTooltip('放弃输入，恢复当前正在使用的目录')
        .onClick(() => {
          rootDraft = this.plugin.service.memoryRoot;
          this.display();
        }),
    );

    /* ---------------- AI ---------------- */
    containerEl.createEl('h3', { text: 'AI（可选）' });
    containerEl.createDiv({
      cls: 'mom-hint',
      text:
        '核心功能（记录、检索、复盘、队列）不依赖模型。启用 AI 才能做自动提取、语义复盘与带来源问答。' +
        '本插件不内置任何模型凭据，也不会上传你的笔记到未经你配置的地址。',
    });

    new Setting(containerEl)
      .setName('启用 AI 功能')
      .setDesc('关闭后：不发送任何请求，界面上的 AI 入口会明确显示「未配置」。')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.currentSettings().ai.enabled);
        toggle.onChange(async value => {
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ ai: { ...settings.ai, enabled: value } });
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('接口地址（OpenAI 兼容）')
      .setDesc('例如 https://api.example.com/v1。留空表示未配置。')
      .addText(text => {
        text.setValue(this.plugin.currentSettings().ai.baseUrl);
        text.onChange(async value => {
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ ai: { ...settings.ai, baseUrl: value.trim() } });
        });
      });

    new Setting(containerEl)
      .setName('模型名')
      .setDesc('由你填写。插件不硬编码模型、不自动切换、不在未启用时发请求。')
      .addText(text => {
        text.setValue(this.plugin.currentSettings().ai.model);
        text.onChange(async value => {
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ ai: { ...settings.ai, model: value.trim() } });
        });
      });

    const storageAvailable = this.plugin.service.hasSecretStorage();
    new Setting(containerEl)
      .setName('API Key')
      .setDesc(
        storageAvailable
          ? '保存在 Obsidian 的密钥存储里，不会写入本插件的数据文件或 Markdown。' +
            '如实说明：本插件不验证底层是否使用系统钥匙串，也不声称所有平台都加密；' +
            'Obsidian 目前没有公开的密钥删除 API，留空保存只会覆盖为空值。'
          : '当前 Obsidian 版本没有可用的密钥存储 API（需要 1.11.4+），因此不会保存密钥。',
      )
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('粘贴后按「使用这个密钥」');
      })
      .addButton(button => {
        button.setButtonText('使用这个密钥');
        button.onClick(async () => {
          const input = containerEl.querySelector<HTMLInputElement>('input[type="password"]');
          const value = input?.value ?? '';
          if (value.trim() === '') {
            this.plugin.service.notify('密钥为空，未保存。');
            return;
          }
          const settings = this.plugin.currentSettings();
          const ok = this.plugin.service.writeCredential(value.trim(), settings);
          this.plugin.service.notify(
            ok
              ? '密钥已写入 Obsidian 密钥存储（本插件不验证底层是否使用系统钥匙串，也不声称所有平台都加密）。'
              : '密钥已生效，但**只保留在本次运行内**（关闭 Obsidian 即失效，不会写入任何文件）。',
          );
          if (input) input.value = '';
          this.display();
        });
      });

    const runtime = this.plugin.service;
    new Setting(containerEl)
      .setName('密钥当前状态')
      .setDesc(
        runtime.keyConfigured()
          ? '已配置：界面只显示「有 / 没有」，不会回显密钥内容。'
          : runtime.hasSessionKey()
            ? '配置了本次运行的临时密钥。'
            : '尚未配置密钥；模型接口通常需要它。',
      )
      .addButton(button => {
        button.setButtonText('清除本次运行的临时密钥');
        button.onClick(() => {
          runtime.writeSessionKey('');
          this.plugin.service.notify('已清除本次运行的临时密钥（已写入密钥存储的那一份不会被删除：公开 API 没有 removeSecret）。');
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('请求超时（毫秒）')
      .setDesc(
        '超过这个时间本插件停止等待。如实说明：Obsidian 的 requestUrl 不支持取消已发出的请求，' +
        '因此「停止等待」不等于「请求没有发生」；这类结果也不会被自动重试。',
      )
      .addText(text => {
        text.setValue(String(this.plugin.currentSettings().ai.timeoutMs));
        text.onChange(async value => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1000) return;
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ ai: { ...settings.ai, timeoutMs: Math.floor(parsed) } });
        });
      });

    new Setting(containerEl)
      .setName('每日调用上限')
      .setDesc('0 表示不限制。达到上限后新的模型调用会被拒绝，并明确告知原因。')
      .addText(text => {
        text.setValue(String(this.plugin.currentSettings().ai.dailyCallBudget));
        text.onChange(async value => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0) return;
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ ai: { ...settings.ai, dailyCallBudget: Math.floor(parsed) } });
        });
      });

    /* ---------------- 检索 ---------------- */
    containerEl.createEl('h3', { text: '检索' });
    new Setting(containerEl)
      .setName('默认返回条数')
      .addText(text => {
        text.setValue(String(this.plugin.currentSettings().search.defaultLimit));
        text.onChange(async value => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1) return;
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({
            search: { ...settings.search, defaultLimit: Math.min(50, Math.floor(parsed)) },
          });
        });
      });

    new Setting(containerEl)
      .setName('默认包含待确认候选')
      .setDesc('关闭时只返回已确认事实，候选不会混进检索结果。')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.currentSettings().search.includePendingByDefault);
        toggle.onChange(async value => {
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ search: { ...settings.search, includePendingByDefault: value } });
        });
      });

    new Setting(containerEl)
      .setName('默认排除已过期记录')
      .setDesc('打开时过期事实退出召回（历史仍在，可在查看历史时显式包含）。')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.currentSettings().search.excludeExpiredByDefault);
        toggle.onChange(async value => {
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ search: { ...settings.search, excludeExpiredByDefault: value } });
        });
      });

    new Setting(containerEl)
      .setName('上下文预算（字符）')
      .setDesc('这是**硬上限**：核心不会为了塞进来源而偷偷放大它；放不下就少给，并记录原因。')
      .addText(text => {
        text.setValue(String(this.plugin.currentSettings().search.contextBudgetChars));
        text.onChange(async value => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 100) return;
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({
            search: { ...settings.search, contextBudgetChars: Math.floor(parsed) },
          });
        });
      });

    /* ---------------- 复盘 ---------------- */
    containerEl.createEl('h3', { text: '复盘' });
    new Setting(containerEl)
      .setName('自动复盘')
      .setDesc('在会话结束、闲置与每日/每周检查点触发本地复盘（本地检查不调用模型）。')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.currentSettings().review.autoReview);
        toggle.onChange(async value => {
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ review: { ...settings.review, autoReview: value } });
        });
      });

    /* ---------------- MSE ---------------- */
    containerEl.createEl('h3', { text: 'MSE（完全可选）' });
    containerEl.createDiv({
      cls: 'mom-hint',
      text:
        'MSE 联动默认关闭，且不是运行依赖：关闭时本插件的记录、检索、复盘、队列全部照常工作。' +
        '开启后只做「方法候选包」的离线生成与校验，不会自动把本地内容上传。',
    });
    new Setting(containerEl)
      .setName('启用 MSE 方法候选联动')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.currentSettings().mse.enabled);
        toggle.onChange(async value => {
          const settings = this.plugin.currentSettings();
          await this.plugin.updateSettings({ mse: { ...settings.mse, enabled: value } });
        });
      });

    /* ---------------- 状态 ---------------- */
    /**
     * 模型调用账目（只读）。
     *
     * 这一块存在的唯一理由：设置项写着「达到上限后新的模型调用会被拒绝」，
     * 用户必须能在这里看到**现在到底用了多少、还剩多少、什么时候恢复**，
     * 而不是等被拒绝时才发现。同时如实区分实测与保守估算——
     * 把估算显示成实测 token 等于对账目撒谎。
     */
    containerEl.createEl('h3', { text: '模型调用账目' });
    const usage = this.plugin.modelUsageReport();
    const ledger = containerEl.createDiv({ cls: 'mom-hint' });
    ledger.setText(
      [
        `记账日界：UTC（当前 ${usage.day}；下一个 UTC 日开始时自动恢复额度，不是本地午夜）`,
        `今日已用：${usage.calls} 次调用 · ${usage.tokens} token${
          usage.accounted === 'measured'
            ? '（最近一次是供应商上报的实测值）'
            : usage.accounted === 'refused'
              ? '（最近一次**没有记账**：缺少可核对的预占 id，为保证不动到别的请求的额度，账目保持保守）'
              : usage.accounted === 'refunded'
                ? '（最近一次没有发送请求，预占已退回）'
                : '（保守估算：供应商未上报用量时宁可高估）'
        }`,
        `上限：${usage.limits.maxCallsPerDay === 0 ? '调用次数不限' : `${usage.limits.maxCallsPerDay} 次/日`} · ` +
          `${usage.limits.maxTokensPerDay === 0 ? 'token 不限' : `${usage.limits.maxTokensPerDay} token/日`}`,
        `问答与作业**共用**这一份账：额度用尽后两条入口都会在发请求之前被拒绝。`,
      ].join('\n'),
    );

    containerEl.createEl('h3', { text: '状态与诊断' });
    const status = containerEl.createDiv({ cls: 'mom-hint' });
    const settings: PluginSettings = this.plugin.currentSettings();
    const refresh = this.plugin.indexRefreshStats();
    status.setText(
      [
        `记忆根目录（当前生效）：${this.plugin.service.memoryRoot}`,
        `已保存到设置的根目录：${settings.root}${settings.root === this.plugin.service.memoryRoot ? '' : '（与当前生效值不同：需要重载插件）'}`,
        `索引跟随刷新：${refresh.refreshes} 次${
          refresh.lastAt === 0 ? '' : `（最近一次 ${new Date(refresh.lastAt).toLocaleTimeString()}）`
        }${refresh.pending === 0 ? '' : ` · 待处理 ${refresh.pending} 个路径`}${
          refresh.selfSkipped === 0 ? '' : ` · 跳过自触发 ${refresh.selfSkipped} 次`
        }`,
        `状态目录：${settings.stateDir}（请求队列 ${settings.stateDir}/requests，回执 ${settings.stateDir}/receipts）`,
        `AI：${settings.ai.enabled ? '已启用' : '未启用'}`,
        `密钥存储 API：${storageAvailable ? '可用（不验证是否使用系统钥匙串）' : '不可用'}`,
      ].join('\n'),
    );
  }
}

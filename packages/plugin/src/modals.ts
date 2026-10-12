/**
 * 界面弹窗：快速记住、搜索、记忆详情、复盘建议详情。
 *
 * 设计原则：**任何写入都必须先展示将被写入的原文与期望值**。
 * 用户看到的哈希就是提交时的期望值；内容在别处被改过，提交会被拒绝，
 * 而不是被覆盖。
 */

import { Modal, Notice, Setting, type App } from 'obsidian';
import {
  describeSuggestion,
  renderSourcesBlock,
  MISSHER_CATEGORY_LABELS,
  type MemoryCategory,
  type MemoryRecord,
  type ReviewSuggestion,
} from '@mom/core';
import type MissherMemoryPlugin from './plugin.js';

export class QuickCaptureModal extends Modal {
  private readonly plugin: MissherMemoryPlugin;
  private text = '';
  private title = '';
  private category: MemoryCategory | '' = '';
  private kind = 'note';
  private scopeChoice: 'personal' | 'project' | 'context' = 'personal';
  private scopeRef = '';
  private asCandidate = false;

  constructor(app: App, plugin: MissherMemoryPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '快速记住' });
    contentEl.createDiv({
      cls: 'mom-hint',
      text: '直接写下来即可。候选会进入「待确认」，由你确认后才成为权威事实。',
    });

    new Setting(contentEl).setName('标题（可选）').setDesc('用简短主题命名；留空时从内容生成。')
      .addText(text => text.setValue(this.title).onChange(value => { this.title = value; }));
    if (this.plugin.service.organization.preset === 'missher') {
      new Setting(contentEl).setName('文件夹分类').setDesc('只决定存放位置；确认状态和适用范围另行设置。')
        .addDropdown(dropdown => {
          dropdown.addOption('', '按内容类型自动选择');
          for (const [key, label] of Object.entries(MISSHER_CATEGORY_LABELS)) dropdown.addOption(key, label);
          dropdown.setValue(this.category).onChange(value => { this.category = value as MemoryCategory | ''; });
        });
    }

    new Setting(contentEl)
      .setName('内容')
      .setDesc('一到三段事实陈述；不要写「记住这个」。')
      .addTextArea(area => {
        area.inputEl.rows = 6;
        area.setPlaceholder('例如：项目 Borealis 的构建脚本改用 pnpm 11。');
        area.onChange(value => {
          this.text = value;
        });
      });

    new Setting(contentEl).setName('类型').addDropdown(dropdown => {
      for (const kind of ['note', 'fact', 'preference', 'person', 'project', 'knowledge', 'event', 'decision']) {
        dropdown.addOption(kind, kind);
      }
      dropdown.setValue(this.kind);
      dropdown.onChange(value => {
        this.kind = value;
      });
    });

    new Setting(contentEl).setName('范围').addDropdown(dropdown => {
      dropdown.addOption('personal', 'personal（只影响我自己）');
      dropdown.addOption('project', 'project（某个项目）');
      dropdown.addOption('context', 'context（某个场景）');
      dropdown.setValue(this.scopeChoice);
      dropdown.onChange(value => {
        this.scopeChoice = value as typeof this.scopeChoice;
      });
    });

    new Setting(contentEl).setName('范围标识').addText(text => {
      text.setPlaceholder('选择 project/context 时必填，例如 borealis');
      text.onChange(value => {
        this.scopeRef = value;
      });
    });

    new Setting(contentEl)
      .setName('先进待确认')
      .setDesc('打开后只创建候选（pending），不会直接成为权威事实。')
      .addToggle(toggle => {
        toggle.setValue(this.asCandidate);
        toggle.onChange(value => {
          this.asCandidate = value;
        });
      });

    new Setting(contentEl).addButton(button => {
      button.setButtonText('提交');
      button.setCta();
      button.onClick(async () => {
        const trimmed = this.text.trim();
        if (trimmed === '') {
          new Notice('内容为空，没有提交。');
          return;
        }
        if (this.scopeChoice !== 'personal' && this.scopeRef.trim() === '') {
          new Notice('选择 project/context 时必须填写范围标识；否则范围会变成「所有项目」，这是被禁止的。');
          return;
        }
        const draft = {
          body: trimmed,
          ...(this.title.trim() === '' ? {} : { title: this.title.trim() }),
          ...(this.category === '' ? {} : { category: this.category }),
          kind: this.kind as MemoryRecord['meta']['kind'],
          scope: this.scopeChoice,
          scopeRef: this.scopeChoice === 'personal' ? '' : this.scopeRef.trim(),
          sourceKind: 'user_explicit' as const,
          sourceRef: 'quick-capture',
        };
        const result = this.asCandidate
          ? await this.plugin.service.store.propose(draft)
          : await this.plugin.service.store.remember(draft);
        new Notice(result.message);
        if (!result.ok) return;
        this.close();
        await this.plugin.refreshViews();
      });
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class SearchModal extends Modal {
  private readonly plugin: MissherMemoryPlugin;

  constructor(app: App, plugin: MissherMemoryPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '搜索记忆' });
    const results = contentEl.createDiv({ cls: 'mom-results' });
    const run = async (query: string): Promise<void> => {
      results.empty();
      const settings = this.plugin.currentSettings();
      const outcome = await this.plugin.service.store.search({
        text: query,
        limit: settings.search.defaultLimit,
        includeNonConfirmed: settings.search.includePendingByDefault,
        includeExpired: !settings.search.excludeExpiredByDefault,
      });
      if (outcome.hits.length === 0) {
        results.createDiv({
          cls: 'mom-empty',
          text: `没有命中（范围排除 ${outcome.diagnosis.excludedByScope}，状态排除 ${outcome.diagnosis.excludedByStatus}，过期排除 ${outcome.diagnosis.excludedByExpired}）。`,
        });
        return;
      }
      for (const hit of outcome.hits) {
        const card = results.createDiv({ cls: 'mom-card' });
        card.createDiv({ cls: 'mom-card-title', text: hit.title });
        card.createDiv({ cls: 'mom-card-meta', text: `${hit.id} · rev ${hit.revision}` });
        for (const snippet of hit.snippets.slice(0, 2)) card.createDiv({ cls: 'mom-card-snippet', text: snippet.text });
        card.onclick = async () => {
          this.close();
          await this.app.workspace.openLinkText(hit.path, '', false);
        };
      }
    };

    new Setting(contentEl).setName('关键词').addText(text => {
      text.inputEl.style.width = '100%';
      text.onChange(value => {
        void run(value);
      });
    });
    void run('');
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 记忆详情：展示来源、变更与提交用的期望哈希。 */
export class RecordDetailModal extends Modal {
  private readonly plugin: MissherMemoryPlugin;
  private readonly record: MemoryRecord;

  constructor(app: App, plugin: MissherMemoryPlugin, record: MemoryRecord) {
    super(app);
    this.plugin = plugin;
    this.record = record;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.record.body.split('\n')[0]?.replace(/^#\s*/, '') ?? '记忆详情' });
    contentEl.createDiv({
      cls: 'mom-card-meta',
      text: `${this.record.meta.id} · rev ${this.record.meta.revision} · ${this.record.meta.status} · ${this.record.meta.scope}`,
    });
    contentEl.createEl('pre', { text: this.record.body });
    if (this.record.sources.length > 0) {
      contentEl.createEl('h3', { text: '来源' });
      contentEl.createEl('pre', { text: renderSourcesBlock(this.record.sources) });
    }
    contentEl.createDiv({
      cls: 'mom-hint',
      text: `提交时会带上期望哈希 ${this.plugin.service.store.hashOf(this.record.meta.id) ?? '（未知）'}；内容在别处被改过就会被拒绝。`,
    });

    /*
     * MSE 方法候选：只能从这条记忆生成，而且按钮上就写清「不会发送」。
     * 默认关闭的联动不该靠一个含糊的按钮名让用户误以为已经同步。
     */
    new Setting(contentEl)
      .setName('导出为 MSE 方法候选包')
      .setDesc('只在本库 _exports/ 下生成一个 JSON（本地校验 + 本地写盘）；不连接 MSE、不发送、不改动这条记忆。')
      .addButton(button => {
        button.setButtonText('生成候选包');
        button.onClick(async () => {
          const result = await this.plugin.exportMethodCandidateFor(this.record);
          new Notice(
            result.ok
              ? `已生成候选包（未发送）：${result.path}`
              : `本地校验未通过，没有写出文件：${result.reasons.join('；')}`,
          );
        });
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 复盘建议详情：把「接受」会做什么写清楚，再让用户决定。 */
export class SuggestionModal extends Modal {
  private readonly plugin: MissherMemoryPlugin;
  private readonly suggestion: ReviewSuggestion;

  constructor(app: App, plugin: MissherMemoryPlugin, suggestion: ReviewSuggestion) {
    super(app);
    this.plugin = plugin;
    this.suggestion = suggestion;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.suggestion.title });
    contentEl.createEl('p', { text: this.suggestion.detail });
    contentEl.createEl('pre', { text: describeSuggestion(this.suggestion) });
    new Setting(contentEl).addButton(button => {
      button.setButtonText('接受');
      button.setCta();
      button.onClick(async () => {
        new Notice(await this.plugin.acceptSuggestion(this.suggestion));
        this.close();
      });
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}


/**
 * 「确认后执行」对话框。
 *
 * 用 Promise 包一层，让调用方可以按顺序写业务逻辑（先确认、再动作），
 * 而不是把后续逻辑塞进按钮回调里——那样最容易漏掉取消分支。
 * `app` 由调用方传入（插件实例手里就有），不从模块级全局取。
 */
export function confirmReload(app: App, title: string, confirmText = '应用并重载'): Promise<boolean> {
  return new Promise(resolve => {
    let decided = false;
    const modal = new Modal(app);
    modal.titleEl.setText('确认改动');
    modal.contentEl.createEl('p', { text: title });
    const decide = (value: boolean) => {
      if (decided) return;
      decided = true;
      modal.close();
      resolve(value);
    };
    new Setting(modal.contentEl)
      .addButton(button =>
        button.setButtonText('取消').onClick(() => {
          decide(false);
        }),
      )
      .addButton(button =>
        button
          .setButtonText(confirmText)
          .setCta()
          .onClick(() => {
            decide(true);
          }),
      );
    // 点遮罩或按 Esc 关闭都视为取消：不会悄悄执行。
    modal.onClose = () => {
      if (!decided) {
        decided = true;
        resolve(false);
      }
    };
    modal.open();
  });
}

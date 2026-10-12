/**
 * 端到端验收用的 `obsidian` 运行时桩（**真实文件系统**版）。
 *
 * 与单元测试用的 `tests/obsidian-stub.ts` 的区别：
 * 单元测试用内存 Vault（快、能精确注入故障）；这里需要一个**真的落在磁盘上**的
 * Vault，因为端到端要验证的是跨进程闭环：外部 CLI 写下的请求文件，
 * 插件那一侧必须真的从磁盘读得到、提交之后再被外部读回去。
 *
 * 只实现被测插件代码用到的 API，行为尽量贴近真实宿主：
 * - `adapter.read/write/exists/stat/list/mkdir/remove/rename` 直接映射到 fs；
 * - `vault.process` 在同步回调里比较并写入（真实宿主也是这个语义）；
 * - `.memory` 这类隐藏目录**不进索引**（真实 Obsidian 就是这样），
 *   因此也顺带验证了「适配器不依赖索引」这条路。
 *
 * 这个文件不打包、不发布，只服务于仓库内的验收脚本。
 */

import { existsSync, promises as fs, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { OrganizationSettings } from '../packages/core/src/organization.js';

export class TFile {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };

  constructor(path: string, mtime: number, size: number) {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
    this.extension = this.name.includes('.') ? this.name.split('.').pop()! : '';
    this.stat = { mtime, size, ctime: mtime };
  }
}

export class TFolder {
  path: string;
  name: string;

  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
  }
}

export class Notice {
  static history: string[] = [];
  constructor(public message: string, public timeout?: number) {
    Notice.history.push(message);
  }
  setMessage(message: string): this {
    this.message = message;
    return this;
  }
  hide(): void {}
}

export class Modal {
  containerEl = fakeEl();
  contentEl = fakeEl();
  titleEl = fakeEl();
  constructor(public app?: unknown) {}
  open(): void {}
  close(): void {}
}

export class Setting {
  constructor(public containerEl?: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
  addExtraButton(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
}

export class Plugin {
  app: unknown = null;
  registerView(): void {}
  addRibbonIcon(): unknown {
    return {};
  }
  addCommand(): void {}
  addSettingTab(): void {}
  registerEvent(): void {}
  registerInterval(): number {
    return 0;
  }
  async loadData(): Promise<unknown> {
    return {};
  }
  async saveData(): Promise<void> {}
}

export class ItemView {
  constructor(public leaf?: unknown) {}
}

export class WorkspaceLeaf {}

export class TAbstractFile {
  path = '';
}

export class ButtonComponent {}
export class TextComponent {}
export class ToggleComponent {}
export class DropdownComponent {}
export function setIcon(): void {}
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
export function requestUrl(): never {
  throw new Error('端到端验收不联网。');
}

/** 极简的 DOM 元素替身：只够模块被加载时不炸。 */
function fakeEl(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    empty: () => undefined,
    createEl: () => fakeEl(),
    createDiv: () => fakeEl(),
    createSpan: () => fakeEl(),
    setText: () => undefined,
    addClass: () => undefined,
    removeClass: () => undefined,
    toggleClass: () => undefined,
    setAttribute: () => undefined,
    addEventListener: () => undefined,
    appendChild: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    style: {},
    children: [],
    classList: { add: () => undefined, remove: () => undefined },
  };
  return el;
}

/* ------------------------------------------------------------------ */
/* 真实文件系统上的 Vault                                              */
/* ------------------------------------------------------------------ */

const HIDDEN_PREFIXES = ['.'];

function toAbsolute(root: string, vaultPath: string): string {
  return nodePath.join(root, vaultPath);
}

function isHidden(vaultPath: string): boolean {
  return vaultPath.split('/').some(segment => HIDDEN_PREFIXES.some(prefix => segment.startsWith(prefix)));
}

function toVaultPath(root: string, absolute: string): string {
  return nodePath.relative(root, absolute).split(nodePath.sep).join('/');
}

export class RuntimeDataAdapter {
  constructor(private readonly root: string) {}

  async exists(vaultPath: string): Promise<boolean> {
    try {
      await fs.stat(toAbsolute(this.root, vaultPath));
      return true;
    } catch {
      return false;
    }
  }

  async read(vaultPath: string): Promise<string> {
    return fs.readFile(toAbsolute(this.root, vaultPath), 'utf8');
  }

  async write(vaultPath: string, content: string): Promise<void> {
    const absolute = toAbsolute(this.root, vaultPath);
    await fs.mkdir(nodePath.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }

  async mkdir(vaultPath: string): Promise<void> {
    await fs.mkdir(toAbsolute(this.root, vaultPath), { recursive: true });
  }

  async remove(vaultPath: string): Promise<void> {
    await fs.rm(toAbsolute(this.root, vaultPath), { force: true, recursive: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const target = toAbsolute(this.root, to);
    await fs.mkdir(nodePath.dirname(target), { recursive: true });
    await fs.rename(toAbsolute(this.root, from), target);
  }

  async stat(vaultPath: string): Promise<{ mtime: number; size: number; ctime: number } | null> {
    try {
      const info = await fs.stat(toAbsolute(this.root, vaultPath));
      return { mtime: info.mtimeMs, size: info.size, ctime: info.ctimeMs };
    } catch {
      return null;
    }
  }

  async list(vaultPath: string): Promise<{ files: string[]; folders: string[] }> {
    const absolute = toAbsolute(this.root, vaultPath);
    const files: string[] = [];
    const folders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fs.readdir>>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          folders.push(toVaultPath(this.root, child));
          await walk(child);
        } else {
          files.push(toVaultPath(this.root, child));
        }
      }
    };
    await walk(absolute);
    return { files, folders };
  }

  /** 真实宿主也有这个：同步读（队列认领时用得到）。 */
  readSync(vaultPath: string): string {
    return readFileSync(toAbsolute(this.root, vaultPath), 'utf8');
  }
}

export class RuntimeVault {
  readonly adapter: RuntimeDataAdapter;
  /** 事件监听登记（端到端只验证是否存在，不驱动刷新）。 */
  readonly handlers = new Map<string, Array<(file: unknown, oldPath?: string) => void>>();

  constructor(readonly root: string) {
    this.adapter = new RuntimeDataAdapter(root);
  }

  on(event: string, handler: (file: unknown, oldPath?: string) => void): { event: string } {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return { event };
  }

  getFiles(): TFile[] {
    return [];
  }

  getAbstractFileByPath(vaultPath: string): TFile | TFolder | null {
    if (isHidden(vaultPath)) return null;
    const absolute = toAbsolute(this.root, vaultPath);
    try {
      const info = statSync(absolute);
      if (info.isDirectory()) return new TFolder(vaultPath);
      return new TFile(vaultPath, info.mtimeMs, info.size);
    } catch {
      return null;
    }
  }

  getMarkdownFiles(): TFile[] {
    return [];
  }

  async create(vaultPath: string, content: string): Promise<TFile> {
    const absolute = toAbsolute(this.root, vaultPath);
    if (existsSync(absolute)) throw new Error(`File already exists: ${vaultPath}`);
    await this.adapter.write(vaultPath, content);
    return new TFile(vaultPath, Date.now(), content.length);
  }

  async modify(file: TFile, content: string): Promise<void> {
    await this.adapter.write(file.path, content);
  }

  /**
   * 比较-写入的同步原子区（真实宿主的语义）。
   * 这里从磁盘真实字节读，回调返回原文就等于不写。
   */
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const absolute = toAbsolute(this.root, file.path);
    const current = await fs.readFile(absolute, 'utf8');
    const next = fn(current);
    if (next !== current) await fs.writeFile(absolute, next, 'utf8');
    return next;
  }

  async read(file: TFile): Promise<string> {
    return fs.readFile(toAbsolute(this.root, file.path), 'utf8');
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async delete(file: TFile): Promise<void> {
    await fs.rm(toAbsolute(this.root, file.path), { force: true });
  }

  async createFolder(vaultPath: string): Promise<TFolder> {
    await fs.mkdir(toAbsolute(this.root, vaultPath), { recursive: true });
    return new TFolder(vaultPath);
  }
}

/**
 * 由端到端脚本调用的入口：在指定 Vault 上跑**真实的** QueueService 一次。
 *
 * 不做任何网络请求，也不引入 UI 代码。
 */
export async function buildSyntheticVault(options: {
  vaultPath: string;
  memoryRoot: string;
  organization?: OrganizationSettings;
}): Promise<Record<string, unknown>> {
  const { vaultPath, memoryRoot, organization } = options;
  const vault = new RuntimeVault(vaultPath);
  const app = { vault, secretStorage: { getSecret: () => null, setSecret: () => undefined } };

  const { VaultFileStore } = await import('../packages/plugin/src/vault-store.js');
  const { QueueService } = await import('../packages/plugin/src/queue-service.js');
  const { createCommitHandler, createCommitRecovery } = await import('../packages/plugin/src/commit-handler.js');
  const { MemoryStore } = await import('../packages/core/src/index.js');

  const fileStore = new VaultFileStore({ app: app as never, memoryRoot, organization });
  const store = new MemoryStore({ store: fileStore, root: memoryRoot, organization, now: () => Date.now() });
  await store.load();
  store.setPatchPersist(async body => {
    try {
      await store.writeStateFile('patches.json', body);
      return true;
    } catch {
      return false;
    }
  });

  const queue = new QueueService({
    app: app as never,
    store: fileStore,
    memoryRoot,
    organization,
    owner: 'e2e_runner',
    now: () => Date.now(),
    random: () => 0.42,
    commit: createCommitHandler(store),
    findCommitted: createCommitRecovery(store),
  });

  const result = await queue.processOnce();
  const receipts = [...result.processed, ...result.skipped, ...(result.deferredReceipts ?? [])];
  const first = result.processed[0] ?? result.skipped[0] ?? null;
  return {
    processed: result.processed.length,
    skipped: result.skipped.length,
    deferred: result.deferred.length,
    status: first?.status ?? null,
    message: first?.message ?? null,
    memoryId: first?.memoryId ?? null,
    receiptWritten: first !== null,
    receiptsCount: receipts.length,
  };
}

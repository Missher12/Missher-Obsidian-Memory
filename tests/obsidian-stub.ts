/**
 * 测试用的 `obsidian` 桩。
 *
 * 只实现被测插件代码真正用到的那部分 API，并且**刻意复现两类真实宿主行为**：
 *
 * 1. **隐藏目录不进索引**：`.memory` 这类以 `.` 开头的目录不会出现在
 *    `vault.getFiles()` / `getAbstractFileByPath()` 里（这是独立审计指出的
 *    待验证点；桩里两种模式都能开，用于验证适配器不依赖索引也能工作）；
 * 2. **缓存可能落后**：`cachedRead` 可以注入过期内容或 I/O 异常，
 *    用来验证「不能把读盘故障当成文件不存在」。
 *
 * 桩不是产品的一部分：它不打包、不发布。
 */

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

export interface FakeVaultOptions {
  /** Vault 内已有文件：路径 → 内容。 */
  files?: Record<string, string>;
  /** 是否把隐藏目录（`.` 开头）排除在索引之外；默认排除。 */
  hideDotPathsFromIndex?: boolean;
  /** 让指定路径的 cachedRead 返回过期内容（模拟宿主缓存落后）。 */
  staleCache?: Record<string, string>;
  /** 让指定路径的读取抛错（模拟权限/I/O 故障）。 */
  readErrors?: string[];
  /** 让指定路径的写入抛错。 */
  writeErrors?: string[];
}

interface FakeFile {
  path: string;
  content: string;
  mtime: number;
}

class FakeDataAdapter {
  private readonly vault: FakeVault;

  constructor(vault: FakeVault) {
    this.vault = vault;
  }

  async read(path: string): Promise<string> {
    const file = this.vault.rawFiles.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    if (this.vault.options.readErrors?.includes(path)) throw new Error(`EIO: ${path}`);
    return file.content;
  }

  async write(path: string, content: string): Promise<void> {
    if (this.vault.options.writeErrors?.includes(path)) throw new Error(`EACCES: ${path}`);
    this.vault.putRaw(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.vault.rawFiles.has(path) || this.vault.rawFolders.has(path);
  }

  async stat(path: string): Promise<{ mtime: number; size: number; type: 'file' | 'folder' }> {
    const file = this.vault.rawFiles.get(path);
    if (file) return { mtime: file.mtime, size: file.content.length, type: 'file' };
    if (this.vault.rawFolders.has(path)) return { mtime: 0, size: 0, type: 'folder' };
    throw new Error(`ENOENT: ${path}`);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path === '' ? '' : `${path}/`;
    const files: string[] = [];
    const folders: string[] = [];
    for (const file of this.vault.rawFiles.keys()) {
      if (!file.startsWith(prefix, 0)) continue;
      const rest = file.slice(prefix.length);
      if (rest.includes('/')) continue;
      files.push(file);
    }
    for (const folder of this.vault.rawFolders.keys()) {
      if (folder === path) continue;
      if (!folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      if (rest === '' || rest.includes('/')) continue;
      folders.push(folder);
    }
    return { files, folders };
  }

  async remove(path: string): Promise<void> {
    if (!this.vault.rawFiles.has(path)) throw new Error(`ENOENT: ${path}`);
    this.vault.deleteRaw(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.vault.rawFiles.get(oldPath);
    if (!file) throw new Error(`ENOENT: ${oldPath}`);
    this.vault.deleteRaw(oldPath);
    this.vault.putRaw(newPath, file.content);
  }

  async mkdir(path: string): Promise<void> {
    this.vault.rawFolders.add(path);
  }
}

export class FakeVault {
  readonly options: FakeVaultOptions;
  readonly rawFiles = new Map<string, FakeFile>();
  readonly rawFolders = new Set<string>();
  readonly adapter: FakeDataAdapter;
  /** 记录所有被调用的 Vault API（原生验收要看实际走了哪条路径）。 */
  readonly calls: string[] = [];
  private readonly index = new Map<string, TFile | TFolder>();
  private clock = 1_700_000_000_000;
  /** 底层同步次数：用于验证 adapter.list 会看到外部新写入。 */
  readonly adapterWrites: string[] = [];

  constructor(options: FakeVaultOptions = {}) {
    this.options = options;
    this.adapter = new FakeDataAdapter(this);
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.putRaw(path, content);
    }
  }

  /** 底层写入（模拟外部 CLI 直接落盘）。 */
  putRaw(path: string, content: string): void {
    this.clock += 1000;
    this.rawFiles.set(path, { path, content, mtime: this.clock });
    this.adapterWrites.push(path);
    this.reindex(path, content);
  }

  deleteRaw(path: string): void {
    this.rawFiles.delete(path);
    this.index.delete(path);
  }

  /** 外部改名后，索引与底层都要更新（模拟真实宿主的 rename 语义）。 */
  renameRaw(from: string, to: string): void {
    const file = this.rawFiles.get(from);
    if (!file) throw new Error(`ENOENT: ${from}`);
    this.deleteRaw(from);
    this.putRaw(to, file.content);
  }

  private indexed(path: string): boolean {
    if (path.split('/').some(segment => segment === '')) return false;
    if (this.options.hideDotPathsFromIndex === false) return true;
    return !path.split('/').some(segment => segment.startsWith('.'));
  }

  private reindex(path: string, content: string): void {
    const parents = path.split('/').slice(0, -1);
    let current = '';
    for (const segment of parents) {
      current = current === '' ? segment : `${current}/${segment}`;
      if (this.indexed(current)) this.index.set(current, new TFolder(current));
    }
    if (this.indexed(path)) {
      const file = this.rawFiles.get(path)!;
      this.index.set(path, new TFile(path, file.mtime, content.length));
    } else {
      this.index.delete(path);
    }
  }

  getFiles(): TFile[] {
    this.calls.push('getFiles');
    return [...this.index.values()].filter((entry): entry is TFile => entry instanceof TFile);
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    this.calls.push(`getAbstractFileByPath:${path}`);
    return this.index.get(path) ?? null;
  }

  async create(path: string, content: string): Promise<TFile> {
    this.calls.push(`create:${path}`);
    if (this.rawFiles.has(path)) throw new Error(`File already exists: ${path}`);
    this.putRaw(path, content);
    const file = this.index.get(path);
    if (!(file instanceof TFile)) {
      // 隐藏路径不会进索引：真实 Obsidian 的 create 仍然会返回 TFile。
      const raw = this.rawFiles.get(path)!;
      return new TFile(path, raw.mtime, content.length);
    }
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.calls.push(`modify:${file.path}`);
    this.putRaw(file.path, content);
  }

  /**
   * 比较-写入的同步原子区。
   *
   * 桩在这里**从底层真实字节**读当前内容（不是缓存），
   * 与真实 `vault.process` 的语义一致。
   */
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    this.calls.push(`process:${file.path}`);
    const raw = this.rawFiles.get(file.path);
    if (!raw) throw new Error(`ENOENT: ${file.path}`);
    const next = fn(raw.content);
    if (next !== raw.content) this.putRaw(file.path, next);
    return next;
  }

  async read(file: TFile): Promise<string> {
    this.calls.push(`read:${file.path}`);
    const raw = this.rawFiles.get(file.path);
    if (!raw) throw new Error(`ENOENT: ${file.path}`);
    if (this.options.readErrors?.includes(file.path)) throw new Error(`EIO: ${file.path}`);
    return raw.content;
  }

  async cachedRead(file: TFile): Promise<string> {
    this.calls.push(`cachedRead:${file.path}`);
    const stale = this.options.staleCache?.[file.path];
    if (stale !== undefined) return stale;
    const raw = this.rawFiles.get(file.path);
    if (!raw) throw new Error(`ENOENT: ${file.path}`);
    if (this.options.readErrors?.includes(file.path)) throw new Error(`EIO: ${file.path}`);
    return raw.content;
  }

  async delete(file: TFile): Promise<void> {
    this.calls.push(`delete:${file.path}`);
    this.deleteRaw(file.path);
  }

  async createFolder(path: string): Promise<TFolder> {
    this.calls.push(`createFolder:${path}`);
    this.rawFolders.add(path);
    const folder = new TFolder(path);
    if (this.indexed(path)) this.index.set(path, folder);
    return folder;
  }
}

/**
 * 假的 `requestUrl`。
 *
 * 默认拒绝一切网络访问（测试不该真的联网）。测试可以：
 * - `setRequestUrlHandler(fn)` 注入自己的传输行为（挂起 / 迟到响应 / HTTP 错误）；
 * - `requestUrlCalls` 读取真实发生的请求次数——「有没有发出去」必须可验证，
 *   因为「没有发送」与「发送了但没用结果」是两件不同的事。
 */
export interface FakeRequestUrlOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  throw?: boolean;
}

export interface FakeRequestUrlResponse {
  status: number;
  text: string;
  json?: unknown;
}

export const requestUrlCalls: FakeRequestUrlOptions[] = [];

let requestUrlHandler: ((options: FakeRequestUrlOptions) => Promise<FakeRequestUrlResponse>) | null = null;

export function setRequestUrlHandler(
  handler: ((options: FakeRequestUrlOptions) => Promise<FakeRequestUrlResponse>) | null,
): void {
  requestUrlHandler = handler;
}

export function resetRequestUrlCalls(): void {
  requestUrlCalls.length = 0;
}

export async function requestUrl(options: FakeRequestUrlOptions): Promise<FakeRequestUrlResponse> {
  requestUrlCalls.push(options);
  if (requestUrlHandler !== null) return await requestUrlHandler(options);
  throw new Error('测试桩拒绝了真实网络访问：请用 setRequestUrlHandler 注入假响应。');
}

/**
 * 极简 DOM 元素桩。
 *
 * `ItemView` / `Modal` / `Setting` 这些界面类的**方法体**在测试里不会被调用
 * （测试只用到服务层与命令层），但插件模块图在导入时必须能求值——
 * 子类要能 `extends`、类体里要能取到 `contentEl`。因此这里只需要一个
 * 「调用不报错」的元素，不需要真实的排版与事件系统。
 */
export class FakeElement {
  children: FakeElement[] = [];
  text = '';
  cls = '';
  readonly style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  empty(): void {
    this.children = [];
    this.text = '';
  }
  createEl(tag: string, options?: { text?: string; cls?: string }): FakeElement {
    void tag;
    const child = new FakeElement();
    if (options?.text !== undefined) child.text = options.text;
    if (options?.cls !== undefined) child.cls = options.cls;
    this.children.push(child);
    return child;
  }
  createDiv(options?: { text?: string; cls?: string }): FakeElement {
    return this.createEl('div', options);
  }
  addClass(cls: string): void {
    this.cls = this.cls === '' ? cls : `${this.cls} ${cls}`;
  }
  setText(text: string): void {
    this.text = text;
  }
  setAttr(): void {
    /* 桩不实现属性 */
  }
}

/**
 * 界面基类桩：只保证「能继承、能构造」。
 *
 * 这些类不是被测对象——插件的界面行为由原生 Obsidian 验收与源码契约检查覆盖；
 * 测试需要的是能真实导入**插件类本身**（`acceptSuggestion` 等业务方法在插件上）。
 */
export class Modal {
  readonly contentEl = new FakeElement();
  readonly titleEl = new FakeElement();
  readonly modalEl = new FakeElement();
  constructor(public app: unknown) {
    void app;
  }
  open(): void {
    /* 桩不打开窗口 */
  }
  close(): void {
    /* 桩不关闭窗口 */
  }
}

export class ItemView {
  readonly containerEl = new FakeElement();
  readonly contentEl = new FakeElement();
  constructor(public leaf: unknown) {
    void leaf;
  }
}

export class PluginSettingTab {
  readonly containerEl = new FakeElement();
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {
    void app;
    void plugin;
  }
  display(): void {
    /* 桩不渲染设置页 */
  }
}

export class Setting {
  constructor(public containerEl: unknown) {
    void containerEl;
  }
  setName(): this {
    return this;
  }
  setDesc(): this {
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
  addDropdown(): this {
    return this;
  }
}

export class Plugin {
  constructor(
    public app: unknown,
    public manifest: unknown,
  ) {
    void app;
    void manifest;
  }
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(): Promise<void> {
    /* 桩不落盘 */
  }
  addCommand(): void {
    /* 桩不注册命令 */
  }
  addRibbonIcon(): void {
    /* 桩不注册图标 */
  }
  addSettingTab(): void {
    /* 桩不注册设置页 */
  }
  registerView(): void {
    /* 桩不注册视图 */
  }
  registerEvent(): void {
    /* 桩不注册事件 */
  }
  registerDomEvent(): void {
    /* 桩不注册事件 */
  }
  registerInterval(): number {
    return 0;
  }
  register(): void {
    /* 桩不注册清理器 */
  }
}

export function setIcon(): void {
  /* 桩不渲染图标 */
}

export class Notice {
  static history: string[] = [];
  constructor(message: string, timeout?: number) {
    void timeout;
    Notice.history.push(message);
  }
  setMessage(): void {
    /* 桩不实现界面 */
  }
}

export function createFakeApp(vault: FakeVault): {
  vault: FakeVault;
  secretStorage: { getSecret(id: string): string | null; setSecret(id: string, value: string): void };
} {
  const secrets = new Map<string, string>();
  return {
    vault,
    secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => {
        secrets.set(id, value);
      },
    },
  };
}

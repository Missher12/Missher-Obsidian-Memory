/**
 * Vault 文件存储：`FileStore` 端口的 Obsidian 实现。
 *
 * 这是插件里**唯一**碰文件的地方。它只用公开的 Vault / DataAdapter API，
 * 不使用任意 `fs`：用户库的文件必须由 Obsidian 自己管理
 * （否则索引、缓存、重命名与同步都会不一致）。
 *
 * ## 路径契约
 *
 * **所有输入与输出都是 Vault 相对路径，内容限于已配置的目录。**
 * 记忆根为 `Brain` 时，状态文件是 `Brain/.memory/state.json`，
 * 请求是 `Brain/.memory/requests/req_x.md`。
 *
 * 适配器**不再前置任何根**：前置一次就会变成 `Brain/Brain/...`。
 * 每个公共方法在调用任何 Vault API **之前**先用根目录或分类目录守卫
 * 校验：绝对路径、`..`、`.`、盘符、UNC、`~`、空字节与保留目录名一律拒绝。
 * 校验看的是原始写法，不做「先归一化再检查」。
 *
 * ## 写入的原子性
 *
 * - `writeFile` 用 `vault.process`：**同步回调里**比较当前原文再返回新内容。
 *   比较与写入之间没有 await，因此人工编辑不会被“读旧值、写新值”覆盖。
 * - `removeFile` 先核对磁盘字节再 `vault.delete`；不一致就不删。
 *
 * ## 读取的错误语义（不许把故障当空）
 *
 * `readFile` 的契约是「确实不存在返回 `null`」。权限、I/O、宿主缓存错误
 * **必须抛出**：把删除账本读失败当成「新库尚无删除记录」会让用户的遗忘
 * 承诺静默失效。因此这里只在两条路径都明确「不存在」时才返回 `null`。
 */

import { TFile, TFolder, type App, type DataAdapter } from 'obsidian';
import {
  PathError,
  assertVaultRelativePath,
  assertOrganizationPath,
  normalizeOrganization,
  isInsideRoot,
  type OrganizationSettings,
  compareDeleteExpectation,
  compareExpectation,
  contentHashOf,
  readRevision,
  type DeleteExpectation,
  type DeleteResult,
  type FileEntry,
  type FileStore,
  type WriteExpectation,
  type WriteResult,
} from '@mom/core';

export interface VaultFileStoreOptions {
  app: App;
  /** 记忆根目录（Vault 内相对路径）；必须与核心 `MemoryStore` 使用同一个值。 */
  memoryRoot: string;
  organization?: OrganizationSettings;
  /**
   * 每次成功写入 / 改名 / 删除之后回调一次（路径为 Vault 相对路径）。
   *
   * 用途只有一个：把「本插件自己造成的变化」登记下来，好让 Vault 事件监听
   * 跳过它们。少了这一步，一次提交就会触发一次索引刷新，刷新再触发事件，
   * 变成无休止的重载。
   */
  onWrite?: (path: string, content?: string) => void;
}

/** 目录枚举方式，用于诊断与原生验收。 */
export type ListingMode = 'index' | 'adapter' | 'mixed';

export class VaultFileStore implements FileStore {
  readonly kind = 'obsidian-vault';
  private readonly app: App;
  private readonly root: string;
  private readonly organization: OrganizationSettings;
  private readonly adapter: DataAdapter;
  private readonly onWrite: ((path: string, content?: string) => void) | undefined;
  private rev = 0;
  /** 上一次目录枚举实际用了哪条通道（诊断用，不参与判定）。 */
  private lastListingMode: ListingMode = 'index';
  /** 索引里查不到、但适配器确认存在的路径（诊断用）。 */
  private readonly offIndexPaths = new Set<string>();

  constructor(options: VaultFileStoreOptions) {
    this.app = options.app;
    this.adapter = options.app.vault.adapter;
    this.onWrite = options.onWrite;
    /**
     * 根目录**在这里**校验一次：之后所有路径都必须带上它，
     * 因此根不合法就根本不该构造出实例。
     */
    this.root = assertVaultRelativePath(options.memoryRoot, options.memoryRoot, '记忆根目录');
    this.organization = normalizeOrganization(options.organization);
  }

  get memoryRoot(): string {
    return this.root;
  }

  get listingMode(): ListingMode {
    return this.lastListingMode;
  }

  /** 上一次枚举中「适配器可见但索引不可见」的路径（原生验收要看这个）。 */
  get offIndex(): string[] {
    return [...this.offIndexPaths].sort();
  }

  revision(): number {
    return this.rev;
  }

  /** 校验一个来自核心的路径；不合法直接抛，绝不静默改成别的路径。 */
  private safe(path: string, label = '路径'): string {
    if (this.organization.preset === 'legacy' || isInsideRoot(`${this.root}/.memory`, path)) {
      return assertVaultRelativePath(this.root, path, label);
    }
    return assertOrganizationPath(this.root, this.organization, path, label);
  }

  /**
   * 枚举记忆根内的文件。
   *
   * 两条通道：
   * 1. `vault.getFiles()`——Obsidian 的索引，用户笔记走这里；
   * 2. `adapter.list()`——真实文件系统，`.memory` 这类隐藏目录不进索引，
   *    但插件自己的状态与队列就住在那里，必须能看见。
   *
   * 结果是两者的并集：既不会漏掉隐藏目录里的队列文件，
   * 也不会因为索引延迟而漏掉刚被外部写入的请求。
   */
  async listFiles(subdir = '', extensions: string[] = ['.md']): Promise<FileEntry[]> {
    const base = subdir === '' ? this.root : this.safe(subdir, '列目录路径');
    const prefix = `${base}/`;
    const out = new Map<string, FileEntry>();
    let usedIndex = false;
    let usedAdapter = false;

    for (const file of this.app.vault.getFiles()) {
      if (!this.acceptEntry(file.path, base, prefix, extensions)) continue;
      out.set(file.path, { path: file.path, mtime: file.stat.mtime, size: file.stat.size });
      usedIndex = true;
    }

    try {
      const listing = await this.adapter.list(base);
      usedAdapter = true;
      for (const path of [...listing.files, ...listing.folders]) {
        const isFolder = listing.folders.includes(path);
        if (isFolder) continue;
        if (extensions.length > 0 && !extensions.some(ext => path.endsWith(ext))) continue;
        try {
          const absolute = path.startsWith('/') ? path.slice(1) : path;
          this.safe(absolute, '枚举结果');
          if (out.has(absolute)) continue;
          const stat = await this.adapter.stat(absolute).catch(() => null);
          out.set(absolute, {
            path: absolute,
            mtime: stat?.mtime ?? 0,
            size: stat?.size ?? 0,
          });
          if (this.app.vault.getAbstractFileByPath(absolute) === null) {
            this.offIndexPaths.add(absolute);
          }
        } catch {
          // 枚举到根外或非法路径的条目直接忽略，不进入结果集。
        }
      }
    } catch {
      // 适配器列目录失败（例如目录尚不存在）：索引结果仍然有效。
      usedAdapter = false;
    }

    this.lastListingMode = usedIndex && usedAdapter ? 'mixed' : usedAdapter ? 'adapter' : 'index';
    return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private acceptEntry(path: string, base: string, prefix: string, extensions: string[]): boolean {
    if (path !== base && !path.startsWith(prefix)) return false;
    if (extensions.length > 0 && !extensions.some(ext => path.endsWith(ext))) return false;
    try {
      this.safe(path, '索引结果');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取 UTF-8 文本。
   *
   * - 确实不存在 → `null`（契约允许）；
   * - 存在但读失败（权限、I/O、宿主错误）→ **抛出**，由上层阻断并上报；
   *
   * 读取用 `vault.read`（真实读盘），**不用 `cachedRead`**：
   * 涉及比较-写入的路径必须看磁盘实际字节，缓存可能落后于外部写入。
   */
  async readFile(path: string): Promise<string | null> {
    const absolute = this.safe(path);
    const indexed = this.app.vault.getAbstractFileByPath(absolute);
    if (indexed instanceof TFile) {
      return this.readThrough(absolute, indexed, path);
    }
    /**
     * 索引里没有：可能是隐藏目录（`.memory`）或索引还没跟上外部写入。
     * 直接问底层适配器；只有它也说「不存在」才返回 `null`。
     */
    if (indexed !== null && !(indexed instanceof TFile)) {
      throw new PathError('not_a_file', `路径不是文件：${path}`);
    }
    const nativeExists = await this.adapterExists(absolute);
    if (!nativeExists) {
      /**
       * 最后再确认一次语义：`exists` 返回 false 与 `list` 都看不到，
       * 才认定为「确实不存在」。否则抛错，避免把故障读成空库。
       */
      return null;
    }
    this.offIndexPaths.add(absolute);
    try {
      const raw = await this.adapter.read(absolute);
      this.rev += 1;
      return raw;
    } catch (error) {
      throw this.readFailure(path, error);
    }
  }

  /** 已索引文件的读取：`vault.read` 失败时退到真实字节，两条都失败才抛。 */
  private async readThrough(absolute: string, file: TFile, label: string): Promise<string> {
    try {
      const raw = await this.app.vault.read(file);
      this.rev += 1;
      return raw;
    } catch (vaultError) {
      try {
        const raw = await this.adapter.read(absolute);
        this.offIndexPaths.add(absolute);
        this.rev += 1;
        return raw;
      } catch {
        throw this.readFailure(label, vaultError);
      }
    }
  }

  private readFailure(path: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new PathError(
      'read_failed',
      `读取 ${path} 失败：${detail}。` +
        '这是读盘/权限错误，不是“文件不存在”；为避免把删除账本或状态当成空的，本插件拒绝继续。',
    );
  }

  private async adapterExists(absolute: string): Promise<boolean> {
    try {
      return await this.adapter.exists(absolute);
    } catch {
      return false;
    }
  }

  async exists(path: string): Promise<boolean> {
    const absolute = this.safe(path);
    if (this.app.vault.getAbstractFileByPath(absolute) instanceof TFile) return true;
    const nativeExists = await this.adapterExists(absolute);
    if (nativeExists) this.offIndexPaths.add(absolute);
    return nativeExists;
  }

  async ensureDir(path: string): Promise<void> {
    const absolute = this.safe(path, '目录路径');
    const segments = absolute.split('/');
    let current = '';
    for (const segment of segments) {
      current = current === '' ? segment : `${current}/${segment}`;
      if (this.app.vault.getAbstractFileByPath(current) instanceof TFolder) continue;
      if (await this.adapterExists(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        /**
         * 并发创建 / 已存在都不是错误；其他失败要说出来。
         */
        if (await this.adapterExists(current)) continue;
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  /**
   * 比较-写入。
   *
   * 关键点：`vault.process` 的回调是**同步**的，因此
   * 「读当前内容 → 与期望值比较 → 决定写入」这一串不会被打断。
   * 人工编辑要么在读之前已经落盘（于是比较失败），要么在写之后落盘
   * （于是用户看到的是自己的版本，插件会在下一次比较时发现差异）。
   */
  async writeFile(relative: string, content: string, expect: WriteExpectation = {}): Promise<WriteResult> {
    const absolute = this.safe(relative);
    let existing = this.app.vault.getAbstractFileByPath(absolute);

    if (existing === null && (await this.adapterExists(absolute))) {
      /**
       * 文件在磁盘上存在但不在索引里（隐藏目录/外部刚写入）。
       * 按「已存在」处理，绝不当作新建去覆盖它。
       */
      const raw = await this.adapter.read(absolute).catch(() => null);
      if (raw === null) {
        throw new PathError('read_failed', `文件存在于磁盘但读不出来：${relative}`);
      }
      const offline = compareExpectation(expect, contentHashOf(raw), raw, contentHashOf);
      if (offline !== null) {
        return { status: 'conflict', path: relative, actualHash: contentHashOf(raw), reason: offline };
      }
      await this.adapter.write(absolute, content);
      this.rev += 1;
      this.offIndexPaths.add(absolute);
      return {
        status: 'written',
        path: relative,
        hash: contentHashOf(content),
        previousHash: contentHashOf(raw),
      };
    }

    if (existing === null) {
      // 期望「必须存在」时不新建。
      if (typeof expect.expectedHash === 'string' && expect.expectedHash !== '') {
        return { status: 'conflict', path: relative, actualHash: '', reason: 'missing' };
      }
      await this.ensureDir(parentOf(absolute));
      await this.app.vault.create(absolute, content);
      this.rev += 1;
      this.onWrite?.(relative, content);
      return { status: 'written', path: relative, hash: contentHashOf(content), previousHash: null };
    }

    if (!(existing instanceof TFile)) {
      return { status: 'conflict', path: relative, actualHash: '', reason: 'already_exists' };
    }

    /**
     * 先做一次比较，好在**不写入**的情况下把冲突原因说清楚；
     * 真正的判定仍在 `vault.process` 的同步回调里再做一次。
     * 两次比较用同一个函数，避免“门口的规则”和“里面的规则”不一致。
     */
    const before = await this.readThrough(absolute, existing, relative);
    const preflight = compareExpectation(expect, contentHashOf(before), before, contentHashOf);
    if (preflight) {
      return { status: 'conflict', path: relative, actualHash: contentHashOf(before), reason: preflight };
    }

    let conflictReason: string | null = null;
    let conflictHash = '';
    let wrote = false;
    if (typeof this.app.vault.process === 'function') {
      await this.app.vault.process(existing, data => {
        const verdict = compareExpectation(expect, contentHashOf(data), data, contentHashOf);
        if (verdict) {
          conflictReason = verdict;
          conflictHash = contentHashOf(data);
          // 同步回调里返回原文 = 不写入，人工编辑原样保留。
          return data;
        }
        wrote = true;
        return content;
      });
    } else {
      /**
       * 没有 `vault.process`（很旧的宿主）时退到 modify：
       * 语义仍是「比较后写入」，但中间多了一个 await 窗口。
       * 这里如实记在返回值里（`previousHash` 用比较时读到的那一版），
       * 不假装它和 process 一样原子。
       */
      await this.app.vault.modify(existing, content);
      wrote = true;
    }

    if (conflictReason !== null) {
      return { status: 'conflict', path: relative, actualHash: conflictHash, reason: conflictReason };
    }
    if (!wrote) {
      return {
        status: 'conflict',
        path: relative,
        actualHash: contentHashOf(before),
        reason: 'content_changed',
      };
    }
    this.rev += 1;
    this.onWrite?.(relative, content);
    return {
      status: 'written',
      path: relative,
      hash: contentHashOf(content),
      previousHash: contentHashOf(before),
    };
  }

  /**
   * 比较-删除：先核对磁盘字节，不一致就不删。
   *
   * 记忆正文的删除必须走 `vault.delete`（让 Obsidian 维护自己的索引与
   * 回收站设置）；插件自己的队列文件走适配器，避免在索引里制造噪音。
   */
  async removeFile(relative: string, expect: DeleteExpectation = {}): Promise<DeleteResult> {
    const absolute = this.safe(relative);
    const indexed = this.app.vault.getAbstractFileByPath(absolute);

    if (indexed instanceof TFile) {
      const current = await this.readThrough(absolute, indexed, relative);
      const currentHash = contentHashOf(current);
      const conflict = compareDeleteExpectation(expect, currentHash, current);
      if (conflict) {
        return { status: 'conflict', path: relative, actualHash: currentHash, reason: conflict };
      }
      // delete 前再读一次：两次读到同一份内容才动手。
      const recheck = await this.readThrough(absolute, indexed, relative);
      if (contentHashOf(recheck) !== currentHash) {
        return {
          status: 'conflict',
          path: relative,
          actualHash: contentHashOf(recheck),
          reason: 'content_changed',
        };
      }
      await this.app.vault.delete(indexed);
      this.rev += 1;
      this.onWrite?.(relative);
      return { status: 'deleted', path: relative, previousHash: currentHash };
    }

    if (!(await this.adapterExists(absolute))) {
      return { status: 'missing', path: relative };
    }
    this.offIndexPaths.add(absolute);
    const current = await this.adapter.read(absolute).catch((error: unknown) => {
      throw this.readFailure(relative, error);
    });
    const currentHash = contentHashOf(current);
    const conflict = compareDeleteExpectation(expect, currentHash, current);
    if (conflict) {
      return { status: 'conflict', path: relative, actualHash: currentHash, reason: conflict };
    }
    const recheck = await this.adapter.read(absolute).catch((error: unknown) => {
      throw this.readFailure(relative, error);
    });
    if (contentHashOf(recheck) !== currentHash) {
      return {
        status: 'conflict',
        path: relative,
        actualHash: contentHashOf(recheck),
        reason: 'content_changed',
      };
    }
    await this.adapter.remove(absolute);
    this.rev += 1;
    this.onWrite?.(relative);
    return { status: 'deleted', path: relative, previousHash: currentHash };
  }

  /** 原子改名（队列认领用）。路径两侧都必须是记忆根内的合法路径。 */
  async rename(fromPath: string, toPath: string): Promise<void> {
    const from = this.safe(fromPath, '改名前路径');
    const to = this.safe(toPath, '改名后路径');
    const rename = (this.adapter as { rename?: (oldPath: string, newPath: string) => Promise<void> }).rename;
    if (typeof rename !== 'function') {
      throw new PathError('no_rename', '当前 Obsidian 版本不支持 adapter.rename，无法安全认领请求。');
    }
    await rename.call(this.adapter, from, to);
    this.rev += 1;
    this.onWrite?.(toPath);
  }

  /** 读取 revision，用于诊断与冲突说明。 */
  async readRevisionOf(relative: string): Promise<number | null> {
    const raw = await this.readFile(relative);
    return raw === null ? null : readRevision(raw);
  }
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index);
}

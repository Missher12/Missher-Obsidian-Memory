/**
 * 存储端口（Port）。
 *
 * 核心只认识这个接口：一个受根目录约束的、乐观并发的键值式文件存储。
 * Obsidian 端由 Vault API 实现（`Vault.process` 提供同步比较-写入原子区），
 * Node 端由 `node:fs` 实现（带独占锁文件的比较-写入）。
 *
 * 关键约定：`writeFile` 的冲突检查必须发生在后端自己的原子区内，不能由
 * 调用者“先读后写”。
 */

export interface FileEntry {
  /** 相对根目录的路径。 */
  path: string;
  /** 最后修改时间（毫秒）。 */
  mtime: number;
  /** 字节数。 */
  size: number;
}

export interface WriteExpectation {
  /**
   * 期望的当前内容哈希。
   * - `null`：期望文件不存在（创建语义）。
   * - 字符串：期望当前内容哈希等于它。
   * - `undefined`：不比较（仅用于插件自身状态文件与明确的覆盖写入）。
   */
  expectedHash?: string | null;
  /** 期望的当前 revision（从 frontmatter 读取）；仅作为附加保护。 */
  expectedRevision?: number;
}

export type WriteResult =
  | {
      status: 'written';
      path: string;
      hash: string;
      /** 写入前的哈希；null 表示新建。 */
      previousHash: string | null;
    }
  | {
      status: 'conflict';
      path: string;
      /** 磁盘上的当前哈希。 */
      actualHash: string;
      /** 磁盘上的当前 revision（若能解析）。 */
      actualRevision?: number;
      reason: 'content_changed' | 'already_exists' | 'missing' | 'revision_mismatch';
      /**
       * 给用户看的一句话说明（可选）。
       * `reason` 是给程序判断用的枚举，`message` 才是给人读的；
       * 两者并存，避免调用方为了显示而再去翻译枚举。
       */
      message?: string;
    };

export interface DeleteExpectation {
  /** 期望的当前内容哈希（必填语义：记忆删除必须提供）。 */
  expectedHash?: string;
  /** 期望的当前 revision；提供时一并核对。 */
  expectedRevision?: number;
}

export type DeleteResult =
  | { status: 'deleted'; path: string; previousHash: string }
  | { status: 'missing'; path: string }
  | { status: 'conflict'; path: string; actualHash: string; reason: 'content_changed' | 'revision_mismatch' };

export interface FileStore {
  /** 存储后端的稳定名称，用于冲突边界说明（`obsidian-vault` / `node-fs`）。 */
  readonly kind: string;
  /**
   * 列出根目录下所有匹配后缀的文件。
   * 只返回记忆根目录内部的路径；不得触碰用户库的其他区域。
   */
  listFiles(subdir?: string, extensions?: string[]): Promise<FileEntry[]>;
  /** 读取 UTF-8 文本；不存在返回 `null`。 */
  readFile(path: string): Promise<string | null>;
  /** 是否存在。 */
  exists(path: string): Promise<boolean>;
  /**
   * 原子比较-写入。返回真实结果，绝不抛出冲突。
   * 其他 I/O 失败（权限、磁盘）仍会抛出，由调用者上报。
   */
  writeFile(path: string, content: string, expect?: WriteExpectation): Promise<WriteResult>;
  /**
   * 原子比较-删除。**破坏性操作必须走这里，不能只比对缓存里的哈希**：
   * 期望值与实际磁盘字节的比较发生在后端自己的原子区内，
   * 因此“检查”与“删除”之间不存在竞态窗口。
   *
   * `expect.expectedHash` 为 `undefined` 时表示调用者明确接受无条件删除
   * （仅用于清理插件自己的临时文件）；记忆文件的删除必须传期望值。
   */
  removeFile(path: string, expect?: DeleteExpectation): Promise<DeleteResult>;
  /** 确保目录存在（Node 需要；Vault 是隐式的）。 */
  ensureDir(path: string): Promise<void>;
  /** 单调递增的修订计数，用于索引失效判断。 */
  revision(): number;
}

/** 取文本的稳定哈希；由后端统一实现，避免核心重复依赖。 */
export type HashFn = (text: string) => string;

/** 便于测试与内存场景的内存实现。 */
export class MemoryFileStore implements FileStore {
  readonly kind = 'memory';
  private readonly files = new Map<string, string>();
  private readonly clock: () => number;
  private rev = 0;
  private readonly hashFn: HashFn;

  constructor(options: { hash: HashFn; clock?: () => number; seed?: Record<string, string> }) {
    this.hashFn = options.hash;
    this.clock = options.clock ?? (() => Date.now());
    for (const [path, content] of Object.entries(options.seed ?? {})) {
      this.files.set(normalize(path), content);
    }
  }

  /** 测试助手：直接放置/读取原始内容。 */
  peek(path: string): string | null {
    return this.files.get(normalize(path)) ?? null;
  }

  /**
   * 测试助手：模拟用户在 Obsidian 之外手改文件。
   *
   * `cacheStale: true` 用来复现“写者手里的内容哈希已经过期”的真实窗口：
   * 磁盘内容变了，但 `MemoryStore` 的内存缓存还停留在上一版
   * （真实场景＝文件变更事件还没送达）。这种状态下提交的修正必须被拒绝。
   */
  simulateManualEdit(path: string, content: string, options: { cacheStale?: boolean } = {}): void {
    this.files.set(normalize(path), content);
    if (!options.cacheStale) this.rev += 1;
  }

  async listFiles(subdir = '', extensions = ['.md']): Promise<FileEntry[]> {
    const prefix = subdir === '' ? '' : `${normalize(subdir)}/`;
    const out: FileEntry[] = [];
    for (const [path, content] of this.files) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      if (extensions.length > 0 && !extensions.some(ext => path.endsWith(ext))) continue;
      out.push({ path, mtime: this.clock(), size: content.length });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(normalize(path)) ?? null;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalize(path));
  }

  async writeFile(path: string, content: string, expect: WriteExpectation = {}): Promise<WriteResult> {
    const key = normalize(path);
    const current = this.files.get(key) ?? null;
    const currentHash = current === null ? null : this.hashFn(current);
    const check = compareExpectation(expect, currentHash, current, this.hashFn);
    if (check) return { status: 'conflict', path: key, actualHash: currentHash ?? '', reason: check };
    this.files.set(key, content);
    this.rev += 1;
    return { status: 'written', path: key, hash: this.hashFn(content), previousHash: currentHash };
  }

  async removeFile(path: string, expect: DeleteExpectation = {}): Promise<DeleteResult> {
    const key = normalize(path);
    const current = this.files.get(key) ?? null;
    if (current === null) return { status: 'missing', path: key };
    const currentHash = this.hashFn(current);
    const conflict = compareDeleteExpectation(expect, currentHash, current);
    if (conflict) return { status: 'conflict', path: key, actualHash: currentHash, reason: conflict };
    this.files.delete(key);
    this.rev += 1;
    return { status: 'deleted', path: key, previousHash: currentHash };
  }

  async ensureDir(): Promise<void> {
    /* 内存实现无需目录 */
  }

  revision(): number {
    return this.rev;
  }
}

/**
 * 删除专用的期望值比较。
 * 与写入共用同一套语义，但缺省方向相反：写入不传期望=覆盖，
 * 删除不传期望=无条件；因此记忆删除的调用点必须显式传值（由 store 层强制）。
 */
export function compareDeleteExpectation(
  expect: DeleteExpectation,
  currentHash: string,
  currentContent: string,
): 'content_changed' | 'revision_mismatch' | null {
  if (typeof expect.expectedHash === 'string' && expect.expectedHash !== currentHash) {
    return 'content_changed';
  }
  if (typeof expect.expectedRevision === 'number') {
    const actual = readRevision(currentContent);
    if (actual !== null && actual !== expect.expectedRevision) return 'revision_mismatch';
  }
  return null;
}

/** 共享的期望值比较逻辑，保证两个后端语义一致。 */
export function compareExpectation(
  expect: WriteExpectation,
  currentHash: string | null,
  currentContent: string | null,
  hash: HashFn,
): 'content_changed' | 'already_exists' | 'missing' | 'revision_mismatch' | null {
  if (expect.expectedHash === null) {
    if (currentHash !== null) return 'already_exists';
  } else if (typeof expect.expectedHash === 'string') {
    if (currentHash === null) return 'missing';
    if (currentHash !== expect.expectedHash) return 'content_changed';
  }
  if (typeof expect.expectedRevision === 'number' && currentContent !== null) {
    const actual = readRevision(currentContent);
    if (actual !== null && actual !== expect.expectedRevision) return 'revision_mismatch';
  }
  return null;
}

/** 从原始文本里读取 revision；解析失败返回 null（不阻塞写入）。 */
export function readRevision(raw: string): number | null {
  const match = /^revision:\s*(\d+)\s*$/m.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function normalize(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

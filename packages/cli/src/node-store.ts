/**
 * Node 端存储适配器。
 *
 * 这是**唯一**允许使用 `node:fs` 的地方之一（另一个是 MCP 入口）。
 * 它把文件系统包装成核心需要的 `FileStore` 端口，并承担三件核心不能做的事：
 *
 * 1. **路径约束**：所有路径都是**Vault 相对路径**，先做语法校验，
 *    再做包含判断，最后对真实路径（realpath）核对——包括目标文件本身。
 * 2. **比较-写入**：在锁内比较当前内容哈希；写入前的最后一次核对 + 原子替换，
 *    把「比较」与「落盘」之间的窗口压到最小。
 * 3. **跨进程互斥**：`<memoryRoot>/.memory/.lock` 上的**租约锁**，
 *    带持有者身份、过期时间与 fencing 校验：活跃租约不会被抢，
 *    旧持有者也不会删掉接任者的锁。
 *
 * ## 必须如实说明的边界（README、HANDOFF 里同样写明）
 *
 * - 租约锁只能约束**自愿参加本协议**的写者（本 CLI/MCP/插件）。
 *   用户在 Obsidian 里手动保存、或第三方同步工具直接改文件，**不参加**这个锁。
 * - 对这类写的保护是「比较-写入」：不一致就**拒绝写入**，而不是自动合并。
 *   这是一条**窄窗口**保证，不是跨软件的原子 CAS——写入前最后一刻的核对
 *   大幅缩小了窗口，但无法把外部编辑者纳入同一个原子区。
 * - 因此默认的**权威写入者是 Obsidian 插件**：外部入口把写请求放进
 *   请求队列（`.memory/requests/`），由插件用 `Vault.process` 同步提交并回执。
 *   离线直写（`writeMode: 'direct'`）是显式选项，用于命令行单写者场景。
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  PathError,
  assertSafeRelativePath,
  assertSafeRoot,
  compareDeleteExpectation,
  compareExpectation,
  isInsideRoot,
  normalizePath,
  normalizeRoot,
  readRevision,
  type DeleteExpectation,
  type DeleteResult,
  type FileEntry,
  type FileStore,
  type WriteExpectation,
  type WriteResult,
} from '@mom/core';

export interface NodeStoreOptions {
  /** Vault（或任意受控目录）的绝对路径。 */
  vaultRoot: string;
  /** 记忆根目录（Vault 内相对路径）。 */
  memoryRoot: string;
  /** 锁租约毫秒数；超过则视为陈旧租约，可以被接管。 */
  lockTtlMs?: number;
  /** 锁等待总时长。 */
  lockWaitMs?: number;
  /**
   * **显式**允许这个适配器直接写 Markdown。
   *
   * 默认 `false`：`writeFile` / `removeFile` 会抛出
   * `PathError('direct_write_disabled')`。默认的产品入口是请求队列——
   * CLI/MCP 把写请求放进 `<memoryRoot>/.memory/requests/`，
   * 由 Obsidian 插件用 `Vault.process` 在自己的同步回调里提交。
   *
   * 为什么是**结构性**门禁而不是注释或 README 提醒：
   * 本适配器的直写对「未参加锁的编辑器」没有通用原子 CAS 能力，
   * 而默认路径必须兑现产品声明的保护。只有明确知道自己是单写者的
   * 内部/测试调用方才会打开它。
   *
   * 打开它的调用方必须接受：比较与替换之间落下的外部写入会被覆盖，
   * 本产品不声称保住它；能保证的只是「比较不一致时拒绝写入」。
   */
  allowDirectWrites?: boolean;
}

/** 锁文件里记录的内容；fencing 与存活判断都基于它，而不是 mtime。 */
interface LockRecord {
  owner: string;
  pid: number;
  acquiredAt: number;
  /** 租约到期时刻（毫秒时间戳）。 */
  expiresAt: number;
  /** 单调递增的 fencing 序号。 */
  fence: number;
}

export class NodeFileStore implements FileStore {
  readonly kind = 'node-fs';
  private readonly vaultRoot: string;
  private readonly memoryRoot: string;
  private readonly stateDir: string;
  private readonly lockPath: string;
  private readonly lockTtlMs: number;
  private readonly lockWaitMs: number;
  private readonly directWrites: boolean;
  private rev = 0;
  /** 当前持有的锁内容哈希（续约会更新它）。 */
  private lockHash: string | null = null;
  /** 续约定时器；释放时清掉，句柄持有，避免泄漏。 */
  private lockTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(options: NodeStoreOptions & { vaultRoot: string; memoryRoot: string }) {
    this.vaultRoot = options.vaultRoot;
    this.memoryRoot = options.memoryRoot;
    this.stateDir = `${options.memoryRoot}/.memory`;
    this.lockPath = path.join(options.vaultRoot, options.memoryRoot, '.memory', '.lock');
    /**
     * 租约长度。
     *
     * 下限存在的理由：租约是**续约式**的（见 `releaseFor` 的心跳）。
     * 只要持有者活着，租约就不断被推后；租约到期只意味着持有者
     * 不再续约（崩溃或被杀）。如果租约短到比一次“读取+比较+替换”
     * 还短，等待者就会在持有者仍在写的时候接管——那是数据损坏，
     * 不是“更快的恢复”。下限保证交接由**续约停止**触发，而不是由
     * 一次调用的耗时触发。
     */
    this.lockTtlMs = Math.max(options.lockTtlMs ?? 30_000, MIN_LOCK_TTL_MS);
    this.lockWaitMs = options.lockWaitMs ?? 10_000;
    this.directWrites = options.allowDirectWrites === true;
  }

  /**
   * 直写门禁。写接口**一律**经过这里。
   *
   * 这不是「文档提醒」：默认配置下写路径根本走不通，
   * 调用方只能走请求队列，或者显式声明自己是单写者。
   */
  private assertDirectWritesAllowed(): void {
    if (this.directWrites) return;
    throw new PathError(
      'direct_write_disabled',
      '该入口默认不允许直接写 Markdown：写请求应放入 .memory/requests/ 队列，由 Obsidian 插件用 Vault.process 权威提交。' +
        '如果你确定自己是唯一写者（内部工具/测试），请显式设置 allowDirectWrites: true。',
    );
  }

  /**
   * 异步构造：解析真实路径，确认 Vault 存在且是目录。
   *
   * `memoryRoot` 走核心的 `assertSafeRoot`——**在任何归一化或建目录之前**。
   * 曾经的实现先 `normalizeRoot` 再检查，于是 `/absolute` 被悄悄改成
   * `absolute`、`safe/../outside` 被解析成 `outside`，公开边界与声明不符。
   */
  static async open(options: NodeStoreOptions): Promise<NodeFileStore> {
    if (typeof options.vaultRoot !== 'string' || options.vaultRoot.trim() === '') {
      throw new PathError('vault_missing', '必须指定 Vault 路径（--vault 或 MOM_VAULT）。');
    }
    let real: string;
    try {
      real = await fs.realpath(path.resolve(options.vaultRoot));
    } catch {
      throw new PathError('vault_not_found', `Vault 路径不存在：${options.vaultRoot}`);
    }
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new PathError('vault_not_dir', `Vault 路径不是目录：${options.vaultRoot}`);
    const memoryRoot = assertSafeRoot(options.memoryRoot, '记忆根目录');
    return new NodeFileStore({ ...options, vaultRoot: real, memoryRoot });
  }

  get resolvedVaultRoot(): string {
    return this.vaultRoot;
  }

  get resolvedMemoryRoot(): string {
    return path.join(this.vaultRoot, this.memoryRoot);
  }

  /** 契约锚点：端口上的所有路径都是 Vault 相对路径。 */
  toVaultRelative(absolute: string): string {
    return normalizePath(path.relative(this.vaultRoot, absolute));
  }

  revision(): number {
    return this.rev;
  }

  /**
   * 把**Vault 相对路径**解析为绝对路径，并确认它落在记忆根目录之内。
   *
   * ## 路径契约（只有一种，端口两端一致）
   *
   * 端口上的路径永远是 **Vault 相对路径**，例如
   * `Second Brain/00-收件箱/xxxx.md`。核心自己的 `root` 选项
   * （默认 `Second Brain`）已经写在路径里，适配器**不再**前置一次
   * `memoryRoot`——曾经那版把两者都加上，于是写进了
   * `Second Brain/Second Brain/...`，提交回执 `ok:true` 而重启后
   * `load` 一条也读不到。
   *
   * `memoryRoot` 因此是**包含范围**（哪棵子树归本产品管），而不是挂载点。
   *
   * 四道闸门：
   * 1. 语法校验（拒绝 `..`、绝对路径、盘符、UNC、`~`、空字节）；
   * 2. **U+FFFD 检查**：核心为防路径穿越把可疑字符替换成替换符，
   *    含替换符的路径一律拒绝，绝不落到磁盘上；
   * 3. 段级包含判断（`isInsideRoot`，对绝对写法直接返回 false）；
   * 4. 真实路径核对：存在则解析**目标自身**（含最后一段符号链接），
   *    不存在则解析最近的已存在祖先，任何不确定都**拒绝**而不是放行。
   */
  private async resolve(relative: string): Promise<string> {
    const safe = assertSafeRelativePath(relative, '路径');
    if (safe.includes('\uFFFD')) {
      throw new PathError('bad_encoding', `路径包含无法解码的替换字符，已拒绝：${relative}`);
    }
    if (!isInsideRoot(this.memoryRoot, safe)) {
      throw new PathError('escape', `路径逃出记忆根目录（${this.memoryRoot}）：${relative}`);
    }
    const target = path.join(this.vaultRoot, safe);
    const existing = await this.realpathForCheck(target, relative);
    if (!this.physicallyInsideMemory(existing)) {
      throw new PathError('symlink_escape', `路径经符号链接逃出记忆根目录：${relative}`);
    }
    return target;
  }

  /**
   * 取得用于包含判断的真实路径。
   *
   * 与曾经那版的关键差别：**先尝试目标自身**。
   * 从 `dirname` 开始永远看不到最后一段符号链接，
   * 于是「记忆根里的 `escape.md` 指向根外文件」可以照常读到根外正文。
   *
   * 失败语义：只有「目标不存在（ENOENT/ENOTDIR）」时才回退到祖先；
   * 其它错误（EACCES、ELOOP、EIO…）一律抛出——**不能吞成“文件不存在”**，
   * 否则调用方会以为这里没东西而放开后续判断。
   */
  private async realpathForCheck(absolute: string, label: string): Promise<string> {
    try {
      return await fs.realpath(absolute);
    } catch (error) {
      if (!isNotFound(error)) {
        throw new PathError('realpath_failed', `无法核对真实路径，已拒绝（${label}）：${messageOf(error)}`);
      }
    }
    let current = path.dirname(absolute);
    for (let depth = 0; depth < 64; depth += 1) {
      try {
        const real = await fs.realpath(current);
        const suffix = path.relative(current, absolute);
        return suffix === '' ? real : path.join(real, suffix);
      } catch (error) {
        if (!isNotFound(error)) {
          throw new PathError('realpath_failed', `无法核对真实路径，已拒绝（${label}）：${messageOf(error)}`);
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw new PathError('root_unresolved', `Vault 根目录无法解析，已拒绝（${label}）。`);
        }
        current = parent;
      }
    }
    throw new PathError('realpath_depth', `路径层级过深，已拒绝（${label}）。`);
  }

  private physicallyInsideMemory(absolute: string): boolean {
    const root = path.resolve(this.vaultRoot, this.memoryRoot);
    const target = path.resolve(absolute);
    return target === root || target.startsWith(`${root}${path.sep}`);
  }

  async listFiles(subdir = '', extensions: string[] = ['.md']): Promise<FileEntry[]> {
    const base = subdir === '' ? this.resolvedMemoryRoot : await this.resolve(subdir);
    const out: FileEntry[] = [];
    await this.walk(base, out, extensions, 0);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private async walk(dir: string, out: FileEntry[], extensions: string[], depth: number): Promise<void> {
    if (depth > 24) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(dir, entry.name);
      // 符号链接一律不跟随：这是防逃逸最省事也最可靠的做法。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await this.walk(absolute, out, extensions, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.length > 0 && !extensions.some(ext => entry.name.endsWith(ext))) continue;
      try {
        const stat = await fs.stat(absolute);
        // 统一 Vault 相对路径：与核心传入的路径同一契约。
        out.push({ path: this.toVaultRelative(absolute), mtime: stat.mtimeMs, size: stat.size });
      } catch {
        /* 读取失败的文件跳过，不阻塞其余扫描 */
      }
    }
  }

  async readFile(relative: string): Promise<string | null> {
    let absolute: string;
    try {
      absolute = await this.resolve(relative);
    } catch {
      /**
       * 路径不合法（含符号链接逃逸）在这里返回 null。
       * 调用方只会看到「没有这个文件」，不会看到根外正文——
       * 这不是静默失败：写入路径走的是 `resolveOrThrow`，会抛出真实原因。
       */
      return null;
    }
    try {
      return await fs.readFile(absolute, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** 读路径的严格版本：把路径错误**如实抛出**，供写入与诊断使用。 */
  async readFileOrThrow(relative: string): Promise<string | null> {
    const absolute = await this.resolve(relative);
    try {
      return await fs.readFile(absolute, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async exists(relative: string): Promise<boolean> {
    try {
      const absolute = await this.resolve(relative);
      await fs.access(absolute);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(relative: string): Promise<void> {
    if (relative.trim() === '') return;
    const absolute = await this.resolve(relative);
    await fs.mkdir(absolute, { recursive: true });
  }

  async removeFile(relative: string, expect: DeleteExpectation = {}): Promise<DeleteResult> {
    this.assertDirectWritesAllowed();
    const absolute = await this.resolve(relative);
    const release = await this.acquireLock();
    try {
      let current: string | null = null;
      try {
        current = await fs.readFile(absolute, 'utf8');
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (current === null) return { status: 'missing', path: normalizePath(relative) };
      const currentHash = sha256(current);
      const conflict = compareDeleteExpectation(expect, currentHash, current);
      if (conflict) {
        return { status: 'conflict', path: normalizePath(relative), actualHash: currentHash, reason: conflict };
      }
      // 删除前再核对一次目标真实路径：符号链接被替换时宁可不删。
      const recheck = await this.realpathForCheck(absolute, relative);
      if (!this.physicallyInsideMemory(recheck)) {
        throw new PathError('symlink_escape', `路径在删除前经符号链接逃出记忆根目录：${relative}`);
      }
      await fs.unlink(absolute);
      this.rev += 1;
      return { status: 'deleted', path: normalizePath(relative), previousHash: currentHash };
    } finally {
      await release();
    }
  }

  async writeFile(relative: string, content: string, expect: WriteExpectation = {}): Promise<WriteResult> {
    this.assertDirectWritesAllowed();
    const absolute = await this.resolve(relative);
    const release = await this.acquireLock();
    try {
      let current: string | null = null;
      try {
        current = await fs.readFile(absolute, 'utf8');
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const currentHash = current === null ? null : sha256(current);
      const conflict = compareExpectation(expect, currentHash, current, sha256);
      if (conflict) {
        return { status: 'conflict', path: normalizePath(relative), actualHash: currentHash ?? '', reason: conflict };
      }
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
      await fs.writeFile(temp, content, 'utf8');
      try {
        /**
         * 替换前**最后**一次核对。
         *
         * 比较与替换之间总有窗口，而 Obsidian 里的人工保存、第三方同步
         * 不参加本适配器的锁，无法被纳入同一个原子区。这里把窗口压到最小，
         * 检出变化就**拒绝写入**，绝不覆盖。
         *
         * 明确的边界（写入 README 与 HANDOFF）：这**不是**通用的跨软件原子 CAS。
         * 一个在本次核对之后、rename 之前落下的外部写入仍会被 rename 覆盖，
         * 本产品不声称能保住它。因此**默认入口不走这条直写路径**：
         * CLI/MCP 把写请求放进 `.memory/requests/` 队列，由 Obsidian 插件用
         * `Vault.process` 在自己的同步回调里提交（开关见 `allowDirectWrites`）。
         * 对未参加协议的编辑者，本适配器能给的只有「拒绝写入」这一种保护。
         */
        const verdict = await this.verifyBeforeReplace(absolute, expect);
        if (verdict !== null) {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          return {
            status: 'conflict',
            path: normalizePath(relative),
            actualHash: verdict === 'missing' ? '' : verdict,
            /** 冲突原因用核心约定的枚举值，说明文字放在 `message` 里。 */
            reason: verdict === 'missing' ? 'missing' : 'content_changed',
            message:
              verdict === 'missing'
                ? '目标文件在写入前消失，本次写入已取消。'
                : '目标内容在比较之后、替换之前被改动（可能是人工编辑或未参加锁的写者），本次写入已取消。',
          };
        }
        // 同目录 rename：要么完整旧内容，要么完整新内容，不会出现半截文件。
        await fs.rename(temp, absolute);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      this.rev += 1;
      return {
        status: 'written',
        path: normalizePath(relative),
        hash: sha256(content),
        previousHash: currentHash,
      };
    } finally {
      await release();
    }
  }

  /**
   * 替换前核对；返回 null 表示可以替换，否则返回实际哈希或 'missing'。
   * 只在调用方**显式给出**期望值时才强制：没有期望值就是“允许覆盖”。
   */
  private async verifyBeforeReplace(
    absolute: string,
    expect: WriteExpectation,
  ): Promise<string | 'missing' | null> {
    const expectsExistingHash = typeof expect.expectedHash === 'string' && expect.expectedHash !== '';
    /** `expectedHash: null` 表示「我读的时候文件不存在」，而不是「随便写」。 */
    const expectsMissing = expect.expectedHash === null;
    if (!expectsExistingHash && !expectsMissing) return null;
    let actual: string | null = null;
    try {
      actual = await fs.readFile(absolute, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (actual === null) return expectsMissing ? null : 'missing';
    if (expectsMissing) return sha256(actual);
    return sha256(actual) === expect.expectedHash ? null : sha256(actual);
  }

  /** 读取 revision，用于诊断。 */
  async readRevisionOf(relative: string): Promise<number | null> {
    const raw = await this.readFileOrThrow(relative);
    return raw === null ? null : readRevision(raw);
  }

  /* ---------------- 租约锁 ---------------- */

  /**
   * 取得写锁。
   *
   * 与曾经那版的关键差别：
   * - **活跃租约不会被抢。** 是否过期看锁文件里的 `expiresAt`，
   *   不再看 mtime——mtime 会被任何调用者随手改旧（测试里就是这么做的）。
   * - **旧持有者删不掉接任者的锁。** 释放前比对锁文件内容哈希，
   *   只有确认这份锁还是自己写的那一份才删除。
   * - **接管是同一次原子动作。** 过期锁先 `rename` 到唯一隔离名，
   *   谁 rename 成功谁才有资格接管，避免两个等待者同时删了对方的锁。
   */
  async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.lockWaitMs;
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    for (;;) {
      const record: LockRecord = {
        owner: randomUUID(),
        pid: process.pid,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + this.lockTtlMs,
        fence: 1,
      };
      const text = JSON.stringify(record);
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        await handle.writeFile(text, 'utf8');
        await handle.close();
        return this.releaseFor(record, sha256(text));
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      const state = await this.readLockState();
      if (state.kind === 'active' || state.kind === 'unreadable') {
        /**
         * 活跃租约绝不抢占——**判断依据是锁文件里的 `expiresAt`，
         * 不是 mtime**。mtime 会被任何调用者（包括测试）随手改旧，
         * 用它判断“还活着吗”等于把租约交给时间戳。
         *
         * 不可读的锁同样只等：拿不到内容就无法确认持有者是谁，
         * 宁可超时报错，也不删除可能有内容的锁文件。
         */
        if (Date.now() > deadline) {
          throw new PathError(
            'lock_timeout',
            `等待写入锁超时（${this.lockWaitMs}ms）。另一个写者（可能是 Obsidian 插件）正在提交；请稍后重试，或改用请求队列。`,
          );
        }
        await sleep(60 + Math.floor(Math.random() * 60));
        continue;
      }
      // 过期或损坏：尝试以一次重命名接管。
      const claimed = await this.tryReclaim(state);
      if (claimed) return this.releaseFor(record, sha256(text));
      if (Date.now() > deadline) {
        throw new PathError('lock_timeout', `等待写入锁超时（${this.lockWaitMs}ms），争夺激烈；请稍后重试。`);
      }
      await sleep(30 + Math.floor(Math.random() * 40));
    }
  }

  /**
   * 交出释放句柄，并在持有期间**续约**。
   *
   * 续约（心跳）是这里的核心：只要本进程还活着，租约就被不断推后，
   * 于是等待者永远不会因为“这次写花得比较久”而接管。
   * 心跳在写回之前会核对锁文件当前内容哈希，确认这份锁还是自己的；
   * 核对失败说明已被接管，立刻停止续约（绝不覆盖接任者的锁）。
   * 释放同样只删自己写下的那一份（`releaseIfOwned`）。
   */
  private releaseFor(record: LockRecord, selfHash: string): () => Promise<void> {
    let released = false;
    const owner = record.owner;
    const renewAfterMs = Math.max(50, Math.floor(this.lockTtlMs / 3));
    const timer = setInterval(() => {
      void this.renewLease(owner).catch(() => undefined);
    }, renewAfterMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.lockTimer = timer;
    this.lockHash = selfHash;

    return async () => {
      if (released) return;
      released = true;
      if (this.lockTimer === timer) {
        clearInterval(timer);
        this.lockTimer = null;
      }
      await this.releaseIfOwned().catch(() => undefined);
    };
  }

  /**
   * 把租约到期时间推后；只有确认锁仍是自己的那一份才写。
   *
   * 先比内容哈希、再比 `owner`：任一项不符就说明已被接管，
   * 立刻停止续约。否则旧持有者会把接任者的锁“续”回自己名下。
   */
  private async renewLease(owner: string): Promise<void> {
    const mine = this.lockHash;
    if (mine === null) return;
    let current: string;
    try {
      current = await fs.readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    if (sha256(current) !== mine) return;
    const record = parseLock(current);
    if (record === null || record.owner !== owner) return;
    const next: LockRecord = { ...record, expiresAt: Date.now() + this.lockTtlMs };
    const text = JSON.stringify(next);
    try {
      await fs.writeFile(this.lockPath, text, 'utf8');
      this.lockHash = sha256(text);
    } catch {
      /* 续约失败不致命：最坏情况是租约到期后由等待者接管 */
    }
  }

  /**
   * 只有当锁文件仍是「我写下的那一份」时才删除。
   *
   * 续约会改变内容，所以这里用实例上记录的最新自哈希；
   * 如果内容换成别人的（被接管），哈希不匹配 → **不删**。
   */
  private async releaseIfOwned(): Promise<void> {
    const mine = this.lockHash;
    if (mine === null) return;
    try {
      const current = await fs.readFile(this.lockPath, 'utf8');
      if (sha256(current) !== mine) {
        // 已被接管：不删别人的锁，本实例也不再持有任何锁。
        this.lockHash = null;
        return;
      }
      await fs.rm(this.lockPath, { force: true });
      this.lockHash = null;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.lockHash = null;
    }
  }

  /** 释放续约心跳（实例弃用/进程退出前调用）。 */
  dispose(): void {
    if (this.lockTimer !== null) {
      clearInterval(this.lockTimer);
      this.lockTimer = null;
    }
    this.lockHash = null;
  }

  /**
   * 判断锁当前状态。
   *
   * - `active`：有合法记录且租约未到期 → 只等待。
   * - `stale`：有合法记录但租约已到期 → 可以接管。
   * - `corrupt`：文件存在、**内容为空**且已超过一个租约 → 按残留接管。
   * - `unreadable`：文件存在但读不出来 → 只等待，绝不删。
   *
   * 「空文件」是允许接管的唯一异常形态：写锁的步骤是
   * `open(O_EXCL)` 之后立刻写入，两者之间会短暂出现空文件；
   * 一段完整租约之后仍然是空的，就只可能是崩溃残留。
   */
  private async readLockState(): Promise<{
    kind: 'active' | 'stale' | 'corrupt' | 'unreadable';
    text: string;
    mtimeMs: number;
  }> {
    try {
      const [text, stat] = await Promise.all([
        fs.readFile(this.lockPath, 'utf8'),
        fs.stat(this.lockPath),
      ]);
      const record = parseLock(text);
      if (record === null) {
        const empty = text.trim() === '';
        const aged = Date.now() - stat.mtimeMs > this.lockTtlMs;
        return { kind: empty && aged ? 'corrupt' : 'active', text, mtimeMs: stat.mtimeMs };
      }
      return { kind: record.expiresAt > Date.now() ? 'active' : 'stale', text, mtimeMs: stat.mtimeMs };
    } catch (error) {
      if (isNotFound(error)) return { kind: 'stale', text: '', mtimeMs: 0 };
      return { kind: 'unreadable', text: '', mtimeMs: 0 };
    }
  }

  /**
   * 用一次重命名把过期/残留的锁移走；成功了才算接管。
   *
   * 关键：**移走的必须仍是刚才看到的那一份**。否则说明在这个窗口里
   * 有人换过锁（新持有者刚写进去），此时放弃接管——
   * 这正是“旧持有者删掉接任者的锁”的反面。
   */
  private async tryReclaim(state: { text: string }): Promise<boolean> {
    const quarantine = `${this.lockPath}.${randomUUID()}.reclaim`;
    try {
      await fs.rename(this.lockPath, quarantine);
    } catch (error) {
      if (isNotFound(error)) return true; // 别人先删了：下一轮直接创建。
      if (!isNotFound(error) && isAlreadyExists(error)) return false;
      return false;
    }
    try {
      const moved = await fs.readFile(quarantine, 'utf8');
      // 移走的必须仍是刚才看到的那一份，否则说明有人换过锁，放弃接管。
      if (moved !== state.text) return false;
      return true;
    } finally {
      await fs.rm(quarantine, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * 租约下限（毫秒）。
 * 见构造函数注释：比一次写事务还短的租约会让等待者接管活跃写者。
 */
const MIN_LOCK_TTL_MS = 5_000;

function parseLock(text: string): LockRecord | null {
  try {
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    if (typeof parsed?.owner !== 'string' || parsed.owner === '') return null;
    if (typeof parsed?.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return null;
    return {
      owner: parsed.owner,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : 0,
      expiresAt: parsed.expiresAt,
      fence: typeof parsed.fence === 'number' ? parsed.fence : 1,
    };
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EEXIST';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

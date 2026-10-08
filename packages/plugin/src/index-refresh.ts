/**
 * 索引跟随刷新（有界、可测、不依赖 Obsidian）。
 *
 * ## 为什么需要它
 *
 * 插件启动时把记忆库读进内存索引，之后用户在 Obsidian 里用**普通编辑器**
 * 改动、重命名或删除笔记，索引并不会自己知道。于是工作台、带来源问答、
 * 复盘都在拿旧快照做判断——这正是审计指出的缺口。
 *
 * ## 自我约束
 *
 * 1. **只关心记忆根之内**：根之外的笔记一个字都不读，不扫描整个库；
 * 2. **跳过自己写入**造成的事件：否则一次提交触发一次刷新，刷新又触发
 *    事件，变成无休止的重载（这是最容易写出的死循环）；
 * 3. **有界合并**：事件先攒进一个集合，安静 `debounceMs` 之后合并成一次
 *    刷新；如果改动一直不停，最多拖 `maxWaitMs` 就强制刷一次（不会因为
 *    你一直在编辑就永远不刷新）；
 * 4. **不与提交抢**：刷新前问一次「现在能重载吗」，提交进行中就推迟，
 *    宁可短暂看到旧内容，也不要读进半截内容；
 * 5. **不重入**：一次只跑一个刷新；刷新期间到达的事件排到下一轮。
 *
 * 这个类不认识 Obsidian，定时器与判断都由调用方注入，因此可以确定性地测试。
 */

import { contentHashOf } from '@mom/core';

export interface RefreshMonitorOptions {
  /** 记忆根目录（Vault 内相对路径，不带首尾斜杠）。 */
  memoryRoot: string;
  /** 真正执行重载。抛错会被报给调用方，不会被吞掉。 */
  refresh: () => Promise<void>;
  /** 当前是否不适合重载（例如队列正在提交）。 */
  isBusy?: () => boolean;
  /** 出错回调（用于界面提示）。 */
  onError?: (message: string) => void;
  /** 刷新完成的回调（用于刷新视图）。 */
  onRefreshed?: () => void;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  now?: () => number;
  debounceMs?: number;
  maxWaitMs?: number;
}

export interface RefreshStats {
  /** 真正完成的刷新次数。 */
  refreshes: number;
  /** 最近一次刷新时间（毫秒时间戳，0 表示还没刷过）。 */
  lastAt: number;
  /** 还在等待处理的路径数。 */
  pending: number;
  /** 因为被自己写入而跳过的路径数。 */
  selfSkipped: number;
}

export class IndexRefreshMonitor {
  private readonly options: Required<Pick<RefreshMonitorOptions, 'memoryRoot' | 'refresh'>> &
    Omit<RefreshMonitorOptions, 'memoryRoot' | 'refresh'>;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pending = new Set<string>();
  /**
   * 本插件近期自己写下的路径 → `{ at, hash }`。
   *
   * `hash` 是那次写入的**内容哈希**（拿不到内容时为 null）。
   * 判定「这是不是自写事件」靠的是**比对当前磁盘内容**，
   * 时间只用于清理过期条目。
   */
  private readonly selfWrites = new Map<string, { at: number; hash: string | null }>();
  /** 记忆根内的协议目录：它们的变化不会影响索引，不该触发刷新。 */
  private readonly protocolDirs: string[] = [];
  private timer: unknown = null;
  private firstQueuedAt = 0;
  private inFlight = false;
  private refreshes = 0;
  private lastAt = 0;
  private selfSkipped = 0;

  constructor(options: RefreshMonitorOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? 400;
    this.maxWaitMs = options.maxWaitMs ?? 3_000;
    /**
     * `.memory` 与 `_exports` 是协议/导出目录，不是记忆。
     * 插件每次提交都会改 `.memory/` 下的状态与回执——如果那些事件也触发刷新，
     * 刷新又会写状态，就会变成「自己喂自己」的循环。
     * 这里直接把它们排除在**触发刷新**之外（它们本来也不进索引）。
     */
    const root = normalize(options.memoryRoot);
    this.protocolDirs = [`${root}/.memory`, `${root}/_exports`];
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private schedule(handler: () => void, ms: number): unknown {
    return this.options.setTimeoutFn ? this.options.setTimeoutFn(handler, ms) : setTimeout(handler, ms);
  }

  private cancel(handle: unknown): void {
    if (this.options.clearTimeoutFn) this.options.clearTimeoutFn(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  /**
   * 登记一次本插件的写入。
   *
   * `writtenContent` 是这次写下的内容（拿得到就给，用于精确判定）。
   * 若不给，判定时**必须**能读到当前内容才能证明「还是那一版」；
   * 两者都没有时**不跳过**——宁多刷一次，也不能把人工修改吃掉。
   */
  noteSelfWrite(vaultPath: string, writtenContent?: string): void {
    const key = normalize(vaultPath);
    this.selfWrites.set(key, {
      at: this.now,
      hash: typeof writtenContent === 'string' ? contentHashOf(writtenContent) : null,
    });
    if (this.selfWrites.size > 200) {
      const cutoff = this.now - 5_000;
      for (const [path, entry] of this.selfWrites) {
        if (entry.at < cutoff) this.selfWrites.delete(path);
      }
    }
  }

  /** 记忆根内的协议目录（`.memory` / `_exports`）：变化不影响索引。 */
  private isProtocolPath(key: string): boolean {
    return this.protocolDirs.some(dir => key === dir || key.startsWith(`${dir}/`));
  }

  /**
   * 这次事件是不是「我们自己写的那一版」。
   *
   * 判定**不看时间窗**，只看内容：
   *
   * - 登记时记下了那次写下的内容哈希 `hash`，
   *   且这次事件带来的当前内容哈希与它**一致** → 自写（跳过刷新）；
   * - 登记时没有内容（`hash === null`）→ 证明不了 → **不跳过**；
   * - 当前内容哈希和登记值不同 → 人工改过 → **不跳过**；
   * - 调用方给不出当前内容哈希 → **不跳过**。
   *
   * 用内容比对代替时间窗，是这次修复的核心：人工完全可能在插件写完的
   * 5 秒内手改同一个文件（比如把 `allow_model` 关掉）。
   * 旧的「5 秒内一律跳过」会把这次修改吃掉，缓存里仍是 `allow_model: true`，
   * 于是带来源问答会把用户刚设为私密的内容发出去。
   *
   * 代价说明：`Vault.read`/`cachedRead` 都是异步的，**生产路径上取不到
   * 同步的当前内容**，因此真实运行时会落在最后一条：
   * 同一个文件的自写事件也会排队刷新一次（比修复前多，但每次写入只多一次
   * 只读重载，不会再写入、不会自我循环——协议目录已被排除）。
   *
   * 这个取舍是故意的：多读一遍盘的代价，
   * 远小于「把用户刚设为私密的内容发出去」的代价。
   * 内容一致时的精确跳过留给能同步取到内容的调用方（见 `onVaultEvent`）。
   */
  private isSelfWrite(key: string, currentHash?: string | null): boolean {
    const entry = this.selfWrites.get(key);
    if (entry === undefined) return false;
    if (entry.hash === null) return false;
    if (typeof currentHash !== 'string' || currentHash === '') return false;
    return currentHash === entry.hash;
  }

  /** 这个路径是否在记忆根之内（根自身也算）。 */
  touchesRoot(vaultPath: string | null | undefined): boolean {
    const path = normalize(vaultPath ?? '');
    const root = normalize(this.options.memoryRoot);
    if (path === '' || root === '') return false;
    return path === root || path.startsWith(`${root}/`);
  }

  /**
   * 处理一次 Vault 事件。
   *
   * 返回「这次事件被怎么处理了」，方便调用方与测试断言，而不是靠猜：
   * - `ignored`：不在记忆根内；
   * - `self`：是本插件自己写入造成的；
   * - `queued`：已排队，稍后合并刷新。
   */
  onVaultEvent(vaultPath: string | null | undefined, currentContent?: string | null): 'ignored' | 'self' | 'queued' {
    if (!this.touchesRoot(vaultPath)) return 'ignored';
    const key = normalize(vaultPath ?? '');
    // 协议目录（`.memory` / `_exports`）的变化不进索引，也不该触发刷新。
    if (this.isProtocolPath(key)) return 'ignored';
    /**
     * `currentContent` 是**这次事件对应的当前内容**（调用方能同步拿到就给）。
     *
     * 给不出来时不跳过——判定要靠内容，不能靠时间。
     */
    const currentHash = typeof currentContent === 'string' ? contentHashOf(currentContent) : null;
    if (this.isSelfWrite(key, currentHash)) {
      this.selfSkipped += 1;
      return 'self';
    }
    this.enqueue(key);
    return 'queued';
  }

  private enqueue(path: string): void {
    this.pending.add(path);
    const now = this.now;
    if (this.timer !== null) {
      // 已经有等待中的刷新：攒得够久就先刷，避免一直往后拖。
      if (now - this.firstQueuedAt < this.maxWaitMs) return;
      this.cancel(this.timer);
    }
    this.firstQueuedAt = now;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  /** 立刻执行一次刷新（忽略防抖；仍然遵守「不重入」与「忙则推迟」）。 */
  async run(): Promise<'refreshed' | 'deferred' | 'busy'> {
    if (this.inFlight) {
      // 刷新期间到达的事件留给下一轮，不并发重入。
      return 'busy';
    }
    if (this.options.isBusy?.() === true) {
      this.timer = this.schedule(() => {
        this.timer = null;
        void this.run();
      }, this.debounceMs);
      return 'deferred';
    }
    this.inFlight = true;
    this.pending.clear();
    try {
      await this.options.refresh();
      this.refreshes += 1;
      this.lastAt = this.now;
      this.options.onRefreshed?.();
      return 'refreshed';
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
      return 'deferred';
    } finally {
      this.inFlight = false;
    }
  }

  /** 取消尚未执行的定时刷新（卸载时调用，避免回调打到已销毁的插件上）。 */
  dispose(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.selfWrites.clear();
  }

  stats(): RefreshStats {
    return {
      refreshes: this.refreshes,
      lastAt: this.lastAt,
      pending: this.pending.size,
      selfSkipped: this.selfSkipped,
    };
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

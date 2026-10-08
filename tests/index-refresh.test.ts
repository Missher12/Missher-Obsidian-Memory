/**
 * 索引跟随刷新的边界测试。
 *
 * 这里测的是**插件真实的刷新策略**（`IndexRefreshMonitor` 的接线就是插件用的那一个），
 * 不是另写一套模拟：
 * 1. 根之外的事件完全不碰；
 * 2. 自己写入造成的事件必须跳过（否则就是无限刷新）；
 * 3. 一堆事件合并成一次刷新，且长时间不停歇时**有界**（不会永远不刷）；
 * 4. 刷新不重入；队列忙的时候推迟；
 * 5. 刷新失败要如实上报，不能假装刷新成功。
 */

import { describe, expect, it } from 'vitest';
import { IndexRefreshMonitor } from '../packages/plugin/src/index-refresh.js';

/** 手动时钟 + 手动定时器：测试里没有真实等待。 */
function harness(options: { memoryRoot?: string; isBusy?: () => boolean } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  /** 定时器触发顺序记录，供有界性断言使用。 */
  let refreshes = 0;
  let failNext = false;
  const errors: string[] = [];
  const refreshed: number[] = [];
  const monitor = new IndexRefreshMonitor({
    memoryRoot: options.memoryRoot ?? 'Second Brain',
    refresh: async () => {
      if (failNext) {
        failNext = false;
        throw new Error('磁盘暂时读不出来');
      }
      refreshes += 1;
    },
    isBusy: options.isBusy,
    onError: message => errors.push(message),
    onRefreshed: () => refreshed.push(now),
    now: () => now,
    setTimeoutFn: (handler, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, handler });
      return id;
    },
    clearTimeoutFn: handle => {
      timers.delete(handle as number);
    },
    debounceMs: 400,
    maxWaitMs: 3_000,
  });
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    // 按时间顺序执行到期定时器；执行中新排的定时器也参与这一轮。
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      timers.delete(id);
      now = Math.max(now, timer.at);
      timer.handler();
      // 让 setTimeout 回调里的 await 推进。
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = until;
  };
  return {
    monitor,
    advance,
    errors,
    refreshed,
    failNext: () => {
      failNext = true;
    },
    refreshCount: () => refreshes,
    pendingTimers: () => timers.size,
  };
}

describe('索引跟随刷新', () => {
  it('记忆根之外的文件变化完全不触发刷新', async () => {
    const h = harness();
    expect(h.monitor.onVaultEvent('日记/2026-10-09.md')).toBe('ignored');
    expect(h.monitor.onVaultEvent('Second Brain 备份/旧.md')).toBe('ignored');
    expect(h.monitor.onVaultEvent('')).toBe('ignored');
    await h.advance(5_000);
    expect(h.refreshCount()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });

  it('根内的批量变化合并成一次刷新（不是每个文件刷一次）', async () => {
    const h = harness();
    for (let index = 0; index < 20; index += 1) {
      expect(h.monitor.onVaultEvent(`Second Brain/00-收件箱/note-${index}.md`)).toBe('queued');
    }
    await h.advance(500);
    expect(h.refreshCount()).toBe(1);
    expect(h.refreshed.length).toBe(1);
  });

  it('连续不断的改动下依然有界：不会因为一直在编辑就永远不刷新', async () => {
    const h = harness();
    // 每 100ms 来一次改动，持续 9 秒，模拟「用户一直在编辑」。
    for (let step = 0; step < 90; step += 1) {
      h.monitor.onVaultEvent('Second Brain/笔记.md');
      await h.advance(100);
    }
    expect(h.refreshCount()).toBeGreaterThan(0);
    /**
     * 有界性的准确表述：**任意两次刷新之间的间隔不超过 maxWait（3 秒）**。
     * 这条断言是关键的——如果哪天有人把 maxWait 去掉，改动不停时
     * 定时器会被反复重置，索引就再也不会刷新（而测试若不测这一点会漏掉）。
     */
    const times = h.refreshed;
    expect(times.length).toBe(h.refreshCount());
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeLessThanOrEqual(3_000);
    }
  });

  /**
   * 自写判定必须**按内容**，不能按时间窗。
   *
   * 审计复现的缺口：人工在插件写完的 5 秒内手改同一个文件
   * （典型动作：把 `allow_model` 从 true 改成 false），
   * 旧实现把这个事件当「自写」丢掉，缓存里仍是 `allow_model: true`，
   * 于是带来源问答会把用户刚设为私密的内容发给模型。
   */
  it('内容一致的自写事件被跳过（不会自触发无限刷新）', async () => {
    const h = harness();
    const written = '---\nallow_model: true\n---\n\n正文\n';
    h.monitor.noteSelfWrite('Second Brain/mem_abc.md', written);
    expect(h.monitor.onVaultEvent('Second Brain/mem_abc.md', written)).toBe('self');
    await h.advance(5_000);
    expect(h.refreshCount()).toBe(0);
    expect(h.monitor.stats().selfSkipped).toBe(1);
  });

  it('同一路径在 5 秒内被人工改成别的内容 → 必须刷新（不许被时间窗吃掉）', async () => {
    const h = harness();
    h.monitor.noteSelfWrite('Second Brain/mem_abc.md', '---\nallow_model: true\n---\n\n正文\n');
    // 人工把许可关掉：内容哈希变了，即便只过了 1 秒也必须刷新。
    await h.advance(1_000);
    expect(h.monitor.onVaultEvent('Second Brain/mem_abc.md', '---\nallow_model: false\n---\n\n正文\n')).toBe('queued');
    await h.advance(500);
    expect(h.refreshCount()).toBe(1);
    expect(h.monitor.stats().selfSkipped).toBe(0);
  });

  it('拿不到当前内容时按「证明不了」处理：刷新，而不是假设是自写', async () => {
    const h = harness();
    // 登记时没给内容 → 没有可比对的哈希。
    h.monitor.noteSelfWrite('Second Brain/mem_unknown.md');
    expect(h.monitor.onVaultEvent('Second Brain/mem_unknown.md')).toBe('queued');
    // 登记了内容，但事件没带当前内容（生产路径上读盘是异步的）。
    h.monitor.noteSelfWrite('Second Brain/mem_abc.md', '正文');
    expect(h.monitor.onVaultEvent('Second Brain/mem_abc.md')).toBe('queued');
    await h.advance(500);
    expect(h.refreshCount()).toBe(1);
  });

  it('协议目录（.memory / _exports）的变化既不刷新也不算自写', async () => {
    const h = harness();
    expect(h.monitor.onVaultEvent('Second Brain/.memory/requests/req_x.md')).toBe('ignored');
    expect(h.monitor.onVaultEvent('Second Brain/.memory/state.json')).toBe('ignored');
    expect(h.monitor.onVaultEvent('Second Brain/_exports/candidate.json')).toBe('ignored');
    await h.advance(5_000);
    expect(h.refreshCount()).toBe(0);
  });

  it('刷新不重入：刷新期间的调用被拒绝，事件留给下一轮', async () => {
    const h = harness();
    let release: (() => void) | null = null;
    let block = true;
    const slow = new IndexRefreshMonitor({
      memoryRoot: 'Second Brain',
      refresh: () =>
        new Promise<void>(resolve => {
          if (!block) {
            resolve();
            return;
          }
          release = resolve;
        }),
      now: () => 1,
    });
    const first = slow.run();
    expect(await slow.run()).toBe('busy');
    block = false;
    release?.();
    await first;
    void h;
  });

  it('队列正在提交时推迟刷新，忙完之后补上', async () => {
    let busy = true;
    const h = harness({ isBusy: () => busy });
    h.monitor.onVaultEvent('Second Brain/mem_1.md');
    await h.advance(500);
    // 忙的时候不重载：宁可短暂看到旧内容，也不读半截内容。
    expect(h.refreshCount()).toBe(0);
    busy = false;
    await h.advance(1_000);
    expect(h.refreshCount()).toBe(1);
  });

  it('刷新失败如实上报，不假装成功', async () => {
    const h = harness();
    h.failNext();
    h.monitor.onVaultEvent('Second Brain/mem_2.md');
    await h.advance(500);
    expect(h.refreshCount()).toBe(0);
    expect(h.errors).toEqual(['磁盘暂时读不出来']);
    expect(h.refreshed.length).toBe(0);
  });

  it('dispose 之后不再有回调打到插件上', async () => {
    const h = harness();
    h.monitor.onVaultEvent('Second Brain/mem_3.md');
    h.monitor.dispose();
    await h.advance(5_000);
    expect(h.refreshCount()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });
});

/**
 * 第二轮独立审查的反例回归。
 *
 * 每个 `it` 对应审查回执里的一条真实复现（audit-storage-initial.md /
 * audit-ai-jobs-initial.md）。这些用例**故意**构造当时导致失败的最小输入，
 * 用来锁死修复；如果哪天有人把防护改回去，这里会立刻变红。
 *
 * 注意：这里只改实现来通过测试，绝不放宽断言去迁就实现。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROOT,
  MemoryStore,
  OpenAiCompatibleProvider,
  assertSafeRoot,
  buildProfileView,
  isInsideRoot,
  JobQueue,
  createJob,
  emptyQueueState,
  mayCommit,
  mergeSettings,
  buildMethodCandidate,
  newBridgeItem,
  parseTombstones,
  requestRecall,
  runAiReview,
  serializeTombstones,
  type BridgeItem,
  type ChatResult,
  type JobRecord,
  type MemoryRecord,
  type TombstoneFile,
} from '@mom/core';
import { T0, fixedClock, memoryStore, seededRand } from './helpers.js';
import { sha256Hex } from '@mom/core';

/** 建一个队列 + 一个已开始的作业，供作业门禁用例复用。 */
function fixtureQueue(): { queue: JobQueue; job: JobRecord } {
  const queue = new JobQueue(emptyQueueState('inst-1', T0));
  const job = createJob({ id: 'job-1', kind: 'session_end', scope: 'personal', trigger: 'session_end', now: T0 });
  queue.add(job);
  queue.start(job.id, T0 + 1);
  return { queue, job: queue.get(job.id)! };
}

function makeStore(seed?: Record<string, string>) {
  const clock = fixedClock(T0);
  const fs = memoryStore(seed);
  const store = new MemoryStore({ store: fs, root: 'Second Brain', now: clock.now, rand: seededRand(11) });
  return { store, fs, clock };
}

/** 把某条记忆的 frontmatter 改成“派生自 sourceId@revision”。 */
function markDerivedFrom(fs: ReturnType<typeof memoryStore>, path: string, refs: string[]): void {
  const raw = fs.peek(path);
  if (raw === null) throw new Error(`找不到 ${path}`);
  const lines = raw.split('\n');
  const index = lines.findIndex(line => line.trimStart().startsWith('derived_from:'));
  const replacement = lines.map(line => line.trimStart().startsWith('derived_from:'));
  void index;
  void replacement;
  const patched = raw.replace(/^derived_from:.*$/m, `derived_from: [${refs.map(ref => `"${ref}"`).join(', ')}]`);
  fs.simulateManualEdit(path, patched);
}

/* ================================================================== */
/* 存储五项                                                            */
/* ================================================================== */

describe('S1 永久删除必须核对磁盘字节，而不是缓存哈希（历史反例）', () => {
  it('用户手改后，拿着旧哈希的删除请求不会删掉新内容', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({
      body: '原文秘密',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const staleHash = store.hashOf(created.id)!;

    // 用户手改（缓存尚未同步）。
    const raw = fs.peek(created.path)!;
    fs.simulateManualEdit(created.path, raw.replace('原文秘密', '人工新秘密'));

    const result = await store.deletePermanently(created.id, { expectedHash: staleHash });

    // 修复前：{ok:true, conflict:false, diskDeleted:true}
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(fs.peek(created.path)).toContain('人工新秘密');
    expect(store.tombstone(created.id)).toBeUndefined();
  });

  it('不传期望哈希时以“加载时看到的磁盘内容”为期望值，同样受保护', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({ body: '原始内容', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const raw = fs.peek(created.path)!;
    fs.simulateManualEdit(created.path, raw.replace('原始内容', '人工改动'));
    // 不重新加载，也不传 expectedHash：缓存里的哈希已经过期。
    const result = await store.deletePermanently(created.id);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(fs.peek(created.path)).toContain('人工改动');
  });

  it('内容一致时删除正常成功，并留下不含正文的标记', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({ body: '待删内容', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const result = await store.deletePermanently(created.id, { expectedHash: store.hashOf(created.id)! });
    expect(result.ok).toBe(true);
    expect(fs.peek(created.path)).toBeNull();
  });
});

describe('S2 AI 不得改写已确认事实，候选入口不得自我确认（历史反例）', () => {
  it('actor:ai 修改 confirmed 正文被拒绝，正文与状态都不变', async () => {
    const { store } = makeStore();
    await store.load();
    const created = await store.remember({ body: '原始事实', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });

    const updated = await store.update(created.id, {
      body: 'AI推断新事实',
      actor: 'ai',
      reason: '自动修正',
      expectedHash: store.hashOf(created.id)!,
    });

    // 修复前：{ok:true, status:'confirmed', body:'# 原始事实\n\nAI推断新事实'}
    expect(updated.ok).toBe(false);
    expect(updated.requiresReview).toBe(true);
    const after = store.get(created.id)!;
    expect(after.meta.status).toBe('confirmed');
    expect(after.body).not.toContain('AI推断新事实');
    expect(after.body).toContain('原始事实');
    expect(after.meta.revision).toBe(1);
  });

  it('AI 也不能改已确认记录的 allow_model / 范围 / 有效期', async () => {
    const { store } = makeStore();
    await store.load();
    const created = await store.remember({
      body: '已确认内容',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
      allowModel: false,
    });
    for (const patch of [
      { allowModel: true as const },
      { scope: 'project' as const, scopeRef: 'x' },
      { validUntil: '2000-01-01T00:00:00.000Z' },
      { tags: ['被篡改'] },
      { status: 'disputed' as const },
    ]) {
      const result = await store.update(created.id, { ...patch, actor: 'ai', reason: 'AI 尝试', expectedHash: store.hashOf(created.id)! });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
    const after = store.get(created.id)!;
    expect(after.meta.allow_model).toBe(false);
    expect(after.meta.scope).toBe('personal');
    expect(after.meta.valid_until).toBe('');
    expect(after.meta.tags).toEqual([]);
    expect(after.meta.status).toBe('confirmed');
  });

  it('用户自己修改已确认记录仍然允许（护栏只拦 AI）', async () => {
    const { store } = makeStore();
    await store.load();
    const created = await store.remember({ body: '原始事实', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const updated = await store.update(created.id, {
      body: '用户自己改正后的内容',
      actor: 'user',
      reason: '用户修改',
      expectedHash: store.hashOf(created.id)!,
    });
    expect(updated.ok).toBe(true);
    expect(store.get(created.id)?.body).toContain('用户自己改正后的内容');
  });

  it('propose({status:"confirmed"}) 仍然写入 pending', async () => {
    const { store } = makeStore();
    await store.load();
    const proposed = await store.propose({
      body: '候选直接通过',
      kind: 'fact',
      sourceKind: 'ai_extraction',
      sourceRef: 'session',
      status: 'confirmed',
    });
    // 修复前：proposeConfirmed === 'confirmed'
    expect(store.get(proposed.id)?.meta.status).toBe('pending');
    expect(proposed.requiresReview).toBe(true);
    expect((await store.search({ text: '候选直接通过' })).hits).toEqual([]);
  });

  it('commit() 也不能让非用户来源自我确认', async () => {
    const { store } = makeStore();
    await store.load();
    const result = await store.commit(
      { body: 'AI 通过 commit 提交', kind: 'fact', sourceKind: 'ai_extraction', sourceRef: 'session' },
      { status: 'confirmed' },
    );
    expect(store.get(result.id)?.meta.status).toBe('pending');

    // 用户动作来源可以。
    const trusted = await store.commit(
      { body: '用户动作提交', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' },
      { status: 'confirmed' },
    );
    expect(store.get(trusted.id)?.meta.status).toBe('confirmed');
  });
});

describe('S3 来源被遗忘/删除后，派生记忆必须退出召回（历史反例）', () => {
  it('forget 来源后，摘要不再被检索到（历史反例）', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const source = await store.remember({
      body: '来源事实：项目代号是 SPARROW。',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const derived = await store.remember({
      body: '概要：这里写的是关于项目代号的摘要。',
      kind: 'note',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    markDerivedFrom(fs, derived.path, [`${source.id}@1`]);

    const reloaded = new MemoryStore({ store: fs, root: 'Second Root', now: () => T0, rand: seededRand(5) });
    // 用同一个 root 重新加载，避免路径前缀变化。
    const store2 = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(5) });
    void reloaded;
    await store2.load({ force: true });
    expect(store2.get(derived.id)?.meta.derived_from).toEqual([`${source.id}@1`]);
    expect((await store2.search({ text: '概要' })).hits.map(hit => hit.id)).toContain(derived.id);

    await store2.forget(source.id, { reason: '用户要求忘记来源' });
    // 修复前：仍然命中 derived。
    const after = await store2.search({ text: '概要' });
    expect(after.hits.map(hit => hit.id)).not.toContain(derived.id);
    expect(store2.get(derived.id)?.meta.derived_invalid).toBe(true);
    expect(store2.get(derived.id)?.meta.derived_invalid_reason).toContain('遗忘');
    // 文件仍然存在（不删用户独立书写的内容）。
    expect(fs.peek(derived.path)).not.toBeNull();
  });

  it('永久删除来源后，摘要同样退出召回（历史反例）', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const source = await store.remember({ body: '来源内容甲', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const derived = await store.remember({ body: '派生概要乙', kind: 'note', sourceKind: 'user_explicit', sourceRef: 'ui' });
    markDerivedFrom(fs, derived.path, [`${source.id}@1`]);
    await store.load({ force: true });

    const removal = await store.deletePermanently(source.id, { expectedHash: store.hashOf(source.id)! });
    expect(removal.ok).toBe(true);
    expect(removal.message).toContain('派生记忆');

    const after = await store.search({ text: '派生概要乙' });
    expect(after.hits).toEqual([]);
    expect(store.get(derived.id)?.meta.derived_invalid).toBe(true);
  });

  it('来源修订变化后，旧摘要退出召回（派生的前提已经不成立）', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const source = await store.remember({ body: '来源内容', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const derived = await store.remember({ body: '派生摘要', kind: 'note', sourceKind: 'user_explicit', sourceRef: 'ui' });
    markDerivedFrom(fs, derived.path, [`${source.id}@1`]);
    await store.load({ force: true });

    await store.update(source.id, {
      body: '来源内容已被用户改写',
      actor: 'user',
      reason: '用户修改来源',
      expectedHash: store.hashOf(source.id)!,
    });
    // 来源变成 rev 2，而依赖仍写着 @1。
    const reloaded = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(5) });
    await reloaded.load({ force: true });
    expect(reloaded.get(derived.id)?.meta.derived_invalid).toBe(true);
    expect((await reloaded.search({ text: '派生摘要' })).hits).toEqual([]);
  });

  it('来源恢复（restore）不会自动复活派生：必须由人复核后放行', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const source = await store.remember({ body: '来源', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const derived = await store.remember({ body: '派生', kind: 'note', sourceKind: 'user_explicit', sourceRef: 'ui' });
    markDerivedFrom(fs, derived.path, [`${source.id}@1`]);
    await store.load({ force: true });
    await store.forget(source.id);
    expect(store.get(derived.id)?.meta.derived_invalid).toBe(true);

    await store.restore(source.id);
    const reloaded = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(5) });
    await reloaded.load({ force: true });
    /**
     * 刻意**不**自动复活：用户的遗忘动作是一份要求，恢复来源并不自动
     * 推翻当时那份要求。复核权交回用户——派生摘要继续保持退出召回状态，
     * 直到用户显式确认它仍然准确。
     */
    expect(reloaded.get(derived.id)?.meta.derived_invalid).toBe(true);
    expect((await reloaded.search({ text: '派生' })).hits).toEqual([]);
    // 记录本身与历史都还在，人工复核后可以恢复。
    expect(reloaded.get(derived.id)).toBeDefined();
  });
});

describe('S4 崩溃重放必须幂等：幂等身份写在正文里（历史反例）', () => {
  it('Markdown 写成功、state 写失败后重启重放，只产生一条记录', async () => {
    const fs = memoryStore();
    let failNextStateWrite = true;
    const originalWrite = fs.writeFile.bind(fs);
    fs.writeFile = async (path, content, expect) => {
      if (failNextStateWrite && path.endsWith('/state.json')) {
        failNextStateWrite = false;
        throw new Error('simulated state write loss');
      }
      return originalWrite(path, content, expect);
    };

    const first = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(7) });
    await first.load();
    let firstError = '';
    try {
      await first.remember({
        body: '事件内容 E',
        kind: 'fact',
        sourceKind: 'session_commit',
        sourceRef: 'source-E',
        eventId: 'event-E',
      });
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    expect(firstError).toContain('simulated state write loss');

    // 模拟重启：同一个文件存储，新的 store 实例。
    const restarted = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(7) });
    await restarted.load({ force: true });
    const replay = await restarted.remember({
      body: '事件内容 E',
      kind: 'fact',
      sourceKind: 'session_commit',
      sourceRef: 'source-E',
      eventId: 'event-E',
    });

    // 修复前：retryIdempotent=false，recordCount=2，两条不同 id。
    expect(restarted.all()).toHaveLength(1);
    expect(replay.idempotent).toBe(true);
  });

  it('state.json 被删除后重放仍幂等（状态文件是可重建缓存）', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const first = await store.remember({
      body: '会话事件',
      kind: 'fact',
      sourceKind: 'session_commit',
      sourceRef: 's1',
      eventId: 'evt-cache-loss',
    });
    // 模拟同步/回滚把状态文件弄丢。
    fs.simulateManualEdit('Second Brain/.memory/state.json', '');

    const restarted = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(7) });
    await restarted.load({ force: true });
    const replay = await restarted.remember({
      body: '会话事件',
      kind: 'fact',
      sourceKind: 'session_commit',
      sourceRef: 's1',
      eventId: 'evt-cache-loss',
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(restarted.all()).toHaveLength(1);
  });

  it('事件身份确实写进了 Markdown frontmatter', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({
      body: '带事件身份的记录',
      kind: 'fact',
      sourceKind: 'session_commit',
      sourceRef: 's',
      eventId: 'evt-visible',
    });
    expect(fs.peek(created.path)).toContain('evt-visible');
  });
});

describe('S5 删除账本损坏必须 fail-closed（历史反例）', () => {
  it('账本损坏后已删除内容不复活、问题可见、坏文件不被覆盖', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({
      body: '将被删除的秘密内容 FALCON-7',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const originalRaw = fs.peek(created.path)!;
    await store.deletePermanently(created.id, { expectedHash: store.hashOf(created.id)! });
    expect(fs.peek(created.path)).toBeNull();

    // 账本损坏 + 旧副本同步回来（这正是审查里的场景）。
    fs.simulateManualEdit('Second Brain/.memory/tombstones.json', '{broken');
    fs.simulateManualEdit(created.path, originalRaw);

    const restarted = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(9) });
    const report = await restarted.load({ force: true });

    // 修复前：hits 命中该记忆，reportProblems=[]，账本被覆盖成空表。
    expect((await restarted.search({ text: 'FALCON-7' })).hits).toEqual([]);
    expect(restarted.isOperational).toBe(false);
    expect(restarted.problems.length).toBeGreaterThan(0);
    expect(restarted.problems.some(problem => problem.issues.some(issue => issue.message.includes('删除标记文件损坏')))).toBe(true);
    expect(report.problems.length).toBeGreaterThan(0);
    // 坏账本必须原样留着当修复证据。
    expect(fs.peek('Second Brain/.memory/tombstones.json')).toBe('{broken');

    // 不可核验时写入也要停：否则新写的内容同样无法对照删除账本。
    const write = await restarted.remember({ body: '账本坏了还写', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    expect(write.ok).toBe(false);
    expect(write.message).toContain('删除账本');
  });

  it('坏账本被修复并重新加载后恢复正常', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({ body: '内容', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    await store.deletePermanently(created.id, { expectedHash: store.hashOf(created.id)! });
    const good = fs.peek('Second Brain/.memory/tombstones.json')!;

    fs.simulateManualEdit('Second Brain/.memory/tombstones.json', '{broken');
    const broken = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(9) });
    await broken.load({ force: true });
    expect(broken.isOperational).toBe(false);

    fs.simulateManualEdit('Second Brain/.memory/tombstones.json', good);
    const healed = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(9) });
    await healed.load({ force: true });
    expect(healed.isOperational).toBe(true);
    expect(healed.problems).toEqual([]);
  });

  it('parseTombstones 对损坏输入返回错误而不是空表', () => {
    const parsed = parseTombstones('{broken');
    expect(parsed.error).not.toBeNull();
    expect(parsed.file.items).toEqual([]);
    // 合法输入不报错。
    expect(parseTombstones('{"version":1,"items":[]}').error).toBeNull();
    // 空文件视为“没有删除过东西”，这是正常初始状态。
    expect(parseTombstones(null).error).toBeNull();
  });

  it('序列化后的账本里不出现被删正文或标题', () => {
    const file: TombstoneFile = {
      version: 1,
      updated_at: '',
      items: [
        {
          id: 'mem_1',
          path: 'Second Brain/00-收件箱/秘密标题.md',
          deleted_at: '2026-01-01T00:00:00.000Z',
          revision: 1,
          content_hash: sha256Hex('秘密正文'),
          dedupe_key: 'k',
          reason: 'user_forget',
        },
      ],
    };
    const text = serializeTombstones(file, T0);
    expect(text).not.toContain('秘密正文');
    expect(text).not.toContain('秘密标题');
  });
});

/* ================================================================== */
/* AI / 作业 / MSE / 复盘 五项                                          */
/* ================================================================== */

describe('A1 没有中止能力时也要有界等待；取消前不发送（历史反例）', () => {
  it('预先取消的请求根本不调用 transport', async () => {
    let calls = 0;
    const provider = new OpenAiCompatibleProvider({
      config: { baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'fake' },
      transport: async () => {
        calls += 1;
        return { status: 200, text: '{"choices":[]}' };
      },
    });
    const result = await provider.complete({ messages: [], timeoutMs: 5, signal: { aborted: true } });
    expect(calls).toBe(0);
    expect(result.delivered).toBe(false);
    expect(result.waitOutcome).toBe('refused');
  });

  it('无 controller 的 transport 永不结束时，等待仍然有界（历史反例）', async () => {
    let resolveLate: ((value: { status: number; text: string }) => void) | null = null;
    const provider = new OpenAiCompatibleProvider({
      config: { baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'fake' },
      // 刻意不提供 controllerFactory —— 这正是 Obsidian requestUrl 的路径。
      transport: () =>
        new Promise<{ status: number; text: string }>(resolve => {
          resolveLate = resolve;
        }),
    });
    const started = Date.now();
    const result = await provider.complete({ messages: [], timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    expect(result.waitOutcome).toBe('timed_out');
    expect(result.billableUnknown).toBe(true);
    // 如实：没有中止能力，就不能说“已中止”。
    expect(result.aborted).toBe(false);
    expect(result.delivered).toBe(true);
    expect(result.error).toContain('无法确认');

    // 迟到的响应不允许改变已返回的结论。
    resolveLate?.({ status: 200, text: '{"choices":[{"message":{"content":"late"}}]}' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.text).toBe('');
  });

  it('有 controller 时会真正中止，并仍然报告计费未知', async () => {
    let aborted = false;
    const provider = new OpenAiCompatibleProvider({
      config: { baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'fake' },
      transport: () => new Promise(() => undefined),
      controllerFactory: () => ({
        signal: {},
        abort: () => {
          aborted = true;
        },
        aborted: () => aborted,
      }),
    });
    const result = await provider.complete({ messages: [], timeoutMs: 20 });
    expect(aborted).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.waitOutcome).toBe('timed_out');
    // 即使中止了传输层，也不能声称远端计费已停止。
    expect(result.billableUnknown).toBe(true);
  });
});

describe('A2 暂停状态不得通过提交门禁（历史反例）', () => {
  const base = { instanceId: 'inst-1', currentInstanceId: 'inst-1', capturedAt: T0, now: T0 + 1 };

  it('paused 被拒绝（修复前 allowed:true）', () => {
    const { queue, job } = fixtureQueue();
    queue.pause(job.id, '用户暂停', T0 + 2);
    const verdict = mayCommit(queue.get(job.id)!, base);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('暂停');
  });

  it('队列级暂停也拒绝提交', () => {
    const { queue, job } = fixtureQueue();
    queue.setQueuePaused(true);
    expect(queue.queuePaused()).toBe(true);
    expect(mayCommit(queue.get(job.id)!, { ...base, queuePaused: true }).allowed).toBe(false);
  });

  it('运行代次不匹配的结果被拒绝', () => {
    const { queue, job } = fixtureQueue();
    expect(job.attempts).toBe(1);
    expect(mayCommit(queue.get(job.id)!, { ...base, attempt: 1 }).allowed).toBe(true);
    expect(mayCommit(queue.get(job.id)!, { ...base, attempt: 0 }).allowed).toBe(false);
  });

  it('cancelled / unknown / queued 都不接受提交', () => {
    const { queue, job } = fixtureQueue();
    queue.cancel(job.id, T0 + 2, '用户取消');
    expect(mayCommit(queue.get(job.id)!, base).allowed).toBe(false);

    const { queue: q2, job: j2 } = fixtureQueue();
    q2.markBillable(j2.id);
    q2.recoverOnStartup(T0 + 2, { resumeRunning: true });
    expect(mayCommit(q2.get(j2.id)!, base).allowed).toBe(false);
  });

  it('正常 running 且未暂停时允许提交', () => {
    const { queue, job } = fixtureQueue();
    expect(mayCommit(queue.get(job.id)!, base)).toEqual({ allowed: true, reason: '允许提交。' });
  });
});

describe('A3 计费未知的作业不得降级为普通暂停（历史反例）', () => {
  it('resumeRunning:false 时已计费的 running 仍归为 unknown', () => {
    const { queue, job } = fixtureQueue();
    queue.markBillable(job.id);
    queue.recoverOnStartup(T0 + 2, { resumeRunning: false });
    expect(queue.get(job.id)!.status).toBe('unknown');
    // 修复前：paused，然后 start 会成功。
    expect(queue.start(job.id, T0 + 3).ok).toBe(false);
  });

  it('resumeRunning:true 时已计费的 running 也是 unknown，不自动重放', () => {
    const { queue, job } = fixtureQueue();
    queue.markBillable(job.id);
    queue.recoverOnStartup(T0 + 2, { resumeRunning: true });
    expect(queue.get(job.id)!.status).toBe('unknown');
    expect(queue.start(job.id, T0 + 3).ok).toBe(false);
  });

  it('未计费的中断作业才受 resumeRunning 影响', () => {
    const { queue, job } = fixtureQueue();
    queue.recoverOnStartup(T0 + 2, { resumeRunning: true });
    expect(queue.get(job.id)!.status).toBe('queued');

    const { queue: q2, job: j2 } = fixtureQueue();
    q2.recoverOnStartup(T0 + 2, { resumeRunning: false });
    expect(q2.get(j2.id)!.status).toBe('paused');
    // 未计费的暂停可以正常继续。
    expect(q2.start(j2.id, T0 + 3).ok).toBe(true);
  });

  it('历史遗留的“已计费 + paused”数据也不能用普通继续操作重放', () => {
    const { queue, job } = fixtureQueue();
    queue.markBillable(job.id);
    queue.pause(job.id, '用户暂停', T0 + 2);
    const attempt = queue.start(job.id, T0 + 3);
    expect(attempt.ok).toBe(false);
    expect(attempt.reason).toContain('未知');
  });

  it('未知请求不能被“继续”抹平：状态始终保持 unknown', () => {
    const { queue, job } = fixtureQueue();
    queue.markBillable(job.id);
    queue.recoverOnStartup(T0 + 2, { resumeRunning: false });
    const first = queue.get(job.id)!.status;
    // 多次“继续”尝试都不改变 unknown。
    queue.start(job.id, T0 + 3);
    queue.start(job.id, T0 + 4);
    expect(queue.get(job.id)!.status).toBe(first);
    expect(queue.get(job.id)!.status).toBe('unknown');
  });
});

describe('A4 MSE 回执必须与方法/版本精确匹配（历史反例）', () => {
  function itemAtRemote(): BridgeItem {
    /**
     * 用真实工厂造一个“已送达”的桥接项，避免手写结构漂移。
     */
    const { envelope } = buildMethodCandidate({
      memory: { id: 'mem_aaaaaaaaaaaaaaaa', revision: 1, scope: 'personal', scopeRef: '' },
      problem: { kind: 'unknown', ref: 'mem_aaaaaaaaaaaaaaaa', excerptHash: sha256Hex('摘要'), excerptLength: 2 },
      method: { instruction: '先核对来源版本再修改。', applicability: '', exclusions: '' },
      originEventId: 'evt-1',
      proposalId: 'prop-1',
      now: T0,
    });
    const base = newBridgeItem({ envelope, now: T0 });
    return {
      ...base,
      remote: { ...base.remote, candidateId: 'cand-1', candidateVersion: 1 },
      delivery: { state: 'accepted', detail: '已送达' },
    };
  }

  it('回执方法与版本都对上才算 confirmed', async () => {
    const item = await requestRecall({
      item: itemAtRemote(),
      channel: {
        requestSuspension: async () => ({ ok: true, methodId: 'expected', version: 1 }),
      },
      methodId: 'expected',
      version: 1,
      now: T0,
    });
    expect(item.recall.state).toBe('confirmed');
    expect(item.recall.receiptMethodId).toBe('expected');
  });

  it('错误的方法/版本只能记为 mismatched，不能声称已停用（历史反例）', async () => {
    const item = await requestRecall({
      item: itemAtRemote(),
      channel: {
        requestSuspension: async () => ({ ok: true, methodId: 'WRONG', version: 99 }),
      },
      methodId: 'expected',
      version: 1,
      now: T0,
    });
    // 修复前：state='confirmed'，文案为“方法 WRONG 版本 99 已停用”。
    expect(item.recall.state).toBe('mismatched');
    expect(item.recall.detail).toContain('未完成');
    expect(item.recall.confirmedAt).toBe('');
  });

  it('只有方法不匹配或只有版本不匹配都要拦住', async () => {
    const wrongMethod = await requestRecall({
      item: itemAtRemote(),
      channel: { requestSuspension: async () => ({ ok: true, methodId: 'other', version: 1 }) },
      methodId: 'expected',
      version: 1,
      now: T0,
    });
    expect(wrongMethod.recall.state).toBe('mismatched');
    expect(wrongMethod.recall.detail).toContain('方法不匹配');

    const wrongVersion = await requestRecall({
      item: itemAtRemote(),
      channel: { requestSuspension: async () => ({ ok: true, methodId: 'expected', version: 2 }) },
      methodId: 'expected',
      version: 1,
      now: T0,
    });
    expect(wrongVersion.recall.state).toBe('mismatched');
    expect(wrongVersion.recall.detail).toContain('版本不匹配');
  });

  it('没有通道时保持本地停用，不声称远端已完成', async () => {
    const item = await requestRecall({
      item: itemAtRemote(),
      channel: null,
      methodId: 'expected',
      version: 1,
      now: T0,
    });
    expect(item.recall.state).toBe('local_only');
  });
});

describe('A5 空证据与不存在的目标不得产生可执行建议（历史反例）', () => {
  function fakeProvider(payload: unknown): { complete: () => Promise<ChatResult> } {
    return {
      complete: async () => ({
        ok: true,
        text: JSON.stringify(payload),
        model: 'fake',
        delivered: true,
        aborted: false,
      }),
    };
  }

  const options = {
    excerpts: [{ id: 'excerpt-1', revision: 1, title: '片段', text: '这是允许读取的原文片段内容。' }],
    memories: [{ id: 'mem_1', title: '记忆一', status: 'confirmed' as const, body: '记忆一的正文内容。' }],
    provider: null as never,
    now: T0,
  };

  it('evidence:[{}] + 不存在 target + 空 excerpts/memories → no_action（历史反例）', async () => {
    const outcome = await runAiReview({
      ...options,
      provider: fakeProvider({
        suggestions: [
          {
            kind: 'conflict',
            memory_ids: ['mem_1'],
            evidence: [{}],
            action: { type: 'correct_memory', target_id: 'mem_1', body: 'made up' },
          },
        ],
      }) as never,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.suggestions).toHaveLength(1);
    expect(outcome.suggestions[0]?.action.type).toBe('no_action');
    expect(outcome.suggestions[0]?.evidence[0]?.verified).toBe(false);
  });

  it('目标 id 不在允许集合内 → no_action', async () => {
    const outcome = await runAiReview({
      ...options,
      provider: fakeProvider({
        suggestions: [
          {
            kind: 'conflict',
            evidence: [{ ref: 'mem_1', excerpt: '记忆一的正文内容。' }],
            action: { type: 'correct_memory', target_id: 'mem_not_allowed', body: '改了别的记录' },
          },
        ],
      }) as never,
    });
    expect(outcome.suggestions[0]?.action.type).toBe('no_action');
    expect(outcome.suggestions[0]?.action.reason).toContain('不在本次允许');
  });

  it('引文无法在原文里找到 → 不算证据 → no_action', async () => {
    const outcome = await runAiReview({
      ...options,
      provider: fakeProvider({
        suggestions: [
          {
            kind: 'conflict',
            evidence: [{ ref: 'mem_1', excerpt: '这句话在原文里根本不存在，是模型编的。' }],
            action: { type: 'correct_memory', target_id: 'mem_1', body: '基于编造证据的改写' },
          },
        ],
      }) as never,
    });
    expect(outcome.suggestions[0]?.action.type).toBe('no_action');
    expect(outcome.suggestions[0]?.evidence[0]?.verified).toBe(false);
  });

  it('真实可核验的证据 + 存在目标 → 保留 correct_memory 建议', async () => {
    const outcome = await runAiReview({
      ...options,
      provider: fakeProvider({
        suggestions: [
          {
            kind: 'conflict',
            evidence: [{ ref: 'mem_1', excerpt: '记忆一的正文内容。' }],
            action: { type: 'correct_memory', target_id: 'mem_1', body: '基于真实证据的改写' },
          },
        ],
      }) as never,
    });
    expect(outcome.suggestions[0]?.action.type).toBe('correct_memory');
    expect(outcome.suggestions[0]?.evidence[0]?.verified).toBe(true);
  });

  it('memory_ids 里对不上的 id 会被过滤掉', async () => {
    const outcome = await runAiReview({
      ...options,
      provider: fakeProvider({
        suggestions: [{ kind: 'unknown', memory_ids: ['mem_1', 'mem_ghost'], action: { type: 'no_action' } }],
      }) as never,
    });
    expect(outcome.suggestions[0]?.impact.memoryIds).toEqual(['mem_1']);
  });

  it('迟到结果被拒绝（isStillValid 为假）', async () => {
    const outcome = await runAiReview({
      ...options,
      provider: fakeProvider({
        suggestions: [{ kind: 'unknown', evidence: [{ ref: 'mem_1', excerpt: '记忆一的正文内容。' }], action: { type: 'no_action' } }],
      }) as never,
      isStillValid: () => false,
    });
    expect(outcome.rejectedLate).toBe(true);
    expect(outcome.suggestions).toEqual([]);
  });
});

/* ================================================================== */
/* 协调者补充：概览、路径与设置                                        */
/* ================================================================== */

describe('X1 派生概览必须遵守与检索相同的可见性规则', () => {
  function record(overrides: Partial<MemoryRecord['meta']> & { invalid?: boolean }): MemoryRecord {
    return {
      meta: {
        id: 'mem_aaaaaaaaaaaaaaaa',
        kind: 'fact',
        status: 'confirmed',
        scope: 'personal',
        scope_ref: '',
        source_kind: 'user_explicit',
        source_ref: 'ui',
        revision: 1,
        observed_at: '2026-01-01T00:00:00.000Z',
        valid_from: '',
        valid_until: '',
        supersedes: [],
        derived_from: [],
        review_after: '',
        updated_at: '2026-01-01T00:00:00.000Z',
        tags: [],
        aliases: [],
        allow_model: true,
        dedupe_key: 'k',
        event_ids: [],
        ...overrides,
      },
      body: '# 标题\n\n正文',
      path: 'Second Brain/00-收件箱/x.md',
      sources: [],
      ...(overrides.invalid === true ? { invalid: true, invalidReasons: ['未知 scope'] } : {}),
    };
  }

  it('invalid 记录不进入概览', () => {
    const view = buildProfileView([record({ invalid: true } as never)], { now: T0 });
    expect(view.sections).toEqual([]);
    expect(view.excluded.invalid).toBe(1);
  });

  it('valid_from 在未来的记录不进入概览', () => {
    const view = buildProfileView([record({ valid_from: '2099-01-01T00:00:00.000Z' })], { now: T0 });
    expect(view.sections).toEqual([]);
    expect(view.excluded.notYetValid).toBe(1);
  });

  it('派生失效的记录不进入概览', () => {
    const view = buildProfileView([record({ derived_invalid: true, derived_invalid_reason: '来源已遗忘' })], { now: T0 });
    expect(view.sections).toEqual([]);
    expect(view.excluded.derivedInvalid).toBe(1);
  });

  it('正常已确认记录仍然进入概览', () => {
    const view = buildProfileView([record({})], { now: T0 });
    expect(view.sections.length).toBe(1);
    expect(view.excluded.invalid).toBe(0);
  });
});

describe('X2 路径与设置不得接受绝对写法或保留目录', () => {
  it('isInsideRoot 对绝对写法返回 false（历史反例）', () => {
    expect(isInsideRoot('Second Brain', 'Second Brain/note.md')).toBe(true);
    // 修复前：true（归一化把开头的 / 剥掉了）。
    expect(isInsideRoot('Second Brain', '/Second Brain/note.md')).toBe(false);
    expect(isInsideRoot('/Second Brain', 'Second Brain/note.md')).toBe(false);
    expect(isInsideRoot('Second Brain', 'C:/Second Brain/note.md')).toBe(false);
  });

  it('保留目录不能当记忆根', () => {
    for (const bad of ['.obsidian', '.git', '.memory', '.trash', 'node_modules', 'x/.git']) {
      expect(() => assertSafeRoot(bad), bad).toThrow();
    }
  });

  it('盘符相对写法也被拒绝（历史反例）', () => {
    expect(() => assertSafeRoot('C:relative')).toThrow();
    expect(() => assertSafeRoot('C:/absolute')).toThrow();
    expect(assertSafeRoot(DEFAULT_ROOT)).toBe(DEFAULT_ROOT);
  });

  it('设置合并不会先剥掉绝对前缀（历史反例）', () => {
    const rejected = mergeSettings({ root: '/Second Brain' });
    expect(rejected.settings.root).toBe(DEFAULT_ROOT);
    expect(rejected.warnings.some(warning => warning.includes('不安全的记忆根目录'))).toBe(true);

    const reserved = mergeSettings({ root: '.obsidian' });
    expect(reserved.settings.root).toBe(DEFAULT_ROOT);

    const drive = mergeSettings({ root: 'C:relative' });
    expect(drive.settings.root).toBe(DEFAULT_ROOT);

    const good = mergeSettings({ root: 'Second Brain/记忆' });
    expect(good.settings.root).toBe('Second Brain/记忆');
    expect(good.warnings).toEqual([]);
  });
});

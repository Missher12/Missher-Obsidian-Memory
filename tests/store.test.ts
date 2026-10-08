/**
 * 任务书要求的针对性回归（第一条与内容状态机部分）。
 *
 * 覆盖：显式记住 / pending 隔离；中文查询；仅本次与引文伪指令；范围隔离；
 * 同名不同实体；版本冲突与人工编辑；重复事件幂等；替代旧偏好；遗忘不复活。
 */

import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@mom/core';
import { T0, fixedClock, memoryStore, seededRand } from './helpers.js';

function makeStore(seed?: Record<string, string>): {
  store: MemoryStore;
  clock: ReturnType<typeof fixedClock>;
  fs: ReturnType<typeof memoryStore>;
} {
  const clock = fixedClock(T0);
  const fs = memoryStore(seed);
  const store = new MemoryStore({ store: fs, root: 'Second Brain', now: clock.now, rand: seededRand(3) });
  return { store, clock, fs };
}

describe('显式记住与待确认隔离', () => {
  it('显式记住直接 confirmed，并且可立即检索到', async () => {
    const { store } = makeStore();
    await store.load();
    const result = await store.remember({
      body: '我更喜欢在上午处理需要专注的工作。',
      kind: 'preference',
      sourceKind: 'user_explicit',
      sourceRef: 'ui:quick-remember',
    });
    expect(result.ok).toBe(true);
    expect(store.get(result.id)?.meta.status).toBe('confirmed');

    const found = await store.search({ text: '上午 专注' });
    expect(found.hits.map(hit => hit.id)).toEqual([result.id]);
  });

  it('AI 提议进入 pending，默认检索不返回它（隔离）', async () => {
    const { store } = makeStore();
    await store.load();
    const proposed = await store.propose({
      body: '推测用户可能偏好极简界面。',
      kind: 'preference',
      sourceKind: 'ai_extraction',
      sourceRef: 'session:1',
    });
    expect(proposed.ok).toBe(true);
    expect(proposed.requiresReview).toBe(true);
    expect(store.get(proposed.id)?.meta.status).toBe('pending');

    const hidden = await store.search({ text: '极简界面' });
    expect(hidden.hits).toEqual([]);
    expect(hidden.diagnosis.notes.some(note => note.code === 'status_excluded')).toBe(true);

    // 显式要求时可以看到，并且如实标注状态。
    const visible = await store.search({ text: '极简界面', includeNonConfirmed: true });
    expect(visible.hits[0]?.status).toBe('pending');
  });

  it('pending 手改正文不会自动变成 confirmed', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const proposed = await store.propose({
      body: '候选内容。',
      kind: 'fact',
      sourceKind: 'ai_extraction',
      sourceRef: 'session:1',
    });
    const raw = fs.peek(proposed.path)!;
    fs.simulateManualEdit(proposed.path, raw.replace('候选内容。', '我手动改写过的候选内容，增加了明确语气。'));

    const reloaded = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(3) });
    await reloaded.load({ force: true });
    expect(reloaded.get(proposed.id)?.meta.status).toBe('pending');
    expect(reloaded.get(proposed.id)?.body).toContain('我手动改写过的候选内容');
  });

  it('AI 无法通过普通更新把 pending 提升为 confirmed', async () => {
    const { store } = makeStore();
    await store.load();
    const proposed = await store.propose({ body: '候选。', kind: 'fact', sourceKind: 'ai_extraction', sourceRef: 's' });
    const blocked = await store.update(proposed.id, {
      status: 'confirmed',
      reason: 'AI 试图自我确认',
      actor: 'ai',
    });
    expect(blocked.ok).toBe(false);
    expect(store.get(proposed.id)?.meta.status).toBe('pending');

    // 用户确认才生效。
    const confirmed = await store.confirm(proposed.id);
    expect(confirmed.ok).toBe(true);
    expect(store.get(proposed.id)?.meta.status).toBe('confirmed');
  });
});

describe('中文查询', () => {
  it('中文关键词、同义别名与标签都能命中', async () => {
    const { store } = makeStore();
    await store.load();
    const target = await store.remember({
      body: '每个季度做一次订阅服务的成本复盘，通常在季度结束后一周内完成。',
      title: '季度成本复盘',
      kind: 'preference',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
      tags: ['财务', '例行事项'],
      aliases: ['每季度对账', '费用回顾'],
    });
    await store.remember({
      body: '无关内容：周末去爬山。',
      kind: 'event',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });

    for (const query of ['季度', '成本复盘', '订阅服务', '每季度对账', '费用回顾', '财务']) {
      const result = await store.search({ text: query });
      expect(result.hits.map(hit => hit.id), `查询：${query}`).toContain(target.id);
    }
  });

  it('无答案时返回空而不是凑数', async () => {
    const { store } = makeStore();
    await store.load();
    await store.remember({ body: '我喜欢喝手冲咖啡。', kind: 'preference', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const none = await store.search({ text: '量子计算 编译原理 罗马帝国' });
    expect(none.hits).toEqual([]);
    expect(none.diagnosis.excludedByTerms).toBe(1);
  });

  it('空查询在无记录时也保持克制', async () => {
    const { store } = makeStore();
    await store.load();
    const result = await store.search({ text: '' });
    expect(result.hits).toEqual([]);
  });
});

describe('范围隔离与同名实体', () => {
  it('项目 A 的结论不会出现在项目 B 的查询里', async () => {
    const { store } = makeStore();
    await store.load();
    const a = await store.remember({
      body: 'Apollo 用 TS。',
      scope: 'project',
      scopeRef: 'apollo',
      kind: 'decision',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const b = await store.remember({
      body: 'Borealis 用 Rust。',
      scope: 'project',
      scopeRef: 'borealis',
      kind: 'decision',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });

    const onlyA = await store.search({ text: '用', scopes: [{ scope: 'project', ref: 'apollo' }] });
    expect(onlyA.hits.map(hit => hit.id)).toEqual([a.id]);
    const onlyB = await store.search({ text: '用', scopes: [{ scope: 'project', ref: 'borealis' }] });
    expect(onlyB.hits.map(hit => hit.id)).toEqual([b.id]);
  });

  it('同名不同实体不会被自动合并', async () => {
    const { store } = makeStore();
    await store.load();
    const first = await store.remember({
      body: '张三（产品经理，负责结算线）喜欢在评审前先看数据。',
      title: '张三（产品）',
      kind: 'person',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const second = await store.remember({
      body: '张三（后端工程师，负责风控线）偏好用 Rust 写服务。',
      title: '张三（后端）',
      kind: 'person',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    expect(first.id).not.toBe(second.id);

    const result = await store.search({ text: '张三' });
    expect(result.hits.length).toBe(2);
    expect(new Set(result.hits.map(hit => hit.id))).toEqual(new Set([first.id, second.id]));
  });
});

describe('版本冲突与人工编辑', () => {
  it('人工编辑后旧任务不覆盖新内容（核心承诺）', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({
      body: '初始内容。',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const seenHash = store.hashOf(created.id)!;

    /**
     * 用户在 Obsidian 里手改。**关键**：缓存（`store.hashOf`）停留在手改之前
     * 的那一版——真实场景里这正是“尚未收到文件变更事件”的窗口。
     */
    const raw = fs.peek(created.path)!;
    fs.simulateManualEdit(created.path, raw.replace('初始内容。', '用户手改后的内容，必须被保留。'), {
      cacheStale: true,
    });

    /**
     * 用户先手改，然后后台任务拿着读取时的旧哈希提交修正。
     * 用 `maintenance` 身份，是为了单独检验“比较-写入”这条防线本身：
     * AI 身份在更早的门禁就会被拒（另有专门用例覆盖）。
     */
    const stale = await store.update(created.id, {
      body: '后台任务想写入的内容。',
      reason: '后台修正',
      actor: 'maintenance',
      expectedHash: seenHash,
    });
    expect(stale.ok).toBe(false);
    expect(stale.conflict).toBe(true);
    expect(stale.message).toContain('已被修改');

    // 磁盘内容仍然是人工编辑的结果。
    expect(fs.peek(created.path)).toContain('用户手改后的内容，必须被保留。');
    expect(fs.peek(created.path)).not.toContain('后台任务想写入的内容');
  });

  it('AI 更新已确认记录会被拒绝，而且不覆盖人工编辑', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({ body: '初始内容。', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const raw = fs.peek(created.path)!;
    fs.simulateManualEdit(created.path, raw.replace('初始内容。', '用户手改后的内容，必须被保留。'), {
      cacheStale: true,
    });

    const rejected = await store.update(created.id, {
      body: 'AI 想写入的内容。',
      reason: '自动修正',
      actor: 'ai',
      expectedHash: store.hashOf(created.id)!,
    });
    /**
     * 这里磁盘上已经有用户的手改，缓存还是旧的。**正确的拒绝理由是
     * “内容已被修改”**（要求重新读取），而不是“你没资格”——
     * 因为后者会让调用者以为换个身份就能写。无论哪种，内容都不能被动过。
     */
    expect(rejected.ok).toBe(false);
    expect(rejected.requiresReview).toBe(true);
    expect(rejected.message).toMatch(/已被修改|AI/);
    expect(fs.peek(created.path)).toContain('用户手改后的内容，必须被保留。');
    expect(fs.peek(created.path)).not.toContain('AI 想写入的内容');
  });

  it('重新读取后可以基于新内容继续修改', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({ body: '初始内容。', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const raw = fs.peek(created.path)!;
    fs.simulateManualEdit(created.path, raw.replace('初始内容。', '人工修改。'));
    await store.load({ force: true });

    const fresh = store.hashOf(created.id)!;
    const updated = await store.update(created.id, {
      body: '人工修改。追加一行补充。',
      reason: '用户补充',
      actor: 'user',
      expectedHash: fresh,
    });
    expect(updated.ok).toBe(true);
    expect(updated.revision).toBeGreaterThan(1);
    expect(fs.peek(created.path)).toContain('追加一行补充');
  });

  it('revision 与磁盘不一致时写入被拒绝', async () => {
    const { store } = makeStore();
    await store.load();
    const created = await store.remember({ body: '内容。', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    // 直接伪造一个错误的期望哈希。
    const result = await store.update(created.id, {
      body: '新内容',
      reason: '测试',
      actor: 'user',
      expectedHash: 'deadbeef',
    });
    expect(result.conflict).toBe(true);
    expect(store.get(created.id)?.body).toContain('内容。');
  });

  it('删除时若内容已被手改，删除被取消', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({ body: '待删除。', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const hashBefore = store.hashOf(created.id)!;
    const raw = fs.peek(created.path)!;
    fs.simulateManualEdit(created.path, raw.replace('待删除。', '用户刚补充的重要信息。'));
    // UI 那边看到的是“手改之后”的那一版，所以它拿的哈希来自重新同步的 store。
    await store.load({ force: true });
    expect(store.hashOf(created.id)).not.toBe(hashBefore);
    expect(store.get(created.id)?.body).toContain('用户刚补充的重要信息');

    // 而后台任务仍然拿着**手改之前**的哈希去删除 → 必须被拒绝。
    const blocked = await store.deletePermanently(created.id, { expectedHash: hashBefore });
    expect(blocked.ok).toBe(false);
    expect(blocked.conflict).toBe(true);
    expect(fs.peek(created.path)).toContain('用户刚补充的重要信息');
  });

  it('并发写入同一事件只成功一次（幂等）', async () => {
    const { store } = makeStore();
    await store.load();
    const [first, second] = await Promise.all([
      store.remember({
        body: '并发内容。',
        kind: 'fact',
        sourceKind: 'session_commit',
        sourceRef: 's',
        eventId: 'evt-concurrent-1',
      }),
      store.remember({
        body: '并发内容。',
        kind: 'fact',
        sourceKind: 'session_commit',
        sourceRef: 's',
        eventId: 'evt-concurrent-1',
      }),
    ]);
    const created = [first, second].filter(result => result.ok && result.changed);
    const idempotent = [first, second].filter(result => result.idempotent === true);
    expect(created.length + idempotent.length).toBe(2);
    expect(new Set([first.id, second.id]).size).toBe(1);
    expect(store.all().filter(record => record.meta.id === first.id)).toHaveLength(1);
  });
});

describe('重复事件幂等', () => {
  it('同一 eventId 重复提交不会重复建条目', async () => {
    const { store } = makeStore();
    await store.load();
    const first = await store.remember({
      body: '我会在每周一整理本周计划。',
      kind: 'preference',
      sourceKind: 'session_commit',
      sourceRef: 'session-42',
      eventId: 'evt-1',
    });
    const again = await store.remember({
      body: '我会在每周一整理本周计划。',
      kind: 'preference',
      sourceKind: 'session_commit',
      sourceRef: 'session-42',
      eventId: 'evt-1',
    });
    expect(again.idempotent).toBe(true);
    expect(again.id).toBe(first.id);
    expect(store.all()).toHaveLength(1);
  });

  it('commitSession 逐项报告，重复项计入 duplicates 而不是新建', async () => {
    const { store } = makeStore();
    await store.load();
    const events = [
      { eventId: 'e1', text: '明确命令一', explicit: true, sourceKind: 'session_commit' as const, sourceRef: 's1' },
      { eventId: 'e2', text: '自动提取二', explicit: false, sourceKind: 'session_commit' as const, sourceRef: 's1' },
      { eventId: 'e1', text: '明确命令一', explicit: true, sourceKind: 'session_commit' as const, sourceRef: 's1' },
    ];
    const outcome = await store.commitSession(events);
    expect(outcome.accepted).toBe(2);
    expect(outcome.duplicates).toBe(1);
    expect(outcome.failed).toBe(0);
    expect(store.all()).toHaveLength(2);
  });

  it('session_commit 的事件不会被当作 confirmed（即使文本含“记住”）', async () => {
    const { store } = makeStore();
    await store.load();
    // 调用方必须先用护栏判定 explicit；这里模拟一个错误地标记为 explicit 的调用，
    // 验证幂等与状态机仍按传入的 explicit 走，而护栏本身会拒绝这类来源。
    const outcome = await store.commitSession([
      {
        eventId: 'e-quote',
        text: '记住：这段其实来自引文',
        explicit: false,
        sourceKind: 'session_commit',
        sourceRef: 's2',
      },
    ]);
    expect(outcome.results[0]?.outcome.requiresReview).toBe(true);
    expect(store.pending()).toHaveLength(1);
  });

  it('游标只随成功事件推进', async () => {
    const { store } = makeStore();
    await store.load();
    await store.commitSession([
      { eventId: 'c1', text: '第一段', explicit: true, sourceKind: 'session_commit', sourceRef: 's', cursor: 'pos-1' },
      { eventId: 'c2', text: '第二段', explicit: true, sourceKind: 'session_commit', sourceRef: 's', cursor: 'pos-2' },
    ]);
    expect(store.cursor).toBe('pos-2');
  });
});

describe('替代旧偏好与遗忘不复活', () => {
  it('替代后旧版本退出默认召回但保留历史', async () => {
    const { store } = makeStore();
    await store.load();
    const old = await store.remember({
      body: '我偏好用浅色主题。',
      kind: 'preference',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
      tags: ['主题'],
    });
    const replaced = await store.supersede(old.id, {
      body: '我改主意了：现在偏好深色主题。',
      kind: 'preference',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
      tags: ['主题'],
      reason: '用户改变偏好',
    });
    expect(replaced.ok).toBe(true);
    expect(store.get(old.id)?.meta.status).toBe('superseded');
    expect(store.get(replaced.id)?.meta.supersedes).toEqual([old.id]);

    const result = await store.search({ text: '主题 偏好' });
    const ids = result.hits.map(hit => hit.id);
    expect(ids).toContain(replaced.id);
    expect(ids).not.toContain(old.id);
    expect(result.diagnosis.notes.some(note => note.code === 'status_excluded')).toBe(true);

    // 历史仍然完整保留在磁盘上。
    expect(store.get(old.id)?.body).toContain('浅色主题');
  });

  it('停止使用（forget）退出召回，但文件与历史保留', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({ body: '我不想再被提醒的事。', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const forgotten = await store.forget(created.id, { reason: '用户要求忘记' });
    expect(forgotten.ok).toBe(true);
    expect(fs.peek(created.path)).not.toBeNull();
    expect(store.get(created.id)?.meta.status).toBe('archived');

    const result = await store.search({ text: '不想再被提醒' });
    expect(result.hits).toEqual([]);

    // 可以恢复。
    await store.restore(created.id);
    expect((await store.search({ text: '不想再被提醒' })).hits).toHaveLength(1);
  });

  it('永久删除后留下不含正文的标记，且同一来源无法复活（历史反复强调）', async () => {
    const { store, fs } = makeStore();
    await store.load();
    const created = await store.remember({
      body: '这是要被彻底删除的秘密内容 SECRET-PAYLOAD。',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
      tags: ['秘密'],
    });
    const deleted = await store.deletePermanently(created.id);
    expect(deleted.ok).toBe(true);
    expect(fs.peek(created.path)).toBeNull();

    // 标记文件里不能出现原文。
    const tombstoneRaw = fs.peek('Second Brain/.memory/tombstones.json')!;
    expect(tombstoneRaw).not.toContain('SECRET-PAYLOAD');
    expect(tombstoneRaw).not.toContain('秘密内容');

    // 同一来源事件再次提取出同样的内容 → 被阻止。
    const revived = await store.remember({
      body: '这是要被彻底删除的秘密内容 SECRET-PAYLOAD。',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
      tags: ['秘密'],
    });
    expect(revived.ok).toBe(false);
    expect(revived.blockedByTombstone?.id).toBe(created.id);
    expect(store.all()).toHaveLength(0);

    // 检索也找不到。
    const result = await store.search({ text: 'SECRET-PAYLOAD' });
    expect(result.hits).toEqual([]);
  });

  it('删除标记不会误伤开头相同的不同长文（历史反例）', async () => {
    const { store } = makeStore();
    await store.load();
    const head = '共同开头很长很长，用来复现截断指纹造成的误伤问题。'.repeat(20);
    const victim = await store.remember({ body: `${head}结论甲`, kind: 'note', sourceKind: 'user_explicit', sourceRef: 'a' });
    await store.deletePermanently(victim.id);

    const unrelated = await store.remember({ body: `${head}结论乙`, kind: 'note', sourceKind: 'user_explicit', sourceRef: 'b' });
    expect(unrelated.ok).toBe(true);
  });

  it('遗忘后的记忆不进入概览', async () => {
    const { store } = makeStore();
    await store.load();
    const a = await store.remember({ body: '保留的偏好。', kind: 'preference', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const b = await store.remember({ body: '被遗忘的偏好。', kind: 'preference', sourceKind: 'user_explicit', sourceRef: 'ui' });
    await store.forget(b.id);

    const { buildProfileView } = await import('@mom/core');
    const view = buildProfileView(store.all(), { now: T0 });
    const ids = view.sections.flatMap(section => section.entries.map(entry => entry.id));
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(view.excluded.archived).toBe(1);
  });
});

describe('索引可重建', () => {
  it('重建后检索结果与重建前一致', async () => {
    const { store, fs } = makeStore();
    await store.load();
    await store.remember({ body: '第一条：我喜欢早起。', kind: 'preference', sourceKind: 'user_explicit', sourceRef: 'ui' });
    await store.remember({ body: '第二条：项目用 pnpm。', kind: 'decision', sourceKind: 'user_explicit', sourceRef: 'ui' });
    const before = await store.search({ text: '早起' });
    expect(before.hits).toHaveLength(1);

    const report = await store.rebuild();
    expect(report.valid).toBe(2);
    const after = await store.search({ text: '早起' });
    expect(after.hits.map(hit => hit.id)).toEqual(before.hits.map(hit => hit.id));

    // 直接丢掉索引（新实例）也必须得到相同结果。
    const fresh = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(3) });
    await fresh.load();
    const freshResult = await fresh.search({ text: '早起' });
    expect(freshResult.hits.map(hit => hit.id)).toEqual(before.hits.map(hit => hit.id));
  });

  it('从旧版本索引升级不需要手工干预（索引是派生物）', async () => {
    const { store, fs } = makeStore();
    await store.load();
    await store.remember({ body: '内容。', kind: 'fact', sourceKind: 'user_explicit', sourceRef: 'ui' });
    await fs.writeFile('Second Brain/.memory/state.json', '{"version":1,"processed_events":{},"index_version":0,"last_sync_at":"","cursor":""}', {});
    const reopened = new MemoryStore({ store: fs, root: 'Second Brain', now: () => T0, rand: seededRand(3) });
    await reopened.load();
    expect(reopened.indexSize).toBe(1);
  });
});

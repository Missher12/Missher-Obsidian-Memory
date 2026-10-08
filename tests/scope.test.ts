/**
 * 审计缺陷 6 与 7：
 *
 * 6. `MemoryIndex.search` 未传 `scopes` 时返回**所有**项目；选定项目 A 后，
 *    诊断里仍能看到项目 B 的标题、路径与范围。
 * 7. 已到期记忆仍进入默认事实结果；去重只取前 400 字会把不同长文当成重复。
 *
 * 这里在 store 层与纯索引层分别验证，因为“先授权、后检索”必须在两层都成立。
 */

import { describe, expect, it } from 'vitest';
import { MemoryIndex, MemoryStore, type MemoryRecord, type ScopeKind } from '@mom/core';
import { T0, fixedClock, memoryStore, seededRand } from './helpers.js';

function makeStore(): { store: MemoryStore; clock: ReturnType<typeof fixedClock> } {
  const clock = fixedClock(T0);
  const store = new MemoryStore({
    store: memoryStore(),
    root: 'Second Brain',
    now: clock.now,
    rand: seededRand(7),
  });
  return { store, clock };
}

async function seed(store: MemoryStore): Promise<{ personal: string; projectA: string; projectB: string }> {
  await store.load();
  const personal = await store.remember({
    body: '我常驻上海，偏好深色主题。',
    kind: 'preference',
    sourceKind: 'user_explicit',
    sourceRef: 'ui',
    tags: ['偏好'],
    aliases: ['居住地'],
  });
  const projectA = await store.remember({
    body: '项目 Apollo 决定使用 TypeScript 作为唯一实现语言。',
    kind: 'decision',
    scope: 'project',
    scopeRef: 'apollo',
    sourceKind: 'user_explicit',
    sourceRef: 'ui',
    tags: ['apollo', '技术选型'],
  });
  const projectB = await store.remember({
    body: '项目 Borealis 决定使用 Rust 重写结算服务，代号 BOREALIS-SECRET。',
    kind: 'decision',
    scope: 'project',
    scopeRef: 'borealis',
    sourceKind: 'user_explicit',
    sourceRef: 'ui',
    tags: ['borealis'],
  });
  expect(personal.ok && projectA.ok && projectB.ok).toBe(true);
  return { personal: personal.id, projectA: projectA.id, projectB: projectB.id };
}

describe('范围隔离：先授权、后检索', () => {
  it('未指定 scopes 时只返回 personal，绝不跨项目（历史反例）', async () => {
    const { store } = makeStore();
    const ids = await seed(store);

    const result = await store.search({ text: '深色主题', limit: 20 });
    const returnedIds = result.hits.map(hit => hit.id);
    expect(returnedIds).toContain(ids.personal);

    // personal 可见，但两个项目都不可见——即使查询词与它们高度相关。
    const projectQuery = await store.search({ text: '决定', limit: 20 });
    expect(projectQuery.hits.map(hit => hit.id)).not.toContain(ids.projectA);
    expect(projectQuery.hits.map(hit => hit.id)).not.toContain(ids.projectB);

    // 诊断里不能出现未授权项目的标题、路径或范围。
    const serializedDiagnosis = JSON.stringify(result.diagnosis);
    expect(serializedDiagnosis).not.toContain('Borealis');
    expect(serializedDiagnosis).not.toContain('BOREALIS-SECRET');
    expect(serializedDiagnosis).not.toContain('borealis');
    expect(serializedDiagnosis).not.toContain(store.get(ids.projectB)!.path);
    expect(serializedDiagnosis).not.toContain(store.get(ids.projectA)!.path);
  });

  it('授权项目 A 后只能看到 A，诊断里没有 B 的痕迹（历史反例）', async () => {
    const { store } = makeStore();
    const ids = await seed(store);

    const result = await store.search({
      text: '决定',
      limit: 20,
      scopes: [{ scope: 'personal' }, { scope: 'project', ref: 'apollo' }],
    });
    const returnedIds = result.hits.map(hit => hit.id);
    expect(returnedIds).toContain(ids.projectA);
    expect(returnedIds).not.toContain(ids.projectB);

    const diagnosis = JSON.stringify(result.diagnosis);
    expect(diagnosis).not.toContain('Borealis');
    expect(diagnosis).not.toContain('borealis');
    expect(diagnosis).not.toContain('BOREALIS-SECRET');
  });

  it('只有项目范围时，personal 也不再返回', async () => {
    const { store } = makeStore();
    await seed(store);
    const result = await store.search({ text: '决定', limit: 20, scopes: [{ scope: 'project', ref: 'apollo' }] });
    expect(result.hits.every(hit => hit.scope === 'project')).toBe(true);
  });

  it('范围不匹配项只统计数量，不泄露身份信息', async () => {
    const { store } = makeStore();
    await seed(store);
    const result = await store.search({ text: '决定', limit: 20 });
    // 未授权项目被静默丢弃（含诊断），不产生 scope_mismatch 明细。
    expect(result.diagnosis.notes.some(note => note.code === 'scope_mismatch')).toBe(false);
  });

  it('纯索引层同样遵守“缺省即最小可见范围”', () => {
    const index = new MemoryIndex({ now: () => T0 });
    const record = (id: string, scope: 'personal' | 'project', scopeRef: string, body: string): MemoryRecord => ({
      meta: {
        id,
        kind: 'fact',
        status: 'confirmed',
        scope,
        scope_ref: scopeRef,
        source_kind: 'user_explicit',
        source_ref: '',
        revision: 1,
        observed_at: new Date(T0).toISOString(),
        valid_from: '',
        valid_until: '',
        supersedes: [],
        derived_from: [],
        review_after: '',
        updated_at: new Date(T0).toISOString(),
        tags: [],
        aliases: [],
        allow_model: true,
        dedupe_key: '',
      },
      body,
      path: `Second Brain/${id}.md`,
      sources: [],
    });
    index.add(record('mem_0000000000000001', 'personal', '', '# 个人\n\n深色主题'));
    index.add(record('mem_0000000000000002', 'project', 'apollo', '# A\n\n决定用 TS'));
    index.add(record('mem_0000000000000003', 'project', 'borealis', '# B\n\n秘密代号 XYZZY'));

    const bare = index.search({ text: '决定' });
    expect(bare.hits.map(hit => hit.id)).toEqual([]);
    expect(JSON.stringify(bare.diagnosis)).not.toContain('XYZZY');

    const scoped = index.search({ text: '决定', scopes: [{ scope: 'project', ref: 'apollo' }] });
    expect(scoped.hits.map(hit => hit.id)).toEqual(['mem_0000000000000002']);
  });

  it('C05：不完整的范围过滤器不会退化成“全部项目”（缺 ref 就不放行）', () => {
    const index = new MemoryIndex({ now: () => T0 });
    const record = (id: string, scope: ScopeKind, scopeRef: string, body: string): MemoryRecord => ({
      meta: {
        id,
        kind: 'note',
        status: 'confirmed',
        scope,
        scope_ref: scopeRef,
        source_kind: 'user_explicit',
        source_ref: 'ui',
        revision: 1,
        observed_at: new Date(T0).toISOString(),
        valid_from: '',
        valid_until: '',
        supersedes: [],
        derived_from: [],
        review_after: '',
        updated_at: new Date(T0).toISOString(),
        tags: [],
        aliases: [],
        allow_model: true,
        dedupe_key: id,
        event_ids: [],
      },
      body,
      path: `Second Brain/${id}.md`,
      sources: [],
    });
    index.add(record('mem_0000000000000011', 'project', 'apollo', '# A\n\n决定用 TS'));
    index.add(record('mem_0000000000000012', 'project', 'borealis', '# B\n\n秘密代号 XYZZY'));
    index.add(record('mem_0000000000000013', 'personal', '', '# 个人\n\n决定早睡'));

    /**
     * 缺 `ref` 的 project 过滤器以前等价于“所有项目”，一次字段写漏就
     * 把范围放大到全部项目。现在它什么也不放行，并且诊断里不泄露
     * 其他项目的标题、路径或正文。
     */
    const incomplete = index.search({ text: '决定', scopes: [{ scope: 'project' }] });
    expect(incomplete.hits).toEqual([]);
    const serialized = JSON.stringify(incomplete.diagnosis);
    expect(serialized).not.toContain('XYZZY');
    expect(serialized).not.toContain('borealis');
    expect(serialized).not.toContain('mem_0000000000000012');

    // 空 `ref` 字符串、只有空白的 `ref` 同样视为不完整。
    expect(index.search({ text: '决定', scopes: [{ scope: 'project', ref: '' }] }).hits).toEqual([]);
    expect(index.search({ text: '决定', scopes: [{ scope: 'project', ref: '   ' }] }).hits).toEqual([]);

    // personal 允许省略 ref。
    const personal = index.search({ text: '决定', scopes: [{ scope: 'personal' }] });
    expect(personal.hits.map(hit => hit.id)).toEqual(['mem_0000000000000013']);

    // 混合：一个不完整 + 一个完整，只按完整的那条放行。
    const mixed = index.search({
      text: '决定',
      scopes: [{ scope: 'project' }, { scope: 'project', ref: 'apollo' }],
    });
    expect(mixed.hits.map(hit => hit.id)).toEqual(['mem_0000000000000011']);
  });
});

describe('过期与去重', () => {
  it('默认检索排除已到期记录，并说明原因', async () => {
    const { store, clock } = makeStore();
    await store.load();
    const expiring = await store.remember({
      body: '我在 2026 年 3 月使用的是旧版订阅方案。',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
      validUntil: new Date(T0 + 1000).toISOString(),
    });
    clock.advance(86_400_000);

    const withExpiry = await store.searchWithExpiry({ text: '订阅方案', excludeExpired: true });
    expect(withExpiry.hits).toEqual([]);
    expect(withExpiry.diagnosis.notes.some(note => note.code === 'expired')).toBe(true);

    /**
     * C06：默认召回对**所有查询形状**一致地排除过期记录，包括空查询。
     * 想看历史必须显式要求 `includeExpired`——历史一直保留，从未被删除。
     */
    const withoutFlag = await store.search({ text: '订阅方案' });
    expect(withoutFlag.hits).toEqual([]);
    const emptyQuery = await store.search({ text: '' });
    expect(emptyQuery.hits.map(hit => hit.id)).not.toContain(expiring.id);

    const historical = await store.search({ text: '订阅方案', includeExpired: true });
    expect(historical.hits.map(hit => hit.id)).toEqual([expiring.id]);
    expect(store.get(expiring.id)?.meta.status).toBe('confirmed');
  });

  it('开头相同的两篇长文不会被当作重复（历史反例）', async () => {
    const { store } = makeStore();
    await store.load();
    const head = '这是一段很长的共同开头，用来复现只取前 400 字归一化文本导致的误判。'.repeat(20);
    const a = await store.remember({ body: `${head}结论甲。`, kind: 'note', sourceKind: 'user_explicit', sourceRef: 'a' });
    const b = await store.remember({ body: `${head}结论乙。`, kind: 'note', sourceKind: 'user_explicit', sourceRef: 'b' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
  });

  it('完全相同的内容来自不同来源时仍然是两条独立记忆', async () => {
    const { store } = makeStore();
    await store.load();
    const a = await store.remember({ body: '同样的一句话。', kind: 'note', sourceKind: 'user_explicit', sourceRef: 'a' });
    const b = await store.remember({ body: '同样的一句话。', kind: 'note', sourceKind: 'user_explicit', sourceRef: 'b' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('未知 scope 的记录退出检索', () => {
  it('手工写入未知 scope 后，该记录不可检索但会被报告为问题', async () => {
    const clock = fixedClock(T0);
    const fs = memoryStore();
    const seeded = new MemoryStore({ store: fs, root: 'Second Brain', now: clock.now, rand: seededRand(11) });
    await seeded.load();

    const normal = await seeded.remember({
      body: '这是我的正常偏好：早上不排会。',
      kind: 'preference',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const tampered = await seeded.remember({
      body: '这一条的 scope 会被手改成未知值。',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    expect(normal.ok && tampered.ok).toBe(true);

    // 模拟用户在 Obsidian 里手改 frontmatter。
    const raw = fs.peek(tampered.path)!;
    expect(raw).toContain('scope: personal');
    fs.simulateManualEdit(tampered.path, raw.replace('scope: personal', 'scope: team-internal'));

    // 新的 store 实例从磁盘重建：坏记录必须被隔离而不是被降级为 personal。
    const rebuilt = new MemoryStore({ store: fs, root: 'Second Brain', now: clock.now, rand: seededRand(11) });
    const report = await rebuilt.load({ force: true });
    expect(report.problems.some(problem => problem.path === tampered.path)).toBe(true);
    expect(rebuilt.problems.some(problem => problem.path === tampered.path)).toBe(true);

    const result = await rebuilt.search({ text: '早上不排会', limit: 20 });
    expect(result.hits.map(hit => hit.id)).not.toContain(tampered.id);
    expect(result.hits.map(hit => hit.id)).toContain(normal.id);

    // 正常记录不受影响，坏数据也没有被清空。
    expect(fs.peek(tampered.path)).toContain('team-internal');
  });
});

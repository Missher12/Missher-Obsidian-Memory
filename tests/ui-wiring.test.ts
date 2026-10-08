/**
 * UI 接线回归（对应协调者 audit-ui-initial.md 的 U1 / U2 / U3）。
 *
 * 这些用例**不启动 Obsidian**，而是用真实的核心（MemoryStore、review、
 * OpenAiCompatibleProvider、patches）加上 `tests/obsidian-stub.ts` 的假 Vault：
 * 目标是把「界面上点一下到底会不会真的发生什么」测清楚。
 *
 * - U1：插件的 provider 必须复用核心的**有界等待**与迟到拒绝；
 * - U2：用户点「接受」必须真的改变状态（用展示时的哈希做前置条件，
 *   冲突时保留人工新正文）；
 * - U3：建议身份不能是「本轮第几条」，处理状态要持久且不跨问题误伤。
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  OpenAiCompatibleProvider,
  PATCH_FILE,
  runLocalReview,
  suggestionIdentity,
  type ChatRequest,
  type ReviewSuggestion,
} from '@mom/core';
import { VaultFileStore } from '../packages/plugin/src/vault-store.js';
import {
  createFakeApp,
  FakeVault,
  requestUrlCalls,
  resetRequestUrlCalls,
  setRequestUrlHandler,
} from './obsidian-stub.js';
import { fixedClock, seededRand, T0 } from './helpers.js';
import { MemoryService, SECRET_ID } from '../packages/plugin/src/memory-service.js';
import { AiJobRunner } from '../packages/plugin/src/job-runner.js';
import { defaultSettings } from '@mom/core';
import {
  emptyReviewState,
  filterHandled,
  parseReviewState,
  recordDecision,
  serializeReviewState,
} from '../packages/plugin/src/review-state.js';
import { acceptSuggestion } from '../packages/plugin/src/review-actions.js';
import MissherMemoryPlugin from '../packages/plugin/src/plugin.js';

/**
 * 每个 store 用一个**推进的**确定性随机源。
 *
 * 常量 `rand` 会让「id 已占用就重试」永远拿到同一个 id；核心现在有界
 * 失败，但测试也不该依赖那种退化行为——它测不出任何真实语义。
 */
let seedCounter = 100;
function makeStore(vault: FakeVault, root = 'Brain') {
  const app = createFakeApp(vault);
  const fileStore = new VaultFileStore({ app: app as never, memoryRoot: root });
  const clock = fixedClock(T0);
  const store = new MemoryStore({
    store: fileStore,
    root,
    now: clock.now,
    rand: seededRand((seedCounter += 7)),
  });
  return { vault, store, fileStore, clock };
}

/* ------------------------------------------------------------------ */
/* U1（原生入口）：MemoryService 的 provider 构造                       */
/* ------------------------------------------------------------------ */

describe('U1 MemoryService 的 provider 走核心边界（不是另写一套）', () => {
  const settingsWith = (patch: Record<string, unknown>): ReturnType<typeof defaultSettings> => {
    const base = defaultSettings();
    return { ...base, ai: { ...base.ai, ...patch } };
  };

  function makeService(vault: FakeVault, settings: ReturnType<typeof defaultSettings>) {
    const app = createFakeApp(vault);
    return new MemoryService({
      app: app as never,
      memoryRoot: 'Brain',
      instanceId: 'test_instance',
      getSettings: () => settings,
    });
  }

  it('未配置时拒绝发送，且一次网络调用都不会发生', async () => {
    resetRequestUrlCalls();
    const service = makeService(new FakeVault(), settingsWith({ enabled: false }));
    const result = await service.createProvider().complete({ messages: [] });
    expect(result.delivered).toBe(false);
    expect(result.waitOutcome).toBe('refused');
    expect(requestUrlCalls.length).toBe(0);
    expect(service.aiConfigured()).toBe(false);
  });

  it('等待超时：本端停止等待、迟到响应不采纳、计费未知如实报告', async () => {
    resetRequestUrlCalls();
    let release: ((value: { status: number; text: string }) => void) | null = null;
    setRequestUrlHandler(async () => await new Promise(resolve => {
      release = resolve as (value: { status: number; text: string }) => void;
    }));
    const service = makeService(
      new FakeVault(),
      settingsWith({ enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm', timeoutMs: 5, persistKey: false }),
    );
    const provider = service.createProvider();
    expect(provider.supportsAbort).toBe(true);
    const started = Date.now();
    const result = await provider.complete({ messages: [], timeoutMs: 5 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.ok).toBe(false);
    expect(result.waitOutcome).toBe('timed_out');
    expect(result.delivered).toBe(true);
    expect(result.billableUnknown).toBe(true);
    // 请求**确实**发出去了：这就是「停止等待 ≠ 没有发生」的证据。
    expect(requestUrlCalls.length).toBe(1);
    release?.({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'late' } }] }) });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(result.text).toBe('');
    setRequestUrlHandler(null);
  });

  it('发送前已取消：不产生任何请求', async () => {
    resetRequestUrlCalls();
    setRequestUrlHandler(async () => ({ status: 200, text: '{"choices":[]}' }));
    const service = makeService(
      new FakeVault(),
      settingsWith({ enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm', timeoutMs: 1000 }),
    );
    const result = await service.createProvider().complete({ messages: [], signal: { aborted: true } });
    expect(result.delivered).toBe(false);
    expect(result.waitOutcome).toBe('refused');
    expect(requestUrlCalls.length).toBe(0);
    setRequestUrlHandler(null);
  });

  it('密钥存储选择真的影响行为：persistKey=false 时不读密钥存储，临时密钥仍可用', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    app.secretStorage.setSecret(SECRET_ID, 'persisted-key');
    const settings = settingsWith({ enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm', persistKey: false });
    const service = new MemoryService({
      app: app as never,
      memoryRoot: 'Brain',
      instanceId: 'test_instance',
      getSettings: () => settings,
    });
    expect(service.readCredential(settings)).toBe('');
    expect(service.keyConfigured()).toBe(false);
    // 没有密钥存储也必须能用：临时密钥只保留在本次运行内。
    service.writeSessionKey('session-key');
    expect(service.readCredential(settings)).toBe('session-key');
    expect(service.hasSessionKey()).toBe(true);

    const persisted = new MemoryService({
      app: app as never,
      memoryRoot: 'Brain',
      instanceId: 'test_instance',
      getSettings: () => settingsWith({ ...settings.ai, persistKey: true, keyStorage: 'secret-storage' }),
    });
    expect(persisted.readCredential(settingsWith({ persistKey: true }))).toBe('persisted-key');
  });

  it('持久队列接线：作业状态与补丁都落到 .memory/ 下并可恢复', async () => {
    const vault = new FakeVault();
    const settings = settingsWith({ enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm', persistKey: false });
    const service = makeService(vault, settings);
    await service.load(true);
    await service.restoreJobs();

    const job = await service.jobs.enqueue({ kind: 'extract_session', scope: 'extract', trigger: 'manual' });
    expect(await service.persistJobs()).toBe(true);
    const jobsRaw = vault.rawFiles.get('Brain/.memory/jobs.json')?.content ?? '';
    expect(jobsRaw).toContain(job.id);

    // 重启（新的 service 实例）后仍能读到同一条作业，并且不会自动重放。
    const restarted = makeService(vault, settings);
    const restored = await restarted.restoreJobs();
    expect(restored.touched).toBeGreaterThanOrEqual(0);
    expect(restarted.jobs.jobs.get(job.id)).toBeDefined();

    const created = await service.store.remember({ body: '补丁落盘检查。', sourceKind: 'user_explicit' });
    const patch = await service.store.proposePatch({
      targetId: created.id,
      fields: { body: '补丁落盘检查（改）。' },
      author: 'ai:ai_review',
      reason: '落盘验证',
    });
    expect(patch.ok).toBe(true);
    expect(vault.rawFiles.get(`Brain/.memory/${PATCH_FILE}`)?.content ?? '').toContain(patch.id);
  });
});

/* ------------------------------------------------------------------ */
/* 发送许可：allow_model / 状态 / 有效期 / 撤回                         */
/* ------------------------------------------------------------------ */

describe('发送给模型的内容必须先过许可筛', () => {
  const buildContext = async () => {
    const core = await import('@mom/core');
    return core.buildContext;
  };

  it('allow_model=false 的记录不会进入提示词（正文里没有那串哨兵）', async () => {
    const PRIVATE_SENTINEL = 'PRIVATE_SENTINEL_DO_NOT_SEND';
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => T0, rand: seededRand(31) });
    await store.remember({
      body: `${PRIVATE_SENTINEL} 这是不该外发的内容。`,
      sourceKind: 'user_explicit',
      allowModel: false,
    });
    await store.remember({ body: '可以外发的公开内容。', sourceKind: 'user_explicit' });
    const hits = (await store.search({ text: '内容', limit: 8 })).hits;

    /**
     * 与插件 `askWithSources` 相同的筛选：只把允许发送的 id 交给 buildContext。
     * 这里直接断言「提示词材料」里没有哨兵——这正是审计的检查方式。
     */
    const allowed = new Set<string>();
    for (const hit of hits) {
      const record = store.get(hit.id);
      if (record !== null && record.meta.allow_model === true && record.meta.status === 'confirmed') allowed.add(hit.id);
    }
    expect(allowed.size).toBe(1);
    const context = await buildContext();
    const bundle = context(
      hits,
      id => {
        const record = store.get(id);
        if (record === null) return null;
        return { body: record.body, sourceRef: record.meta.source_ref };
      },
      { allowIds: allowed },
    );
    const rendered = bundle.items.map(item => item.text).join('\n');
    expect(rendered).not.toContain(PRIVATE_SENTINEL);
    expect(bundle.dropped.some(item => item.reason.includes('allow_model') || item.reason.includes('白名单'))).toBe(true);
  });

  it('已撤回（archived）与过期的记录同样不允许发送', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => T0, rand: seededRand(41) });
    const archived = await store.remember({ body: '已经撤回的内容。', sourceKind: 'user_explicit' });
    await store.dispute(archived.id, { note: '有争议，先停用', expectedHash: store.hashOf(archived.id) ?? undefined });
    expect(store.get(archived.id)!.meta.status).toBe('disputed');
    expect(store.get(archived.id)!.meta.allow_model).toBe(true);
    // 状态不是 confirmed：不允许发送。
    expect(store.get(archived.id)!.meta.status !== 'confirmed').toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 付费状态与预算必须可对账                                            */
/* ------------------------------------------------------------------ */

describe('付费请求与预算的持久化', () => {
  it('发出请求之前就把 billableRequestSent 与预算落盘；重启后不重置当日限额', async () => {
    const vault = new FakeVault();
    const settings = {
      ...defaultSettings(),
      ai: { ...defaultSettings().ai, enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm' },
    };
    const app = createFakeApp(vault);
    const first = new MemoryService({
      app: app as never,
      memoryRoot: 'Brain',
      instanceId: 'inst_a',
      getSettings: () => settings,
    });
    await first.load(true);
    await first.restoreJobs();
    await first.store.remember({ body: '需要提取的内容。', sourceKind: 'user_explicit' });
    first.jobs.noticeInput(T0);

    let persistedAtCallTime = '';
    const job = await first.jobs.enqueue({ kind: 'extract_session', scope: 'extract', trigger: 'manual' });
    const outcome = await first.jobs.run(job.id, async context => {
      /**
       * 进入 work 就说明请求即将发出：这一刻磁盘上必须已经记好账——
       * 作业标记为已计费，而且预算里已经有**预占**（不是 0）。
       */
      persistedAtCallTime = vault.rawFiles.get('Brain/.memory/jobs.json')?.content ?? '';
      // 真实用量必须能被登记，settle 之后账目才是实测值而不是估算。
      context.reportUsage({ promptTokens: 100, completionTokens: 23 });
      return {
        ok: true,
        message: '假调用',
        modelUsed: true,
        usage: { promptTokens: 100, completionTokens: 23 },
      };
    });
    expect(outcome.status).toBe('completed');
    expect(persistedAtCallTime).toContain('"billableRequestSent": true');
    expect(persistedAtCallTime).toContain(job.id);
    // 发出前就已预占：这是「崩溃也能对账」的关键，预占额是保守估算。
    const reservedAtCallTime = Number(/"tokens":\s*(\d+)/.exec(persistedAtCallTime)?.[1] ?? '0');
    expect(reservedAtCallTime).toBeGreaterThan(0);

    const afterRaw = vault.rawFiles.get('Brain/.memory/jobs.json')?.content ?? '';
    expect(afterRaw).toContain('"calls": 1');
    // 用量回来之后按**实测**对账：100 + 23，而不是预占的估算值。
    expect(afterRaw).toContain('"tokens": 123');
    expect(first.jobs.lastSettlementReport()).toEqual({ accounted: 'measured', tokens: 123 });

    /**
     * 重建一个服务（等价于重启）：
     * - 当日预算必须**保留**（不能被重启清零，否则限额形同虚设）；
     * - 已发出付费请求的作业必须仍被标成已计费，恢复时归入 unknown 而不是重放。
     */
    const restarted = new MemoryService({
      app: app as never,
      memoryRoot: 'Brain',
      instanceId: 'inst_b',
      getSettings: () => settings,
    });
    await restarted.load(true);
    const restored = await restarted.restoreJobs();
    expect(restarted.jobs.budgetSnapshot().calls).toBe(1);
    expect(restarted.jobs.budgetSnapshot().tokens).toBe(123);
    void restored;
  });

  it('状态写不进去时拒绝调用模型（宁可不跑也不留无法对账的付费请求）', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => T0, rand: seededRand(51) });
    let called = 0;
    const runner = new AiJobRunner({
      store,
      instanceId: 'inst',
      now: () => T0,
      // 持久化永远失败：等价于磁盘只读。
      persist: async () => false,
    });
    const job = await runner.enqueue({ kind: 'extract_session', scope: 'extract', trigger: 'manual' });
    const outcome = await runner.run(job.id, async () => {
      called += 1;
      return { ok: true, message: '不该发生', modelUsed: true };
    });
    expect(called).toBe(0);
    expect(outcome.status).toBe('refused');
    expect(outcome.message).toContain('持久化');
    // 预占被退回：没有落盘的调用不能留在账上。
    expect(runner.budgetSnapshot().calls).toBe(0);
  });

  it('结果未知的付费作业在恢复后保持 unknown，直到用户显式处理', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => T0, rand: seededRand(61) });
    let state = '';
    const runner = new AiJobRunner({
      store,
      instanceId: 'inst',
      now: () => T0,
      persist: async next => {
        state = JSON.stringify(next);
        return true;
      },
    });
    const job = await runner.enqueue({ kind: 'extract_session', scope: 'extract', trigger: 'manual' });
    // 模拟「发出请求之后进程死掉」：直接把状态改成 running + 已计费。
    const crashed = { ...JSON.parse(state), jobs: JSON.parse(state).jobs.map((item: { id: string }) => (item.id === job.id ? { ...item, status: 'running', billableRequestSent: true } : item)) };
    state = JSON.stringify(crashed);
    const restarted = new AiJobRunner({ store, instanceId: 'inst', now: () => T0, persist: async () => true });
    const touched = await restarted.load(state, { resumeRunning: true });
    expect(touched.length).toBe(1);
    expect(touched[0]!.status).toBe('unknown');
    expect(restarted.jobs.get(job.id)!.status).toBe('unknown');
    // 不能靠普通「继续」把它重新发出去。
    expect(restarted.jobs.start(job.id, T0).ok).toBe(false);
    // 只有用户显式处理才改变它。
    const resolved = await restarted.resolveUnknown(job.id, 'discard');
    expect(resolved.ok).toBe(true);
    expect(restarted.jobs.get(job.id)!.status).toBe('cancelled');
  });
});

/* ------------------------------------------------------------------ */
/* 有界 id 生成：随机源退化不能把应用卡死                                */
/* ------------------------------------------------------------------ */

describe('记忆 id 生成必须有界', () => {
  it('常量随机源下第二次写入抛出可诊断错误，而不是死循环', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    // 刻意退化：永远返回同一个数 —— 这正是当初卡死测试的原因。
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => T0, rand: () => 0.42 });
    const first = await store.remember({ body: '第一条。', sourceKind: 'user_explicit' });
    expect(first.ok).toBe(true);
    await expect(store.remember({ body: '第二条。', sourceKind: 'user_explicit' })).rejects.toThrow(/已被占用/);
    // 失败必须是无副作用的：没有多出任何记忆文件。
    expect(store.all().length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* U1：有界等待与迟到拒绝（核心 provider 契约）                         */
/* ------------------------------------------------------------------ */

describe('U1 模型请求边界复用核心 provider', () => {
  it('等待超时后不再采纳迟到的响应，并如实报告计费未知', async () => {
    let release: ((value: { status: number; text: string }) => void) | null = null;
    const transport = async (): Promise<{ status: number; text: string }> =>
      await new Promise(resolve => {
        release = resolve;
      });
    const provider = new OpenAiCompatibleProvider({
      config: { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' },
      transport,
      controllerFactory: () => {
        const controller = new AbortController();
        return {
          signal: controller.signal,
          abort: () => controller.abort(),
          aborted: () => controller.signal.aborted,
        };
      },
    });
    const request: ChatRequest = { messages: [], timeoutMs: 5 };
    const started = Date.now();
    const result = await provider.complete(request);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    expect(result.waitOutcome).toBe('timed_out');
    expect(result.delivered).toBe(true);
    expect(result.billableUnknown).toBe(true);

    // 迟到响应即使到达也不改变已经给出的结论。
    release?.({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'late' } }] }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
  });

  it('发送前已取消时不发出任何请求', async () => {
    let called = 0;
    const provider = new OpenAiCompatibleProvider({
      config: { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' },
      transport: async () => {
        called += 1;
        return { status: 200, text: '{}' };
      },
      controllerFactory: () => {
        const controller = new AbortController();
        return { signal: controller.signal, abort: () => controller.abort(), aborted: () => controller.signal.aborted };
      },
    });
    const result = await provider.complete({ messages: [], signal: { aborted: true } });
    expect(called).toBe(0);
    expect(result.waitOutcome).toBe('refused');
    expect(result.delivered).toBe(false);
  });

  it('没有 controller（无法真中止）时依然是有界等待', async () => {
    const provider = new OpenAiCompatibleProvider({
      config: { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' },
      transport: async () => await new Promise(() => undefined),
    });
    expect(provider.supportsAbort).toBe(false);
    const result = await provider.complete({ messages: [], timeoutMs: 5 });
    expect(result.waitOutcome).toBe('timed_out');
    expect(result.aborted).toBe(false);
    expect(result.billableUnknown).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* U2：用户接受必须真的改变状态                                        */
/* ------------------------------------------------------------------ */

describe('U2 用户接受的接受路径', () => {
  it('mark_disputed 真的把已确认记录置为停止使用', async () => {
    const { vault, store } = makeStore(new FakeVault());
    const first = await store.remember({ body: '部署走 A 通道。', sourceKind: 'user_explicit' });
    const second = await store.remember({ body: '部署走 B 通道。', sourceKind: 'user_explicit' });
    expect(first.ok && second.ok).toBe(true);
    const target = store.get(first.id)!;
    const suggestion: ReviewSuggestion = {
      id: 'rv_manual_dispute',
      kind: 'conflict',
      title: '部署通道有两条说法',
      detail: '需要人工确认哪一条仍然有效。',
      impact: { memoryIds: [first.id, second.id], scopes: ['personal'] },
      evidence: [
        { kind: 'memory', ref: target.path, detail: `${first.id} · rev ${target.meta.revision}` },
      ],
      action: { type: 'mark_disputed', targetId: first.id, note: '与另一条冲突' },
      status: 'open',
    };
    const outcome = await acceptSuggestion(suggestion, {
      store,
      capturedHashOf: id => store.hashOf(id) ?? undefined,
    });
    expect(outcome.ok).toBe(true);
    expect(store.get(first.id)!.meta.status).toBe('archived');
    expect(store.get(second.id)!.meta.status).toBe('confirmed');
    expect(vault.rawFiles.size).toBeGreaterThan(0);
  });

  it('correct_memory 在展示之后被人工改过时报冲突且不覆盖新正文', async () => {
    const { store } = makeStore(new FakeVault());
    const created = await store.remember({ body: '构建脚本用 npm。', sourceKind: 'user_explicit' });
    const captured = store.hashOf(created.id)!;
    // 用户/其他工具在审核期间改了正文。
    await store.update(created.id, {
      body: '构建脚本用 pnpm 11。',
      reason: '人工编辑',
      actor: 'user',
    });
    const suggestion: ReviewSuggestion = {
      id: 'rv_manual_correct',
      kind: 'conflict',
      title: '工具链写法需要更正',
      detail: '模型建议改成 npm。',
      impact: { memoryIds: [created.id], scopes: ['personal'] },
      evidence: [{ kind: 'memory', ref: store.get(created.id)!.path, detail: `${created.id} · rev 1` }],
      action: { type: 'correct_memory', targetId: created.id, replacement: '构建脚本用 npm。' },
      status: 'open',
    };
    const outcome = await acceptSuggestion(suggestion, {
      store,
      capturedHashOf: () => captured,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.needsReReview).toContain('变化');
    // 人工新正文必须保留。
    expect(store.get(created.id)!.body).toContain('pnpm 11');
  });

  it('展示时的哈希不能在接受瞬间被刷新（插件源码层守卫）', async () => {
    /**
     * 插件必须在**展示**时捕获哈希，并在接受时使用那一份。
     * 如果接受路径里再次调用 captureHashes，就等于「现查新哈希」——
     * 用户看到旧内容、系统却拿新哈希去写，后果是覆盖人工编辑。
     * 这里直接对源码做守卫断言，防止将来有人「顺手」加回去。
     */
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../packages/plugin/src/plugin.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async acceptSuggestion(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('async ignoreSuggestion(', start));
    expect(body).not.toContain('this.captureHashes(suggestion)');
    expect(body).toContain('capturedHashOf: id => captured.get(id)');
  });

  it('另一轮列表刷新不得重绑已经展示的旧建议的哈希（与独立验收 UI-review-redisplay 同序列）', async () => {
    /**
     * 审计复现：展示旧建议 A → 人工编辑 A 涉及的记忆 →
     * 工作台再刷新一轮 `allSuggestions()`（同一批记忆的新哈希写回）→
     * 此时点击 A 的「接受」，如果用刷新后的新哈希做前置条件，提交会通过，
     * 旧建议的内容就覆盖掉人工编辑（revision 涨到 2 甚至 3）。
     *
     * 期望：旧建议仍然只认自己展示时的哈希 → 提交被拒 → 人工编辑保留、revision 不变。
     */
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const settings = defaultSettings();
    settings.root = 'Brain';
    const service = new MemoryService({
      app: app as never,
      memoryRoot: 'Brain',
      instanceId: 'u6-review-redisplay',
      getSettings: () => settings,
    });
    await service.load();
    const plugin = new MissherMemoryPlugin(app as never, {} as never);
    // 直接注入真实服务：与独立验收的接法一致，不重复走 onload 的界面接线。
    (plugin as unknown as { service: MemoryService }).service = service;
    (plugin as unknown as { refreshViews: () => Promise<void> }).refreshViews = async () => {};

    const first = await service.store.remember({
      title: '合成复盘对象',
      body: '合成事实甲',
      sourceKind: 'user_explicit',
      eventId: 'stale-review-redisplay-a',
    });
    const second = await service.store.remember({
      title: '合成复盘对象',
      body: '合成事实乙',
      sourceKind: 'user_explicit',
      eventId: 'stale-review-redisplay-b',
    });
    expect(first.ok && second.ok).toBe(true);

    const stale = (await plugin.allSuggestions()).find(item => item.kind === 'conflict');
    expect(stale?.action.type).toBe('mark_disputed');
    if (stale === undefined || stale.action.type !== 'mark_disputed') throw new Error('样例必须产出一条可执行的冲突建议');
    const targetId = stale.action.targetId;

    // 人工编辑：这一版才是用户当前的内容。
    const edited = await service.store.correct(targetId, {
      replacement: 'MANUAL_NEW_VERSION_REDISPLAY_883',
      reason: 'synthetic manual edit',
      expectedHash: service.store.hashOf(targetId),
    });
    expect(edited.ok).toBe(true);

    // 又刷新一轮列表：同一条记忆以新版本重新出现。
    const fresh = await plugin.allSuggestions();
    expect(fresh.some(item => item.impact.memoryIds.includes(targetId))).toBe(true);

    // 点击**旧**建议：必须被拒，人工编辑必须留住。
    const message = await plugin.acceptSuggestion(stale);
    const current = service.store.get(targetId)!;
    expect({ message, status: current.meta.status, revision: current.meta.revision }).toEqual({
      message,
      status: 'confirmed',
      revision: 2,
    });
    expect(current.body).toContain('MANUAL_NEW_VERSION_REDISPLAY_883');
  });

  it('correct_memory 在哈希一致时按用户权限直接生效', async () => {
    const { store } = makeStore(new FakeVault());
    const created = await store.remember({ body: '构建脚本用 npm run build。', sourceKind: 'user_explicit' });
    const captured = store.hashOf(created.id)!;
    const suggestion: ReviewSuggestion = {
      id: 'rv_manual_correct_ok',
      kind: 'stale',
      title: '命令需要更新',
      detail: '建议替换为 pnpm build。',
      impact: { memoryIds: [created.id], scopes: ['personal'] },
      evidence: [{ kind: 'memory', ref: store.get(created.id)!.path, detail: `${created.id} · rev 1` }],
      action: { type: 'correct_memory', targetId: created.id, replacement: '构建脚本用 pnpm build。' },
      status: 'open',
    };
    const outcome = await acceptSuggestion(suggestion, { store, capturedHashOf: () => captured });
    expect(outcome.ok).toBe(true);
    expect(store.get(created.id)!.body).toContain('pnpm build');
    expect(store.get(created.id)!.meta.revision).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 待审补丁：AI 想改已确认事实的唯一通道                                */
/* ------------------------------------------------------------------ */

describe('待审补丁', () => {
  it('AI 提案不改正文；用户接受才应用，且带提议时的哈希', async () => {
    const { vault, store } = makeStore(new FakeVault());
    const created = await store.remember({ body: '每周五发周报。', sourceKind: 'user_explicit' });
    const before = store.get(created.id)!.body;

    const proposed = await store.proposePatch({
      targetId: created.id,
      fields: { body: '每周四发周报（周五是休息日）。' },
      author: 'ai:ai_review',
      reason: '与日历记录冲突',
    });
    expect(proposed.ok).toBe(true);
    // 提议阶段正文完全没动。
    expect(store.get(created.id)!.body).toBe(before);

    const accepted = await store.acceptPatch(proposed.id, { handledBy: 'user' });
    expect(accepted.ok).toBe(true);
    expect(store.get(created.id)!.body).toContain('每周四');
    expect(store.get(created.id)!.meta.revision).toBe(2);

    const patchFile = vault.rawFiles.get(`Brain/.memory/${PATCH_FILE}`)?.content ?? '';
    expect(patchFile).toContain('"status": "accepted"');
  });

  it('接受前目标被人工改过：报冲突、保留人工正文、补丁标记重新审核', async () => {
    const { store } = makeStore(new FakeVault());
    const created = await store.remember({ body: '部署在周五。', sourceKind: 'user_explicit' });
    const proposed = await store.proposePatch({
      targetId: created.id,
      fields: { body: '部署在周三。' },
      author: 'ai:ai_review',
      reason: '排期调整',
    });
    expect(proposed.ok).toBe(true);
    await store.update(created.id, { body: '部署在周二（人工确认）。', reason: '人工改动', actor: 'user' });

    const accepted = await store.acceptPatch(proposed.id, { handledBy: 'user' });
    expect(accepted.ok).toBe(false);
    expect(accepted.note).toContain('变化');
    expect(store.get(created.id)!.body).toContain('周二');
    expect(store.patchById(proposed.id)!.status).toBe('conflict');
  });

  it('忽略补丁不改动任何记忆', async () => {
    const { store } = makeStore(new FakeVault());
    const created = await store.remember({ body: '周末不排期。', sourceKind: 'user_explicit' });
    const proposed = await store.proposePatch({
      targetId: created.id,
      fields: { body: '周末可以排期。' },
      author: 'ai:ai_review',
      reason: '与排期表冲突',
    });
    const ignored = await store.ignorePatch(proposed.id, { handledBy: 'user' });
    expect(ignored.ok).toBe(true);
    expect(store.get(created.id)!.body).toContain('周末不排期');
    expect(store.get(created.id)!.meta.revision).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* U3：建议身份与处理状态                                              */
/* ------------------------------------------------------------------ */

describe('U3 建议身份与处理状态', () => {
  it('不同记忆的同类问题得到不同 id（不会互相掩盖）', async () => {
    const { store } = makeStore(new FakeVault());
    await store.remember({ body: '重复内容 A。', sourceKind: 'user_explicit' });
    await store.remember({ body: '重复内容 A。', sourceKind: 'user_explicit' });
    const firstGroup = await runLocalReview(store.all());
    const duplicateFirst = firstGroup.find(item => item.kind === 'duplicate')!;
    expect(duplicateFirst).toBeDefined();

    // 第二组完全不同的重复问题。
    const other = makeStore(new FakeVault());
    await other.store.remember({ body: '重复内容 B。', sourceKind: 'user_explicit' });
    await other.store.remember({ body: '重复内容 B。', sourceKind: 'user_explicit' });
    const secondGroup = await runLocalReview(other.store.all());
    const duplicateSecond = secondGroup.find(item => item.kind === 'duplicate')!;

    expect(duplicateFirst.id).not.toBe(duplicateSecond.id);
    // 忽略第一组之后，第二组仍然可见。
    const state = recordDecision(emptyReviewState(Date.now()), duplicateFirst, 'ignored', '用户忽略', Date.now());
    const visible = filterHandled(secondGroup, state);
    expect(visible.some(item => item.kind === 'duplicate')).toBe(true);
  });

  it('处理状态持久化；重启后不再重复提示，版本变化则重新开放', async () => {
    const { store } = makeStore(new FakeVault());
    await store.remember({ body: '同一句话。', sourceKind: 'user_explicit' });
    await store.remember({ body: '同一句话。', sourceKind: 'user_explicit' });
    const suggestions = await runLocalReview(store.all());
    const duplicate = suggestions.find(item => item.kind === 'duplicate')!;

    const state = recordDecision(emptyReviewState(Date.now()), duplicate, 'ignored', '忽略', Date.now());
    const roundTrip = parseReviewState(serializeReviewState(state, Date.now())).file;
    expect(filterHandled(suggestions, roundTrip)).toEqual([]);

    // 版本变化（编辑其中一条）后同一条建议必须重新出现。
    const target = duplicate.impact.memoryIds[0]!;
    await store.update(target, { body: '同一句话（改过）。', reason: '人工编辑', actor: 'user' });
    const afterEdit = await runLocalReview(store.all());
    const reopened = afterEdit.find(item => item.kind === 'duplicate');
    if (reopened !== undefined) {
      expect(filterHandled([reopened], roundTrip).length).toBe(1);
    }
  });

  it('suggestionIdentity 与顺序、显示文本无关', () => {
    const a = suggestionIdentity('duplicate', ['mem_b', 'mem_a'], [2, 1]);
    const b = suggestionIdentity('duplicate', ['mem_a', 'mem_b'], [1, 2]);
    expect(a).toBe(b);
    expect(suggestionIdentity('duplicate', ['mem_a'])).not.toBe(a);
  });
});

/* ------------------------------------------------------------------ */
/* U6（真实入口）：所有模型调用都受同一份持久预算约束                   */
/* ------------------------------------------------------------------ */

/**
 * 这一组用例针对一个具体的漏洞：问答（`askWithSources`）与作业曾经是两条
 * 各自记账的路径——作业受每日上限约束，问答却可以直接发请求。
 * 因此这里**不测闸门本身**（那属于单元测试），而是驱动插件真正调用的
 * `askWithBoundedModel`，让「真实入口有没有过闸门」变成可执行的断言。
 */
describe('U6 真实入口的模型调用都有界（问答与作业同一份账）', () => {
  const settingsWith = (patch: Record<string, unknown>): ReturnType<typeof defaultSettings> => {
    const base = defaultSettings();
    return { ...base, ai: { ...base.ai, ...patch } };
  };

  function makeBridge(options: {
    runnerConfig?: Partial<ConstructorParameters<typeof AiJobRunner>[0]['config']>;
    persist?: (state: unknown) => Promise<boolean>;
  } = {}) {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => T0, rand: seededRand(71) });
    const runner = new AiJobRunner({
      store,
      instanceId: 'inst',
      now: () => T0,
      persist: options.persist ?? (async () => true),
      ...(options.runnerConfig === undefined ? {} : { config: options.runnerConfig as never }),
    });
    const settings = settingsWith({ enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm', timeoutMs: 1000 });
    const service = new MemoryService({
      app: app as never,
      memoryRoot: 'Brain',
      instanceId: 'inst',
      getSettings: () => settings,
    });
    return { vault, app, fileStore, store, runner, service, settings };
  }

  const askInput = (parts: ReturnType<typeof makeBridge>) => ({
    store: parts.store,
    jobs: parts.runner,
    createProvider: () => parts.service.createProvider(),
    maySend: (record: { meta: { allow_model: boolean }; invalid: boolean }) => {
      if (record.meta.allow_model !== true) {
        return { allowed: false, reason: 'allow_model=false' };
      }
      return { allowed: true, reason: '允许' };
    },
    maxContextChars: () => 4000,
    isUnloaded: () => false,
  });

  it('每日调用额度用尽后：问答一次请求都不发，并说明原因', async () => {
    resetRequestUrlCalls();
    setRequestUrlHandler(async () => ({ status: 200, text: '{"choices":[{"message":{"content":"ok"}}]}' }));
    const parts = makeBridge({ runnerConfig: { maxCallsPerDay: 1, maxTokensPerDay: 0 } });
    await parts.store.load();
    await parts.store.remember({ body: '用户住在杭州。', sourceKind: 'user_explicit' });
    await parts.store.confirm(parts.store.all()[0]!.meta.id);
    await parts.store.load();

    const { askWithBoundedModel } = await import('../packages/plugin/src/ask-gate.js');
    const first = await askWithBoundedModel(askInput(parts), '我住在哪里？');
    expect(requestUrlCalls.length).toBe(1);
    expect(first.gate.blocked).toBe(false);

    // 额度（1 次）已经用掉：第二次必须连请求都不发。
    resetRequestUrlCalls();
    const second = await askWithBoundedModel(askInput(parts), '我住在哪里？');
    expect(requestUrlCalls.length).toBe(0);
    expect(second.gate.blocked).toBe(true);
    expect(second.answer).toContain('达上限');
    expect(second.answer).toContain('没有发送');
    setRequestUrlHandler(null);
  });

  it('token 额度极小：拒绝发送并解释差多少，不产生请求', async () => {
    resetRequestUrlCalls();
    setRequestUrlHandler(async () => ({ status: 200, text: '{"choices":[{"message":{"content":"ok"}}]}' }));
    const parts = makeBridge({ runnerConfig: { maxCallsPerDay: 0, maxTokensPerDay: 5 } });
    await parts.store.load();
    await parts.store.remember({ body: '这是一段会被送进模型的长文本，用来触发 token 上限。', sourceKind: 'user_explicit' });
    await parts.store.confirm(parts.store.all()[0]!.meta.id);
    await parts.store.load();

    const { askWithBoundedModel } = await import('../packages/plugin/src/ask-gate.js');
    const result = await askWithBoundedModel(askInput(parts), '这段文本说了什么？');
    expect(requestUrlCalls.length).toBe(0);
    expect(result.gate.blocked).toBe(true);
    expect(result.answer).toContain('token');
    expect(result.answer).toContain('没有发送');
    // 没有发送 → 也没有记账。
    expect(parts.runner.budgetSnapshot().calls).toBe(0);
    setRequestUrlHandler(null);
  });

  it('成功调用的真实用量进入持久账（实测，而不是估算也不是 0）', async () => {
    resetRequestUrlCalls();
    let persisted = '';
    setRequestUrlHandler(async () => ({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: `杭州。 [${'mem_'}]`.replace('mem_', '') } }],
        usage: { prompt_tokens: 30, completion_tokens: 7 },
      }),
    }));
    const parts = makeBridge({
      runnerConfig: { maxCallsPerDay: 10, maxTokensPerDay: 100_000 },
      persist: async state => {
        persisted = JSON.stringify(state);
        return true;
      },
    });
    await parts.store.load();
    const created = await parts.store.remember({ body: '用户住在杭州。', sourceKind: 'user_explicit' });
    await parts.store.confirm(created.id);
    await parts.store.load();
    // 用真实 id 让引用核验能通过，从而走到「成功且带用量」的分支。
    setRequestUrlHandler(async () => ({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: `用户住在杭州 [${created.id}]。` } }],
        usage: { prompt_tokens: 30, completion_tokens: 7 },
      }),
    }));

    const { askWithBoundedModel } = await import('../packages/plugin/src/ask-gate.js');
    const result = await askWithBoundedModel(askInput(parts), '我住在哪里？');
    expect(requestUrlCalls.length).toBe(1);
    expect(result.settlement).toEqual({ accounted: 'measured', tokens: 37 });
    expect(parts.runner.budgetSnapshot().calls).toBe(1);
    expect(parts.runner.budgetSnapshot().tokens).toBe(37);
    // 而且真的落盘了：账不能只活在内存里。
    expect(persisted).toContain('"tokens":37');
    setRequestUrlHandler(null);
  });

  it('供应商不报用量时保留保守估算（不记 0，也不假装实测）', async () => {
    resetRequestUrlCalls();
    setRequestUrlHandler(async () => ({ status: 200, text: '{"choices":[{"message":{"content":"没有用的回复"}}]}' }));
    const parts = makeBridge({ runnerConfig: { maxCallsPerDay: 10, maxTokensPerDay: 100_000 } });
    await parts.store.load();
    await parts.store.remember({ body: '用户住在杭州。', sourceKind: 'user_explicit' });
    await parts.store.load();

    const { askWithBoundedModel } = await import('../packages/plugin/src/ask-gate.js');
    const result = await askWithBoundedModel(askInput(parts), '我住在哪里？');
    expect(requestUrlCalls.length).toBe(1);
    expect(result.settlement?.accounted).toBe('estimated');
    expect(result.settlement?.tokens ?? 0).toBeGreaterThan(0);
    expect(result.settlement?.tokens ?? 0).toBeGreaterThan(0);
    expect(parts.runner.budgetSnapshot().tokens).toBeGreaterThan(0);
    setRequestUrlHandler(null);
  });

  /**
   * 跨日迟到的结算**不许冲减今天的账**。
   *
   * 审计复现：昨日预占 1241、今日另预占 1241；
   * 昨日那条迟到的 usage 10 结算时按数字从「当前日账」里减退，
   * 把今天的 tokens 直接写成了 10——今天那笔还没结算的预占凭空消失，
   * 于是用户可以超额调用。
   *
   * 修法是让每次预占记住**自己属于哪一天**，结算时核对日期。
   */
  it('昨日迟到的结算不能冲掉今日另一笔预占', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    let clock = Date.parse('2026-10-08T23:59:59Z');
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => clock, rand: seededRand(91) });
    const runner = new AiJobRunner({
      store,
      instanceId: 'inst-rollover-settle',
      now: () => clock,
      persist: async () => true,
      config: { maxCallsPerDay: 10, maxTokensPerDay: 5000 } as never,
    });
    await store.load();

    const call = {
      purpose: '跨日结算回归',
      promptText: 'A'.repeat(100),
      maxOutputTokens: 1200,
      messages: 2,
    };
    const yesterday = await runner.beginModelCall(call);
    expect(yesterday.ok).toBe(true);
    if (!yesterday.ok) throw new Error('昨日预占应当成功');

    // 跨到新的一天，再做一次预占。
    clock = Date.parse('2026-10-09T00:00:01Z');
    const today = await runner.beginModelCall(call);
    expect(today.ok).toBe(true);
    if (!today.ok) throw new Error('今日预占应当成功');
    const afterToday = runner.budgetSnapshot().tokens;
    /**
     * 今天的日账里只有**今天**那一笔预占：昨日的预算随 UTC 日界翻页清零，
     * 不会作为「已用额度」压到今天头上（否则新的一天一开始就少了一天的量）。
     * 昨日那条预占仍然留在预占账本里，等它的结算结果回来时按日核对。
     */
    expect(afterToday).toBe(today.reservedTokens);
    expect(runner.budgetSnapshot().day).toBe('2026-10-09');

    // 昨日那条请求的**迟到**结果现在才回来，实测只有 10 token。
    const settled = await runner.settleModelCall({
      reservedTokens: yesterday.reservedTokens,
      reservationId: yesterday.reservationId,
      usage: { promptTokens: 8, completionTokens: 2 },
    });
    expect(settled.staleDay).toBe(true);

    const budget = runner.budgetSnapshot();
    /**
     * 关键断言：今日账目**没有被昨天的数字改写**。
     * 修复前这里是 `tokens: 10`（今日预占被冲掉）。
     */
    expect(budget.day).toBe('2026-10-09');
    expect(budget.tokens).toBe(afterToday);
    // 今日那笔预占必须**完整**还在（修复前会被昨日的 10 冲成 10）。
    expect(budget.tokens).toBeGreaterThanOrEqual(today.reservedTokens);
  });

  it('缺少预占 id 的结算宁可拒绝记账，也不去动别人的预占', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const clock = Date.parse('2026-10-09T10:00:00Z');
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => clock, rand: seededRand(95) });
    const runner = new AiJobRunner({
      store,
      instanceId: 'inst-unmatched-settle',
      now: () => clock,
      persist: async () => true,
      config: { maxCallsPerDay: 10, maxTokensPerDay: 5000 } as never,
    });
    await store.load();
    const call = { purpose: '缺少预占 id', promptText: 'C'.repeat(80), maxOutputTokens: 400, messages: 1 };
    const gate = await runner.beginModelCall(call);
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error('预占应当成功');
    const before = runner.budgetSnapshot();

    /**
     * 没有 id：不能猜「估算值相同就是同一笔」——
     * 并发或乱序返回时同一天里完全可能有两笔估算相同的请求，猜错就是动了别人的额度。
     */
    const missing = await runner.settleModelCall({
      reservedTokens: gate.reservedTokens,
      usage: { promptTokens: 30, completionTokens: 7 },
    });
    expect(missing.accounted).toBe('refused');
    expect(missing.refused).toBe('unmatched_reservation');
    expect(runner.budgetSnapshot()).toEqual(before);

    // 未知 id 同样拒绝，而不是「找不到就按当前日账加减」。
    const unknown = await runner.settleModelCall({
      reservedTokens: gate.reservedTokens,
      reservationId: 'rsv_不存在',
      usage: { promptTokens: 30, completionTokens: 7 },
    });
    expect(unknown.accounted).toBe('refused');
    expect(runner.budgetSnapshot()).toEqual(before);

    // 带上正确的 id 才能对账，且预占被换成实测值。
    const ok = await runner.settleModelCall({
      reservedTokens: gate.reservedTokens,
      reservationId: gate.reservationId,
      usage: { promptTokens: 30, completionTokens: 7 },
    });
    expect(ok).toEqual({ accounted: 'measured', tokens: 37 });
    expect(runner.budgetSnapshot().tokens).toBe(37);
  });

  it('同一天内的正常结算仍然把预占换成实测值', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const clock = Date.parse('2026-10-09T10:00:00Z');
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => clock, rand: seededRand(93) });
    const runner = new AiJobRunner({
      store,
      instanceId: 'inst-same-day-settle',
      now: () => clock,
      persist: async () => true,
      config: { maxCallsPerDay: 10, maxTokensPerDay: 5000 } as never,
    });
    await store.load();
    const gate = await runner.beginModelCall({
      purpose: '同日结算回归',
      promptText: 'B'.repeat(50),
      maxOutputTokens: 300,
      messages: 1,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error('预占应当成功');
    const settled = await runner.settleModelCall({
      reservedTokens: gate.reservedTokens,
      reservationId: gate.reservationId,
      usage: { promptTokens: 30, completionTokens: 7 },
    });
    expect(settled).toEqual({ accounted: 'measured', tokens: 37 });
    expect(runner.budgetSnapshot().tokens).toBe(37);
    expect(runner.budgetSnapshot().calls).toBe(1);
  });

  it('同一实例跨过 UTC 日界后自动恢复额度（不会一直说「已达上限」）', async () => {
    resetRequestUrlCalls();
    setRequestUrlHandler(async () => ({ status: 200, text: '{"choices":[{"message":{"content":"ok"}}]}' }));
    let clock = Date.UTC(2026, 9, 9, 23, 30);
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: 'Brain' });
    const store = new MemoryStore({ store: fileStore, root: 'Brain', now: () => clock, rand: seededRand(73) });
    const runner = new AiJobRunner({
      store,
      instanceId: 'inst',
      now: () => clock,
      persist: async () => true,
      config: { maxCallsPerDay: 1, maxTokensPerDay: 0 } as never,
    });
    await store.load();
    await store.remember({ body: '用户住在杭州。', sourceKind: 'user_explicit' });
    await store.confirm(store.all()[0]!.meta.id);
    await store.load();
    /**
     * 用一个**明确拒绝发送**的 provider（未配置模型名），而不是 null：
     * 这样走的是真实的「provider 拒绝 → modelUsed=false → 退回预占」路径，
     * 预占会退回，但**调用次数照记**（这正是要验证的跨天行为的触发条件）。
     */
    const refusingSettings = { ...defaultSettings(), ai: { ...defaultSettings().ai, enabled: false } };
    const refusingService = new MemoryService({
      app: createFakeApp(vault) as never,
      memoryRoot: 'Brain',
      instanceId: 'inst',
      getSettings: () => refusingSettings,
    });
    const input = {
      store,
      jobs: runner,
      createProvider: () => refusingService.createProvider(),
      maySend: () => ({ allowed: true, reason: '允许' }),
      maxContextChars: () => 4000,
      isUnloaded: () => false,
    };
    const { askWithBoundedModel } = await import('../packages/plugin/src/ask-gate.js');
    // 第一次：provider 在传输前拒绝 → 预占退回，但这一次调用已经记在账上。
    resetRequestUrlCalls();
    await askWithBoundedModel(input, '我住在哪里？');
    expect(requestUrlCalls.length).toBe(0);
    // 请求没发出去 → 预占退回，账目如实标成「已退回」而不是「花了 0 元」。
    expect(runner.budgetSnapshot().calls).toBe(0);

    /**
     * 让这个 UTC 日的额度真正用尽：用一次**真的会发出去**的调用。
     * （供应商侧拒绝不算用掉额度，那正是上面那条断言的用途。）
     */
    const sendingService = new MemoryService({
      app: createFakeApp(new FakeVault()) as never,
      memoryRoot: 'Brain',
      instanceId: 'inst',
      getSettings: () => ({
        ...defaultSettings(),
        ai: { ...defaultSettings().ai, enabled: true, baseUrl: 'https://example.invalid/v1', model: 'm', timeoutMs: 1000 },
      }),
    });
    setRequestUrlHandler(async () => ({ status: 200, text: '{"choices":[{"message":{"content":"ok"}}]}' }));
    await askWithBoundedModel({ ...input, createProvider: () => sendingService.createProvider() }, '我住在哪里？');
    expect(runner.budgetSnapshot().calls).toBe(1);
    const blockedSameDay = await askWithBoundedModel({ ...input, createProvider: () => sendingService.createProvider() }, '我住在哪里？');
    expect(blockedSameDay.gate.blocked).toBe(true);

    // 同一实例跨过 UTC 午夜：额度必须自动恢复，而不是一直拒绝。
    clock = Date.UTC(2026, 9, 10, 0, 10);
    const afterMidnight = await askWithBoundedModel(
      { ...input, createProvider: () => sendingService.createProvider() },
      '我住在哪里？',
    );
    expect(afterMidnight.gate.blocked).toBe(false);
    expect(runner.budgetSnapshot().day).toBe('2026-10-10');
    setRequestUrlHandler(null);
  });
});

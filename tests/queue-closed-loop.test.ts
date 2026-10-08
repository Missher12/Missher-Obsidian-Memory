/**
 * 队列闭环集成测试（独立审计 A1–A8 的复现与回归）。
 *
 * 这份测试用**真实的**核心与插件适配器代码、一个合成 Vault 桩来跑完整闭环：
 *
 *   CLI/MCP 入队 → 插件（权威提交者）认领 → Vault.process 比较-写入
 *   → 回执落地 → 删请求 → 重启后重放不重复 → 检索/纠错/遗忘
 *
 * 覆盖的缺陷（对应独立审计）：
 *
 * 1. 路径契约：所有 FileStore 路径都是「含记忆根」的 Vault 相对路径，
 *    不得出现双根；越界与 `..` 在适配器边界就被拒绝；
 * 2. 读盘故障不得被当成「文件不存在」（删除账本读不出来 → 阻断）；
 * 3. 请求校验：非法 id / target / revision / 载荷形状不得到达提交边界；
 * 4. 幂等身份：同名不同内容必须冲突，不得复用旧回执；
 * 5. 落地证据：completed 回执必须带真实 revision 与哈希；
 * 6. 崩溃恢复：提交成功但回执写失败时，重放**补写回执**而不是再写一条记忆；
 * 7. 外部修正/纠错不再一律 failed（受 expectedHash 保护的显式更正）；
 * 8. 隐藏 `.memory` 目录不进索引时，队列仍能看见外部写入的文件。
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  contentHashOf,
  parseReceipt,
  parseRequestEnvelope,
  processRequest,
  serializeReceipt,
  validateReceipt,
  requestFingerprint,
  type QueueRequest,
} from '@mom/core';
import { VaultFileStore } from '../packages/plugin/src/vault-store.js';
import { QueueService } from '../packages/plugin/src/queue-service.js';
import { createCommitHandler, createCommitRecovery } from '../packages/plugin/src/commit-handler.js';
import { createFakeApp, FakeVault } from './obsidian-stub.js';

const ROOT = 'Brain';

interface Harness {
  vault: FakeVault;
  store: MemoryStore;
  queue: QueueService;
  fileStore: VaultFileStore;
  /** 模拟「插件进程重启」：保留真实文件，重建内存对象。 */
  restart: () => Harness;
}

function createHarness(vault: FakeVault, options: { receiptWriteFails?: () => boolean } = {}): Harness {
  const app = createFakeApp(vault);
  const fileStore = new VaultFileStore({ app: app as never, memoryRoot: ROOT });
  const store = new MemoryStore({
    store: fileStore,
    root: ROOT,
    now: () => Date.now(),
    rand: () => 0.42,
  });
  const queue = new QueueService({
    app: app as never,
    store: fileStore,
    memoryRoot: ROOT,
    owner: 'plugin_test',
    now: () => Date.now(),
    random: () => 0.5,
    commit: createCommitHandler(store),
    findCommitted: createCommitRecovery(store),
  });
  const harness: Harness = {
    vault,
    store,
    queue,
    fileStore,
    restart: () => createHarness(vault, options),
  };
  void options;
  return harness;
}

function requestOf(overrides: Partial<QueueRequest> = {}): Omit<QueueRequest, 'protocol' | 'id' | 'createdAt' | 'expiresAt'> {
  return {
    operation: 'remember',
    payload: { body: '项目 Borealis 的构建脚本改用 pnpm 11。', kind: 'fact', scope: 'personal' },
    target: '',
    expectedHash: null,
    expectedRevision: null,
    requester: 'cli:test',
    idempotencyKey: 'idem-1',
    ...overrides,
  } as Omit<QueueRequest, 'protocol' | 'id' | 'createdAt' | 'expiresAt'>;
}

describe('A1 路径契约：只有一种含记忆根的写法', () => {
  it('状态文件、记忆文件、队列目录都只出现一次记忆根', async () => {
    const vault = new FakeVault({ files: { 'Brain/note.md': '---\nid: mem_note1\n---\n\n正文\n' } });
    const harness = createHarness(vault);
    await harness.store.load();
    await harness.store.writeStateFile('probe.json', '{}');
    const accepted = await harness.queue.enqueue(requestOf());
    expect(accepted.accepted).toBe(true);

    const paths = [...vault.rawFiles.keys()];
    expect(paths).toContain('Brain/note.md');
    expect(paths).toContain('Brain/.memory/probe.json');
    expect(paths).toContain(`Brain/.memory/requests/${accepted.requestId}.md`);
    for (const path of paths) {
      expect(path.startsWith('Brain/Brain')).toBe(false);
      expect(path.split('/').filter(segment => segment === 'Brain').length).toBeLessThanOrEqual(1);
    }
  });

  it('listFiles(root) 能看到记忆根内的文件（不漏）', async () => {
    const vault = new FakeVault({ files: { 'Brain/a.md': 'x', 'Other/b.md': 'y' } });
    const harness = createHarness(vault);
    const entries = await harness.fileStore.listFiles(ROOT, ['.md']);
    expect(entries.map(entry => entry.path)).toEqual(['Brain/a.md']);
  });

  it('队列 enqueue 之后父目录存在，认领与提交都不报 parent missing', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const accepted = await harness.queue.enqueue(requestOf());
    const scan = await harness.queue.processOnce();
    expect(accepted.accepted).toBe(true);
    expect(scan.malformed).toEqual([]);
    expect(scan.processed.length).toBe(1);
    expect(scan.processed[0]!.status).toBe('completed');
  });

  it('绝对路径、..、保留目录在适配器边界被拒绝，而不是被归一抹平', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    await expect(harness.fileStore.readFile('/etc/passwd')).rejects.toThrow(/绝对路径/);
    await expect(harness.fileStore.readFile('Brain/../private.md')).rejects.toThrow(/\.\./);
    await expect(harness.fileStore.readFile('Other/x.md')).rejects.toThrow(/不在记忆根/);
    await expect(harness.fileStore.writeFile('Brain/.obsidian/x.md', 'x')).rejects.toThrow(/保留目录/);
    // 关键：越界尝试不能产生任何写入。
    expect([...vault.rawFiles.keys()]).toEqual([]);
  });

  it('队列路径 helper 只在边界接一次根', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const accepted = await harness.queue.enqueue(requestOf());
    expect(accepted.path.startsWith('Brain/.memory/requests/')).toBe(true);
    expect(accepted.path.includes('Brain/Brain')).toBe(false);
  });
});

describe('A2 读盘故障不是「文件不存在」', () => {
  it('删除账本读取抛 EIO 时，载入被阻断而不是当成空账本', async () => {
    const vault = new FakeVault({
      files: { 'Brain/.memory/tombstones.json': '{"version":1,"items":[]}' },
      readErrors: ['Brain/.memory/tombstones.json'],
    });
    const harness = createHarness(vault);
    await expect(harness.store.load()).rejects.toThrow(/读盘|读取/);
    expect(harness.store.isOperational).toBe(false);
    // 再次尝试载入仍然失败：故障不会因为「试过一次」就变成空库。
    await expect(harness.store.load({ force: true })).rejects.toThrow(/读盘|读取/);
  });

  it('确实不存在时仍然返回 null（契约允许）', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    expect(await harness.fileStore.readFile('Brain/.memory/nothing.json')).toBeNull();
    const report = await harness.store.load();
    expect(report.problems).toEqual([]);
  });

  it('坏 JSON 与读盘故障都被看见（前者阻断召回，后者阻断载入）', async () => {
    const broken = new FakeVault({ files: { 'Brain/.memory/tombstones.json': '{invalid' } });
    const brokenHarness = createHarness(broken);
    const report = await brokenHarness.store.load();
    expect(report.problems.length).toBeGreaterThan(0);
    expect(brokenHarness.store.isOperational).toBe(false);
    // 坏账本本身不得被覆盖：它仍是人工修复的依据。
    expect(broken.rawFiles.get('Brain/.memory/tombstones.json')!.content).toBe('{invalid');
  });
});

describe('A3 请求校验：非法信封到不了提交边界', () => {
  it('非法 id / target / revision / 载荷都在入队时被拒', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const bad = await harness.queue.enqueue({
      ...requestOf({ target: '../private.md', expectedRevision: -3 }),
      id: '../escape',
      payload: { body: 123, scope: 'all', allowModel: 'false' },
    } as never);
    expect(bad.accepted).toBe(false);
    expect(bad.error).toMatch(/不合法|id/);
    expect([...vault.rawFiles.keys()]).toEqual([]);
  });

  it('parseRequestEnvelope 对越界 target 报错，不产出可执行请求', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const accepted = await harness.queue.enqueue(requestOf());
    const path = `Brain/.memory/requests/${accepted.requestId}.md`;
    const raw = vault.rawFiles.get(path)!.content.replace('target: ""', 'target: "../private.md"');
    const parsed = parseRequestEnvelope(raw, { root: ROOT });
    expect(parsed.request).toBeNull();
    expect(parsed.errors.join(' ')).toMatch(/target/);
  });

  it('修改类操作缺少 expectedHash 一律拒绝', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const bad = await harness.queue.enqueue(
      requestOf({ operation: 'update', target: 'Brain/mem_abcd1234.md', expectedHash: null }),
    );
    expect(bad.accepted).toBe(false);
    expect(bad.error).toMatch(/expectedHash/);
  });

  it('未知 scope 在入队时就被拒（不能先接单再隔离）', async () => {
    /**
     * 独立队列审计 Q01 反例：`payload.scope = 'all'`。
     *
     * 记录层对未知 scope 是 fail-closed 的（隔离检索 + `unknown_scope`），
     * 但那条路要等到插件处理队列时才走。若入队不校验，调用方会先拿到 accepted、
     * 库里随后多出一条「写进去了但永远检索不到」的记忆——对写入口来说太晚了。
     */
    const vault = new FakeVault();
    const harness = createHarness(vault);
    for (const scope of ['all', 'global', 'Personal', '']) {
      const bad = await harness.queue.enqueue(requestOf({ payload: { body: '合成内容', scope } }));
      expect(bad.accepted, `scope=${JSON.stringify(scope)} 不该被接受`).toBe(false);
      expect(bad.error).toMatch(/scope/);
    }
    // 三个合法取值必须照常通过——拒绝不能扩大到正常请求。
    for (const scope of ['personal', 'project', 'context']) {
      // 显式给 id：这个 harness 的 random 是固定值，默认 id 会在同一秒内相同。
      const ok = await harness.queue.enqueue({
        ...requestOf({
          idempotencyKey: `idem-scope-${scope}`,
          payload: { body: '合成内容', scope, ...(scope === 'personal' ? {} : { scopeRef: '合成项目' }) },
        }),
        id: `req_20260101_000000_scope${scope.padEnd(4, '0')}`,
      });
      expect(ok.accepted, `scope=${scope} 应当被接受`).toBe(true);
    }
    // 有且只有上面三条合法请求落了盘。
    expect([...vault.rawFiles.keys()].filter(key => key.includes('/requests/'))).toHaveLength(3);
  });

  it('提交者自报 completed 但没有落地证据时，回执改为 failed 而不是放行', async () => {
    /**
     * Q04 反例的另一半。两条容易混的路径要分开：
     *
     * 1. **恢复层先答**：如果同一个请求已经有权威落地效果，`findCommitted` 会返回
     *    真实存在的合法效果（A6 覆盖），假 commit 根本不会运行——那是更好的结果。
     * 2. **提交路径兜底**：这里把恢复层关掉（`findCommitted` 恒为 null），
     *    让一个自报 completed、却拿不出落地证据的提交者走到回执这一步。
     *
     * 拦截点在 `validateReceipt` 的 completed 分支（`evidence`、`contentHash`、
     * `revision`、`memoryId`、`path` 逐项要求），运行器随后把回执降级为 failed。
     * 测试用意是**把这条契约钉住**：将来谁放宽了 completed 的校验，这里会红。
     */
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const accepted = await harness.queue.enqueue(requestOf());
    const raw = vault.rawFiles.get(`${ROOT}/.memory/requests/${accepted.requestId}.md`)!.content;
    const parsed = parseRequestEnvelope(raw, { root: ROOT });
    expect(parsed.request).not.toBeNull();

    const liars = [
      ['证据整体缺失', { evidence: null, contentHash: null }],
      ['内容证据但没有哈希', { evidence: { kind: 'content', contentHash: null, revision: 1 }, contentHash: null }],
      ['未知证据类型', { evidence: { kind: 'made_up' }, contentHash: null }],
      ['没有 memoryId', { evidence: { kind: 'content', contentHash: 'a'.repeat(64), revision: 1 }, contentHash: 'a'.repeat(64), memoryId: '' }],
    ] as const;

    for (const [label, broken] of liars) {
      let commitCalls = 0;
      const outcome = await processRequest(parsed.request!, {
        now: () => Date.now(),
        root: ROOT,
        committedBy: 'synthetic-liar',
        findReceipt: () => ({ kind: 'none' }),
        findCommitted: async () => null,
        commit: async () => {
          commitCalls += 1;
          return {
            status: 'completed' as const,
            message: '合成：自报成功但没有证据',
            revision: 1,
            evidence: null,
            contentHash: null,
            memoryId: 'mem_0000000000000001',
            path: `${ROOT}/synthetic.md`,
            actualHash: null,
            ...broken,
          };
        },
        writeReceipt: () => true,
      });
      // 故障注入必须真的到达提交边界，否则这条测试什么都没测。
      expect(commitCalls, `${label}：假提交没有被调用`).toBe(1);
      expect(outcome.receipt.status, `${label}：假成功被放行`).toBe('failed');
      expect(outcome.receipt.message).toMatch(/缺少落地证据/);
      expect(outcome.receiptDurable).toBe(true);
    }
  });

  it('文件名与信封 id 不一致时按结构错误处理，且不产生回执', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const accepted = await harness.queue.enqueue(requestOf());
    const raw = vault.rawFiles.get(`Brain/.memory/requests/${accepted.requestId}.md`)!.content;
    // 复制成另一个文件名（信封里的 id 不变）：身份不一致，必须拒绝。
    vault.putRaw('Brain/.memory/requests/req_20260101_000000_deadbeef.md', raw);
    const scan = await harness.queue.processOnce();
    expect(scan.malformed.length).toBe(1);
    expect(scan.malformed[0]!.errors.join(' ')).toMatch(/文件名与信封 id 不一致/);
    // 真的那条正常处理，伪造的那条被拒绝——两者不是同一件事。
    expect(scan.processed.map(item => item.requestId)).toEqual([accepted.requestId]);
  });
});

describe('A4 幂等身份：同名不同内容必须冲突', () => {
  it('相同 requestId、不同 payload 不会复用旧回执', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const base = requestOf();
    const first = await harness.queue.enqueue({ ...base, id: 'req_20260101_000000_aaaaaaaa' });
    expect(first.accepted).toBe(true);
    const scan1 = await harness.queue.processOnce();
    expect(scan1.processed[0]!.status).toBe('completed');

    // 同一 id 再次入队：内容一致才算重复入队；内容不同必须拒绝。
    const same = await harness.queue.enqueue({ ...base, id: 'req_20260101_000000_aaaaaaaa' });
    expect(same.accepted).toBe(true);
    const different = await harness.queue.enqueue({
      ...base,
      id: 'req_20260101_000000_aaaaaaaa',
      payload: { body: '完全不同的正文', kind: 'fact', scope: 'personal' },
    });
    expect(different.accepted).toBe(false);
    expect(different.error).toMatch(/不同内容/);

    // 绕过入队门禁（直接改磁盘上的载荷）后，处理器按指纹冲突处理，绝不复用旧回执。
    const path = `Brain/.memory/requests/req_20260101_000000_aaaaaaaa.md`;
    const tampered = vault.rawFiles
      .get(path)!
      .content.replace('项目 Borealis 的构建脚本改用 pnpm 11。', '完全不同的正文');
    vault.putRaw(path, tampered);
    const scan2 = await harness.queue.processOnce();
    /**
     * 旧回执指纹不同，因此不能被覆盖，也不能被当作本次的成功回执。
     * 冲突现场写成**争议证据**另存，请求保留，等人工处理。
     */
    expect(scan2.processed).toEqual([]);
    expect(scan2.retained.map(item => item.requestId)).toContain('req_20260101_000000_aaaaaaaa');
    const dispute = [...vault.rawFiles.keys()].filter(path => path.includes('.conflict.'));
    expect(dispute.length).toBe(1);
    const body = vault.rawFiles.get(dispute[0]!)!.content;
    expect(body).toMatch(/指纹不同/);
    expect(body).toMatch(/本次指纹/);
  });

  it('同幂等键不同内容同样被拒绝（指纹参与判定）', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    await harness.queue.enqueue({ ...requestOf(), id: 'req_20260101_000000_bbbbbbbb' });
    await harness.queue.processOnce();
    const again = await harness.queue.enqueue({
      ...requestOf({ payload: { body: '另一个正文', kind: 'fact', scope: 'personal' } }),
      id: 'req_20260101_000000_cccccccc',
    });
    // 不同 id 但同幂等键 + 不同指纹：入队成功后，处理时必须报冲突而不是复用旧回执。
    expect(again.accepted).toBe(true);
    const scan = await harness.queue.processOnce();
    const receipt = scan.processed.find(item => item.requestId === 'req_20260101_000000_cccccccc');
    expect(receipt?.status).toBe('conflict');
    expect(receipt?.message).toMatch(/指纹|不同内容/);
  });
});

describe('A5 落地证据：completed 必须带 revision 与哈希', () => {
  it('remember 的成功回执带内容哈希与 revision，并可通过校验', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const accepted = await harness.queue.enqueue(requestOf());
    const scan = await harness.queue.processOnce();
    const receipt = scan.processed[0]!;
    expect(receipt.status).toBe('completed');
    expect(receipt.revision).toBe(1);
    expect(receipt.evidence?.kind).toBe('content');
    if (receipt.evidence?.kind !== 'content') throw new Error('expected content evidence');
    expect(receipt.contentHash).toBe(receipt.evidence.contentHash);
    const reread = parseReceipt(
      vault.rawFiles.get(`Brain/.memory/receipts/${accepted.requestId}.md`)!.content,
      { root: ROOT },
    );
    expect(reread.errors).toEqual([]);
    expect(reread.receipt?.contentHash).toBe(receipt.contentHash);
  });

  it('永久删除的成功回执带删除标记（而不是伪造内容哈希）', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const remembered = await harness.store.remember({ body: '临时事实', sourceKind: 'user_explicit' });
    const hash = harness.store.hashOf(remembered.id)!;
    const accepted = await harness.queue.enqueue(
      requestOf({
        operation: 'delete',
        target: remembered.path,
        payload: { reason: '用户要求删除' },
        expectedHash: hash,
        idempotencyKey: 'idem-delete',
      }) as never,
    );
    expect(accepted.accepted).toBe(true);
    const scan = await harness.queue.processOnce();
    const receipt = scan.processed[0]!;
    expect(receipt.status).toBe('completed');
    expect(receipt.evidence?.kind).toBe('deletion');
    if (receipt.evidence?.kind !== 'deletion') throw new Error('expected deletion evidence');
    expect(receipt.evidence.tombstoneId).toMatch(/^mem_/);
    expect(receipt.evidence.previousHash).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.rawFiles.has(remembered.path)).toBe(false);
  });
});

describe('A6 崩溃恢复：提交成功、回执丢失时不重复提交', () => {
  it('重放同一条请求只补写回执，不产生第二条记忆', async () => {
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    const fileStore = new VaultFileStore({ app: app as never, memoryRoot: ROOT });
    const store = new MemoryStore({ store: fileStore, root: ROOT, now: () => Date.now(), rand: () => 0.42 });
    let failReceipt = true;
    const queue = new QueueService({
      app: app as never,
      store: fileStore,
      memoryRoot: ROOT,
      owner: 'plugin_test',
      now: () => Date.now(),
      random: () => 0.5,
      commit: createCommitHandler(store),
      findCommitted: createCommitRecovery(store),
    });
    // 让第一轮回执写入失败：模拟「提交成功、回执落盘失败」。
    const originalCreate = vault.create.bind(vault);
    vault.create = (async (path: string, content: string) => {
      if (failReceipt && path.includes('/.memory/receipts/')) {
        throw new Error('synthetic: receipt write failed');
      }
      return originalCreate(path, content);
    }) as typeof vault.create;

    const accepted = await queue.enqueue(requestOf({ idempotencyKey: 'idem-crash' }));
    expect(accepted.accepted).toBe(true);
    const first = await queue.processOnce();
    expect(first.retained.length).toBe(1);
    expect(first.processed.length).toBe(0);

    // 重启：同一批文件、新的内存对象。
    failReceipt = false;
    const store2 = new MemoryStore({ store: fileStore, root: ROOT, now: () => Date.now(), rand: () => 0.42 });
    const queue2 = new QueueService({
      app: app as never,
      store: fileStore,
      memoryRoot: ROOT,
      owner: 'plugin_test',
      now: () => Date.now(),
      random: () => 0.5,
      commit: createCommitHandler(store2),
      findCommitted: createCommitRecovery(store2),
    });
    const second = await queue2.processOnce();
    expect(second.processed.length + second.skipped.length).toBe(1);
    const receipt = [...second.processed, ...second.skipped][0]!;
    expect(receipt.status).toBe('completed');

    // 关键断言：只存在一条记忆。
    await store2.load(true);
    const records = store2.all();
    expect(records.length).toBe(1);
    expect(records[0]!.meta.event_ids).toContain(`queue:${accepted.requestId}`);
  });
});

describe('A7 外部修正与纠错：受保护的显式更正可以生效', () => {
  it('带 expectedHash 的 update 能生效，回执带新哈希', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const remembered = await harness.store.remember({
      body: '构建脚本使用 npm。',
      sourceKind: 'user_explicit',
    });
    const hash = harness.store.hashOf(remembered.id)!;
    const accepted = await harness.queue.enqueue(
      requestOf({
        operation: 'update',
        target: remembered.path,
        payload: { body: '构建脚本使用 pnpm 11。', reason: '更正工具链' },
        expectedHash: hash,
        idempotencyKey: 'idem-update',
      }) as never,
    );
    expect(accepted.accepted).toBe(true);
    const scan = await harness.queue.processOnce();
    const receipt = scan.processed[0]!;
    expect(receipt.status).toBe('completed');
    expect(receipt.contentHash).not.toBe(hash);
    const raw = vault.rawFiles.get(remembered.path)!.content;
    expect(raw).toContain('pnpm 11');
    expect(contentHashOf(raw)).toBe(receipt.contentHash);
  });

  it('expectedHash 过期（有人工编辑）时报告冲突且不覆盖', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const remembered = await harness.store.remember({ body: '原始内容', sourceKind: 'user_explicit' });
    const staleHash = harness.store.hashOf(remembered.id)!;
    // 人工编辑：直接改磁盘字节。
    vault.putRaw(remembered.path, vault.rawFiles.get(remembered.path)!.content.replace('原始内容', '人工改写的内容'));
    const accepted = await harness.queue.enqueue(
      requestOf({
        operation: 'update',
        target: remembered.path,
        payload: { body: '外部想写的内容', reason: '外部修正' },
        expectedHash: staleHash,
        idempotencyKey: 'idem-conflict',
      }) as never,
    );
    expect(accepted.accepted).toBe(true);
    const scan = await harness.queue.processOnce();
    const receipt = scan.processed[0]!;
    expect(receipt.status).toBe('conflict');
    expect(vault.rawFiles.get(remembered.path)!.content).toContain('人工改写的内容');
  });

  it('correct 走受保护的显式更正并可立即生效', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const remembered = await harness.store.remember({ body: '旧结论：需要 npm。', sourceKind: 'user_explicit' });
    const hash = harness.store.hashOf(remembered.id)!;
    const accepted = await harness.queue.enqueue(
      requestOf({
        operation: 'correct',
        target: remembered.path,
        payload: { replacement: '新结论：需要 pnpm 11。', reason: '用户明确纠错' },
        expectedHash: hash,
        idempotencyKey: 'idem-correct',
      }) as never,
    );
    expect(accepted.accepted).toBe(true);
    const scan = await harness.queue.processOnce();
    const receipt = scan.processed[0]!;
    expect(receipt.status).toBe('completed');
    expect(vault.rawFiles.get(remembered.path)!.content).toContain('pnpm 11');
  });
});

describe('A8 隐藏目录：不依赖 Obsidian 索引也能看见外部请求', () => {
  it('外部 CLI 直接落盘的请求能被适配器发现并处理', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    // 模拟外部 CLI：不经 Vault API，直接写底层文件系统。
    const raw = [
      '---',
      'protocol: 1',
      'id: "req_20260101_000000_deadbeef"',
      'operation: "remember"',
      'target: ""',
      'expected_hash: null',
      'expected_revision: null',
      'requester: "cli:external"',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'expires_at: "2099-01-01T00:00:00.000Z"',
      'idempotency_key: "idem-external"',
      '---',
      '',
      '## 载荷',
      '',
      '```json',
      JSON.stringify({ body: '外部排队的记忆。', kind: 'fact', scope: 'personal' }, null, 2),
      '```',
      '',
    ].join('\n');
    vault.putRaw('Brain/.memory/requests/req_20260101_000000_deadbeef.md', raw);

    const scan = await harness.queue.processOnce();
    expect(scan.malformed).toEqual([]);
    expect(scan.processed.length).toBe(1);
    expect(scan.processed[0]!.status).toBe('completed');
    // 隐藏文件确实不在索引里，说明这条路径真的走了适配器。
    expect(vault.getAbstractFileByPath('Brain/.memory/requests/req_20260101_000000_deadbeef.md')).toBeNull();
    expect(harness.fileStore.offIndex.length).toBeGreaterThan(0);
  });

  it('认领后的请求恢复处理，且不会重复提交', async () => {
    const vault = new FakeVault();
    const harness = createHarness(vault);
    const accepted = await harness.queue.enqueue(requestOf({ idempotencyKey: 'idem-claimed' }));
    // 手工制成「上次崩溃留下的认领态」。
    const original = `Brain/.memory/requests/${accepted.requestId}.md`;
    const claimed = `${original}.claimed.plugin_test.md`;
    vault.renameRaw(original, claimed);

    const scan = await harness.queue.processOnce();
    expect(scan.processed.length).toBe(1);
    expect(scan.processed[0]!.status).toBe('completed');
    expect(vault.rawFiles.has(claimed)).toBe(false);

    // 再跑一轮：没有请求了，也没有第二条记忆。
    const again = await harness.queue.processOnce();
    expect(again.processed).toEqual([]);
    await harness.store.load(true);
    expect(harness.store.all().length).toBe(1);
  });
});

describe('A9 指纹稳定性', () => {
  it('同一逻辑请求换 id 后指纹不变；内容不同则指纹不同', () => {
    const base = {
      operation: 'remember' as const,
      target: '',
      payload: { body: '同一段正文', scope: 'personal' },
      expectedHash: null,
      expectedRevision: null,
    };
    const same = requestFingerprint({ ...base, payload: { scope: 'personal', body: '同一段正文' } });
    expect(requestFingerprint(base)).toBe(same);
    expect(requestFingerprint({ ...base, payload: { body: '别的正文', scope: 'personal' } })).not.toBe(
      requestFingerprint(base),
    );
    expect(requestFingerprint({ ...base, expectedHash: 'a'.repeat(64) })).not.toBe(requestFingerprint(base));
  });
});


/**
 * A6：回执的**写入 → 读回**往返。
 *
 * 审计复现（修复前）：`serializeReceipt` 对 conflict / failed / expired 写的是
 * `evidence: null`，而 `parseEvidence` 把 `null` 当成「类型不对」记进 errors，
 * 于是 `parseReceipt` 返回 `receipt: null`——回执确实写成功了，
 * 但任何读回它的入口（CLI `receipts`、界面、外部对账）都看不到它。
 * 用户看到的现象是「提交冲突了，可查不到那条冲突回执」。
 */
describe('A6 回执读回：null 证据是合法状态，不丢回执', () => {
  const receiptOf = (status: 'completed' | 'conflict' | 'failed' | 'expired', evidence: unknown) =>
    ({
      protocol: 1,
      requestId: 'req_20261009120000_abc12345',
      status,
      fingerprint: 'fp_roundtrip',
      committedBy: 'test_runner',
      committedAt: '2026-10-09T12:00:00.000Z',
      revision: status === 'completed' ? 2 : null,
      evidence,
      contentHash: status === 'completed' ? 'a'.repeat(64) : null,
      memoryId: 'mem_roundtrip',
      path: 'Brain/note.md',
      actualHash: status === 'completed' ? null : 'b'.repeat(64),
      message: '往返测试',
      idempotencyKey: 'idem-roundtrip',
      expiresAt: null,
    }) as never;

  it('completed 的内容证据可以往返', () => {
    const receipt = receiptOf('completed', { kind: 'content', contentHash: 'a'.repeat(64), revision: 2 });
    const parsed = parseReceipt(serializeReceipt(receipt), { root: ROOT });
    expect(parsed.errors).toEqual([]);
    expect(parsed.receipt?.status).toBe('completed');
    expect(parsed.receipt?.evidence).toEqual({ kind: 'content', contentHash: 'a'.repeat(64), revision: 2 });
  });

  it('completed 的删除证据可以往返', () => {
    const receipt = receiptOf('completed', {
      kind: 'deletion',
      previousHash: 'c'.repeat(64),
      tombstoneId: 'tomb_1',
      revision: null,
    });
    const parsed = parseReceipt(serializeReceipt(receipt), { root: ROOT });
    expect(parsed.errors).toEqual([]);
    expect(parsed.receipt?.evidence).toEqual({
      kind: 'deletion',
      previousHash: 'c'.repeat(64),
      tombstoneId: 'tomb_1',
      revision: null,
    });
  });

  it.each(['conflict', 'failed', 'expired'] as const)('%s 的 null 证据可以往返（回执不会消失）', status => {
    const receipt = receiptOf(status, null);
    const parsed = parseReceipt(serializeReceipt(receipt), { root: ROOT });
    // 关键断言：errors 为空、receipt 不为 null——这正是修复前丢掉的那一步。
    expect(parsed.errors).toEqual([]);
    expect(parsed.receipt).not.toBeNull();
    expect(parsed.receipt?.status).toBe(status);
    expect(parsed.receipt?.evidence ?? null).toBeNull();
  });

  it('completed 缺落地证据仍然被拒（校验没有被放宽）', () => {
    const receipt = receiptOf('completed', null);
    const checked = validateReceipt(receipt, { root: ROOT });
    expect(checked.ok).toBe(false);
    expect(checked.errors.join('；')).toContain('落地证据');
  });

  it('completed 的 revision 不合法也仍然被拒', () => {
    const receipt = receiptOf('completed', { kind: 'content', contentHash: 'd'.repeat(64), revision: 0 });
    const checked = validateReceipt(receipt, { root: ROOT });
    expect(checked.ok).toBe(false);
    expect(checked.errors.join('；')).toContain('revision');
  });
});

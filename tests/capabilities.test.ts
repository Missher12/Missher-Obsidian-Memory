/**
 * 兼容与能力降级回归（PLAN：compatibility-images-20261014 第 2 条）。
 *
 * 这一组用例只回答一个问题：**宿主少了一个接口时，插件到底会做什么？**
 * 答案必须是一句准确的话，而不是「看起来还能用」。
 *
 * - 必要接口（`Vault.process`）缺失 → 拒绝写入并报 `no_atomic_write`，
 *   且**绝不**退到非原子的 `vault.modify`；
 * - 可选接口缺失 → 只关闭对应功能，核心本地记录与检索继续可用。
 *
 * 这些是 API-stub 级别的定向回归，**不是**真实 Obsidian 运行验收：
 * 桩模拟的是接口有无，不证明真实宿主行为。真实运行验收见 docs/COMPATIBILITY.md。
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, PathError, contentHashOf, defaultSettings } from '@mom/core';
import { VaultFileStore } from '../packages/plugin/src/vault-store.js';
import {
  NO_ATOMIC_WRITE,
  UNSAFE_OFFINDEX_WRITE,
  describeCapabilities,
  probeCapabilities,
} from '../packages/plugin/src/capabilities.js';
import { MemoryService, SECRET_ID } from '../packages/plugin/src/memory-service.js';
import { FakeVault, createFakeApp } from './obsidian-stub.js';
import { fixedClock, memoryStore, seededRand, T0 } from './helpers.js';

const ROOT = 'Brain';
const NODE = `${ROOT}/Notes/n1.md`;

function vaultStoreFor(vault: FakeVault, root = ROOT) {
  const app = createFakeApp(vault);
  const fileStore = new VaultFileStore({ app: app as never, memoryRoot: root });
  const store = new MemoryStore({
    store: fileStore,
    root,
    now: fixedClock(T0).now,
    rand: seededRand(11),
  });
  return { fileStore, store, app };
}

function serviceFor(app: ReturnType<typeof createFakeApp>, root = ROOT): MemoryService {
  return new MemoryService({
    app: app as never,
    memoryRoot: root,
    instanceId: 'test_instance',
    getSettings: () => defaultSettings(),
  });
}

/* ================================================================== */
/* 能力探测                                                            */
/* ================================================================== */

describe('能力探测只依据真实接口，不猜版本号', () => {
  it('完整宿主：必要与可选接口都报告可用，且不输出无意义提示', () => {
    const report = probeCapabilities(createFakeApp(new FakeVault()) as never);
    expect(report.required.vaultProcess).toBe(true);
    expect(report.optional.adapterRename).toBe(true);
    expect(report.optional.secretStorageRead).toBe(true);
    expect(report.optional.secretStorageWrite).toBe(true);
    expect(report.optional.appReload).toBe(true);
    expect(report.canCommitSafely).toBe(true);
    expect(report.missingRequired).toEqual([]);
    expect(report.missingOptional).toEqual([]);
    expect(describeCapabilities(report)).toBeNull();
  });

  it('缺 Vault.process：列为必要缺失，并明确「不会提交正文」', () => {
    const report = probeCapabilities(createFakeApp(new FakeVault({ withoutProcess: true })) as never);
    expect(report.required.vaultProcess).toBe(false);
    expect(report.canCommitSafely).toBe(false);
    expect(report.missingRequired.join()).toContain('Vault.process');
    const text = describeCapabilities(report);
    expect(text).not.toBeNull();
    expect(text).toContain('不会提交正文');
  });

  it('缺可选接口：只列入可选缺失，核心仍可安全提交', () => {
    const app = createFakeApp(new FakeVault({ withoutAdapterRename: true }), {
      withoutSecretStorage: true,
      withoutCommands: true,
    });
    const report = probeCapabilities(app as never);
    expect(report.canCommitSafely).toBe(true);
    expect(report.missingRequired).toEqual([]);
    expect(report.missingOptional).toHaveLength(3);
    const text = describeCapabilities(report) ?? '';
    expect(text).toContain('只关闭对应功能');
    expect(text).not.toContain('不会提交正文');
  });
});

/* ================================================================== */
/* 必要接口缺失：拒绝写入，不退到非原子的 modify                        */
/* ================================================================== */

describe('必要接口缺失：拒绝写入，不退到非原子的 modify', () => {
  it('writeFile 抛 no_atomic_write，且 modify 未被调用、原字节不变', async () => {
    // 只去掉 process，**保留** modify：真实旧宿主就是两者都在、但没有 process。
    const vault = new FakeVault({ files: { [NODE]: '人工编辑过的原文' }, withoutProcess: true });
    const { fileStore } = vaultStoreFor(vault);
    const modify = vi.spyOn(vault, 'modify');

    await expect(fileStore.writeFile(NODE, '插件想写的新内容')).rejects.toThrowError(PathError);
    try {
      await fileStore.writeFile(NODE, '插件想写的新内容');
      throw new Error('缺少 process 时不应写入成功');
    } catch (error) {
      expect(error).toBeInstanceOf(PathError);
      expect((error as PathError).code).toBe(NO_ATOMIC_WRITE);
      expect((error as Error).message).toContain('不会退到 vault.modify');
      expect((error as Error).message).toContain('1.1.0+');
    }

    // 直接断言真实方法没被调用，而不是依赖桩内部的调用日志。
    expect(modify).not.toHaveBeenCalled();
    expect(vault.rawFiles.get(NODE)?.content).toBe('人工编辑过的原文');
  });

  it('新建路径同样被闸门挡住（闸门在任何写路径之前）', async () => {
    const vault = new FakeVault({ withoutProcess: true });
    const { fileStore } = vaultStoreFor(vault);
    await expect(fileStore.writeFile(`${ROOT}/Notes/brand-new.md`, 'x')).rejects.toThrowError(PathError);
    expect(vault.rawFiles.has(`${ROOT}/Notes/brand-new.md`)).toBe(false);
  });

  it('读取、存在性与枚举不受影响（缺写入接口 ≠ 整个插件不可用）', async () => {
    const vault = new FakeVault({ files: { [NODE]: '仍然读得到' }, withoutProcess: true });
    const { fileStore } = vaultStoreFor(vault);

    expect(await fileStore.readFile(NODE)).toBe('仍然读得到');
    expect(await fileStore.exists(NODE)).toBe(true);
    const listing = await fileStore.listFiles();
    expect(listing.map(entry => entry.path)).toContain(NODE);
  });

  it('核心本地记录与检索在缺少 process 时继续工作', async () => {
    /**
     * 用纯内存后端写下一条**真实格式**的记忆，再把文件原样灌进假 Vault。
     * 这样断言的就是真实记录格式与真实检索，而不是手写的 frontmatter。
     */
    const seedFs = memoryStore();
    const seedStore = new MemoryStore({
      store: seedFs,
      root: ROOT,
      now: fixedClock(T0).now,
      rand: seededRand(3),
    });
    await seedStore.load();
    await seedStore.remember({
      body: '这是一条关于本地检索的记忆正文。',
      kind: 'fact',
      sourceKind: 'user_explicit',
      sourceRef: 'ui',
    });
    const files = await seedFs.listFiles();
    expect(files.length).toBeGreaterThan(0);

    const seed: Record<string, string> = {};
    for (const entry of files) {
      const content = await seedFs.readFile(entry.path);
      if (content !== null) seed[entry.path] = content;
    }

    const vault = new FakeVault({ files: seed, withoutProcess: true });
    const { store } = vaultStoreFor(vault);

    const report = await store.load();
    expect(report.valid).toBeGreaterThan(0);
    const result = await store.search({ text: '本地检索' });
    expect(result.hits.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 可选接口缺失：只关闭对应功能                                        */
/* ================================================================== */

describe('可选接口缺失：只关闭对应功能', () => {
  it('没有 adapter.rename：认领报准确错误，本地写入不受影响', async () => {
    const vault = new FakeVault({ files: { [NODE]: '原文' }, withoutAdapterRename: true });
    const { fileStore } = vaultStoreFor(vault);
    await expect(fileStore.rename(NODE, `${ROOT}/Notes/n2.md`)).rejects.toThrowError(/adapter\.rename/);
    // 同一个实例的普通写入仍然可用。
    const result = await fileStore.writeFile(NODE, '新正文');
    expect(result.status).toBe('written');
    expect(vault.rawFiles.get(NODE)?.content).toBe('新正文');
  });

  it('没有 SecretStorage：密钥只用本次运行，不落盘，AI 仍可配置', () => {
    const app = createFakeApp(new FakeVault(), { withoutSecretStorage: true });
    const service = serviceFor(app);
    const settings = defaultSettings();
    expect(service.hasSecretStorage()).toBe(false);
    // 返回 false ＝「没有持久保存」，但密钥立即生效。
    expect(service.writeCredential('sk-test-value', settings)).toBe(false);
    expect(service.hasSessionKey()).toBe(true);
    expect(service.readCredential(settings)).toBe('sk-test-value');
    expect(service.keyConfigured()).toBe(true);
    expect(app.persistedSecrets.size).toBe(0);
  });

  it('有 SecretStorage 时走持久化，且不再依赖本次运行的临时密钥', () => {
    const app = createFakeApp(new FakeVault());
    const service = serviceFor(app);
    const settings = defaultSettings();
    expect(service.canPersistCredential()).toBe(true);
    expect(service.canReadPersistedCredential()).toBe(true);
    expect(service.writeCredential('sk-persisted', settings)).toBe(true);
    expect(service.hasSessionKey()).toBe(false);
    expect(service.readCredential(settings)).toBe('sk-persisted');
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-persisted');
  });
});

/* ================================================================== */
/* 密钥读写能力分开探测                                                */
/* ================================================================== */

describe('SecretStorage 的读与写分开探测', () => {
  it('只有 getter：能读旧持久值，写入仍只在本运行生效', () => {
    const app = createFakeApp(new FakeVault(), { secretStorageGetterOnly: true });
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const report = probeCapabilities(app as never);
    expect(report.optional.secretStorageRead).toBe(true);
    // 关键：getter 存在**不能**当成写能力。
    expect(report.optional.secretStorageWrite).toBe(false);
    expect(report.missingOptional.join()).toContain('setSecret');

    const service = serviceFor(app);
    const settings = defaultSettings();
    expect(service.canPersistCredential()).toBe(false);
    expect(service.canReadPersistedCredential()).toBe(true);
    expect(service.hasSecretStorage()).toBe(false);
    // getter-only 仍要能读到旧的持久值。
    expect(service.readCredential(settings)).toBe('sk-old-persisted');
    // 写入只能临时生效，且如实返回 false。
    expect(service.writeCredential('sk-getter-only', settings)).toBe(false);
    expect(service.readCredential(settings)).toBe('sk-getter-only');
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-old-persisted');
  });

  it('只有 setter：不报成已持久化，凭据在本次运行内真实可用', () => {
    const app = createFakeApp(new FakeVault(), { secretStorageSetterOnly: true });
    const report = probeCapabilities(app as never);
    expect(report.optional.secretStorageWrite).toBe(true);
    expect(report.optional.secretStorageRead).toBe(false);
    expect(report.missingOptional.join()).toContain('getSecret');

    const service = serviceFor(app);
    const settings = defaultSettings();
    // 读不回来就不算可用的持久化能力。
    expect(service.canPersistCredential()).toBe(false);
    expect(service.canReadPersistedCredential()).toBe(false);
    expect(service.hasSecretStorage()).toBe(false);

    expect(service.writeCredential('sk-setter-only', settings)).toBe(false);
    // 写进去的值本次运行内必须读得到——不能既报 false 又什么都读不到。
    expect(service.readCredential(settings)).toBe('sk-setter-only');
    expect(service.keyConfigured()).toBe(true);
  });

  it('setSecret 抛错：返回 false 且临时覆盖真的生效，压住旧持久值', () => {
    const app = createFakeApp(new FakeVault(), { secretStorageSetThrows: true });
    const settings = defaultSettings();
    // 先放一个旧持久值，模拟「之前存过、这次写失败」。
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const service = serviceFor(app);

    expect(service.writeCredential('sk-new-failed', settings)).toBe(false);
    // 不能只说「保存失败」却什么也没留下：新值必须立刻生效。
    expect(service.hasSessionKey()).toBe(true);
    expect(service.readCredential(settings)).toBe('sk-new-failed');
  });

  it('getSecret 抛错：按「没有配置」处理，不把异常当成有密钥', () => {
    const app = createFakeApp(new FakeVault(), { secretStorageGetThrows: true });
    const service = serviceFor(app);
    const settings = defaultSettings();
    expect(service.readCredential(settings)).toBe('');
    expect(service.keyConfigured()).toBe(false);
  });
});

/* ================================================================== */
/* 临时覆盖 vs 持久值                                                  */
/* ================================================================== */

describe('本次运行覆盖与持久密钥的关系', () => {
  it('显式空覆盖不得让旧持久密钥复活，清除覆盖后恢复读取', () => {
    const app = createFakeApp(new FakeVault());
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const service = serviceFor(app);
    const settings = defaultSettings();
    expect(service.readCredential(settings)).toBe('sk-old-persisted');

    // 显式空＝「此刻没有密钥」，必须压住持久值。
    service.writeSessionKey('');
    expect(service.readCredential(settings)).toBe('');
    expect(service.keyConfigured()).toBe(false);
    // 持久那一份并没有被删掉（公开 API 没有 removeSecret），只是被覆盖挡住。
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-old-persisted');

    // 「清除临时覆盖」恢复读取持久密钥。
    service.clearSessionOverride();
    expect(service.hasSessionKey()).toBe(false);
    expect(service.readCredential(settings)).toBe('sk-old-persisted');
  });

  it('持久化成功后清除本次运行覆盖', () => {
    const app = createFakeApp(new FakeVault());
    const service = serviceFor(app);
    const settings = defaultSettings();
    service.writeSessionKey('sk-session');
    expect(service.readCredential(settings)).toBe('sk-session');

    expect(service.writeCredential('sk-persisted', settings)).toBe(true);
    expect(service.hasSessionKey()).toBe(false);
    expect(service.readCredential(settings)).toBe('sk-persisted');
  });

  it('persistKey 关闭时只写本次运行，不落进存储', () => {
    const app = createFakeApp(new FakeVault());
    const service = serviceFor(app);
    const settings = defaultSettings();
    const noPersist = { ...settings, ai: { ...settings.ai, persistKey: false } };
    expect(service.writeCredential('sk-session-only', noPersist)).toBe(false);
    expect(service.readCredential(noPersist)).toBe('sk-session-only');
    expect(app.persistedSecrets.size).toBe(0);
  });

  it('setSecret 成功但读回不一致：持久值可能已变，临时值仍可用，且不谎报已保存', () => {
    const app = createFakeApp(new FakeVault());
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const service = serviceFor(app);
    const settings = defaultSettings();
    // 写入确实发生，只是读回来对不上（宿主缓存/同步延迟）。
    app.setReadBackMode('different');

    expect(service.writeCredential('sk-new', settings)).toBe(false);
    expect(service.persistUnconfirmedLastWrite()).toBe(true);
    // 不能承诺「没落盘」：持久值可能已经被改写。
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-new');
    // 临时值仍然可用。
    expect(service.hasSessionKey()).toBe(true);
    expect(service.readCredential(settings)).toBe('sk-new');
  });

  it('setSecret 成功但写后读回抛错：同样按「未确认」处理', () => {
    const app = createFakeApp(new FakeVault());
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const service = serviceFor(app);
    const settings = defaultSettings();
    app.setReadBackMode('throws');

    expect(service.writeCredential('sk-new', settings)).toBe(false);
    expect(service.persistUnconfirmedLastWrite()).toBe(true);
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-new');
    expect(service.hasSessionKey()).toBe(true);
    expect(service.readCredential(settings)).toBe('sk-new');
  });

  it('setSecret 抛错（未落盘）仍标成「未确认」：setter 可能先写后抛', () => {
    const app = createFakeApp(new FakeVault(), { secretStorageSetThrows: true });
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const service = serviceFor(app);
    expect(service.writeCredential('sk-new', defaultSettings())).toBe(false);
    // setter 已被调用过，就无法断言「没写入」，因此同样按未确认处理。
    expect(service.persistUnconfirmedLastWrite()).toBe(true);
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-old-persisted');
  });

  it('setSecret 先落盘再抛错：持久值已改、临时覆盖生效、且不谎称只在本次运行', () => {
    const app = createFakeApp(new FakeVault(), { secretStorageSetWritesThenThrows: true });
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const service = serviceFor(app);
    const settings = defaultSettings();

    expect(service.writeCredential('sk-new', settings)).toBe(false);
    // 实际持久值已经改变——这正是「不能说只在本次运行/未落盘」的原因。
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-new');
    expect(service.persistUnconfirmedLastWrite()).toBe(true);
    // 新覆盖同时生效。
    expect(service.hasSessionKey()).toBe(true);
    expect(service.readCredential(settings)).toBe('sk-new');
  });

  it('未尝试持久化时不得标成「未确认」', () => {
    const app = createFakeApp(new FakeVault());
    const service = serviceFor(app);
    // persistKey 关闭 → 根本没调用 setter，此时可以确定「没落盘」。
    const noPersist = { ...defaultSettings(), ai: { ...defaultSettings().ai, persistKey: false } };
    expect(service.writeCredential('sk-session-only', noPersist)).toBe(false);
    expect(service.persistUnconfirmedLastWrite()).toBe(false);
    expect(app.persistedSecrets.size).toBe(0);
  });

  it('空写入在持久化抛错时仍作为显式清空生效，且不等于直接写空串', () => {
    const app = createFakeApp(new FakeVault(), { secretStorageSetThrows: true });
    app.persistedSecrets.set(SECRET_ID, 'sk-old-persisted');
    const service = serviceFor(app);
    const settings = defaultSettings();

    // 存有旧持久值时，显式空写必须立刻生效。
    expect(service.writeCredential('', settings)).toBe(false);
    expect(service.hasSessionKey()).toBe(true);
    expect(service.readCredential(settings)).toBe('');
    expect(service.keyConfigured()).toBe(false);
    // 旧持久值没有被删除，只是被覆盖挡住。
    expect(app.persistedSecrets.get(SECRET_ID)).toBe('sk-old-persisted');

    // 清除覆盖后恢复读取旧持久值——这正是与「直接 writeSessionKey('')」的差别。
    service.clearSessionOverride();
    expect(service.hasSessionKey()).toBe(false);
    expect(service.readCredential(settings)).toBe('sk-old-persisted');
  });
});

/* ================================================================== */
/* 未索引的权威 Markdown：无声拒绝，不覆盖                            */
/* ================================================================== */

describe('未索引文件不得被非原子覆盖', () => {
  it('索引外的 Markdown：拒绝写入且没有调用 adapter.write', async () => {
    // 隐藏目录不进索引，因此这个文件在磁盘上存在、但索引里没有。
    const vault = new FakeVault({ files: { [`${ROOT}/.hidden/note.md`]: '用户原文' } });
    const { fileStore } = vaultStoreFor(vault);
    const target = `${ROOT}/.hidden/note.md`;
    // 直接 spy 真实的 adapter.write：`vault.calls` 里没有 write 记录，
    // 用它断言「零写入」会永远通过。
    const adapterWrite = vi.spyOn(vault.adapter, 'write');

    await expect(fileStore.writeFile(target, '插件想写的内容')).rejects.toThrowError(PathError);
    try {
      await fileStore.writeFile(target, '插件想写的内容');
    } catch (error) {
      expect((error as PathError).code).toBe(UNSAFE_OFFINDEX_WRITE);
    }
    // 关键：不是「写了之后又改回来」，而是根本没写。
    expect(adapterWrite).not.toHaveBeenCalled();
    expect(vault.rawFiles.get(target)?.content).toBe('用户原文');
  });

  it('读 A 之后外部改成 B：B 不会被 C 覆盖', async () => {
    /**
     * 复现审查给出的竞争序列：本端读到 A → 外部写入 B → 本端按 A 的比较结果写 C。
     * 修复后本端在「读完 A」这一步就不该继续，因此 B 原样保留。
     */
    const target = `${ROOT}/.hidden/race.md`;
    const vault = new FakeVault({ files: { [target]: 'A' } });
    const { fileStore } = vaultStoreFor(vault);
    const adapterWrite = vi.spyOn(vault.adapter, 'write');

    const attempt = fileStore.writeFile(target, 'C', { expectedHash: contentHashOf('A') });
    // 外部竞争写在等待期间发生。
    vault.putRaw(target, 'B');
    await expect(attempt).rejects.toThrowError(PathError);
    expect(vault.rawFiles.get(target)?.content).toBe('B');
    // 拒绝发生在读盘之前，因此这条路径上根本不会去写。
    expect(adapterWrite).not.toHaveBeenCalled();
  });

  it('插件自己的状态域仍可正常持久化（.memory 不被一刀切拒绝）', async () => {
    const vault = new FakeVault();
    const { fileStore } = vaultStoreFor(vault);
    // `.memory` 里的状态文件由插件自己读写：即使不在索引里也必须写得进去。
    const result = await fileStore.writeFile(`${ROOT}/.memory/state.json`, '{"cursor":1}');
    expect(result.status).toBe('written');
    expect(vault.rawFiles.get(`${ROOT}/.memory/state.json`)?.content).toBe('{"cursor":1}');

    // 覆盖同一状态文件同样走通（第二次写入是「已存在」路径）。
    const again = await fileStore.writeFile(`${ROOT}/.memory/state.json`, '{"cursor":2}');
    expect(again.status).toBe('written');
    expect(vault.rawFiles.get(`${ROOT}/.memory/state.json`)?.content).toBe('{"cursor":2}');
  });

  it('未索引的 Markdown 仍可读（拒绝的是写，不是可用性）', async () => {
    const target = `${ROOT}/.hidden/note.md`;
    const vault = new FakeVault({ files: { [target]: '仍然读得到' } });
    const { fileStore } = vaultStoreFor(vault);
    expect(await fileStore.readFile(target)).toBe('仍然读得到');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultOrganization, defaultSettings, type OrganizationSettings } from '@mom/core';
import MissherMemoryPlugin from '../packages/plugin/src/plugin.js';
import { MemoryService } from '../packages/plugin/src/memory-service.js';
import { confirmReload } from '../packages/plugin/src/modals.js';
import { createFakeApp, FakeVault } from './obsidian-stub.js';

// 仅替换用户确认；切换方法、核心、存储适配器均走产品实现。
vi.mock('../packages/plugin/src/modals.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/plugin/src/modals.js')>(),
  confirmReload: vi.fn(),
}));

const missher = (placement: 'root' | 'vault' = 'vault'): OrganizationSettings => ({ preset: 'missher', placement, folders: {} });
const routes = ['root', 'organization'] as const;
type Route = typeof routes[number];

async function setup(organization = defaultOrganization(), root = 'Second Brain') {
  const vault = new FakeVault();
  const reload = vi.fn(() => true);
  const app = { ...createFakeApp(vault), commands: { executeCommandById: reload } };
  const settings = { ...defaultSettings(), root, organization };
  const plugin = new MissherMemoryPlugin(app as never, {} as never);
  Object.assign(plugin, { momSettings: settings });
  const service = new MemoryService({
    app: app as never, memoryRoot: root, instanceId: 'organization-switch-test',
    getSettings: () => plugin.currentSettings(),
  });
  plugin.service = service;
  await service.load();
  const save = vi.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
  return { plugin, service, vault, settings, save, reload };
}

function switchVia(plugin: MissherMemoryPlugin, route: Route, root = '新库', organization = defaultOrganization()) {
  return route === 'root' ? plugin.applyRoot(root) : plugin.applyOrganization(organization, root);
}

function snapshot(vault: FakeVault) {
  return [...vault.rawFiles].map(([path, file]) => [path, file.content]);
}

beforeEach(() => { vi.mocked(confirmReload).mockReset().mockResolvedValue(true); });
afterEach(() => vi.restoreAllMocks());

describe('目录切换不切断同一批记忆的状态账本', () => {
  it.each(routes)('%s 入口在确认及保存之前拒绝 Missher/vault 换状态根', async route => {
    const { plugin, service, vault, settings, save, reload } = await setup(missher(), '记忆库');
    const draft = { title: '合成知识', body: '应保持遗忘的合成内容', kind: 'knowledge' as const, sourceKind: 'user_explicit' as const, sourceRef: 'synthetic-event' };
    const saved = await service.store.remember(draft);
    expect(saved.ok).toBe(true);
    const deleted = await service.store.deletePermanently(saved.id, { expectedHash: service.store.hashOf(saved.id)! });
    expect(deleted.ok).toBe(true);
    const before = snapshot(vault);
    const result = await switchVia(plugin, route, '系统', missher());
    expect(result.ok).toBe(false);
    expect(result.message).toContain('专门迁移');
    expect(vi.mocked(confirmReload)).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(plugin.currentSettings()).toBe(settings);
    expect(service.memoryRoot).toBe('记忆库');
    expect(snapshot(vault)).toEqual(before);
    const replay = await service.store.remember(draft);
    expect(replay.ok).toBe(false);
    expect(replay.blockedByTombstone).toBeDefined();
  });

  it.each(routes)('%s 入口依据实际运行方案，不能用已保存的 legacy 值绕过保护', async route => {
    const { plugin, save } = await setup(missher(), '记忆库');
    Object.assign(plugin, { momSettings: { ...plugin.currentSettings(), organization: defaultOrganization() } });
    const result = await switchVia(plugin, route);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('专门迁移');
    expect(save).not.toHaveBeenCalled();
  });

  it('legacy 初次切换到不重叠的 Missher/vault 可选择记忆库根，旧文件不迁移', async () => {
    const { plugin, service, vault, save, reload } = await setup();
    const saved = await service.store.remember({ body: '旧根的合成偏好', kind: 'preference', sourceKind: 'user_explicit' });
    const before = snapshot(vault);
    const result = await plugin.applyOrganization(missher(), '记忆库');
    expect(result.ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ root: '记忆库', organization: missher() }));
    expect(reload).toHaveBeenCalledWith('app:reload');
    expect(plugin.currentSettings().root).toBe('记忆库');
    expect(service.memoryRoot).toBe('Second Brain');
    expect(service.organization).toEqual(defaultOrganization());
    expect(vault.rawFiles.has(saved.path)).toBe(true);
    expect(snapshot(vault)).toEqual(before);
  });

  it('新旧物理目录重叠的 legacy 到 vault 切换也必须保留状态根', async () => {
    const { plugin, save } = await setup(defaultOrganization(), '知识库');
    const result = await plugin.applyOrganization(missher(), '记忆库');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('重叠');
    expect(save).not.toHaveBeenCalled();
    expect(vi.mocked(confirmReload)).not.toHaveBeenCalled();
  });

  it.each(['旧库/子库', '旧库'])('根目录祖先/后代重叠不能成为另一个空状态库：%s', async nextRoot => {
    const oldRoot = nextRoot === '旧库' ? '旧库/子库' : '旧库';
    const { plugin, save } = await setup(defaultOrganization(), oldRoot);
    const result = await plugin.applyRoot(nextRoot);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('重叠');
    expect(save).not.toHaveBeenCalled();
  });

  it('保持同一状态根时仍可调整分类方案', async () => {
    const { plugin, service, save } = await setup(missher(), '记忆库');
    const next = { ...missher(), folders: { knowledge: '资料/知识' } };
    expect((await plugin.applyOrganization(next, '记忆库')).ok).toBe(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ root: '记忆库', organization: next }));
    expect(service.organization).toEqual(missher());
  });
});

describe('两个切换入口的确认、队列与保存边界', () => {
  it.each(routes)('%s 确认前及取消后均零次保存', async route => {
    const { plugin, settings, save, reload } = await setup();
    let decide!: (confirmed: boolean) => void;
    vi.mocked(confirmReload).mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const pending = switchVia(plugin, route);
    expect(vi.mocked(confirmReload)).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(plugin.currentSettings()).toBe(settings);
    decide(false);
    expect((await pending).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(plugin.currentSettings()).toBe(settings);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(routes)('%s 弹窗期间队列开始提交，确认后仍阻止保存和重载', async route => {
    const { plugin, service, settings, save, reload } = await setup();
    let busy = false;
    vi.spyOn(service.writeQueue, 'busy').mockImplementation(() => busy);
    let decide!: (confirmed: boolean) => void;
    vi.mocked(confirmReload).mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const pending = switchVia(plugin, route);
    expect(vi.mocked(confirmReload)).toHaveBeenCalledTimes(1);
    busy = true;
    decide(true);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('正在提交');
    expect(save).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(plugin.currentSettings()).toBe(settings);
  });

  it.each(routes)('%s 保存失败保持运行及保存前设置，不触发重载', async route => {
    const { plugin, service, settings, save, reload } = await setup();
    save.mockRejectedValueOnce(new Error('synthetic settings error'));
    const result = await switchVia(plugin, route);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('synthetic settings error');
    expect(plugin.currentSettings()).toBe(settings);
    expect(service.memoryRoot).toBe('Second Brain');
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(routes)('%s 重载命令返回 false 时如实报告尚未生效', async route => {
    const { plugin, service, save, reload } = await setup();
    reload.mockReturnValueOnce(false);
    const result = await switchVia(plugin, route);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/手动|当前仍使用旧方案/);
    if ('reloading' in result) expect(result.reloading).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(plugin.currentSettings().root).toBe('新库');
    expect(service.memoryRoot).toBe('Second Brain');
  });
});

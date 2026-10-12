import { describe, expect, it } from 'vitest';
import { defaultSettings, type OrganizationSettings } from '@mom/core';
import MissherMemoryPlugin from '../packages/plugin/src/plugin.js';
import { MemoryService } from '../packages/plugin/src/memory-service.js';
import { IndexRefreshMonitor } from '../packages/plugin/src/index-refresh.js';
import { createFakeApp, FakeVault, requestUrlCalls, resetRequestUrlCalls } from './obsidian-stub.js';

const organization: OrganizationSettings = { preset: 'missher', placement: 'vault', folders: {} };
function setup(vault = new FakeVault(), config = organization) {
  const settings = { ...defaultSettings(), root: '记忆库', organization: config };
  const service = new MemoryService({
    app: createFakeApp(vault) as never, memoryRoot: settings.root,
    instanceId: 'organization_test', getSettings: () => settings,
  });
  return { service, vault, settings };
}

describe('Missher 分类的插件存储和队列接线', () => {
  it('同级目录接收真实队列提交并在重建服务后查询，普通笔记字节保持', async () => {
    const original = '# 手写知识\n这不是托管记忆。\n';
    const { service, vault } = setup(new FakeVault({ files: { '知识库/手写笔记.md': original } }));
    const report = await service.load();
    expect(report.invalid).toBe(0);
    const accepted = await service.writeQueue.enqueue({
      operation: 'remember', payload: { body: '青岚项目采用隔离验证。', title: '隔离验证', kind: 'knowledge', category: 'knowledge' },
      target: '', expectedHash: null, expectedRevision: null,
      requester: 'cli:synthetic', idempotencyKey: 'category-vault-1',
    });
    expect(accepted.accepted).toBe(true);
    expect(service.store.all()).toHaveLength(0);
    const scan = await service.writeQueue.processOnce();
    expect(scan.malformed).toEqual([]);
    expect(scan.processed[0]?.status).toBe('completed');
    expect(scan.processed[0]?.path).toBe('知识库/隔离验证.md');
    const receipt = await service.writeQueue.readReceipt(accepted.requestId!);
    expect(receipt.errors).toEqual([]);
    expect(receipt.receipt?.status).toBe('completed');
    expect(vault.rawFiles.get('知识库/手写笔记.md')?.content).toBe(original);
    const restarted = setup(vault).service;
    await restarted.load();
    const hits = await restarted.store.search({ text: '隔离验证' });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]?.path).toBe('知识库/隔离验证.md');
    const replay = await restarted.writeQueue.processOnce();
    expect(replay.processed).toEqual([]);
    expect(restarted.store.all()).toHaveLength(1);
  });

  it('自定义目录同时约束读取和提交，状态文件仍只位于根内', async () => {
    const { service } = setup(undefined, { ...organization, folders: { knowledge: '资料/知识' } });
    await service.load();
    const result = await service.store.remember({ body: '中文检索约定。', title: '检索约定', kind: 'knowledge', sourceKind: 'user_explicit' });
    expect(result.ok).toBe(true);
    expect(result.path).toBe('资料/知识/检索约定.md');
    await expect(service.vaultStore.readFile('其他/秘密.md')).rejects.toThrow();
    await expect(service.vaultStore.readFile('资料/知识/.memory/tombstones.json')).rejects.toThrow();
    await expect(service.store.writeStateFile('probe.json', '{}')).resolves.toBeUndefined();
    expect(await service.vaultStore.readFile('记忆库/.memory/probe.json')).toBe('{}');
  });

  it('确认状态不随分类提升；有新旧内容冲突时不覆盖人工修改', async () => {
    const { service, vault } = setup();
    await service.load();
    const saved = await service.store.propose({ body: '有待确认的部署步骤。', title: '部署步骤', category: 'workflow', sourceKind: 'ai_extraction' });
    expect(saved.ok).toBe(true);
    const record = service.store.get(saved.id!);
    expect(record?.meta.status).toBe('pending');
    expect(record?.path).toBe('工作流/部署步骤.md');
    expect((await service.store.search({ text: '部署' })).hits).toEqual([]);
    const hash = service.store.hashOf(saved.id!);
    vault.putRaw(saved.path!, vault.rawFiles.get(saved.path!)!.content.replace('有待确认', '人工修订后待确认'));
    const confirmed = await service.store.confirm(saved.id!, { expectedHash: hash! });
    expect(confirmed.ok).toBe(false);
    expect(vault.rawFiles.get(saved.path!)!.content).toContain('人工修订后待确认');
  });

  it('刷新监听覆盖显式同级目录，排除无关目录和内部状态', () => {
    const monitor = new IndexRefreshMonitor({ memoryRoot: '记忆库', organization, refresh: async () => {}, setTimeoutFn: () => 1, clearTimeoutFn: () => {} });
    expect(monitor.onVaultEvent('知识库/主题.md')).toBe('queued');
    expect(monitor.onVaultEvent('教训/错误.md')).toBe('queued');
    expect(monitor.onVaultEvent('其他/秘密.md')).toBe('ignored');
    expect(monitor.onVaultEvent('记忆库/.memory/state.json')).toBe('ignored');
    expect(monitor.onVaultEvent('知识库/../../私密.md')).toBe('ignored');
    monitor.dispose();
  });
});


it('确认的模板不会被自动提取当成事实发送，作业验证也拒绝它', async () => {
  resetRequestUrlCalls();
  const { service, vault, settings } = setup();
  settings.ai = { ...settings.ai, enabled: true, baseUrl: 'https://example.invalid/v1', model: 'synthetic' };
  await service.load();
  const saved = await service.store.remember({ body: '待填写的习惯，不是真实偏好。', category: 'template', sourceKind: 'user_explicit' });
  const plugin = new MissherMemoryPlugin(createFakeApp(vault) as never, {} as never);
  Object.assign(plugin, { service, momSettings: settings, refreshViews: async () => {} });
  const job = await service.jobs.enqueue({ kind: 'extract_session', scope: 'template_extract', trigger: 'manual' });
  const message = await plugin.runExtractJob(job.id);
  expect(message).toContain('未发送任何请求');
  expect(requestUrlCalls).toHaveLength(0);
  const another = await service.jobs.enqueue({ kind: 'extract_session', scope: 'template_gate', trigger: 'manual' });
  let checked = false;
  await service.jobs.run(another.id, async context => {
    expect(context.validate(service.store.get(saved.id)!)).toMatchObject({ allowed: false });
    checked = true;
    return { ok: true, message: '无需模型', modelUsed: false };
  });
  expect(checked).toBe(true);
});

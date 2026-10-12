import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeOrganization, parseRequestEnvelope, serializeReceipt, type QueueReceipt } from '@mom/core';
import { ExternalQueueClient } from '../packages/cli/src/external-queue.js';
import { NodeFileStore } from '../packages/cli/src/node-store.js';
import { categoryFrom, organizationFromStartup } from '../packages/cli/src/organization-options.js';

const EXPERIMENT = fileURLToPath(new URL('../.experiment/', import.meta.url));
const ROOT = 'Brain';
const ORGANIZATION = normalizeOrganization({ preset: 'missher', placement: 'vault', folders: { profile: '人物/当前' } });
const fixtures: string[] = [];

async function fixture(): Promise<string> {
  await fs.mkdir(EXPERIMENT, { recursive: true });
  const vault = await fs.mkdtemp(path.join(EXPERIMENT, 'organization-node-'));
  fixtures.push(vault);
  return vault;
}

async function put(vault: string, relative: string, content = '合成内容'): Promise<void> {
  const absolute = path.join(vault, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
}

afterEach(async () => {
  for (const vault of fixtures.splice(0)) await fs.rm(vault, { recursive: true, force: true });
});

describe('可信启动配置', () => {
  it('默认保持 legacy，参数优先于环境，JSON 目录覆盖遵循同一规范', () => {
    expect(organizationFromStartup(new Map(), {})).toEqual(normalizeOrganization(undefined));
    const organization = organizationFromStartup(new Map([
      ['layout', 'missher'], ['placement', 'vault'], ['folders-json', '{"profile":"人物/当前"}'],
    ]), { MOM_LAYOUT: 'legacy', MOM_PLACEMENT: 'root', MOM_FOLDERS_JSON: '{"profile":"旧位置"}' });
    expect(organization).toEqual(ORGANIZATION);
    expect(organizationFromStartup(new Map(), {
      MOM_LAYOUT: 'missher', MOM_PLACEMENT: 'vault', MOM_FOLDERS_JSON: '{"profile":"人物/当前"}',
    })).toEqual(ORGANIZATION);
  });

  it('未知分类、越界目录、错误 JSON 不降级为宽松扫描', () => {
    for (const json of ['null', '[]', '{', '{"unknown":"目录"}', '{"profile":"../私人"}', '{"profile":".memory"}']) {
      expect(() => organizationFromStartup(new Map([['folders-json', json]]), {})).toThrow();
    }
    expect(() => organizationFromStartup(new Map([['layout', 'all']]), {})).toThrow();
    expect(() => organizationFromStartup(new Map([['placement', 'all']]), {})).toThrow();
    expect(categoryFrom('workflow')).toBe('workflow');
    expect(categoryFrom(undefined)).toBeUndefined();
    for (const category of [null, '../知识库', 'all', true]) expect(() => categoryFrom(category)).toThrow();
  });
});

describe('Node 分类目录与外部队列', () => {
  it('只枚举旧根与明确分类根，旧配置不会扩大扫描', async () => {
    const vault = await fixture();
    await put(vault, 'Brain/旧笔记.md');
    await put(vault, '人物/当前/偏好.md');
    await put(vault, '工作流/步骤.md');
    await put(vault, '用户画像/已覆盖目录.md');
    await put(vault, '未授权/私人.md');
    await put(vault, 'Brain/.memory/状态.md');
    const store = await NodeFileStore.open({ vaultRoot: vault, memoryRoot: ROOT, organization: ORGANIZATION });
    expect((await store.listFiles()).map(item => item.path)).toEqual(['Brain/旧笔记.md', '人物/当前/偏好.md', '工作流/步骤.md']);
    expect(await store.readFileOrThrow('人物/当前/偏好.md')).toBe('合成内容');
    await expect(store.readFileOrThrow('未授权/私人.md')).rejects.toThrow();
    const legacy = await NodeFileStore.open({ vaultRoot: vault, memoryRoot: ROOT });
    expect((await legacy.listFiles()).map(item => item.path)).toEqual(['Brain/旧笔记.md']);
    await expect(legacy.readFileOrThrow('工作流/步骤.md')).rejects.toThrow();
    await expect(store.writeFile('工作流/新笔记.md', '不得直接写')).rejects.toThrow(/默认不允许直接写/);
  });

  it('分类目录、末段文件和根内状态链接均不能逃逸', async () => {
    const vault = await fixture();
    await put(vault, '未授权/私人.md');
    await put(vault, 'Brain/.memory/secret.json');
    await put(vault, '工作流/步骤.md');
    await fs.symlink(path.join(vault, '未授权'), path.join(vault, '知识库'));
    await fs.symlink(path.join(vault, '未授权/私人.md'), path.join(vault, '工作流/escape.md'));
    await fs.symlink(path.join(vault, 'Brain/.memory/secret.json'), path.join(vault, '工作流/state.md'));
    const store = await NodeFileStore.open({ vaultRoot: vault, memoryRoot: ROOT, organization: ORGANIZATION });
    await expect(store.listFiles('知识库')).rejects.toThrow(/符号链接/);
    await expect(store.readFileOrThrow('工作流/escape.md')).rejects.toThrow(/符号链接/);
    await expect(store.readFileOrThrow('工作流/state.md')).rejects.toThrow(/符号链接/);
    await expect(store.readFileOrThrow('工作流/.memory/secret.json')).rejects.toThrow();
    expect((await store.listFiles('工作流')).map(item => item.path)).toEqual(['工作流/步骤.md']);
    const state = await store.resolveStatePath('Brain/.memory/requests');
    expect(state).toBe(path.join(vault, 'Brain/.memory/requests'));
    await expect(store.resolveStatePath('工作流/.memory/requests')).rejects.toThrow();
  });

  it('自定义分类请求只排入原根，分类回执能读回，未直接创建笔记', async () => {
    const vault = await fixture();
    const queue = new ExternalQueueClient({ vaultRoot: vault, memoryRoot: ROOT, organization: ORGANIZATION });
    const accepted = await queue.enqueue({
      id: 'req_20261012000000_abc12345', operation: 'remember',
      payload: { body: '合成偏好完整正文', title: '偏好', category: 'profile', allow_model: false },
      requester: 'test', idempotencyKey: 'category-profile',
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.path).toBe(`Brain/.memory/requests/${accepted.requestId}.md`);
    const raw = await fs.readFile(path.join(vault, accepted.path), 'utf8');
    expect(parseRequestEnvelope(raw, { root: ROOT, organization: ORGANIZATION }).request?.payload)
      .toEqual({ body: '合成偏好完整正文', title: '偏好', category: 'profile', allow_model: false });
    await expect(fs.stat(path.join(vault, '人物'))).rejects.toMatchObject({ code: 'ENOENT' });
    const receipt: QueueReceipt = {
      protocol: 1, requestId: accepted.requestId, fingerprint: accepted.fingerprint,
      status: 'completed', committedBy: 'synthetic-plugin', committedAt: new Date().toISOString(),
      revision: 1, evidence: { kind: 'content', contentHash: 'b'.repeat(64), revision: 1 },
      contentHash: 'b'.repeat(64), memoryId: 'mem_category', path: '人物/当前/偏好.md',
      message: '合成回执', actualHash: null, idempotencyKey: 'category-profile',
    };
    await put(vault, `Brain/.memory/receipts/${accepted.requestId}.md`, serializeReceipt(receipt));
    expect((await queue.readReceipt(accepted.requestId))?.path).toBe('人物/当前/偏好.md');
    expect(await queue.listReceipts()).toHaveLength(1);
    expect((await queue.pendingCount()).pending).toBe(1);
    const legacy = new ExternalQueueClient({ vaultRoot: vault, memoryRoot: ROOT });
    expect(await legacy.readReceipt(accepted.requestId)).toBeNull();
  });

  it('状态目录链接到分类根也被拒绝，不能借分类扩大 queue 的物理范围', async () => {
    const vault = await fixture();
    await fs.mkdir(path.join(vault, ROOT));
    await fs.mkdir(path.join(vault, '工作流'));
    await fs.symlink(path.join(vault, '工作流'), path.join(vault, 'Brain/.memory'));
    const store = await NodeFileStore.open({ vaultRoot: vault, memoryRoot: ROOT, organization: ORGANIZATION });
    await expect(store.readFile('Brain/.memory/tombstones.json')).rejects.toThrow(/符号链接/);
    const queue = new ExternalQueueClient({ vaultRoot: vault, memoryRoot: ROOT, organization: ORGANIZATION });
    await expect(queue.enqueue({
      operation: 'remember', payload: { body: '合成内容', category: 'workflow' },
      requester: 'test', idempotencyKey: 'state-escape',
    })).rejects.toThrow(/符号链接/);
    expect(await fs.readdir(path.join(vault, '工作流'))).toEqual([]);
  });
});

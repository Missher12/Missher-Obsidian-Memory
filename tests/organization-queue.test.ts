import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_CATEGORIES,
  assertQueuePath,
  normalizeOrganization,
  parseReceipt,
  parseRequestEnvelope,
  processRequest,
  receiptPath,
  requestFingerprint,
  requestPath,
  serializeReceipt,
  serializeRequest,
  validateOperationPayload,
  validateReceipt,
  validateRequest,
  type CommitOutcome,
  type QueueReceipt,
  type QueueRequest,
} from '@mom/core';

const ROOT = 'Brain';
const NOW = Date.parse('2026-10-12T00:00:00.000Z');
const ORGANIZATION = normalizeOrganization({ preset: 'missher', placement: 'vault', folders: { profile: '人物/当前' } });

function request(overrides: Partial<QueueRequest> = {}): QueueRequest {
  return {
    protocol: 1,
    id: 'req_20261012000000_abc12345',
    operation: 'correct',
    target: '人物/当前/偏好.md',
    payload: { replacement: '合成内容' },
    expectedHash: 'a'.repeat(64),
    expectedRevision: 1,
    requester: 'organization-test',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    idempotencyKey: 'organization-queue-test',
    ...overrides,
  };
}

function outcome(path = '人物/当前/偏好.md'): CommitOutcome {
  return {
    status: 'completed', message: '合成提交', path, revision: 2,
    evidence: { kind: 'content', contentHash: 'b'.repeat(64), revision: 2 },
    contentHash: 'b'.repeat(64), memoryId: 'mem_organization', actualHash: null,
  };
}

function receipt(path = '人物/当前/偏好.md'): QueueReceipt {
  return {
    ...outcome(path), protocol: 1, status: 'completed',
    requestId: request().id, fingerprint: requestFingerprint(request()),
    committedBy: 'test', committedAt: new Date(NOW).toISOString(),
    idempotencyKey: request().idempotencyKey,
  };
}

describe('组织配置队列契约', () => {
  it('旧配置仍只接受原根，分类布局需显式配置且遵循自定义映射', () => {
    expect(validateRequest(request(), { root: ROOT }).ok).toBe(false);
    expect(validateRequest(request({ target: 'Brain/legacy.md' }), { root: ROOT }).ok).toBe(true);
    expect(validateRequest(request(), { root: ROOT, organization: ORGANIZATION }).ok).toBe(true);
    expect(validateRequest(request({ target: '用户画像/旧默认.md' }), { root: ROOT, organization: ORGANIZATION }).ok).toBe(false);
    expect(validateRequest(request({ target: '工作流/步骤.md' }), { root: ROOT, organization: ORGANIZATION }).ok).toBe(true);
    const nested = normalizeOrganization({ preset: 'missher', placement: 'root' });
    expect(validateRequest(request({ target: '工作流/步骤.md' }), { root: ROOT, organization: nested }).ok).toBe(false);
    expect(validateRequest(request({ target: 'Brain/工作流/步骤.md' }), { root: ROOT, organization: nested }).ok).toBe(true);
  });

  it.each(['其他/笔记.md', '../用户画像/a.md', '/工作流/a.md', '工作流/../其他/a.md', '工作流/.memory/a.md', 'Brain/.memory/tombstones.json'])('拒绝非法普通内容目标 %s', target => {
    const options = { root: ROOT, organization: ORGANIZATION };
    expect(validateRequest(request({ target }), options).ok).toBe(false);
    expect(validateReceipt(receipt(target), options).ok).toBe(false);
  });

  it('分类不扩大请求/回执文件自身目录', () => {
    expect(requestPath(ROOT, request().id)).toBe(`Brain/.memory/requests/${request().id}.md`);
    expect(receiptPath(ROOT, request().id)).toBe(`Brain/.memory/receipts/${request().id}.md`);
    expect(() => assertQueuePath(ROOT, `工作流/.memory/requests/${request().id}.md`)).toThrow();
  });

  it('remember/propose 只接收分类白名单，不从载荷读取组织边界', () => {
    for (const operation of ['remember', 'propose'] as const) {
      for (const category of MEMORY_CATEGORIES) {
        expect(validateOperationPayload(operation, { body: '合成内容', category }).ok).toBe(true);
      }
      for (const category of ['', '../知识库', 'all', null, true, {}]) {
        expect(validateOperationPayload(operation, { body: '合成内容', category }).ok).toBe(false);
      }
      for (const key of ['organization', 'layout', 'placement', 'folders', 'root']) {
        expect(validateOperationPayload(operation, { body: '合成内容', [key]: {} }).ok).toBe(false);
      }
    }
  });

  it('remember/propose 可携带短标题，300 字符边界严格且信封往返保留', () => {
    for (const operation of ['remember', 'propose'] as const) {
      const base = { body: '完整正文与短标题分开保存', category: 'workflow' };
      expect(validateOperationPayload(operation, base).ok).toBe(true);
      expect(validateOperationPayload(operation, { ...base, title: '短标题' }).ok).toBe(true);
      expect(validateOperationPayload(operation, { ...base, title: '标'.repeat(300) }).ok).toBe(true);
      for (const title of ['', ' ', '标'.repeat(301), null, 1, true, {}]) {
        expect(validateOperationPayload(operation, { ...base, title }).ok).toBe(false);
      }
      const envelope = request({ operation, target: '', expectedHash: null, expectedRevision: null, payload: { ...base, title: '短标题' } });
      const parsed = parseRequestEnvelope(serializeRequest(envelope), { root: ROOT, organization: ORGANIZATION });
      expect(parsed.request?.payload.title).toBe('短标题');
      expect(parsed.request?.payload.body).toBe(base.body);
    }
    expect(validateOperationPayload('update', { title: '既有修正标题' }).ok).toBe(true);
    expect(validateOperationPayload('update', { title: '标'.repeat(301) }).ok).toBe(false);
  });

  it('请求/回执往返共用配置，省略配置不会信任信封中的目录', () => {
    const options = { root: ROOT, organization: ORGANIZATION };
    const raw = serializeRequest(request());
    expect(parseRequestEnvelope(raw, options).request?.target).toBe(request().target);
    expect(parseRequestEnvelope(raw, { root: ROOT }).request).toBeNull();
    const rawReceipt = serializeReceipt(receipt());
    expect(parseReceipt(rawReceipt, options).receipt?.path).toBe(request().target);
    expect(parseReceipt(rawReceipt, { root: ROOT }).receipt).toBeNull();
  });

  it('runner 接收分类目标，保留 CAS 预期并认可分类回执', async () => {
    const commit = vi.fn(() => outcome());
    const writeReceipt = vi.fn(() => true);
    const result = await processRequest(request(), {
      root: ROOT, organization: ORGANIZATION, now: () => NOW, committedBy: 'test',
      findReceipt: () => ({ kind: 'none' }), commit, writeReceipt,
    });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ expectedHash: 'a'.repeat(64), expectedRevision: 1 }));
    expect(result.receipt?.status).toBe('completed');
    expect(result.receiptDurable).toBe(true);
    expect(writeReceipt).toHaveBeenCalledTimes(1);
  });

  it('runner 默认旧边界拒绝分类目标，不进入提交', async () => {
    const commit = vi.fn(() => outcome());
    const result = await processRequest(request(), {
      root: ROOT, now: () => NOW, committedBy: 'test',
      findReceipt: () => ({ kind: 'none' }), commit, writeReceipt: () => true,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(result.receipt?.status).toBe('failed');
  });

  it('恢复也校验分类回执，越界结果不持久化、不重放副作用', async () => {
    const commit = vi.fn(() => outcome());
    const writeReceipt = vi.fn(() => true);
    const result = await processRequest(request(), {
      root: ROOT, organization: ORGANIZATION, now: () => NOW, committedBy: 'test',
      findReceipt: () => ({ kind: 'none' }), findCommitted: () => outcome('其他/越界.md'), commit, writeReceipt,
    });
    expect(result.recovered).toBe(true);
    expect(result.receiptDurable).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(writeReceipt).not.toHaveBeenCalled();
  });
});

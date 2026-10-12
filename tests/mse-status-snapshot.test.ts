import { describe, expect, it } from 'vitest';
import { buildMethodCandidate, newBridgeItem, refreshRemoteStatus, type BridgeItem, type MseChannel } from '@mom/core';

function validatedItem(): BridgeItem {
  const { envelope } = buildMethodCandidate({
    memory: { id: 'mem_aaaaaaaaaaaaaaaa', revision: 1, scope: 'project', scopeRef: 'qinglan' },
    problem: { kind: 'unknown', ref: 'synthetic', excerptHash: 'a'.repeat(64), excerptLength: 2 },
    method: { instruction: '提交前检查来源版本。', applicability: '青岚项目', exclusions: '其他项目' },
    originEventId: 'evt-synthetic', proposalId: 'proposal-synthetic', now: 0,
  });
  const item = newBridgeItem({ envelope, now: 0 });
  item.remote = { ...item.remote, candidateId: 'candidate-1', candidateVersion: 1,
    validatedAt: '2026-10-01T00:00:00.000Z', reviewedAt: '2026-09-30T00:00:00.000Z',
    openQuestions: ['旧版本记录'], readAt: '2026-10-01T00:00:00.000Z' };
  return item;
}
const channel = (result: Partial<BridgeItem['remote']> | { error: string }): MseChannel => ({
  id: 'synthetic', available: async () => true,
  importCandidate: async () => ({ ok: false, error: '本测试不发送候选', retryable: false }),
  readStatus: async () => result,
});

describe('MSE 状态必须是同一候选的明确版本快照', () => {
  it('新版缺少验证证据时不能继承旧版的通过时间', async () => {
    const previous = validatedItem();
    const result = await refreshRemoteStatus({ item: previous, channel: channel({ candidateVersion: 2 }), now: 100 });
    expect(result.remote.candidateVersion).toBe(2);
    expect(result.remote.validatedAt).toBe('');
    expect(result.remote.reviewedAt).toBe('');
    expect(result.remote.openQuestions).toEqual([]);
    expect(previous.remote.validatedAt).not.toBe('');
  });
  it('同版本快照缺少验证也不将旧通过状态拼接回来', async () => {
    const result = await refreshRemoteStatus({ item: validatedItem(), channel: channel({ candidateVersion: 1, suspendedAt: '2026-10-12T00:00:00.000Z' }), now: 100 });
    expect(result.remote.validatedAt).toBe('');
    expect(result.remote.suspendedAt).not.toBe('');
  });
  it.each([{}, { candidateVersion: 0 }, { candidateVersion: 1.5 }, { candidateVersion: 2, candidateId: 'different' }, { error: 'offline' }])(
    '不明确或错误对象的状态不作为新回读证据：%j', async snapshot => {
      const item = validatedItem();
      const result = await refreshRemoteStatus({ item, channel: channel(snapshot), now: 100 });
      expect(result.remote).toEqual(item.remote);
    },
  );
  it('明确同对象同版本证据可显示；外部数组不共享引用', async () => {
    const questions = ['仍有待观察项'];
    const result = await refreshRemoteStatus({ item: validatedItem(), channel: channel({ candidateId: 'candidate-1', candidateVersion: 2, validatedAt: '2026-10-12T00:00:00.000Z', openQuestions: questions }), now: 100 });
    questions.push('外部变化');
    expect(result.remote.validatedAt).toBe('2026-10-12T00:00:00.000Z');
    expect(result.remote.openQuestions).toEqual(['仍有待观察项']);
  });
});

/**
 * MSE 方法候选导出：**本地生成 + 本地校验 + 本地写盘**。
 *
 * 这一组测试存在的理由，是防止出现「界面上有导出按钮，但导出的东西
 * 校验不过 / 悄悄改了记忆 / 覆盖了上一次导出」这类看不出问题的失败。
 */

import { describe, expect, it } from 'vitest';
import { MSE_SCHEMA, MemoryStore, type MemoryRecord } from '@mom/core';
import { VaultFileStore } from '../packages/plugin/src/vault-store.js';
import { buildMethodCandidateDraft, renderMethodCandidateFile } from '../packages/plugin/src/mse-candidate.js';
import { createFakeApp, FakeVault } from './obsidian-stub.js';
import { fixedClock, seededRand, T0 } from './helpers.js';

const ROOT = 'Brain';

function makeStore(vault: FakeVault, seed = 11) {
  const app = createFakeApp(vault);
  const fileStore = new VaultFileStore({ app: app as never, memoryRoot: ROOT });
  const clock = fixedClock(T0);
  const store = new MemoryStore({
    store: fileStore,
    root: ROOT,
    now: clock.now,
    rand: seededRand(seed),
  });
  return { vault, store, clock };
}

async function rememberOne(vault: FakeVault, body: string): Promise<MemoryRecord> {
  const { store } = makeStore(vault);
  const remembered = await store.remember({ body, sourceKind: 'user_explicit' });
  await store.load();
  const record = store.get(remembered.id);
  if (record === null) throw new Error('播种失败：记忆没有出现在存储里');
  return record;
}

describe('MSE 候选导出：本地生成与本地校验', () => {
  it('生成的候选包通过本地校验，且 schema 是 mse-method-v1', async () => {
    const record = await rememberOne(new FakeVault(), '# 项目 Borealis 的构建脚本\n\n构建脚本改用 pnpm 11。');
    const draft = buildMethodCandidateDraft({ record, now: T0 });
    expect(draft.validation.ok).toBe(true);
    expect(draft.validation.reasons).toEqual([]);
    expect(draft.packet.schema).toBe(MSE_SCHEMA);
  });

  it('同一个输入两次生成得到**完全相同**的包（校验和不依赖时间）', async () => {
    const record = await rememberOne(new FakeVault(), '# 稳定标题\n\n同一份内容。');
    const first = buildMethodCandidateDraft({ record, now: T0 });
    const second = buildMethodCandidateDraft({ record, now: T0 + 86_400_000 });
    expect(second.packet).toEqual(first.packet);
  });

  it('改动正文会改变校验和（导出的是这条记忆当时的内容）', async () => {
    const vault = new FakeVault();
    const record = await rememberOne(vault, '# 会被改的标题\n\n第一版内容。');
    const before = buildMethodCandidateDraft({ record, now: T0 });
    /*
     * 把标题也一起改掉：默认指令里含标题，摘要也有长度上限，
     * 只改一条短正文的尾部时正文摘要可能完全一样（那就测不出差异）。
     */
    const changed: MemoryRecord = {
      ...record,
      body: '# 改过的标题\n\n第二版内容，说明它确实变了。',
    };
    const after = buildMethodCandidateDraft({ record: changed, now: T0 });
    expect(after.packet.checksum).not.toBe(before.packet.checksum);
    expect(after.packet.instruction).not.toBe(before.packet.instruction);
  });

  it('显式给定的指令原样进入候选包（不覆盖调用者的话）', async () => {
    const record = await rememberOne(new FakeVault(), '# 指令\n\n内容。');
    const draft = buildMethodCandidateDraft({
      record,
      instruction: '先核对来源版本，再改构建脚本。',
      applicability: '仅限本地仓库',
      exclusions: '不适用于发布流程',
      now: T0,
    });
    expect(draft.validation.ok).toBe(true);
    expect(draft.packet.instruction).toBe('先核对来源版本，再改构建脚本。');
    expect(draft.packet.applicability).toBe('仅限本地仓库');
    expect(draft.packet.exclusions).toBe('不适用于发布流程');
  });

  it('建议文件名带记忆 id 与 revision，便于一眼看出导出的是哪一版', async () => {
    const record = await rememberOne(new FakeVault(), '# 命名\n\n内容。');
    const draft = buildMethodCandidateDraft({ record, now: T0 });
    expect(draft.suggestedName).toContain(record.meta.id);
    expect(draft.suggestedName).toContain(`r${record.meta.revision}`);
    expect(draft.suggestedName.endsWith('.json')).toBe(true);
    // 文件名必须能在 Unix/Windows 上通用：id 里只允许出现安全字符。
    expect(draft.suggestedName).not.toMatch(/[\s/\\:*?"<>|]/);
  });

  it('写出的文件里明确写着「没有发送、没有改动记忆」', async () => {
    const record = await rememberOne(new FakeVault(), '# 说明\n\n内容。');
    const content = renderMethodCandidateFile(buildMethodCandidateDraft({ record, now: T0 }));
    const parsed = JSON.parse(content) as { note: string; validation: { ok: boolean }; packet: unknown };
    expect(parsed.validation.ok).toBe(true);
    expect(parsed.note).toContain('没有连接任何 MSE 实例');
    expect(parsed.note).toContain('没有改动这条记忆');
    expect(parsed.packet).toBeTruthy();
  });

  it('超长正文只带摘要，不把整篇复制进候选包', async () => {
    const long = `# 长文\n\n${'这是一段很长的正文。'.repeat(200)}`;
    const record = await rememberOne(new FakeVault(), long);
    const draft = buildMethodCandidateDraft({ record, now: T0 });
    expect(draft.packet.instruction).toBeTruthy();
    expect(draft.note.length).toBeLessThan(long.length);
    expect(draft.note).toContain('…');
  });

  it('导出**不会**改动记忆本身（状态、revision、正文都不变）', async () => {
    const vault = new FakeVault();
    const record = await rememberOne(vault, '# 不许被改动\n\n原始正文。');
    const snapshot = { revision: record.meta.revision, status: record.meta.status, body: record.body };
    buildMethodCandidateDraft({ record, now: T0 });
    buildMethodCandidateDraft({ record, now: T0 });
    expect(record.meta.revision).toBe(snapshot.revision);
    expect(record.meta.status).toBe(snapshot.status);
    expect(record.body).toBe(snapshot.body);
  });
});

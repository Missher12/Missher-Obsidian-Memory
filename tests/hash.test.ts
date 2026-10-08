/**
 * 审计缺陷 1：SHA-256 padding 边界。
 *
 * 原实现用 `((len + 9) >> 6) + 1` 计算块数，在 `len ≡ 55 (mod 64)` 时块数不足，
 * 长度字段被写进不存在的空间，摘要与标准实现不一致（0/1/54/56/63/64 恰好正常）。
 *
 * 这里的对照物是 Node 的 `createHash('sha256')`——不是我们自己算的期望值，
 * 因此能真正抓住“算法坏了但自测自过”的情况。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, shortHash } from '@mom/core';

function nodeSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('sha256Hex 与 Node createHash 一致', () => {
  it('覆盖 padding 边界长度（55/56/119/120 是关键反例）', () => {
    const lengths = [0, 1, 2, 53, 54, 55, 56, 57, 63, 64, 65, 111, 119, 120, 121, 127, 128, 191, 192, 1000];
    const mismatches: string[] = [];
    for (const length of lengths) {
      const input = 'a'.repeat(length);
      if (sha256Hex(input) !== nodeSha256(input)) mismatches.push(`ASCII len=${length}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('明确复现并锁死历史上的 55 字节回归', () => {
    const input = 'a'.repeat(55);
    // 这是标准 SHA-256 的值；原实现会给出不同结果。
    expect(sha256Hex(input)).toBe('9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318');
    expect(sha256Hex(input)).toBe(nodeSha256(input));
  });

  it('多字节 UTF-8 在边界上仍与标准一致（字节长度而非字符长度决定分块）', () => {
    const inputs = [
      '中'.repeat(18), // 54 字节
      '中'.repeat(19), // 57 字节
      '中'.repeat(39), // 117 字节
      '中'.repeat(40), // 120 字节
      'ā'.repeat(27), // 54 字节
      'ā'.repeat(28), // 56 字节
      '🐟'.repeat(13), // 52 字节
      '🐟'.repeat(14), // 56 字节
      'aé中🐟'.repeat(20),
    ];
    const mismatches: string[] = [];
    for (const input of inputs) {
      if (sha256Hex(input) !== nodeSha256(input)) mismatches.push(JSON.stringify(input.slice(0, 6)));
    }
    expect(mismatches).toEqual([]);
  });

  it('空串与已知向量正确（防止实现整体性错误后仍互相一致）', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('中文')).toBe(nodeSha256('中文'));
  });

  it('shortHash 是完整摘要的前 16 位，不会因截断而错位', () => {
    const input = 'a'.repeat(55);
    expect(shortHash(input)).toBe(nodeSha256(input).slice(0, 16));
  });

  it('含有 NUL 与代理对的输入不会崩溃且与标准一致', () => {
    const inputs = ['a\u0000b', '\u0000'.repeat(64), '𠀀'.repeat(30), String.fromCharCode(0xd800) + 'x'];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(nodeSha256(input));
    }
  });
});

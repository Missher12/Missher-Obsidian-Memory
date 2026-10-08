/**
 * 审计缺陷 2：根目录自身未校验导致目录穿越。
 *
 * 原实现：
 * - `resolveInsideRoot('../outside', 'note.md')` → `'../outside/note.md'`
 * - `isInsideRoot('Second Brain', 'Second Brain/../private.md')` → `true`
 *
 * 两处都是“先归一化、再前缀比较”，于是 `..` 被当成普通字符处理。
 */

import { describe, expect, it } from 'vitest';
import {
  PathError,
  assertNotReserved,
  assertSafeRelativePath,
  assertSafeRoot,
  isInsideRoot,
  isStatePath,
  normalizePath,
  normalizeRoot,
  resolveInsideRoot,
  slugify,
  memoryFileName,
} from '@mom/core';

describe('根目录与路径穿越', () => {
  it('含 .. 的根目录不会产出库外路径（历史反例）', () => {
    expect(() => resolveInsideRoot('../outside', 'note.md', '记忆路径')).toThrow(PathError);
    expect(() => assertSafeRoot('../outside')).toThrow(PathError);
  });

  it('isInsideRoot 拒绝经由 .. 的逃逸（历史反例）', () => {
    expect(isInsideRoot('Second Brain', 'Second Brain/../private.md')).toBe(false);
    expect(isInsideRoot('Second Brain', 'Second Brain/../../etc/passwd')).toBe(false);
    expect(isInsideRoot('Second Brain/notes', 'Second Brain/../private.md')).toBe(false);
  });

  it('正常的包含关系仍然成立', () => {
    expect(isInsideRoot('Second Brain', 'Second Brain')).toBe(true);
    expect(isInsideRoot('Second Brain', 'Second Brain/10-关于我/a.md')).toBe(true);
    expect(isInsideRoot('Second Brain', 'Second Brains/a.md')).toBe(false);
    expect(isInsideRoot('Second Brain', 'Other/a.md')).toBe(false);
  });

  it('拒绝绝对路径、盘符、UNC、家目录写法、空字节', () => {
    const bad = [
      '/etc/passwd',
      'C:/Windows/system32',
      'C:\\Windows\\system32',
      '\\\\server\\share\\x.md',
      '~/notes/a.md',
      'a\u0000b.md',
      '',
      '   ',
      '..',
      '.',
      'a/../../b.md',
      './a.md',
    ];
    for (const candidate of bad) {
      expect(() => assertSafeRelativePath(candidate)).toThrow(PathError);
    }
  });

  it('normalizeRoot 只做回退，assertSafeRoot 才做校验', () => {
    expect(normalizeRoot('')).toBe('Second Brain');
    expect(normalizeRoot(undefined)).toBe('Second Brain');
    expect(normalizeRoot('   ')).toBe('Second Brain');
    expect(normalizeRoot('Brain/Notes')).toBe('Brain/Notes');
    // 归一化本身不抛错，但校验会拒绝。
    expect(normalizeRoot('../outside')).toBe('../outside');
    expect(() => assertSafeRoot('../outside')).toThrow(PathError);
  });

  it('normalizePath 不把 .. 变成安全路径', () => {
    // normalizePath 只做分隔符整理；安全性由分段校验负责。
    expect(normalizePath('a//b/')).toBe('a/b');
    expect(isInsideRoot('a', 'a/./b')).toBe(false);
    expect(isInsideRoot('a', 'a//b')).toBe(true);
  });

  it('resolveInsideRoot 只在根内生成路径', () => {
    expect(resolveInsideRoot('Second Brain', '10-关于我/x.md')).toBe('Second Brain/10-关于我/x.md');
    expect(() => resolveInsideRoot('Second Brain', '../x.md')).toThrow(PathError);
    expect(() => resolveInsideRoot('Second Brain', 'a/../../x.md')).toThrow(PathError);
  });

  it('保留目录与状态目录判定一致', () => {
    expect(() => assertNotReserved('Second Brain/.memory/state.json')).toThrow(PathError);
    expect(() => assertNotReserved('Second Brain/.obsidian/app.json')).toThrow(PathError);
    expect(() => assertNotReserved('Second Brain/normal.md')).not.toThrow();
    expect(isStatePath('Second Brain', 'Second Brain/.memory/state.json')).toBe(true);
    expect(isStatePath('Second Brain', 'Second Brain/10-关于我/x.md')).toBe(false);
    // 经 .. 绕出的“状态目录”不算状态目录。
    expect(isStatePath('Second Brain', 'Second Brain/.memory/../10-关于我/x.md')).toBe(false);
  });

  it('文件名生成保持稳定且不含路径分隔符', () => {
    const name = memoryFileName('mem_0123456789abcdef', '项目 A/B 的决定: 用 TS');
    expect(name.startsWith('01234567-')).toBe(true);
    expect(name.endsWith('.md')).toBe(true);
    expect(name.includes('/')).toBe(false);
    expect(name.includes(':')).toBe(false);
    expect(slugify('  a   b  ')).toBe('a-b');
    expect(slugify('中文 标题')).toBe('中文-标题');
  });

  it('MemoryStore 构造时用不安全根目录会直接失败，而不是带病运行', async () => {
    const { MemoryStore, MemoryFileStore, sha256Hex } = await import('@mom/core');
    const store = new MemoryFileStore({ hash: sha256Hex });
    for (const badRoot of ['../outside', '/abs', 'a/../b']) {
      expect(() => new MemoryStore({ store, root: badRoot })).toThrow(PathError);
    }
    expect(() => new MemoryStore({ store, root: 'Second Brain' })).not.toThrow();
  });
});

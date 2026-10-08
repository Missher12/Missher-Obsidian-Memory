#!/usr/bin/env node
/**
 * 清理构建与打包产物。
 *
 *   node scripts/clean.mjs            # 只删构建产物（dist、各包的 dist、tsbuildinfo）
 *   node scripts/clean.mjs --all      # 连 node_modules 一起删（需要重新 pnpm install）
 *
 * 为什么单独写一个脚本而不是直接 rm -rf：
 *
 * 1. 删除是不可逆的，所以**每一步都要先打印将被删除的绝对路径**，
 *    并且只在本仓库内部操作——路径必须落在仓库根目录之下，否则直接拒绝。
 * 2. 明确列出**不删什么**：源码、测试、文档、
 *    以及用户自己的 Vault（本仓库根本不知道它在哪，也永远不会去碰）。
 */

import { rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanAll = process.argv.includes('--all');

/**
 * 只允许删除仓库内的路径。
 *
 * 这是防呆而不是防恶意：一个拼错的相对路径（`../..`）就足以删掉别的东西。
 * 因此这里做的是**解析后的前缀检查**，不是字符串前缀检查。
 */
function assertInsideRepo(target) {
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`拒绝删除仓库之外的路径：${resolved}`);
  }
  return resolved;
}

async function describe(target) {
  if (!existsSync(target)) return null;
  const info = await stat(target);
  if (!info.isDirectory()) return `${(info.size / 1024).toFixed(1)} KiB`;
  const entries = await readdir(target);
  return `${entries.length} 个条目`;
}

async function remove(target, label) {
  const resolved = assertInsideRepo(target);
  const summary = await describe(resolved);
  if (summary === null) {
    process.stdout.write(`· 跳过（不存在）：${path.relative(root, resolved)}\n`);
    return;
  }
  process.stdout.write(`- 删除 ${label}：${path.relative(root, resolved)}（${summary}）\n`);
  await rm(resolved, { recursive: true, force: true });
}

async function main() {
  process.stdout.write(`清理仓库：${root}\n`);
  if (cleanAll) {
    process.stdout.write('模式：--all（连 node_modules 一起删，之后需要重新 pnpm install）\n');
  }

  /* ---------- 构建产物 ---------- */
  await remove(path.join(root, 'dist'), '打包与插件产物');
  for (const name of ['core', 'cli']) {
    await remove(path.join(root, 'packages', name, 'dist'), `@mom/${name} 构建产物`);
  }

  /* ---------- TypeScript 增量信息 ---------- */
  await remove(path.join(root, 'tsconfig.tsbuildinfo'), 'TS 增量信息');
  await remove(path.join(root, 'tsconfig.build.tsbuildinfo'), 'TS 增量信息');
  for (const name of ['core', 'plugin', 'cli']) {
    await remove(path.join(root, 'packages', name, 'tsconfig.tsbuildinfo'), `@mom/${name} 增量信息`);
  }

  /* ---------- 依赖（可选） ---------- */
  if (cleanAll) {
    await remove(path.join(root, 'node_modules'), '依赖');
    for (const name of ['core', 'plugin', 'cli']) {
      await remove(path.join(root, 'packages', name, 'node_modules'), `@mom/${name} 依赖`);
    }
  }

  process.stdout.write(
    [
      '',
      '明确没有删除：',
      '  · 源码（packages/*/src）与测试（tests/）',
      '  · 文档与交接记录（README.md、docs/、HANDOVER.md、PROJECT_CONTEXT.md）',
      '  · 你的 Obsidian 库：本仓库不知道它在哪里，也永远不会去动它',
      '  · 你在 <记忆根>/.memory/ 下的请求与回执：那是你的数据，不是构建产物',
      '',
      cleanAll ? '下一步：pnpm install && pnpm run build' : '下一步：pnpm run build',
      '',
    ].join('\n'),
  );
}

await main();

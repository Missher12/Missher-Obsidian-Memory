#!/usr/bin/env node
/**
 * 合成 Vault 上的**真实插件处理**驱动。
 *
 * 验收外部排队闭环时，最诚实的做法不是「再用核心跑一遍」，
 * 而是把**插件真正用的那几个模块**（VaultFileStore / QueueService / commit-handler）
 * 在合成桩上跑起来。这里负责把 TypeScript 现场打成一个可执行模块：
 *
 *   1. 用 esbuild 打包 `packages/plugin/src/{vault-store,queue-service,commit-handler}.ts`；
 *   2. `obsidian` 指到 `tests/obsidian-runtime-stub.ts`（内存 Vault 实现）；
 *   3. 由 `scripts/e2e-cli.mjs` 起子进程调用导出的 `buildSyntheticVault()`。
 *
 * 这样端到端脚本不需要安装 Obsidian，也不需要读任何真实库。
 */

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPluginCommitHarness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mom-plugin-commit-'));
  const outfile = path.join(dir, 'harness.mjs');
  await build({
    entryPoints: [path.join(root, 'scripts', 'plugin-commit-entry.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // obsidian 用合成桩替换：与单元测试用的是同一个，避免两套行为。
    // obsidian 指到端到端专用的运行时桩（真实文件系统版，见该文件头部说明）。
    alias: { obsidian: path.join(root, 'scripts', 'obsidian-runtime-stub.ts') },
    logLevel: 'silent',
  });
  return {
    moduleUrl: pathToFileURL(outfile).href,
    /** 用完删掉临时打包目录（不留在系统临时目录里）。 */
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { moduleUrl, dispose } = await buildPluginCommitHarness();
  process.stdout.write(`打包完成：${moduleUrl}\n`);
  if (!process.argv.includes('--keep')) await dispose();
}

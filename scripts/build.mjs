#!/usr/bin/env node
/**
 * 构建脚本：产出可安装的 Obsidian 插件与可运行的外部适配器。
 *
 *   node scripts/build.mjs [all|core|plugin|cli|mcp]
 *
 * 为什么要打包而不是直接发 .ts：
 * - Obsidian 只加载 `main.js`（CommonJS，一个文件），不会编译 TypeScript；
 * - 外部 CLI/MCP 需要**不需要装依赖**就能跑，所以把 @mom/core 一起打进去。
 *
 * 三条硬规则写在这里，而不是靠人记得：
 * 1. 插件产物**不得**引用 node 内置模块或任意 fs——插件只能用 Vault API；
 *    一旦有人在插件里 import 'node:fs'，构建会直接失败。
 * 2. 核心（@mom/core）不得依赖 obsidian 或 node 内置模块。
 * 3. 测试辅助代码（stub 等）不得进入产物。
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = (process.argv[2] ?? 'all').toLowerCase();
const VERSION = '0.1.0';
const PLUGIN_ID = 'missher-obsidian-memory';

const banner = (name) =>
  `/*! ${name} v${VERSION} — Missher Obsidian Memory\n` +
  ` *  独立第二大脑与 AI 记忆插件。核心不依赖 Obsidian / Node / MSE。\n` +
  ` *  本文件由 scripts/build.mjs 生成，请勿手工编辑。\n` +
  ` */`;

/** 插件里出现这些引用就是设计越界，构建必须失败。 */
const FORBIDDEN_IN_PLUGIN = [
  { pattern: /require\(["']node:/, message: '插件产物引用了 node 内置模块' },
  { pattern: /from\s*["']node:(fs|path|child_process|net|http|https)["']/, message: '插件源码引用了 node 内置模块' },
];

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/** 读取产物并做越界检查。 */
async function assertNoForbidden(file, rules) {
  const code = await readFile(file, 'utf8');
  for (const rule of rules) {
    if (rule.pattern.test(code)) {
      throw new Error(`构建被拒绝：${path.relative(root, file)} ${rule.message}。`);
    }
  }
  return code;
}

async function sha256(file) {
  const content = await readFile(file);
  return createHash('sha256').update(content).digest('hex');
}

async function buildCore() {
  // 核心也要产出产物：外部使用者可以只依赖核心做独立评估。
  const out = path.join(root, 'packages/core/dist/index.js');
  await ensureDir(path.dirname(out));
  await build({
    entryPoints: [path.join(root, 'packages/core/src/index.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    sourcemap: false,
    banner: { js: banner('@mom/core') },
    external: [],
  });
  const code = await readFile(out, 'utf8');
  if (/from\s*["']obsidian["']/.test(code)) throw new Error('核心产物引用了 obsidian——核心必须与 Obsidian 无关。');
  if (/require\(["']node:/.test(code)) throw new Error('核心产物引用了 node 内置模块——核心必须是纯逻辑。');
  console.log(`✓ core    packages/core/dist/index.js  ${(code.length / 1024).toFixed(1)} KiB`);
  return { file: out, bytes: code.length };
}

async function buildPlugin() {
  const outDir = path.join(root, 'dist', PLUGIN_ID);
  await ensureDir(outDir);
  const main = path.join(outDir, 'main.js');
  await build({
    entryPoints: [path.join(root, 'packages/plugin/src/plugin.ts')],
    outfile: main,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    // obsidian 由宿主提供，不能打进产物。
    external: ['obsidian', 'electron'],
    banner: { js: banner('Missher Obsidian Memory') },
  });
  await assertNoForbidden(main, FORBIDDEN_IN_PLUGIN);

  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(
      {
        id: PLUGIN_ID,
        name: 'Missher Obsidian Memory',
        version: VERSION,
        minAppVersion: '1.5.0',
        description: '独立第二大脑与 AI 记忆：本地优先的记忆库、AI 提取、带来源问答与复盘补丁。',
        author: 'Missher',
        /**
         * 桌面专用。
         *
         * 插件本身不导入 Node，但它的 AI 凭据走 `secretStorage`（移动端没有），
         * 而移动端**从未验收过**。标成 false 会让移动用户在插件市场里
         * 装上一个没测过的包——那是拿用户的库在赌。
         */
        isDesktopOnly: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(path.join(outDir, 'styles.css'), await buildStyles(), 'utf8');
  const bytes = (await readFile(main)).length;
  console.log(`✓ plugin  dist/${PLUGIN_ID}/{main.js,manifest.json,styles.css}  ${(bytes / 1024).toFixed(1)} KiB`);
  return { dir: outDir, bytes };
}

/** 样式也从源码目录复制，保证「仓库里看到的」就是「安装后得到的」。 */
async function buildStyles() {
  const css = path.join(root, 'packages/plugin/styles.css');
  if (existsSync(css)) return readFile(css, 'utf8');
  return '/* 无额外样式：界面全部使用 Obsidian 内置类名。 */\n';
}

async function buildCli() {
  const outDir = path.join(root, 'packages/cli/dist');
  await ensureDir(outDir);
  await build({
    entryPoints: [path.join(root, 'packages/cli/src/cli.ts')],
    outfile: path.join(outDir, 'cli.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // 源码里已经写了 shebang；banner 只放说明，避免出现两行 shebang。
    banner: { js: banner('mom-memory CLI') },
  });
  const bytes = (await readFile(path.join(outDir, 'cli.js'))).length;
  console.log(`✓ cli     packages/cli/dist/cli.js  ${(bytes / 1024).toFixed(1)} KiB`);
  return { file: path.join(outDir, 'cli.js'), bytes };
}

async function buildMcp() {
  /**
   * MCP 适配器与 CLI 放在同一个包里（`packages/cli`）。
   *
   * 这样解压发布包之后就只有两个自带依赖的可执行文件，而不是
   * 「要先把另一个 workspace 包也解出来」——外部使用者不该被 monorepo 结构绑架。
   */
  const entry = path.join(root, 'packages/cli/src/mcp.ts');
  if (!existsSync(entry)) throw new Error('缺少 packages/cli/src/mcp.ts。');
  const outDir = path.join(root, 'packages/cli/dist');
  await ensureDir(outDir);
  await build({
    entryPoints: [entry],
    outfile: path.join(outDir, 'mcp.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    banner: { js: banner('mom-memory MCP') },
  });
  const bytes = (await readFile(path.join(outDir, 'mcp.js'))).length;
  console.log(`✓ mcp     packages/cli/dist/mcp.js  ${(bytes / 1024).toFixed(1)} KiB`);
  return { file: path.join(outDir, 'mcp.js'), bytes };
}

async function main() {
  const started = Date.now();
  const done = {};
  if (target === 'all' || target === 'core') done.core = await buildCore();
  if (target === 'all' || target === 'plugin') done.plugin = await buildPlugin();
  if (target === 'all' || target === 'cli') done.cli = await buildCli();
  if (target === 'all' || target === 'mcp') done.mcp = await buildMcp();

  // 冻结产物的哈希：发布、校验与「我装的是不是同一个包」都要靠它。
  if (target === 'all') {
    const sums = [];
    for (const rel of [
      `dist/${PLUGIN_ID}/main.js`,
      `dist/${PLUGIN_ID}/manifest.json`,
      `dist/${PLUGIN_ID}/styles.css`,
    ]) {
      sums.push(`${await sha256(path.join(root, rel))}  ${rel}`);
    }
    await writeFile(path.join(root, 'dist', 'SHA256SUMS'), `${sums.join('\n')}\n`, 'utf8');
    console.log('✓ sums    dist/SHA256SUMS');
  }
  console.log(`构建完成（${((Date.now() - started) / 1000).toFixed(1)}s）：${Object.keys(done).join(', ')}`);
}

main().catch(async (error) => {
  console.error(`构建失败：${error instanceof Error ? error.message : String(error)}`);
  // 失败时不要留下半截产物，否则「有 dist 目录」会被误当成构建成功。
  await rm(path.join(root, 'dist'), { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
});

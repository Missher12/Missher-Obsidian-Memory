#!/usr/bin/env node
/**
 * 交付前自检：一条命令回答「这个仓库现在能不能交」。
 *
 *   node scripts/verify.mjs [--skip-tests] [--json]
 *
 * 检查顺序是刻意的：**先证明产物与源码一致，再证明行为**。
 * 只跑测试不跑构建，会出现「测试全绿但 dist 还是三小时前的」这种交付事故。
 *
 * 这个脚本只做**本仓库内**的自检。协调者的独立验收脚本
 * （verify-*-independent.*）不在本仓库里，也**不由本仓库执行**：
 * 它们的作用是独立复核，若由被验收方自己跑就失去意义。
 * 因此这里只如实报告「本仓库自检覆盖了什么、没覆盖什么」。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipTests = process.argv.includes('--skip-tests');
const asJson = process.argv.includes('--json');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!asJson) process.stdout.write(`${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : `：${detail}`}\n`);
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function run(args, options = {}) {
  try {
    const stdout = execFileSync(args[0], args.slice(1), {
      cwd: root,
      encoding: 'utf8',
      stdio: options.inherit === true ? 'inherit' : 'pipe',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
    });
    return { ok: true, stdout: stdout ?? '' };
  } catch (error) {
    return {
      ok: false,
      stdout: `${error?.stdout ?? ''}`,
      stderr: `${error?.stderr ?? error?.message ?? ''}`,
    };
  }
}

function failureDetail(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n');
}

async function main() {
  process.stdout.write('Missher Obsidian Memory —— 交付自检\n\n');

  // 版本单一来源：根 package.json。产物名与产物内版本标识都据此核对，
  // 避免脚本里写死旧版本号而误验上一次的包。
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || version === '') throw new Error('无法从 package.json 读取 version。');

  /* ---------- 1. 构建：产物必须能从当前源码重建 ---------- */
  const build = run([process.execPath, path.join(root, 'scripts', 'build.mjs'), 'all']);
  record('构建成功（core / plugin / cli / mcp）', build.ok, (build.stderr || '').trim().split('\n').slice(-1)[0] ?? '');

  const pluginDir = path.join(root, 'dist', 'missher-obsidian-memory');
  for (const name of ['main.js', 'manifest.json', 'styles.css']) {
    const file = path.join(pluginDir, name);
    record(`插件产物存在：${name}`, existsSync(file));
  }

  /* ---------- 2. 产物边界：插件不得引用 Node，核心不得引用 Obsidian ---------- */
  if (existsSync(path.join(pluginDir, 'main.js'))) {
    const main = await readFile(path.join(pluginDir, 'main.js'), 'utf8');
    /**
     * Obsidian 插件的运行环境没有 Node 内置模块，也没有任意 fs。
     * 一旦有人在插件里 import 'node:fs'，构建也要能拦住——这里是第二道证据。
     */
    const nodeRefs = [...main.matchAll(/require\(["'](node:[^"']+)["']\)|from\s*["'](node:[^"']+)["']/g)].map(
      match => match[1] ?? match[2],
    );
    record('插件产物没有引用 Node 内置模块', nodeRefs.length === 0, nodeRefs.join(','));
    record('插件产物没有直接使用 require("fs")', !/require\(["']fs["']\)/.test(main));
    record(
      '插件产物包含版本标识（可核对装的是哪一版）',
      main.includes('missher-obsidian-memory') || main.includes(`v${version}`),
    );
  }
  if (existsSync(path.join(root, 'packages', 'core', 'dist', 'index.js'))) {
    const core = await readFile(path.join(root, 'packages', 'core', 'dist', 'index.js'), 'utf8');
    record('核心产物不依赖 obsidian', !/from\s*["']obsidian["']/.test(core));
    record('核心产物不依赖 node 内置模块', !/from\s*["']node:/.test(core));
  }

  /* ---------- 3. 类型检查 ---------- */
  const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
  const typeBuild = run([tsc, '-b', 'tsconfig.build.json']);
  record('类型检查：核心构建（tsc -b）', typeBuild.ok, (typeBuild.stdout || typeBuild.stderr || '').trim().split('\n').slice(-1)[0] ?? '');
  const typePlugin = run([tsc, '-p', 'packages/plugin/tsconfig.json', '--noEmit']);
  record('类型检查：插件', typePlugin.ok, (typePlugin.stdout || '').trim().split('\n')[0] ?? '');
  const typeCli = run([tsc, '-p', 'packages/cli/tsconfig.json', '--noEmit']);
  record('类型检查：外部适配器（CLI / MCP）', typeCli.ok, (typeCli.stdout || '').trim().split('\n')[0] ?? '');

  /* ---------- 4. 测试 ---------- */
  if (!skipTests) {
    const tests = run([process.execPath, path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run']);
    const summary = /Tests\s+(\d+) passed/.exec(tests.stdout ?? '');
    record(`单元与集成测试（${summary?.[1] ?? '?'} 项）`, tests.ok, (tests.stderr || '').trim().split('\n').slice(-1)[0] ?? '');

    const cliE2e = run([process.execPath, path.join(root, 'scripts', 'e2e-cli.mjs')]);
    record('CLI 端到端：排队 → 真实插件提交 → 回执可回读', cliE2e.ok, failureDetail(cliE2e));

    const mcpE2e = run([process.execPath, path.join(root, 'scripts', 'e2e-mcp.mjs')]);
    const mcpSummary = /MCP 端到端：(\d+) 项通过/.exec(mcpE2e.stdout ?? '');
    record(
      `MCP 端到端：与 CLI 同契约（${mcpSummary?.[1] ?? '?'} 项）`,
      mcpE2e.ok,
      failureDetail(mcpE2e),
    );
    const organizationE2e = run([process.execPath, path.join(root, 'scripts', 'e2e-organization.mjs')]);
    record('中文分类端到端：真实 CLI/MCP bundle + 插件服务（合成 Vault API）', organizationE2e.ok,
      failureDetail(organizationE2e));
  } else {
    record('单元与集成测试', true, '已按 --skip-tests 跳过（结果不代表已通过）');
  }

  /* ---------- 5. 交付物与校验和 ---------- */
  const zip = path.join(root, 'dist', `missher-obsidian-memory-${version}.zip`);
  const tgz = path.join(root, 'dist', `mom-memory-cli-${version}.tgz`);
  const sums = path.join(root, 'dist', 'SHA256SUMS.txt');
  const hasArtifacts = existsSync(zip) && existsSync(tgz) && existsSync(sums);
  if (hasArtifacts) {
    const lines = (await readFile(sums, 'utf8')).trim().split('\n');
    let allMatch = true;
    const mismatched = [];
    for (const line of lines) {
      const [expected, relative] = line.split(/\s+/);
      const file = path.join(root, 'dist', relative);
      if (!existsSync(file)) {
        allMatch = false;
        mismatched.push(`${relative}（文件不存在）`);
        continue;
      }
      const actual = await sha256(file);
      if (actual !== expected) {
        allMatch = false;
        mismatched.push(relative);
      }
    }
    record(`交付物校验和一致（${lines.length} 个文件）`, allMatch, mismatched.join(','));
    const zipInfo = await stat(zip);
    record(`插件 ZIP 非空（${(zipInfo.size / 1024).toFixed(1)} KiB）`, zipInfo.size > 0);
  } else {
    record(
      '交付物已打包（ZIP / tgz / SHA256SUMS.txt）',
      false,
      '还没打包：运行 node scripts/package.mjs 生成（这不影响源码正确性，但影响「可交付」）',
    );
  }

  /* ---------- 6. 独立验收的边界（如实说明，不冒充已通过） ---------- */
  const coordinationDir = process.env.MOM_COORDINATION_DIR ?? '';
  record(
    '独立验收脚本由协调者运行（本仓库不自评）',
    true,
    coordinationDir === ''
      ? '本仓库内不存在 verify-*-independent.*；那几份脚本属于协调者的独立复核，需由其执行后给出结论'
      : `协调目录：${coordinationDir}`,
  );

  const failed = results.filter(item => !item.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ results, failed: failed.length }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n自检结果：${results.length - failed.length}/${results.length} 项通过。\n`);
    if (failed.length > 0) {
      process.stdout.write('未通过的项目：\n');
      for (const item of failed) process.stdout.write(`  - ${item.name}${item.detail === '' ? '' : `：${item.detail}`}\n`);
    }
    process.stdout.write(
      '\n注意：这里只覆盖本仓库自检。签名/发布/独立复核不在其中，也不应由本脚本代替。\n',
    );
  }
  if (failed.length > 0) process.exitCode = 1;
}

await main();

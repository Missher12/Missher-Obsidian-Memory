#!/usr/bin/env node
/**
 * 打包：产出**可以直接安装/解压就运行**的交付物。
 *
 *   node scripts/package.mjs [--out <目录>] [--allow-dirty]
 *
 * 产出的三样东西，对应三类使用者：
 *
 * 1. `dist/missher-obsidian-memory/` —— 解压到 `<Vault>/.obsidian/plugins/` 的插件目录；
 *    `missher-obsidian-memory-<version>.zip` 是同一个目录的压缩包。
 * 2. `dist/mom-memory-cli-<version>.tgz` —— 独立 CLI：解压后 `node cli.js` 就能用，
 *    **不依赖本仓库、不需要 pnpm install**（核心已经打进去）。
 * 3. `dist/SHA256SUMS.txt` —— 上面每个文件的校验和，供使用者自己核对。
 *
 * 明确不做的事：不发布、不推送、不登录任何账号、不改任何全局配置。
 * 这个脚本只碰本仓库的 `dist/`。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const outDir = path.resolve(root, argValue('--out', 'dist'));

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * 把目录（含子目录）里所有条目的 mtime 钉到固定时刻。
 *
 * 压缩包会记录条目 mtime：不钉死的话，同样的输入每次打包出的 SHA-256 都不同，
 * 发布校验和对不上，也没法证明「冻结的是同一份东西」。
 * 只改时间戳，不改任何文件内容。
 */
const FIXED_MTIME = '198001010000';
async function normalizeTimestamps(dir) {
  execFileSync('find', [dir, '-exec', 'touch', '-t', FIXED_MTIME, '{}', '+']);
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(absolute, base)));
    else out.push(path.relative(base, absolute));
  }
  return out.sort();
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : `：${detail}`}\n`);
}

async function main() {
  const pkg = await readJson(path.join(root, 'package.json'));
  const version = pkg.version;
  const pluginId = 'missher-obsidian-memory';
  const pluginDir = path.join(outDir, pluginId);

  process.stdout.write(`打包 missher-obsidian-memory v${version}\n`);

  /* ---------- 0. 产物必须是最新的：先跑一次构建 ---------- */
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), 'all'], { cwd: root, stdio: 'inherit' });

  /* ---------- 1. 插件目录的三个文件 ---------- */
  const required = ['main.js', 'manifest.json', 'styles.css'];
  for (const name of required) {
    const file = path.join(pluginDir, name);
    if (!existsSync(file)) {
      check(`插件产物包含 ${name}`, false, `缺少 ${file}`);
      continue;
    }
    const info = await stat(file);
    check(`插件产物包含 ${name}（${(info.size / 1024).toFixed(1)} KiB）`, info.size > 0);
  }
  if (checks.some(item => !item.ok)) {
    process.stdout.write('打包中止：插件产物不完整。\n');
    process.exitCode = 1;
    return;
  }

  /**
   * 插件产物里**不得**出现源码或测试辅助文件。
   * Obsidian 只加载 main.js；把别的东西塞进去会让使用者以为它们是插件的一部分。
   */
  const pluginFiles = await listFiles(pluginDir);
  check(
    '插件目录只有预期的三个文件',
    pluginFiles.length === 3 && pluginFiles.every(name => required.includes(name)),
    pluginFiles.join(','),
  );

  /* ---------- 2. 插件 ZIP ---------- */
  const pluginZip = path.join(outDir, `${pluginId}-${version}.zip`);
  await rm(pluginZip, { force: true });
  /**
   * 用系统 `zip` 而不是自己写压缩：Windows/macOS/Linux 都能解，
   * 而且 `-X` 不写额外的元数据，产物可复现。
   *
   * 「可复现」还得**把时间戳钉死**：压缩包会记录每个条目的 mtime，
   * 否则同样的输入每次打包出来的 SHA-256 都不一样——发布时就没法核对校验和了。
   * 这里统一钉到 1980-01-01（ZIP 时间戳的起点），核心三个文件的字节不变，只是时间归零。
   */
  await normalizeTimestamps(path.join(outDir, pluginId));
  execFileSync('zip', ['-r', '-X', '-q', pluginZip, pluginId], { cwd: outDir });
  check(`插件 ZIP 已生成（${path.basename(pluginZip)}）`, existsSync(pluginZip));

  /* ---------- 3. 独立 CLI 包 ---------- */
  const cliStage = path.join(outDir, 'mom-memory-cli');
  await rm(cliStage, { recursive: true, force: true });
  await ensureDir(path.join(cliStage, 'lib'));
  await copyFile(path.join(root, 'packages', 'cli', 'dist', 'cli.js'), path.join(cliStage, 'lib', 'cli.js'));
  await copyFile(path.join(root, 'packages', 'cli', 'dist', 'mcp.js'), path.join(cliStage, 'lib', 'mcp.js'));
  const cliPackage = {
    name: 'mom-memory-cli',
    version,
    private: true,
    type: 'module',
    description: 'Missher Obsidian Memory 的独立命令行与 MCP 入口（已内嵌核心，无外部依赖）',
    bin: { 'mom-memory': 'lib/cli.js', 'mom-memory-mcp': 'lib/mcp.js' },
    engines: { node: '>=22.13' },
  };
  await writeFile(path.join(cliStage, 'package.json'), `${JSON.stringify(cliPackage, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(cliStage, 'README.txt'),
    [
      'Missher Obsidian Memory —— 独立命令行 / MCP 入口',
      '',
      '这个目录不依赖仓库，也不需要 pnpm install：核心已经打进 lib/ 里。',
      '',
      '  看帮助：        node lib/cli.js help',
      '  看队列状态：    node lib/cli.js queue-status --vault /path/to/Vault',
      '  排队一条记忆：  node lib/cli.js remember --vault /path/to/Vault --text "要记住的事"',
      '  起 MCP 服务：   node lib/mcp.js --vault /path/to/Vault',
      '',
      '重要：外部入口**默认只排队**，真正的写入由 Obsidian 插件完成。',
      '"已排队"不等于"已提交"，回执在 <记忆根>/.memory/receipts/ 下。',
      '',
      `版本：${version}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const cliTgz = path.join(outDir, `mom-memory-cli-${version}.tgz`);
  await rm(cliTgz, { force: true });
  /**
   * 同样钉死时间与属主：否则同一个 `lib/cli.js` 每次打出来的 tgz 哈希都不同。
   *
   * 时间不靠 `--mtime`——macOS 自带的是 bsdtar，不认这个选项，也不认 `--sort=name`。
   * 改成先把暂存目录里所有文件的 mtime 归零，归档器就写不出差异；
   * gzip 头由 `GZIP=-n` 去掉时间戳。`--no-mac-metadata` 只有 bsdtar 有，
   * GNU tar 会拒绝，因此单独重试一次。
   */
  await normalizeTimestamps(cliStage);
  /**
   * 压缩这一步**不用 `tar -z`**：bsdtar 内建的 gzip 会往头里写时间戳，
   * 而且不受 `GZIP=-n` 影响（实测同一个 tar 流每次 gzip 头都差一个字节，
   * 正好落在 gzip mtime 字段上）。改成先吐未压缩 tar、再交给 `gzip -n`，
   * `-n` 明确要求不写时间戳与原始文件名。
   */
  const tarArgs = ['--numeric-owner', '--uid', '0', '--gid', '0', '-cf', '-', '-C', outDir, 'mom-memory-cli'];
  const quotedTar = (extra = []) => [`tar`, [...extra, ...tarArgs].map(arg => `'${arg}'`).join(' ')];
  let tarCommand;
  try {
    execFileSync('tar', ['--no-mac-metadata', ...tarArgs], { stdio: ['ignore', 'pipe', 'ignore'] });
    tarCommand = quotedTar(['--no-mac-metadata']);
  } catch {
    tarCommand = quotedTar();
  }
  execFileSync('/bin/sh', ['-c', `${tarCommand.join(' ')} | gzip -n > '${cliTgz}'`]);

  /**
   * 解压后**必须能跑**：这一条是「独立包」这个承诺的证据。
   * 在临时目录里解压、跑 `help`，确认没有 monorepo 依赖。
   */
  const probe = path.join(outDir, '.package-probe');
  await rm(probe, { recursive: true, force: true });
  await ensureDir(probe);
  execFileSync('tar', ['-xzf', cliTgz, '-C', probe]);
  const helpOut = execFileSync(process.execPath, [path.join(probe, 'mom-memory-cli', 'lib', 'cli.js'), 'help'], {
    encoding: 'utf8',
  });
  check('解压后的独立 CLI 能直接运行（不依赖仓库）', helpOut.includes('mom-memory'), helpOut.split('\n')[0] ?? '');
  await rm(probe, { recursive: true, force: true });

  /* ---------- 4. 校验和 ---------- */
  const delivered = [pluginZip, cliTgz];
  for (const name of required) delivered.push(path.join(pluginDir, name));
  const lines = [];
  for (const file of delivered) {
    lines.push(`${await sha256(file)}  ${path.relative(outDir, file)}`);
  }
  const sumsFile = path.join(outDir, 'SHA256SUMS.txt');
  await writeFile(sumsFile, `${lines.join('\n')}\n`, 'utf8');
  check('校验文件 SHA256SUMS.txt 已生成', existsSync(sumsFile));

  process.stdout.write(`\n交付物（都在 ${path.relative(root, outDir)}/）：\n`);
  for (const line of lines) process.stdout.write(`  ${line}\n`);

  const failed = checks.filter(item => !item.ok);
  process.stdout.write(`\n打包完成：${checks.length - failed.length}/${checks.length} 项检查通过。\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();

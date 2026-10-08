#!/usr/bin/env node
/**
 * CLI 端到端验收：用真的命令行进程跑一遍「排队 → 回执 → 提交」闭环。
 *
 *   node scripts/e2e-cli.mjs
 *
 * 关键点：**插件那一侧用真实的插件代码**（`packages/plugin/src/commit-handler.ts`
 * + `queue-service.ts` + `vault-store.ts`），只把 Obsidian 的 API 换成合成桩。
 * 这样才叫闭环：外部进程排队、插件提交、回执回读，三方都是真代码。
 *
 * 全程在仓库外的临时合成库中进行，不碰任何真实 Vault。
 */

import { spawn } from 'node:child_process';
import { buildPluginCommitHarness } from './plugin-commit-harness.mjs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages/cli/dist/cli.js');
const failures = [];
const passes = [];

/**
 * 递归列举目录下的 Markdown 文件（相对路径），可排除管理目录。
 */
async function listMarkdown(dir, options = {}) {
  const skip = new Set(options.skip ?? []);
  const out = [];
  const walk = async current => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith('.md')) out.push(path.relative(dir, absolute));
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out.sort();
}

function check(name, condition, detail = '') {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail === '' ? '' : `：${detail}`}`);
}

/** 跑一条 CLI 命令，返回退出码与输出。 */
function run(args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

/** 从 CLI 的 JSON 输出里取对象（拿不到就抛，避免静默通过）。 */
function jsonOf(stdout, label) {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`${label} 没有输出 JSON：${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start));
}

/** 从 CLI 的 JSON 输出里取数组；空数组是合法结果，因此允许 `[]`。 */
function jsonArrayOf(stdout, label) {
  const objectStart = stdout.indexOf('{');
  const arrayStart = stdout.indexOf('[');
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
    return JSON.parse(stdout.slice(arrayStart, stdout.lastIndexOf(']') + 1));
  }
  if (objectStart >= 0) {
    // 有些命令会把数组包在对象里（例如 { receipts: [...] }）。
    const parsed = JSON.parse(stdout.slice(objectStart));
    if (Array.isArray(parsed)) return parsed;
    for (const value of Object.values(parsed)) if (Array.isArray(value)) return value;
    throw new Error(`${label} 的 JSON 里没有数组：${stdout.slice(0, 200)}`);
  }
  throw new Error(`${label} 没有输出数组（也没有 JSON）：${stdout.slice(0, 200)}`);
}

async function main() {
  if (!existsSync(cli)) {
    console.error('缺少 packages/cli/dist/cli.js，请先运行 node scripts/build.mjs cli。');
    process.exit(1);
  }
  const vault = await mkdtemp(path.join(os.tmpdir(), 'mom-cli-e2e-'));
  const memoryRoot = 'Second Brain';
  try {
    /* ---------- 1. 参数与边界 ---------- */
    const noVault = await run(['queue-status']);
    /**
     * CLI 的错误信息走 **stderr**（stdout 只用于数据输出，便于管道）。
     * 断言必须两处都看：修复前这里只检查 stdout，
     * 于是「错误信息其实好好地打出来了」却报成失败。
     */
    check(
      '缺少 --vault 时明确拒绝（不猜用户库）',
      noVault.code === 2 && `${noVault.stdout}${noVault.stderr}`.includes('--vault'),
      `${noVault.code} / ${noVault.stderr.trim()}`,
    );

    const badVault = await run(['queue-status', '--vault', path.join(vault, '不存在的库')]);
    check('库不存在时明确报错', badVault.code === 2, String(badVault.code));

    const emptyStatus = await run(['queue-status', '--vault', vault, '--json', 'true']);
    const emptyQueue = jsonOf(emptyStatus.stdout, 'queue-status');
    check('空库队列为 0', emptyQueue.pending === 0, JSON.stringify(emptyQueue));

    /* ---------- 2. 写命令默认只排队 ---------- */
    const remember = await run([
      'remember',
      '--vault',
      vault,
      '--json',
      'true',
      '--text',
      '端到端验证：写命令默认只排队，由 Obsidian 插件提交。',
      '--title',
      '端到端',
    ]);
    const queued = jsonOf(remember.stdout, 'remember');
    check('remember 默认只排队（accepted）', queued.accepted === true && queued.status === 'queued', JSON.stringify(queued));
    check('排队结果里说明「已排队 ≠ 已提交」', String(queued.note ?? '').includes('不是已提交'), String(queued.note));

    const requestDir = path.join(vault, memoryRoot, '.memory', 'requests');
    const queuedFiles = await readdir(requestDir);
    check('请求文件真的落在 .memory/requests/', queuedFiles.includes(`${queued.requestId}.md`), queuedFiles.join(','));

    const memoryEntries = await readdir(path.join(vault, memoryRoot));
    check('排队没有直接写笔记', !memoryEntries.some(name => name.endsWith('.md')), memoryEntries.join(','));

    // 幂等：同一条命令再跑一次，不重复落盘。
    const again = jsonOf((await run(['remember', '--vault', vault, '--json', 'true', '--text', '端到端验证：写命令默认只排队，由 Obsidian 插件提交。', '--title', '端到端'])).stdout, 'remember#2');
    check('重复排队被识别为重复（不重复落盘）', again.duplicate === true, JSON.stringify(again));
    check('重复排队没有新增文件', (await readdir(requestDir)).length === 1);

    /* ---------- 3. 回执：还没处理时说清楚 ---------- */
    const wait = jsonOf(
      (await run(['wait-receipt', queued.requestId, '--vault', vault, '--json', 'true', '--wait-timeout', '1'])).stdout,
      'wait-receipt',
    );
    check('超时不算失败：状态仍是排队', wait.status === 'waiting' || wait.status === 'queued', JSON.stringify(wait.status));

    const receiptsBefore = jsonArrayOf((await run(['receipts', '--vault', vault, '--json', 'true'])).stdout, 'receipts');
    check('还没处理时没有任何回执（不编造）', receiptsBefore.length === 0, JSON.stringify(receiptsBefore));

    /* ---------- 4. 真实插件提交这一条请求 ---------- */
    const committed = await runPluginCommit(vault, memoryRoot);
    check('插件处理了排队请求', committed.processed === 1, JSON.stringify(committed));
    check('插件提交成功（completed）', committed.status === 'completed', String(committed.status));
    check('回执落盘到 .memory/receipts/', committed.receiptWritten === true);

    /**
     * 记忆笔记落在 `00-收件箱/` 这类子目录里，因此要递归列举：
     * 只列顶层会得到 0 个，随后 `path.join(..., memoryFiles[0])` 会直接崩掉，
     * 让人以为是实现出错，其实只是断言写错了层。
     */
    const memoryFiles = await listMarkdown(path.join(vault, memoryRoot), { skip: ['.memory'] });
    check('提交之后笔记真的出现在记忆根里', memoryFiles.length === 1, memoryFiles.join(','));

    /* ---------- 5. 回执可被外部读回 ---------- */
    const receipt = jsonArrayOf((await run(['receipts', '--vault', vault, '--json', 'true'])).stdout, 'receipts#2');
    check('外部能读回这条回执', Array.isArray(receipt) && receipt.length === 1, JSON.stringify(receipt));
    check('回执状态是 completed', receipt[0]?.status === 'completed', JSON.stringify(receipt[0]));
    check('回执带上了落地记忆 id', typeof receipt[0]?.memoryId === 'string' && receipt[0].memoryId.startsWith('mem_'), String(receipt[0]?.memoryId));

    /* ---------- 6. 读命令走的是同一份数据 ---------- */
    const search = jsonOf(
      (await run(['search', '--vault', vault, '--json', 'true', '--text', '排队', '--include-pending'])).stdout,
      'search',
    );
    check('搜索能找到刚提交的记忆', search.hits?.length === 1, JSON.stringify(search.hits));
    const memoryId = search.hits[0].id;

    const got = await run(['get', '--vault', vault, '--id', memoryId]);
    check('get 能取出正文', got.code === 0 && got.stdout.includes('由 Obsidian 插件提交'), String(got.code));

    const explain = jsonOf((await run(['explain', '--vault', vault, '--json', 'true', '--id', memoryId])).stdout, 'explain');
    check('explain 说明召回原因', typeof explain === 'object' && explain !== null, JSON.stringify(explain).slice(0, 120));

    /* ---------- 7. 冲突保护：排队之后、提交之前的人工编辑不被覆盖 ---------- */
    const notePath = path.join(vault, memoryRoot, memoryFiles[0]);
    const before = await readFile(notePath, 'utf8');

    /**
     * 顺序很重要：**先排队**（CLI 此时读到的是未被改动的版本，哈希随之写进请求）
     * → 再人工编辑 → 最后提交。反过来做的话，CLI 会在排队时读到已经改过的版本，
     * 记录下的预期哈希就是新内容，提交当然成功——那是协议正确，不是测试通过。
     */
    const updateQueued = jsonOf(
      (await run(['update', '--vault', vault, '--json', 'true', '--id', memoryId, '--text', '想覆盖成新内容'])).stdout,
      'update',
    );
    check('update 排队时带上了期望哈希', updateQueued.accepted === true, JSON.stringify(updateQueued));
    const updateEnvelope = await readFile(
      path.join(vault, memoryRoot, '.memory', 'requests', `${updateQueued.requestId}.md`),
      'utf8',
    );
    const queuedHash = /expected_hash: "([0-9a-f]+)"/.exec(updateEnvelope)?.[1] ?? '';
    check('排队时记下了「当时读到的」哈希', /^[0-9a-f]{64}$/.test(queuedHash), queuedHash);

    await writeFile(notePath, before.replace('由 Obsidian 插件提交', '由 Obsidian 插件提交（我手动补了一句）'), 'utf8');
    check('人工编辑确实改了文件内容', (await readFile(notePath, 'utf8')) !== before);

    const conflict = await runPluginCommit(vault, memoryRoot);
    check(
      '人工编辑过 → 提交冲突而不是覆盖',
      conflict.status === 'conflict',
      `${conflict.status} / ${conflict.message ?? ''}`,
    );
    const after = await readFile(notePath, 'utf8');
    check('人工正文一个字都没被改掉', after.includes('我手动补了一句'), after.slice(0, 80));
    check('冲突时没有把请求里的新内容写进去', !after.includes('想覆盖成新内容'), after.slice(0, 80));

    // 按**本次 requestId** 取回执：不能拿「批次里的第一条」当证据。
    const conflictReceipt = jsonArrayOf((await run(['receipts', '--vault', vault, '--json', 'true'])).stdout, 'receipts#3');
    const myReceipt = conflictReceipt.find(item => item.requestId === updateQueued.requestId);
    const receiptFiles2 = await readdir(path.join(vault, memoryRoot, '.memory', 'receipts'));
    console.log(
      '[debug] conflict', JSON.stringify(conflict),
      'files', receiptFiles2.join(','),
      'receipts', JSON.stringify(conflictReceipt.map(i => [i.requestId, i.status])),
    );
    check(
      '冲突回执在外部可读，且写明现场',
      myReceipt?.status === 'conflict' && typeof myReceipt.message === 'string' && myReceipt.message.length > 0,
      JSON.stringify(myReceipt ?? conflictReceipt.map(item => [item.requestId, item.status])),
    );

    /* ---------- 7b. 显式旧预期：调用者说了按旧版改，就必须被拒 ---------- */
    const staleNote = await readFile(notePath, 'utf8');
    await writeFile(notePath, `${staleNote}\n又手动加了一行。\n`, 'utf8');
    const staleQueued = jsonOf(
      (
        await run([
          'update',
          '--vault',
          vault,
          '--json',
          'true',
          '--id',
          memoryId,
          '--text',
          '用旧预期强行覆盖',
          // 全 0 是一个**故意不可能匹配**的旧预期：模拟「我读到的是旧版」。
          '--expected-hash',
          '0'.repeat(64),
        ])
      ).stdout,
      'update#2',
    );
    check('显式 --expected-hash 被受理', staleQueued.accepted === true, JSON.stringify(staleQueued));
    const staleEnvelope = await readFile(
      path.join(vault, memoryRoot, '.memory', 'requests', `${staleQueued.requestId}.md`),
      'utf8',
    );
    check(
      '排队信封里原样保留了调用者给的旧哈希（没有被现查值盖掉）',
      staleEnvelope.includes('0'.repeat(64)),
      staleEnvelope.slice(0, 220),
    );
    const staleCommit = await runPluginCommit(vault, memoryRoot);
    check(
      '按旧预期提交被拒（不是静默覆盖）',
      staleCommit.status === 'conflict' || staleCommit.status === 'failed',
      `${staleCommit.status} / ${staleCommit.message ?? ''}`,
    );
    const afterStale = await readFile(notePath, 'utf8');
    check('被拒之后人工正文仍然完好', afterStale.includes('又手动加了一行。'), afterStale.slice(-90));
    check('被拒之后没有写入请求里的内容', !afterStale.includes('用旧预期强行覆盖'));

    /* ---------- 8. 只读命令不需要排队 ---------- */
    const stats = await run(['stats', '--vault', vault, '--json', 'true']);
    check('stats 直接读（不排队）', stats.code === 0 && stats.stdout.includes('{'), String(stats.code));
  } finally {
    await rm(vault, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\nCLI 端到端：${passes.length} 项通过，${failures.length} 项失败`);
  for (const name of passes) console.log(`  ✓ ${name}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log('结论：外部 CLI 排队 → 真实插件代码提交 → 回执可回读，闭环成立。');
}

/**
 * 用**真实的插件处理代码**消费队列。
 *
 * 这里不做网络、不开 Obsidian：把 Obsidian API 换成内存合成桩，
 * 让 `QueueService.processOnce()` 与提交处理器按真实逻辑跑一遍。
 */
async function runPluginCommit(vault, memoryRoot) {
  const { moduleUrl, dispose } = await buildPluginCommitHarness();
  try {
    const harness = await import(moduleUrl);
    return await harness.buildSyntheticVault({ vaultPath: vault, memoryRoot });
  } finally {
    await dispose();
  }
}

main().catch(error => {
  console.error(`CLI 端到端失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});

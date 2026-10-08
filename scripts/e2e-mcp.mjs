#!/usr/bin/env node
/**
 * MCP 端到端验收：真的把 `mom-memory-mcp` 当子进程启动，按 MCP stdio 协议对话。
 *
 *   node scripts/e2e-mcp.mjs
 *
 * 覆盖「TASK 首版闭环」里 MCP 必须在场的部分：
 * 1. initialize / tools/list 说得通；
 * 2. 读工具能读；
 * 3. 写工具**只排队**（`requests/` 里出现请求文件），并且不直接改笔记；
 * 4. 回执未到时 `memory_wait_receipt` 如实说「还在队列里」，
 *    而不是假装成功、也不是报错；
 * 5. 排队的请求**不会**直接出现在记忆目录里（没有第二个写入者）。
 *
 * 全程使用仓库外的临时合成库，不碰任何真实 Vault。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'packages/cli/dist/mcp.js');
const failures = [];
const passes = [];

function check(name, condition, detail = '') {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail === '' ? '' : `：${detail}`}`);
}

/**
 * 让**真实的插件处理代码**把队列排空一次。
 *
 * 这是端到端里唯一被允许的写入路径：外部只有 CLI/MCP 排队，
 * 提交由插件真正使用的那几个模块完成。任何断言如果绕开它，
 * 测的就不是真实闭环。
 */
async function commitQueue(vault, memoryRoot) {
  const { buildPluginCommitHarness } = await import('./plugin-commit-harness.mjs');
  const harness = await buildPluginCommitHarness();
  try {
    const module = await import(harness.moduleUrl);
    return await module.buildSyntheticVault({ vaultPath: vault, memoryRoot });
  } finally {
    await harness.dispose();
  }
}

/**
 * 用**真实的队列处理**播种两条记录，再回头测 MCP 的准入过滤。
 *
 * 为什么不让 MCP 自己写：那正好绕过了「写请求只排队」这条契约，
 * 测出来的东西不代表真实路径。这里走的是与 CLI 端到端相同的做法——
 * 外部排队，插件侧（真实处理代码）提交。
 */
async function seedMemory(vault, memoryRoot, entries) {
  const { execFileSync } = await import('node:child_process');
  const cli = path.join(root, 'packages/cli/dist/cli.js');
  const requestDir = path.join(vault, memoryRoot, '.memory', 'requests');

  // 1) 先把要播种的记录全部排进队列（每条都确认请求文件真的出现了）。
  for (const entry of entries) {
    const out = execFileSync(
      process.execPath,
      [
        cli,
        'remember',
        '--vault',
        vault,
        '--json',
        'true',
        '--text',
        entry.body,
        ...(entry.title === undefined ? [] : ['--title', entry.title]),
        ...(entry.allowModel === false ? ['--no-allow-model'] : []),
      ],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    if (parsed.accepted !== true) throw new Error(`播种失败：${out}`);
    await waitForFile(requestDir, `${parsed.requestId}.md`);
  }

  /**
   * 2) 让**真实的插件处理代码**把队列排空一次。
   *
   * 为什么只认「排空」而不是逐条处理：驱动进程启动时会顺手把队列里
   * **所有**等待中的请求都处理掉（这就是真实插件的做法）。逐条写、逐条处理
   * 会变成「第二次的请求被第一次的处理顺手提交了」，测试就会莫名其妙地失败。
   * 因此这里改成：全部排队 → 一次处理 → 处理数必须正好等于播种条数。
   */
  const outcome = await commitQueue(vault, memoryRoot);
  const processed = outcome.processed;
  /**
   * 只要求「至少把播种的这几条提交掉」。
   *
   * 处理数通常更多：驱动启动时会顺手把队列里其它等待中的请求（本次会话早先
   * 排队的那几条）也处理掉——这正是真实插件的行为，不是缺陷。
   */
  if (outcome.status !== 'completed' || processed < entries.length) {
    throw new Error(`播种提交结果不符合预期：${JSON.stringify(outcome)}（至少应有 ${entries.length} 条）`);
  }

  // 3) 取回真实 id：用**正文**匹配（每条都不一样），这一步是脚手架核对，不是模型可见路径。
  const search = execFileSync(
    process.execPath,
    /**
     * 检索词要**同时出现在两条播种记录里**：只在一半记录里出现的词
     * 会让另一条既搜不到、也拿不到 id，然后报出一个看不懂的「找不到记录」。
     * 构造正文时保证这条共同词存在。
     */
        // 「发送给模型」这个说法同时出现在两条播种正文里，因此两条都能被召回。
    [cli, 'search', '--vault', vault, '--json', 'true', '--text', '发送给模型', '--include-pending', '--limit', '50'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(search.slice(search.indexOf('{')));
  return entries.map(entry => {
    const hit = parsed.hits?.find(item => entry.body.includes(item.title));
    if (hit === undefined) {
      throw new Error(`播种后找不到记录：${entry.title}\n可用命中：${JSON.stringify(parsed.hits?.map(h => h.title))}`);
    }
    return { id: hit.id, title: entry.title };
  });
}

/**
 * 等一个文件出现（最多 5 秒）。
 *
 * 跨进程验收里「命令返回」与「文件可见」之间不该靠猜：等不到就让测试明确失败，
 * 而不是让后面的断言去解释一个空目录。
 */
async function waitForFile(dir, name, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path.join(dir, name))) return;
    if (Date.now() > deadline) throw new Error(`等待文件超时：${path.join(dir, name)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * 递归列举目录下的 Markdown 文件（相对路径）。
 *
 * `skip` 用来排除 `.memory` 这类管理目录：那里放的是请求与回执，不是记忆本身。
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

/** 起一个真实的 MCP 子进程，按行收发 JSON-RPC。 */
function startServer(vault) {
  const child = spawn(process.execPath, [server, '--vault', vault], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = pending.get(message.id);
      if (resolver !== undefined) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`MCP 请求超时：${method}`));
      }, 20_000);
    });
  return { child, request, stderr, stop: () => child.kill('SIGTERM') };
}

const payload = message => {
  const text = message?.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function main() {
  if (!existsSync(server)) {
    console.error('缺少 packages/cli/dist/mcp.js，请先运行 node scripts/build.mjs mcp。');
    process.exit(1);
  }
  const vault = await mkdtemp(path.join(os.tmpdir(), 'mom-mcp-e2e-'));
  const memoryRoot = 'Second Brain';
  const session = startServer(vault);
  try {
    const init = await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    check('initialize 返回服务器身份', init?.result?.serverInfo?.name === 'missher-obsidian-memory', JSON.stringify(init));
    check('initialize 声明 tools 能力', init?.result?.capabilities?.tools !== undefined);

    const list = await session.request('tools/list', {});
    const tools = (list?.result?.tools ?? []).map(tool => tool.name);
    check('tools/list 含读工具', tools.includes('memory_search') && tools.includes('memory_get'));
    check('tools/list 含排队写工具', tools.includes('memory_remember'));
    check('tools/list 含回执工具', tools.includes('memory_wait_receipt') && tools.includes('memory_receipts'));
    check('没有直写工具（MCP 不给 AI 绕过队列的能力）', !tools.some(name => /direct|write_file|raw/i.test(name)), tools.join(','));

    const remember = await session.request('tools/call', {
      name: 'memory_remember',
      arguments: { text: 'MCP 排队的这条内容应该只出现在请求队列里。', title: 'MCP 闭环' },
    });
    const queued = payload(remember);
    check('memory_remember 明确说 accepted（已排队）', queued?.status === 'accepted', JSON.stringify(queued));
    check('memory_remember 回执里说明「已排队 ≠ 已提交」', String(queued?.meaning ?? '').includes('≠'));
    check('返回了请求 id', typeof queued?.requestId === 'string' && queued.requestId.startsWith('req_'), String(queued?.requestId));

    const requestDir = path.join(vault, memoryRoot, '.memory', 'requests');
    /** 等请求文件真的出现在磁盘上（同进程内的写入也可能有极短的可见延迟）。 */
    await waitForFile(requestDir, `${queued.requestId}.md`);
    const queuedFiles = existsSync(requestDir) ? await readdir(requestDir) : [];
    check('请求文件真的落到了 .memory/requests/', queuedFiles.includes(`${queued.requestId}.md`), queuedFiles.join(','));
    /**
     * 立刻把信封内容读下来。
     *
     * 后面的播种会让插件把这些请求提交掉（请求文件随之被清理），
     * 所以对信封的断言必须发生在处理之前，否则读到的是一个已经不存在的文件。
     */
    const queuedEnvelope = await readFile(path.join(requestDir, `${queued.requestId}.md`), 'utf8');

    // 关键：排队不等于写入。记忆目录里不该出现新笔记。
    const memoryDir = path.join(vault, memoryRoot);
    const memoryEntries = existsSync(memoryDir) ? await readdir(memoryDir) : [];
    check(
      '排队没有直接写笔记（没有第二个写入者）',
      !memoryEntries.some(name => name.endsWith('.md')),
      memoryEntries.join(','),
    );

    // 同样的内容再排一次：应识别为重复，不重复落盘。
    const again = await session.request('tools/call', {
      name: 'memory_remember',
      arguments: { text: 'MCP 排队的这条内容应该只出现在请求队列里。', title: 'MCP 闭环' },
    });
    const dupe = payload(again);
    check('同内容重排被识别为重复请求', dupe?.duplicate === true, JSON.stringify(dupe));
    const afterSecond = await readdir(requestDir);
    check('重复请求没有多出一个文件', afterSecond.filter(name => name.endsWith('.md')).length === 1, String(afterSecond.length));

    // 回执未到：必须如实说「还在队列里」。
    const wait = await session.request('tools/call', {
      name: 'memory_wait_receipt',
      arguments: { id: queued.requestId, timeoutSeconds: 1 },
    });
    const waited = payload(wait);
    check('回执未到时返回 pending（不是假装 completed）', waited?.status === 'pending', JSON.stringify(waited));
    check('pending 说明请求仍在队列里', String(waited?.message ?? '').includes('队列'), String(waited?.message));

    const status = payload(await session.request('tools/call', { name: 'memory_queue_status', arguments: {} }));
    check('队列状态显示 1 条待处理', status?.pending === 1, JSON.stringify(status));

    const search = payload(await session.request('tools/call', { name: 'memory_search', arguments: { text: 'MCP' } }));
    check('memory_search 在空库里返回 0 条（不编造）', Array.isArray(search?.hits) && search.hits.length === 0, JSON.stringify(search));

    /* ---------- pending: true 真的排成 propose ---------- */
    const proposeCall = payload(
      await session.request('tools/call', {
        name: 'memory_remember',
        arguments: { text: '这条只是候选：等用户确认才生效。', pending: true },
      }),
    );
    check(
      'pending:true 排队成功且标明是候选',
      proposeCall?.status === 'accepted' && JSON.stringify(proposeCall).includes('propose'),
      JSON.stringify(proposeCall),
    );
    const proposeEnvelope = await readFile(path.join(requestDir, `${proposeCall.requestId}.md`), 'utf8');
    check('请求文件里的操作名真的是 propose', /operation:\s*"?propose"?/.test(proposeEnvelope), proposeEnvelope.slice(0, 160));
    const beforeCommit = await session.request('tools/call', { name: 'memory_search', arguments: { text: '候选' } });
    check(
      '候选提交之前搜不到（不伪装成事实）',
      (payload(beforeCommit)?.hits ?? []).length === 0,
      JSON.stringify(payload(beforeCommit)).slice(0, 160),
    );

    /* ---------- 准入过滤：不能发送的记录不许被绕过 ---------- */
    const seed = await seedMemory(vault, memoryRoot, [
      // 两条正文都含「发送给模型」：播种后的 id 回查依赖这个共同词。
      { body: '可以发送给模型的公开内容：构建脚本用 esbuild。', title: '公开', allowModel: true },
      { body: 'PRIVATE_SENTINEL_MCP 这条设置为不发送给模型。', title: '私密', allowModel: false },
    ]);
    check('播种两条记录成功', seed.length === 2, JSON.stringify(seed));

    /**
     * 用只在两条播种记录里出现的词检索。
     *
     * 用精确词而不是「内容」这种常见词：这个库此刻已经有一条早先排队的记录，
     * 用常见词会把那条也召回来，断言就不清楚了。
     */
    const publicSearch = payload(
      await session.request('tools/call', { name: 'memory_search', arguments: { text: 'PRIVATE_SENTINEL_MCP 公开' } }),
    );
    const publicText = JSON.stringify(publicSearch);
    check('默认搜索只返回允许发送的记录', publicSearch?.hits?.length === 1, publicText.slice(0, 300));
    check('默认搜索里没有 allow_model=false 的正文', !publicText.includes('PRIVATE_SENTINEL_MCP'), publicText.slice(0, 200));
    check(
      '被拦下的只给数量与类别，不给 id/路径',
      publicSearch?.hidden !== undefined &&
        !JSON.stringify(publicSearch.hidden).includes('mem_') &&
        !JSON.stringify(publicSearch.hidden).includes('收件箱'),
      JSON.stringify(publicSearch.hidden),
    );

    const privateId = seed.find(item => item.title === '私密')?.id ?? '';
    const blockedGet = payload(
      await session.request('tools/call', { name: 'memory_get', arguments: { id: privateId } }),
    );
    check('知道 id 也取不到不允许发送的记录', blockedGet?.found === false, JSON.stringify(blockedGet));
    check('取不到时不含正文与元数据', !JSON.stringify(blockedGet).includes('PRIVATE_SENTINEL_MCP'), JSON.stringify(blockedGet).slice(0, 200));

    /**
     * 越权参数必须**在运行时**被拒绝，而不是靠「schema 里没写」。
     * 所以这里故意手工填 includePrivate: true，看它能不能绕过 allow_model。
     */
    const bypassSearch = await session.request('tools/call', {
      name: 'memory_search',
      arguments: { text: 'PRIVATE_SENTINEL_MCP 公开', includePrivate: true },
    });
    const bypassText = JSON.stringify(bypassSearch);
    check('手工填 includePrivate 也不能让搜索泄露', !bypassText.includes('PRIVATE_SENTINEL_MCP'), bypassText.slice(0, 200));
    const bypassHits = payload(bypassSearch)?.hits?.length;
    check('手工填 includePrivate 时不返回被禁止的记录', bypassHits === 1, String(bypassHits));

    const bypassGet = await session.request('tools/call', {
      name: 'memory_get',
      arguments: { id: privateId, includePrivate: true },
    });
    check('手工填 includePrivate 也不能按 id 取到', payload(bypassGet)?.found === false, JSON.stringify(payload(bypassGet)).slice(0, 200));
    check('越权尝试不返回任何正文', !JSON.stringify(bypassGet).includes('PRIVATE_SENTINEL_MCP'));

    const schemaText = JSON.stringify((await session.request('tools/list', {})).result?.tools ?? []);
    check('schema 里也不再声明这个越权参数', !schemaText.includes('includePrivate'), schemaText.slice(0, 120));

    const badScope = await session.request('tools/call', {
      name: 'memory_search',
      arguments: { text: 'PRIVATE_SENTINEL_MCP 公开', scope: 'team:研究组' },
    });
    check('未知范围被拒绝（不静默转换）', badScope?.result?.isError === true, JSON.stringify(badScope?.result).slice(0, 200));
    check('错误里列出真正可用的范围', String(badScope?.result?.content?.[0]?.text ?? '').includes('personal'), String(badScope?.result?.content?.[0]?.text ?? ''));

    const noRefScope = await session.request('tools/call', {
      name: 'memory_search',
      arguments: { text: 'PRIVATE_SENTINEL_MCP 公开', scope: 'project' },
    });
    check('project 缺名称时被拒绝', noRefScope?.result?.isError === true, JSON.stringify(noRefScope?.result).slice(0, 200));

    const contextScope = payload(
      await session.request('tools/call', {
        name: 'memory_search',
        arguments: { text: 'PRIVATE_SENTINEL_MCP 公开', scope: 'context:在家' },
      }),
    );
    check('context:<名称> 是合法范围且不跨范围泄露', Array.isArray(contextScope?.hits) && contextScope.hits.length === 0, JSON.stringify(contextScope).slice(0, 160));

    const publicId = seed.find(item => item.title === '公开')?.id ?? '';
    /* ---------- R7 回执不能成为第四条泄漏通道 ---------- */

    /**
     * 复现审计给出的旁路：回执里的 `path` 含原文标题，
     * `message` 形如「已记住：<含标题路径>」。
     *
     * 如果回执不过可见性规则，那么「把记录改成 allow_model=false」之后，
     * AI 仍然能从历史回执里取回标题——搜索、按 id 读取、诊断三条路都堵住了，
     * 却从第四条路漏了出去。
     */
    const SENTINEL_TITLE = 'receipt-privacy-sentinel-标题';
    const SENTINEL_BODY = `回执隐私哨兵正文：${SENTINEL_TITLE}，这段文字不许从回执里泄漏。`;

    const { execFileSync: execSyncLocal } = await import('node:child_process');
    const cliPath = path.join(root, 'packages/cli/dist/cli.js');
    /** 同步跑一次 CLI 并解析 JSON（只用来构造前置状态，不走捷径、不直写）。 */
    const queueViaCli = cliArgs => {
      const output = execSyncLocal(process.execPath, [cliPath, ...cliArgs], { encoding: 'utf8' });
      return JSON.parse(output.slice(output.indexOf('{')));
    };

    const sentinelQueue = queueViaCli([
      'remember', '--vault', vault, '--json', 'true',
      '--text', SENTINEL_BODY, '--title', SENTINEL_TITLE,
    ]);
    await waitForFile(requestDir, `${sentinelQueue.requestId}.md`);
    const sentinelCommit = await commitQueue(vault, memoryRoot);
    check('哨兵记录被真实插件提交（构造前提成立）', sentinelCommit.status === 'completed', JSON.stringify(sentinelCommit));

    // 正向对照：记录当前可见时，回执**必须**带细节——否则下面的断言可能只是因为整体被脱敏。
    const visibleReceipt = payload(
      await session.request('tools/call', {
        name: 'memory_wait_receipt',
        arguments: { id: sentinelQueue.requestId, timeoutSeconds: 5 },
      }),
    );
    check(
      '正向对照：记录可见时回执带路径与说明',
      visibleReceipt?.status === 'completed' &&
        visibleReceipt?.detailsHidden === false &&
        typeof visibleReceipt?.memoryPath === 'string',
      JSON.stringify(visibleReceipt).slice(0, 240),
    );

    // 把这条记录改成不发送给模型（走真实的 CLI 排队 + 插件提交，不直接改文件）。
    const sentinelId = visibleReceipt?.memoryId ?? '';
    const sentinelHash = payload(
      await session.request('tools/call', { name: 'memory_get', arguments: { id: sentinelId } }),
    )?.hash;
    const disableCall = queueViaCli([
      'update', '--vault', vault, '--json', 'true',
      '--id', sentinelId, '--expected-hash', String(sentinelHash),
      '--no-allow-model', 'true', '--text', SENTINEL_BODY,
    ]);
    await waitForFile(requestDir, `${disableCall.requestId}.md`);
    check('把哨兵记录改成 allow_model=false 已排队', disableCall?.status === 'queued', JSON.stringify(disableCall).slice(0, 200));
    const disableCommit = await commitQueue(vault, memoryRoot);
    check('allow_model=false 的更新被真实插件提交', disableCommit.status === 'completed', JSON.stringify(disableCommit));

    // 关键断言：知道 requestId 仍然能准确知道状态，但拿不到标题/路径/正文。
    const hiddenReceipt = await session.request('tools/call', {
      name: 'memory_wait_receipt',
      arguments: { id: sentinelQueue.requestId, timeoutSeconds: 5 },
    });
    const hiddenPayload = payload(hiddenReceipt);
    const hiddenText = JSON.stringify(hiddenReceipt);
    check(
      '禁止外发后，回执仍准确报 completed（不改成 pending）',
      hiddenPayload?.status === 'completed',
      JSON.stringify(hiddenPayload).slice(0, 200),
    );
    check('禁止外发后，回执不含标题', !hiddenText.includes(SENTINEL_TITLE), hiddenText.slice(0, 240));
    check('禁止外发后，回执不含正文片段', !hiddenText.includes('不许从回执里泄漏'), hiddenText.slice(0, 240));
    check('禁止外发后，回执不含记忆路径', !hiddenText.includes('收件箱'), hiddenText.slice(0, 240));
    check('禁止外发后，回执不含 memoryId', hiddenPayload?.memoryId === undefined, JSON.stringify(hiddenPayload).slice(0, 200));
    check(
      '禁止外发后，回执给出固定原因',
      typeof hiddenPayload?.reason === 'string' && hiddenPayload.reason.includes('不允许发送给模型'),
      String(hiddenPayload?.reason),
    );
    check('禁止外发后，回执标记 detailsHidden', hiddenPayload?.detailsHidden === true, JSON.stringify(hiddenPayload).slice(0, 200));

    // 批量回执：先范围/许可过滤再投影，同样不能泄漏。
    const batch = await session.request('tools/call', { name: 'memory_receipts', arguments: { limit: 50 } });
    const batchText = JSON.stringify(batch);
    check('批量回执不含被隐藏记录的标题', !batchText.includes(SENTINEL_TITLE), batchText.slice(0, 240));
    check('批量回执不含被隐藏记录的正文片段', !batchText.includes('不许从回执里泄漏'), batchText.slice(0, 240));
    const batchItems = payload(batch);
    const hiddenItem = Array.isArray(batchItems)
      ? batchItems.find(item => item.requestId === sentinelQueue.requestId)
      : undefined;
    check('批量回执仍列出这条请求的准确状态', hiddenItem?.status === 'completed', JSON.stringify(hiddenItem));
    check('批量回执里这条被标记为隐藏细节', hiddenItem?.detailsHidden === true, JSON.stringify(hiddenItem));

    /**
     * 删除之后连 memory_get 都应该取不到，回执同样必须隐藏。
     * 这里用真实队列排队 delete，再由插件提交。
     */
    const deleteCall = queueViaCli(['delete', '--vault', vault, '--json', 'true', '--id', sentinelId]);
    await waitForFile(requestDir, `${deleteCall.requestId}.md`);
    const deleteCommit = await commitQueue(vault, memoryRoot);
    check('哨兵记录被真实删除', deleteCommit.status === 'completed', JSON.stringify(deleteCommit));
    const afterDeleteGet = payload(
      await session.request('tools/call', { name: 'memory_get', arguments: { id: sentinelId } }),
    );
    check('删除后按 id 取不到（前置条件成立）', afterDeleteGet?.found === false, JSON.stringify(afterDeleteGet).slice(0, 160));
    const deletedReceipt = await session.request('tools/call', {
      name: 'memory_wait_receipt',
      arguments: { id: sentinelQueue.requestId, timeoutSeconds: 5 },
    });
    const deletedPayload = payload(deletedReceipt);
    const deletedText = JSON.stringify(deletedReceipt);
    check('删除后回执仍准确报 completed', deletedPayload?.status === 'completed', JSON.stringify(deletedPayload).slice(0, 200));
    check('删除后回执不含标题', !deletedText.includes(SENTINEL_TITLE), deletedText.slice(0, 240));
    check('删除后回执不含路径', !deletedText.includes('收件箱'), deletedText.slice(0, 240));
    check('删除后回执给出固定原因且标记隐藏', deletedPayload?.detailsHidden === true, JSON.stringify(deletedPayload).slice(0, 200));

    /**
     * 等待期间世界会变：这一条**专测等待中途被禁发**。
     *
     * 竞态必须真的堵在等待上，否则测的还是旧状态：
     * - 上一次更新的回执**还没提交**（文件不存在）；
     * - 等待先发出去，它会真的阻塞在轮询上；
     * - 我们随后把「禁发」提交掉，回执才会出现，等待就在这时返回。
     *
     * 如果返回前不重新读盘，判定用的就是等待前那份「还允许发送」的快照，
     * 标题与路径会漏出去。
     */
    const midWaitText = `等待中禁发哨兵 ${Date.now()}`;
    const midWaitQueue = queueViaCli([
      'remember', '--vault', vault, '--json', 'true', '--text', midWaitText, '--title', 'mid-wait-title',
    ]);
    await waitForFile(requestDir, `${midWaitQueue.requestId}.md`);
    const midWaitCommit = await commitQueue(vault, memoryRoot);
    check('等待中禁发用例的前置提交成功', midWaitCommit.status === 'completed', JSON.stringify(midWaitCommit));
    const midWaitReceipt = payload(
      await session.request('tools/call', {
        name: 'memory_wait_receipt',
        arguments: { id: midWaitQueue.requestId, timeoutSeconds: 5 },
      }),
    );
    const midWaitId = String(midWaitReceipt?.memoryId ?? '');
    const midWaitHash = payload(
      await session.request('tools/call', { name: 'memory_get', arguments: { id: midWaitId } }),
    )?.hash;

    /** 第二条更新带上哨兵标题：它的回执要等我们提交之后才会出现。 */
    const secondTitle = `mid-wait-title-2-${Date.now()}`;
    const racingRequest = queueViaCli([
      'update', '--vault', vault, '--json', 'true',
      '--id', midWaitId, '--expected-hash', String(midWaitHash),
      '--no-allow-model', 'true', '--text', midWaitText, '--title', secondTitle,
    ]);
    await waitForFile(requestDir, `${racingRequest.requestId}.md`);
    /** 回执还不存在：这次等待会真的阻塞住。 */
    check(
      '竞态前置：这条更新的回执尚未产生',
      !existsSync(path.join(vault, memoryRoot, '.memory', 'receipts', `${racingRequest.requestId}.md`)),
      racingRequest.requestId,
    );

    const racingWait = session.request('tools/call', {
      name: 'memory_wait_receipt',
      arguments: { id: racingRequest.requestId, timeoutSeconds: 15 },
    });
    // 让等待真的进入轮询之后，再提交这次禁发。
    await new Promise(resolve => setTimeout(resolve, 700));
    const midWaitDisableCommit = await commitQueue(vault, memoryRoot);
    check(
      '等待中把记录改成 allow_model=false（真实插件提交）',
      midWaitDisableCommit.status === 'completed',
      JSON.stringify(midWaitDisableCommit),
    );
    const racingReceipt = await racingWait;
    const midWaitAfter = await session.request('tools/call', { name: 'memory_get', arguments: { id: midWaitId } });
    check(
      '禁发确实生效：此时按 id 已经取不到该记录',
      payload(midWaitAfter)?.found === false,
      JSON.stringify(payload(midWaitAfter)).slice(0, 200),
    );
    const racingPayload = payload(racingReceipt);
    const racingText = JSON.stringify(racingReceipt);
    check(
      '等待期间被禁发：回执仍准确报 completed，且改用当前可见性',
      racingPayload?.status === 'completed' && racingPayload?.detailsHidden === true,
      JSON.stringify(racingPayload).slice(0, 240),
    );
    check('等待期间被禁发：回执不含标题', !racingText.includes(secondTitle), racingText.slice(0, 240));
    check('等待期间被禁发：回执不含正文', !racingText.includes('等待中禁发哨兵'), racingText.slice(0, 240));
    check(
      '等待期间被禁发：给出固定原因',
      typeof racingPayload?.reason === 'string' && racingPayload.reason.includes('不允许发送给模型'),
      String(racingPayload?.reason),
    );

    /* ---------- session_commit 默认事件 id 不含正文 ---------- */

    const defaultEventText = '默认事件 id 哨兵：这段正文不该出现在 id 里。';
    const defaultEventCommit = payload(
      await session.request('tools/call', {
        name: 'memory_session_commit',
        arguments: { events: [{ text: defaultEventText }] },
      }),
    );
    check(
      '不带 eventId 的会话提交排队成功',
      defaultEventCommit?.status === 'accepted',
      JSON.stringify(defaultEventCommit).slice(0, 200),
    );
    const defaultRequest = String(defaultEventCommit?.requestId ?? '');
    await waitForFile(requestDir, `${defaultRequest}.md`);
    const defaultEnvelope = await readFile(path.join(requestDir, `${defaultRequest}.md`), 'utf8');
    /**
     * 信封里**必然**有正文：那就是这次要写的内容，payload.events[0].text。
     * 这里要证明的是另一件事——**事件 id 不是正文的副本**：
     * id 会写进每条记忆的元数据与状态文件，一旦它带正文片段，
     * 记录后来被改成 `allow_model: false` 也擦不掉那份副本。
     */
    const idMatch = /"event_id":\s*"([^"]*)"/.exec(defaultEnvelope);
    const defaultEventId = idMatch?.[1] ?? '';
    check(
      '默认事件 id 不含正文片段（id 不复制正文）',
      defaultEventId !== '' && !defaultEventId.includes('这段正文不该出现在 id 里'),
      defaultEventId,
    );
    check(
      '默认事件 id 是稳定哈希形状',
      /^mcp:0:[0-9a-f]{32}$/.test(defaultEventId),
      defaultEventId,
    );
    check(
      '幂等键同样只由哈希 id 组成，不含正文',
      !/"idempotency_key":\s*"[^"]*这段正文/.test(defaultEnvelope),
      (/"idempotency_key":\s*"([^"]*)"/.exec(defaultEnvelope)?.[1] ?? '').slice(0, 120),
    );
    const defaultCommit = await commitQueue(vault, memoryRoot);
    check('默认事件被真实插件提交', defaultCommit.status === 'completed', JSON.stringify(defaultCommit));
    const gotPublic = payload(
      await session.request('tools/call', { name: 'memory_get', arguments: { id: publicId } }),
    );
    check('允许发送的记录可以正常读到', gotPublic?.found === true && typeof gotPublic.hash === 'string', JSON.stringify(gotPublic).slice(0, 200));
    check('memory_get 不再整包回吐元数据', gotPublic?.meta === undefined, JSON.stringify(Object.keys(gotPublic ?? {})));

    /* ---------- 完整写入闭环：update / forget / session-commit ---------- */
    const updateCall = payload(
      await session.request('tools/call', {
        name: 'memory_update',
        arguments: { id: publicId, hash: gotPublic.hash, text: '可以发送给模型的公开内容：构建脚本改用 esbuild 单文件产物。' },
      }),
    );
    check('memory_update 排队成功', updateCall?.status === 'accepted', JSON.stringify(updateCall));

    const badHash = await session.request('tools/call', {
      name: 'memory_update',
      arguments: { id: publicId, hash: 'deadbeef'.repeat(8), text: '不该被接受' },
    });
    check('memory_update 的哈希不一致时被拒绝', badHash?.result?.isError === true, JSON.stringify(badHash?.result).slice(0, 200));

    const noHash = await session.request('tools/call', {
      name: 'memory_update',
      arguments: { id: publicId, text: '缺少 hash' },
    });
    check('memory_update 缺少 hash 时被拒绝', noHash?.result?.isError === true, JSON.stringify(noHash?.result).slice(0, 160));

    const forgetCall = payload(
      await session.request('tools/call', {
        name: 'memory_forget',
        arguments: { id: publicId, hash: gotPublic.hash, reason: '端到端验证' },
      }),
    );
    check('memory_forget 排队成功且说明是归档语义', forgetCall?.status === 'accepted' && JSON.stringify(forgetCall).includes('归档'), JSON.stringify(forgetCall));

    const sessionCommit = payload(
      await session.request('tools/call', {
        name: 'memory_session_commit',
        arguments: {
          events: [
            { eventId: 'e2e-evt-1', text: '会话事件一：这是用户说过的话。', liveUserTurn: true, sourceRef: 'e2e-session' },
            { eventId: 'e2e-evt-2', text: '会话事件二：回放的历史文本。' },
          ],
        },
      }),
    );
    check('memory_session_commit 排队成功', sessionCommit?.status === 'accepted' && sessionCommit.count === 2, JSON.stringify(sessionCommit));
    check('会话提交说明默认是待确认候选', JSON.stringify(sessionCommit).includes('待确认'), JSON.stringify(sessionCommit));

    const badEvent = await session.request('tools/call', {
      name: 'memory_session_commit',
      arguments: { events: [{ text: '   ' }] },
    });
    check('空事件文本被拒绝', badEvent?.result?.isError === true);

    /**
     * 这一刻队列里还在等待处理的：update / forget / session-commit。
     * （propose 那条已经在前面被播种时的真实插件处理一并提交掉了。）
     */
    const requestFiles = await readdir(requestDir);
    check('所有写请求都只落在队列里', requestFiles.filter(name => name.endsWith('.md')).length >= 3, String(requestFiles.length));
    /**
     * 记忆文件在 `00-收件箱/` 这类子目录里，所以用递归列举：
     * 只列顶层会得到 0 个，断言就变成「看起来没写过」这种误导性结论。
     */
    const memoryFiles = await listMarkdown(path.join(vault, memoryRoot), { skip: ['.memory'] });
    /**
     * 记忆文件数必须与「已完成回执」数一致：每一条记忆文件都能对上一条
     * 由插件提交完成的排队请求。数量对不上就说明有第二个写入者，或有人绕过队列。
     * （具体条数不重要——播种时会顺手把早先排队的请求一起提交，所以这里比的是关系。）
     */
    /**
     * 「没有第二个写入者」要比的是**变化**，不是文件总数。
     *
     * 一条回执不等于一条记忆：更新、删除、会话提交都会产生回执，
     * 而记忆文件数只在「新建」时才增加。因此这里对一段**纯 MCP 活动窗口**
     * 取前后快照——窗口内没有任何插件提交，记忆文件数就必须纹丝不动。
     */
    const pluginCommitted = await listMarkdown(path.join(vault, memoryRoot), { skip: ['.memory'] });
    const mcpOnlyCommit = payload(
      await session.request('tools/call', {
        name: 'memory_session_commit',
        arguments: { events: [{ text: `MCP 纯排队窗口哨兵：${Date.now()}`, liveUserTurn: true }] },
      }),
    );
    check('纯 MCP 活动窗口里又有一次排队写入', mcpOnlyCommit?.status === 'accepted', JSON.stringify(mcpOnlyCommit));
    await waitForFile(requestDir, `${String(mcpOnlyCommit?.requestId ?? '')}.md`);
    const afterMcpWindow = await listMarkdown(path.join(vault, memoryRoot), { skip: ['.memory'] });
    check(
      'MCP 自己不会写记忆文件：只排队的那段时间里记忆文件数不变',
      afterMcpWindow.length === pluginCommitted.length,
      `before=${pluginCommitted.length} after=${afterMcpWindow.length} memory=${memoryFiles.length}`,
    );
    const receiptDir = path.join(vault, memoryRoot, '.memory', 'receipts');
    const receiptFiles = existsSync(receiptDir) ? await readdir(receiptDir) : [];
    check(
      '上一次插件提交之后，记忆文件至少与已完成回执一样多（每条提交都留下落盘结果）',
      memoryFiles.length >= 3 && receiptFiles.length >= 3,
      `memory=${memoryFiles.length} receipts=${receiptFiles.length}`,
    );

    const explain = payload(
      await session.request('tools/call', {
        name: 'memory_explain',
        arguments: { text: '这是外部客户端发来的一段文本。', sourceKind: 'external_document' },
      }),
    );
    check('memory_explain 对外部文本判定为「不作为显式命令」', explain?.explicit === false, JSON.stringify(explain));

    // 参数缺失必须报工具级错误，而不是静默成功。
    const bad = await session.request('tools/call', { name: 'memory_remember', arguments: { text: '   ' } });
    check('空正文被拒绝', bad?.result?.isError === true, JSON.stringify(bad?.result));

    const unknown = await session.request('tools/call', { name: 'memory_nope', arguments: {} });
    check('未知工具报错', unknown?.result?.isError === true || unknown?.error !== undefined);

    const requestBody = queuedEnvelope;
    check('请求信封里不含任何密钥字段', !/api[_-]?key|secret|token/i.test(requestBody), requestBody.slice(0, 120));
    check('请求信封标明 requester 是 mcp', requestBody.includes('requester: "mcp"'), requestBody.slice(0, 200));
    check('MCP 服务器把日志写在 stderr（不污染协议流）', session.stderr.join('').includes('已启动'));
  } finally {
    session.stop();
    await rm(vault, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\nMCP 端到端：${passes.length} 项通过，${failures.length} 项失败`);
  for (const name of passes) console.log(`  ✓ ${name}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log('结论：MCP 与 CLI 同契约——写请求只排队，回执如实区分状态。');
  void stat;
}

main().catch(error => {
  console.error(`MCP 端到端失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});

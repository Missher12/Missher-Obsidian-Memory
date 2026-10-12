#!/usr/bin/env node
/**
 * 分类端到端验收：真实 CLI/MCP dist bundle + 真实插件处理模块 + 合成 Vault。
 *
 * 先由协调者统一构建，再执行：node scripts/e2e-organization.mjs
 * 本脚本不重建 CLI/MCP；输出被测 bundle SHA256，避免把源码检查当成产物验收。
 * 插件侧复用 plugin-commit-harness：RuntimeVault 是磁盘版 FakeVault/API 替身，
 * 不是原生 Obsidian，不验证 UI、真实模型或 MSE。整个流程不联网。
 * 合成库只创建在本仓库 .experiment 下的唯一目录，结束后只清理该目录。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginCommitHarness } from './plugin-commit-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'packages/cli/dist/cli.js');
const server = path.join(root, 'packages/cli/dist/mcp.js');
const memoryRoot = '记忆库';
const organization = { preset: 'missher', placement: 'vault', folders: { profile: '资料/人物' } };
// 不继承可能指向用户真实 Vault 或另一套目录配置的 MOM_* 环境变量。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOM_')));
const passes = [];
const failures = [];

function check(label, condition, detail = '') {
  if (condition) passes.push(label);
  else failures.push(`${label}${detail === '' ? '' : `：${detail}`}`);
}

function flags(vault) {
  return ['--vault', vault, '--root', memoryRoot, '--layout', 'missher', '--placement', 'vault',
    '--folders-json', JSON.stringify(organization.folders)];
}

function runCli(vault, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, ...flags(vault), '--json', 'true'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`CLI 超时：${args[0]}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function cliJson(vault, args) {
  const result = await runCli(vault, args);
  if (result.code !== 0) throw new Error(`CLI ${args[0]} 失败：${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function startMcp(vault) {
  const child = spawn(process.execPath, [server, ...flags(vault)], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const failPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === '') continue;
      let message;
      try { message = JSON.parse(line); }
      catch { failPending(new Error(`MCP stdout 出现非 JSON：${line.slice(0, 160)}`)); continue; }
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      item.resolve(message);
    }
  });
  child.once('error', error => { closed = true; failPending(error); });
  const completion = new Promise(resolve => child.once('close', code => {
    closed = true;
    failPending(new Error(`MCP 进程已退出 ${code}：${stderr}`));
    resolve();
  }));
  return {
    request(method, params = {}) {
      if (closed) return Promise.reject(new Error(`MCP 已关闭：${stderr}`));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP 请求超时：${method}；${stderr}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
          if (!error || !pending.delete(id)) return;
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    async stop() {
      if (closed) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await completion;
      clearTimeout(timer);
    },
  };
}

function mcpPayload(message) {
  if (message.error || message.result?.isError) throw new Error(`MCP 调用失败：${JSON.stringify(message)}`);
  const text = message.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('MCP 工具没有文本结果。');
  return JSON.parse(text);
}

const tool = async (session, name, args = {}) => mcpPayload(await session.request('tools/call', { name, arguments: args }));
const toolRejected = message => message.result?.isError === true || message.error !== undefined;

async function put(vault, relative, text) {
  const absolute = path.join(vault, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, text, 'utf8');
}

async function queueFiles(vault) {
  try { return (await readdir(path.join(vault, memoryRoot, '.memory/requests'))).filter(name => name.endsWith('.md')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function main() {
  for (const bundle of [cli, server]) {
    if (!existsSync(bundle)) throw new Error(`缺少 ${path.relative(root, bundle)}；请先统一构建当前 CLI/MCP bundle。`);
    const sha = createHash('sha256').update(await readFile(bundle)).digest('hex');
    console.log(`bundle ${path.relative(root, bundle)} SHA256 ${sha}`);
  }
  console.log('验收层：真实 CLI/MCP bundle；真实插件提交代码；RuntimeVault/FakeVault 替身（非原生 Obsidian）。');
  const experiment = path.join(root, '.experiment');
  await mkdir(experiment, { recursive: true });
  const vault = await mkdtemp(path.join(experiment, 'organization-e2e-'));
  let session;
  let harness;
  try {
    const ordinary = new Map([
      ['知识库/手写笔记.md', '# 手写知识\n保留用户原文与已有链接 [[主页]]。\n'],
      ['资料/人物/README.md', '# 人物索引\n这是普通导航，没有记忆身份。\n'],
      ['主页.md', '# 主页\n[[知识库/手写笔记]]\n'],
    ]);
    for (const [relative, content] of ordinary) await put(vault, relative, content);
    harness = await buildPluginCommitHarness();
    const { buildSyntheticVault } = await import(harness.moduleUrl);
    const commit = () => buildSyntheticVault({ vaultPath: vault, memoryRoot, organization });
    session = startMcp(vault);
    const initialized = await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    check('真实 MCP bundle 版本为 0.2.0', initialized.result?.serverInfo?.version === '0.2.0');
    const listed = await session.request('tools/list');
    const rememberSchema = listed.result?.tools?.find(item => item.name === 'memory_remember')?.inputSchema;
    check('MCP schema 声明分类与短标题长度', rememberSchema?.properties?.category?.enum?.includes('profile')
      && rememberSchema?.properties?.title?.maxLength === 300);

    const workflow = await cliJson(vault, ['remember', '--text', '组织验收流程：先保留证据，再执行修改。',
      '--title', '工作惯例', '--category', 'workflow']);
    check('CLI remember 只返回排队状态', workflow.accepted === true && workflow.status === 'queued');
    const proposed = await tool(session, 'memory_remember', {
      text: '组织验收偏好：用户偏好简体中文回复。', title: '个人偏好', category: 'profile', pending: true,
    });
    check('MCP propose 只返回排队状态', proposed.status === 'accepted');
    const knowledge = await tool(session, 'memory_remember', {
      text: '组织验收知识：短标题与正文独立保存。', title: '条目命名', category: 'knowledge',
    });
    check('MCP remember 只返回排队状态', knowledge.status === 'accepted');
    const template = await cliJson(vault, ['remember', '--text', '组织验收模板：{{主题}}、{{背景}}和{{结论}}。',
      '--title', '问题模板', '--category', 'template']);
    const expected = new Map([
      [workflow.requestId, '工作流/工作惯例.md'], [proposed.requestId, '资料/人物/个人偏好.md'],
      [knowledge.requestId, '知识库/条目命名.md'], [template.requestId, '模板/问题模板.md'],
    ]);
    check('全部请求位于原根的 .memory/requests', (await queueFiles(vault)).length === 4);
    check('外部排队未创建任何目标笔记', [...expected.values()].every(relative => !existsSync(path.join(vault, relative))));
    const requestText = await readFile(path.join(vault, memoryRoot, '.memory/requests', `${workflow.requestId}.md`), 'utf8');
    check('CLI 信封实际保留短标题和分类', requestText.includes('"title": "工作惯例"') && requestText.includes('"category": "workflow"'));

    const invalidCategory = await runCli(vault, ['remember', '--text', '非法分类不得保存', '--category', '../私人']);
    check('CLI 拒绝非法 category', invalidCategory.code !== 0);
    const invalidMcp = await session.request('tools/call', { name: 'memory_remember', arguments: { text: '非法分类不得保存', category: 'all' } });
    check('MCP 拒绝非法 category', toolRejected(invalidMcp));
    const longTitle = await runCli(vault, ['propose', '--text', '过长标题不得排队', '--title', '标'.repeat(301)]);
    check('CLI 拒绝超过 300 字符的新建标题', longTitle.code !== 0);
    const longMcp = await session.request('tools/call', { name: 'memory_remember', arguments: { text: '过长标题不得排队', title: '标'.repeat(301) } });
    check('MCP 运行时拒绝超过 300 字符的新建标题', toolRejected(longMcp));
    const boundaryOverride = await session.request('tools/call', { name: 'memory_search', arguments: { text: '手写', root: '其他' } });
    check('MCP 工具调用不能更改启动目录范围', toolRejected(boundaryOverride));
    check('被拒绝的输入没有新增请求', (await queueFiles(vault)).length === 4);
    const before = await cliJson(vault, ['search', '--text', '组织验收']);
    check('提交前排队内容未进入事实搜索', before.hits?.length === 0);

    const firstCommit = await commit();
    check('真实插件处理代码提交全部四条请求', firstCommit.processed === 4 && firstCommit.status === 'completed', JSON.stringify(firstCommit));
    const receipts = await cliJson(vault, ['receipts']);
    check('CLI 能读到四条 completed 分类回执', receipts.length === 4 && receipts.every(item => item.status === 'completed'));
    for (const [id, relative] of expected) {
      const receipt = receipts.find(item => item.requestId === id);
      check(`回执路径与短标题一致：${relative}`, receipt?.path === relative && existsSync(path.join(vault, relative)));
    }
    check('插件提交后请求已消费', (await queueFiles(vault)).length === 0);
    check('没有写回已被自定义映射替换的目录', !existsSync(path.join(vault, '用户画像/个人偏好.md')));
    const workflowSearch = await cliJson(vault, ['search', '--text', '组织验收流程']);
    check('CLI 从同级分类目录检索实际提交内容', workflowSearch.hits?.some(item => item.path === '工作流/工作惯例.md' && item.title === '工作惯例'));
    const knowledgeSearch = await tool(session, 'memory_search', { text: '组织验收知识' });
    check('MCP 从同级分类目录检索实际提交内容', knowledgeSearch.hits?.some(item => item.path === '知识库/条目命名.md' && item.title === '条目命名'));
    const firstMcpReceipts = await tool(session, 'memory_receipts');
    check('MCP 分类回执带真实路径', firstMcpReceipts.some(item => item.requestId === knowledge.requestId && item.memoryPath === '知识库/条目命名.md'));
    check('候选回执仅保留状态，不作为事实泄出', firstMcpReceipts.some(item => item.requestId === proposed.requestId && item.status === 'completed' && item.detailsHidden === true));
    const candidate = receipts.find(item => item.requestId === proposed.requestId);
    if (!candidate?.memoryId) throw new Error('候选回执缺少真实 memoryId。');
    const candidateRecord = await cliJson(vault, ['get', '--id', candidate.memoryId]);
    check('profile 分类不会自动提升候选确认状态', candidateRecord.record?.meta?.status === 'pending');
    const candidateSearch = await tool(session, 'memory_search', { text: '组织验收偏好', limit: 50 });
    check('候选尚未进入 MCP 事实搜索', Array.isArray(candidateSearch.hits)
      && !candidateSearch.hits.some(item => item.id === candidate.memoryId || item.path === candidate.path));

    const confirmation = await cliJson(vault, ['confirm', '--id', candidate.memoryId]);
    check('跨目录候选确认仍走外部排队', confirmation.accepted === true);
    const secondCommit = await commit();
    check('插件完成候选确认', secondCommit.processed === 1 && secondCommit.status === 'completed', JSON.stringify(secondCommit));
    const profileSearch = await tool(session, 'memory_search', { text: '组织验收偏好' });
    check('确认后 MCP 能从自定义目录搜索', profileSearch.hits?.some(item => item.id === candidate.memoryId && item.path === '资料/人物/个人偏好.md'));
    const waited = await tool(session, 'memory_wait_receipt', { id: confirmation.requestId, timeoutSeconds: 1 });
    check('MCP 回执回读保留自定义目录和 completed', waited.status === 'completed' && waited.memoryPath === '资料/人物/个人偏好.md');

    const templateReceipt = receipts.find(item => item.requestId === template.requestId);
    if (!templateReceipt?.memoryId) throw new Error('模板回执缺少真实 memoryId。');
    const templateCliSearch = await cliJson(vault, ['search', '--text', '组织验收模板', '--limit', '50']);
    check('模板在 CLI 事实搜索中排除', Array.isArray(templateCliSearch.hits)
      && !templateCliSearch.hits.some(item => item.id === templateReceipt.memoryId || item.path === templateReceipt.path));
    const templateMcpSearch = await tool(session, 'memory_search', { text: '组织验收模板', limit: 50 });
    check('模板在 MCP 事实搜索中排除', Array.isArray(templateMcpSearch.hits)
      && !templateMcpSearch.hits.some(item => item.id === templateReceipt.memoryId || item.path === templateReceipt.path));
    const templateGet = await tool(session, 'memory_get', { id: templateReceipt.memoryId });
    check('按 ID 读取不能绕过模板的模型可见性限制', templateGet.found === false && !JSON.stringify(templateGet).includes('组织验收模板'));
    const templateView = (await tool(session, 'memory_receipts')).find(item => item.requestId === template.requestId);
    check('模板回执不泄露标题或路径', templateView?.detailsHidden === true && templateView.memoryPath === undefined);
    for (const [relative, content] of ordinary) check(`普通笔记字节保持：${relative}`, await readFile(path.join(vault, relative), 'utf8') === content);
    const replay = await commit();
    check('队列重放没有重复提交', replay.processed === 0);
  } finally {
    try { if (session) await session.stop(); }
    finally {
      try { if (harness) await harness.dispose(); }
      finally { await rm(vault, { recursive: true, force: true }); }
    }
  }
}

try { await main(); }
catch (error) { failures.push(error instanceof Error ? error.stack ?? error.message : String(error)); }
for (const item of passes) console.log(`PASS ${item}`);
for (const item of failures) console.error(`FAIL ${item}`);
console.log(`分类合成验收：${passes.length} pass / ${failures.length} fail；不代表原生 Obsidian 验收。`);
process.exitCode = failures.length === 0 ? 0 : 1;

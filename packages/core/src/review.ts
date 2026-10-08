/**
 * 复盘：发现问题、给证据、给可执行修正、并复测。
 *
 * 设计原则：
 * - **先确定性检查，再考虑模型**。重复、冲突、过期、引用不可复核、检索失败，
 *   全部可以本地算出来；没有模型时这些结论照样成立。
 * - 每条结论必须带证据与影响范围；证据不足时允许“无结论”，不为完成复盘硬生成。
 * - AI 只能产出候选（pending）；用户明确纠错才直接生效。
 * - 结果里区分 `retrieved` 与 `delivered`，不把“检索到了”算成“送进模型了”。
 */

import { shortHash } from './hash.js';
import { normalizeForDedupe } from './record.js';
import { readTitle } from './search-index.js';
import type { MemoryRecord, MemoryStatus } from './types.js';
import type { AiProvider } from './ai.js';
import { extractJsonPayload } from './ai.js';

export type ProblemKind =
  | 'duplicate'
  | 'conflict'
  | 'stale'
  | 'missing' // 漏记：允许读取的来源里有、记忆里没有
  | 'retrieval_failure' // 存在却搜不到
  | 'unsupported_source' // 来源不可复核（没有读取权限 / 已被删除）
  | 'unused' // 送到了但没被采用（需要宿主回执，缺失时为 unknown）
  | 'unknown'; // 证据不足

export interface ReviewEvidence {
  kind: 'memory' | 'source' | 'index' | 'job' | 'model';
  ref: string;
  /** 人类可读的说明。 */
  detail: string;
  /** 摘录（可能为空）。 */
  excerpt?: string;
  /**
   * 该证据是否已核对过：引用必须命中本次允许的输入，
   * 且给出的引文必须能在对应原文里找到。
   * 未核对的证据只用于展示，不构成任何动作的授权依据。
   */
  verified?: boolean;
}

export interface ReviewSuggestion {
  id: string;
  kind: ProblemKind;
  /** 一句话问题描述。 */
  title: string;
  detail: string;
  /** 影响范围。 */
  impact: {
    memoryIds: string[];
    scopes: string[];
  };
  evidence: ReviewEvidence[];
  /** 建议动作；没有足够证据时可以是 `unknown`。 */
  action:
    | { type: 'no_action'; reason: string }
    | { type: 'propose_memory'; draft: { body: string; kind?: string; tags?: string[] } }
    | { type: 'correct_memory'; targetId: string; replacement: string }
    | { type: 'supersede'; targetId: string; draft: { body: string } }
    | { type: 'mark_disputed'; targetId: string; note: string }
    | { type: 'expire'; targetId: string; at: string }
    | { type: 'schedule_review'; targetId: string; at: string }
    | { type: 'rebuild_index' }
    | { type: 'propose_method'; problem: string; method: string };
  /** 处理状态，由调用方维护。 */
  status: 'open' | 'accepted' | 'ignored';
  /** 复测结果：修正后重新跑同一问题集。 */
  retest?: { at: string; passed: boolean | null; note: string };
}

export interface ReviewReport {
  at: string;
  /** 本地确定性检查结果。 */
  suggestions: ReviewSuggestion[];
  /** 模型是否参与了本次复盘。 */
  modelUsed: boolean;
  modelError: string | null;
  /** 统计。 */
  counts: Record<ProblemKind, number>;
  /** 本次复盘的输入摘要，供 UI 显示“这次到底看了什么”。 */
  inputs: {
    memoriesConsidered: number;
    sourcesConsidered: number;
    issueSetSize: number;
  };
}

export interface LocalReviewOptions {
  /** 是否跳过被遗忘/归档记录。默认跳过 archived 与 superseded 的正文比对。 */
  now?: number;
  /** 允许复核的来源读取器；返回 null 表示“无法复核”。 */
  readSource?: (ref: string) => Promise<string | null>;
  /** 判断“明显过期”的阈值天数。 */
  staleGraceDays?: number;
  /**
   * 每条建议 id 生成器，便于测试确定性。
   *
   * 参数里带上 `identity`（受影响记忆的稳定标识与版本哈希）：
   * 建议身份必须由**问题类型 + 受影响记忆 + 版本/证据**构成，
   * 不能用「本轮第几条」。用序号当身份会让「忽略第一组重复」把
   * 后面完全不同的第二组也一起隐藏掉。
   */
  idFactory?: (index: number, kind: ProblemKind, identity: string) => string;
}

/**
 * 建议的稳定身份指纹。
 *
 * 参与计算的只有**稳定标识**：问题类型、受影响记忆 id（排序后）、
 * 以及它们的当前 revision。顺序、显示文本、证据摘录都不参与，
 * 因此同一组问题在多次运行里得到同一个 id；
 * 而「另一组不同的记忆出现同类问题」一定得到不同的 id。
 *
 * 版本参与计算是有意的：内容变化后（revision 变了）建议会**重新开放**，
 * 而不是被上一次的「已忽略」永久遮蔽。
 */
export function suggestionIdentity(
  kind: ProblemKind,
  memoryIds: readonly string[],
  revisions: readonly number[] = [],
): string {
  const ids = [...new Set(memoryIds)].sort();
  const revs = [...revisions].sort((a, b) => a - b);
  return `rv_${kind}_${shortHash(`${kind}|${ids.join(',')}|${revs.join(',')}`)}`;
}

/**
 * 本地确定性复盘。不调用模型、不联网。
 */
export async function runLocalReview(
  records: readonly MemoryRecord[],
  options: LocalReviewOptions = {},
): Promise<ReviewSuggestion[]> {
  const now = options.now ?? Date.now();
  const idFactory = options.idFactory ?? ((index, kind, identity) => identity || `rv_${kind}_${index}`);
  let counter = 0;
  const next = (kind: ProblemKind, memoryIds: readonly string[], revisions: readonly number[] = []): string =>
    idFactory(counter++, kind, suggestionIdentity(kind, memoryIds, revisions));
  const out: ReviewSuggestion[] = [];
  const normalized = new Map<string, MemoryRecord[]>();

  for (const record of records) {
    if (record.meta.status === 'archived') continue;
    const key = normalizeForDedupe(record.body).slice(0, 200);
    if (key === '') continue;
    const bucket = normalized.get(key);
    if (bucket) bucket.push(record);
    else normalized.set(key, [record]);
  }

  // 1) 重复：同源事件、同一内容出现两次
  for (const [, bucket] of normalized) {
    if (bucket.length < 2) continue;
    const ids = bucket.map(r => r.meta.id);
    out.push({
      id: next('duplicate', ids, bucket.map(r => r.meta.revision)),
      kind: 'duplicate',
      title: `有 ${bucket.length} 条记忆的正文完全相同`,
      detail: `归一化后正文一致的记录：${ids.join('、')}。可能是重复来源事件或重复提取。`,
      impact: { memoryIds: ids, scopes: [...new Set(bucket.map(r => scopeLabel(r)))] },
      evidence: bucket.map(record => ({
        kind: 'memory' as const,
        ref: record.path,
        detail: `${record.meta.id}（rev ${record.meta.revision}，来源 ${record.meta.source_kind}:${record.meta.source_ref || '无'}）`,
        excerpt: record.body.slice(0, 160),
      })),
      action: { type: 'mark_disputed', targetId: ids[1]!, note: '疑似重复，等待人工确认保留哪一条' },
      status: 'open',
    });
  }

  // 2) 冲突：同主题、同范围、同样式不同取值的已确认记忆
  const bySubject = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    if (record.meta.status !== 'confirmed') continue;
    const subject = subjectKey(record);
    if (subject === '') continue;
    const bucket = bySubject.get(subject);
    if (bucket) bucket.push(record);
    else bySubject.set(subject, [record]);
  }
  for (const [subject, bucket] of bySubject) {
    if (bucket.length < 2) continue;
    const distinct = new Set(bucket.map(r => normalizeForDedupe(r.body).slice(0, 200)));
    if (distinct.size < 2) continue;
    const ids = bucket.map(r => r.meta.id);
    out.push({
      id: next('conflict', ids, bucket.map(r => r.meta.revision)),
      kind: 'conflict',
      title: `「${subject}」有 ${bucket.length} 条已确认记忆内容不一致`,
      detail:
        '先区分范围与时间，再判断新旧。不要只用“更晚”或“更多次”决定真假；若其中一条明确替代了另一条，请用“替代”而不是“争议”。',
      impact: { memoryIds: ids, scopes: [...new Set(bucket.map(r => scopeLabel(r)))] },
      evidence: bucket.map(record => ({
        kind: 'memory' as const,
        ref: record.path,
        detail: `${record.meta.id} · rev ${record.meta.revision} · 生效 ${record.meta.valid_from || '未知'} · 来源 ${record.meta.source_kind}`,
        excerpt: record.body.slice(0, 160),
      })),
      action: { type: 'mark_disputed', targetId: ids[1]!, note: `与 ${ids[0]} 冲突，等待人工确认` },
      status: 'open',
    });
  }

  // 3) 过期
  const graceMs = (options.staleGraceDays ?? 0) * 86_400_000;
  for (const record of records) {
    if (record.meta.status !== 'confirmed' && record.meta.status !== 'pending') continue;
    const until = Date.parse(record.meta.valid_until);
    if (!Number.isFinite(until) || until + graceMs >= now) continue;
    out.push({
      id: next('stale', [record.meta.id], [record.meta.revision]),
      kind: 'stale',
      title: `「${readTitle(record)}」的有效期已过（${record.meta.valid_until}）`,
      detail: '到期后已退出默认召回，历史保留。若没有新证据，只提出复查，不直接改内容。',
      impact: { memoryIds: [record.meta.id], scopes: [scopeLabel(record)] },
      evidence: [
        {
          kind: 'memory',
          ref: record.path,
          detail: `${record.meta.id} · 有效期至 ${record.meta.valid_until} · 来源 ${record.meta.source_kind}:${record.meta.source_ref || '无'}`,
          excerpt: record.body.slice(0, 160),
        },
      ],
      action: { type: 'schedule_review', targetId: record.meta.id, at: new Date(now).toISOString() },
      status: 'open',
    });
  }

  // 4) 复查到期
  for (const record of records) {
    if (record.meta.status !== 'confirmed') continue;
    const reviewAt = Date.parse(record.meta.review_after);
    if (!Number.isFinite(reviewAt) || reviewAt > now) continue;
    out.push({
      id: next('stale', [record.meta.id], [record.meta.revision]),
      kind: 'stale',
      title: `「${readTitle(record)}」已到复查时间（${record.meta.review_after}）`,
      detail: '复查只需要确认是否仍然成立；没有反向证据就不改动内容。',
      impact: { memoryIds: [record.meta.id], scopes: [scopeLabel(record)] },
      evidence: [
        { kind: 'memory', ref: record.path, detail: `${record.meta.id} · review_after ${record.meta.review_after}` },
      ],
      action: { type: 'no_action', reason: '等待用户复查确认' },
      status: 'open',
    });
  }

  // 5) 来源不可复核
  if (options.readSource) {
    for (const record of records) {
      if (record.meta.status === 'archived') continue;
      for (const source of record.sources) {
        if (source.kind !== 'note' && source.kind !== 'file') continue;
        const text = await options.readSource(source.ref);
        if (text !== null) continue;
        out.push({
          id: next('unsupported_source', [record.meta.id], [record.meta.revision]),
          kind: 'unsupported_source',
          title: `「${readTitle(record)}」的来源无法复核：${source.ref}`,
          detail: '来源文件不存在或没有读取权限。该记忆的可复核性下降，但内容本身不因此失效。',
          impact: { memoryIds: [record.meta.id], scopes: [scopeLabel(record)] },
          evidence: [
            { kind: 'source', ref: source.ref, detail: '读取返回空', excerpt: source.excerpt.slice(0, 160) },
          ],
          action: { type: 'no_action', reason: '缺少可复核来源，标记为“无法复核”而不是判定真假' },
          status: 'open',
        });
      }
    }
  }

  return out;
}

export interface IssueCase {
  id: string;
  query: string;
  /** 期望被返回的记忆 id。 */
  expectIds: string[];
  /** 明确禁止被返回的记忆 id（例如旧版本、已遗忘、待确认）。 */
  forbidIds: string[];
  /** 该问题的类型，用于分层报告。 */
  category?: 'capture' | 'retrieval' | 'delivery' | 'usage' | 'maintenance' | 'guard';
}

export interface IssueOutcome {
  id: string;
  category: IssueCase['category'];
  /** 相关记忆是否被找回。 */
  recalled: boolean;
  /** 无关内容比例（返回里不期望也不禁止的条数 / 返回条数）。 */
  noiseRatio: number;
  /** 是否错误地返回了禁止项。 */
  violated: boolean;
  /** 无答案时是否保持克制（返回空）。 */
  restrained: boolean;
  returnedIds: string[];
  note: string;
}

/**
 * 运行问题集并计算可分层报告的指标。
 *
 * `search` 由调用方注入（通常是 `store.search`），因此这个函数既能测真实索引，
 * 也能测“检索到了但没送进模型”的下游环节。
 */
export async function runIssueSet(
  cases: readonly IssueCase[],
  search: (query: string, limit: number) => Promise<string[]>,
): Promise<{ outcomes: IssueOutcome[]; summary: IssueSummary }> {
  const outcomes: IssueOutcome[] = [];
  for (const testCase of cases) {
    const limit = Math.max(5, testCase.expectIds.length + 3);
    const returnedIds = await search(testCase.query, limit);
    const expected = new Set(testCase.expectIds);
    const forbidden = new Set(testCase.forbidIds);
    const recalled = testCase.expectIds.every(id => returnedIds.includes(id));
    const violated = returnedIds.some(id => forbidden.has(id));
    const relevant = returnedIds.filter(id => expected.has(id)).length;
    const neutral = returnedIds.length - relevant;
    const noiseRatio = returnedIds.length === 0 ? 0 : Math.max(0, neutral) / returnedIds.length;
    const isNoAnswerCase = testCase.expectIds.length === 0 && forbidden.size === 0;
    const restrained = !isNoAnswerCase || returnedIds.length === 0;
    outcomes.push({
      id: testCase.id,
      category: testCase.category,
      recalled,
      noiseRatio,
      violated,
      restrained,
      returnedIds,
      note: describeOutcome({ recalled, violated, restrained, returnedIds, testCase }),
    });
  }
  return { outcomes, summary: summarize(outcomes) };
}

export interface IssueSummary {
  total: number;
  recalled: number;
  violated: number;
  restrained: number;
  averageNoise: number;
  byCategory: Record<string, { total: number; recalled: number; violated: number; averageNoise: number }>;
}

function summarize(outcomes: readonly IssueOutcome[]): IssueSummary {
  const byCategory: IssueSummary['byCategory'] = {};
  let recalled = 0;
  let violated = 0;
  let restrained = 0;
  let noise = 0;
  for (const outcome of outcomes) {
    if (outcome.recalled) recalled += 1;
    if (outcome.violated) violated += 1;
    if (outcome.restrained) restrained += 1;
    noise += outcome.noiseRatio;
    const key = outcome.category ?? 'uncategorized';
    const bucket = (byCategory[key] ??= { total: 0, recalled: 0, violated: 0, averageNoise: 0 });
    bucket.total += 1;
    if (outcome.recalled) bucket.recalled += 1;
    if (outcome.violated) bucket.violated += 1;
    bucket.averageNoise += outcome.noiseRatio;
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.averageNoise = bucket.total === 0 ? 0 : bucket.averageNoise / bucket.total;
  }
  return {
    total: outcomes.length,
    recalled,
    violated,
    restrained,
    averageNoise: outcomes.length === 0 ? 0 : noise / outcomes.length,
    byCategory,
  };
}

function describeOutcome(input: {
  recalled: boolean;
  violated: boolean;
  restrained: boolean;
  returnedIds: string[];
  testCase: IssueCase;
}): string {
  const parts: string[] = [];
  if (input.testCase.expectIds.length > 0) {
    parts.push(input.recalled ? '期望项已找回' : '期望项未被找回');
  } else {
    parts.push('无答案用例');
  }
  if (input.violated) parts.push('返回了禁止项（守卫失败）');
  if (!input.restrained) parts.push('无答案时仍返回了内容（不够克制）');
  parts.push(`返回 ${input.returnedIds.length} 条`);
  return parts.join('；');
}

function scopeLabel(record: MemoryRecord): string {
  return record.meta.scope === 'personal' ? 'personal' : `${record.meta.scope}:${record.meta.scope_ref}`;
}

/**
 * 计算“同主题”键。
 *
 * 中文没有词干，这里用两种信号组合：正文首个 6~20 字的片段 + 标签集合。
 * 目的只是把可能冲突的记录分到一组，最终判断仍由人来做。
 */
function subjectKey(record: MemoryRecord): string {
  const tags = [...record.meta.tags].sort().join(',');
  const firstLine = record.body
    .split(/\r?\n/)
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(line => line !== '' && !line.startsWith('#'));
  if (!firstLine) return '';
  const head = normalizeForDedupe(firstLine).slice(0, 14);
  if (head.length < 4) return '';
  return `${record.meta.scope}:${record.meta.scope_ref}|${tags}|${head}`;
}

/* ------------------------------------------------------------------ */
/* 模型参与的复盘                                                      */
/* ------------------------------------------------------------------ */

export interface AiReviewOptions {
  provider: AiProvider;
  /** 允许发送给模型的片段（调用方已按 allow_model、范围与预算筛过）。 */
  excerpts: Array<{ id: string; title: string; text: string; revision: number }>;
  /** 已确认记忆的精简视图，用于让模型对齐既有事实。 */
  memories: Array<{ id: string; title: string; status: MemoryStatus; body: string }>;
  maxSuggestions?: number;
  /** 语言提示；默认中文。 */
  language?: string;
  signal?: { aborted: boolean };
  /** 取消/暂停后到达的迟到响应必须被拒绝：由调用方给出“是否仍然有效”。 */
  isStillValid?: () => boolean;
}

export interface AiReviewOutcome {
  ok: boolean;
  suggestions: ReviewSuggestion[];
  /** 迟到响应被拒绝时置位。 */
  rejectedLate: boolean;
  error: string | null;
  rawText: string;
  /** 供应商报的真实用量（没有就不填）。只透传，不估算。 */
  usage?: { promptTokens?: number; completionTokens?: number };
}

const REVIEW_SYSTEM_PROMPT = `你是一个 Obsidian 记忆库的复盘助手。
只依据给定的原文片段与既有记忆做判断，不要引入外部知识，不要编造来源。
严格输出 JSON：{"suggestions":[{"kind":"missing|conflict|stale|duplicate|unsupported_source|unknown","title":"...","detail":"...","memory_ids":["..."],"evidence":[{"ref":"...","excerpt":"..."}],"action":{"type":"propose_memory|correct_memory|supersede|mark_disputed|expire|schedule_review|no_action","target_id":"...","body":"...","reason":"..."}}]}
证据不足时用 kind=unknown 且 action.type=no_action，不要为了凑数量编造结论。
不要输出任何 Markdown 代码围栏之外的解释。`;

/** 用模型做语义复盘；产出永远是建议（pending），不会直接改权威正文。 */
export async function runAiReview(options: AiReviewOptions): Promise<AiReviewOutcome> {
  const maxSuggestions = Math.max(1, Math.min(30, options.maxSuggestions ?? 10));
  const userPrompt = [
    `语言：${options.language ?? '简体中文'}`,
    '',
    '## 允许读取的原文片段',
    ...options.excerpts.map(excerpt => `### [${excerpt.id}] rev ${excerpt.revision} ${excerpt.title}\n${truncate(excerpt.text, 2000)}`),
    '',
    '## 既有记忆（只读参考，不要改写它们）',
    ...options.memories.map(memory => `- [${memory.id}] (${memory.status}) ${memory.title}：${truncate(memory.body, 400)}`),
    '',
    `最多给出 ${maxSuggestions} 条建议。`,
  ].join('\n');

  const result = await options.provider.complete({
    messages: [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    maxTokens: 2000,
    json: true,
    signal: options.signal,
  });

  // 迟到结果拦截：取消/暂停后不得写入任何东西。
  if (options.isStillValid && !options.isStillValid()) {
    /**
     * 迟到结果不采纳，但**用量要带出去**：请求已经发出，可能已经计费，
     * 把它丢掉会让账目看起来像没花过钱。
     */
    return {
      ok: false,
      suggestions: [],
      rejectedLate: true,
      error: '任务已被取消或暂停，迟到结果被拒绝。',
      rawText: result.text,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      suggestions: [],
      rejectedLate: false,
      error: result.error ?? '模型调用失败',
      rawText: result.text,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
  const payload = extractJsonPayload(result.text);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      suggestions: [],
      rejectedLate: false,
      error: '模型输出不是合法 JSON，已丢弃。',
      rawText: result.text,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
  const raw = (payload as { suggestions?: unknown }).suggestions;
  const suggestions: ReviewSuggestion[] = [];
  /**
   * A5：把“本次允许的输入”作为证据与目标的唯一合法来源。
   *
   * 审计复现（修复前）：模型返回 `evidence:[{}]`（空对象）与一个不存在的
   * `target_id`，仍然生成了可操作的 `correct_memory` 建议——
   * 因为缺失的 ref 被补成了占位文字「（未提供）」，随后
   * `e.ref !== ''` 把占位文字当成了真证据。
   *
   * 现在：占位文字只用于展示；真实 ref 必须命中本次允许的片段或记忆 id；
   * 引文片段必须能在对应输入里找到；目标 id 必须存在于允许集合。
   */
  const allowed = {
    excerptIds: new Set(options.excerpts.map(excerpt => excerpt.id)),
    memoryIds: new Set(options.memories.map(memory => memory.id)),
    excerptTexts: new Map(options.excerpts.map(excerpt => [excerpt.id, excerpt.text])),
    memoryBodies: new Map(options.memories.map(memory => [memory.id, memory.body])),
  };
  if (Array.isArray(raw)) {
    let index = 0;
    for (const item of raw.slice(0, maxSuggestions)) {
      const parsed = parseSuggestion(item, index++, allowed);
      if (parsed) suggestions.push(parsed);
    }
  }
  return {
    ok: true,
    suggestions,
    rejectedLate: false,
    error: null,
    rawText: result.text,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

/** 允许作为证据/目标的输入集合。 */
export interface ReviewAllowedInput {
  excerptIds: Set<string>;
  memoryIds: Set<string>;
  excerptTexts: Map<string, string>;
  memoryBodies: Map<string, string>;
}

function parseSuggestion(item: unknown, index: number, allowed: ReviewAllowedInput): ReviewSuggestion | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Record<string, unknown>;
  const kind = normalizeKind(raw.kind);
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : `模型建议 ${index + 1}`;
  const detail = typeof raw.detail === 'string' ? raw.detail : '';
  const memoryIds = (Array.isArray(raw.memory_ids) ? raw.memory_ids.filter(x => typeof x === 'string') : []).filter(id =>
    allowed.memoryIds.has(id),
  );
  const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
  const evidence: ReviewEvidence[] = [];
  for (const entry of evidenceRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const rawRef = typeof e.ref === 'string' ? e.ref.trim() : '';
    /**
     * 只有能对上本次输入的引用才算证据。
     * 对不上的仍然展示（用 `unverified` 标记），但不参与 `hasEvidence` 判定。
     */
    const verified = rawRef !== '' && (allowed.excerptIds.has(rawRef) || allowed.memoryIds.has(rawRef));
    const excerpt = typeof e.excerpt === 'string' ? e.excerpt : undefined;
    let excerptVerified = false;
    if (verified && excerpt !== undefined && excerpt.trim() !== '') {
      const haystack = allowed.excerptTexts.get(rawRef) ?? allowed.memoryBodies.get(rawRef) ?? '';
      // 空白差异不算差异；除此之外必须能在原文里找到。
      const needle = excerpt.trim().replace(/\s+/g, ' ');
      const normalized = haystack.replace(/\s+/g, ' ');
      excerptVerified = normalized.includes(needle);
    }
    evidence.push({
      kind: 'memory',
      ref: verified ? rawRef : rawRef === '' ? '（模型未提供引用）' : `（无法核对：${rawRef}）`,
      detail: typeof e.detail === 'string' ? e.detail : '模型给出的证据',
      excerpt,
      // 只有“引用命中 + 引文可核验”才算真证据。
      verified: verified && (excerpt === undefined || excerptVerified),
    });
  }
  const actionRaw = raw.action && typeof raw.action === 'object' ? (raw.action as Record<string, unknown>) : {};
  const action = parseAction(actionRaw, evidence, allowed);
  return {
    id: `rv_ai_${index}`,
    kind,
    title,
    detail,
    impact: { memoryIds, scopes: [] },
    evidence,
    action,
    status: 'open',
  };
}

function parseAction(
  action: Record<string, unknown>,
  evidence: readonly ReviewEvidence[],
  allowed: ReviewAllowedInput,
): ReviewSuggestion['action'] {
  const type = typeof action.type === 'string' ? action.type : 'no_action';
  const targetId = typeof action.target_id === 'string' ? action.target_id : '';
  /**
   * A5：证据门槛只看**已核验**的证据。
   * 空对象、占位文字、对不上输入的引用都不算。
   */
  const hasEvidence = evidence.some(e => e.verified === true);
  const body = typeof action.body === 'string' ? action.body : '';
  /** 会改写某条记忆的动作，目标必须存在于本次允许的输入里。 */
  const mutating = new Set(['correct_memory', 'supersede', 'mark_disputed', 'expire', 'schedule_review']);
  if (mutating.has(type) && (targetId === '' || !allowed.memoryIds.has(targetId))) {
    return {
      type: 'no_action',
      reason: `模型建议的目标 id「${targetId || '（空）'}」不在本次允许修改的记忆集合内，已降级为不动作。`,
    };
  }
  // 没有证据的“修正/替代”一律降级为“无动作”，防止模型凭空改内容。
  if ((type === 'correct_memory' || type === 'supersede') && (!hasEvidence || body.trim() === '')) {
    return { type: 'no_action', reason: '模型建议缺少可核对证据（引用必须命中本次允许的输入），已降级为不动作。' };
  }
  switch (type) {
    case 'propose_memory':
      return body.trim() === ''
        ? { type: 'no_action', reason: '模型建议缺少正文。' }
        : { type: 'propose_memory', draft: { body } };
    case 'correct_memory':
      return { type: 'correct_memory', targetId, replacement: body };
    case 'supersede':
      return { type: 'supersede', targetId, draft: { body } };
    case 'mark_disputed':
      return { type: 'mark_disputed', targetId, note: typeof action.reason === 'string' ? action.reason : '模型建议复查' };
    case 'expire':
      return { type: 'expire', targetId, at: typeof action.at === 'string' ? action.at : '' };
    case 'schedule_review':
      return { type: 'schedule_review', targetId, at: typeof action.at === 'string' ? action.at : '' };
    case 'rebuild_index':
      return { type: 'rebuild_index' };
    case 'propose_method':
      return {
        type: 'propose_method',
        problem: typeof action.problem === 'string' ? action.problem : '',
        method: typeof action.method === 'string' ? action.method : '',
      };
    default:
      return { type: 'no_action', reason: typeof action.reason === 'string' ? action.reason : '模型未给出可执行动作。' };
  }
}

function normalizeKind(value: unknown): ProblemKind {
  const text = typeof value === 'string' ? value : '';
  const allowed: ProblemKind[] = [
    'duplicate',
    'conflict',
    'stale',
    'missing',
    'retrieval_failure',
    'unsupported_source',
    'unused',
    'unknown',
  ];
  return (allowed as string[]).includes(text) ? (text as ProblemKind) : 'unknown';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 供界面展示的「接受这条建议会做什么」。
 *
 * 界面必须能在动手之前把动作讲清楚：`propose_memory` 只会新建**候选**，
 * `correct_memory` / `supersede` 才触及权威内容，`no_action` 什么也不做。
 * 含糊的「接受」按钮会让用户以为自己在确认一件事实，实际却改了别的。
 */
export function describeSuggestion(suggestion: ReviewSuggestion): string {
  const lines: string[] = [];
  lines.push(`问题类型：${suggestion.kind}`);
  lines.push(`影响的记忆：${suggestion.impact.memoryIds.join('、') || '（无）'}`);
  const verified = suggestion.evidence.filter(item => item.verified !== false).length;
  lines.push(`证据 ${suggestion.evidence.length} 条（其中已核对 ${verified} 条）`);
  lines.push('');
  const action = suggestion.action;
  switch (action.type) {
    case 'propose_memory':
      lines.push('接受后会新建一条**待确认候选**，不会直接成为权威事实。');
      lines.push(`候选正文：${action.draft.body}`);
      break;
    case 'correct_memory':
      lines.push(`接受后会把 ${action.targetId} 的正文替换为建议内容（这是一次权威改写，会要求确认）。`);
      lines.push(`新正文：${action.replacement}`);
      break;
    case 'supersede':
      lines.push(`接受后会新建一条记忆并让 ${action.targetId} 退出默认召回（历史保留）。`);
      break;
    case 'mark_disputed':
      lines.push(`接受后会把 ${action.targetId} 标记为有争议，等待人工判断。`);
      lines.push(`说明：${action.note}`);
      break;
    case 'expire':
      lines.push(`接受后会把 ${action.targetId} 的有效期设为 ${action.at}，退出默认召回。`);
      break;
    case 'schedule_review':
      lines.push(`接受后会为 ${action.targetId} 安排 ${action.at} 的复查。`);
      break;
    case 'rebuild_index':
      lines.push('接受后会重建检索索引（索引是派生物，可随时重建）。');
      break;
    case 'propose_method':
      lines.push('接受后会生成一个 MSE 方法候选包（离线、可选，不影响本插件独立运行）。');
      break;
    case 'no_action':
    default:
      lines.push(`这条建议不包含可执行动作（no_action）：${'reason' in action ? action.reason : '证据不足'}`);
      break;
  }
  return lines.join('\n');
}

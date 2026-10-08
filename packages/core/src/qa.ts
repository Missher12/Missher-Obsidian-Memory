/**
 * 带来源问答与“检索到 / 已送入 / 已采用”三层区分。
 *
 * 三个状态绝不混为一谈：
 * - `retrieved`：检索给出了结果
 * - `delivered`：真正进入了送给模型的上下文（受预算、去重、allow_model 限制）
 * - `used`：模型输出里确实引用了该来源
 *
 * 展示层可以因此回答“搜到了却没送进去”和“送进去了却没被采用”这两个不同问题。
 */

import { sha256Hex } from './hash.js';
import type { SearchResult } from './search-index.js';
import { extractJsonPayload, type AiProvider } from './ai.js';

/** 上下文构建只依赖检索结果的形状，这里给一个结构化别名便于阅读。 */
type SearchHit = SearchResult['hits'][number];

export interface ContextItem {
  /** 记忆 id。 */
  id: string;
  title: string;
  text: string;
  /** 来源定位符，用于跳转与引用。 */
  ref: string;
  revision: number;
  status: string;
  score: number;
}

export interface ContextBundle {
  items: ContextItem[];
  /** 每个被考虑但未进入上下文的条目及原因。 */
  dropped: Array<{ id: string; reason: string }>;
  budget: { maxChars: number; usedChars: number; maxItems: number };
}

export interface ContextBuildOptions {
  maxChars?: number;
  maxItems?: number;
  /** 允许进入上下文的记忆 id 白名单（用于 `allow_model`、范围与授权过滤）。 */
  allowIds?: Set<string> | null;
}

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_ITEMS = 8;
/** 截断后缀；必须从预算里预留，不能事后追加。 */
const TRUNCATION_SUFFIX = '…（已截断）';
/**
 * 来源块外层包装的固定开销：`\n\n## 来源\n`（问题行之后的部分）。
 * 预算要按**真正送出去的整块**计账，所以这部分也要算进去。
 */
const SOURCE_BLOCK_WRAPPER_CHARS = '\n\n## 来源\n'.length;
/** 放不下这么多内容就不放这一条：宁可少给，也不越界。 */
const MIN_ITEM_CHARS = 60;

/**
 * 单条来源在提示里的**精确**文本形态。
 *
 * 预算、发送与预览三处必须用同一个函数生成同一串字符，
 * 否则“预算预览”和“真正发出去的”就会不一样：
 * 修复前的实现按 `[id] title（rev n，来源 x）` 计费，
 * 实际拼进去的却是 `### [id] title（rev n）\n内容...`。
 */
function formatContextItem(item: Pick<ContextItem, 'id' | 'title' | 'revision' | 'text'>): string {
  return `### [${item.id}] ${item.title}（rev ${item.revision}）\n${item.text}`;
}

/**
 * 在给定字符预算内生成来源块。
 *
 * 返回的 `text` 长度**严格不超过** `limit`；放不下的条目不出现，
 * 由调用方记录原因。截断时会为后缀预留位置。
 */
function fitItemText(raw: string, limit: number): string {
  if (raw.length <= limit) return raw;
  if (limit <= TRUNCATION_SUFFIX.length) return raw.slice(0, limit);
  return `${raw.slice(0, limit - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

/**
 * 从检索结果构建送模型的上下文。
 *
 * - 去重：同 id、同正文哈希只保留最高分的一条。
 * - 预算：按分数降序填充，超出预算的明确记录原因（不静默丢弃）。
 * - 顺序稳定：相同输入必然得到相同上下文，便于复现与比对。
 */
export function buildContext(hits: readonly SearchHit[], records: (id: string) => { body: string; sourceRef: string } | null, options: ContextBuildOptions = {}): ContextBundle {
  /**
   * `maxChars` 是**调用方给的硬上限**，这里不设最小值：
   * 曾经写成 `Math.max(200, ...)`，于是 UI 传 50 会被静默放大到 200——
   * 「上限」变成了建议。核心只接受、不放大；界面若想限制输入，
   * 应在设置层提示与校验，而不是在发送层偷偷改数。
   */
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
  const blockChars = Math.max(0, maxChars - SOURCE_BLOCK_WRAPPER_CHARS);
  const maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS);
  const items: ContextItem[] = [];
  const dropped: ContextBundle['dropped'] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  let usedChars = 0;

  for (const hit of hits) {
    if (seenIds.has(hit.id)) {
      dropped.push({ id: hit.id, reason: '同一次检索里重复出现，已去重。' });
      continue;
    }
    if (options.allowIds && !options.allowIds.has(hit.id)) {
      dropped.push({ id: hit.id, reason: '不在允许发送给模型的白名单内（范围或 allow_model 限制）。' });
      continue;
    }
    const record = records(hit.id);
    if (!record) {
      dropped.push({ id: hit.id, reason: '记录已不在库中（可能刚被删除）。' });
      continue;
    }
    const hash = sha256Hex(record.body.trim());
    if (seenHashes.has(hash)) {
      dropped.push({ id: hit.id, reason: '与已选内容正文完全相同，已去重。' });
      continue;
    }
    if (items.length >= maxItems) {
      dropped.push({ id: hit.id, reason: `超出最大条数 ${maxItems}。` });
      continue;
    }
    const snippetText =
      hit.snippets.length > 0 ? hit.snippets.map(snippet => snippet.text).join('\n') : record.body;
    /**
     * 预算按**真实序列化**计账：
     * 先减去本条已有的前缀与分隔符，再看剩下多少能放正文。
     */
    const probe = {
      id: hit.id,
      title: hit.title,
      revision: hit.revision,
      text: snippetText,
    };
    const prefixLength = formatContextItem({ ...probe, text: '' }).length;
    const separator = items.length === 0 ? '' : '\n\n';
    const remaining = blockChars - usedChars - separator.length - prefixLength;
    if (remaining < MIN_ITEM_CHARS) {
      dropped.push({ id: hit.id, reason: `超出上下文预算 ${maxChars} 字符。` });
      continue;
    }
    const text = fitItemText(snippetText, remaining);
    items.push({
      id: hit.id,
      title: hit.title,
      text,
      ref: hit.path,
      revision: hit.revision,
      status: hit.status,
      score: hit.score,
    });
    seenIds.add(hit.id);
    seenHashes.add(hash);
    usedChars += separator.length + prefixLength + text.length;
  }

  return { items, dropped, budget: { maxChars, usedChars, maxItems } };
}

/**
 * 回答的**支持状态**。
 *
 * 结构核验不等于事实正确：本产品能证明的是「引用确实指向本次送进去的来源」，
 * 不能证明「该来源在语义上支持这个结论」。因此这里只区分三件事，
 * 并且绝不把第三件当成第一件发布：
 *
 * - `supported`：正文里的每一条 `[mem_…]` 都指向本次交付的来源，且至少引用了 1 条。
 * - `no_sources`：检索/预算范围内没有可交付的来源（明确弃答，不是错误）。
 * - `unsupported`：模型给了事实性正文，但引用为零、引用了未知 id、
 *   或引用了**没被送进去**的 id。这类正文不能作为“带来源回答”发布。
 */
export type AnswerSupport = 'supported' | 'unsupported' | 'no_sources';

export interface QaResult {
  ok: boolean;
  answer: string;
  /** 送入模型的来源 id（按进入顺序）。 */
  delivered: string[];
  /** 模型输出里引用的、且**确实在本次交付集合内**的来源 id。 */
  cited: string[];
  /**
   * 正文里引用的、但**不在**本次交付集合内的 id（含不存在的伪造 id）。
   * 这些引用不能当作依据，必须显式暴露，而不是从数组里悄悄滤掉。
   */
  citationsInvalid: string[];
  /** 引用核验结论；`unsupported` 时 `answer` 不得作为带来源回答发布。 */
  support: AnswerSupport;
  /**
   * 未支持正文的原样保留（便于排查模型行为）。
   * 只有 `support === 'unsupported'` 时有值；UI 必须与正式回答区分展示。
   */
  unverifiedAnswer: string | null;
  /** 是否属于「依据不足」的弃答（明确说明缺什么，而不是编答案）。 */
  refused: boolean;
  /** 检索到但没送进模型的来源及原因。 */
  retrievedNotDelivered: Array<{ id: string; reason: string }>;
  /** 送进去了但一次也没被引用。 */
  deliveredNotCited: string[];
  /** 模型是否参与。没有模型时返回明确的“未配置”而不是编造答案。 */
  modelUsed: boolean;
  /**
   * 供应商报的真实用量（没有就不填）。
   *
   * 只做**透传**：这里不估算、不补零。调用方（插件）用它把持久账
   * 从「预占的估算」对账成实测值；缺了它账目就只能标成估算。
   */
  usage?: { promptTokens?: number; completionTokens?: number };
  /**
   * 请求是否**已经发出**（发送前被拒 = false）。
   *
   * 调用方据此决定预占是退回还是保留：`timed_out` / `cancelled` 都是 true，
   * 因为「本端停止等待」不等于远端没有收到、没有计费。
   */
  sentToProvider: boolean;
  error: string | null;
  bundle: ContextBundle;
  /** 检索诊断，用于解释“为什么没有返回某条”。 */
  diagnosis: SearchResult['diagnosis'] | null;
}

const QA_SYSTEM_PROMPT = `你是只依据给定来源作答的助手。
规则：
1. 只能使用“来源”里出现的信息；不得使用外部知识，不得补全没有依据的细节。
2. 每个结论后面必须标注来源 id，格式为 [mem_xxxxxxxx]。
3. 如果来源不足以回答，直接回答「根据现有记忆无法回答」，并说明还缺什么。
4. 不要引用没有出现在来源里的 id。不要输出与问题无关的来源。
5. 用简体中文回答，除非问题本身是其它语言。`;

/** 只用检索到的片段回答，带来源，不凭空补齐。 */
export async function answerWithSources(input: {
  question: string;
  retrieval: SearchResult;
  records: (id: string) => { body: string; sourceRef: string } | null;
  provider: AiProvider | null;
  contextOptions?: ContextBuildOptions;
  signal?: { aborted: boolean };
}): Promise<QaResult> {
  const bundle = buildContext(input.retrieval.hits, input.records, input.contextOptions);
  const retrievedNotDelivered = bundle.dropped;

  if (!input.provider) {
    return {
      ok: false,
      answer: '未配置模型，无法生成带来源的回答。检索本身可用：请直接查看下面的相关记忆。',
      delivered: [],
      cited: [],
      citationsInvalid: [],
      support: 'no_sources',
      unverifiedAnswer: null,
      refused: false,
      retrievedNotDelivered,
      deliveredNotCited: [],
      modelUsed: false,
      sentToProvider: false,
      error: 'no_provider',
      bundle,
      diagnosis: input.retrieval.diagnosis,
    };
  }
  if (bundle.items.length === 0) {
    return {
      ok: true,
      answer: '根据现有记忆无法回答：在允许的范围内没有检索到相关记忆。',
      delivered: [],
      cited: [],
      citationsInvalid: [],
      support: 'no_sources',
      unverifiedAnswer: null,
      refused: true,
      retrievedNotDelivered,
      deliveredNotCited: [],
      modelUsed: false,
      sentToProvider: false,
      error: null,
      bundle,
      diagnosis: input.retrieval.diagnosis,
    };
  }

  const sourceBlock = bundle.items
    .map(item => `### [${item.id}] ${item.title}（rev ${item.revision}）\n${item.text}`)
    .join('\n\n');
  const result = await input.provider.complete({
    messages: [
      { role: 'system', content: QA_SYSTEM_PROMPT },
      { role: 'user', content: `问题：${input.question}\n\n## 来源\n${sourceBlock}` },
    ],
    temperature: 0,
    maxTokens: 1200,
    signal: input.signal,
  });
  if (!result.ok) {
    return {
      ok: false,
      answer: '',
      delivered: bundle.items.map(item => item.id),
      cited: [],
      citationsInvalid: [],
      support: 'unsupported',
      unverifiedAnswer: null,
      refused: false,
      retrievedNotDelivered,
      deliveredNotCited: bundle.items.map(item => item.id),
      modelUsed: false,
      /** 传输失败也要如实区分「发出去了」和「没发出去」。 */
      sentToProvider: result.delivered === true,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      error: result.error ?? '模型调用失败',
      bundle,
      diagnosis: input.retrieval.diagnosis,
    };
  }
  const delivered = bundle.items.map(item => item.id);
  const checked = checkCitations(result.text, delivered);
  const refused = isRefusalText(result.text);

  /**
   * 发布门禁。
   *
   * 修复前：provider 传输成功 = 产品问答成功，于是「来源只说她住在北京，
   * 模型答东京且不含任何引用」被标记 `ok:true` 原样发布；
   * 伪造 `[mem_deadbeef]` 也只是从 cited 数组里被悄悄滤掉，正文照旧展示。
   *
   * 现在的规则：
   * - 引用了**未知/未交付** id → `unsupported`：正文里混着无法核验的引用，
   *   整篇都不能当成“带来源回答”。
   * - 没有任何引用且不是明确弃答 → `unsupported`：事实性结论没有可核验依据。
   * - 明确的「根据现有记忆无法回答」→ `refused`，这是**合规的弃答**，
   *   与“模型偷偷编答案”区分开，不当作错误。
   *
   * 注意边界：`supported` 只说明引用**形式上指向了本次交付的来源**，
   * 不说明该来源在语义上支持结论。本产品不做真实性声明。
   */
  const unsupported = !refused && (checked.invalid.length > 0 || checked.valid.length === 0);
  return {
    /**
     * 未支持的回答**不是成功**。
     *
     * 传输成功只是传输成功；把 `ok` 置为 true 会让任何只看 `ok` 的界面
     * （包括未来的我自己）把未经核验的结论当作“带来源回答”发布。
     * `unverifiedAnswer` 保留原样文本，供排查模型行为，但必须与正式回答
     * 分开呈现——它没有通过引用门禁。
     */
    ok: !unsupported,
    answer: unsupported ? '' : result.text,
    delivered,
    cited: checked.valid,
    citationsInvalid: checked.invalid,
    support: unsupported ? 'unsupported' : 'supported',
    unverifiedAnswer: unsupported ? result.text : null,
    refused,
    retrievedNotDelivered,
    deliveredNotCited: delivered.filter(id => !checked.valid.includes(id)),
    modelUsed: true,
    sentToProvider: true,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    error: unsupported
      ? checked.invalid.length > 0
        ? `回答包含无法核验的来源引用（${checked.invalid.join('、')}）或没有有效引用，未作为带来源回答发布。`
        : '回答没有引用任何交付给它的来源，未作为带来源回答发布。'
      : null,
    bundle,
    diagnosis: input.retrieval.diagnosis,
  };
}

/**
 * 引用核验：区分「有效的」与「未知/未交付的」。
 *
 * 不再把非法引用静默过滤掉——被剔除的引用会写进 `invalid`，
 * 由调用方决定怎么展示；但**正文是否可发布**已经由上面的门禁决定。
 */
export function checkCitations(
  text: string,
  allowed: readonly string[],
): { valid: string[]; invalid: string[] } {
  const allowedSet = new Set(allowed);
  const valid: string[] = [];
  const invalid: string[] = [];
  const re = /\[(mem_[0-9a-zA-Z_]{4,40})\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const id = match[1]!;
    if (allowedSet.has(id)) {
      if (!valid.includes(id)) valid.push(id);
    } else if (!invalid.includes(id)) {
      invalid.push(id);
    }
  }
  return { valid, invalid };
}

/**
 * 兼容旧调用：只返回有效引用。
 * 需要区分非法引用时请用 `checkCitations`。
 */
export function extractCitations(text: string, allowed: readonly string[]): string[] {
  return checkCitations(text, allowed).valid;
}

/** 是否属于明确的「依据不足」弃答。 */
export function isRefusalText(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return (
    normalized.includes('根据现有记忆无法回答') ||
    normalized.includes('根据现有记忆，无法回答') ||
    normalized.includes('现有记忆不足') ||
    /cannotanswerbasedonthe(available|provided)memor/i.test(text)
  );
}

/* ------------------------------------------------------------------ */
/* 选定内容的提取                                                      */
/* ------------------------------------------------------------------ */

export interface ExtractionCandidate {
  title: string;
  body: string;
  kind: string;
  tags: string[];
  aliases: string[];
  /** 支持该候选的原文片段（必须来自输入，不能是模型编的）。 */
  evidence: string[];
  /** 模型自己的置信度，仅供参考，不作为“已确认”依据。 */
  confidence: number;
}

export interface ExtractionResult {
  ok: boolean;
  candidates: ExtractionCandidate[];
  /** 被拒绝的候选与原因（例如证据不在原文里）。 */
  rejected: Array<{ candidate: ExtractionCandidate; reason: string }>;
  error: string | null;
  modelUsed: boolean;
  /** 供应商报的真实用量（没有就不填）。只透传，不估算。 */
  usage?: { promptTokens?: number; completionTokens?: number };
}

const EXTRACT_SYSTEM_PROMPT = `你是一个记忆提取器。从给定文本里提取值得长期记住的内容。
严格输出 JSON：{"candidates":[{"title":"不超过30字","body":"一到三段事实陈述","kind":"preference|fact|person|project|knowledge|event|decision|note","tags":["..."],"aliases":["..."],"evidence":["原文中的原句"],"confidence":0.0}]}
规则：
1. evidence 必须是输入原文中**逐字出现**的句子，不得改写。找不到原句就不要提取。
2. 不要提取寒暄、临时状态、命令本身（例如“记住这个”这几个字）。
3. 一条候选只表达一个可独立更新的事实。
4. 提取不到就返回 {"candidates":[]}，不要凑数。`;

/**
 * 从选定文本里提取候选。**产出永远是 pending**，由用户确认后才进入已确认事实。
 * 提取阶段还会做证据核对：原文里找不到的 evidence 直接剔除，防止模型幻觉入库。
 */
export async function extractCandidates(input: {
  text: string;
  provider: AiProvider;
  maxCandidates?: number;
  /** 允许发送给模型的文本上限。 */
  maxChars?: number;
  signal?: { aborted: boolean };
  title?: string;
}): Promise<ExtractionResult> {
  const maxCandidates = Math.max(1, Math.min(20, input.maxCandidates ?? 6));
  const maxChars = Math.max(200, input.maxChars ?? 12_000);
  const source = input.text.length > maxChars ? input.text.slice(0, maxChars) : input.text;
  const result = await input.provider.complete({
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${input.title ? `文档标题：${input.title}\n\n` : ''}## 文本\n${source}\n\n最多提取 ${maxCandidates} 条。`,
      },
    ],
    temperature: 0,
    maxTokens: 2000,
    json: true,
    signal: input.signal,
  });
  if (!result.ok) {
    return {
      ok: false,
      candidates: [],
      rejected: [],
      error: result.error ?? '模型调用失败',
      /**
       * 传输失败也要带上用量：有些供应商在中止/错误响应里照样报了 usage，
       * 而这次调用**确实花掉了钱**。丢掉它就等于把账目做成 0。
       */
      modelUsed: result.delivered === true,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
  const payload = extractJsonPayload(result.text);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      candidates: [],
      rejected: [],
      error: '模型输出不是合法 JSON，已丢弃。',
      modelUsed: true,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  }
  const raw = (payload as { candidates?: unknown }).candidates;
  const candidates: ExtractionCandidate[] = [];
  const rejected: ExtractionResult['rejected'] = [];
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, maxCandidates)) {
      const parsed = parseCandidate(item);
      if (!parsed) continue;
      /**
       * Q2：先把证据归一化并**剔除空白项**，再做「至少一条可核验」的判断。
       *
       * 曾经的写法直接 `normalizedSource.includes(normalizeWhitespace(quote))`：
       * 空串或全空白的 quote 归一化后是 `''`，而
       * `'任意文本'.includes('') === true`，于是**没有证据**的候选
       * 被当成「逐字命中原文」放行，虚构内容拿到了「有原文依据」的假标记。
       */
      const normalizedSource = normalizeWhitespace(source);
      const evidence = parsed.evidence
        .map(quote => ({ raw: quote, normalized: normalizeWhitespace(quote) }))
        .filter(entry => entry.normalized !== '');
      const blankEvidenceCount = parsed.evidence.length - evidence.length;
      if (evidence.length === 0) {
        rejected.push({
          candidate: parsed,
          reason:
            blankEvidenceCount > 0
              ? `证据为空或只有空白（${blankEvidenceCount} 条），不构成原文依据，已剔除。`
              : '模型没有给出原文证据，已剔除（防止凭空入库）。',
        });
        continue;
      }
      const missing = evidence.filter(entry => !normalizedSource.includes(entry.normalized));
      if (missing.length > 0) {
        rejected.push({
          candidate: parsed,
          reason: `证据在原文中找不到：${missing.map(entry => `「${entry.raw.slice(0, 40)}」`).join('、')}`,
        });
        continue;
      }
      candidates.push({ ...parsed, evidence: evidence.map(entry => entry.normalized) });
    }
  }
  return {
    ok: true,
    candidates,
    rejected,
    error: null,
    modelUsed: true,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

function parseCandidate(item: unknown): ExtractionCandidate | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Record<string, unknown>;
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (body === '') return null;
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : body.slice(0, 30);
  const kind = typeof raw.kind === 'string' ? raw.kind : 'fact';
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((x): x is string => typeof x === 'string') : [];
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((x): x is string => typeof x === 'string') : [];
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter((x): x is string => typeof x === 'string') : [];
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  return { title, body, kind, tags, aliases, evidence, confidence };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 给 UI 用的可读上下文预览。 */
export function renderContextPreview(bundle: ContextBundle): string {
  const lines: string[] = [`预算：${bundle.budget.usedChars}/${bundle.budget.maxChars} 字符，最多 ${bundle.budget.maxItems} 条`];
  lines.push('');
  for (const item of bundle.items) {
    lines.push(`### [${item.id}] ${item.title}（rev ${item.revision}，分数 ${item.score.toFixed(2)}）`);
    lines.push(item.text);
    lines.push('');
  }
  if (bundle.dropped.length > 0) {
    lines.push('## 未送入上下文');
    for (const drop of bundle.dropped) lines.push(`- ${drop.id}：${drop.reason}`);
  }
  return lines.join('\n');
}

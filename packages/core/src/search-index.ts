/**
 * 确定性检索索引。
 *
 * 索引是**可重建派生物**：随时可以丢掉并从头扫描 Markdown 重建。
 * 检索本身不需要模型、网络或外部服务，这是“没有 AI 也能用”的产品基线。
 *
 * 打分是显式的、可解释的加权词频，而不是黑盒：
 * 标题 4 分、别名 3 分、标签 3 分、元数据 1.5 分、正文 1 分，
 * 再乘以平滑 IDF；额外给出短语命中与更新时间加成。
 * 每个结果都附带 `reasons`，工作台可以解释“为什么返回它”。
 */

import type { MemoryKind, MemoryRecord, MemoryStatus, ScopeFilter, ScopeKind } from './types.js';
import { tokenize, tokenizeFields, type FieldTokens } from './tokenize.js';
import { extractTitle } from './record.js';

export interface IndexDocument {
  id: string;
  path: string;
  title: string;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: ScopeKind;
  scope_ref: string;
  revision: number;
  tags: string[];
  aliases: string[];
  body: string;
  updated_at: string;
  valid_until: string;
  supersedes: string[];
  /** 该文档是否被遗忘（墓碑命中），命中则不参与检索。 */
  forgotten?: boolean;
  /** 元数据无法安全解释（未知 scope / 坏 revision）：排除出检索。 */
  invalid?: boolean;
  /** invalid 的原因。 */
  invalidReasons?: string[];
  /** 派生的来源已失效：退出召回，等待人工复核。 */
  derivedInvalid?: boolean;
  derivedInvalidReason?: string;
}

export interface IndexOptions {
  /** 是否包含待确认；由查询决定，不由索引决定。 */
  now?: () => number;
}

const FIELD_WEIGHTS = {
  title: 4,
  alias: 3,
  tag: 3,
  meta: 1.5,
  body: 1,
} as const;

/** 建索引时保留的正文长度上限（字符）；超出部分不参与检索，避免超大文件拖慢。 */
export const MAX_BODY_CHARS = 40_000;

export class MemoryIndex {
  private docs = new Map<string, IndexDocument>();
  private tokens = new Map<string, FieldTokens>();
  private fieldLengths = new Map<string, number>();
  private df = new Map<string, number>();
  private built = false;
  private readonly now: () => number;

  constructor(options: IndexOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.docs.size;
  }

  get isBuilt(): boolean {
    return this.built;
  }

  /** 从记录全量重建。调用者通常先清空再喂全部记录。 */
  rebuild(records: MemoryRecord[], forgotten: ReadonlySet<string> = new Set()): void {
    this.docs.clear();
    this.tokens.clear();
    this.fieldLengths.clear();
    this.df.clear();
    for (const record of records) this.add(record, forgotten.has(record.meta.id));
    this.built = true;
  }

  /** 增量添加/替换一条文档。 */
  add(record: MemoryRecord, forgotten = false): void {
    const title = readTitle(record);
    const doc: IndexDocument = {
      id: record.meta.id,
      path: record.path,
      title,
      kind: record.meta.kind,
      status: record.meta.status,
      scope: record.meta.scope,
      scope_ref: record.meta.scope_ref,
      revision: record.meta.revision,
      tags: record.meta.tags,
      aliases: record.meta.aliases,
      body: record.body.slice(0, MAX_BODY_CHARS),
      updated_at: record.meta.updated_at,
      valid_until: record.meta.valid_until,
      supersedes: record.meta.supersedes,
      forgotten,
      invalid: record.invalid === true,
      invalidReasons: record.invalidReasons ? [...record.invalidReasons] : [],
      derivedInvalid: record.meta.derived_invalid === true,
      derivedInvalidReason: record.meta.derived_invalid_reason ?? '',
    };
    this.remove(record.meta.id);
    this.docs.set(doc.id, doc);
    const fields = tokenizeFields({
      title: doc.title,
      body: doc.body,
      aliases: doc.aliases,
      tags: doc.tags,
      kind: doc.kind,
      scopeRef: doc.scope_ref,
      sourceRef: record.meta.source_ref,
    });
    this.tokens.set(doc.id, fields);
    this.fieldLengths.set(doc.id, fields.body.length + fields.title.length);
    for (const token of allTokens(fields)) {
      this.df.set(token, (this.df.get(token) ?? 0) + 1);
    }
  }

  /** 移除一条文档。 */
  remove(id: string): void {
    const existing = this.docs.get(id);
    if (!existing) return;
    const fields = this.tokens.get(id);
    if (fields) {
      for (const token of allTokens(fields)) {
        const next = (this.df.get(token) ?? 1) - 1;
        if (next <= 0) this.df.delete(token);
        else this.df.set(token, next);
      }
    }
    this.docs.delete(id);
    this.tokens.delete(id);
    this.fieldLengths.delete(id);
  }

  get(id: string): IndexDocument | undefined {
    return this.docs.get(id);
  }

  all(): IndexDocument[] {
    return [...this.docs.values()];
  }

  /**
   * 执行一次检索。
   *
   * 返回命中列表与逐条排除原因，二者总是一致：任何被排除的候选都会出现在
   * `notes` 里，用户因此可以知道“为什么某条记忆没有被返回”。
   */
  search(query: SearchRequest): SearchResult {
    const started = this.now();
    const limit = clampLimit(query.limit ?? 10);
    const snippetsPerHit = Math.max(0, Math.min(5, query.snippetsPerHit ?? 2));
    const statuses = resolveStatuses(query);
    const scopes = query.scopes ?? null;
    const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
    const tags = query.tags && query.tags.length > 0 ? new Set(query.tags.map(t => t.toLowerCase())) : null;

    const excluded = { scope: 0, status: 0, kind: 0, tag: 0, terms: 0, derived: 0, expired: 0 };
    const includeExpired = query.includeExpired === true;
    const notes: SearchNote[] = [];

    const queryTokens = tokenize(query.text);
    const queryUnique = queryTokens.unique;
    const queryPhrases = queryTokens.phrases.filter(p => p.length >= 2);
    const hasQuery = queryUnique.length > 0;
    const total = this.docs.size;
    const avgLen = this.averageLength();

    interface Scored {
      doc: IndexDocument;
      score: number;
      matched: string[];
      fields: FieldTokens;
    }
    const scored: Scored[] = [];

    for (const doc of this.docs.values()) {
      /**
       * 范围闸门放在**最前面**：未授权范围的内容不仅不返回，
       * 连标题、路径、范围都不允许出现在诊断里（诊断也是一种输出）。
       */
      if (!scopeAllowed(doc, scopes)) {
        /**
         * 未授权范围的内容**连诊断都不写**。
         *
         * 审计发现：即使返回结果已经过滤，诊断里的 `scope_mismatch` 明细仍会
         * 带上未授权项目的标题、路径与范围，等于用另一种方式泄露。
         * 诊断也是输出，必须遵守同一套范围闸门。
         *
         * 唯一例外：该范围**种类**已被授权、只是 ref 不再允许列表里
         * （例如已授权 `project`，但某条属于另一个项目）。此时也只报数量，
         * 不透露是哪一个项目。
         */
        excluded.scope += 1;
        continue;
      }
      if (doc.forgotten) {
        excluded.status += 1;
        notes.push(note(doc, 'deleted', '该记忆已被遗忘（命中删除标记），不参与检索。'));
        continue;
      }
      if (doc.invalid) {
        excluded.status += 1;
        notes.push(
          note(
            doc,
            'invalid_metadata',
            `元数据无法安全解释，已与检索隔离：${(doc.invalidReasons ?? []).join('；') || '原因未知'}`,
          ),
        );
        continue;
      }
      /**
       * 派生失效闸门：来源被遗忘/删除/修订变化后，摘要不能继续被召回。
       * 放在状态闸门之前，因为无论调用者允许哪些状态，
       * “来源已经不存在”这条都必须先拦住。
       */
      /**
       * C06：有效期闸门对**所有**查询形状一致，包括空查询。
       * 修复前，过期记录在关键词查询里被上层过滤掉，但在空查询
       * （列出全部记忆）里照样返回——同一份数据两条召回规则。
       * 闸门放在索引里，是因为索引才是唯一知道“所有查询路径”的地方。
       */
      if (!includeExpired && isExpired(doc, this.now())) {
        excluded.expired += 1;
        notes.push(note(doc, 'expired', `有效期已在 ${doc.valid_until} 结束，默认退出召回。`));
        continue;
      }
      if (doc.derivedInvalid) {
        excluded.derived += 1;
        notes.push(
          note(
            doc,
            'derived_invalid',
            `本条派生自一条已失效的来源，已退出召回等待复核：${doc.derivedInvalidReason || '原因未记录'}`,
          ),
        );
        continue;
      }
      if (!statusAllowed(doc, statuses, query.includeNonConfirmed === true)) {
        excluded.status += 1;
        notes.push(
          note(
            doc,
            'status_excluded',
            doc.status === 'pending'
              ? '状态为 pending（待确认），默认不参与已确认事实查询。'
              : `状态为 ${doc.status}，不在本次查询允许的状态内。`,
          ),
        );
        continue;
      }
      if (kinds && !kinds.has(doc.kind)) {
        excluded.kind += 1;
        notes.push(note(doc, 'kind_excluded', `类型 ${doc.kind} 不在本次查询允许的类型内。`));
        continue;
      }
      if (tags && !doc.tags.some(tag => tags.has(tag.toLowerCase()))) {
        excluded.tag += 1;
        notes.push(note(doc, 'tag_excluded', `标签 ${doc.tags.join('、') || '（空）'} 不包含查询标签。`));
        continue;
      }

      const fields = this.tokens.get(doc.id);
      if (!fields) continue;

      if (!hasQuery) {
        scored.push({ doc, score: 1, matched: [], fields });
        continue;
      }

      const { score, matched } = this.scoreDocument(doc, fields, queryUnique, queryPhrases, total, avgLen);
      if (score <= 0) {
        excluded.terms += 1;
        notes.push(note(doc, 'no_term_match', '关键词与标题、别名、标签和正文都不匹配。'));
        continue;
      }
      scored.push({ doc, score, matched, fields });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const at = a.doc.updated_at || '';
      const bt = b.doc.updated_at || '';
      if (at !== bt) return at < bt ? 1 : -1;
      return a.doc.id < b.doc.id ? -1 : 1;
    });

    const limited = scored.slice(0, limit);
    for (const truncated of scored.slice(limit)) {
      notes.push(note(truncated.doc, 'budget_truncated', `分数 ${truncated.score.toFixed(3)} 未进入前 ${limit} 名。`));
    }

    const hits = limited.map(entry => {
      const reasons: string[] = [];
      if (entry.matched.length > 0) reasons.push(`命中词元：${entry.matched.slice(0, 12).join('、')}`);
      if (entry.doc.status === 'pending') reasons.push('状态为待确认');
      if (entry.doc.tags.length > 0) reasons.push(`标签：${entry.doc.tags.join('、')}`);
      reasons.push(`分数 ${entry.score.toFixed(3)}`);
      return {
        id: entry.doc.id,
        path: entry.doc.path,
        title: entry.doc.title,
        kind: entry.doc.kind,
        status: entry.doc.status,
        scope: entry.doc.scope,
        scope_ref: entry.doc.scope_ref,
        revision: entry.doc.revision,
        score: entry.score,
        snippets: buildSnippets(entry.doc, entry.fields, entry.matched, snippetsPerHit),
        reasons,
      };
    });

    return {
      hits,
      diagnosis: {
        query: query.text,
        candidates: total,
        excludedByScope: excluded.scope,
        excludedByStatus: excluded.status,
        excludedByDerived: excluded.derived,
        excludedByExpired: excluded.expired,
        excludedByKind: excluded.kind,
        excludedByTag: excluded.tag,
        excludedByTerms: excluded.terms,
        notes,
        elapsedMs: Math.max(0, this.now() - started),
      },
    };
  }

  private scoreDocument(
    doc: IndexDocument,
    fields: FieldTokens,
    queryUnique: string[],
    queryPhrases: string[],
    total: number,
    avgLen: number,
  ): { score: number; matched: string[] } {
    const matched: string[] = [];
    let score = 0;
    const docLen = this.fieldLengths.get(doc.id) ?? 0;
    const lenNorm = avgLen > 0 ? 1 + 0.25 * Math.log(1 + docLen / avgLen) : 1;

    for (const token of queryUnique) {
      const df = this.df.get(token) ?? 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      let contributed = 0;
      contributed += FIELD_WEIGHTS.title * idf * has(fields.title, token);
      contributed += FIELD_WEIGHTS.alias * idf * has(fields.alias, token);
      contributed += FIELD_WEIGHTS.tag * idf * has(fields.tag, token);
      contributed += FIELD_WEIGHTS.meta * idf * has(fields.meta, token);
      contributed += FIELD_WEIGHTS.body * idf * has(fields.body, token);
      if (contributed > 0) {
        matched.push(token);
        score += contributed;
      }
    }
    if (matched.length === 0) return { score: 0, matched: [] };
    score /= lenNorm;

    // 短语命中（拉丁词串或整段中文）额外加成，缓解 bigram 噪声。
    const haystack = `${doc.title}\n${doc.aliases.join(' ')}\n${doc.tags.join(' ')}\n${doc.body}`.toLowerCase();
    for (const phrase of queryPhrases) {
      if (phrase.length >= 2 && haystack.includes(phrase)) {
        score += 1.5 + Math.min(3, phrase.length / 4);
        matched.push(`"${phrase}"`);
      }
    }

    // 明确的时间衰减：越新越靠前，但幅度温和，避免“更晚就是更真”。
    const updated = Date.parse(doc.updated_at);
    if (Number.isFinite(updated)) {
      const ageDays = Math.max(0, (this.now() - updated) / 86_400_000);
      score *= 1 + 0.15 / (1 + ageDays / 30);
    }

    /**
     * 过期记录已经在闸门处退出召回，这里不再降权：
     * “降权但仍返回”正是 C06 里那种自相矛盾的行为。
     */
    return { score, matched };
  }

  private averageLength(): number {
    if (this.fieldLengths.size === 0) return 0;
    let sum = 0;
    for (const value of this.fieldLengths.values()) sum += value;
    return sum / this.fieldLengths.size;
  }
}

/**
 * 一条记录是否已经过期。
 * 空 `valid_until` 表示无期限；无法解析的时间也按“不确定”处理，不当作过期。
 */
export function isExpired(doc: { valid_until: string }, now: number): boolean {
  if (doc.valid_until === '') return false;
  const until = Date.parse(doc.valid_until);
  return Number.isFinite(until) && until < now;
}

export interface SearchRequest {
  text: string;
  /**
   * 是否把已过期的记录也返回（默认 **false**）。
   * 历史查看/审计可以显式打开；默认召回永远不含过期事实。
   */
  includeExpired?: boolean;
  includeNonConfirmed?: boolean;
  statuses?: MemoryStatus[];
  kinds?: MemoryKind[];
  /**
   * 允许检索的范围白名单。
   * 省略或传空数组表示“只查 personal”，而不是“查全部”。
   */
  scopes?: ScopeFilter[] | null;
  tags?: string[];
  limit?: number;
  snippetsPerHit?: number;
}

export interface SearchNote {
  id: string;
  path: string;
  title: string;
  reason: string;
  code:
    | 'scope_mismatch'
    | 'status_excluded'
    | 'kind_excluded'
    | 'tag_excluded'
    | 'no_term_match'
    | 'budget_truncated'
    | 'superseded'
    | 'expired'
    | 'deleted'
    | 'invalid_metadata'
    | 'derived_invalid'
    | 'included';
}

export interface SearchResult {
  hits: Array<{
    id: string;
    path: string;
    title: string;
    kind: MemoryKind;
    status: MemoryStatus;
    scope: ScopeKind;
    scope_ref: string;
    revision: number;
    score: number;
    snippets: Array<{ text: string; matched: string[]; score: number }>;
    reasons: string[];
  }>;
  diagnosis: {
    query: string;
    candidates: number;
    excludedByScope: number;
    excludedByStatus: number;
    /** 因来源失效而退出的派生记忆数量。 */
    excludedByDerived: number;
    /** 因有效期结束而退出的记录数量。 */
    excludedByExpired: number;
    excludedByKind: number;
    excludedByTag: number;
    excludedByTerms: number;
    notes: SearchNote[];
    elapsedMs: number;
  };
}

function has(list: string[], token: string): number {
  return list.includes(token) ? 1 : 0;
}

function allTokens(fields: FieldTokens): string[] {
  return [...new Set([...fields.title, ...fields.body, ...fields.alias, ...fields.tag, ...fields.meta])];
}

export function readTitle(record: MemoryRecord): string {
  const fromBody = extractTitle(record.body, '');
  if (fromBody) return fromBody;
  const fallback = record.path.split('/').pop() ?? record.meta.id;
  return fallback.replace(/\.md$/, '');
}

/** 状态过滤：默认只返回 confirmed；显式请求时可以放开。 */
function resolveStatuses(query: SearchRequest): Set<MemoryStatus> | null {
  if (query.statuses && query.statuses.length > 0) return new Set(query.statuses);
  if (query.includeNonConfirmed) return null;
  return new Set<MemoryStatus>(['confirmed']);
}

function statusAllowed(doc: IndexDocument, statuses: Set<MemoryStatus> | null, includeAll: boolean): boolean {
  if (includeAll || statuses === null) return true;
  return statuses.has(doc.status);
}

/**
 * 范围过滤。
 *
 * 语义是**先授权、后检索**：
 * - 传入 `scopes` 时，只有显式列出的范围可见；
 * - 传入 `null`/`undefined`/空数组时，**只**放行 personal。
 *
 * 旧实现在缺省时返回 true（等于放行所有项目），审计发现这会导致
 * “选定项目 A 后仍能通过诊断看到项目 B 的标题与路径”。
 * 默认必须是最小可见范围，而不是最大。
 */
/**
 * 范围闸门。
 *
 * C05 反例：`scopes: [{ scope: 'project' }]`（缺 `ref`）曾把**所有**
 * 项目都放行——一个写漏字段的请求把访问范围悄悄放大成了全部项目。
 * 现在：缺 `ref` 的 project/context 过滤器一律视为**不完整**，
 * 宁可什么都查不到，也不猜调用者想查哪个项目。
 */
function scopeAllowed(doc: IndexDocument, scopes: ScopeFilter[] | null | undefined): boolean {
  const filters = (scopes ?? []).filter(filter => isCompleteScopeFilter(filter));
  if (doc.scope === 'personal' && doc.scope_ref === '') {
    return filters.length === 0
      ? (scopes === null || scopes === undefined || scopes.length === 0)
      : filters.some(filter => filter.scope === 'personal');
  }
  if (filters.length === 0) return false;
  for (const filter of filters) {
    if (doc.scope !== filter.scope) continue;
    // `ref` 已由 isCompleteScopeFilter 保证非空，这里做精确匹配。
    if (filter.ref === doc.scope_ref) return true;
  }
  return false;
}

/** project/context 必须带 ref；只有 personal 允许省略。 */
export function isCompleteScopeFilter(filter: ScopeFilter): boolean {
  if (filter.scope === 'personal') return true;
  return typeof filter.ref === 'string' && filter.ref.trim() !== '';
}

function describeScope(doc: IndexDocument): string {
  return doc.scope === 'personal' ? '个人全局' : `${doc.scope}:${doc.scope_ref || '（未指定）'}`;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(50, Math.floor(limit)));
}

function note(doc: IndexDocument, code: SearchNote['code'], reason: string): SearchNote {
  return { id: doc.id, path: doc.path, title: doc.title, reason, code };
}

/** 从正文里截取包含命中词元的片段。 */
export function buildSnippets(
  doc: IndexDocument,
  fields: FieldTokens,
  matched: string[],
  maxSnippets: number,
): Array<{ text: string; matched: string[]; score: number }> {
  if (maxSnippets <= 0) return [];
  const plainMatched = matched.filter(token => !token.startsWith('"'));
  const lines = doc.body.split(/\r?\n/);
  const candidates: Array<{ text: string; matched: string[]; score: number }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const lineTokens = new Set(tokenize(trimmed).unique);
    const hits = plainMatched.filter(token => lineTokens.has(token));
    if (hits.length === 0) continue;
    candidates.push({
      text: trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed,
      matched: hits,
      score: hits.length + (trimmed.includes('#') ? 0.5 : 0),
    });
  }
  if (candidates.length === 0 && fields.title.length > 0) {
    const titleHits = plainMatched.filter(token => fields.title.includes(token));
    if (titleHits.length > 0) {
      candidates.push({ text: doc.title, matched: titleHits, score: titleHits.length });
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, maxSnippets);
}

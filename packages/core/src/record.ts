/**
 * 记忆文件的读写格式。
 *
 * 一条记忆 = 一个 Markdown 文件，结构固定为：
 *
 * ```markdown
 * ---
 * <YAML frontmatter：MemoryMeta 的全部字段>
 * ---
 *
 * # 标题
 *
 * 正文……
 *
 * ## 来源
 * - kind | ref | observed_at
 *   > 摘录
 *
 * ## 变更
 * - 2026-10-09T00:00:00.000Z rev 1 → 2：说明了什么
 * ```
 *
 * 审计修正后的三条硬规则：
 *
 * 1. **托管小节只在代码块之外识别**。用户在正文里贴一段带 `## 来源` 的围栏示例，
 *    绝不能被当成插件的托管区域而被重写掉。
 * 2. **未知值一律保守**。未知 `scope` 不能降级成 `personal`（那会扩大可见范围），
 *    未知 `allow_model` 不能当成 `true`（那是隐私开关）。这类记录标记为 `invalid`
 *    并排除出检索，交给人工修复。
 * 3. **无法安全往返的内容不破坏性重写**。未知属性键保留；无法解释的 YAML 行由
 *    调用方拒绝写入，而不是被悄悄丢掉。
 */

import { advanceFence } from './guard.js';
import { sha256Hex } from './hash.js';
import {
  asBoolean,
  asNumber,
  asString,
  asStringList,
  parseYaml,
  serializeYaml,
  type YamlDocument,
  type YamlValue,
} from './yaml.js';
import {
  MEMORY_KINDS,
  SCOPE_KINDS,
  SOURCE_KINDS,
  MEMORY_STATUSES,
  type MemoryKind,
  type MemoryMeta,
  type MemoryRecord,
  type MemoryStatus,
  type ScopeKind,
  type SourceKind,
  type SourceRef,
} from './types.js';

export const SOURCES_HEADING = '## 来源';
export const CHANGELOG_HEADING = '## 变更';
/** 由插件写入的变更记录最多保留的条目数。 */
export const MAX_CHANGELOG_ENTRIES = 40;

/** 插件管理的 frontmatter 键；其余键属于用户，必须原样保留。 */
export const MANAGED_KEYS: readonly string[] = [
  'id',
  'kind',
  'status',
  'scope',
  'scope_ref',
  'source_kind',
  'source_ref',
  'revision',
  'observed_at',
  'valid_from',
  'valid_until',
  'supersedes',
  'derived_from',
  'review_after',
  'updated_at',
  'tags',
  'aliases',
  'allow_model',
  'dedupe_key',
  'event_ids',
  'derived_invalid',
  'derived_invalid_reason',
];

export interface ParseIssue {
  code:
    | 'no_frontmatter'
    | 'bad_frontmatter'
    | 'missing_id'
    | 'unknown_kind'
    | 'unknown_status'
    | 'unknown_scope'
    | 'unknown_source_kind'
    | 'bad_revision'
    | 'bad_boolean'
    | 'unsupported_yaml'
    /** 文件存在但读不出来（权限 / I/O / 宿主错误）：这是故障，不是空文件。 */
    | 'unreadable'
    | 'missing_title';
  message: string;
  /** 1 起的行号（如果可定位）。 */
  line?: number;
  /** 是否使整条记录不可用于检索。 */
  fatal?: boolean;
}

export interface ParseResult {
  ok: boolean;
  record: MemoryRecord | null;
  issues: ParseIssue[];
  /** 原始 frontmatter 文本（不含 --- 分隔符）。 */
  rawFrontmatter: string;
  /** 无法安全往返的 YAML 行。 */
  unsupportedYaml: Array<{ line: number; text: string }>;
  /** 用户手写的、非插件管理的属性键值（保留原样）。 */
  extraFrontmatter: Array<[string, YamlValue]>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** 从标题行推断记录标题。 */
export function extractTitle(body: string, fallback: string): string {
  const lines = body.split(/\r?\n/);
  let fence: FenceState | null = null;
  for (const line of lines) {
    fence = advanceFence(line, fence);
    if (fence) continue;
    const match = /^[ \t]*#[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match && match[1]) return match[1].trim();
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* 围栏跟踪：4 个反引号的外围栏不会被 3 个反引号的内围栏关闭           */
/* ------------------------------------------------------------------ */

/** 围栏状态：由 `guard.ts` 的 `advanceFence` 统一实现，避免两处规则漂移。 */
type FenceState = ReturnType<typeof advanceFence>;

/**
 * 把正文拆成“托管区域可识别的部分”。
 *
 * 返回行级视图：哪些行处于围栏内、哪些是（围栏外的）托管小节标题。
 */
export interface BodyLayout {
  lines: string[];
  /** 围栏外 `## 来源` 的行号。 */
  sourcesHeading: number;
  /** 围栏外 `## 变更` 的行号。 */
  changelogHeading: number;
  /** 是否有任何一行处于代码围栏内。 */
  hasFence: boolean;
}

/**
 * 托管小节的身份**不能只看标题文字**。
 *
 * 这里曾犯过一个真实错误：只要正文里出现 `## 来源` 或 `## 变更` 就当作
 * 插件托管小节，于是用户在笔记里写自己的「## 来源」「## 变更」章节时，
 * 章节连同内容会在 parse → serialize 往返里被吞掉，只剩标题。
 *
 * 现在的判定规则是**看内容形状**（并且只在围栏之外）：
 * - 「## 来源」是托管的，当且仅当它后面的行全部是空行或来源条目
 *   （`- kind | ref | time` 开头的列表项，可带 `>` 引文续行）；
 * - 「## 变更」是托管的，当且仅当它后面的行全部是空行或
 *   `- <ISO 时间戳> …` 形式的变更记录。
 *
 * 用户写普通段落时两条都不满足，因此那两个标题会被完整当作正文保留。
 */
export function analyzeBody(body: string): BodyLayout {
  const lines = body.split(/\r?\n/);
  let fence: FenceState | null = null;
  let sourcesHeading = -1;
  let changelogHeading = -1;
  let hasFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const before = fence;
    fence = advanceFence(lines[i]!, fence);
    if (before !== null || fence !== null) {
      hasFence = true;
      continue;
    }
    const trimmed = lines[i]!.trim();
    if (trimmed === SOURCES_HEADING && sourcesHeading < 0 && looksLikeManagedSources(lines, i)) sourcesHeading = i;
    else if (trimmed === CHANGELOG_HEADING && changelogHeading < 0 && looksLikeManagedChangelog(lines, i)) {
      changelogHeading = i;
    }
  }
  return { lines, sourcesHeading, changelogHeading, hasFence };
}

/** 来源条目行：`- kind | ref | observed_at`（ref 可以为空）。 */
function isSourceEntryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- ')) return false;
  const payload = trimmed.slice(2).trim();
  if (payload === '') return false;
  return payload.includes('|');
}

function isChangelogEntryLine(line: string): boolean {
  return /^-\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line.trim());
}

/**
 * 从标题行的下一行开始判断：是否全部由“托管小节允许的行”组成。
 * 允许空行、条目行，以及条目下的引文续行（`>` 或缩进文本）。
 * 出现任何普通段落（非空行且不是条目/引文）就说明这是用户自己的章节。
 */
function sectionShapeMatches(lines: readonly string[], headingIndex: number, isEntry: (line: string) => boolean): boolean {
  let entries = 0;
  let seenEntry = false;
  let fence: FenceState | null = null;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const before = fence;
    fence = advanceFence(line, fence);
    if (before !== null || fence !== null) {
      // 托管小节里不该出现围栏；一旦出现，说明这是用户内容。
      return false;
    }
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // 任何标题行都终止本小节——否则会把下一个章节的列表项吞进来源条目里。
    if (/^#{1,6}\s/.test(trimmed)) break;
    if (isEntry(line)) {
      entries += 1;
      seenEntry = true;
      continue;
    }
    if (trimmed.startsWith('>')) continue;
    return false;
  }
  return seenEntry && entries > 0;
}

function looksLikeManagedSources(lines: readonly string[], headingIndex: number): boolean {
  return sectionShapeMatches(lines, headingIndex, isSourceEntryLine);
}

function looksLikeManagedChangelog(lines: readonly string[], headingIndex: number): boolean {
  return sectionShapeMatches(lines, headingIndex, isChangelogEntryLine);
}

/** 解析一个记忆文件。 */
export function parseMemoryFile(path: string, raw: string): ParseResult {
  const issues: ParseIssue[] = [];
  const fmMatch = FRONTMATTER_RE.exec(raw);
  if (!fmMatch) {
    return {
      ok: false,
      record: null,
      issues: [{ code: 'no_frontmatter', message: '文件没有 YAML frontmatter，未按记忆处理。' }],
      rawFrontmatter: '',
      unsupportedYaml: [],
      extraFrontmatter: [],
    };
  }
  const rawFrontmatter = fmMatch[1] ?? '';
  let doc: YamlDocument;
  try {
    doc = parseYaml(rawFrontmatter);
  } catch (error) {
    return {
      ok: false,
      record: null,
      issues: [
        {
          code: 'bad_frontmatter',
          message: `frontmatter 解析失败：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      rawFrontmatter,
      unsupportedYaml: [],
      extraFrontmatter: [],
    };
  }
  for (const line of doc.unsupported) {
    issues.push({
      code: 'unsupported_yaml',
      message: `不支持的 YAML 结构（保留原文，写入时会被拒绝以免破坏）：${line.text.trim()}`,
      line: line.line,
    });
  }

  const map = new Map<string, YamlValue>();
  for (const [key, value] of doc.entries) map.set(key, value);
  const get = (key: string): YamlValue | undefined => map.get(key);
  const extraFrontmatter: Array<[string, YamlValue]> = doc.entries.filter(([key]) => !MANAGED_KEYS.includes(key));

  const invalidReasons: string[] = [];
  const id = asString(get('id')).trim();
  if (!id) {
    issues.push({ code: 'missing_id', message: '缺少 id 字段，无法建立稳定标识。' });
  }

  const kindRaw = asString(get('kind'), 'note').trim() as MemoryKind;
  const kind: MemoryKind = MEMORY_KINDS.includes(kindRaw) ? kindRaw : 'note';
  if (!MEMORY_KINDS.includes(kindRaw)) {
    issues.push({ code: 'unknown_kind', message: `未知 kind「${kindRaw}」，按 note 归类（不影响隐私与范围）。` });
  }

  /**
   * 未知 status 保守回退到 `pending`：pending 默认不参与已确认事实查询，
   * 因此“看不懂就不当事实用”，而不是悄悄当成 confirmed。
   */
  const statusRaw = asString(get('status'), 'pending').trim() as MemoryStatus;
  const status: MemoryStatus = MEMORY_STATUSES.includes(statusRaw) ? statusRaw : 'pending';
  if (!MEMORY_STATUSES.includes(statusRaw)) {
    issues.push({
      code: 'unknown_status',
      message: `未知 status「${statusRaw}」，保守按 pending 处理（不进入已确认事实）。`,
    });
  }

  /**
   * 未知 scope **不能**降级为 personal：personal 是默认可见范围，
   * 降级会把一条范围不明的记录广播给所有查询。这里改成不可匹配的哨兵值
   * 并标记 invalid，使该记录退出检索，等待人工修复。
   */
  const scopeRaw = asString(get('scope'), 'personal').trim() as ScopeKind;
  const scopeKnown = SCOPE_KINDS.includes(scopeRaw);
  const scope: ScopeKind = scopeKnown ? scopeRaw : 'context';
  if (!scopeKnown) {
    invalidReasons.push(`未知 scope「${scopeRaw}」，已与检索隔离（不会按 personal 或任何项目范围返回）。`);
    issues.push({
      code: 'unknown_scope',
      message: `未知 scope「${scopeRaw}」。为避免扩大可见范围，本条不参与检索；请修正为 personal/project/context 之一。`,
      fatal: true,
    });
  }

  const sourceKindRaw = asString(get('source_kind'), 'user_explicit').trim() as SourceKind;
  const sourceKind: SourceKind = SOURCE_KINDS.includes(sourceKindRaw) ? sourceKindRaw : 'plugin_maintenance';
  if (!SOURCE_KINDS.includes(sourceKindRaw)) {
    issues.push({
      code: 'unknown_source_kind',
      message: `未知 source_kind「${sourceKindRaw}」，按 plugin_maintenance 处理（不会被当成用户明确命令）。`,
    });
  }

  const revisionValue = get('revision');
  const revision = asNumber(revisionValue, 0);
  if (!Number.isInteger(revision) || revision < 1) {
    invalidReasons.push(`revision 不是 >=1 的整数（当前 ${JSON.stringify(revisionValue ?? null)}）。`);
    issues.push({
      code: 'bad_revision',
      message: 'revision 不是 >=1 的整数。版本号不可信，本条退出检索以免覆盖人工编辑时判断错误。',
      fatal: true,
    });
  }

  /**
   * 隐私开关：只有显式 `true` 才算允许发送给模型。
   * 缺失、空值、无法解释的值一律视为**不允许**。
   */
  const allowModelRaw = get('allow_model');
  const allowModel = asBoolean(allowModelRaw, false);
  if (allowModelRaw !== undefined && allowModelRaw !== null) {
    const text = typeof allowModelRaw === 'string' ? allowModelRaw.trim().toLowerCase() : '';
    const recognizable =
      typeof allowModelRaw === 'boolean' ||
      text === 'true' ||
      text === 'false' ||
      text === 'yes' ||
      text === 'no';
    if (!recognizable) {
      issues.push({
        code: 'bad_boolean',
        message: `allow_model 的值「${asString(allowModelRaw)}」无法解释，保守按 false（不发给模型）处理。`,
      });
    }
  }

  const bodyRaw = raw.slice(fmMatch[0].length);
  const { body, sources } = splitBody(bodyRaw);

  const title = asString(get('title')).trim();
  if (!title && !extractTitle(body, '')) {
    issues.push({ code: 'missing_title', message: '缺少标题，工作台将用文件名显示。' });
  }

  const meta: MemoryMeta = {
    id: id || '',
    kind,
    status,
    scope,
    scope_ref: asString(get('scope_ref')).trim(),
    source_kind: sourceKind,
    source_ref: asString(get('source_ref')).trim(),
    revision: Number.isInteger(revision) && revision >= 1 ? revision : 1,
    observed_at: asString(get('observed_at')).trim(),
    valid_from: asString(get('valid_from')).trim(),
    valid_until: asString(get('valid_until')).trim(),
    supersedes: asStringList(get('supersedes')),
    derived_from: asStringList(get('derived_from')),
    review_after: asString(get('review_after')).trim(),
    updated_at: asString(get('updated_at')).trim(),
    tags: asStringList(get('tags')),
    aliases: asStringList(get('aliases')),
    allow_model: allowModel,
    dedupe_key: asString(get('dedupe_key')).trim(),
    event_ids: asStringList(get('event_ids')).map(value => value.trim()).filter(value => value !== ''),
    ...(asBoolean(get('derived_invalid')) === true
      ? {
          derived_invalid: true,
          derived_invalid_reason: asString(get('derived_invalid_reason')).trim(),
        }
      : {}),
  };

  const record: MemoryRecord = {
    meta,
    body,
    path,
    sources,
    invalid: invalidReasons.length > 0,
    invalidReasons,
  };
  return {
    ok: id !== '' && invalidReasons.length === 0,
    record,
    issues,
    rawFrontmatter,
    unsupportedYaml: doc.unsupported,
    extraFrontmatter,
  };
}

export interface SplitBodyResult {
  /** 正文主体（围栏外的托管小节之前的全部内容）。 */
  body: string;
  sources: SourceRef[];
}

/**
 * 把正文拆成主体 + 来源。
 *
 * 托管小节只在**围栏之外**识别，因此正文里的 Markdown 示例不会被吞掉。
 */
export function splitBody(raw: string): SplitBodyResult {
  const layout = analyzeBody(raw);
  const { lines, sourcesHeading, changelogHeading } = layout;
  const bodyEnd = Math.min(
    sourcesHeading >= 0 ? sourcesHeading : Number.POSITIVE_INFINITY,
    changelogHeading >= 0 ? changelogHeading : Number.POSITIVE_INFINITY,
  );
  const body = lines.slice(0, Number.isFinite(bodyEnd) ? bodyEnd : lines.length).join('\n').trim();

  let sources: SourceRef[] = [];
  if (sourcesHeading >= 0) {
    /**
     * 来源小节在下一个小节标题处结束。`changelogHeading` 之所以也要看，
     * 是因为「## 变更」本身也是标题行；若只看到文件末尾，
     * 变更记录会被当成来源条目读进来（审查反例：
     * `- 2026-01-01 rev 1 → 2：测试` 变成一条空来源）。
     */
    const nextHeading = lines.findIndex((line, index) => index > sourcesHeading && /^#{1,6}\s/.test(line.trim()));
    const end = nextHeading > sourcesHeading ? nextHeading : lines.length;
    sources = parseSources(lines.slice(sourcesHeading + 1, end));
  }
  return { body, sources };
}

function parseSources(lines: string[]): SourceRef[] {
  const out: SourceRef[] = [];
  let current: SourceRef | null = null;
  let fence: FenceState | null = null;
  for (const line of lines) {
    fence = advanceFence(line, fence);
    if (fence) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('- ')) {
      if (current) out.push(current);
      const payload = trimmed.slice(2).trim();
      const parts = payload.split('|').map(part => part.trim());
      current = {
        kind: parts[0] ?? '',
        ref: parts[1] ?? '',
        observed_at: parts[2] ?? '',
        excerpt: '',
      };
      continue;
    }
    if (trimmed.startsWith('>') && current) {
      const text = trimmed.replace(/^>\s?/, '');
      current.excerpt = current.excerpt ? `${current.excerpt}\n${text}` : text;
      continue;
    }
    if (current) current.excerpt = current.excerpt ? `${current.excerpt}\n${trimmed}` : trimmed;
  }
  if (current) out.push(current);
  return out;
}

/** 序列化正文中的来源小节。 */
export function renderSources(sources: SourceRef[]): string {
  if (sources.length === 0) return `${SOURCES_HEADING}\n\n（暂无来源记录）`;
  const lines = [SOURCES_HEADING, ''];
  for (const source of sources) {
    lines.push(`- ${source.kind} | ${source.ref} | ${source.observed_at}`);
    if (source.excerpt.trim() !== '') {
      for (const line of source.excerpt.split(/\r?\n/)) lines.push(`  > ${line}`);
    }
  }
  return lines.join('\n');
}

export interface SerializeOptions {
  /** 额外保留的 frontmatter 键（用户手写的），放在标准键之后。 */
  extraFrontmatter?: Array<[string, YamlValue]>;
  /** 变更记录的追加行。 */
  changelogLines?: string[];
  /** 来源小节是否由插件重写；默认 true。 */
  rewriteSources?: boolean;
}

/**
 * 由记录生成完整文件文本。
 *
 * `changelogLines` 为空时**不追加**“变更”小节，从而解析→序列化是内容保持的。
 */
export function serializeMemoryFile(record: MemoryRecord, options: SerializeOptions = {}): string {
  const doc: YamlDocument = {
    entries: [
      ['id', record.meta.id],
      ['kind', record.meta.kind],
      ['status', record.meta.status],
      ['scope', record.meta.scope],
      ['scope_ref', record.meta.scope_ref],
      ['source_kind', record.meta.source_kind],
      ['source_ref', record.meta.source_ref],
      ['revision', record.meta.revision],
      ['observed_at', record.meta.observed_at],
      ['valid_from', record.meta.valid_from],
      ['valid_until', record.meta.valid_until],
      ['supersedes', { kind: 'list', items: record.meta.supersedes }],
      ['derived_from', { kind: 'list', items: record.meta.derived_from }],
      ['review_after', record.meta.review_after],
      ['updated_at', record.meta.updated_at],
      ['tags', { kind: 'list', items: record.meta.tags }],
      ['aliases', { kind: 'list', items: record.meta.aliases }],
      ['allow_model', record.meta.allow_model],
      ['dedupe_key', record.meta.dedupe_key],
      ['event_ids', { kind: 'list', items: record.meta.event_ids }],
      ...(record.meta.derived_invalid === true
        ? ([
            ['derived_invalid', true],
            ['derived_invalid_reason', record.meta.derived_invalid_reason ?? ''],
          ] as Array<[string, YamlValue]>)
        : []),
    ],
    unsupported: [],
  };
  for (const [key, value] of options.extraFrontmatter ?? []) {
    if (MANAGED_KEYS.includes(key)) continue;
    if (doc.entries.some(([existing]) => existing === key)) continue;
    doc.entries.push([key, value]);
  }

  const parts: string[] = ['---', serializeYaml(doc), '---', ''];
  /**
   * 正文统一 trim（两端）：解析侧也做同样的 trim，
   * 否则 `parse → serialize → parse` 会因为末尾空行逐轮累积而不再稳定。
   */
  parts.push(record.body.trim());
  parts.push('');
  if (options.rewriteSources !== false && record.sources.length > 0) {
    /**
     * 没有来源就不写这个标题。
     * 否则每往返一次就多出一个空「## 来源」，既不是稳定形式，
     * 也会和用户自己写的「## 来源」撞在一起。
     */
    parts.push(renderSources(record.sources));
    parts.push('');
  }
  const changelog = options.changelogLines ?? [];
  if (changelog.length > 0) {
    parts.push(CHANGELOG_HEADING, '');
    for (const line of changelog) parts.push(`- ${line}`);
    parts.push('');
  }
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** 读取文件中已有的“变更”小节文本行（只在围栏之外）。 */
export function readChangelogEntries(raw: string): string[] {
  const layout = analyzeBody(raw);
  if (layout.changelogHeading < 0) return [];
  const out: string[] = [];
  let fence: FenceState | null = null;
  for (const line of layout.lines.slice(layout.changelogHeading + 1)) {
    fence = advanceFence(line, fence);
    if (fence) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('- ')) out.push(trimmed.slice(2));
  }
  return out;
}

/**
 * 计算文件的内容哈希。
 *
 * 直接对完整文件字节哈希：既覆盖 frontmatter 里的 revision，也覆盖用户手改的
 * 正文。这样即使人工编辑没有同步 revision，提交前的字节比对也能发现。
 */
export function contentHashOf(raw: string): string {
  return sha256Hex(raw);
}

/**
 * 归一化文本，用于去重指纹。
 *
 * **只规范空白，不删除标点和数字**。
 * 曾经这里把所有标点都删掉，于是「剂量1.2」和「剂量12」归一化成同一个
 * 字符串、拿到同一个去重 key，两条不同的事实被判成重复——去重把事实改了。
 *
 * 现在只做两件安全的事：统一换行/空白（不同编辑器写法不产生重复），
 * 以及大小写折叠（英文大小写不产生重复）。其余字符一律保留。
 */
export function normalizeForDedupe(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

/**
 * 计算来源事件的去重指纹。
 *
 * **不再截断归一化文本**：曾经只取前 400 字，于是两篇开头相同、正文不同的长文
 * 会被判为同一指纹，删除标记会误伤无关内容。指纹必须覆盖全文。
 */
export function computeDedupeKey(sourceKind: string, sourceRef: string, body: string): string {
  const normalized = normalizeForDedupe(body);
  return sha256Hex(`${sourceKind}\u0000${sourceRef}\u0000${normalized}`).slice(0, 32);
}

/** 内容一致性指纹：用于“完全相同的正文”判定，覆盖全文且不含截断。 */
export function fullTextHashOf(body: string): string {
  return sha256Hex(normalizeForDedupe(body));
}

/** 渲染来源小节的可读文本；供界面与导出复用同一份格式。 */
export function renderSourcesBlock(sources: readonly SourceRef[]): string {
  if (sources.length === 0) return '（没有记录来源）';
  return sources
    .map(source => {
      const head = `- ${source.kind} | ${source.ref} | ${source.observed_at || '时间未记录'}`;
      return source.excerpt === '' ? head : `${head}\n  > ${source.excerpt}`;
    })
    .join('\n');
}

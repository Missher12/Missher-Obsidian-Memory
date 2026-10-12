/**
 * 记忆核心的领域模型。
 *
 * 本文件（及整个 `@mom/core`）刻意不引用 Obsidian、Node 内置模块或 MSE，
 * 以便同一份逻辑同时运行在 Obsidian 插件、Node CLI 与 MCP 服务里。
 */

/** 记忆类型。`kind` 决定默认归类目录与复盘策略。 */
export type MemoryKind =
  | 'preference'
  | 'fact'
  | 'person'
  | 'project'
  | 'knowledge'
  | 'event'
  | 'decision'
  | 'note';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'fact',
  'person',
  'project',
  'knowledge',
  'event',
  'decision',
  'note',
];

/** 记忆状态。只有 confirmed 参与“已确认事实”查询。 */
export type MemoryStatus = 'pending' | 'confirmed' | 'disputed' | 'superseded' | 'archived';

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'pending',
  'confirmed',
  'disputed',
  'superseded',
  'archived',
];

/**
 * 作用范围。查询必须先过滤范围，避免项目之间串味。
 * - `personal`：个人全局
 * - `project`：需要 `scope_ref`（项目标识）
 * - `context`：需要 `scope_ref`（会话/场景标识）
 */
export type ScopeKind = 'personal' | 'project' | 'context';

export const SCOPE_KINDS: readonly ScopeKind[] = ['personal', 'project', 'context'];

/** 来源种类。用于区分“用户亲口说的”和“AI 推断的”。 */
export type SourceKind =
  /** 用户在本插件内明确输入 */
  | 'user_explicit'
  /** 用户选中的资料片段（可能来自别的笔记） */
  | 'user_selection'
  /** AI 从原始记录中提取的候选 */
  | 'ai_extraction'
  /** 外部 CLI / MCP 会话提交 */
  | 'session_commit'
  /** 从另一条记忆派生（修正、合并） */
  | 'derived'
  /** 插件自身的技术性维护 */
  | 'plugin_maintenance';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'user_explicit',
  'user_selection',
  'ai_extraction',
  'session_commit',
  'derived',
  'plugin_maintenance',
];

/** 记忆的分类归类目录，用于决定文件落盘位置（纯展示/组织用途）。 */
export type MemoryCategory =
  | 'memory'
  | 'profile'
  | 'scene'
  | 'knowledge'
  | 'research'
  | 'decision'
  | 'planning'
  | 'workflow'
  | 'lesson'
  | 'journal'
  | 'weekly'
  | 'monthly'
  | 'system'
  | 'template';

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'memory', 'profile', 'scene', 'knowledge', 'research', 'decision', 'planning',
  'workflow', 'lesson', 'journal', 'weekly', 'monthly', 'system', 'template',
];

/**
 * 一条记忆的结构化元数据。
 *
 * 所有字段都是扁平标量或字符串数组，便于 Obsidian 的“属性”面板直接编辑，
 * 也便于序列化成 YAML 而不引入嵌套结构。
 */
export interface MemoryMeta {
  /** 稳定标识，与文件名无关。`mem_` + 16 位小写十六进制。 */
  id: string;
  /** 记忆类型。 */
  kind: MemoryKind;
  /** 可选的文件组织分类；旧记录缺省，独立于 kind/status/scope。 */
  category?: MemoryCategory;
  /** 记忆状态。 */
  status: MemoryStatus;
  /** 作用范围种类。 */
  scope: ScopeKind;
  /** 范围标识；`personal` 时为空字符串。 */
  scope_ref: string;
  /** 来源种类。 */
  source_kind: SourceKind;
  /** 来源引用：note 路径、会话 id、事件 id 等。 */
  source_ref: string;
  /** 受控维护的版本号，从 1 开始，每次内容/元数据提交 +1。 */
  revision: number;
  /** 首次记录时间（ISO 8601，UTC）。 */
  observed_at: string;
  /** 生效时间；空字符串表示未知。 */
  valid_from: string;
  /** 失效时间；空字符串表示无期限。 */
  valid_until: string;
  /** 替代的记忆 id 列表（本条替代了谁）。 */
  supersedes: string[];
  /** 派生来源 `id@revision` 列表。 */
  derived_from: string[];
  /** 复查时间；空字符串表示不排期。 */
  review_after: string;
  /** 最近一次内容提交时间（ISO 8601，UTC）。 */
  updated_at: string;
  /** 标签，用于检索与范围过滤。 */
  tags: string[];
  /** 别名/同义词，提升中文检索召回。 */
  aliases: string[];
  /** 是否允许把本条内容发送给配置的模型提供方。 */
  allow_model: boolean;
  /** 去重指纹（来源事件 + 归一化内容），用于幂等。 */
  dedupe_key: string;
  /**
   * 已经落盘的来源事件 id（可多个）。
   *
   * **幂等身份必须写在权威正文里**，不能只放在 `state.json`：
   * 那个文件在写入失败/崩溃/同步回滚后可能落后于 Markdown，
   * 于是一次安全重试就会变成两条重复事实。加载时从这里重建去重索引，
   * `state.json` 只作为可重建的缓存。
   */
  event_ids: string[];
  /**
   * 派生内容已因来源被遗忘/删除/修订变化而失效。
   *
   * 失效的派生记忆**退出召回**（不能因为来源没了就继续把摘要喂给模型），
   * 但文件与历史保留，并由工作台提示人工复核。
   */
  derived_invalid?: boolean;
  /** 派生失效的人类可读原因。 */
  derived_invalid_reason?: string;
}

/** 正文区托管小节的名字。 */
export const MANAGED_SECTIONS = ['来源', '变更'] as const;

/** 解析后的完整记忆。 */
export interface MemoryRecord {
  meta: MemoryMeta;
  /** 正文（不含 frontmatter）。 */
  body: string;
  /** 相对 Vault 根目录的路径。 */
  path: string;
  /** 正文区“来源”小节里的引用条目。 */
  sources: SourceRef[];
  /**
   * 元数据存在无法安全解释的值（未知 scope、坏 revision 等）。
   *
   * 这类记录**不参与检索**：宁可查不到，也不能用宽松默认值把一条范围不明、
   * 隐私开关不明的记忆当成普通事实返回。工作台会把它列进“需要修复”。
   */
  invalid?: boolean;
  /** `invalid` 为真时的人类可读原因列表。 */
  invalidReasons?: string[];
}

/** 正文来源区里的一条引用。 */
export interface SourceRef {
  /** 来源种类，自由文本，例如 `note`、`session`、`url`。 */
  kind: string;
  /** 定位符：路径、会话 id、URL。 */
  ref: string;
  /** 摘录的原文片段。 */
  excerpt: string;
  /** 该来源被记录时的时间。 */
  observed_at: string;
}

/** 检索命中的一条结果。 */
export interface SearchHit {
  id: string;
  path: string;
  title: string;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: ScopeKind;
  scope_ref: string;
  revision: number;
  score: number;
  /** 高分片段列表，按分数降序。 */
  snippets: SearchSnippet[];
  /** 命中原因，用于诊断“为什么返回它”。 */
  reasons: string[];
}

export interface SearchSnippet {
  /** 片段文本。 */
  text: string;
  /** 命中的词元。 */
  matched: string[];
  score: number;
}

/** 检索请求。 */
export interface SearchQuery {
  /** 查询文本（中文按字/bigram，英文按词）。 */
  text: string;
  /** 是否包含非 confirmed 记录。默认 false。 */
  includeNonConfirmed?: boolean;
  /** 允许的状态；设置后覆盖 `includeNonConfirmed`。 */
  statuses?: MemoryStatus[];
  /** 允许的 kind。 */
  kinds?: MemoryKind[];
  /** 允许的范围。默认只查 personal + 已请求的项目。 */
  scopes?: ScopeFilter[];
  /** 允许的标签（任一命中）。 */
  tags?: string[];
  /** 结果数量上限，1..50，默认 10。 */
  limit?: number;
  /** 每条结果最多返回多少片段。 */
  snippetsPerHit?: number;
  /** 是否在无匹配时返回空（默认 true，绝不臆造）。 */
  strict?: boolean;
}

export interface ScopeFilter {
  scope: ScopeKind;
  /** personal 时忽略。 */
  ref?: string;
}

/** 检索诊断，用于“工作台说明某条记忆未被返回的原因”。 */
export interface SearchDiagnosis {
  query: string;
  /** 参与检索的候选总数。 */
  candidates: number;
  /** 因范围被排除。 */
  excludedByScope: number;
  /** 因状态被排除。 */
  excludedByStatus: number;
  /** 因类型被排除。 */
  excludedByKind: number;
  /** 因标签被排除。 */
  excludedByTag: number;
  /** 因关键词完全不匹配被排除。 */
  excludedByTerms: number;
  /** 具体记录级说明。 */
  notes: DiagnosisNote[];
  /** 检索耗时（毫秒）。 */
  elapsedMs: number;
}

export interface DiagnosisNote {
  id: string;
  path: string;
  title: string;
  reason: string;
  /** 机器可读的原因码。 */
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
    | 'included';
}

/** 写入结果。 */
export interface WriteOutcome {
  ok: boolean;
  id: string;
  path: string;
  /** 提交后的 revision；冲突时为磁盘上的当前 revision。 */
  revision: number;
  /** 是否检测到冲突（人工编辑或并发写入）。 */
  conflict: boolean;
  /** 冲突时磁盘上的内容哈希。 */
  conflictHash?: string;
  /** 人类可读的说明。 */
  message: string;
  /** 是否实际发生了写入。 */
  changed: boolean;
}

/** 记忆内容哈希与元数据快照，用于乐观并发。 */
export interface RecordSnapshot {
  id: string;
  path: string;
  revision: number;
  /** 正文+frontmatter 中受保护部分的稳定哈希。 */
  contentHash: string;
  updatedAt: string;
}

/** 删除标记：不含原内容，只用于防止旧副本复活。 */
export interface Tombstone {
  id: string;
  /** 原始路径。 */
  path: string;
  /** 删除时间。 */
  deleted_at: string;
  /** 被删除时的 revision。 */
  revision: number;
  /** 被删除内容的哈希，用于识别旧副本。 */
  content_hash: string;
  /** 去重指纹，用于阻止同一来源再次提取出同样内容。 */
  dedupe_key: string;
  /** 删除原因分类。 */
  reason: 'user_forget' | 'superseded_cleanup' | 'user_delete_file';
}

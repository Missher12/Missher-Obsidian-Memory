/**
 * 插件设置：**默认值在核心**，不依赖 Obsidian 的 `loadData/saveData`。
 * 这样 CLI/MCP 能读到与插件完全一致的默认值与语义，不会两处漂移。
 */

import { DEFAULT_ROOT, assertSafeRoot } from './paths.js';
import { DEFAULT_TRIGGERS, type TriggerConfig } from './jobs.js';
import { defaultOrganization, normalizeOrganization, type OrganizationSettings } from './organization.js';

export interface AiSettings {
  /** 是否启用模型相关功能（提取、复盘、问答）。关闭后核心功能照常可用。 */
  enabled: boolean;
  /** OpenAI 兼容地址；留空表示未配置。 */
  baseUrl: string;
  /** 模型名。由用户填写，插件不硬编码、不自动切换。 */
  model: string;
  /**
   * 密钥存储位置。
   *
   * - `secret-storage`：写进 Obsidian 的 `SecretStorage`（1.11.4+），
   *   不落进插件 `data.json`。**不声称**它一定使用系统钥匙串或一定加密。
   * - `session`：只保留在本次运行的插件内存里，关闭 Obsidian 即丢失。
   */
  keyStorage: 'secret-storage' | 'session';
  /** 是否把密钥存进平台密钥存储（不可用时改为仅本次运行）。 */
  persistKey: boolean;
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number;
  /** 每日模型调用次数上限；0 表示不限制。 */
  dailyCallBudget: number;
  /** 每日 token 上限（估算，来自响应 usage）；0 表示不限制。 */
  dailyTokenBudget: number;
  /** 采样温度。 */
  temperature: number;
}

export interface ReviewSettings {
  /** 是否自动触发复盘。 */
  autoReview: boolean;
  /** 触发配置。 */
  triggers: TriggerConfig;
  /** 单次复盘最多发送多少条片段。 */
  maxExcerpts: number;
  /** 单条片段最大字符数。 */
  maxExcerptChars: number;
  /** 单次复盘最多产出多少条建议。 */
  maxSuggestions: number;
}

export interface SearchSettings {
  /** 默认返回条数。 */
  defaultLimit: number;
  /** 默认是否包含待确认。 */
  includePendingByDefault: boolean;
  /** 默认是否排除已过期。 */
  excludeExpiredByDefault: boolean;
  /** 单次送入模型的上下文预算（字符）。 */
  contextBudgetChars: number;
  /** 上下文最大条数。 */
  contextMaxItems: number;
}

export interface MseSettings {
  /** 是否启用 MSE 候选联动（默认关闭，且不是运行依赖）。 */
  enabled: boolean;
  /** 候选导入端点（可选适配器；不配置时完全离线）。 */
  endpoint: string;
  /** 去敏证据策略：只发哈希与定位符，不搬运原文。 */
  hashEvidenceOnly: boolean;
}

export interface PluginSettings {
  /** 记忆根目录（Vault 内相对路径）。 */
  root: string;
  organization: OrganizationSettings;
  ai: AiSettings;
  review: ReviewSettings;
  search: SearchSettings;
  mse: MseSettings;
  /** 界面语言；当前只提供简体中文。 */
  language: 'zh-CN';
  /** 状态目录名（固定为 `.memory`，仅用于展示）。 */
  stateDir: string;
}

export function defaultSettings(): PluginSettings {
  return {
    root: DEFAULT_ROOT,
    organization: defaultOrganization(),
    ai: {
      enabled: false,
      baseUrl: '',
      model: '',
      keyStorage: 'secret-storage',
      persistKey: true,
      timeoutMs: 45_000,
      dailyCallBudget: 200,
      dailyTokenBudget: 200_000,
      temperature: 0,
    },
    review: {
      autoReview: true,
      triggers: { ...DEFAULT_TRIGGERS },
      maxExcerpts: 12,
      maxExcerptChars: 1500,
      maxSuggestions: 10,
    },
    search: {
      defaultLimit: 10,
      includePendingByDefault: false,
      excludeExpiredByDefault: true,
      contextBudgetChars: 6000,
      contextMaxItems: 8,
    },
    mse: {
      enabled: false,
      endpoint: '',
      hashEvidenceOnly: true,
    },
    language: 'zh-CN',
    stateDir: '.memory',
  };
}

/**
 * 合并已保存的设置与默认值。
 * 逐字段校验类型，坏值回退默认并记录，不静默接受脏数据。
 */
export function mergeSettings(raw: unknown): { settings: PluginSettings; warnings: string[] } {
  const base = defaultSettings();
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { settings: base, warnings };
  const input = raw as Record<string, unknown>;

  if (typeof input.root === 'string' && input.root.trim() !== '') {
    /**
     * X2：**不能先剥掉绝对前缀再校验**。
     *
     * 审计发现（修复前）：这里先 `replace(/\/+$/g,'')` 把开头的 `/` 去掉，
     * 于是 `/Second Brain` 被静默接受成一个相对根目录——用户以为写的是
     * 绝对路径，插件却在一个同名的相对目录里工作。绝对路径、盘符、
     * `~`、保留目录都必须原样拒绝并回退默认值。
     */
    try {
      base.root = assertSafeRoot(input.root);
    } catch (error) {
      warnings.push(
        `忽略不安全的记忆根目录「${input.root}」：${error instanceof Error ? error.message : String(error)}已回退为 ${base.root}。`,
      );
    }
  } else if (input.root !== undefined) {
    warnings.push('记忆根目录不是有效字符串，已回退默认值。');
  }

  try {
    base.organization = normalizeOrganization(input.organization);
  } catch (error) {
    warnings.push(`文件组织设置无效，已回退旧版布局：${error instanceof Error ? error.message : String(error)}`);
  }
  mergeAi(base.ai, input.ai, warnings);
  mergeReview(base.review, input.review, warnings);
  mergeSearch(base.search, input.search, warnings);
  mergeMse(base.mse, input.mse, warnings);
  return { settings: base, warnings };
}

function mergeAi(target: AiSettings, raw: unknown, warnings: string[]): void {
  if (!raw || typeof raw !== 'object') return;
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled === 'boolean') target.enabled = input.enabled;
  if (typeof input.baseUrl === 'string') target.baseUrl = input.baseUrl.trim();
  if (typeof input.model === 'string') target.model = input.model.trim();
  if (typeof input.persistKey === 'boolean') target.persistKey = input.persistKey;
  if (isPositiveInt(input.timeoutMs, 1000, 180_000)) target.timeoutMs = input.timeoutMs;
  else if (input.timeoutMs !== undefined) warnings.push('模型超时不是 1000~180000 的整数，已回退默认值。');
  if (isNonNegativeInt(input.dailyCallBudget)) target.dailyCallBudget = input.dailyCallBudget;
  if (isNonNegativeInt(input.dailyTokenBudget)) target.dailyTokenBudget = input.dailyTokenBudget;
  if (typeof input.temperature === 'number' && input.temperature >= 0 && input.temperature <= 2) {
    target.temperature = input.temperature;
  }
}

function mergeReview(target: ReviewSettings, raw: unknown, warnings: string[]): void {
  if (!raw || typeof raw !== 'object') return;
  const input = raw as Record<string, unknown>;
  if (typeof input.autoReview === 'boolean') target.autoReview = input.autoReview;
  if (isPositiveInt(input.maxExcerpts, 1, 50)) target.maxExcerpts = input.maxExcerpts;
  if (isPositiveInt(input.maxExcerptChars, 200, 8000)) target.maxExcerptChars = input.maxExcerptChars;
  if (isPositiveInt(input.maxSuggestions, 1, 30)) target.maxSuggestions = input.maxSuggestions;
  if (input.triggers && typeof input.triggers === 'object') {
    const triggers = input.triggers as Record<string, unknown>;
    if (isNonNegativeInt(triggers.idleMinutes)) target.triggers.idleMinutes = triggers.idleMinutes;
    if (isNonNegativeInt(triggers.dailyHours)) target.triggers.dailyHours = triggers.dailyHours;
    if (isNonNegativeInt(triggers.weeklyHours)) target.triggers.weeklyHours = triggers.weeklyHours;
  }
}

function mergeSearch(target: SearchSettings, raw: unknown, warnings: string[]): void {
  void warnings;
  if (!raw || typeof raw !== 'object') return;
  const input = raw as Record<string, unknown>;
  if (isPositiveInt(input.defaultLimit, 1, 50)) target.defaultLimit = input.defaultLimit;
  if (typeof input.includePendingByDefault === 'boolean') target.includePendingByDefault = input.includePendingByDefault;
  if (typeof input.excludeExpiredByDefault === 'boolean') target.excludeExpiredByDefault = input.excludeExpiredByDefault;
  if (isPositiveInt(input.contextBudgetChars, 500, 40_000)) target.contextBudgetChars = input.contextBudgetChars;
  if (isPositiveInt(input.contextMaxItems, 1, 30)) target.contextMaxItems = input.contextMaxItems;
}

function mergeMse(target: MseSettings, raw: unknown, warnings: string[]): void {
  if (!raw || typeof raw !== 'object') return;
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled === 'boolean') target.enabled = input.enabled;
  if (typeof input.endpoint === 'string') {
    const endpoint = input.endpoint.trim();
    if (endpoint !== '' && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(endpoint)) {
      warnings.push('MSE 端点只允许 loopback 地址（127.0.0.1 / localhost），已忽略该配置。');
    } else {
      target.endpoint = endpoint;
    }
  }
  if (typeof input.hashEvidenceOnly === 'boolean') target.hashEvidenceOnly = input.hashEvidenceOnly;
}

function isPositiveInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

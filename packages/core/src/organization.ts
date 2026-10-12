/** 文件组织只决定落盘位置，不授予范围权限，也不迁移已有笔记。 */
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryKind } from './types.js';
import { assertNotReserved, assertSafeRelativePath, assertSafeRoot, isInsideRoot, PathError } from './paths.js';

export interface OrganizationSettings {
  preset: 'legacy' | 'missher';
  placement: 'root' | 'vault';
  /** 每个分类相对于 placement 的目录覆盖；缺省使用中文预设。 */
  folders: Partial<Record<MemoryCategory, string>>;
}

export const MISSHER_CATEGORY_LABELS: Readonly<Record<MemoryCategory, string>> = Object.freeze({
  memory: '记忆库', profile: '用户画像', scene: '场景', knowledge: '知识库',
  research: '调研', decision: '决策', planning: '规划', workflow: '工作流',
  lesson: '教训', journal: '日记', weekly: '周报', monthly: '月报',
  system: '系统', template: '模板',
});

export const MISSHER_CATEGORY_FOLDERS = MISSHER_CATEGORY_LABELS;

export function defaultOrganization(): OrganizationSettings {
  return { preset: 'legacy', placement: 'root', folders: {} };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeFolder(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new PathError('organization_folder', `${label}必须是相对目录字符串。`);
  const path = assertSafeRelativePath(value, label);
  assertNotReserved(path);
  // 隐藏目录不会参与记忆扫描，因此也不能被配置成普通内容的写入目录。
  if (path.split('/').some(segment => segment.startsWith('.'))) {
    throw new PathError('organization_hidden', `${label}不能是隐藏目录。`);
  }
  return path;
}

/** 不安全配置必须由调用方显式处理；设置合并入口可以警告后回退。 */
export function normalizeOrganization(raw: unknown): OrganizationSettings {
  const result = defaultOrganization();
  if (raw === undefined || raw === null) return result;
  if (!plainObject(raw)) throw new PathError('organization_settings', '文件组织设置必须是对象。');
  if (raw.preset !== undefined) {
    if (raw.preset !== 'legacy' && raw.preset !== 'missher') throw new PathError('organization_preset', '未知文件组织预设。');
    result.preset = raw.preset;
  }
  if (raw.placement !== undefined) {
    if (raw.placement !== 'root' && raw.placement !== 'vault') throw new PathError('organization_placement', '未知文件组织布局。');
    result.placement = raw.placement;
  }
  if (raw.folders !== undefined) {
    if (!plainObject(raw.folders)) throw new PathError('organization_folders', '分类目录设置必须是对象。');
    for (const [key, value] of Object.entries(raw.folders)) {
      if (!MEMORY_CATEGORIES.includes(key as MemoryCategory)) throw new PathError('organization_category', `未知分类「${key}」。`);
      result.folders[key as MemoryCategory] = safeFolder(value, `分类「${key}」目录`);
    }
  }
  return result;
}

export function defaultMemoryCategory(kind: MemoryKind): MemoryCategory {
  switch (kind) {
    case 'knowledge': return 'knowledge';
    case 'decision': return 'decision';
    case 'project': return 'planning';
    case 'event': return 'journal';
    default: return 'memory';
  }
}

/** Missher 分类的物理目录。旧模式仍由既有 kind 路由负责。 */
export function organizationCategoryFolder(root: string, organization: OrganizationSettings, category: MemoryCategory): string {
  const safeRoot = assertSafeRoot(root);
  const normalized = normalizeOrganization(organization);
  if (!MEMORY_CATEGORIES.includes(category)) throw new PathError('organization_category', `未知分类「${category}」。`);
  const folder = normalized.folders[category] ?? MISSHER_CATEGORY_FOLDERS[category];
  return normalized.placement === 'vault' ? folder : `${safeRoot}/${folder}`;
}

/** 明确允许的物理根；始终保留旧 root，绝不返回空路径或整个 Vault。 */
export function organizationFolders(root: string, organization: OrganizationSettings): string[] {
  const safeRoot = assertSafeRoot(root);
  const normalized = normalizeOrganization(organization);
  if (normalized.preset === 'legacy') return [safeRoot];
  return [...new Set([safeRoot, ...MEMORY_CATEGORIES.map(category => organizationCategoryFolder(safeRoot, normalized, category))])];
}

/** 普通内容路径校验；.memory 协议目录由适配器的独立状态分支负责。 */
export function assertOrganizationPath(root: string, organization: OrganizationSettings, path: string, label = '记忆路径'): string {
  const safe = assertSafeRelativePath(path, label);
  assertNotReserved(safe);
  if (!organizationFolders(root, organization).some(folder => isInsideRoot(folder, safe))) {
    throw new PathError('organization_escape', `${label}不在已配置的记忆目录内。`);
  }
  return safe;
}

export function isOrganizationPath(root: string, organization: OrganizationSettings, path: string): boolean {
  try { assertOrganizationPath(root, organization, path); return true; } catch { return false; }
}

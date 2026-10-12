import { MEMORY_CATEGORIES, normalizeOrganization, type MemoryCategory, type OrganizationSettings } from '@mom/core';

/** 目录范围只由本地进程启动配置决定；不能从 MCP 工具请求继承。 */
export function organizationFromStartup(
  flags: ReadonlyMap<string, string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): OrganizationSettings {
  const foldersRaw = flags.get('folders-json') ?? env.MOM_FOLDERS_JSON ?? '';
  let folders: unknown = {};
  if (foldersRaw.trim() !== '') {
    try {
      folders = JSON.parse(foldersRaw);
    } catch {
      throw new Error('--folders-json / MOM_FOLDERS_JSON 必须是分类到相对目录的 JSON 对象。');
    }
  }
  return normalizeOrganization({
    preset: flags.get('layout') ?? env.MOM_LAYOUT ?? 'legacy',
    placement: flags.get('placement') ?? env.MOM_PLACEMENT ?? 'root',
    folders,
  });
}

/** 分类是受限标识，不是调用方提供的目录。 */
export function categoryFrom(value: unknown): MemoryCategory | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(MEMORY_CATEGORIES as readonly string[]).includes(value)) {
    throw new Error(`category 只能是 ${MEMORY_CATEGORIES.join(' / ')} 之一。`);
  }
  return value as MemoryCategory;
}

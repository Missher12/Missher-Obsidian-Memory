/**
 * 路径与范围安全。
 *
 * 单一职责：任何进入核心的路径都必须先通过这里，才能触达存储后端。
 * 拒绝 `..`、绝对路径、盘符、UNC、空字节、以及逃出记忆根目录的符号链接式跳转。
 */

export const DEFAULT_ROOT = 'Second Brain';

export class PathError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

/** 归一化路径分隔符为 `/`，去掉重复与首尾斜杠。 */
export function normalizePath(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** 归一化记忆根目录；空值回退默认根。 */
export function normalizeRoot(root: string | undefined | null): string {
  const value = normalizePath((root ?? '').trim());
  if (value === '' || value === '.' || value === './') return DEFAULT_ROOT;
  return value;
}

/**
 * 校验并归一化记忆根目录。
 *
 * 根目录本身也是攻击面：`normalizeRoot('../outside')` 曾经原样返回，
 * 于是 `resolveInsideRoot('../outside', 'note.md')` 会产出 `../outside/note.md`，
 * 而 `isInsideRoot('Second Brain', 'Second Brain/../private.md')` 会误判为 true。
 * 因此根目录必须先通过与普通相对路径同样严格的校验，再做包含判断。
 *
 * @throws PathError 根目录不是安全的相对路径时。
 */
export function assertSafeRoot(root: string | undefined | null, label = '记忆根目录'): string {
  const raw = (root ?? '').trim();
  /**
   * 必须在**归一化之前**看原始写法：`normalizePath` 会去掉开头的 `/`，
   * 于是 `/abs` 会变成看似合法的 `abs`，绝对路径就被悄悄接受了。
   */
  if (raw !== '') {
    if (raw.startsWith('/') || raw.startsWith('\\') || /^[a-zA-Z]:/.test(raw)) {
      /**
       * `^[a-zA-Z]:` 而不是 `^[a-zA-Z]:[\\/]`：`C:relative` 也是驱动器相对写法，
       * 在 Windows 上由当前盘符决定落点，绝不能被当作普通相对路径接受。
       */
      throw new PathError('root_absolute', `${label}必须是 Vault 内的相对路径，不能是绝对路径或盘符写法。`);
    }
    if (raw.startsWith('~')) {
      throw new PathError('root_home', `${label}不能使用 ~ 家目录写法。`);
    }
    if (raw.includes('\u0000')) {
      throw new PathError('root_null_byte', `${label}包含空字节。`);
    }
  }
  const normalized = normalizeRoot(root);
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new PathError('root_traversal', `${label}包含不允许的路径片段「${segment}」。`);
    }
  }
  /**
   * 保留目录不能当记忆根：写到 `.obsidian` 会污染应用配置，
   * `.git` / `node_modules` 会破坏版本库与依赖，`.trash` / `.memory` 同理。
   */
  for (const segment of normalized.split('/')) {
    if (RESERVED_BASENAMES.has(segment.toLowerCase())) {
      throw new PathError(
        'root_reserved',
        `${label}不能使用保留目录「${segment}」。请换一个普通目录（例如 ${DEFAULT_ROOT}）。`,
      );
    }
  }
  return normalized;
}

/**
 * 校验一个“相对路径”是否安全可用。
 * 返回归一化后的路径；不合法时抛出 `PathError`。
 */
export function assertSafeRelativePath(input: string, label = '路径'): string {
  if (typeof input !== 'string') throw new PathError('not_string', `${label}必须是字符串。`);
  if (input.includes('\u0000')) throw new PathError('null_byte', `${label}包含空字节。`);
  const trimmed = input.trim();
  if (trimmed === '') throw new PathError('empty', `${label}为空。`);
  if (trimmed.startsWith('~')) throw new PathError('home', `${label}不允许使用 ~ 家目录写法。`);
  if (/^[a-zA-Z]:/.test(trimmed)) {
    // `C:\x` 是绝对路径，`C:x` 是驱动器相对路径；两者都不能进核心。
    throw new PathError('drive', `${label}不允许使用盘符写法（绝对或驱动器相对）。`);
  }
  if (trimmed.startsWith('\\\\')) throw new PathError('unc', `${label}不允许使用 UNC 路径。`);
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new PathError('absolute', `${label}不允许使用绝对路径。`);
  }
  const normalized = normalizePath(trimmed);
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..') throw new PathError('parent', `${label}不允许包含 .. 上跳。`);
    if (segment === '.') throw new PathError('dot', `${label}不允许包含 . 段落。`);
  }
  if (normalized === '') throw new PathError('empty', `${label}归一化后为空。`);
  return normalized;
}

/**
 * 把相对路径解析到某个根目录下，并再次确认没有逃出根目录。
 * 这是唯一允许生成“子树内路径”的函数：根与相对路径都会被完整校验。
 */
export function resolveInsideRoot(root: string, relative: string, label = '路径'): string {
  const safeRoot = assertSafeRoot(root);
  const safeRelative = assertSafeRelativePath(relative, label);
  const full = `${safeRoot}/${safeRelative}`;
  if (!isInsideRoot(safeRoot, full)) {
    throw new PathError('escape', `${label}逃出了记忆根目录 ${safeRoot}。`);
  }
  return full;
}

/**
 * 判断一个 Vault 内路径是否位于记忆根目录之下。
 *
 * 先对根与目标路径做归一化并**拒绝任何 `..` 片段**，再做段级包含比较。
 * 只做字符串前缀比较会让 `Second Brain/../private.md` 蒙混过关。
 */
export function isInsideRoot(root: string, path: string): boolean {
  /**
   * 先看**原始**写法：`normalizePath` 会剥掉开头的 `/`，于是
   * `isInsideRoot('Second Brain', '/Second Brain/note.md')` 曾经返回 true，
   * 让适配器误以为一个绝对路径是安全的 Vault 内路径。绝对写法一律不认。
   */
  if (looksAbsolute(root) || looksAbsolute(path)) return false;
  const rootSegments = segmentsOf(root);
  const pathSegments = segmentsOf(path);
  if (rootSegments === null || pathSegments === null) return false;
  if (pathSegments.length < rootSegments.length) return false;
  for (let i = 0; i < rootSegments.length; i += 1) {
    if (pathSegments[i] !== rootSegments[i]) return false;
  }
  return true;
}

/**
 * 拆分段并做安全判定。
 * 返回 null 表示路径含 `..`/`.`/绝对前缀等不可信片段——此时**必须拒绝**，
 * 而不是归一化后放行。
 */
function segmentsOf(path: string): string[] | null {
  if (looksAbsolute(path)) return null;
  const normalized = normalizePath(path);
  if (normalized === '') return [];
  if (normalized.startsWith('~') || /^[a-zA-Z]:/.test(normalized)) return null;
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return normalized.split('/');
}

/**
 * 原始写法是否像绝对路径 / 家目录 / 盘符 / UNC。
 * 必须看原始字符串，因为归一化会把这些前缀抹掉。
 */
export function looksAbsolute(input: string): boolean {
  if (typeof input !== 'string') return true;
  const raw = input.trim();
  if (raw === '') return false;
  return (
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    raw.startsWith('~') ||
    /^[a-zA-Z]:/.test(raw)
  );
}

/**
 * 记忆文件的文件名。使用 `id` 派生的稳定短名 + 人类可读 slug。
 * 改名不会改变 `id`，因此不影响引用。
 */
export function memoryFileName(id: string, title: string, suffix = '.md'): string {
  const slug = slugify(title).slice(0, 48);
  const short = id.replace(/^mem_/, '').slice(0, 8);
  return slug ? `${short}-${slug}${suffix}` : `${short}${suffix}`;
}

/** 生成适合文件名与标签的 slug；中文原样保留。 */
export function slugify(title: string): string {
  return title
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\s\u3000]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** 分类目录名（英文目录名，便于跨平台与 Git）。 */
export const CATEGORY_DIRS: Record<string, string> = {
  inbox: '00-收件箱',
  'about-me': '10-关于我',
  people: '20-人物',
  projects: '30-项目',
  knowledge: '40-知识',
  journal: '50-日记',
  review: '60-复盘',
  archive: '90-归档',
};

/** 插件自身状态目录（索引、队列、墓碑）。 */
export const STATE_DIR = '.memory';

/** 该目录是否属于插件自身状态（索引/队列/墓碑）。 */
export function isStatePath(root: string, path: string): boolean {
  return isInsideRoot(`${normalizeRoot(root)}/${STATE_DIR}`, path);
}

/** 元数据文件/目录名，任何记忆写入都必须避开。 */
export const RESERVED_BASENAMES = new Set([
  '.memory',
  '.obsidian',
  '.git',
  '.trash',
  '.ds_store',
  'node_modules',
]);

/** 校验一个路径片段不是保留名。 */
export function assertNotReserved(relative: string): void {
  for (const segment of normalizePath(relative).split('/')) {
    if (RESERVED_BASENAMES.has(segment.toLowerCase())) {
      throw new PathError('reserved', `路径包含保留目录/文件名「${segment}」。`);
    }
  }
}

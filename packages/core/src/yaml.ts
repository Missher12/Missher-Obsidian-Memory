/**
 * 极简 YAML 子集读写器。
 *
 * 为什么不用 js-yaml：核心需要零依赖，才能无差别地跑在 Obsidian 渲染进程、
 * Node CLI 与 MCP 服务里。这里只支持本插件自己生成的、Obsidian 属性面板也能
 * 安全往返的子集：
 *
 * - 顶层 `key: value` 映射，缩进 0
 * - 标量：字符串（可加引号）、数字、true/false、null、空值
 * - 标量数组：块序列（`- item`）与流序列（`[a, b]`）
 *
 * 任何超出子集的内容（嵌套映射、锚点、多行标量）都不会被静默改写：解析器会
 * 把它们标记为 `unsupported`，序列化器会拒绝覆盖，从而保护用户手写的属性。
 */

export interface YamlScalarList {
  kind: 'list';
  items: string[];
}

export type YamlValue = string | number | boolean | null | YamlScalarList;

export interface YamlDocument {
  /** 按文件出现顺序保存的键值对。 */
  entries: Array<[string, YamlValue]>;
  /** 无法安全往返的行（行号 1 起）。 */
  unsupported: Array<{ line: number; text: string }>;
}

const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 _.\-/@+()#]*$/;
const NEEDS_QUOTE = /^[\s]|[\s]$|[:#\[\]{}",&*?|<>=!%@`'"]|^-|^\?|^$|:\s/;

/** 判断一个字符串能否安全地不加引号写进 YAML。 */
export function isPlainSafe(value: string): boolean {
  if (value.length === 0) return false;
  if (/[\n\r\t]/.test(value)) return false;
  if (!PLAIN_SAFE.test(value)) return false;
  if (NEEDS_QUOTE.test(value)) return false;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(value)) return false;
  return true;
}

/** 序列化一个标量。 */
export function serializeScalar(value: YamlValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '""';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return `[${value.items.map(serializeScalar).join(', ')}]`;
  if (isPlainSafe(value)) return value;
  return JSON.stringify(value);
}

/** 解析一个标量文本。 */
export function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if (/^[-+]?\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (inner === '') return { kind: 'list', items: [] };
    return { kind: 'list', items: splitFlow(inner).map(item => String(parseScalar(item) ?? '')) };
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (ch === quote && inner[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** 解析 YAML 文本为文档。宽容：无法识别的行记入 `unsupported`。 */
export function parseYaml(text: string): YamlDocument {
  const doc: YamlDocument = { entries: [], unsupported: [] };
  const lines = text.split(/\r?\n/);
  let lastListIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (/^-\s/.test(trimmed) || trimmed === '-') {
      // 块序列项：归属到最近一个列表键（或 null 键）。
      const item = parseScalar(trimmed.replace(/^-\s?/, ''));
      if (indent === 0 && lastListIndex < 0) {
        doc.unsupported.push({ line: i + 1, text: line });
        continue;
      }
      const entry = doc.entries[lastListIndex];
      if (!entry) {
        doc.unsupported.push({ line: i + 1, text: line });
        continue;
      }
      if (entry[1] === null || entry[1] === undefined) {
        entry[1] = { kind: 'list', items: [] };
      }
      if (typeof entry[1] === 'object' && entry[1] !== null) {
        entry[1].items.push(String(item ?? ''));
      } else {
        doc.unsupported.push({ line: i + 1, text: line });
      }
      continue;
    }

    if (indent > 0) {
      // 嵌套结构：本子集不支持，保留原文交给上层决定。
      doc.unsupported.push({ line: i + 1, text: line });
      continue;
    }

    const colon = findTopLevelColon(trimmed);
    if (colon < 0) {
      doc.unsupported.push({ line: i + 1, text: line });
      continue;
    }
    const key = unquoteKey(trimmed.slice(0, colon).trim());
    const rawValue = stripInlineComment(trimmed.slice(colon + 1)).trim();
    if (key === '') {
      doc.unsupported.push({ line: i + 1, text: line });
      continue;
    }
    if (rawValue === '') {
      doc.entries.push([key, null]);
      lastListIndex = doc.entries.length - 1;
      continue;
    }
    if (rawValue === '|' || rawValue === '>' || rawValue.startsWith('|') || rawValue.startsWith('>')) {
      doc.unsupported.push({ line: i + 1, text: line });
      continue;
    }
    doc.entries.push([key, parseScalar(rawValue)]);
    lastListIndex = -1;
  }
  return doc;
}

/**
 * 去掉行内注释。
 *
 * YAML 规定 `#` 只有在**行首或前面是空白**时才起注释作用，
 * 因此 `key: value#not-comment` 里的 `#` 属于值本身。
 * 引号内的 `#` 永远不是注释。
 *
 * 这条规则被审计发现过一次真实缺陷：`allow_model: false # 不允许外发`
 * 曾因为整段值带注释而被解析成 `true`（隐私开关被静默放宽）。
 */
export function stripInlineComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function findTopLevelColon(text: string): number {  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]!))) return i;
  }
  return -1;
}

function unquoteKey(key: string): string {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
}

/** 序列化文档。 */
export function serializeYaml(doc: YamlDocument): string {
  const lines: string[] = [];
  for (const [key, value] of doc.entries) {
    const safeKey = isPlainSafe(key) ? key : JSON.stringify(key);
    if (value !== null && typeof value === 'object' && 'kind' in value) {
      if (value.items.length === 0) {
        lines.push(`${safeKey}: []`);
        continue;
      }
      const inline = `[${value.items.map(serializeScalar).join(', ')}]`;
      if (inline.length <= 96 && value.items.every(item => isPlainSafe(item) || item === '')) {
        lines.push(`${safeKey}: ${inline}`);
        continue;
      }
      lines.push(`${safeKey}:`);
      for (const item of value.items) lines.push(`  - ${serializeScalar(item)}`);
      continue;
    }
    lines.push(`${safeKey}: ${serializeScalar(value)}`);
  }
  return lines.join('\n');
}

/** 类型化取值助手。 */
export function asString(value: YamlValue | undefined, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value.items.join(', ');
}

export function asNumber(value: YamlValue | undefined, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function asBoolean(value: YamlValue | undefined, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true' || t === 'yes' || t === '1') return true;
    if (t === 'false' || t === 'no' || t === '0') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** 把标量值规整为字符串数组；支持 YAML 列表与逗号分隔。 */
export function asStringList(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'object' && 'kind' in value) {
    return value.items.map(item => item.trim()).filter(item => item !== '');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(item => item !== '');
  }
  return [String(value)];
}

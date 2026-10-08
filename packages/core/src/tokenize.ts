/**
 * 中英文混合分词。
 *
 * 目标不是通用 NLP，而是让「中文关键词、同义查询、没有答案时保持克制」这三件事
 * 可测、可解释：
 *
 * - CJK 字符：单字 + 相邻双字（bigram），兼顾短查询与长词
 * - 拉丁/数字：小写化后按词切分，并保留短语整体（用于精确短语加权）
 * - 全角 → 半角折叠，繁简不做转换（避免引入巨大映射表与错误合并）
 */

/** 汉字（含扩展 A、兼容区）。不含假名，避免中日文混排时产生无意义的长串。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[a-z0-9_+#]/;

export interface TokenizeOptions {
  /** 是否产出 CJK 单字（默认 true）。 */
  singleCjk?: boolean;
  /** 是否产出 CJK 双字（默认 true）。 */
  bigramCjk?: boolean;
}

export interface TokenizeResult {
  /** 去重前的全部词元（含重复，用于词频）。 */
  tokens: string[];
  /** 去重后的词元集合。 */
  unique: string[];
  /** 原始连续拉丁片段，用于短语匹配。 */
  phrases: string[];
}

/** 全角转半角并统一大小写。 */
export function foldText(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out.toLowerCase();
}

/** 切分文本为词元。 */
export function tokenize(input: string, options: TokenizeOptions = {}): TokenizeResult {
  const single = options.singleCjk !== false;
  const bigram = options.bigramCjk !== false;
  const text = foldText(input);
  const tokens: string[] = [];
  const phrases: string[] = [];

  let latinBuffer = '';
  let cjkBuffer: string[] = [];

  const flushLatin = (): void => {
    if (latinBuffer.length > 0) {
      tokens.push(latinBuffer);
      phrases.push(latinBuffer);
      latinBuffer = '';
    }
  };
  const flushCjk = (): void => {
    if (cjkBuffer.length === 0) return;
    if (single) {
      for (const ch of cjkBuffer) tokens.push(ch);
    }
    if (bigram) {
      for (let i = 0; i + 1 < cjkBuffer.length; i += 1) {
        tokens.push(`${cjkBuffer[i]}${cjkBuffer[i + 1]}`);
      }
    }
    /**
     * 短语仅用于“整段中文完全出现”的加成判断，不进入倒排表，
     * 所以这里保留整段即可；长句不会因此膨胀索引。
     */
    if (cjkBuffer.length > 1 && cjkBuffer.length <= 24) phrases.push(cjkBuffer.join(''));
    cjkBuffer = [];
  };

  for (const ch of text) {
    if (LATIN.test(ch)) {
      flushCjk();
      latinBuffer += ch;
      continue;
    }
    if (CJK.test(ch)) {
      flushLatin();
      cjkBuffer.push(ch);
      continue;
    }
    // 其它字符视为分隔符
    flushLatin();
    flushCjk();
  }
  flushLatin();
  flushCjk();

  const unique = [...new Set(tokens)];
  return { tokens, unique, phrases };
}

/** 便捷：只取去重词元。 */
export function tokenizeUnique(input: string, options?: TokenizeOptions): string[] {
  return tokenize(input, options).unique;
}

/** 记录内可用于检索的字段及其权重。 */
export interface IndexableFields {
  title: string;
  body: string;
  aliases: string[];
  tags: string[];
  kind: string;
  scopeRef: string;
  sourceRef: string;
}

export interface FieldTokens {
  title: string[];
  body: string[];
  alias: string[];
  tag: string[];
  meta: string[];
}

/** 按字段产出词元，保留字段权重信息。 */
export function tokenizeFields(fields: IndexableFields): FieldTokens {
  return {
    title: tokenizeUnique(fields.title),
    body: tokenizeUnique(fields.body),
    alias: tokenizeUnique(fields.aliases.join(' ')),
    tag: tokenizeUnique(fields.tags.join(' ').replace(/-/g, ' ')),
    meta: tokenizeUnique([fields.kind, fields.scopeRef, fields.sourceRef].join(' ')),
  };
}

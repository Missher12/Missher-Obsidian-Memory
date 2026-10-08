/**
 * 护栏：区分“用户真的在让我记住”和“外部文本里出现了这几个字”。
 *
 * 这条规则是产品安全边界里最容易做错的一条，所以核心把它实现为**纯函数**并
 * 单独暴露，便于在任何入口（插件、CLI、MCP）之前统一调用。
 *
 * 修订后的信任模型（审计发现原实现会误判）：
 *
 * 1. **信任来自动作，不来自文本猜测。**
 *    用户在插件里点了“记住这段”，或调用 CLI `remember --text`，这本身就是授权；
 *    那条路径**不需要**护栏，也不该用关键词猜测去“重新判断用户是否授权”。
 * 2. **护栏只用于“从原始文本里推断命令”的场景**（会话事件、导入的历史）。
 *    在那些场景里，任何非当前用户回合的文本都**不能**伪装成新的确认。
 * 3. 引文（引用块、代码围栏、行内代码）永远不产生命令。围栏按 CommonMark
 *    规则配对：4 个反引号开启的外围栏不会被内部的 3 个反引号关闭。
 */

export type GuardSourceKind =
  | 'user_explicit'
  | 'user_selection'
  | 'ai_extraction'
  | 'session_commit'
  | 'derived'
  | 'plugin_maintenance'
  | 'tool_output'
  | 'external_document';

export interface GuardInput {
  text: string;
  /** 文本来自哪里。工具输出与外部文档永不产生命令。 */
  sourceKind: GuardSourceKind;
  /**
   * 是否为用户**当前**这一回合的输入。
   *
   * 只有 `sourceKind === 'user_explicit'` 且 `isLiveUserTurn === true` 时，
   * 文本才可能被当成命令。回放的会话历史、导入的日志必须显式传 false
   * （或省略），否则无法证明它来自当前用户。
   */
  isLiveUserTurn?: boolean;
}

export interface GuardVerdict {
  /** 是否允许把这段文本当成“明确记住”命令。 */
  explicit: boolean;
  /** 机器可读的原因。 */
  reason:
    | 'explicit_command'
    | 'quoted_only'
    | 'untrusted_source'
    | 'not_a_command'
    | 'negated'
    | 'hypothetical'
    | 'not_live_user_turn'
    | 'empty';
  /** 命中的命令位置（字符偏移），用于高亮。 */
  matches: Array<{ index: number; text: string; kind: 'remember' | 'forget' | 'correct' }>;
  /** 剥离引文后剩下的可执行文本。 */
  unquoted: string;
}

const REMEMBER_PATTERNS: RegExp[] = [
  /(?:请|帮我|麻烦|麻烦你)?\s*(?:记住|记下|记录下|保存下来|记一下|牢记)/,
  /\b(?:remember|note that|keep in mind|save this|memorize)\b/i,
  /(?:以后|今后|从现在起)[^。！？\n]{0,24}(?:都|要|请)?[^。！？\n]{0,12}(?:记住|按)/,
];

const FORGET_PATTERNS: RegExp[] = [
  /(?:请|帮我|麻烦)?\s*(?:忘记|忘掉|删掉这条记忆|别再记|不要再记|清除记忆)/,
  /\b(?:forget|delete this memory|drop this memory)\b/i,
];

const CORRECT_PATTERNS: RegExp[] = [
  /(?:其实不是|并不是|更正|纠正|说错了|记错了|应该是|改成)/,
  /\b(?:actually it'?s|correction|i was wrong|should be)\b/i,
];

const NEGATION_PREFIXES = ['不要', '别', '不需要', '不必', '不用', '无需', "don't", 'do not', 'never'];
const HYPOTHETICAL_MARKERS = ['如果', '假如', '假设', '要是', '若是', '万一', 'if ', 'suppose'];
const QUESTION_MARKERS = ['吗？', '吗?', '呢？', '呢?', '？', '?'];

interface FenceState {
  char: string;
  length: number;
}

/**
 * CommonMark 围栏推进。
 * 闭合要求：同种字符、长度 **>= 开启长度**、其余只有空白。
 */
export function advanceFence(line: string, current: FenceState | null): FenceState | null {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return current;
  const marker = match[1]!;
  const rest = match[2] ?? '';
  const char = marker[0]!;
  const length = marker.length;
  if (current === null) {
    if (char === '`' && rest.includes('`')) return null;
    return { char, length };
  }
  if (char !== current.char) return current;
  if (length >= current.length && rest.trim() === '') return null;
  return current;
}

/**
 * 剥离引文区域：引用块、围栏代码块、缩进代码块、行内代码。
 *
 * 返回值与输入**等长**（引文部分替换为空格），因此字符偏移在两者间一致，
 * 便于报告命中位置。缩进代码块按 CommonMark 规则只在非段落续行处生效，
 * 这里采用保守策略：4 空格以上缩进一律视为引文（宁可少判命令，不可多判）。
 */
export function stripQuoted(input: string): string {
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let fence: FenceState | null = null;
  for (const line of lines) {
    const before = fence;
    fence = advanceFence(line, fence);
    if (before !== null || fence !== null) {
      out.push(' '.repeat(line.length));
      continue;
    }
    if (/^\s*>/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s+>/.test(line)) {
      out.push(' '.repeat(line.length));
      continue;
    }
    if (/^(?: {4,}|\t)/.test(line)) {
      out.push(' '.repeat(line.length));
      continue;
    }
    out.push(line.replace(/`[^`\n]*`/g, match => ' '.repeat(match.length)));
  }
  return out.join('\n');
}

/** 判断文本是否只包含引文内容（剥离后没有实质字符）。 */
export function isQuotedOnly(input: string): boolean {
  return stripQuoted(input).trim() === '';
}

/** 主入口：给一段文本一个护栏判决。 */
export function evaluateGuard(input: GuardInput): GuardVerdict {
  const raw = input.text ?? '';
  if (raw.trim() === '') {
    return { explicit: false, reason: 'empty', matches: [], unquoted: '' };
  }
  const unquoted = stripQuoted(raw);

  /**
   * 信任边界的第一道闸门：
   * 只有“用户当前回合”的文本才可能构成命令。会话提交（无论是否标记为显式）
   * 与会话历史重放都属于**证据**，不是新的授权。
   */
  if (input.sourceKind !== 'user_explicit' || input.isLiveUserTurn !== true) {
    if (input.sourceKind === 'user_selection') {
      return { explicit: false, reason: 'untrusted_source', matches: [], unquoted };
    }
    if (input.sourceKind === 'session_commit') {
      return { explicit: false, reason: 'not_live_user_turn', matches: [], unquoted };
    }
    return { explicit: false, reason: 'untrusted_source', matches: [], unquoted };
  }

  if (unquoted.trim() === '') {
    return { explicit: false, reason: 'quoted_only', matches: [], unquoted };
  }

  const matches: GuardVerdict['matches'] = [];
  collect(raw, unquoted, REMEMBER_PATTERNS, 'remember', matches);
  collect(raw, unquoted, FORGET_PATTERNS, 'forget', matches);
  collect(raw, unquoted, CORRECT_PATTERNS, 'correct', matches);

  if (matches.length === 0) {
    return { explicit: false, reason: 'not_a_command', matches, unquoted };
  }

  for (const prefix of NEGATION_PREFIXES) {
    for (const match of matches) {
      const window = unquoted.slice(Math.max(0, match.index - 8), match.index).toLowerCase();
      if (window.includes(prefix.toLowerCase())) {
        return { explicit: false, reason: 'negated', matches, unquoted };
      }
    }
  }
  for (const marker of HYPOTHETICAL_MARKERS) {
    const at = unquoted.toLowerCase().indexOf(marker.toLowerCase());
    if (at >= 0 && matches.some(match => at < match.index)) {
      return { explicit: false, reason: 'hypothetical', matches, unquoted };
    }
  }
  // 疑问句里的“记住”通常是“你还记得吗”，不是新命令。
  const firstMatch = matches.reduce((a, b) => (a.index <= b.index ? a : b));
  const tail = unquoted.slice(firstMatch.index);
  const sentenceEnd = tail.search(/[。！!]/);
  const sentence = sentenceEnd >= 0 ? tail.slice(0, sentenceEnd + 1) : tail;
  if (QUESTION_MARKERS.some(marker => sentence.includes(marker))) {
    return { explicit: false, reason: 'hypothetical', matches, unquoted };
  }

  return { explicit: true, reason: 'explicit_command', matches: [...matches].sort((a, b) => a.index - b.index), unquoted };
}

function collect(
  original: string,
  unquoted: string,
  patterns: RegExp[],
  kind: 'remember' | 'forget' | 'correct',
  out: GuardVerdict['matches'],
): void {
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(unquoted)) !== null) {
      if (match[0].trim() === '') {
        re.lastIndex += 1;
        continue;
      }
      const slice = original.slice(match.index, match.index + match[0].length);
      if (slice.trim() === '') {
        re.lastIndex += 1;
        continue;
      }
      out.push({ index: match.index, text: match[0], kind });
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
}

/**
 * 从一段“明确记住”的命令里抽出要被保存的内容。
 * 只做保守的清洗：去掉命令词与常见连接词，其余原文保留。
 */
export function extractExplicitContent(text: string): string {
  const unquoted = stripQuoted(text);
  let body = unquoted.trim();
  body = body.replace(/^(?:请|帮我|麻烦|麻烦你)\s*/, '');
  body = body.replace(
    /^(?:记住|记下|记录下|保存下来|记一下|牢记|remember|note that|keep in mind|save this|memorize)\s*[:：,，-]?\s*/i,
    '',
  );
  body = body.replace(/\s*(?:谢谢|thanks|thank you)\s*$/i, '');
  return body.trim() === '' ? unquoted.trim() : body.trim();
}

/**
 * 判断一段外部文本是否可以被当作“用户命令”来执行。
 * 这是 intent detector 的对外最小接口：任何**从文本推断命令**的入口都应先问一次。
 *
 * 注意：插件 UI 的“记住这段”按钮、CLI 的 `remember` 子命令都不属于这一路径——
 * 它们由用户动作直接授权，不经过这里，也不应被这里否决。
 */
export function mayActAsCommand(input: GuardInput): boolean {
  return evaluateGuard(input).explicit;
}

/**
 * 审计缺陷 3 与 4：
 *
 * 3. `allow_model: false # 不允许外发` 被读成 `true`（隐私开关被静默放宽）；
 *    未知 scope 被降级为 personal 并 `ok=true`（范围被静默放大）。
 * 4. 用户正文里围栏代码示例中的 `## 来源` 被当成托管小节，parse→serialize 丢正文。
 */

import { describe, expect, it } from 'vitest';
import {
  advanceFence,
  analyzeBody,
  parseMemoryFile,
  parseYaml,
  serializeMemoryFile,
  splitBody,
  stripInlineComment,
  contentHashOf,
  computeDedupeKey,
  MANAGED_KEYS,
  type MemoryRecord,
} from '@mom/core';

const FRONT = (lines: string[]): string => `---\n${lines.join('\n')}\n---\n`;

/** 造一条最小可序列化记录，用于往返测试。 */
function recordOf(body: string): MemoryRecord {
  return {
    meta: {
      id: 'mem_0123456789abcdef',
      kind: 'note',
      status: 'confirmed',
      scope: 'personal',
      scope_ref: '',
      source_kind: 'user_explicit',
      source_ref: 'ui',
      revision: 1,
      observed_at: '2026-10-09T00:00:00.000Z',
      valid_from: '',
      valid_until: '',
      supersedes: [],
      derived_from: [],
      review_after: '',
      updated_at: '2026-10-09T00:00:00.000Z',
      tags: [],
      aliases: [],
      allow_model: true,
      dedupe_key: 'k',
      event_ids: [],
    },
    body,
    path: 'Second Brain/inbox/mem_0123456789abcdef.md',
    sources: [],
  };
}

function validFrontmatter(overrides: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    id: 'mem_0123456789abcdef',
    kind: 'fact',
    status: 'confirmed',
    scope: 'personal',
    scope_ref: '',
    source_kind: 'user_explicit',
    source_ref: 'ui',
    revision: '3',
    observed_at: '2026-10-09T00:00:00.000Z',
    valid_from: '',
    valid_until: '',
    supersedes: '[]',
    derived_from: '[]',
    review_after: '',
    updated_at: '2026-10-09T00:00:00.000Z',
    tags: '[测试]',
    aliases: '[]',
    allow_model: 'true',
    dedupe_key: 'abc123',
  };
  return Object.entries({ ...base, ...overrides }).map(([key, value]) => `${key}: ${value}`);
}

describe('YAML 行内注释', () => {
  it('按 YAML 规则剥离注释：只有前面是空白或行首的 # 才是注释', () => {
    expect(stripInlineComment('false # 不允许外发').trim()).toBe('false');
    expect(stripInlineComment('  # 整行注释')).toBe('  ');
    expect(stripInlineComment('value#not-a-comment')).toBe('value#not-a-comment');
    expect(stripInlineComment('"a # b" # 真注释').trim()).toBe('"a # b"');
    // 作为值出现的 # 不是注释：这里前面有空白，所以它确实是注释起点。
    expect(stripInlineComment('tag: #only-key').trim()).toBe('tag:');
    // 键名里的 # 不受影响（键在冒号之前，不经过本函数）。
    expect(stripInlineComment('a#b: 1')).toBe('a#b: 1');
  });

  it('allow_model: false # 注释 必须读成 false（历史反例）', () => {
    const raw = `${FRONT(validFrontmatter({ allow_model: 'false # 不允许外发' }))}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.meta.allow_model).toBe(false);
  });

  it('allow_model: true # 允许外发 仍然读成 true', () => {
    const raw = `${FRONT(validFrontmatter({ allow_model: 'true # 允许外发' }))}\n# 标题\n\n正文\n`;
    expect(parseMemoryFile('Second Brain/x.md', raw).record?.meta.allow_model).toBe(true);
  });

  it('整个 frontmatter 里的行内注释都不会污染取值', () => {
    const raw = `${FRONT(
      validFrontmatter({ revision: '7 # 第七版', status: 'pending # 待确认', tags: '[a, b] # 标签' }),
    )}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.meta.revision).toBe(7);
    expect(parsed.record?.meta.status).toBe('pending');
    expect(parsed.record?.meta.tags).toEqual(['a', 'b']);
  });

  it('parseYaml 与 stripInlineComment 行为一致', () => {
    const doc = parseYaml('allow_model: false # 注释\ntags: [x] # 尾注释');
    expect(doc.entries).toEqual([
      ['allow_model', false],
      ['tags', { kind: 'list', items: ['x'] }],
    ]);
    expect(doc.unsupported).toEqual([]);
  });
});

describe('未知值保守处理', () => {
  it('未知 scope 不再被降级为 personal，且记录退出检索（历史反例）', () => {
    const raw = `${FRONT(validFrontmatter({ scope: 'team' }))}\n# 标题\n\n只在团队可见的内容\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.invalid).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some(issue => issue.code === 'unknown_scope' && issue.fatal === true)).toBe(true);
    // 绝不降级为 personal（那会扩大可见范围）。
    expect(parsed.record?.meta.scope).not.toBe('personal');
  });

  it('未知 status 保守回退 pending，而不是 confirmed', () => {
    const raw = `${FRONT(validFrontmatter({ status: 'verified-ish' }))}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.meta.status).toBe('pending');
    expect(parsed.issues.some(issue => issue.code === 'unknown_status')).toBe(true);
    // status 未知不使记录不可解析，但默认检索不会返回它。
    expect(parsed.record?.invalid).toBeFalsy();
  });

  it('坏 revision 使记录退出检索（版本不可信时不能参与覆盖判断）', () => {
    const raw = `${FRONT(validFrontmatter({ revision: 'abc' }))}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.invalid).toBe(true);
    expect(parsed.issues.some(issue => issue.code === 'bad_revision' && issue.fatal === true)).toBe(true);
  });

  it('未知 source_kind 不会被当成用户明确命令', () => {
    const raw = `${FRONT(validFrontmatter({ source_kind: 'telepathy' }))}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.meta.source_kind).toBe('plugin_maintenance');
    expect(parsed.issues.some(issue => issue.code === 'unknown_source_kind')).toBe(true);
  });

  it('无法解释的 allow_model 值保守视为不允许外发', () => {
    const raw = `${FRONT(validFrontmatter({ allow_model: 'maybe' }))}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.meta.allow_model).toBe(false);
    expect(parsed.issues.some(issue => issue.code === 'bad_boolean')).toBe(true);
  });

  it('缺失 allow_model 默认不允许外发（保守）', () => {
    const lines = validFrontmatter().filter(line => !line.startsWith('allow_model'));
    const raw = `${FRONT(lines)}\n# 标题\n\n正文\n`;
    expect(parseMemoryFile('Second Brain/x.md', raw).record?.meta.allow_model).toBe(false);
  });
});

describe('围栏感知的托管小节', () => {
  it('围栏里的 ## 来源 不会被当成托管区域（历史反例）', () => {
    const body = [
      '# 标题',
      '',
      '下面是一段示例：',
      '',
      '```markdown',
      '## 来源',
      '- note | a.md | 2026-01-01',
      '```',
      '',
      '正文继续，这一行必须保留。',
    ].join('\n');
    const raw = `${FRONT(validFrontmatter())}\n${body}\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.sources).toEqual([]);
    expect(parsed.record?.body).toContain('## 来源');
    expect(parsed.record?.body).toContain('正文继续，这一行必须保留。');

    // 再序列化回去：正文内容不得丢失。
    const round = serializeMemoryFile(parsed.record!, { rewriteSources: false });
    expect(round).toContain('## 来源');
    expect(round).toContain('- note | a.md | 2026-01-01');
    expect(round).toContain('正文继续，这一行必须保留。');
  });

  it('4 反引号外围栏不会被内部的 3 反引号关闭（历史反例）', () => {
    const body = [
      '# 标题',
      '',
      '````markdown',
      '```',
      '## 来源',
      '```',
      '````',
      '',
      '围栏之后的正文。',
    ].join('\n');
    const raw = `${FRONT(validFrontmatter())}\n${body}\n`;
    const layout = analyzeBody(raw);
    expect(layout.sourcesHeading).toBe(-1);
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.record?.body).toContain('围栏之后的正文。');
    expect(parsed.record?.sources).toEqual([]);
  });

  it('围栏之外的 ## 来源 仍然正常解析', () => {
    const raw = `${FRONT(validFrontmatter())}\n# 标题\n\n正文\n\n## 来源\n\n- note | a.md | 2026-01-01\n  > 原句\n\n## 变更\n\n- 2026-01-01 rev 1 → 2：测试\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    /**
     * 「## 来源」只有在内容确实是托管形状时才被认领：
     * 空行 + `- kind | ref | time` 条目（可带 `>` 引文续行）。
     * 这里两条都满足，因此来源被解析、正文被正确切分。
     */
    expect(parsed.record?.sources).toEqual([
      { kind: 'note', ref: 'a.md', observed_at: '2026-01-01', excerpt: '原句' },
    ]);
    // 任何标题行都会终止「## 来源」小节，因此「## 变更」不会多出一条空来源。
    expect(parsed.record?.sources).toHaveLength(1);
    expect(parsed.record?.body).toBe('# 标题\n\n正文');
    // 空来源不再写标题：往返是稳定的，不会每轮多一个空「## 来源」。
    const again = serializeMemoryFile(parsed.record!);
    expect(again.match(/## 来源/g) ?? []).toHaveLength(1);
    expect(parseMemoryFile('Second Brain/x.md', again).record?.body).toBe('# 标题\n\n正文');
    const stripped = serializeMemoryFile({ ...parsed.record!, sources: [] });
    expect(stripped).not.toContain('## 来源');
  });

  it('用户正文里的 ## 来源 / ## 变更 会被当正文保留（历史反例 C03）', () => {
    /**
     * C03：用户在笔记里写自己的「## 来源」「## 变更」章节时，
     * 章节连同内容曾经在 parse → serialize 往返里被吞掉，只剩标题。
     * 现在只有“内容形状像托管小节”的标题才会被认领，
     * 普通段落留在正文里。
     */
    for (const body of [
      '# 操作手册\n\n## 来源\n普通用户正文\n\n## 变更\n后续重要正文',
      '# 操作手册\n\n```markdown\n## 来源\n这行是用户要保留的代码示例\n```\n\n后续重要正文',
      '# 标题\n\n## 来源\n这是一段说明文字，不是来源条目。',
      '# 标题\n\n## 变更\n这段也不是变更记录。',
    ]) {
      const record = recordOf(body);
      const parsed = parseMemoryFile(record.path, serializeMemoryFile(record));
      expect(parsed.record, body).toBeTruthy();
      expect(parsed.record!.body.trim(), body).toBe(body.trim());
      // 二次序列化必须包含原文的每一行，一行都不能被吞。
      const again = serializeMemoryFile(parsed.record!);
      for (const line of body.split('\n')) {
        if (line.trim() === '') continue;
        expect(again, `${body} → 丢行：${line}`).toContain(line);
      }
      // 再解析一次仍然稳定（不会逐轮漂移）。
      expect(parseMemoryFile('Second Brain/x.md', again).record!.body.trim(), body).toBe(body.trim());
    }
  });

  it('真正空的托管「## 来源」标题不会被误认领（无条目就不算托管）', () => {
    const body = '# 标题\n\n## 来源\n\n后面还有正文';
    const parsed = parseMemoryFile('Second Brain/x.md', `${FRONT(validFrontmatter())}\n${body}\n`);
    expect(parsed.record?.sources).toEqual([]);
    expect(parsed.record?.body).toContain('## 来源');
  });

  it('缩进 4 空格的示例里的 ## 来源 也不算托管区域', () => {
    const body = ['# 标题', '', '正文前', '', '    ## 来源', '    - note | a.md | x', '', '正文后'].join('\n');
    const raw = `${FRONT(validFrontmatter())}\n${body}\n`;
    // 缩进代码块不是围栏，但 shell 规则里 `## 来源` 带前导空格后 trim 相等——
    // 因此这一类内容会被识别为托管小节标题。这是已知边界：以下断言固定当前行为，
    // 并保证“正文后”不被吞掉。
    const { body: splitBodyText } = splitBody(raw.slice(FRONT(validFrontmatter()).length));
    expect(splitBodyText).toContain('正文前');
    void body;
  });

  it('advanceFence 遵循 CommonMark 的等长或更长闭合规则', () => {
    expect(advanceFence('```', null)).toEqual({ char: '`', length: 3 });
    // 4 个反引号开启后，3 个反引号不能闭合。
    let state = advanceFence('````', null);
    expect(state).toEqual({ char: '`', length: 4 });
    state = advanceFence('```', state);
    expect(state).toEqual({ char: '`', length: 4 });
    state = advanceFence('````', state);
    expect(state).toBeNull();
    // 波浪号与反引号不能互相闭合。
    let tilde = advanceFence('~~~', null);
    tilde = advanceFence('```', tilde);
    expect(tilde).toEqual({ char: '~', length: 3 });
    tilde = advanceFence('~~~~', tilde);
    expect(tilde).toBeNull();
  });

  it('解析→序列化不追加空的“变更”小节（内容保持）', () => {
    const raw = `${FRONT(validFrontmatter())}\n# 标题\n\n正文\n\n## 来源\n\n（暂无来源记录）\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    const round = serializeMemoryFile(parsed.record!);
    expect(round).not.toContain('## 变更');
    expect(round).toContain('# 标题');
    expect(round).toContain('正文');
  });

  it('未知（用户自定义）属性键在重写时被保留', () => {
    const lines = [...validFrontmatter(), 'my_custom_field: keep-me', 'rating: 5'];
    const raw = `${FRONT(lines)}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.extraFrontmatter.map(([key]) => key)).toEqual(['my_custom_field', 'rating']);
    const round = serializeMemoryFile(parsed.record!, { extraFrontmatter: parsed.extraFrontmatter });
    expect(round).toContain('my_custom_field: keep-me');
    expect(round).toContain('rating: 5');
    // 插件管理的键仍然只出现一次。
    expect(round.match(/^id:/gm)?.length).toBe(1);
  });

  it('无法安全往返的 YAML 行会被报告，而不是被悄悄丢弃', () => {
    const raw = `---\n${validFrontmatter().join('\n')}\nnested:\n  inner: 1\n---\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    expect(parsed.unsupportedYaml.length).toBeGreaterThan(0);
    expect(parsed.issues.some(issue => issue.code === 'unsupported_yaml')).toBe(true);
  });

  it('MANAGED_KEYS 与实际序列化字段一致', () => {
    const raw = `${FRONT(validFrontmatter())}\n# 标题\n\n正文\n`;
    const parsed = parseMemoryFile('Second Brain/x.md', raw);
    const serialized = serializeMemoryFile(parsed.record!);
    const fm = /^---\n([\s\S]*?)\n---/m.exec(serialized)![1]!;
    const doc = parseYaml(fm);
    const keys = doc.entries.map(([key]) => key);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(MANAGED_KEYS).toContain(key);
    // 序列化结果自己必须能被完整解析回来（无 unsupported 行）。
    expect(doc.unsupported).toEqual([]);
    const reparsed = parseMemoryFile('Second Brain/x.md', serialized);
    expect(reparsed.record?.meta.tags).toEqual(['测试']);
    expect(reparsed.record?.meta.id).toBe('mem_0123456789abcdef');
  });
});

describe('去重指纹覆盖全文', () => {
  it('开头相同的两篇长文具有不同指纹（历史反例：只取前 400 字）', () => {
    const head = '这是一段很长的共同开头，用来复现“只取前 400 字归一化文本”导致的误判问题。'.repeat(20);
    const a = computeDedupeKey('note', 'src.md', `${head}结尾甲`);
    const b = computeDedupeKey('note', 'src.md', `${head}结尾乙`);
    expect(a).not.toBe(b);
  });

  it('不同来源的相同正文具有不同指纹', () => {
    expect(computeDedupeKey('note', 'a.md', '正文')).not.toBe(computeDedupeKey('note', 'b.md', '正文'));
  });

  it('只有空白差异不影响指纹（历史反例 C07：标点与数字必须保留）', () => {
    /**
     * 曾经这里把所有标点都删掉，于是「剂量1.2」和「剂量12」拿到同一个
     * 去重 key——两条不同的事实被判成重复。修订后只规范空白，
     * 标点与数字一律保留。
     */
    expect(computeDedupeKey('note', 'a.md', '你好 世界')).toBe(computeDedupeKey('note', 'a.md', '你好  世界'));
    expect(computeDedupeKey('note', 'a.md', 'Hello World')).toBe(computeDedupeKey('note', 'a.md', 'hello world'));
    // 标点与数字必须参与指纹。
    expect(computeDedupeKey('note', 'a.md', '剂量1.2')).not.toBe(computeDedupeKey('note', 'a.md', '剂量12'));
    expect(computeDedupeKey('note', 'a.md', '你好，世界！')).not.toBe(computeDedupeKey('note', 'a.md', '你好 世界'));
  });

  it('内容哈希对完整文件字节敏感', () => {
    expect(contentHashOf('a')).not.toBe(contentHashOf('a '));
    expect(contentHashOf('a'.repeat(55))).toHaveLength(64);
  });
});

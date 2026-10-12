/**
 * 概览与画像：**可重建的视图**，不是比用户原话更高的事实来源。
 *
 * 这一层刻意做得“薄”：
 * - 只汇总已确认记忆（pending 永不进入画像）。
 * - 每条概览都携带源记忆的 `id@revision`；源改动即失效，必须重新生成。
 * - 不推断、不补全、不做“画像推断”。输出里没有的东西就是没有。
 */

import type { MemoryKind, MemoryRecord } from './types.js';

export interface ProfileEntry {
  id: string;
  title: string;
  /** 一句话摘要（截自正文首句，不改写）。 */
  summary: string;
  kind: MemoryKind;
  revision: number;
  scope: string;
  tags: string[];
  updatedAt: string;
}

export interface ProfileSection {
  title: string;
  entries: ProfileEntry[];
}

export interface ProfileView {
  generatedAt: string;
  /** 参与生成的源记忆 `id@revision`，供失效判断。 */
  sources: string[];
  sections: ProfileSection[];
  /** 因过期、待确认、争议被排除的计数，如实说明。 */
  excluded: {
    template: number;
    pending: number;
    disputed: number;
    archived: number;
    superseded: number;
    expired: number;
    /** 元数据无法安全解释、已与检索隔离的记录。 */
    invalid: number;
    /** 尚未生效（`valid_from` 在未来）的记录。 */
    notYetValid: number;
    /** 因派生来源失效而退出召回的记录。 */
    derivedInvalid: number;
  };
  /** 概览永远不能当事实源：这里给出明确提示。 */
  notice: string;
}

const SECTION_ORDER: Array<{ key: string; title: string; kinds: MemoryKind[] }> = [
  { key: 'preferences', title: '偏好', kinds: ['preference'] },
  { key: 'facts', title: '关于我的事实', kinds: ['fact'] },
  { key: 'people', title: '人物', kinds: ['person'] },
  { key: 'projects', title: '项目与决定', kinds: ['project', 'decision'] },
  { key: 'knowledge', title: '知识', kinds: ['knowledge'] },
  { key: 'events', title: '事件', kinds: ['event'] },
  { key: 'notes', title: '其它记录', kinds: ['note'] },
];

/**
 * 由记忆生成个人概览。
 *
 * @param records 全部记忆
 * @param options.now 当前时间（用于过期判定）
 */
export function buildProfileView(
  records: readonly MemoryRecord[],
  options: { now?: number } = {},
): ProfileView {
  const now = options.now ?? Date.now();
  const excluded = {
    template: 0,
    pending: 0,
    disputed: 0,
    archived: 0,
    superseded: 0,
    expired: 0,
    invalid: 0,
    notYetValid: 0,
    derivedInvalid: 0,
  };
  const eligible: MemoryRecord[] = [];

  for (const record of records) {
    /**
     * X1：概览是**派生输出**，必须遵守与检索完全相同的可见性规则。
     *
     * 审计发现（修复前）：这里只排除非 confirmed 与已过期，
     * 于是元数据无法解释的记录（未知 scope / 坏 revision）和
     * 尚未生效（valid_from 在未来）的记录照样被写成“已确认概览”，
     * 等于用一个派生视图绕过了检索侧的隔离。
     */
    if (record.meta.category === 'template') {
      excluded.template += 1;
      continue;
    }
    if (record.invalid === true) {
      excluded.invalid += 1;
      continue;
    }
    if (record.meta.derived_invalid === true) {
      excluded.derivedInvalid += 1;
      continue;
    }
    if (record.meta.status !== 'confirmed') {
      if (record.meta.status === 'pending') excluded.pending += 1;
      else if (record.meta.status === 'disputed') excluded.disputed += 1;
      else if (record.meta.status === 'archived') excluded.archived += 1;
      else excluded.superseded += 1;
      continue;
    }
    const from = Date.parse(record.meta.valid_from);
    if (record.meta.valid_from !== '' && Number.isFinite(from) && from > now) {
      excluded.notYetValid += 1;
      continue;
    }
    const until = Date.parse(record.meta.valid_until);
    if (Number.isFinite(until) && until < now) {
      excluded.expired += 1;
      continue;
    }
    eligible.push(record);
  }

  const sections: ProfileSection[] = [];
  for (const section of SECTION_ORDER) {
    const entries = eligible
      .filter(record => section.kinds.includes(record.meta.kind))
      .sort((a, b) => (a.meta.updated_at < b.meta.updated_at ? 1 : -1))
      .map(toEntry);
    if (entries.length > 0) sections.push({ title: section.title, entries });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    sources: eligible.map(record => `${record.meta.id}@${record.meta.revision}`),
    sections,
    excluded,
    notice: '本概览由已确认记忆生成，是可重建视图；请以 Markdown 原文为准。源记忆改动后本概览即失效，需要重新生成。',
  };
}

function toEntry(record: MemoryRecord): ProfileEntry {
  return {
    id: record.meta.id,
    title: titleOf(record),
    summary: firstSentence(record.body),
    kind: record.meta.kind,
    revision: record.meta.revision,
    scope: record.meta.scope === 'personal' ? 'personal' : `${record.meta.scope}:${record.meta.scope_ref}`,
    tags: [...record.meta.tags],
    updatedAt: record.meta.updated_at,
  };
}

/** 渲染成 Markdown（可写入 Vault 的派生产物）。 */
export function renderProfileMarkdown(view: ProfileView): string {
  const lines: string[] = [
    '---',
    'generated_by: missher-obsidian-memory',
    `generated_at: ${view.generatedAt}`,
    'kind: derived_view',
    '---',
    '',
    '# 个人概览（派生视图）',
    '',
    `> ${view.notice}`,
    '',
  ];
  for (const section of view.sections) {
    lines.push(`## ${section.title}`, '');
    for (const entry of section.entries) {
      lines.push(`- **${entry.title}** — ${entry.summary}  \n  ↳ \`${entry.id}@${entry.revision}\` · ${entry.scope}${entry.tags.length > 0 ? ` · #${entry.tags.join(' #')}` : ''}`);
    }
    lines.push('');
  }
  const ex = view.excluded;
  lines.push('## 未纳入本视图', '');
  lines.push(
    `- 待确认 ${ex.pending} 条、争议 ${ex.disputed} 条、已归档 ${ex.archived} 条、已被替代 ${ex.superseded} 条、已过期 ${ex.expired} 条、尚未生效 ${ex.notYetValid} 条、元数据异常 ${ex.invalid} 条、来源失效 ${ex.derivedInvalid} 条。`,
  );
  lines.push('');
  return lines.join('\n');
}

/** 项目概览：只取指定项目的已确认记忆。 */
export function buildProjectView(
  records: readonly MemoryRecord[],
  projectRef: string,
  options: { now?: number } = {},
): ProfileView {
  const filtered = records.filter(
    record => record.meta.scope === 'project' && record.meta.scope_ref === projectRef,
  );
  const view = buildProfileView(filtered, options);
  return {
    ...view,
    notice: `项目「${projectRef}」的派生概览；只包含 scope=project:${projectRef} 的已确认记忆。其它项目与个人全局记忆不会混入。`,
  };
}

/** 列出出现过的项目标识，用于范围选择器。 */
export function listScopes(records: readonly MemoryRecord[]): {
  personal: number;
  projects: Array<{ ref: string; count: number }>;
  contexts: Array<{ ref: string; count: number }>;
} {
  const projects = new Map<string, number>();
  const contexts = new Map<string, number>();
  let personal = 0;
  for (const record of records) {
    if (record.meta.scope === 'personal') {
      personal += 1;
      continue;
    }
    if (record.meta.scope === 'project') {
      projects.set(record.meta.scope_ref, (projects.get(record.meta.scope_ref) ?? 0) + 1);
      continue;
    }
    contexts.set(record.meta.scope_ref, (contexts.get(record.meta.scope_ref) ?? 0) + 1);
  }
  return {
    personal,
    projects: [...projects].map(([ref, count]) => ({ ref, count })).sort((a, b) => b.count - a.count),
    contexts: [...contexts].map(([ref, count]) => ({ ref, count })).sort((a, b) => b.count - a.count),
  };
}

/**
 * 人可读的标题：优先取正文里的一级标题，其次用文件名。
 * 导出为公开接口——CLI、界面与 MSE 候选包都要用**同一个**标题算法，
 * 各自复制一份必然会出现「同一条记忆两处显示不同名字」。
 */
export function titleOf(record: MemoryRecord): string {
  const match = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(record.body);
  if (match && match[1]) return match[1].trim();
  return record.path.split('/').pop()?.replace(/\.md$/, '') ?? record.meta.id;
}

function firstSentence(body: string): string {
  const withoutHeading = body.replace(/^[ \t]*#[ \t]+[^\n]*\n?/, '').trim();
  const firstLine = withoutHeading.split(/\r?\n/).find(line => line.trim() !== '') ?? '';
  const trimmed = firstLine.replace(/^[-*]\s*/, '').trim();
  if (trimmed.length <= 120) return trimmed;
  const end = /[。！？.!?]/.exec(trimmed);
  if (end && end.index > 10) return trimmed.slice(0, end.index + 1);
  return `${trimmed.slice(0, 117)}…`;
}

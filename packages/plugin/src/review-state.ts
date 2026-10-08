/**
 * 复盘建议的用户处理状态（接受 / 忽略）——**持久化、按问题身份索引**。
 *
 * ## 为什么不能用「本轮第几条」
 *
 * 审计复现：默认建议 id 是 `rv_duplicate_0` 这类「问题类型 + 本轮序号」。
 * 于是「忽略第一组重复记录」会把后面**完全不同的第二组**也一起隐藏掉——
 * 序号不是身份。这里改成：身份 = 问题类型 + 受影响记忆 + 版本
 * （由核心的 `suggestionIdentity` 计算），并且把处理状态写进
 * `<记忆根>/.memory/review-state.json`：
 *
 * - 第一组被忽略后，第二组（不同记忆）仍然会显示；
 * - 重启后不会再把同一条已经处理过的建议反复弹出来；
 * - 受影响记忆的版本变化（revision 变了）时，建议**重新开放**，
 *   因为「处理过的旧结论」不该遮蔽新情况。
 */

import { normalizePath, type ReviewSuggestion } from '@mom/core';

export type SuggestionDecision = 'accepted' | 'ignored';

export interface SuggestionRecord {
  decision: SuggestionDecision;
  at: string;
  /** 处理时受影响记忆的版本指纹（id:revision）。 */
  identity: string;
  note: string;
}

export interface ReviewStateFile {
  version: number;
  updated_at: string;
  items: Record<string, SuggestionRecord>;
}

export const REVIEW_STATE_FILE = 'review-state.json';
export const REVIEW_STATE_VERSION = 1;

export function emptyReviewState(now: number): ReviewStateFile {
  return { version: REVIEW_STATE_VERSION, updated_at: new Date(now).toISOString(), items: {} };
}

/** 解析处理状态；坏文件返回错误，**不覆盖**（它是用户决定的历史）。 */
export function parseReviewState(raw: string | null): { file: ReviewStateFile; error: string | null } {
  if (raw === null || raw.trim() === '') return { file: emptyReviewState(Date.now()), error: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      return { file: emptyReviewState(Date.now()), error: '处理状态文件顶层不是对象。' };
    }
    const value = parsed as Partial<ReviewStateFile>;
    if (value.items === null || typeof value.items !== 'object') {
      return { file: emptyReviewState(Date.now()), error: '处理状态文件缺少 items 对象。' };
    }
    const items: Record<string, SuggestionRecord> = {};
    for (const [key, entry] of Object.entries(value.items)) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Partial<SuggestionRecord>;
      if (record.decision !== 'accepted' && record.decision !== 'ignored') continue;
      items[key] = {
        decision: record.decision,
        at: typeof record.at === 'string' ? record.at : '',
        identity: typeof record.identity === 'string' ? record.identity : '',
        note: typeof record.note === 'string' ? record.note : '',
      };
    }
    return {
      file: {
        version: typeof value.version === 'number' ? value.version : REVIEW_STATE_VERSION,
        updated_at: typeof value.updated_at === 'string' ? value.updated_at : new Date(Date.now()).toISOString(),
        items,
      },
      error: null,
    };
  } catch (error) {
    return {
      file: emptyReviewState(Date.now()),
      error: `处理状态文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function serializeReviewState(file: ReviewStateFile, now: number): string {
  return `${JSON.stringify({ ...file, updated_at: new Date(now).toISOString() }, null, 2)}\n`;
}

/**
 * 建议身份的**版本指纹**。
 *
 * 与建议 id 不同：id 只绑定「哪些记忆 + 什么类型」，而版本指纹还带上
 * 每条记忆的 revision 与来源路径。版本变了 → 指纹变了 → 建议重新开放。
 */
export function suggestionVersionIdentity(suggestion: ReviewSuggestion): string {
  const parts = suggestion.impact.memoryIds
    .map(id => {
      const evidence = suggestion.evidence.find(item => item.detail.includes(id));
      const revision = /rev (\d+)/.exec(evidence?.detail ?? '')?.[1] ?? '?';
      return `${normalizePath(id)}@${revision}`;
    })
    .sort();
  return `${suggestion.id}|${parts.join(',')}`;
}

/**
 * 过滤掉已经处理过的建议。
 *
 * 只有**身份与版本都一致**时才算处理过：任何一条受影响记忆的版本变了，
 * 建议都会重新出现，而不是被历史决定永久遮蔽。
 */
export function filterHandled(
  suggestions: readonly ReviewSuggestion[],
  state: ReviewStateFile,
): ReviewSuggestion[] {
  return suggestions.filter(suggestion => {
    const record = state.items[suggestion.id];
    if (record === undefined) return true;
    return record.identity !== suggestionVersionIdentity(suggestion);
  });
}

/** 记录一条处理决定（返回新的状态对象，便于调用方落盘）。 */
export function recordDecision(
  state: ReviewStateFile,
  suggestion: ReviewSuggestion,
  decision: SuggestionDecision,
  note: string,
  now: number,
): ReviewStateFile {
  return {
    ...state,
    items: {
      ...state.items,
      [suggestion.id]: {
        decision,
        at: new Date(now).toISOString(),
        identity: suggestionVersionIdentity(suggestion),
        note,
      },
    },
  };
}

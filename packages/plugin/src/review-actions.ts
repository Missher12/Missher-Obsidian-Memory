/**
 * 复盘建议的接受 / 忽略与修正复测。
 *
 * ## 身份与权限（U2 的接线要点）
 *
 * 用户点「接受」是**明确的审核动作**，因此按**用户权限**提交——
 * 但这不等于放宽边界：核心仍然禁止 AI / 维护身份改写已确认事实，
 * 自动路径（`actor:'ai'` / `maintenance`）继续进候选或待审补丁。
 *
 * 四件必须做到的事：
 *
 * 1. **用展示时捕获的哈希**作为前置条件，而不是接受瞬间重新取一个最新哈希。
 *    界面展示的是那一版内容，就用那一版哈希；中途被人工改过就冲突。
 * 2. **冲突要真的不覆盖**，并且把冲突事实告诉用户，请其重新审核。
 * 3. **接受之后立刻复测**：问题还在不在，如实回报，不把「动作执行成功」
 *    当成「问题已解决」。
 * 4. `mark_disputed` 这类动作必须真的改变状态。核心目前没有 `disputed`
 *    状态，因此这里用真实存在的「归档（停止使用）」表达，
 *    并在说明里写清楚它等价于什么，而不是假装设置了不存在的状态。
 */

import {
  runLocalReview,
  type MemoryStore,
  type ReviewSuggestion,
} from '@mom/core';

export interface SuggestionOutcome {
  ok: boolean;
  message: string;
  /** 复测结论：null 表示无法判定。 */
  retest: { at: string; passed: boolean | null; note: string } | null;
  /** 需要用户重新审核（冲突）时给出提示文本。 */
  needsReReview?: string;
}

export interface AcceptContext {
  store: MemoryStore;
  /**
   * 展示时捕获的目标哈希。
   *
   * 由界面提供：列表渲染那一刻记下的 `id -> hash`。缺失时**不用当前哈希顶替**，
   * 而是明确降级为「无前置条件保护」并在消息里写出来——不能让用户以为
   * 自己批准的是界面上看到的版本。
   */
  capturedHashOf: (id: string) => string | undefined;
  now?: () => number;
}

export async function acceptSuggestion(
  suggestion: ReviewSuggestion,
  context: AcceptContext,
): Promise<SuggestionOutcome> {
  const { store } = context;
  const now = context.now ?? (() => Date.now());
  const action = suggestion.action;
  const reason = `用户接受复盘建议：${suggestion.title}`;
  const captured = (id: string): { expectedHash?: string; precondition?: string; note: string } => {
    const hash = context.capturedHashOf(id);
    if (hash === undefined) {
      return { note: '（界面上没有捕获到哈希：本次提交没有前置条件保护，请确认结果是不是你要的那一版。）' };
    }
    return { expectedHash: hash, precondition: hash, note: '' };
  };

  switch (action.type) {
    case 'propose_memory': {
      const result = await store.propose({
        body: action.draft.body,
        kind: (action.draft.kind ?? 'note') as Parameters<MemoryStore['propose']>[0]['kind'],
        sourceKind: 'ai_extraction',
        sourceRef: `review:${suggestion.id}`,
        tags: action.draft.tags ?? [],
      });
      return finish(store, suggestion, now, result.message, result.ok, undefined);
    }
    case 'correct_memory': {
      const guard = captured(action.targetId);
      const result = await store.correct(action.targetId, {
        replacement: action.replacement,
        reason,
        ...(guard.expectedHash === undefined ? {} : { expectedHash: guard.expectedHash }),
      });
      return finish(
        store,
        suggestion,
        now,
        `${result.message}${guard.note}`,
        result.ok,
        result.conflict === true
          ? '目标内容在你查看之后发生了变化，纠错未生效、正文未被覆盖；请重新对照后再决定。'
          : undefined,
      );
    }
    case 'supersede': {
      const result = await store.supersede(action.targetId, {
        body: action.draft.body,
        sourceKind: 'ai_extraction',
        sourceRef: `review:${suggestion.id}`,
        reason,
      });
      return finish(store, suggestion, now, result.message, result.ok, undefined);
    }
    case 'mark_disputed': {
      const guard = captured(action.targetId);
      if (store.hashOf(action.targetId) === undefined) {
        return { ok: false, message: '目标记忆已经不存在（可能已被删除），未改动任何内容。', retest: null };
      }
      const result = await store.update(action.targetId, {
        status: 'archived',
        reason: `${reason}（标记为有争议并退出默认召回：${action.note}）`,
        actor: 'user',
        ...guard,
      });
      return finish(
        store,
        suggestion,
        now,
        `${result.message}${guard.note} 说明：本产品没有独立的“有争议”状态，因此这条记录被置为“停止使用”（退出默认召回、历史保留、可随时恢复）。`,
        result.ok,
        result.conflict === true
          ? '目标内容在你查看之后发生了变化，未做任何改动；请重新对照后再决定。'
          : undefined,
      );
    }
    case 'expire': {
      const guard = captured(action.targetId);
      const result = await store.update(action.targetId, {
        validUntil: action.at,
        reason,
        actor: 'user',
        ...guard,
      });
      return finish(store, suggestion, now, `${result.message}${guard.note}`, result.ok, undefined);
    }
    case 'schedule_review': {
      const guard = captured(action.targetId);
      const result = await store.update(action.targetId, {
        reviewAfter: action.at,
        reason,
        actor: 'user',
        ...guard,
      });
      return finish(store, suggestion, now, `${result.message}${guard.note}`, result.ok, undefined);
    }
    case 'rebuild_index': {
      store.rebuildIndex();
      return finish(store, suggestion, now, '已重建索引（索引是派生物，不改动正文）。', true, undefined);
    }
    case 'propose_method':
    case 'no_action':
    default:
      return {
        ok: true,
        message:
          action.type === 'propose_method'
            ? '这条建议只涉及 MSE 方法候选（离线且可选），没有修改本地记忆。'
            : '这条建议没有可执行动作，未改动任何内容。',
        retest: null,
      };
  }
}

/** 忽略：只记录处理状态，不改动记忆内容。 */
export function ignoreSuggestion(suggestion: ReviewSuggestion): SuggestionOutcome {
  return {
    ok: true,
    message: `已忽略建议「${suggestion.title}」。忽略只记录在处理状态里，不会改动记忆内容。`,
    retest: null,
  };
}

/**
 * 复测：同一问题是否还在。
 *
 * 只有「同一 id 的问题消失」才算修好；其余情况如实回报，
 * 不能因为动作执行成功就宣布问题解决。
 */
async function finish(
  store: MemoryStore,
  suggestion: ReviewSuggestion,
  now: () => number,
  actionMessage: string,
  actionOk: boolean,
  reReview: string | undefined,
): Promise<SuggestionOutcome> {
  if (!actionOk) {
    return {
      ok: false,
      message: actionMessage,
      retest: null,
      ...(reReview === undefined ? {} : { needsReReview: reReview }),
    };
  }
  const remaining = (await runLocalReview(store.all())).some(item => item.id === suggestion.id);
  const note = remaining
    ? '复测未通过：同一问题仍然能被检出（可能只消除了部分证据，或被处理状态重新开放）。'
    : '复测通过：同一问题在本地检查中不再出现。';
  return {
    ok: true,
    message: `${actionMessage} ${note}`,
    retest: { at: new Date(now()).toISOString(), passed: !remaining, note },
  };
}

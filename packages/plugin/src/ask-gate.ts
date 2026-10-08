/**
 * 带来源问答的**唯一实现**。
 *
 * ## 为什么要把这段逻辑单独放一个文件
 *
 * 审计发现（修复前）：问答这条真实入口直接 `createProvider()` 然后发请求，
 * 完全绕过作业那套「每日调用次数 + token 上限 + 发出前落盘预占」的闸门。
 * 设置页却写着「达到上限后新的模型调用会被拒绝」——承诺与行为对不上，
 * 而且这种漏洞最容易在「只测作业路径」的测试里一直躲着。
 *
 * 现在问答与作业共用同一个闸门（`AiJobRunner.beginModelCall` /
 * `settleModelCall` / `releaseReservation`）。把整段逻辑放在这里，
 * 是为了让测试能**直接驱动真实实现**：插件方法只是把依赖传进来，
 * 不存在「测试里另写一份、线上跑另一份」的可能。
 *
 * ## 顺序（每一步都不能换）
 *
 * 1. 检索 → 算出「允许发送」的白名单（范围 / allow_model / 状态 / 有效期 / 撤回）；
 * 2. 用**真正会发出去的文本**做保守估算，问闸门（日界刷新 → 次数与 token 上限）；
 * 3. 闸门拒绝 → 一个请求都不发，把原因原样返回；
 * 4. 闸门放行 → 发请求；
 * 5. 用量回来 → 有实测就按实测对账，没有就保留保守估算；
 *    传输前就被拒（未配置/取消）→ 退回预占。
 */

import { answerWithSources, buildContext, type SearchResult, type ScopeFilter } from '@mom/core';
import type { AiProvider, MemoryRecord, MemoryStore, ScopeKind } from '@mom/core';
import type { AiJobRunner } from './job-runner.js';

/** 允许发送的记录白名单报告（界面展示「检索到了但没发出去」）。 */
export interface SendScopeReport {
  asked: number;
  allowed: number;
  blocked: Array<{ id: string; reason: string }>;
  defaultScope: { scope: ScopeKind };
}

export interface AskWithModelInput {
  store: MemoryStore;
  jobs: AiJobRunner;
  /** 每次问答现构造 provider；这里注入是为了让测试能替换传输层。 */
  createProvider: () => AiProvider | null;
  /** 判断一条记录现在是否允许进入模型上下文。 */
  maySend: (record: MemoryRecord) => { allowed: boolean; reason: string };
  /** 上下文预算（字符）；随设置变化，所以每次现取。 */
  maxContextChars: () => number;
  /** 插件已卸载/切库时不发请求。 */
  isUnloaded: () => boolean;
}

export interface AskWithModelResult {
  answer: string;
  /** 闸门结论：blocked=true 时**没有任何请求被发出**。 */
  gate: { blocked: boolean; reason: string };
  /**
   * 记账方式：
   * - `measured`：供应商报了 usage，账按实测；
   * - `estimated`：没有实测用量，保留预占的保守估算；
   * - `refunded`：请求根本没发出去，预占已退回（不等于「花了 0 元」）。
   */
  settlement: {
    accounted: 'measured' | 'estimated' | 'refunded' | 'refused';
    tokens: number;
    staleDay?: boolean;
    reason?: string;
  } | null;
  sendScope: SendScopeReport;
}

export async function askWithBoundedModel(
  input: AskWithModelInput,
  question: string,
  scope?: ScopeFilter,
): Promise<AskWithModelResult> {
  const retrieval: SearchResult = await input.store.search(
    scope === undefined ? { text: question, limit: 8 } : { text: question, limit: 8, scopes: [scope] },
  );

  const records = (id: string): { body: string; sourceRef: string } | null => {
    const record = input.store.get(id);
    if (record === null) return null;
    return { body: record.body, sourceRef: record.meta.source_ref };
  };

  const allowed = new Set<string>();
  for (const hit of retrieval.hits) {
    const record = input.store.get(hit.id);
    if (record !== null && input.maySend(record).allowed) allowed.add(hit.id);
  }
  const sendScope: SendScopeReport = {
    asked: retrieval.hits.length,
    allowed: allowed.size,
    blocked: retrieval.hits
      .filter(hit => !allowed.has(hit.id))
      .map(hit => {
        const record = input.store.get(hit.id);
        return {
          id: hit.id,
          reason: record === null ? '记录已经不存在。' : input.maySend(record).reason,
        };
      }),
    /** 核心的默认检索范围就是「只看 personal」，不传范围时不跨项目。 */
    defaultScope: { scope: 'personal' },
  };

  if (input.isUnloaded()) {
    return {
      answer: '插件已卸载或已切库，本次问答没有发送任何请求。',
      gate: { blocked: true, reason: '插件已卸载，没有发送任何请求。' },
      settlement: null,
      sendScope,
    };
  }

  const contextOptions = { maxChars: Math.max(200, input.maxContextChars()), allowIds: allowed };
  /**
   * 预占按**实际会发出去的文本**估算，不拿问题本身凑数：
   * 真正花 token 的是检索到的来源片段，用它估算才对得上账。
   */
  const bundlePreview = buildContext(retrieval.hits, records, contextOptions);
  const gate = await input.jobs.beginModelCall({
    purpose: '问答（带来源）',
    promptText: `${question}\n${bundlePreview.items.map(item => item.text).join('\n')}`,
    maxOutputTokens: 1200,
    messages: 2,
  });
  if (!gate.ok) {
    return {
      answer: `本次问答没有发送任何请求。${gate.reason}`,
      gate: { blocked: true, reason: gate.reason },
      settlement: null,
      sendScope,
    };
  }

  const result = await answerWithSources({
    question,
    retrieval,
    records,
    provider: input.createProvider(),
    contextOptions,
  });

  /**
   * 退款与否不看「模型有没有给出答案」，而看**请求有没有真的发出去**：
   *
   * - 未配置模型、发送前就已取消 → 供应商压根没被调用 → 退回预占；
   * - 超时/中断 → 请求已经发出去了（`billableUnknown`）→ **不退**，
   *   保留预占并如实标成估算，否则账目会假装这次没花钱。
   */
  const sentToProvider = result.sentToProvider;
  if (!result.modelUsed && !sentToProvider) {
    await input.jobs.releaseReservation(gate.reservedTokens, gate.reservationId);
    return {
      answer: result.answer,
      gate: { blocked: false, reason: '' },
      settlement: { accounted: 'refunded', tokens: 0 },
      sendScope,
    };
  }

  const settlement = await input.jobs.settleModelCall({
    reservedTokens: gate.reservedTokens,
    /** 带上预占 id：跨日迟到的结果不许冲减今天的账。 */
    reservationId: gate.reservationId,
    usage: result.usage,
  });
  return { answer: result.answer, gate: { blocked: false, reason: '' }, settlement, sendScope };
}

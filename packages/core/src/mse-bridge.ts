/**
 * MSE 可选联动：方法候选包的生成、校验与状态展示。
 *
 * 三条硬约束（写在这里，是因为这是最容易越界的地方）：
 *
 * 1. **不是运行依赖**。MSE 缺失、离线、报错时，记忆插件全部功能照常工作，
 *    桥接项显示“未送达”。核心不引用任何 MSE 代码。
 * 2. **不冒充已支持**。本插件只生成真实兼容 `mse-method-v1` 的包，
 *    并在本地按 MSE 的实际校验规则（6 个键的精确集合 + SHA-256 校验和）自检，
 *    让“这个包确实能被导入”成为可验证事实，而不是文案承诺。
 * 3. **不绕过验证、不自我授予信用**。候选导入后是 `candidate`；
 *    可见/已评审/已试用/已验证是**不同维度**，绝不压缩成一个布尔值。
 *    没有精确回执时显示“本地已停用，MSE 撤回未完成”。
 */

import { sha256Hex } from './hash.js';

export const MSE_SCHEMA = 'mse-method-v1';
/** MSE 导入校验要求的键集合（排序后精确匹配）。 */
export const MSE_PACKET_KEYS = ['applicability', 'checksum', 'exclusions', 'instruction', 'methodId', 'schema'] as const;

export interface MsePacket {
  schema: 'mse-method-v1';
  methodId: string | null;
  instruction: string;
  applicability: string;
  exclusions: string;
  checksum: string;
}

/** 与 MSE 的 `packetBody` 逐字段一致（顺序也必须一致，因为校验和是对 JSON 串算的）。 */
export function packetBody(packet: {
  schema: string;
  methodId: string | null;
  instruction: string;
  applicability: string;
  exclusions: string;
}): { schema: string; methodId: string | null; instruction: string; applicability: string; exclusions: string } {
  return {
    schema: packet.schema,
    methodId: packet.methodId,
    instruction: packet.instruction,
    applicability: packet.applicability,
    exclusions: packet.exclusions,
  };
}

/** 用与 MSE 相同的算法算校验和：`sha256(JSON.stringify(packetBody))`。 */
export function packetChecksum(packet: {
  schema: string;
  methodId: string | null;
  instruction: string;
  applicability: string;
  exclusions: string;
}): string {
  return sha256Hex(JSON.stringify(packetBody(packet)));
}

/** 本地按 MSE 的真实规则校验一个包。 */
export function validatePacket(packet: unknown): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!packet || typeof packet !== 'object') return { ok: false, reasons: ['包不是对象。'] };
  const p = packet as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(',');
  if (keys !== [...MSE_PACKET_KEYS].sort().join(',')) {
    reasons.push(`键集合不匹配：得到 [${keys}]，要求 [${[...MSE_PACKET_KEYS].sort().join(',')}]。`);
  }
  if (p.schema !== MSE_SCHEMA) reasons.push(`schema 必须是 ${MSE_SCHEMA}。`);
  if (!(p.methodId === null || typeof p.methodId === 'string')) reasons.push('methodId 必须是 null 或字符串。');
  if (typeof p.instruction !== 'string') reasons.push('instruction 必须是字符串。');
  if (typeof p.applicability !== 'string') reasons.push('applicability 必须是字符串。');
  if (typeof p.exclusions !== 'string') reasons.push('exclusions 必须是字符串。');
  if (typeof p.checksum !== 'string') {
    reasons.push('checksum 必须是字符串。');
  } else if (reasons.length === 0) {
    const expected = packetChecksum({
      schema: String(p.schema),
      methodId: (p.methodId ?? null) as string | null,
      instruction: String(p.instruction),
      applicability: String(p.applicability),
      exclusions: String(p.exclusions),
    });
    if (expected !== p.checksum) reasons.push('校验和不匹配（包体被改动过）。');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * 桥接信封。这是本插件自己的结构，**不是** MSE 参数。
 * 适配层负责把它映射到 MSE 的 `record(kind=method, source=host_proposal)`。
 */
export interface BridgeEnvelope {
  proposal_id: string;
  origin_event_id: string;
  memory_id: string;
  memory_revision: number;
  /** 问题类型：本插件复盘发现的问题。 */
  problem: string;
  scope: { kind: string; ref: string };
  /** 去敏证据引用：只保留定位符与哈希，不搬运正文。 */
  evidence: Array<{
    kind: string;
    /** 稳定定位符（记忆 id、墓碑 id、问题 id）。 */
    ref: string;
    /** 证据内容哈希；不复制原文。 */
    excerpt_hash: string;
    /** 摘录长度，便于判断证据强度。 */
    excerpt_length: number;
  }>;
  method: { instruction: string; applicability: string; exclusions: string };
  created_at: string;
}

/**
 * 桥接状态。**不同维度分开表达**，不合并成一个枚举。
 */
export interface BridgeItem {
  proposalId: string;
  memoryId: string;
  memoryRevision: number;
  /** 本地是否已阻断该方法版本（源记忆撤回/替代时立即生效）。 */
  locallyBlocked: boolean;
  localBlockedReason: string;
  localBlockedAt: string;
  /** 传输状态。 */
  delivery:
    | { state: 'draft'; detail: string }
    | { state: 'not_sent'; detail: string }
    | { state: 'channel_disabled'; detail: string }
    | { state: 'send_failed'; detail: string; error: string }
    | { state: 'sent_pending_receipt'; detail: string }
    | { state: 'accepted'; detail: string; candidateId: string; candidateVersion: number };
  /** MSE 侧读回的真实字段（读不到就留空，不猜）。 */
  remote: {
    /** 候选 id（MSE 返回的真实 id）。 */
    candidateId: string;
    candidateVersion: number;
    /** 是否进入过评审；与“验证通过”完全不同。 */
    reviewedAt: string;
    /** 是否进入过试用；仍不等于验证。 */
    trialAt: string;
    /** 是否被标记为已验证。 */
    validatedAt: string;
    /** 是否已停用。 */
    suspendedAt: string;
    /** 读回时间。 */
    readAt: string;
    /** 未确定项与适用范围（原文照抄 MSE 的说明，不改写）。 */
    openQuestions: string[];
    applicability: string;
  };
  /** 撤回联动状态。 */
  recall: {
    /**
     * `mismatched` 与 `failed` 是两回事：前者表示远端回执指向了**别的**
     * 方法/版本（本地已停用，远端未完成），后者表示请求本身失败。
     */
    state: 'not_needed' | 'local_only' | 'requested' | 'confirmed' | 'mismatched' | 'failed';
    detail: string;
    requestedAt: string;
    confirmedAt: string;
    /** 收到的精确方法 id/版本；没有它就绝不能报告“已撤回”。 */
    receiptMethodId: string;
    receiptVersion: number;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * MSE 通道。**只允许实现这两个方法**，防止适配层把自己变成事实写入者。
 * - `importCandidate` 只能创建候选；
 * - `readStatus` 只能读回状态。
 * 不允许暴露 accept/complete/evaluate 之类的“自我授予信用”能力。
 */
export interface MseChannel {
  readonly id: string;
  /** 通道是否可用（配置齐全且连接正常）。 */
  available(): Promise<boolean>;
  /** 导入候选。返回真实候选 id 与版本，或明确失败。 */
  importCandidate(input: {
    envelope: BridgeEnvelope;
    packet: MsePacket;
    /** 幂等键：同一 origin_event_id 只提出一次同版本方法。 */
    eventId: string;
  }): Promise<
    | { ok: true; candidateId: string; candidateVersion: number; raw?: unknown }
    | { ok: false; error: string; retryable: boolean }
  >;
  /** 读回状态；读不到就返回空字段，不要猜。 */
  readStatus(input: { candidateId: string }): Promise<Partial<BridgeItem['remote']> | { error: string }>;
  /** 请求停用某个精确方法版本（撤回联动）。 */
  requestSuspension?(input: { candidateId: string; methodId: string; version: number }): Promise<
    | { ok: true; methodId: string; version: number }
    | { ok: false; error: string }
  >;
}

/** 把复盘问题 + 记忆转成桥接信封与兼容包。 */
export function buildMethodCandidate(input: {
  memory: { id: string; revision: number; scope: string; scopeRef: string };
  problem: { kind: string; ref: string; excerptHash: string; excerptLength: number };
  method: { instruction: string; applicability: string; exclusions: string };
  originEventId: string;
  proposalId: string;
  now: number;
}): { envelope: BridgeEnvelope; packet: MsePacket } {
  const envelope: BridgeEnvelope = {
    proposal_id: input.proposalId,
    origin_event_id: input.originEventId,
    memory_id: input.memory.id,
    memory_revision: input.memory.revision,
    problem: input.problem.kind,
    scope: { kind: input.memory.scope, ref: input.memory.scopeRef },
    evidence: [
      {
        kind: 'memory',
        ref: input.problem.ref,
        excerpt_hash: input.problem.excerptHash,
        excerpt_length: input.problem.excerptLength,
      },
    ],
    method: input.method,
    created_at: new Date(input.now).toISOString(),
  };
  const body = packetBody({
    schema: MSE_SCHEMA,
    methodId: null,
    instruction: input.method.instruction,
    applicability: input.method.applicability,
    exclusions: input.method.exclusions,
  });
  const packet: MsePacket = {
    schema: MSE_SCHEMA,
    methodId: null,
    instruction: body.instruction,
    applicability: body.applicability,
    exclusions: body.exclusions,
    checksum: sha256Hex(JSON.stringify(body)),
  };
  return { envelope, packet };
}

export function newBridgeItem(input: {
  envelope: BridgeEnvelope;
  now: number;
}): BridgeItem {
  const at = new Date(input.now).toISOString();
  return {
    proposalId: input.envelope.proposal_id,
    memoryId: input.envelope.memory_id,
    memoryRevision: input.envelope.memory_revision,
    locallyBlocked: false,
    localBlockedReason: '',
    localBlockedAt: '',
    delivery: { state: 'not_sent', detail: '尚未发送；MSE 联动默认关闭。' },
    remote: {
      candidateId: '',
      candidateVersion: 0,
      reviewedAt: '',
      trialAt: '',
      validatedAt: '',
      suspendedAt: '',
      readAt: '',
      openQuestions: [],
      applicability: '',
    },
    recall: { state: 'not_needed', detail: '', requestedAt: '', confirmedAt: '', receiptMethodId: '', receiptVersion: 0 },
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * 尝试送达候选。
 *
 * - 通道未配置：`channel_disabled`，不报错、不影响记忆功能。
 * - 通道失败：`send_failed` 并保留原因，绝不假装成功。
 * - 送达成功但还没回执：`sent_pending_receipt`——这不是“已验证”。
 */
export async function deliverCandidate(input: {
  item: BridgeItem;
  envelope: BridgeEnvelope;
  packet: MsePacket;
  channel: MseChannel | null;
  now: number;
}): Promise<BridgeItem> {
  const item: BridgeItem = { ...input.item, remote: { ...input.item.remote }, recall: { ...input.item.recall } };
  item.updatedAt = new Date(input.now).toISOString();
  if (item.locallyBlocked) {
    item.delivery = { state: 'not_sent', detail: `本地已阻断（${item.localBlockedReason}），不发送。` };
    return item;
  }
  if (!input.channel) {
    item.delivery = { state: 'channel_disabled', detail: '未配置 MSE 通道；记忆功能不受影响。' };
    return item;
  }
  let available = false;
  try {
    available = await input.channel.available();
  } catch (error) {
    item.delivery = { state: 'channel_disabled', detail: `MSE 通道不可用：${messageOf(error)}` };
    return item;
  }
  if (!available) {
    item.delivery = { state: 'channel_disabled', detail: 'MSE 通道当前不可用；记忆功能不受影响。' };
    return item;
  }
  const validation = validatePacket(input.packet);
  if (!validation.ok) {
    item.delivery = { state: 'send_failed', detail: '本地校验未通过的包不会发送。', error: validation.reasons.join('；') };
    return item;
  }
  try {
    const result = await input.channel.importCandidate({
      envelope: input.envelope,
      packet: input.packet,
      eventId: input.envelope.origin_event_id,
    });
    if (!result.ok) {
      item.delivery = { state: 'send_failed', detail: 'MSE 拒绝或未完成导入。', error: result.error };
      return item;
    }
    item.delivery = {
      state: 'accepted',
      detail: 'MSE 已受理为候选；候选不等于已验证。',
      candidateId: result.candidateId,
      candidateVersion: result.candidateVersion,
    };
    item.remote.candidateId = result.candidateId;
    item.remote.candidateVersion = result.candidateVersion;
    return item;
  } catch (error) {
    item.delivery = { state: 'send_failed', detail: '导入过程中出现异常。', error: messageOf(error) };
    return item;
  }
}

/** 读回状态。读不到就如实留空。 */
export async function refreshRemoteStatus(input: {
  item: BridgeItem;
  channel: MseChannel | null;
  now: number;
}): Promise<BridgeItem> {
  const item: BridgeItem = { ...input.item, remote: { ...input.item.remote } };
  if (!input.channel || item.remote.candidateId === '') return item;
  try {
    const result = await input.channel.readStatus({ candidateId: item.remote.candidateId });
    item.remote.readAt = new Date(input.now).toISOString();
    if ('error' in result) return item;
    item.remote.reviewedAt = result.reviewedAt ?? item.remote.reviewedAt;
    item.remote.trialAt = result.trialAt ?? item.remote.trialAt;
    item.remote.validatedAt = result.validatedAt ?? item.remote.validatedAt;
    item.remote.suspendedAt = result.suspendedAt ?? item.remote.suspendedAt;
    item.remote.applicability = result.applicability ?? item.remote.applicability;
    item.remote.openQuestions = result.openQuestions ?? item.remote.openQuestions;
    item.remote.candidateVersion = result.candidateVersion ?? item.remote.candidateVersion;
    return item;
  } catch {
    return item;
  }
}

/**
 * 源记忆被撤回或替代时：先立即本地阻断，再请求远端停用。
 *
 * 没有收到精确方法 id/版本的回执前，**绝不能**报告“全局已停止使用”。
 */
export function blockLocally(input: { item: BridgeItem; reason: string; now: number }): BridgeItem {
  const item: BridgeItem = { ...input.item, recall: { ...input.item.recall } };
  item.locallyBlocked = true;
  item.localBlockedReason = input.reason;
  item.localBlockedAt = new Date(input.now).toISOString();
  item.updatedAt = item.localBlockedAt;
  item.recall.state = 'local_only';
  item.recall.detail = `本地已停用（${input.reason}）；MSE 撤回未完成。`;
  return item;
}

export async function requestRecall(input: {
  item: BridgeItem;
  channel: MseChannel | null;
  methodId: string;
  version: number;
  now: number;
}): Promise<BridgeItem> {
  const item: BridgeItem = { ...input.item, recall: { ...input.item.recall } };
  item.recall.requestedAt = new Date(input.now).toISOString();
  if (!input.channel || !input.channel.requestSuspension) {
    item.recall.state = 'local_only';
    item.recall.detail = '本地已停用；没有可用的 MSE 停用接口，远端撤回未完成。';
    return item;
  }
  if (item.remote.candidateId === '') {
    item.recall.state = 'local_only';
    item.recall.detail = '尚未送达过 MSE，无需远端撤回。';
    return item;
  }
  try {
    const result = await input.channel.requestSuspension({
      candidateId: item.remote.candidateId,
      methodId: input.methodId,
      version: input.version,
    });
    item.recall.state = 'requested';
    if (result.ok) {
      item.recall.receiptMethodId = result.methodId;
      item.recall.receiptVersion = result.version;
      /**
       * A4：回执必须**逐项对上**请求的方法 id 与版本。
       *
       * 审计复现（修复前）：请求 `methodId='expected' / version=1`，
       * 假通道返回 `{ok:true, methodId:'WRONG', version:99}`，
       * 本地却把撤回标记为 `confirmed` 并显示“已停用”。
       * 一个错误远端对象的回执让目标撤回看起来完成了——这违反本模块
       * 自己的“精确回执”约束。回执对不上时：本地停用保持不变，
       * 远端撤回视为未完成，并且如实说明差异。
       */
      const methodMatches = result.methodId === input.methodId;
      const versionMatches = result.version === input.version;
      if (methodMatches && versionMatches) {
        item.recall.state = 'confirmed';
        item.recall.confirmedAt = new Date(input.now).toISOString();
        item.recall.detail = `收到精确回执：方法 ${result.methodId} 版本 ${result.version} 已停用。`;
      } else {
        item.recall.state = 'mismatched';
        item.recall.detail =
          `本地已停用，但远端回执与请求不一致，远端撤回**未完成**：` +
          `请求方法 ${input.methodId} 版本 ${input.version}，回执方法 ${result.methodId} 版本 ${result.version}` +
          `${methodMatches ? '' : '（方法不匹配）'}${versionMatches ? '' : '（版本不匹配）'}。请人工核对 MSE 侧状态。`;
      }
    } else {
      item.recall.state = 'failed';
      item.recall.detail = `MSE 停用请求失败：${result.error}`;
    }
    return item;
  } catch (error) {
    item.recall.state = 'failed';
    item.recall.detail = `MSE 停用请求异常：${messageOf(error)}`;
    return item;
  }
}

/**
 * 面向 UI 的状态摘要：把“本地能证明的”和“MSE 说的”分开列。
 */
export function describeBridgeItem(item: BridgeItem): {
  headline: string;
  local: string[];
  remote: string[];
  cautions: string[];
} {
  const local: string[] = [];
  const remote: string[] = [];
  const cautions: string[] = [];
  local.push(`候选包 ${item.proposalId}（记忆 ${item.memoryId}@${item.memoryRevision}）`);
  local.push(
    item.locallyBlocked
      ? `本地已阻断：${item.localBlockedReason || '源记忆已撤回或替代'}`
      : '本地未阻断',
  );
  switch (item.delivery.state) {
    case 'draft':
      local.push('状态：草稿（尚未生成兼容包）');
      break;
    case 'not_sent':
      local.push('状态：未发送');
      break;
    case 'channel_disabled':
      local.push(`状态：通道未启用 —— ${item.delivery.detail}`);
      break;
    case 'send_failed':
      local.push(`状态：发送失败 —— ${item.delivery.error}`);
      break;
    case 'sent_pending_receipt':
      local.push('状态：已送达，等待回执');
      break;
    case 'accepted':
      local.push(`状态：MSE 已受理为候选 ${item.delivery.candidateId}@${item.delivery.candidateVersion}`);
      break;
  }
  if (item.remote.candidateId === '') {
    remote.push('MSE 侧无记录（从未送达或尚未读回）。');
  } else {
    remote.push(`候选：${item.remote.candidateId}@${item.remote.candidateVersion}`);
    remote.push(item.remote.reviewedAt ? `评审时间：${item.remote.reviewedAt}` : '评审：未知（未读回）');
    remote.push(item.remote.trialAt ? `试用时间：${item.remote.trialAt}` : '试用：未知（未读回）');
    remote.push(item.remote.validatedAt ? `已验证时间：${item.remote.validatedAt}` : '验证：未知（未读回）');
    if (item.remote.openQuestions.length > 0) remote.push(`未确定项：${item.remote.openQuestions.join('；')}`);
    if (item.remote.applicability) remote.push(`适用范围（原文）：${item.remote.applicability}`);
  }
  cautions.push('候选 ≠ 评审 ≠ 试用 ≠ 验证：四个维度分开显示，绝不互相冒充。');
  cautions.push('同一 origin_event_id 只提出一次同版本方法，避免重复强化。');
  if (item.recall.state === 'local_only' || item.recall.state === 'requested') {
    cautions.push('本地已停用，MSE 撤回未完成：在收到精确方法 id/版本回执前，不声称全局已停止。');
  }
  if (item.recall.state === 'mismatched') {
    cautions.push(`本地已停用，但远端回执不匹配，远端撤回**未完成**：${item.recall.detail}`);
  }
  if (item.recall.state === 'confirmed') {
    cautions.push(`远端起效：${item.recall.detail}`);
  }
  cautions.push('撤回联动验收前，只做候选交换与状态展示，不启用生产自动召回。');
  return { headline: item.delivery.detail, local, remote, cautions };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

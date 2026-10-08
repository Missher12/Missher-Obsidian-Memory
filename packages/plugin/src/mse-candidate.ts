/**
 * 把一条记忆导出成 MSE 方法候选包（`mse-method-v1`）。
 *
 * 这个文件的职责范围**故意很窄**：
 *
 * - 只**本地生成 + 本地校验 + 本地写文件**；
 * - 绝不与任何 MSE 实例通信，不发网络请求，不写 MSE 的学习库；
 * - 不因为「导出了候选」就改变这条记忆的状态。
 *
 * 为什么要单独一个文件：CLI 的 `mse-candidate` 和插件里的同一个动作
 * 必须是**同一份**逻辑。两边各写一遍，迟早会出现「CLI 生成的包插件不认」。
 */

import {
  MSE_SCHEMA,
  packetBody,
  packetChecksum,
  titleOf,
  validatePacket,
  type MemoryRecord,
} from '@mom/core';

export interface MethodCandidateDraft {
  /** 完整候选包（待写出）。 */
  packet: Record<string, unknown>;
  /** 本地校验结果；false 时**不要**写出文件。 */
  validation: { ok: boolean; reasons: string[] };
  /** 写出时用的建议文件名（不含目录）。 */
  suggestedName: string;
  /** 给人看的说明：这次只做了什么、没做什么。 */
  note: string;
}

export interface MethodCandidateInput {
  record: MemoryRecord;
  /** 方法指令：遇到这类问题应该怎么做。留空则给一条保守的默认值。 */
  instruction?: string;
  problemKind?: string;
  applicability?: string;
  exclusions?: string;
  now: number;
}

/** 让候选包里的摘要长度可控，避免把整篇正文复制进包里。 */
const EXCERPT_LIMIT = 400;

function excerptOf(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length <= EXCERPT_LIMIT ? text : `${text.slice(0, EXCERPT_LIMIT)}…`;
}

/**
 * 构造候选包。**不碰文件系统**——写文件是调用方的事，
 * 这样测试可以在不建 Vault 的情况下验证包的内容与校验结果。
 */
export function buildMethodCandidateDraft(input: MethodCandidateInput): MethodCandidateDraft {
  const { record } = input;
  const body = excerptOf(record.body);
  const instruction =
    input.instruction?.trim() !== '' && input.instruction !== undefined
      ? input.instruction.trim()
      : `在遇到「${titleOf(record) ?? record.meta.id}」这类问题时，先核对来源版本再修改。`;

  /**
   * 用核心的 `packetBody` / `packetChecksum` 构造，**不自己拼字段**：
   * `checksum` 是对包体做 JSON 序列化后的 sha256，字段顺序变了校验就不过。
   * 自己拼一份字段顺序，迟早会和核心的校验算法错开。
   */
  const bodyShape = packetBody({
    schema: MSE_SCHEMA,
    methodId: null,
    instruction,
    applicability: input.applicability ?? '',
    exclusions: input.exclusions ?? '',
  });

  const packet = { ...bodyShape, checksum: packetChecksum(bodyShape) };

  const validation = validatePacket(packet);
  const safeId = record.meta.id.replace(/[^a-zA-Z0-9_-]/g, '');
  return {
    packet,
    validation,
    suggestedName: `mse-method-candidate-${safeId}-r${record.meta.revision}.json`,
    note: [
      `来源记忆：${record.meta.id}（rev ${record.meta.revision}，scope ${record.meta.scope}）`,
      `正文摘要（前 ${Math.min(body.length, EXCERPT_LIMIT)} 字）：${body}`,
      '本次只做本地生成与本地校验：没有连接任何 MSE 实例，没有发送，也没有改动这条记忆。',
    ].join('\n'),
  };
}

/** 供 CLI 与插件共用：一份可直接写盘的 JSON（含校验结果与提示）。 */
export function renderMethodCandidateFile(draft: MethodCandidateDraft): string {
  return `${JSON.stringify(
    {
      generatedBy: 'missher-obsidian-memory',
      schema: 'mse-method-candidate-export-v1',
      validation: draft.validation,
      note: draft.note,
      packet: draft.packet,
    },
    null,
    2,
  )}\n`;
}

/**
 * 待审补丁：AI 或外部工具对**已确认事实**的修改建议。
 *
 * ## 为什么必须有这一层
 *
 * 核心有一条不可动摇的边界：AI / 维护身份不能改写已确认事实
 * （`update` 用 `actor:'ai'` 会被直接拒绝，`propose` 只能新建候选）。
 * 这条边界是对的，但如果只有「拒绝」，用户在界面上就什么也做不了：
 * 既看不到 AI 到底想改什么，也没有可执行的动作。
 *
 * 待审补丁把「拒绝」变成「可审」：
 *
 * - 提议阶段**不改动任何记忆文件**，只写 `.memory/patches.json`；
 * - 补丁里保存**提议时捕获的**目标哈希与 revision；
 * - 用户在界面上对照当前内容与新内容后，用**用户权限**接受或忽略；
 * - 接受时带的是捕获的哈希：目标已经被人工改过就报冲突并保留新正文，
 *   由用户重新审核——**不会偷偷刷新成最新哈希然后覆盖**。
 *
 * 补丁文件本身在 `.memory/` 下（插件状态，不是记忆正文），因此不参与召回。
 */

import { sha256Hex } from './hash.js';
import { normalizePath } from './paths.js';
import type { MemoryRecord } from './types.js';

/** 带进补丁的字段（与 `UpdatePatch` 的子集对应，避免循环依赖）。 */
export interface PatchFields {
  body?: string;
  title?: string;
  tags?: string[];
  scope?: string;
  scopeRef?: string;
  validUntil?: string;
  reviewAfter?: string;
}

export type PatchStatus = 'pending' | 'accepted' | 'ignored' | 'conflict';

export interface PendingPatch {
  id: string;
  target: string;
  createdAt: string;
  /** 提议者标签：`ai` / `cli` / `mcp` / 具体工具名。仅用于展示与审计。 */
  author: string;
  reason: string;
  /** 提议时捕获的目标正文哈希。接受时用它作为前置条件。 */
  capturedHash: string;
  capturedRevision: number;
  /** 提议时的那一版正文（用于对照展示，不参与判定）。 */
  capturedExcerpt: string;
  fields: PatchFields;
  status: PatchStatus;
  /** 处理时刻与结果说明。 */
  handledAt?: string;
  handledBy?: string;
  note?: string;
}

export interface PatchFile {
  version: number;
  updated_at: string;
  items: PendingPatch[];
}

export const PATCH_FILE = 'patches.json';
export const PATCH_VERSION = 1;

export function emptyPatchFile(now: number): PatchFile {
  return { version: PATCH_VERSION, updated_at: new Date(now).toISOString(), items: [] };
}

/**
 * 解析补丁文件。
 *
 * 与删除账本同样的 fail-closed 原则：读不懂就返回错误，**不覆盖**原文件。
 * 把坏文件当成「没有补丁」会让用户已经审核过的决定静默消失。
 */
export function parsePatchFile(raw: string | null): { file: PatchFile; error: string | null } {
  if (raw === null || raw.trim() === '') return { file: emptyPatchFile(Date.now()), error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      file: emptyPatchFile(Date.now()),
      error: `补丁文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { file: emptyPatchFile(Date.now()), error: '补丁文件顶层不是对象。' };
  }
  const value = parsed as Partial<PatchFile>;
  if (!Array.isArray(value.items)) {
    return { file: emptyPatchFile(Date.now()), error: '补丁文件缺少 items 数组。' };
  }
  const items: PendingPatch[] = [];
  for (const item of value.items) {
    const patch = parsePatch(item);
    if (patch === null) {
      return { file: emptyPatchFile(Date.now()), error: '补丁文件里有无法解析的条目。' };
    }
    items.push(patch);
  }
  return {
    file: {
      version: typeof value.version === 'number' ? value.version : PATCH_VERSION,
      updated_at: typeof value.updated_at === 'string' ? value.updated_at : new Date(Date.now()).toISOString(),
      items,
    },
    error: null,
  };
}

function parsePatch(value: unknown): PendingPatch | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const fields = raw.fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const status = raw.status;
  if (status !== 'pending' && status !== 'accepted' && status !== 'ignored' && status !== 'conflict') return null;
  if (typeof raw.id !== 'string' || typeof raw.target !== 'string') return null;
  const out: PendingPatch = {
    id: raw.id,
    target: normalizePath(raw.target),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    author: typeof raw.author === 'string' ? raw.author : '',
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    capturedHash: typeof raw.capturedHash === 'string' ? raw.capturedHash : '',
    capturedRevision: typeof raw.capturedRevision === 'number' ? raw.capturedRevision : 0,
    capturedExcerpt: typeof raw.capturedExcerpt === 'string' ? raw.capturedExcerpt : '',
    fields: fields as PatchFields,
    status,
  };
  if (typeof raw.handledAt === 'string') out.handledAt = raw.handledAt;
  if (typeof raw.handledBy === 'string') out.handledBy = raw.handledBy;
  if (typeof raw.note === 'string') out.note = raw.note;
  return out;
}

export function serializePatchFile(file: PatchFile, now: number): string {
  return `${JSON.stringify({ ...file, updated_at: new Date(now).toISOString() }, null, 2)}\n`;
}

/** 补丁 id：由目标与提议内容派生，同一份提议重复提交不会产生一堆重复条目。 */
export function patchId(target: string, fields: PatchFields, author: string): string {
  const canonical = JSON.stringify({
    target: normalizePath(target),
    author,
    fields: Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
  return `ptc_${sha256Hex(canonical).slice(0, 16)}`;
}

/** 由记忆记录与目标字段构造一条补丁。 */
export function buildPatch(input: {
  record: MemoryRecord;
  hash: string;
  fields: PatchFields;
  author: string;
  reason: string;
  now: number;
}): PendingPatch {
  return {
    id: patchId(input.record.path, input.fields, input.author),
    target: normalizePath(input.record.path),
    createdAt: new Date(input.now).toISOString(),
    author: input.author,
    reason: input.reason,
    capturedHash: input.hash,
    capturedRevision: input.record.meta.revision,
    capturedExcerpt: input.record.body.slice(0, 400),
    fields: input.fields,
    status: 'pending',
  };
}

/** 补丁里非空的修改字段（用于界面显示与「有没有实际改动」判断）。 */
export function patchFieldSummary(patch: PendingPatch): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  const push = (field: string, value: unknown): void => {
    if (typeof value === 'string' && value !== '') out.push({ field, value });
  };
  push('body', patch.fields.body);
  push('title', patch.fields.title);
  push('scope', patch.fields.scope);
  push('scopeRef', patch.fields.scopeRef);
  push('validUntil', patch.fields.validUntil);
  push('reviewAfter', patch.fields.reviewAfter);
  if (Array.isArray(patch.fields.tags)) out.push({ field: 'tags', value: patch.fields.tags.join('、') });
  return out;
}

/** 该补丁是否真的有可应用的改动。 */
export function patchHasChanges(patch: PendingPatch): boolean {
  return patchFieldSummary(patch).length > 0;
}

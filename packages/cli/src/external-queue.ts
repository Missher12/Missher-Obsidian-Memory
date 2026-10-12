/**
 * 外部队列客户端（CLI 与 MCP 共用）。
 *
 * ## 为什么外部入口不能直接写 Markdown
 *
 * 本产品的普通 Markdown 写入者只有一个：Obsidian 插件。它在 `Vault.process`
 * 的同步回调里做比较-写入，人工编辑与插件写入之间不存在竞态窗口。
 * 外部进程没有这个 API，用「备份 / 改名 / 还原」去模拟跨软件原子比较
 * 是**做不到**的——那只是把竞态窗口藏起来。
 *
 * 所以外部入口的写操作一律走这里：把请求**持久排队**到
 * `<记忆根>/.memory/requests/`，由插件在下次处理时真正提交，
 * 并把结果写成 `.memory/receipts/` 里的回执。
 *
 * ## 诚实点
 *
 * - `accepted`（已持久排队）**不等于** `completed`（已提交）。
 * - 插件没开的时候，外部仍然可以排队与读取，只是不会有新回执。
 * - 等待超时不代表失败：请求还在队列里，下次打开 Obsidian 依然会被处理。
 * - 排队请求里**不包含密钥**：密钥只在本次进程内使用（MCP/CLI 的 AI 功能）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  QUEUE_PROTOCOL_VERSION,
  DEFAULT_REQUEST_TTL_MS,
  assertRequestId,
  assertVaultRelativePath,
  isRequestExpired,
  makeRequestId,
  normalizeOrganization,
  parseReceipt,
  parseRequestEnvelope,
  receiptDirPath,
  receiptPath,
  requestDirPath,
  requestFingerprint,
  requestPath,
  serializeRequest,
  validateRequest,
  type QueueReceipt,
  type QueueRequest,
  type QueueValidationOptions,
  type OrganizationSettings,
  type ReceiptStatus,
  type WriteOperation,
} from '@mom/core';
import { NodeFileStore } from './node-store.js';

export interface EnqueueInput {
  operation: WriteOperation;
  payload: Record<string, unknown>;
  target?: string;
  expectedHash?: string | null;
  expectedRevision?: number | null;
  requester: string;
  idempotencyKey: string;
  now?: number;
  random?: () => number;
  ttlMs?: number;
  /** 显式指定请求 id（幂等重试）；默认按时间与随机数生成。 */
  id?: string;
}

export interface EnqueueOutcome {
  accepted: boolean;
  requestId: string;
  /** Vault 相对路径（含记忆根）。 */
  path: string;
  fingerprint: string;
  /** 已经有同样指纹的请求在排队：本次没有重复落盘。 */
  duplicate: boolean;
  error?: string;
}

export class ExternalQueueClient {
  private readonly vaultRoot: string;
  private readonly memoryRoot: string;
  private readonly organization: OrganizationSettings;
  private nodeStore: Promise<NodeFileStore> | null = null;

  constructor(options: { vaultRoot: string; memoryRoot: string; organization?: OrganizationSettings }) {
    this.vaultRoot = options.vaultRoot;
    this.memoryRoot = options.memoryRoot;
    this.organization = normalizeOrganization(options.organization);
  }

  private get validationOptions(): QueueValidationOptions {
    return { root: this.memoryRoot, organization: this.organization };
  }

  /** 分类目录不改变状态目录；队列每次 IO 前仍做原根的 realpath 边界检查。 */
  private async statePath(relative: string): Promise<string> {
    this.nodeStore ??= NodeFileStore.open({ vaultRoot: this.vaultRoot, memoryRoot: this.memoryRoot, organization: this.organization });
    return (await this.nodeStore).resolveStatePath(relative);
  }

  /**
   * 落一条请求。返回 `accepted: true` 只表示**已经持久排队**。
   *
   * 同一 `idempotencyKey` + 同一内容重复提交时不会重复落盘（外部重试安全）；
   * 同一 id 不同内容会被拒绝，绝不覆盖别人已经排好的请求。
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueOutcome> {
    const now = input.now ?? Date.now();
    const random = input.random ?? Math.random;
    const requestId = input.id !== undefined && input.id !== '' ? assertRequestId(input.id) : makeRequestId(now, random);
    const request: QueueRequest = {
      protocol: QUEUE_PROTOCOL_VERSION,
      id: requestId,
      operation: input.operation,
      target: input.target ?? '',
      expectedHash: input.expectedHash ?? null,
      expectedRevision: input.expectedRevision ?? null,
      payload: input.payload,
      requester: input.requester,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? DEFAULT_REQUEST_TTL_MS)).toISOString(),
    };

    const validation = validateRequest(request, this.validationOptions);
    if (!validation.ok) {
      return {
        accepted: false,
        requestId,
        path: '',
        fingerprint: '',
        duplicate: false,
        error: validation.errors.join('；'),
      };
    }
    const fingerprint = requestFingerprint(request);
    const relative = requestPath(this.memoryRoot, requestId);
    assertVaultRelativePath(this.memoryRoot, relative, '请求路径');
    const absolute = await this.statePath(relative);

    await fs.mkdir(path.dirname(absolute), { recursive: true });

    // 同 id 已经存在：内容一致算重复提交，内容不同一律拒绝。
    const existingSameId = await readIfExists(absolute);
    if (existingSameId !== null) {
      const existing = readEnvelopeFingerprint(existingSameId, this.validationOptions);
      if (existing !== null && existing.fingerprint === fingerprint) {
        return { accepted: true, requestId, path: relative, fingerprint, duplicate: true };
      }
      return {
        accepted: false,
        requestId,
        path: relative,
        fingerprint,
        duplicate: false,
        error: `请求 ${requestId} 已经存在且内容不同；不覆盖，请换一个 id 或先处理已有请求。`,
      };
    }

    // 同幂等键 + 同指纹的请求已经在排队：不重复落盘。
    const sameKey = await this.findByFingerprint(fingerprint);
    if (sameKey !== null) {
      return { accepted: true, requestId: sameKey, path: requestPath(this.memoryRoot, sameKey), fingerprint, duplicate: true };
    }

    /**
     * `wx` 保证不会覆盖并发写入者刚落下的同名请求：外部入口可能有多个进程
     * 同时在排队（CLI + MCP + 定时任务），这里必须靠文件系统本身来互斥。
     */
    try {
      await fs.writeFile(absolute, serializeRequest(request), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return {
          accepted: false,
          requestId,
          path: relative,
          fingerprint,
          duplicate: false,
          error: `请求 ${requestId} 刚刚被另一个进程写入；请重试（不会覆盖）。`,
        };
      }
      throw error;
    }
    /**
     * 落盘之后**再确认一次文件真的在那里**。
     *
     * 为什么值得多一次系统调用：「已排队」是给用户看的承诺，
     * 而 `writeFile` 在某些情况下可能看起来成功、实际没落地（目录被同步工具
     * 移走、容器层写穿等）。没有这一步，界面会报一个查无此物的请求 id。
     */
    const verified = await readIfExists(absolute);
    if (verified === null) {
      return {
        accepted: false,
        requestId,
        path: relative,
        fingerprint,
        duplicate: false,
        error: `请求文件写入后未能读回（${relative}）；本次不算已排队，请检查目录权限后重试。`,
      };
    }
    return { accepted: true, requestId, path: relative, fingerprint, duplicate: false };
  }

  /** 按指纹找一条已经在排队的请求（避免重复排队）。 */
  private async findByFingerprint(fingerprint: string): Promise<string | null> {
    const relativeDir = requestDirPath(this.memoryRoot);
    const dir = await this.statePath(relativeDir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const raw = await readIfExists(await this.statePath(`${relativeDir}/${name}`));
      if (raw === null) continue;
      const info = readEnvelopeFingerprint(raw, this.validationOptions);
      if (info !== null && info.fingerprint === fingerprint) return info.id;
    }
    return null;
  }

  /** 读取回执（只读；文件不存在返回 null）。 */
  async readReceipt(requestId: string): Promise<QueueReceipt | null> {
    const absolute = await this.statePath(receiptPath(this.memoryRoot, requestId));
    const raw = await readIfExists(absolute);
    if (raw === null) return null;
    const parsed = parseReceipt(raw, this.validationOptions);
    return parsed.receipt;
  }

  /** 列出最近的回执（按文件名倒序，最多 limit 条）。 */
  async listReceipts(limit = 20): Promise<QueueReceipt[]> {
    const relativeDir = receiptDirPath(this.memoryRoot);
    const dir = await this.statePath(relativeDir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: QueueReceipt[] = [];
    for (const name of names.sort().reverse().slice(0, limit)) {
      if (!name.endsWith('.md')) continue;
      const raw = await readIfExists(await this.statePath(`${relativeDir}/${name}`));
      if (raw === null) continue;
      const parsed = parseReceipt(raw, this.validationOptions);
      if (parsed.receipt !== null) out.push(parsed.receipt);
    }
    return out;
  }

  /** 队列里还没处理的请求数（含已过期但仍保留的）。 */
  async pendingCount(): Promise<{ pending: number; expired: number }> {
    const relativeDir = requestDirPath(this.memoryRoot);
    const dir = await this.statePath(relativeDir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return { pending: 0, expired: 0 };
    }
    let pending = 0;
    let expired = 0;
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const raw = await readIfExists(await this.statePath(`${relativeDir}/${name}`));
      if (raw === null) continue;
      const info = readEnvelopeFingerprint(raw, this.validationOptions);
      if (info === null) continue;
      pending += 1;
      if (isRequestExpired({ expiresAt: info.expiresAt }, now)) expired += 1;
    }
    return { pending, expired };
  }

  /**
   * 等回执。
   *
   * 超时**不代表失败**：返回 `null` 时请求仍然在队列里，
   * 下次插件打开时会被处理；调用方必须如实这么告诉用户。
   */
  async waitForReceipt(
    requestId: string,
    options: { timeoutMs: number; pollMs?: number; signal?: { aborted: boolean } } = { timeoutMs: 30_000 },
  ): Promise<QueueReceipt | null> {
    const pollMs = Math.max(100, options.pollMs ?? 500);
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      if (options.signal?.aborted === true) return null;
      const receipt = await this.readReceipt(requestId);
      if (receipt !== null) return receipt;
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
}

/**
 * 从请求信封里读出 id、指纹与过期时间。
 *
 * 复用核心的 `parseRequestEnvelope`（插件处理请求时用的是同一个解析器），
 * 因此外部看到的「这条请求是什么」和插件执行的是同一个理解。
 */
function readEnvelopeFingerprint(raw: string, options: QueueValidationOptions): {
  id: string;
  fingerprint: string;
  expiresAt: string;
} | null {
  const parsed = parseRequestEnvelope(raw, options);
  if (parsed.request === null) return null;
  return {
    id: parsed.request.id,
    fingerprint: requestFingerprint(parsed.request),
    expiresAt: parsed.request.expiresAt,
  };
}

async function readIfExists(absolute: string): Promise<string | null> {
  try {
    return await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 回执状态的中文标签（CLI/MCP 输出共用）。 */
export const RECEIPT_LABELS: Record<ReceiptStatus, string> = {
  completed: '已提交',
  conflict: '冲突（未提交，正文未改动）',
  failed: '失败（未提交）',
  expired: '已过期（未提交，请求保留）',
};

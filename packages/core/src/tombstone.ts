/**
 * 遗忘与删除标记。
 *
 * 两种“忘掉”是不同操作，必须分开：
 * 1. **停止使用**（`forget`）：记忆退出当前召回，历史保留，可被人工回看与恢复。
 * 2. **删除内容**（`delete`）：文件连同派生缓存一起删除，只留下**不含正文**的最小
 *    标记，防止旧同步副本或重复来源把它复活。
 *
 * 标记里刻意不保存原内容，只保存内容哈希与去重指纹。这样即使标记文件泄露，
 * 也不能还原被删掉的记忆正文。
 */

import { sha256Hex } from './hash.js';
import type { Tombstone } from './types.js';

export const TOMBSTONE_FILE = 'tombstones.json';
export const TOMBSTONE_VERSION = 1;

export interface TombstoneFile {
  version: number;
  updated_at: string;
  items: Tombstone[];
}

export function emptyTombstoneFile(now: number): TombstoneFile {
  return { version: TOMBSTONE_VERSION, updated_at: new Date(now).toISOString(), items: [] };
}

/** 解析标记文件；损坏时返回空集并报告，绝不静默丢数据也绝不抛异常。 */
export function parseTombstones(raw: string | null): { file: TombstoneFile; error: string | null } {
  if (raw === null || raw.trim() === '') return { file: emptyTombstoneFile(Date.now()), error: null };
  try {
    const parsed = JSON.parse(raw) as Partial<TombstoneFile>;
    const items: Tombstone[] = [];
    for (const item of parsed.items ?? []) {
      if (!item || typeof item.id !== 'string' || item.id === '') continue;
      items.push({
        id: item.id,
        path: typeof item.path === 'string' ? item.path : '',
        deleted_at: typeof item.deleted_at === 'string' ? item.deleted_at : '',
        revision: typeof item.revision === 'number' ? item.revision : 0,
        content_hash: typeof item.content_hash === 'string' ? item.content_hash : '',
        dedupe_key: typeof item.dedupe_key === 'string' ? item.dedupe_key : '',
        reason: item.reason === 'superseded_cleanup' || item.reason === 'user_delete_file' ? item.reason : 'user_forget',
      });
    }
    return {
      file: {
        version: typeof parsed.version === 'number' ? parsed.version : TOMBSTONE_VERSION,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
        items,
      },
      error: null,
    };
  } catch (error) {
    return {
      file: emptyTombstoneFile(Date.now()),
      error: `删除标记文件损坏，已按空集处理（原文件不会被自动覆盖）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 序列化删除标记。
 *
 * **刻意不写入 `path`**：记忆文件名里带有用户标题（slug），把路径写进标记文件
 * 等于把被删除的正文标题一起留了下来。标记只需要“认得出旧副本”，
 * 因此保留 `id`、内容哈希与去重指纹就足够，且这些都不含原文。
 */
export function serializeTombstones(file: TombstoneFile, now: number): string {
  const items = file.items.map(item => ({
    id: item.id,
    deleted_at: item.deleted_at,
    revision: item.revision,
    content_hash: item.content_hash,
    dedupe_key: item.dedupe_key,
    reason: item.reason,
  }));
  return `${JSON.stringify(
    { version: TOMBSTONE_VERSION, updated_at: new Date(now).toISOString(), items },
    null,
    2,
  )}\n`;
}

/** 标记集合：查询与判定。 */
export class TombstoneSet {
  private readonly byId = new Map<string, Tombstone>();
  private readonly byDedupe = new Map<string, Tombstone>();
  private readonly byContentHash = new Map<string, Tombstone>();

  constructor(items: readonly Tombstone[] = []) {
    for (const item of items) this.add(item);
  }

  static from(file: TombstoneFile): TombstoneSet {
    return new TombstoneSet(file.items);
  }

  add(item: Tombstone): void {
    this.byId.set(item.id, item);
    if (item.dedupe_key) this.byDedupe.set(item.dedupe_key, item);
    if (item.content_hash) this.byContentHash.set(item.content_hash, item);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Tombstone | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  all(): Tombstone[] {
    return [...this.byId.values()];
  }

  /**
   * 判断一条**新**记录是否应当被拒绝写入，因为它是已被删除来源的复活。
   *
   * 只按去重指纹与内容哈希判断，不按标题，避免“同名不同实体”被误杀。
   */
  isResurrection(candidate: { id?: string; dedupeKey: string; contentHash: string }): Tombstone | null {
    if (candidate.id && this.byId.has(candidate.id)) return this.byId.get(candidate.id) ?? null;
    if (candidate.dedupeKey && this.byDedupe.has(candidate.dedupeKey)) {
      return this.byDedupe.get(candidate.dedupeKey) ?? null;
    }
    if (candidate.contentHash && this.byContentHash.has(candidate.contentHash)) {
      return this.byContentHash.get(candidate.contentHash) ?? null;
    }
    return null;
  }
}

/** 生成一条标记（内容不入库，只留哈希）。 */
export function createTombstone(input: {
  id: string;
  path: string;
  revision: number;
  rawContent: string;
  dedupeKey: string;
  reason: Tombstone['reason'];
  now: number;
}): Tombstone {
  return {
    id: input.id,
    path: input.path,
    deleted_at: new Date(input.now).toISOString(),
    revision: input.revision,
    content_hash: sha256Hex(input.rawContent),
    dedupe_key: input.dedupeKey,
    reason: input.reason,
  };
}

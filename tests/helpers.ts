import { MemoryFileStore, type FileStore } from '@mom/core';
import { sha256Hex } from '@mom/core';

/** 确定性时钟：测试不依赖真实时间。 */
export function fixedClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 确定性随机源：id 可复现。 */
export function seededRand(seed = 1): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

export function memoryStore(seed?: Record<string, string>): MemoryFileStore {
  return new MemoryFileStore({ hash: sha256Hex, seed });
}

/** 固定的测试时间基点（避免使用本机当前时间）。 */
export const T0 = Date.parse('2026-10-09T00:00:00.000Z');

export function iso(offsetMs = 0): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** 包装存储，注入“读取/写入之间被人手改文件”的竞态。 */
export function withManualEditRace(
  store: FileStore,
  hook: { path: string; content: string; trigger: 'beforeWrite' },
): FileStore {
  let fired = false;
  return {
    kind: `${store.kind}+race`,
    listFiles: (...args) => store.listFiles(...args),
    readFile: (...args) => store.readFile(...args),
    exists: path => store.exists(path),
    ensureDir: path => store.ensureDir(path),
    revision: () => store.revision(),
    removeFile: path => store.removeFile(path),
    async writeFile(path, content, expect) {
      // 在所有异步准备都完成之后、真正写入之前，模拟用户手改。
      if (!fired && path === hook.path) {
        fired = true;
        await store.writeFile(hook.path, hook.content, {});
      }
      return store.writeFile(path, content, expect);
    },
  };
}

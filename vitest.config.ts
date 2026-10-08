import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));
/**
 * 测试用的 `obsidian` 桩：只提供被测插件适配器真正用到的那部分 API。
 * 插件源码在测试里与真实 Obsidian 共享同一份导入路径，
 * 因此不要在测试里改写业务源码来绕开宿主。
 */
const obsidianStub = fileURLToPath(new URL('./tests/obsidian-stub.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mom/core': coreSrc,
      obsidian: obsidianStub,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 产品约束：测试并发最多 1。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: { concurrent: false },
    reporters: ['default'],
    testTimeout: 30_000,
  },
});

/**
 * 端到端验收的打包入口。
 *
 * 只导出 `buildSyntheticVault`：它会在真实文件系统上跑一次**插件真正使用的**
 * 队列处理代码（VaultFileStore + QueueService + 提交处理器）。
 * esbuild 会把插件源码与 `obsidian` 运行时桩一起打成一个自包含模块，
 * 因此这个脚本不需要安装 Obsidian，也不会加载任何界面代码。
 */
export { buildSyntheticVault } from './obsidian-runtime-stub.js';

# Missher Obsidian Memory

默认简体中文。需求 OBS-MEM-20261009：交付独立的 Obsidian 第二大脑与 AI 记忆插件，不依赖 MSE、DSH、OpenViking 或 TencentDB 才能启动和使用。MSE 仅可选方法候选交换，不允许绕过其验证。

本轮实现必须由原生 DeepSeek Harness 会话使用 `deepseek-account / deepseek-flash`（当前 Host 名称 DeepSeek-V41-Flash）与 max 推理完成；Codex 负责规划、独立审查、验收和发布，不替代指定模型编写业务实现。

唯一业务写入者为本项目的原生 DSH 开发会话。修改范围仅此仓库。Codex 协调者拥有 AGENTS.md、docs/TASK.md 与协调目录回执；其他源码、测试和产品文档由原生会话单写。先读 docs/TASK.md。保持 HANDOVER.md / PROJECT_CONTEXT.md 简短且准确，在阶段边界更新。

不得修改其他仓库、DSH 日常 profile、模型默认值、个人 Obsidian Vault、MSE 学习数据、既有应用或全局插件。测试用当前工作区内 `.experiment/` 下新建的唯一独立合成 Vault（该目录已被 Git 忽略）；不能把源码仓库根目录当作 Vault，也不要申请工作区外写权限；不得读取真实个人笔记或搬运凭据。不能把开发日志、凭据、机器绝对路径和真实会话导出加入公开包。

成品要求：源码、必要测试、可安装 Obsidian 插件 main.js/manifest.json/styles.css 与 ZIP、可用独立核心和 AI 接入方式、中文使用说明、示例 Vault、校验文件、清楚的未验证层。不能仅交脚手架或把核心功能变成文档占位。

TypeScript 优先；沿用 Obsidian 官方 API。纯核心不依赖 Obsidian、Node、MSE；Node 仅允许出现在明确分离的外部 CLI/MCP 适配器。插件使用 Vault API，不用任意 fs 读取用户库。先异步生成修正，再在 Vault.process 同步回调内比较当前原文，旧任务不覆盖人工编辑。没有真实网络取消能力时，如实区分停止提交和停止网络请求。

测试与构建并发最多 1。使用临时目录和合成样例，不操作日常数据。审查发现缺口持续修复到完整候选；无须询问常规步骤。Git 提交、仓库创建与推送由 Codex 协调者统一处理；原生会话准备变更但不推送。

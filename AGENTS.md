# Missher Obsidian Memory

## 2026-10-13 当前发布与分工

用户已明确授权本产品源码及产物公开，采用正式 Release；只有 Media 保持独立私有。个人 Vault、笔记、凭据及学习数据不公开。后续维护尽量按实际能力和合理版本范围兼容，不默认锁定精确最新版。全项目当前开发统一由 DSH 原生 `deepseek-official / deepseek-flash / max` 执行，Codex 负责协调、审查和独立验收；本批 Git 由根协调单写。下文 2026-10-09 的 Codex 实现与私有交付约定记录历史，不覆盖本条。

默认简体中文。需求 OBS-MEM-20261009：交付独立的 Obsidian 第二大脑与 AI 记忆插件，不依赖 MSE、DSH、OpenViking 或 TencentDB 才能启动和使用。MSE 仅可选方法候选交换，不允许绕过其验证。

2026-10-09 用户更新分工：Codex 接续会话为唯一业务实现、修复、验收和 Git 交付者，沿用用户为该会话设置的模型与推理配置。此安排替代原生 DSH Flash/max 执行限制；原生会话已取消并确认停止，保留历史，不再派发。

唯一业务写入者为接续 Codex 会话。修改范围仅此仓库。Codex 协调者拥有 AGENTS.md、docs/TASK.md 与协调目录回执；源码、测试和产品文档也由该 Codex 会话单写。先读 docs/TASK.md。保持 HANDOVER.md / PROJECT_CONTEXT.md 简短且准确，在阶段边界更新。

不得修改其他仓库、DSH 日常 profile、模型默认值、个人 Obsidian Vault、MSE 学习数据、既有应用或全局插件。测试用当前工作区内 `.experiment/` 下新建的唯一独立合成 Vault（该目录已被 Git 忽略）；不能把源码仓库根目录当作 Vault，也不要申请工作区外写权限；不得读取真实个人笔记或搬运凭据。不能把开发日志、凭据、机器绝对路径和真实会话导出加入公开包。

成品要求：源码、必要测试、可安装 Obsidian 插件 main.js/manifest.json/styles.css 与 ZIP、可用独立核心和 AI 接入方式、中文使用说明、示例 Vault、校验文件、清楚的未验证层。不能仅交脚手架或把核心功能变成文档占位。

TypeScript 优先；沿用 Obsidian 官方 API。纯核心不依赖 Obsidian、Node、MSE；Node 仅允许出现在明确分离的外部 CLI/MCP 适配器。插件使用 Vault API，不用任意 fs 读取用户库。先异步生成修正，再在 Vault.process 同步回调内比较当前原文，旧任务不覆盖人工编辑。没有真实网络取消能力时，如实区分停止提交和停止网络请求。

测试与构建并发最多 1。使用临时目录和合成样例，不操作日常数据。审查发现缺口持续修复到完整候选；无须询问常规步骤。Git 提交与推送由接续 Codex 统一处理，仓库保持私有；不再向原生会话派发任务。

真实运行验收的用户授权目标为已登记的新 Obsidian-DSH 库；精确 ID/path 由协调目录 guarded-obsidian-cli.mjs 每次校验。只操作指定合成测试根与本插件设置，不读取个人笔记。验收后保留证据并切回 Second Brain 根、本地自动复盘默认，AI/MSE 未配置保持关闭。

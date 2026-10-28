# 0.2.0 中文分类交付

日期：2026-10-12。独立 Obsidian Memory 继续保留私有仓库，不依赖 DSH 或 MSE。

## 最终行为

- 新增与现有笔记库一致的 14 类中文目录；支持根内布局、Vault 同级布局和自定义映射。
- 快速记住与 CLI/MCP 可选分类和短标题，重名追加序号，旧版默认路径兼容。
- 普通笔记、导航与模板不会因扫描而自动变成记忆；托管模板退出事实检索、画像和模型作业。
- 分类不提升确认状态或权限，AI 提议保持 pending；现有 CAS 冲突保护与唯一提交者约定保持。
- 配置预览后保存并重载，取消不保存；拒绝会使同一批笔记脱离原状态账本的换根。
- MSE 状态按明确版本刷新，不拼接旧版本的验证信用。联动协议另见 [MSE 互动方向](MSE-INTERACTION.md)。

## 使用与规划

[分类说明](CLASSIFICATION.md)包含目录职责、命名规范、配置步骤和 CLI/MCP 示例。[合成示例库](../examples/missher-vault/README.md)包含 14 类目录、主页、教训模板和配置示例。

本版落实新建记录的分类与现有目录绑定。旧笔记迁移、自动维护导航页、跨系统自动召回属于后续独立阶段，不能据本版安装而推断已完成。

## 验证

`node scripts/package.mjs`：8/8 打包检查通过；`node scripts/verify.mjs`：19/19 自检通过。

- 类型检查：核心、插件、CLI/MCP 均通过。
- 单元与集成：18 个文件、327 项通过，包含新旧布局、普通笔记保护、同名/CAS、模板隔离、队列回执、换根保护及 MSE 版本快照。
- 旧版 CLI 闭环 34 项、MCP 闭环 88 项通过；新增中文分类闭环 41 项通过。
- 外部闭环运行真实 CLI/MCP bundle 与真实插件提交代码，使用磁盘上的合成库及 RuntimeVault API 替身，**不是原生 Obsidian 验收**。合成库和 harness 限于本仓库 `.experiment` 下唯一目录。
- 插件无 Node 内置依赖、纯核心不依赖 Obsidian/Node；独立 CLI 解包后可运行，5 个交付文件摘要匹配。

插件 ZIP SHA-256：`5ab67d3a7dfa8b5dd94e8cc7919451115fc6cc623bc3d96b768b6c1e67e1e1c2`。
独立 CLI tgz SHA-256：`60723892c70c7f68ce47861f82cb31e3260724fe029d9bbd845e05181410614a`。

真实原生验收尝试：本机 `/usr/bin/obsidian help` 返回命令行未启用，要求在 Settings → General → Advanced 开启。当前会话也没有可用的原生输入控制，因此本轮没有替换日常插件、改动个人笔记库或借旧版原生证据宣称新版已验收。当前安装包可用于手动安装，真实 Obsidian 设置界面、真实模型与 MSE 网络投递仍未验证。

MSE 维护任务独立完成 12 项实际核心的合成契约断言；这些是互动方向的依据，不替代本包的原生或线上验收。

## 包与回滚

产物：`dist/missher-obsidian-memory-0.2.0.zip`、`dist/mom-memory-cli-0.2.0.tgz`、插件三件套及 `dist/SHA256SUMS.txt`。源码可通过 `pnpm install --frozen-lockfile`、`pnpm package`、`pnpm verify` 串行重建和验证。

升级前备份插件设置、托管 Markdown 和原根 `.memory`。旧版不能完整理解同级分类目录；回退应恢复成对的插件/设置，保留新建笔记，不用旧状态覆盖新操作。本轮没有自动迁移或需要回滚的个人库修改。

## Git 交付状态

实现提交 `a7749eb02e0cc298619286c611c861d4fe28ef3e` 已保存在本地 main。向原私有仓库 main 推送返回 HTTP 403（Write access to repository not granted）；SSH 回退返回 Permission denied (publickey)，已连接 GitHub 的仓库查询返回 404。远端仍为 `7189a2224134e44650d9e8fb4f64f1d7d74333ec`，不能称已推送或已发布 0.2.0 Release。

需要恢复本机对原仓库的写权限后执行 `git push origin main`，再核对远端与 HEAD。代码、测试、包和文档均已完成；本地另有 `dist/missher-obsidian-memory-0.2.0-source.bundle` 保存 Git 历史，便于转移到有写权限的电脑。

> **2026-10-12 当前接续：0.2.0 中文分类。** 本轮实现由当前 Obsidian 任务完成，源码从原私有 Git 0.1.1 基线恢复；按用户 GO 授权实现 14 类目录、CLI/MCP 路径绑定和短标题，保持独立使用并与 MSE 任务完成互动协议讨论。当前结果以 [0.2.0 交付记录](docs/DELIVERY-0.2.0.md) 为准。下文 0.1.x 的路径、安装、原生验收及提交均为历史，不能推断当前 Linux 或新包已安装。未改个人 Vault、MSE 学习库或 DSH 日常。

# HANDOVER —— 交接（成品 0.1.0 候选）

> 2026-10-09 接续更新：用户已将实际实现/修复、验收和私有 Git 交付转交 Codex，旧 DSH 会话停止，不再派发。冻结 0.1.0 三件套在真实 Obsidian 1.14.4 的程序化界面、CLI/MCP 队列、冲突/索引/复盘/遗忘验收通过，详见 [运行验收](docs/LIVE-ACCEPTANCE.md)。当前安装 0.1.1，插件保持启用，日常根恢复 Second Brain、本地自动复盘开启，AI/MSE 关闭。物理键鼠与真实远端模型仍未验收。本轮已修复自动复盘开关与本地预算门控并交付 0.1.1；232 项测试与真实进程定向补验通过，旧 0.1.0 资产保留。下文为原冻结阶段的历史记录，不代表当前 Git 或 GUI 状态。


> 接手请先读本文件，再看 `PROJECT_CONTEXT.md`（阶段上下文）与
> `docs/ARCHITECTURE.md`（设计）。需求原文在 `docs/TASK.md`（协调者所有，勿改）。

## 一句话状态

**代码、测试、文档、样例、样式、CI、打包全部就绪；本机自检 18/18 通过、
协调者 7 个独立脚本全绿（第 8 个 MCP 真机 smoke 等冻结后由协调者跑）；唯一未完成的是「真实 Obsidian GUI 里的原生验收」，
它被系统许可（Screen Recording 未授权）挡住，属明确未验证层。**

Git 提交/推送/Release 由协调者负责。协调者已完成首个提交并推送私有仓库：

```text
仓库   Missher12/Missher-Obsidian-Memory
分支   main
commit 7a6d41a7f08d906ff70730ab5a448e0c49e042f6   feat: release standalone Obsidian memory plugin 0.1.0
```

本会话**没有** `git add`/commit/push。上述提交之后的唯一改动是本文件的
`scripts/package.mjs` 跨平台归档修复（CI 失败项），工作树里未提交，等协调者接管。

## 冻结候选（要核对的就用这一组）

| 项 | 值 |
| --- | --- |
| 版本 | `0.1.0` |
| 分支 | `main`（无 commit） |
| 插件 ZIP | `dist/missher-obsidian-memory-0.1.0.zip` → `dc1463d8aadd86d5fe55f5d76d484cdc083fe3f75499eb903aa3428656a7cba6` |
| 独立 CLI | `dist/mom-memory-cli-0.1.0.tgz` → `25403c772d591639e5fe2c7b972c5feedd8552a0428761d72bcb311e52f3a169`（**本机 BSD tar 分支**；Linux GNU tar 分支哈希不同，见下） |
| 插件 main.js | `dist/missher-obsidian-memory/main.js` → `61f71cc8eff1aeeddc0f5d5c469f9a520cbd37fee67c803363531756d139966a` |
| 插件 manifest | `dist/missher-obsidian-memory/manifest.json` → `391cefdab7043b35e7e56a97ca2f2b6a5899ffbf1875e02574c474847e6337b7` |
| 插件 styles.css | `dist/missher-obsidian-memory/styles.css` → `aa140388950a2b1480bb6c0b9f263a42cba63e6e1552ac3adee57d237802a28e` |

校验和汇总在 `dist/SHA256SUMS.txt`（里面是 5 行：插件 ZIP、CLI tgz、
以及插件目录下三个文件；`dist/SHA256SUMS` 是构建阶段生成的同名简表）。

### 打包是可复现的，并且跨平台归档器都能跑

`node scripts/package.mjs` 连跑三次，5 个交付物的 SHA-256 **完全一致**。三件事一起保证：

1. **时间**：打包前把暂存目录里所有条目的 mtime 钉到 `1980-01-01`（`find -exec touch -t`）。
2. **属主**：GNU tar 与 BSD tar 的选项名不同，脚本先探测 `tar --version` 再选——
   GNU 用 `--owner=0 --group=0`，BSD 用 `--uid 0 --gid 0`（外加 `--no-mac-metadata`）。
   写死任何一套都会在另一个平台直接失败：Linux CI 第一次就是
   `tar: unrecognized option '--uid'`。
3. **压缩**：不用 `tar -z`、也不拼 shell 字符串。tar 的 stdout 收成 Buffer 后交给
   Node 标准库 `gzipSync`（不写 gzip 时间戳），`execFileSync` 在 tar 非零退出时抛异常——
   所以 **tar 失败一定是打包失败**，不会留下一个空 tgz 等到解包时才炸。
   （旧版 `/bin/sh -c "tar … | gzip"` 只取管道最后一个进程的状态，正是 CI 那次
   「tar 报错却继续跑，最后报 CLI 文件缺失」的成因。）

**注意**：`zip` 打包需要那三个文件的 mtime 固定，所以别在 `package` 与核对哈希之间再跑 `build`。
**跨平台哈希差异**：同一份输入在 BSD tar 与 GNU tar 下产出的 tgz 哈希**不同**
（归档头里的属主写法不同）。这不影响可复现性——每个平台各自稳定；
但跨平台比对校验和时要用该平台自己产出的那份。

## 复现全部结论的精确命令

按顺序跑（每一步的机器可核对结论在右列）：

```bash
# 1. 安装（严格按锁文件；obsidian 依赖必须是 1.13.1，不要降级）
pnpm install --frozen-lockfile

# 2. 构建 → core / plugin / cli / mcp 四份产物
node scripts/build.mjs

# 3. 打包 → ZIP + tgz + SHA256SUMS（必须先打包再自检，否则校验和那项会报旧值）
node scripts/package.mjs

# 4. 仓库自检 → 18/18 项通过
node scripts/verify.mjs

# 5. 单独看单元与集成测试 → 11 个文件 / 228 项通过
npx vitest run

# 6. 两个端到端闭环（都自带结论行）
node scripts/e2e-cli.mjs     # CLI 端到端：34 项通过，0 项失败
node scripts/e2e-mcp.mjs     # MCP 端到端：88 项通过，0 项失败
```

第 4 步的 18 项里包含：产物边界（插件产物不得出现 `node:` 与 `require("fs")`）、
核心产物不得依赖 obsidian、三份类型检查、228 项测试、两个 e2e、5 个文件的校验和一致。

### 协调者的独立脚本（不在本仓库，勿改）

按协调目录（路径见协调者的 `HANDOVER.md`）逐个 `node <脚本>`：

| 脚本 | 本会话实跑结果 |
| --- | --- |
| `verify-core-independent.cjs` | `{total:13, passed:13, failed:0, sourceStable:true}` |
| `verify-ai-independent.cjs` | `{pass:6, fail:0}`（自报 `SOURCE_CHECKS_ONLY`） |
| `verify-qa-independent.cjs` | `{pass:3, fail:0}`（自报 `CONTRACTS_ONLY`） |
| `verify-vault-independent.cjs` | `{pass:4, fail:0, nativePending:1}` |
| `verify-queue-independent.cjs` | `{total:4, passed:4, failed:0}`（Q01–Q04） |
| `verify-node-independent.cjs` | `{total:4, failed:0, passed:4}`（N04 已按新契约更新） |
| `verify-ui-independent.cjs` | `{pass:9, fail:0, nativePending:true}` |
| `verify-mcp-independent.mjs` | **未跑**：要求 `--bundle <冻结 mcp.js> --sha256 <hex>`，留给协调者在冻结后执行 |

## 本轮（完成阶段）实际改了什么

1. **队列入口补上 `scope` 枚举校验**（`core/queue.ts`）：非法 scope 以前会被持久接受、
   拿到 accepted，再在提交阶段变成一条「写进库但永远检索不到」的记忆。
   现在 `readString(..., { oneOf: SCOPE_KINDS })` 在入队时就拒。
2. **`completed` 回执必须带落地证据的契约被测试钉住**（`tests/queue-closed-loop.test.ts`）：
   四种「自报成功却拿不出证据」的提交者都会被降级为 failed 回执。
   拦截点是 `validateReceipt` 的 completed 分支——**只有这一处**；
   运行器里没有第二份重复检查（避免后来者以为可以放宽其中一处）。
3. **打包可复现**（`scripts/package.mjs`）：见上。
4. **文档**：新增 `LICENSE`、`.github/workflows/verify.yml`、`examples/`（三个真实接入样例
   + 说明）、`README.md` 验收状态一节；`PROJECT_CONTEXT.md` 更新独立脚本表并去掉机器绝对路径。
5. **删除了一条错误的提前表述**：README 里「只在桌面版 Obsidian 1.13.4 上做过验收」
   与事实矛盾，已改为如实描述（见下）。

## 明确未验证（不得当成已通过）

- **真实 Obsidian GUI 原生验收：未完成**。准备做完了（专属合成实验库 + 插件三件套已就位，
  Obsidian 1.13.4 已启动），但读取窗口被系统 TCC 拒绝：
  `Accessibility: granted` / `Screen Recording: NOT granted`，
  `get_window_state` 返回 `protected_resource_scope_invalid`，截图返回「用户拒绝了捕捉」。
  按约定**没有绕过**：没用 shell 截图、没走隐藏 IPC、没手改全局 Vault 登记，
  也没去处理那个权限提示窗。**实验库至今没有被登记**，插件在真实 Obsidian 里未被加载过。
  因此下列全部未验证：`.memory` 在真实索引里的可见性、`adapter.rename` 认领、
  `Vault.process` 在真实人工编辑并发下的行为、Vault 事件是否真的触发刷新、
  真实界面观感与交互。
- **移动端**：首版定位桌面（`isDesktopOnly: true`），从未在移动端运行过。
  移动端 API 与能力差异**没有实测**，因此不推断移动端具体缺什么。
- **真实远端模型端点**：e2e 打的是本地假端点。
- **MSE 端到端**：只做本地生成 + 本地按 `mse-method-v1` 校验，未与真实 MSE 通信。
- **MCP 真机 SDK smoke**：协调者已在冻结后跑通（DSH MCP SDK 2.0.0，从 tgz 解包运行 5/5）。
- **提示注入**：护栏在「哪些内容允许进上下文」这一层，不在「模型说了什么」这一层。
- **多设备并发**：未验证，也未声称。

## 环境事实（免得下一次重新踩）

- 机器上 `ps` 被限制（`Operation not permitted`），排查进程用 `lsappinfo` / `pgrep`。
- macOS 自带 `bsdtar 3.5.3`：**不支持** `--sort` / `--mtime` / `--mode`；`--no-mac-metadata` 只有它有。
  GNU tar 反过来：认 `--owner=`/`--group=`，不认 `--uid`/`--gid`/`--no-mac-metadata`。
- `pnpm@11.1.3` 与锁文件一致；有探针曾回显 `pnpm 12.10.1`，属环境噪声，冻结安装仍按 11.1.3 验证过。
- 测试用的合成库只在 `.experiment/`（已被 `.gitignore` 忽略）下；本会话未读任何真实个人 Vault。
- 本会话启动的 Obsidian 实例（pid 87288 / window_id 12813）加载的是用户既有登录库，
  **只被启动、未被写入、也未被本会话关闭**。实验库从未登记进 `obsidian.json`。

## 给协调者的建议

1. 在 `main` 上做首个 commit；把上面的哈希写进 Release 说明。
2. Release 里明确列出「桌面原生 GUI 验收未完成（系统许可受阻）」这一层——
   代码与包可以按可安装 0.1.0 交付，但不要把未做的验收写成已做。
3. 冻结后跑 `verify-mcp-independent.mjs --bundle <mcp.js> --sha256 <hex>`；
   若要在有屏幕录制许可的会话里补原生验收，按协调目录的 `native-validation-plan.md` 走，
   实验库与回执还在 `.experiment/obs-mem-native-acceptance-20261009-liyj_ksr/`
   （含 `evidence/native-acceptance-status.md`，记录了当时的工具返回原文）。

# PROJECT_CONTEXT —— 续接用阶段上下文

> 2026-10-09 接续更新：用户已将实际实现/修复、验收和私有 Git 交付转交 Codex，旧 DSH 会话停止，不再派发。冻结 0.1.0 三件套在真实 Obsidian 1.14.4 的程序化界面、CLI/MCP 队列、冲突/索引/复盘/遗忘验收通过，详见 [运行验收](docs/LIVE-ACCEPTANCE.md)。当前安装 0.1.1，插件保持启用，日常根恢复 Second Brain、本地自动复盘开启，AI/MSE 关闭。物理键鼠与真实远端模型仍未验收。本轮已修复自动复盘开关与本地预算门控并交付 0.1.1；232 项测试与真实进程定向补验通过，旧 0.1.0 资产保留。下文为原冻结阶段的历史记录，不代表当前 Git 或 GUI 状态。


> 本文件给“下一个接手的人或会话”看。保持简短；详细设计在 `docs/ARCHITECTURE.md`，交接结论在 `HANDOVER.md`。

## 这是什么

Missher Obsidian Memory（需求 OBS-MEM-20261009）：一个**独立**的 Obsidian 第二大脑与 AI 记忆插件。
不依赖 MSE、DSH、OpenViking 或 TencentDB 才能启动和使用。

## 仓库结构

```
packages/core/   ← 纯核心：无 Obsidian、无 node:*、无 MSE。状态机/检索/护栏/作业/桥接都在这
packages/plugin/ ← Obsidian 插件：Vault API + Vault.process 原子提交
packages/cli/    ← 外部 Node 适配器：CLI 与 MCP stdio（唯一允许 node:fs 的地方）
tests/           ← vitest，单并发
scripts/         ← 构建/校验/打包/e2e
docs/            ← TASK.md（需求原文）、ARCHITECTURE.md
```

## 写入架构（协调者 2026-10-09 明确的范围更正，优先于早期设计）

**默认只有一个 Markdown 写入者：Obsidian 插件。**

- 外部入口（CLI / MCP）默认**只排队**：把写请求持久写进
  `<memoryRoot>/.memory/requests/`，由插件用 `Vault.process` 在同步回调里
  比较当前原文并提交，回执写进 `.memory/receipts/`。
- **不接受**用多轮 backup/rename/restore 去模拟“跨软件通用原子 CAS”。
  `read+rename` 不可能覆盖不合作的编辑器；增加交换与恢复只会**扩大**丢数据面。
  这类“魔术”一律不加。
- `NodeFileStore` 需要 `allowDirectWrites: true` 才能写，且只给内部/测试用。
  默认用户入口**结构上**走队列——不是靠注释或 README 提醒。
- 回执必须区分 `accepted`（已持久排队）与 `completed / conflict / failed / expired`；
  accepted **不等于** completed。插件关闭时外部仍可读、可排队，打开后处理。
- 合作锁（CLI/插件之间的租约锁）只保护本产品自己的必要状态与队列协议，
  不再声称它能让 Node 与插件同时直接写 Markdown。

## 不可动摇的约束（改动前先读）

1. **纯核心**不得 `import 'obsidian'`、`node:*` 或 MSE。Node 只能出现在 `packages/cli`。
2. **写入必须比较-交换**：先异步生成修正，再在 `Vault.process` 的**同步**回调里比较当前原文与 revision；不一致就终止。旧任务绝不覆盖人工编辑。直写路径（内部/测试）只承诺「比较不一致就拒写」，**不**承诺能保住核对之后落下的外部编辑。
3. **删除也必须核对磁盘字节**（不只是缓存哈希）。
4. **候选永远是 pending**；AI 不能自我确认，也不能改已确认事实的语义。
5. **忘记要连衍生一起失效**：`derived_from` 的后代在来源被归档/删除/修订变化时退出召回并标记待复核。
6. **幂等身份写在正文里**（frontmatter `event_ids`），不能只靠 `state.json`——那个文件必须可重建。
7. **删除账本损坏要 fail-closed**：看不到删除账本时禁止召回，且要保留错误可见。
8. 调用模型前现场过滤 `scope` / `allow_model` / `status` / 有效期 / `invalid`；迟到结果再次核对代次与来源原文。
9. 没有真实网络取消能力时，如实区分“停止提交”与“停止网络请求”。未知计费请求**不自动重放**。

## 当前状态

见 `HANDOVER.md` 的“已完成 / 未完成 / 未验证”三节，那里是唯一权威。

## 已知的第二轮审查缺陷与修复位置

| 编号 | 问题 | 修复位置 |
| --- | --- | --- |
| S1 | 删除只比对缓存哈希 | `core/storage.ts`（`removeFile` 带期望）、`core/store.ts` |
| S2 | AI 可改已确认正文；propose 可自报 confirmed | `core/store.ts`（`updateLocked`、`propose`） |
| S3 | 来源遗忘/删除后衍生仍召回 | `core/store.ts`（依赖失效） |
| S4 | 正文与事件表分两次提交，重放重复 | `core/record.ts`（`event_ids`）、`core/store.ts`（重建去重索引） |
| S5 | 账本损坏被当空表 | `core/tombstone.ts`、`core/store.ts`（fail-closed） |
| A1 | 无 controller 无超时；预先取消仍发送 | `core/ai.ts` |
| A2 | paused 通过 `mayCommit` | `core/jobs.ts` |
| A3 | 计费未知被降格为 paused | `core/jobs.ts` |
| A4 | MSE 回执方法/版本不匹配仍称成功 | `core/mse-bridge.ts` |
| A5 | 空证据绕过复盘门槛 | `core/review.ts` |
| X1 | profile 未排除 invalid / 未生效 | `core/profile.ts` |
| X2 | 根目录/绝对路径校验不严 | `core/paths.ts`、`core/settings.ts` |
| C03/C05/C06/C07 | 正文被吞 / 项目范围放大 / 过期仍召回 / 去重截断 | `core/record.ts`、`core/search-index.ts` |
| N01–N04 | 路径契约、叶子符号链接、严格 root、锁与直写声明 | `cli/node-store.ts`（＋默认改队列） |
| Q1/Q2/Q3 | 无引用仍算成功 / 空白证据 / 预算越界 | `core/qa.ts` |

每条都配有 `tests/` 下针对性的反例回归；测试名字里的“历史反例”指第二轮审查给出的真实复现。

## 独立验收脚本（只读，禁止修改；由协调者持有，不在本仓库）

脚本放在协调目录里（路径见协调者的 `HANDOVER.md`），本仓库不复制、不修改它们。

| 脚本 | 覆盖 | 本会话最近一次实跑 |
| --- | --- | --- |
| `verify-core-independent.cjs` | 13 项核心反例 | 13/13 PASS |
| `verify-ai-independent.cjs` | 6 项 AI/作业反例 | 6/6 PASS（自报 `SOURCE_CHECKS_ONLY`） |
| `verify-qa-independent.cjs` | 3 组契约场景 | 3/3 PASS（自报 `CONTRACTS_ONLY`） |
| `verify-vault-independent.cjs` | 4 项 Vault/合成库契约 | 4/4 PASS（自报 `SYNTHETIC_ONLY_NATIVE_PENDING`） |
| `verify-queue-independent.cjs` | 4 项队列反例（Q01–Q04） | 4/4 PASS |
| `verify-node-independent.cjs` | 4 项 Node 契约（N01–N04） | 4/4 PASS |
| `verify-ui-independent.cjs` | 9 项界面接线反例 | 9/9 PASS（`nativePending: true`） |
| `verify-mcp-independent.mjs` | MCP 真机 SDK smoke | **未跑**：要求冻结 bundle + sha256，由协调者在冻结后执行 |

这些脚本自报的 `acceptance` 字段本身就写明「不是原生验收」——不要把它们当成 GUI 证据。

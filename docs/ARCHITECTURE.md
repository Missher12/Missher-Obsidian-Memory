# 架构（ARCHITECTURE）

面向维护者。产品怎么用见 [README.md](../README.md)；本轮任务与验收边界见 [docs/TASK.md](TASK.md)。

## 一句话

一个**本地优先**的第二大脑：记忆是 Markdown 文件（你就是数据的主人），
只有一个写入者（Obsidian 插件），AI 只是可选的加速器，不是权威。

## 分层

```
packages/core      纯核心：不依赖 Obsidian、Node、MSE
packages/plugin    唯一的写入者：Obsidian 插件（Vault API）
packages/cli       外部适配器：CLI + MCP（Node 只允许出现在这一层）
```

依赖方向是单向的，`core` 不知道另外两层的存在：

```
core  ←── plugin
  ↑
  └────── cli（通过 .memory/requests 的**文件协议**与插件通信，不 import 插件）
```

这条边界是硬约束，由构建脚本与测试共同看住：

- 插件产物里**不得出现 `node:` 引用**（`scripts/verify.mjs` 的一等检查项）；
- 核心**不得 import obsidian / node**；
- CLI/MCP 与插件之间**没有函数调用**，只有 `<记忆根>/.memory/` 下的文件交换。

## 为什么只有一个写入者

多进程同时改同一个 Markdown 文件，最后写入的一方会静默覆盖另一方——
这类损坏不会报错，只会悄悄丢内容。因此：

- **外部入口（CLI / MCP）只排队**：把请求写成 `<记忆根>/.memory/requests/<id>.md`，
  然后返回 `accepted`（已排队）。它们**从不直接改笔记**。
- **插件是唯一的提交者**：处理队列时用 `Vault.process` 在**同步回调**里
  比较当前原文与期望哈希，一致才写。人工编辑在这中间发生 → 得到 `conflict`，
  你的编辑保留，请求不生效。
- 处理结果写进 `<记忆根>/.memory/receipts/<id>.md`。因此
  **accepted ≠ completed**：只有出现回执才算真的进库。

请求文件在写下有效回执（`completed` / `conflict`）后被删除；
失败 / 过期（`failed` / `expired`）的请求会留在原处，方便排查后重提。

## 状态语义

| 状态 | 含义 | 记忆是否改变 |
| --- | --- | --- |
| `accepted` | 已持久排队，等插件处理 | 没有 |
| `completed` | 已提交，回执里有落地证据（内容哈希 / revision） | 是 |
| `conflict` | 排队后内容被人工改过，前置条件不成立，本次取消 | 没有 |
| `failed` | 处理失败（载荷非法、权限不允许、磁盘问题…） | 没有 |
| `expired` | 超过 `expires_at` 仍未被处理 | 没有 |
| `pending` | 还没有回执 | 没有 |

## 核心模块（packages/core/src）

| 文件 | 负责 |
| --- | --- |
| `types.ts` | 记录结构、状态枚举、`SCOPE_KINDS`（personal / project / context） |
| `record.ts` | Markdown ↔ 记录的解析与序列化（frontmatter + 正文） |
| `store.ts` | 记忆的增删改查、revision、`expectedHash` 比较、待审补丁 |
| `hash.ts` | 内容哈希与幂等键（`contentHash` 是「这一版」的身份） |
| `queue.ts` | 请求信封的解析与**结构校验**（字段白名单、长度上限） |
| `queue-runner.ts` | 队列处理的通用流程与回执生成 / 校验 |
| `jobs.ts` | AI 作业队列、日预算、**预占账本**（见下） |
| `ai.ts` | OpenAI 兼容 provider、超时与「计费未知」判定 |
| `qa.ts` / `review.ts` | 带来源问答与确定性复盘（不调用模型也能跑） |
| `patches.ts` | AI 提案 → 待审补丁 → 用户接受才生效 |
| `mse-bridge.ts` | MSE 方法候选包的本地校验（`mse-method-v1`） |
| `paths.ts` | 路径安全：不逃出记忆根 |
| `search-index.ts` / `tokenize.ts` | 检索索引（派生物，可随时重建） |
| `lock.ts` / `tombstone.ts` | 单写入者锁与删除账本 |

## 预算：为什么要「预占账本」

AI 调用是**付费**的，所以预算必须在**发出请求之前**落盘：

1. `beginModelCall` 用保守估算预占 token 与 1 次调用，**先写盘再发请求**。
   写不进去就不发——否则崩溃后无法对账。
2. 用量回来之后 `settleModelCall` 把预占换成实测值（多退少补）。
3. 供应商没报用量 → **保留估算**，如实标注 `estimated`，不记 0、不假装实测。

难点在跨日：请求可能昨天发出、今天才回来。若结算直接按「当前日账」加减，
昨日的迟到结果会把**今天另一笔预占**冲掉，用户可以超额调用。

因此每笔预占都记下**自己属于哪一天**（`JobQueueState.reservations`）：

- 结算时核对预占所属的记账日；不在今天 → 只关掉账本条目，**一个 token 都不动**；
- **必须给出预占 id**（`beginModelCall` 的返回值里有）。缺 id 或 id 不认识时
  **拒绝记账**并保留预占——不允许靠「估算值相同」去猜是哪一笔，
  并发或乱序返回时这种猜测没有依据，猜错就是动了别人的额度；
- 账本只保留今天与昨天的条目，更早的随日界翻页淘汰。

记账日界是 **UTC**，不是本地午夜（避免时区变化导致额度提前/延后恢复）。

## 可见性：`allow_model`

每条记忆都有 `allow_model`。它为 `false` 时：

- 问答、AI 提取、语义复盘的**上下文组装阶段**就把它排除，并且报告「有几条被排除、为什么」；
- 搜索、按 id 读取、诊断都会挡住；
- **回执也不能成为第四条泄漏通道**：回执里的 `path` 与 `message` 含原文标题，
  所以回执要按**当前**可见性投影——记录被改成 `allow_model=false` 或删除之后，
  回执只返回 `requestId / status / label / committedAt / detailsHidden / reason`，
  状态照实报（`completed` 不会被改写成 `pending`）。

`memory_search` 曾被审计发现一个 `includePrivate` 越权参数，已**删除**并在运行时拒绝：
权限不能靠「schema 里没写」来保证。

## 插件侧（packages/plugin/src）

| 文件 | 负责 |
| --- | --- |
| `plugin.ts` | 插件入口：命令、设置、`acceptSuggestion` 等对外业务方法 |
| `memory-service.ts` | 把 core 的核心接到 Vault 上（store / 队列 / 作业 / 凭据） |
| `vault-store.ts` | `Vault.process` 的 CAS 实现、目录、隐藏文件可见性 |
| `commit-handler.ts` | 把一条队列请求真正提交进库（唯一写入路径） |
| `queue-service.ts` | 认领、处理、写回执、清理请求 |
| `index-refresh.ts` | 跟随 Vault 事件刷新索引（按**内容哈希**判断自写） |
| `job-runner.ts` | 作业执行与预算闸门 |
| `ask-gate.ts` | 问答的「发送前闸门 → 调用 → 对账」整段 |
| `settings-tab.ts` / `modals.ts` / `view-workbench.ts` | 界面 |

### 自写事件为什么按内容判定

插件自己写文件也会触发 Vault 事件。若按「时间窗」忽略，用户在窗口内的**人工编辑**
会被一起忽略（索引从此落后，表现为搜不到刚写的内容）；
若完全不忽略，又会自喂循环（刷新 → 写 → 事件 → 刷新）。

因此记下**自写后的内容哈希**，事件回来时比对：内容仍是自己写的那一份 → 忽略；
内容不同（人工改过）→ 照常排队刷新。协议目录（`.memory/`、`_exports/`）直接排除。

### 展示的哈希必须绑定「那一条建议」

复盘建议接受时要带**展示那一刻**捕获的记忆哈希作为前置条件。
早期实现用一个 `Map<记忆id, 哈希>`，于是：展示旧建议 → 人工编辑 →
工作台再刷新一轮（同一条记忆的新哈希把旧的覆盖掉）→ 点「接受」，
用的是刷新后的新哈希，前置条件当然通过，**旧建议的内容就覆盖了人工编辑**。

现在键是**建议实例**（建议身份 + 受影响记忆的版本），
每条建议只认自己展示时的哈希；期间被改过 → 前置条件不成立 → 提交被拒。

## 外部适配器（packages/cli/src）

- `cli.ts`：`remember / propose / update / correct / supersede / forget / delete /
  confirm / reject / restore / search / get / queue-status / wait-receipt /
  session-commit / stats / export`，默认只排队。
- `mcp.ts`：MCP stdio 服务器，11 个工具（搜索、读取、解释、状态、排队写、
  会话提交、回执、队列状态）。**没有直写工具**。
- `external-queue.ts`：写请求信封与回执的读写（与插件共用 core 的解析器）。
- `node-store.ts`：Node 侧的存储实现（只给 CLI/MCP 用）。

MCP 的写工具与其他入口同契约：只排队，返回 `accepted` 与 `requestId`。

## 数据布局

```
<记忆根>/
  00-收件箱/…            记忆 Markdown（frontmatter 带 id / revision / allow_model 等）
  .memory/
    requests/<id>.md     外部排队的写请求（处理成功后被删除）
    receipts/<id>.md     每个请求的结果（删除账本的唯一记录）
    jobs.json            AI 作业队列 + 日预算 + 预占账本
    patches.json         待审补丁
    probe.json           隐藏目录可读性探测
    audit/…              本地审计详情
  _exports/…             显式导出的 MSE 方法候选包（只本地）
```

`.memory` 与 `_exports` 是**协议目录**，不是缓存：里面有请求正文、
删除账本和待审补丁，删之前要知道自己在丢什么。

## 已知边界（不当作已通过）

- AI 的真实远端端点、提示注入的影响、移动端、MSE 端到端、多设备并发：
  见 README 的「明确没有验证的部分」。
- 索引刷新在真实运行时**取不到同步的当前内容**（`Vault.read` / `cachedRead` 都是
  异步的），所以同一路径的自写事件在生产路径上会多排队刷新一次。
  这是刻意取舍（宁可多刷一次，也不要漏掉人工编辑），只经合成测试覆盖。
- 没有真实网络取消能力时，代码如实区分「停止提交」与「停止网络请求」，
  不把前者说成后者。

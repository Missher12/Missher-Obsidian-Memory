# READY —— 冻结候选就绪清单

> 生成时间：2026-10-09。执行者：原生 DSH 会话（`deepseek-account` / `deepseek-flash`，max 推理）。
> 本文件只写**跑过的命令与真实结果**。设计说明在 `docs/ARCHITECTURE.md`，
> 交接与未验证层在 `HANDOVER.md`。

## 结论

**源码与包：可以按可安装的 0.1.0 交付。**
**原生 GUI 验收：未完成**，原因是本机系统许可（Screen Recording 未授权），不是代码问题。
这一层必须由协调者记入 Release，不能写成已通过。

Git 状态：分支 `main`，**无任何 commit**，98 个文件全部未跟踪；本会话未 `git add`、未提交、未推送。

## 冻结校验和

```text
dc1463d8aadd86d5fe55f5d76d484cdc083fe3f75499eb903aa3428656a7cba6  missher-obsidian-memory-0.1.0.zip
7deebe82e45d20a96a824b49625005252db05d9a6c259607214e76e61150abd8  mom-memory-cli-0.1.0.tgz
61f71cc8eff1aeeddc0f5d5c469f9a520cbd37fee67c803363531756d139966a  missher-obsidian-memory/main.js
391cefdab7043b35e7e56a97ca2f2b6a5899ffbf1875e02574c474847e6337b7  missher-obsidian-memory/manifest.json
aa140388950a2b1480bb6c0b9f263a42cba63e6e1552ac3adee57d237802a28e  missher-obsidian-memory/styles.css
```

`node scripts/package.mjs` 连跑三次，上面 5 个哈希**逐一相同**（归档时间戳已归一化）。
文件大小：ZIP 134,577 B；tgz 159,633 B；main.js 509,915 B；styles.css 6,553 B。
`manifest.json` 关键字段：`id=missher-obsidian-memory`、`version=0.1.0`、
`minAppVersion=1.5.0`、`isDesktopOnly=true`。

> `minAppVersion: 1.5.0` 标的是 API 下限，**不是已验收版本**；
> 实际只在本机 1.13.4 上启动过，而 GUI 层验收被系统许可挡住（见下）。

## 跑过的命令与结果

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | 通过（obsidian 保持 1.13.1；`pnpm-lock.yaml` 已提交内容一致） |
| 2 | `node scripts/build.mjs` | `core, plugin, cli, mcp` 四份产物；**重复构建哈希相同** |
| 3 | `node scripts/package.mjs` | 7/7 项检查通过；ZIP + tgz + `SHA256SUMS.txt` |
| 4 | `node scripts/verify.mjs` | **18/18 项通过**（含产物边界、三份类型检查、228 项测试、两个 e2e、校验和一致） |
| 5 | `npx vitest run` | **11 个测试文件 / 228 项全部通过** |
| 6 | `node scripts/e2e-cli.mjs` | CLI 端到端：34 项通过，0 项失败；闭环结论行成立 |
| 7 | `node scripts/e2e-mcp.mjs` | MCP 端到端：88 项通过，0 项失败 |
| 8 | 独立 CLI 解包复核 | 解包后 `lib/cli.js help`、`queue-status` 直接可跑，**不依赖仓库** |

MCP 协议握手（真实 JSON-RPC，对 `examples/synthetic-vault`）：

```text
initialize → {'name': 'missher-obsidian-memory', 'version': '0.1.0'}
tools/list → 11 个工具：memory_search, memory_get, memory_explain, memory_status,
             memory_remember, memory_update, memory_forget, memory_session_commit,
             memory_wait_receipt, memory_receipts, memory_queue_status
```

这条握手**不写库、不发模型请求**（初始化只描述能力）。

## 协调者独立脚本（本会话实跑，非自评）

```text
verify-core-independent.cjs    {"total":13,"passed":13,"failed":0,"sourceStable":true}
verify-ai-independent.cjs      {"pass":6,"fail":0}            self-report: SOURCE_CHECKS_ONLY
verify-qa-independent.cjs      {"pass":3,"fail":0}            self-report: CONTRACTS_ONLY
verify-vault-independent.cjs   {"pass":4,"fail":0,"nativePending":1}
verify-queue-independent.cjs   {"total":4,"passed":4,"failed":0}
verify-node-independent.cjs    {"total":4,"failed":0,"passed":4}   （含 N04）
verify-ui-independent.cjs      {"pass":9,"fail":0,"nativePending":true}
verify-mcp-independent.mjs     未跑：要求 --bundle <冻结 mcp.js> --sha256 <hex>
```

这些脚本自己就把 `acceptance` 标成「不是原生验收」——不要把上表当 GUI 证据。

## 反证（证明新回归测试是有效的）

| 反证做法 | 结果 |
| --- | --- |
| 去掉 `queue.ts` 的 `oneOf: SCOPE_KINDS` | 新增的「未知 scope 入队即拒」测试**红** |
| 放宽 `validateReceipt` 的 completed 分支 | 「自报成功但无证据被降级为 failed」测试**红**（同时另一项也红） |
| 把 MCP 回执的 `store.load({force:true})` 改回 `load()` | MCP e2e 中 3 项回归**红** |
| 把 `capturedHashes` 还原成旧全局 Map 语义 | UI 接线测试的旧建议哈希绑定回归**红** |

## 原生验收：做到了哪一步，卡在哪

**做到的**（准备动作，不是验收结论）：

- 在工作区内被 Git 忽略的 `.experiment/` 下建了唯一专属合成实验库：
  `.experiment/obs-mem-native-acceptance-20261009-liyj_ksr/OBS-MEM-Acceptance-d635e3a8eb7b`
  （回执文件 `acceptance-target.json`）。
- 冻结候选的插件三件套已放进该库的 `.obsidian/plugins/missher-obsidian-memory/`。
- 官方 Obsidian 1.13.4 已启动（pid 87288，window_id 12813）。

**卡住的**：读取窗口时系统拒绝——

```text
check_permissions        → Accessibility: granted / Screen Recording: NOT granted
get_window_state(87288,12813) → protected_resource_scope_invalid
zoom(...)                → ScreenCaptureKit capture failed … 用户拒绝了应用程序、窗口、显示器捕捉的TCC
```

**没有做的事**（按约定克制）：没有 shell 截图兜底、没有走隐藏 IPC、没有手改全局 Vault 登记、
没有去点那个权限提示窗、没有关掉用户原先的窗口。
**实验库至今没有被登记进 `obsidian.json`**（已用 grep 核对：里面只有用户既有的两个个人库）。

**因此仍未验证**：实验库登记、插件在真实 Obsidian 里的加载、`.memory` 在真实索引里的可见性、
`adapter.rename` 认领、`Vault.process` 在真实人工编辑并发下的行为、Vault 事件是否真的触发刷新、
真实界面（工作台 / 设置页 / 弹窗）的观感与交互。

证据原文留在
`.experiment/obs-mem-native-acceptance-20261009-liyj_ksr/evidence/native-acceptance-status.md`。

## 给协调者的下一步

1. `main` 首个 commit；Release 说明写入上面的哈希。
2. Release 明确列出「桌面原生 GUI 验收未完成（系统许可受阻）」。
3. 冻结后跑 `verify-mcp-independent.mjs --bundle <mcp.js> --sha256 <hex>`。
4. 若要在有屏幕录制许可的会话补原生验收，按协调目录的 `native-validation-plan.md` 走；
   实验库与回执都还在原处，可以直接续用。

# 0.1.1 交付清单

2026-10-09，按最新用户授权由 Codex 接续实现、验收和私有 Git 交付；原生 DSH 已停止，不再派发。0.1.0 保留原 tag 与资产。

本版修复自动复盘设置未被调度消费、本地维护未做确定性复盘及错误经过模型预算的问题。包含暂停/卸载检查、调度防重入、闲置活动接线、读取失败准确报告；不新增宿主或 MSE 依赖。

验证：类型检查通过；232 项测试通过，新增自动复盘定向 4 项（使用真正耗尽的预算，不把零上限当作耗尽）；18/18 自检通过，包含 CLI 34 项与 MCP 88 项端到端检查。原 0.1.0 冻结独立验收证据保持其历史层级，不冒称在新版重跑。

真实 Obsidian 1.14.4：既有基础闭环完成程序化验收；0.1.1 在备份安装后新增开关、调度防重入、本地建议、无计费标记、预算保持与 CLI 提交补验。日常根 Second Brain、默认本地自动复盘、AI/MSE 关闭、插件启用及错误检查已回读。详见 [运行验收](docs/LIVE-ACCEPTANCE.md)。

物理键鼠、长时间调度、真实远端模型、实际 MSE 接收、其他平台原生与多设备并发仍未验证。原始日志、机器路径、用户库及窗口截图仅留本机。

## 产物校验和

```text
f43a37c903623770313928f89736e6ab9e67b6d6ee48d6b9dbf8d1b4cd3278bf  missher-obsidian-memory-0.1.1.zip
b4164a0b1d1b3759951dd9ba0487f785dd8b45bcd52154a3ccf14422d6915d14  mom-memory-cli-0.1.1.tgz
72fc7961d56c444a610e75932f35b1f34c9720400df27412ac560f64c2de2be1  missher-obsidian-memory/main.js
d7c3d1345421092da126da0ebfb4f4e1ec531e6e8c9527525ced9cde60922992  missher-obsidian-memory/manifest.json
aa140388950a2b1480bb6c0b9f263a42cba63e6e1552ac3adee57d237802a28e  missher-obsidian-memory/styles.css
```

版本与运行包匹配；发布时创建 0.1.1 新 Release，不替换 0.1.0。Git/CI 最终状态以远端回读及 Release 链接为准。

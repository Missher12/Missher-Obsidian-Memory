# 这里有一个**真实排队**的示例请求

`req_20261008204916_71abae83.md` 是用仓库里真实的 CLI 命令排队出来的，
不是在文档里手写的示例文本：

```bash
node packages/cli/dist/cli.js remember \
  --vault <这个库的副本> --root 第二大脑 \
  --text "示例：Borealis 的冲突策略采用「比较当前原文再提交」，不采用最后写入者获胜。"
```

它现在的状态是 **accepted（已持久排队）**：

- 文件已经落盘，所以「请求不会丢」；
- 但**记忆还没有写进去**——这条内容现在还不存在于任何笔记里。

## 怎么让它变成 completed

在 Obsidian 里打开这个库（装好并启用插件），然后：

- 命令面板 → `Missher Obsidian Memory: 处理外部写请求队列`，或
- 直接等插件按间隔自动处理。

处理完成后你会看到：

- `requests/` 里这个文件消失（处理前它会被改名为 `*.claimed.*`）；
- `receipts/` 里出现 `req_20261008204916_71abae83.md`，`status` 是 `completed`；
- `00-收件箱/` 里多出一个带元数据的新笔记。

## 想自己再排队一条

```bash
node packages/cli/dist/cli.js propose \
  --vault <这个库的副本> --root 第二大脑 \
  --text "候选内容：等确认后才成为权威事实。"
```

`propose` 进去的记忆是 `pending`（待确认），需要在插件界面里确认。
这个区别是刻意的：外部入口默认**不能**直接制造「已确认事实」。

# 合成示例 Vault（Synthetic Demo Vault）

这是一个**完全虚构**的 Obsidian 库样本，用来演示、试用和验收
Missher Obsidian Memory。里面没有任何真实个人笔记。

## 怎么用

1. 把这个目录**复制**一份到你自己的位置（不要直接在这里试用，试用会产生垃圾文件）：
   ```bash
   cp -R examples/synthetic-vault ~/Documents/mom-demo-vault
   ```
2. 用 Obsidian 打开这份副本：`Open folder as vault` → 选刚复制出来的目录。
3. 把插件装进去（两种方式任选）：
   - **ZIP**：解压 `dist/missher-obsidian-memory-0.1.0.zip`，
     得到 `missher-obsidian-memory/` 目录，整个放进
     `<副本>/.obsidian/plugins/`；
   - **源目录**：直接把 `dist/missher-obsidian-memory/` 整个复制过去。
4. Obsidian 里 `设置 → 第三方插件` → 关闭「受限模式」→ 启用 **Missher Obsidian Memory**。
5. **把记忆根目录改成 `第二大脑`**：`设置 → Missher Obsidian Memory → 记忆根目录`
   填入 `第二大脑`（这份示例库就是这么组织的），然后点保存。
   > 默认值是 `Second Brain`。示例库为了让你一眼看懂，用的是中文目录名；
   > 不改成一致的话，插件会在库里新建一个空的 `Second Brain/`，
   > 你就看不到示例内容了。想用英文目录名也行：
   > 把 `第二大脑/` 改名成 `Second Brain/`，保持默认设置即可。
6. 打开命令面板（`Cmd/Ctrl + P`），试：
   - `Missher Obsidian Memory: 快速记住…`
   - `Missher Obsidian Memory: 打开记忆工作台`
   - `Missher Obsidian Memory: 处理外部写请求队列`

## 里面有什么

```
第二大脑/                 ← 记忆根目录（示例库用的名字；默认值是 Second Brain，见上面第 5 步）
  00-收件箱/              ← 默认写入位置
  .memory/                ← 队列与回执（隐藏目录，不是笔记）
    requests/             ← 外部排队进来的写请求
    receipts/             ← 每个请求的提交结果
  _exports/               ← MSE 方法候选包（只在显式导出时出现）
笔记/
  Borealis 项目.md        ← 虚构的项目笔记
  读书笔记示例.md         ← 虚构的读书笔记
```

## 关于 `第二大脑/.memory/`

`.memory/` 是插件的**协议数据**，不是你的笔记：

- 外部 CLI/MCP 写请求先落在这里（`accepted` = 已持久排队）；
- 插件用 `Vault.process` 提交后，把结果写成回执放在 `receipts/`；
- **`accepted` 不等于 `completed`**——只有回执里写着 `completed` 才算真的写进笔记。

可以随时删掉 `.memory/receipts/` 下的历史回执（那只是流水）；
删掉整个 `.memory/` 等于放弃还没处理的请求。

## 内容都是假的

`Borealis`、`pnpm 11`、书架编号、人名都是示例文本。
它们被刻意写得像真事，是为了让检索、来源追踪和复盘能看到真实效果。

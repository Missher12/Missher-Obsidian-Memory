# 接入方式（examples/）

三个文件，对应三种真实接入场景。

| 文件 | 给谁用 | 会动你的库吗 |
| --- | --- | --- |
| [`dsh-cordis-memory.yml`](dsh-cordis-memory.yml) | DeepSeek Harness（DSH）用户：把本插件的 MCP 服务器挂进 Cordis | 不会。它只是一段配置文本 |
| [`mcp-generic.json`](mcp-generic.json) | 其他 MCP 客户端（Claude Desktop / Cursor / Cline 等）的 `mcpServers` JSON | 不会。同上 |
| [`cli-walkthrough.sh`](cli-walkthrough.sh) | 想先用命令行确认「排队 → 插件提交 → 回执」这条闭环的人 | **会写入你指定的库**：往 `<记忆根>/.memory/requests/` 排一条合成请求 |

前两个是**静态样例**：放在这里不会自己生效，也不会自己跑；
必须由你把内容合并进对应客户端的配置。第三个是**可执行演练**，它真的会排一条请求——
演练内容是一条写着「可以删除」的合成记忆，提交后你自己删掉即可。

## 先决条件（三者相同）

```bash
pnpm install --frozen-lockfile
pnpm run package          # 产出 dist/missher-obsidian-memory-0.1.0.zip 与 dist/mom-memory-cli-0.1.0.tgz
```

`pnpm build` 只编译，**不产出 tgz**；要拿独立 CLI 包得跑 `pnpm package`。

解压那个 tgz 到任意位置，会得到一个**不依赖本仓库**的目录：

```bash
mkdir -p ~/mom-memory-cli
tar -xzf dist/mom-memory-cli-0.1.0.tgz -C ~/mom-memory-cli --strip-components=1
node ~/mom-memory-cli/lib/cli.js help       # 打印完整用法与参数
```

`--vault` 必须是**绝对路径**，指向一个真实的 Obsidian 库（或你打算作为库使用的目录）。
本产品不会猜你的库在哪；路径不存在时会明确报错，而不是替你新建一个。

### 确认 MCP 服务器能起来（真实协议握手）

MCP 入口是 stdio 服务器，**没有 `--help`，也不能裸跑**：它只说 JSON-RPC。
按它自己的协议问一句就够了（下面这条已实测可用）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| node ~/mom-memory-cli/lib/mcp.js --vault /绝对路径/你的Obsidian库
```

能看到 `serverInfo` 与工具列表就算通了。`initialize` 与 `tools/list`
**只描述能力：不写库、不发模型请求**——这条命令不会改动你的库。

### 排队 ≠ 已写入

写工具（`memory_remember` 等）只把请求排进 `<记忆根>/.memory/requests/`，
真正的写入由 Obsidian 插件完成。所以：**没装/没开插件时，MCP 排队成功 ≠ 内容已进库**。

## 三个文件的位置建议

它们是**样例**，不是构建产物。DSH 的那条要合并进 profile 的
`cordis.patch.yml`（顶层 YAML 数组）；通用 MCP 的那段要合并进对应客户端的
`mcpServers`。不要直接把样例文件丢进某个配置目录就以为生效了。

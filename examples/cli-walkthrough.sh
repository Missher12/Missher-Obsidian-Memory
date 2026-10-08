#!/usr/bin/env bash
# 命令行闭环演练：排队 → 插件提交 → 回执可读。
#
#   bash examples/cli-walkthrough.sh /绝对路径/你的Obsidian库
#
# 说明：
# - 第 1 步会**真的往你的库里排队一条写请求**（不是只读演练）。
#   它写的是一条合成内容，位置在 <记忆根>/00-收件箱/ 下，事后可以自己删掉。
# - 不联网、不需要密钥、不碰你的其他 Vault。
# - 不自动处理队列：提交必须由 Obsidian 里的插件完成（这是产品的核心约束）。
#   脚本会在最后告诉你「下一步该在 Obsidian 里点什么」。

set -euo pipefail

VAULT="${1:-}"
if [[ -z "$VAULT" ]]; then
  echo "用法：bash examples/cli-walkthrough.sh /绝对路径/你的Obsidian库" >&2
  exit 2
fi
if [[ "$VAULT" != /* ]]; then
  echo "停止：--vault 必须是绝对路径（本产品不猜库的位置）。" >&2
  exit 2
fi
if [[ ! -d "$VAULT" ]]; then
  echo "停止：目录不存在：$VAULT" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "缺少 $CLI —— 先跑一次：pnpm build" >&2
  exit 2
fi

# 每条命令都写完整的 node 调用：把 "node x.js" 存进变量再 $VAR 调用，
# 在 zsh 里不会按空格拆词。
echo "== 1. 排队一条记忆（只是排队，还不是已提交） =="
node "$CLI" remember --vault "$VAULT" --json true \
  --text "演练内存：这条是 cli-walkthrough.sh 写的合成内容，可以直接删除。"

echo
echo "== 2. 队列状态（应当有 1 条待处理） =="
node "$CLI" queue-status --vault "$VAULT"

echo
echo "== 3. 检索（此刻应当查不到——因为它还没被提交） =="
node "$CLI" search --vault "$VAULT" --text "演练内存" --limit 5

echo
echo "== 下一步（必须人工做，脚本不会代劳） =="
cat <<'TEXT'
在 Obsidian 里打开这个库并启用本插件，然后任选一种方式提交：
  - 命令面板 → 「Missher Obsidian Memory: 处理外部写请求队列」
  - 或等插件按设置自动处理
提交之后再回来跑：

  node packages/cli/dist/cli.js wait-receipt --vault <你的库> --id <上一步的 requestId>
  node packages/cli/dist/cli.js search       --vault <你的库> --text "演练内存"

回执出现 completed 才算真的进库；如果内容是 conflict，
说明排队之后有人工编辑，本次写入被取消（你的编辑保留）。
TEXT

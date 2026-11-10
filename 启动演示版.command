#!/bin/bash
# 双击运行：在本机打开 LA&9S 销售系统演示版（不需要联网，不需要安装依赖）
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if ! command -v node >/dev/null; then echo "没有找到 Node.js，请先安装 https://nodejs.org"; read -r; exit 1; fi
(sleep 1; open "http://localhost:5173/") &
node scripts/serve.mjs dist 5173

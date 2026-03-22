#!/bin/bash
# MonadX 专用停止脚本 — 只停 monadx-agent，不动其他任何服务
pm2 stop monadx-agent 2>/dev/null
echo "--- VERIFY ---"
pm2 status monadx-agent

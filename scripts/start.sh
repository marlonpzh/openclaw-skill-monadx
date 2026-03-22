#!/bin/bash
# MonadX 专用启动脚本 — 只启动 monadx-agent，不动其他任何服务
pm2 start monadx-agent 2>/dev/null
echo "--- VERIFY ---"
pm2 status monadx-agent

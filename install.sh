#!/bin/bash
set -e

echo "🚀 Installing MonadX Engine into your OpenClaw..."

# Allow users to override the base skills directory via the DEST_DIR environment variable
BASE_DIR="${DEST_DIR:-$HOME/.openclaw/workspace/skills}"
SKILL_DIR="$BASE_DIR/monadx"

echo "📂 Target installation directory: $SKILL_DIR"

# Check if the directory already exists
if [ -d "$SKILL_DIR" ]; then
  echo "📦 MonadX is already installed. Updating to latest version..."
  cd "$SKILL_DIR"
  git pull origin main
  # Ensure scripts are executable after pull
  chmod +x scripts/*.sh 2>/dev/null || true
  # Restart running daemon to pick up new code
  if command -v pm2 >/dev/null 2>&1 && pm2 describe monadx-agent >/dev/null 2>&1; then
    echo "🔄 Restarting monadx-agent to apply updates..."
    pm2 restart monadx-agent > /dev/null 2>&1 || true
  fi
else
  echo "📥 Cloning MonadX repository..."
  mkdir -p "$BASE_DIR"
  git clone https://github.com/marlonpzh/openclaw-skill-monadx.git "$SKILL_DIR"
  cd "$SKILL_DIR"
fi

echo "⚙️ Installing dependencies..."
npm install > /dev/null 2>&1

echo "📁 Bootstrapping MonadX User Data Directory (~/.monadx)..."
MONADX_DATA_DIR="$HOME/.monadx"
mkdir -p "$MONADX_DATA_DIR"

if [ ! -f "$MONADX_DATA_DIR/config.json" ]; then
  cp config.json "$MONADX_DATA_DIR/config.json"
fi

if [ ! -f "$MONADX_DATA_DIR/resume.md" ]; then
  echo -e "# (请通过 IM 频道告诉 Agent 你的求职信息)\n\n## Skills\n(待填写)\n" > "$MONADX_DATA_DIR/resume.md"
fi

if [ ! -f "$MONADX_DATA_DIR/jd.md" ]; then
  echo -e "# (请通过 IM 频道告诉 Agent 你的招聘信息)\n\n## Requirements\n(待填写)\n" > "$MONADX_DATA_DIR/jd.md"
fi

echo "🛡️ Installing System Daemon (PM2) to keep MonadX online 24/7..."
npm install -g pm2 > /dev/null 2>&1 || echo "⚠️ PM2 install skipped (requires sudo or node mismatch). MonadX might not autorun."

if command -v pm2 >/dev/null 2>&1; then
  echo "⚡ Spinning up MonadX Core Node in background..."
  pm2 delete monadx-agent > /dev/null 2>&1 || true
  pm2 start "npx tsx src/index.ts daemon" --name "monadx-agent" > /dev/null 2>&1
  pm2 save > /dev/null 2>&1
  echo "🎉 Daemon installed successfully! Your Node is now immortal on the P2P network."
fi

echo "✅ Installation Complete! MonadX is now integrated into OpenClaw."
echo ""
echo "🔥 What to do next:"
echo "1. Start OpenClaw"
echo "2. Open your IM channel and type: 'I want to post a job' or 'Find me a job'"
echo "3. The Agent will handle everything automatically. No commands needed!"

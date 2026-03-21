#!/bin/bash
set -e

echo "🚀 Installing MonadX Engine into your OpenClaw..."

# Allow users to override the base skills directory via the DEST_DIR environment variable
BASE_DIR="${DEST_DIR:-$HOME/.openclaw/skills}"
SKILL_DIR="$BASE_DIR/monadx"

echo "📂 Target installation directory: $SKILL_DIR"

# Check if the directory already exists
if [ -d "$SKILL_DIR" ]; then
  echo "📦 MonadX is already installed. Updating to latest version..."
  cd "$SKILL_DIR"
  git pull origin main
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
  echo -e "# 张三 — 寻求全栈开发岗位\n\nSkills: Node.js, React, TypeScript\nLocation: Remote\nSalary: 20-30k\n\n(Edit this file to build your precise seeker profile!)" > "$MONADX_DATA_DIR/resume.md"
fi

if [ ! -f "$MONADX_DATA_DIR/jd.md" ]; then
  echo -e "# 招聘：高级算法工程师\n\nSkills: PyTorch, AI, C++\nLocation: Beijing\nSalary: 30-50k\n\n(Edit this file to build your precisely targeted employer JD!)" > "$MONADX_DATA_DIR/jd.md"
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

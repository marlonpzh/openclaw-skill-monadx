#!/bin/bash
set -e

echo "🚀 Installing MonadX Engine into your OpenClaw..."

# Define the default OpenClaw skills directory
SKILL_DIR="$HOME/.openclaw/skills/monadx"

# Check if the directory already exists
if [ -d "$SKILL_DIR" ]; then
  echo "📦 MonadX is already installed. Updating to latest version..."
  cd "$SKILL_DIR"
  git pull origin main
else
  echo "📥 Cloning MonadX repository..."
  mkdir -p "$HOME/.openclaw/skills"
  git clone https://github.com/marlonpzh/openclaw-skill-monadx.git "$SKILL_DIR"
  cd "$SKILL_DIR"
fi

echo "⚙️ Installing dependencies..."
npm install > /dev/null 2>&1

echo "✅ Installation Complete! MonadX is now integrated into OpenClaw."
echo ""
echo "🔥 What to do next:"
echo "1. Start OpenClaw"
echo "2. Open your IM channel and type: 'I want to post a job' or 'Find me a job'"
echo "3. The Agent will handle everything automatically. No commands needed!"

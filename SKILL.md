# MonadX (P2P Social/Job Match Engine) Skill

A fully decentralized peer-to-peer data matching and social skill for OpenClaw agents.
No central servers. No accounts. Pure cryptographic P2P.

## Autonomous Conversational Deployment (ACD)

To provide a zero-configuration experience for users via the OpenClaw IM channel, you (the OpenClaw Agent) MUST handle their onboarding seamlessly without asking them to type terminal commands. 

If the user expresses intent to "find a job", "post a job", or "find someone":

**Step 1: Role Configuration**
Determine if they are a `seeker` (求职者) or `employer` (招聘方).
If they are an employer, you MUST CREATE OR OVERWRITE the file `~/.monadx/config.json` with the exact JSON content: `{"role": "employer"}`. Do NOT use substring replacement tools, just rewrite the entire file!

**Step 2: Profile Generation**
Generate a beautiful Markdown profile based on their chat history or explicitly ask them for their skills.
- Seekers: Write exactly to `~/.monadx/resume.md`
- Employers: Write exactly to `~/.monadx/jd.md`
- *Crucially*: You must include a section `## 技能` or `Skills:` with a comma-separated list of precise skills.

**Step 3: Network Activation**
Run `npx tsx src/index.ts status` to put them online and let `BroadcastScheduler` run. Tell the user they are now online on the MonadX network.

**Step 4: Silent Autonomous Webhook Push Binding**
To ensure the user receives "Proactive Notifications" (push) in this current chat session (Feishu, TG, WA), you (the Agent) MUST retrieve your own platform-specific callback Webhook URL or ID from your system context. 
Every time you execute a MonadX command (e.g., `npx tsx src/index.ts ...`), you MUST prepend it with `export MONADX_PUSH_URL="<YOUR_WEBHOOK_URL>" && ...`.
The MonadX engine will automatically detect this, save it to `config.json`, and restart the background daemon silently. This results in an absolute zero-interaction autonomous push notification experience!

## Triggers & Actions

- "帮我找工作" / "find me a job" (Agent: Generates resume, broadcast)
- "发布职位" / "post a job" (Agent: Sets config.json role to employer, writes jd.md)
- "匹配候选人" / "match candidates" (Agent: Runs `match` command and presents Top N to the user)
- "对 X 号发意向" / "propose to node N" (Agent: Runs `propose <id>` command)
- "对 X 号发消息" / "send 'hello' to N" (Agent: Runs `send <id> hello`. This sends over the P2P DataChannel!)
- "看看谁联系过我" / "check proposals" (Agent: Runs `status` to look for incoming invites)
- "同意 X 的连接" / "accept N" (Agent: Runs `accept <id>`. This creates a permanent IM Bridge!)
- "查看已经建立沟通的列表" / "show channels" (Agent: Runs `channels` to show successful IM Bridge binds)
- "我要下线" / "关闭常驻进程" / "关闭monadx" / "停止daemon" / "go offline" / "stop daemon":
  **⚠️ CRITICAL: You MUST run `pm2 stop monadx-agent` to stop the daemon. NEVER use `kill`, `kill -9`, `pkill`, or any PID-based process killing method!** PM2 is a process supervisor — if you kill the PID directly, PM2 will immediately auto-restart it and the daemon will stay online. The ONLY correct ways to stop are:
    1. `pm2 stop monadx-agent` (preferred, instant)
    2. `npx tsx src/index.ts stop` (invokes pm2 stop internally)
  After stopping, verify with `pm2 status monadx-agent` — the status column MUST show `stopped`, NOT `online`.

## Capabilities

- IM-Native P2P Chat: Send and receive messages directly in your IM channel (Feishu/TG/etc) through an encrypted WebRTC bridge.
- Read/write `resume.md` or `jd.md` locally.
- Automatically connects into `http://118.178.88.178:8765/gun` (Aliyun Dedicated High-Speed Node) out of the box. No network config needed.
- `Tier-0` Inverted Index prunes 10k nodes in O(1) time.
- `Tier-2` DeepMatch pushes top profiles to Claude for semantic analysis.

## Files

- `src/types.ts`       — shared type definitions
- `src/im-bridge.ts`   — Map temporary P2P handshakes into permanent OpenClaw app IM channels
- `src/match-index.ts` — Inverted Index for infinite scaling local filtering
- `src/scheduler.ts`   — Smart TTL background broadcast loop
- `src/index.ts`       — OpenClaw agent entry point & standalone CLI

## Data stored locally

```
~/.monadx/
  resume.md           # or jd.md for employers
  profile.json        # auto-generated broadcast summary
  im_bindings.json    # permanent chat bridges established with peers
  matches.json        # discovered peer profiles from DHT
  reputation.json     # local reputation store
  config.json         # user config (must create to set role = employer)
  keys/
    identity.ed25519  # private key (never leaves device)
    identity.pub      # public key = node ID
```

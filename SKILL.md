# P2P Jobs Skill

A decentralized peer-to-peer job matching skill for OpenClaw agents.
No servers. No accounts. No blockchain. Pure P2P.

## Triggers

- "帮我找工作" / "find me a job"
- "发布职位" / "post a job"
- "匹配候选人" / "match candidates"
- "查看我的匹配" / "show my matches"
- "更新简历" / "update my resume"
- "查看声誉" / "show reputation"

## Capabilities

- Read/write local resume.md or jd.md
- Generate and broadcast profile.json to P2P network
- Match against discovered peers using local semantic scoring
- Initiate encrypted handshake with matched peers
- Manage local reputation store

## Files

- `src/types.ts`       — shared type definitions
- `src/identity.ts`    — Ed25519 key generation and signing
- `src/profile.ts`     — local file I/O and profile.json generation
- `src/network.ts`     — Gun.js P2P broadcast and discovery
- `src/match.ts`       — semantic matching engine
- `src/handshake.ts`   — WebRTC direct connection + intent signals
- `src/reputation.ts`  — local reputation store and gossip
- `src/index.ts`       — OpenClaw agent entry point

## Data stored locally

```
~/.monadx/
  resume.md           # or jd.md for employers
  profile.json        # auto-generated broadcast summary
  matches.json        # discovered peer profiles
  reputation.json     # local reputation store
  keys/
    identity.ed25519  # private key (never leaves device)
    identity.pub      # public key = node ID
```

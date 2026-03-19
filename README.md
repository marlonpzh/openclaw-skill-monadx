# openclaw-skill-monadx

A fully decentralised, resilient job-matching skill for [OpenClaw](https://openclaw.ai). Designed to scale to tens of thousands of peers locally without a central database.

- **No servers, zero lock-in.** No accounts, no databases, no blockchain.
- **Privacy-first data ownership.** Your full resume/JD text never leaves your machine unless you explicitly accept a connection.
- **Smart P2P discovery.** Uses a rotating broadcast scheduler and Gun.js DHT for profile gossiping.
- **Blazing fast AI matching.** 
  - *Tier-0*: O(1) Inverted Index pruning (scales to 10k+ nodes instantly).
  - *Tier-1*: Jaccard similarity & multi-dimensional scoring.
  - *Tier-2*: Claude semantic analysis on demand via OpenClaw MCP.
- **Direct encrypted connections.** WebRTC DataChannel (or TCP fallback) for full document exchange.
- **Persistent IM Bridge.** Automatically transitions volatile P2P handshakes into persistent OpenClaw IM channels.

---

## How it works

```text
Your resume.md          Peer's jd.md
  (local only)            (local only)
      │                       │
      ▼                       ▼
  profile.json ──────► P2P Network (Gun.js DHT)
  (skills, location,    Smart Broadcast Scheduler
   salary range,        (Hot/Steady/Sleep modes)
   node ID, sig)
      │                       │
      └──── local match ───────┘
            (Tier-0: Inverted Index Filter)
            (Tier-1: Multi-dimension Scoring)
                  │
           optional: Claude
           deep analysis via MCP
                  │
           double opt-in handshake
           (both must accept)
                  │
           WebRTC / TCP Direct Link
           (encrypted direct channel)
           full doc exchange
                  │
           IM Channel Bridge
           (persistent OpenClaw chat)
```

---

## Quick start

The absolute easiest way to deploy MonadX into your existing OpenClaw setup is to run our one-line installer:

```bash
# This automatically clones the repo into ~/.openclaw/skills/monadx and installs dependencies
curl -fsSL https://raw.githubusercontent.com/marlonpzh/openclaw-skill-monadx/main/install.sh | bash
```

> **Note**: If your OpenClaw skills directory is located somewhere other than the default `~/.openclaw/skills`, you can specify a custom path using `DEST_DIR` before the `bash` command:
> ```bash
> curl -fsSL https://raw.githubusercontent.com/marlonpzh/openclaw-skill-monadx/main/install.sh | DEST_DIR=/your/custom/skills/path bash
> ```

Once installed, **you don't need to manually run any terminal commands.** Just talk to your OpenClaw agent in any IM channel:
- *"I am looking for a job as a Node.js engineer in Tokyo."*
- *"I am an employer. Help me broadcast a JD for a senior algorithm engineer."*

The OpenClaw Agent autonomously parses your intent, edits your `~/.monadx/config.json`, extracts your core skills into a strict Markdown format (`~/.monadx/resume.md`), and launches the background DHT syncing protocol (`status` command).


---

## Commands

Commands now support either a full Node ID, a prefix (>= 8 chars), or the **1-based index** shown in your latest `match` or `status` output.

| Command | Description |
|---|---|
| `status` | Show node ID, role, discovered peers, pending connections, & active IM channels |
| `match` | Run fast local skill-based matching against all cached peers |
| `deepmatch [n]` | Claude semantic analysis on top-N local matches |
| `broadcast` | Trigger an immediate hot-start broadcast of your profile |
| `propose <序号\|id> <msg>` | Send a connection proposal to a peer |
| `accept <序号\|id>` | Accept an incoming proposal (initiates document exchange & IM binding) |
| `decline <序号\|id>` | Decline an incoming proposal |
| `channels` | List all successfully bridged persistent IM channels |
| `rate <序号\|id> <0-100>` | Record a reputation score for a peer |
| `rep [序号\|id]` | Show reputation data (all peers, or one specific peer) |

All commands also work as `SkillAction` objects from the OpenClaw agent runtime.

---

## Data directory

```text
~/.monadx/
  resume.md         ← your CV (seekers) — edit freely, any format
  jd.md             ← your job description (employers) — edit freely
  profile.json      ← auto-generated from the above; re-created on change
  matches.json      ← peer profiles cached from the network (48h default TTL)
  im_bindings.json  ← persistent mapping of peer node IDs to OpenClaw IM Channels
  reputation.json   ← your local reputation store
  config.json       ← optional config overrides (copy from project root)
  keys/
    identity.ed25519  ← private key (chmod 600, never leaves device)
    identity.pub      ← public key = your node ID
```

**Your full document text is never broadcast.** Only `profile.json` goes out:
`skills`, `location`, `salary_range`, `title`, `node_id`, `timestamp`, `sig`.

---

## Configuration

Copy `config.json` from the project root to `~/.monadx/config.json`
and edit as needed. All keys are optional — unset keys fall back to defaults.

```jsonc
{
  "role": "seeker",                    // "seeker" | "employer"

  "network": {
    "bootstrap_peers": [ "..." ],      // Gun.js relay URLs
    "peer_ttl_seconds": 172800         // 48 hours profile lifetime
  },

  "broadcast": {
    "active_hours": [9, 22],           // high-frequency active window (local time)
    "hot_start_count": 6,              // rapid broadcasts on start/update
    "hot_start_interval_sec": 300,     // 5 mins
    "steady_interval_sec": 14400,      // 4 hours in active window
    "sleep_interval_sec": 43200        // 12 hours outside active window
  },

  "matching": {
    "tier2_top_n": 5,                  // how many candidates to send to Claude
    "min_score_threshold": 10          // hide matches below this score
  }
}
```

---

## Matching algorithm

### Tier 0 — Inverted Index Pruning (O(1))
Maps `Skill -> Node Set`. Instantly rejects any peers that share exactly 0 skills with your profile, saving massive CPU cycles against large DHT swarms.

### Tier 1 — Local Scoring (O(K))
Scores the remaining candidate peers 0–100 from four signals:

| Signal | Weight | Method |
|---|---|---|
| Skill overlap | 40% | Jaccard similarity between your skills and theirs |
| Skills in doc | 20% | How many of their skills appear in your full text |
| Salary range  | 20% | Fractional overlap of the two `[min, max]` ranges |
| Location      | 20% | Exact match → 100%, remote → 80%, same region → 60% |

### Tier 2 — Claude Deep Analysis (via `deepmatch`)
Sends your full document + peer's skills list (or full doc if they've connected) to Claude. Returns structured JSON: `score`, `strengths`, `gaps`, `recommendation`.
*(Requires `ANTHROPIC_API_KEY` when running outside OpenClaw)*

---

## Security model

| Concern | Mitigation |
|---|---|
| Fake profiles | Every `profile.json` is Ed25519-signed with the sender's private key. Peers verify the signature before storing. |
| Stale profiles | Profiles include a `timestamp`; anything older than the configured TTL is rejected. |
| Full doc exposure | Full text is only sent after **both** sides explicitly accept, over an encrypted direct channel. |
| Network spam | Gun.js Warden content filter + local deduplication via seen-set + smart broadcast scheduler. |
| Byzantine reputation | BFT-lite: anonymous score vectors; outliers beyond 2σ from the median are discarded. |
| Key loss | Losing `~/.monadx/keys/identity.ed25519` = new identity. Back it up like a password. |

---

## Licence

MIT

// ─────────────────────────────────────────────
// index.ts — OpenClaw agent entry point
//
// OpenClaw calls run(action) with a parsed SkillAction.
// Also doubles as a standalone CLI for development / testing.
// ─────────────────────────────────────────────

import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

import type { SkillAction, MatchResult } from "./types.js";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { buildProfile, toBroadcast } from "./profile.js";
import { P2PNetwork } from "./network.js";
import { localMatch } from "./match.js";
import { HandshakeManager } from "./handshake.js";
import { ReputationStore } from "./reputation.js";
import { deepMatchBatch, formatDeepMatchResults } from "./mcp.js";
import { installWebRTCPolyfill } from "./webrtc-polyfill.js";
import { IMBridge } from "./im-bridge.js";
import { BroadcastScheduler } from "./scheduler.js";

// ── Boot ──────────────────────────────────────────────────────────────────

// We will initialize polyfill after Gun.js boots to prevent Gun from hijacking it.

const DATA_DIR = join(homedir(), ".monadx");

mkdirSync(DATA_DIR, { recursive: true });

const cfg = loadConfig(DATA_DIR);

// monadx_ROLE env var overrides config file (convenient for quick switching)
const NODE_ROLE = (process.env.monadx_ROLE ?? cfg.role) as "seeker" | "employer";

const keyPair = loadOrCreateIdentity(DATA_DIR);
const profile = buildProfile(DATA_DIR, NODE_ROLE, keyPair);

// 🔍 Auto-Configuration: Silent IM Push Binding
// If an Agent passes its callback URL via MONADX_PUSH_URL env var, we lock it in!
if (process.env.MONADX_PUSH_URL && process.env.MONADX_PUSH_URL !== cfg.network.push_webhook) {
  cfg.network.push_webhook = process.env.MONADX_PUSH_URL;
  try {
    const fs = await import("fs");
    fs.writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify(cfg, null, 2));
    console.log(`[config] 🛡️ IM Push EndPoint 已自动绑定: ${cfg.network.push_webhook}`);
    
    // Auto-Restart Daemon if we are in CLI mode to ensure it picks up the change
    if (!process.argv.includes("stop")) {
      const { exec } = await import("child_process");
      exec("pm2 restart monadx-agent > /dev/null 2>&1 || true");
    }
  } catch (err) {
    // Ignore FS errors in read-only environments
  }
}

const isCLI = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
const cliCmd = isCLI ? (process.argv[2] ?? "help") : "none";
const isDaemon = cliCmd === "daemon" || !isCLI;

const network = new P2PNetwork({
  nodeId: keyPair.nodeId,
  dataDir: DATA_DIR,
  peers: cfg.network.bootstrap_peers,
  ttlSeconds: cfg.network.peer_ttl_seconds,
  radisk: isDaemon, // 🛠️ Fix: CLI tools (match/propose/etc) bypass file locking
});

// Install polyfill *after* Gun.js has safely bound to pure WebSockets.
installWebRTCPolyfill();

const reputation = new ReputationStore(DATA_DIR, network);

const handshake = new HandshakeManager({
  keyPair,
  network,
  docPath: profile.doc_path,
});

// Full documents received after DataChannel opens (keyed by peer node_id).
// Used by deep_match to give Claude full context instead of just skills list.
const receivedDocs = new Map<string, string>();

const imBridge = new IMBridge({
  dataDir: DATA_DIR,
  myNodeId: keyPair.nodeId,
  myTitle: profile.title,
});

handshake.onDocumentReceived = async (docText, peerNodeId) => {
  receivedDocs.set(peerNodeId, docText);
  console.log(`\n[skill] Full doc stored for ${peerNodeId.slice(0, 20)}… — run deep_match for Claude analysis.`);

  // 自动创建 IM 通道绑定
  const peerTitle = docText.split("\n")[0]?.replace(/^#\s*/, "").trim() || peerNodeId.slice(0, 16);
  const result = await imBridge.onDocExchanged(peerNodeId, peerTitle);
  if (result) {
    console.log(`[skill] IM 通道已创建: ${result.im_channel_id}`);
    
    // 🔥 Webhook Push: 主动唤醒远端 OpenClaw
    if (cfg.network.push_webhook) {
      try {
        await fetch(cfg.network.push_webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "new_match_received",
            text: `🔔 [MonadX] 与 ${peerTitle} 完成 P2P 匹配握手！\nNode: ${peerNodeId.slice(0, 16)}…\nIM Channel: ${result.im_channel_id}`,
            peer_node_id: peerNodeId,
            peer_title: peerTitle,
            im_channel_id: result.im_channel_id,
            timestamp: Date.now()
          })
        });
        console.log(`[webhook] 成功向 ${cfg.network.push_webhook} 发送主动提示机制！`);
      } catch (err: any) {
        console.error(`[webhook] 发送失败:`, err.message);
      }
    }
  }
};

handshake.onChatMessageReceived = async (text, peerNodeId) => {
  console.log(`[skill] 收到来自 ${peerNodeId.slice(0, 16)}… 的 P2P 消息: ${text}`);

  if (cfg.network.push_webhook) {
    try {
      const peerTitle = imBridge.getBinding(peerNodeId)?.peer_title || peerNodeId.slice(0, 16);
      await fetch(cfg.network.push_webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "p2p_chat_received",
          text: `💬 [MonadX] ${peerTitle}: ${text}`,
          peer_node_id: peerNodeId,
          peer_title: peerTitle,
          timestamp: Date.now()
        })
      });
    } catch (err: any) {
      console.error(`[webhook] 消息推送失败:`, err.message);
    }
  }
};

network.startDiscovery();

const scheduler = new BroadcastScheduler({
  cfg,
  dataDir: DATA_DIR,
  role: NODE_ROLE,
  keyPair,
  network,
});
scheduler.start();

// ── Skill dispatcher — called by OpenClaw agent runtime ──────────────────

export async function run(action: SkillAction): Promise<string> {
  switch (action.type) {

    case "send": {
      const { peer_node_id, text } = action;
      handshake.sendMessage(peer_node_id, text);
      return `Message sent to ${peer_node_id.slice(0, 16)}… over encrypted P2P channel.`;
    }

    case "match": {
      const peers = network.loadCachedPeers();
      if (peers.length === 0) {
        return "No peers discovered yet — the network needs a moment. Try again shortly.";
      }
      const result: MatchResult = localMatch(profile, peers);
      const visible = result.peers.filter(
        (p) => (p.score ?? 0) >= cfg.matching.min_score_threshold
      );
      if (visible.length === 0) {
        return "No peers met the minimum score threshold. Try broadening your skills list.";
      }
      return formatMatchResult({ ...result, peers: visible });
    }

    case "deep_match": {
      const topN = action.top_n ?? cfg.matching.tier2_top_n;
      const peers = network.loadCachedPeers();
      if (peers.length === 0) {
        return "No peers discovered yet. Try again shortly.";
      }
      const localResult = localMatch(profile, peers);
      const candidates = localResult.peers
        .filter((p) => (p.score ?? 0) >= cfg.matching.min_score_threshold)
        .slice(0, topN);
      if (candidates.length === 0) {
        return "No candidates qualify for deep analysis.";
      }
      console.log(`[skill] Deep-matching ${candidates.length} candidates with Claude…`);
      const results = await deepMatchBatch(profile, candidates, receivedDocs);
      return formatDeepMatchResults(results);
    }

    case "broadcast": {
      const fresh = buildProfile(DATA_DIR, NODE_ROLE, keyPair);
      network.broadcast(toBroadcast(fresh));
      return `Profile re-broadcast:\n  Title:  ${fresh.title}\n  Skills: ${fresh.skills.slice(0, 8).join(", ")}`;
    }

    case "propose": {
      const { peer_node_id, message } = action;
      handshake.propose(peer_node_id, message);
      return [
        `Proposal sent to ${peer_node_id.slice(0, 20)}…`,
        `Message: "${message.slice(0, 120)}"`,
        `Waiting for their response (timeout: ${cfg.handshake.proposal_timeout_seconds / 3600}h).`,
      ].join("\n");
    }

    case "accept": {
      handshake.accept(action.peer_node_id);
      return `Accepted ${action.peer_node_id.slice(0, 20)}… — establishing encrypted WebRTC channel.`;
    }

    case "decline": {
      handshake.decline(action.peer_node_id);
      return `Declined proposal from ${action.peer_node_id.slice(0, 20)}…`;
    }

    case "status": {
      const peers = network.loadCachedPeers();
      const conns = handshake.getStatus();
      const repAll = reputation.getAll();
      return [
        `── Node ───────────────────────────────────`,
        `  ID:    ${keyPair.nodeId.slice(0, 32)}…`,
        `  Role:  ${NODE_ROLE}`,
        `  Title: ${profile.title}`,
        `  Doc:   ${profile.doc_path}`,
        ``,
        `── Network ────────────────────────────────`,
        `  Peers discovered:  ${peers.length}`,
        `  Bootstrap relays:  ${cfg.network.bootstrap_peers.length}`,
        ``,
        `── Connections ────────────────────────────`,
        conns.length > 0
          ? conns.map((c) => `  ${c.peerNodeId.slice(0, 24)}…  [${c.status}]`).join("\n")
          : `  None`,
        ``,
        `── Reputation ─────────────────────────────`,
        repAll.length > 0
          ? repAll.slice(0, 5).map((r) => `  ${r.node_id.slice(0, 20)}…  ${r.score}/100`).join("\n")
          : `  No entries yet`,
        ``,
        `── IM Channels ────────────────────────────`,
        imBridge.formatBindings(),
      ].join("\n");
    }

    case "channels": {
      const bindings = imBridge.listBindings();
      if (bindings.length === 0) {
        return "暂无 IM 通道绑定。\n匹配成功并完成文档交换后会自动创建。";
      }
      return [
        `── IM Channels (${bindings.length}) ────────────────────`,
        imBridge.formatBindings(),
        ``,
        `TCP 断开后可通过 IM Channel ID 继续沟通。`,
      ].join("\n");
    }

    case "rate": {
      const { peer_node_id, score } = action;
      if (score < 0 || score > 100) {
        return "Score must be 0–100.";
      }
      reputation.record(peer_node_id, score);
      return `Recorded ${score}/100 for ${peer_node_id.slice(0, 20)}…`;
    }

    case "reputation": {
      return reputation.summary(action.peer_node_id);
    }

    default: {
      return "Unknown action type.";
    }
  }
}

// ── Output formatting ─────────────────────────────────────────────────────

function formatMatchResult(result: MatchResult): string {
  const lines: string[] = [
    `Found ${result.peers.length} match${result.peers.length === 1 ? "" : "es"}  (doc: ${result.doc_used})`,
    "",
  ];

  result.peers.slice(0, cfg.matching.tier1_top_n).forEach((peer, i) => {
    const bar = scoreBar(peer.score ?? 0);
    const sal =
      peer.salary_range[0] === 0
        ? "salary not specified"
        : `${peer.salary_range[0]}–${peer.salary_range[1]}k`;

    lines.push(
      `${String(i + 1).padStart(2)}. ${peer.title}`,
      `    ${bar} ${String(peer.score ?? 0).padStart(3)}/100  ·  ${peer.location}  ·  ${sal}`,
      `    ${peer.match_reason ?? ""}`,
      `    Skills: ${peer.skills.slice(0, 6).join(", ")}`,
      `    Node:   ${peer.node_id.slice(0, 28)}…`,
      "",
    );
  });

  lines.push(`To connect:  propose  <序号|node_id前缀>  "your intro message"`);
  lines.push(`  例:  propose 1 "你好，我很感兴趣"`);
  return lines.join("\n");
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// ── Node ID resolver ─────────────────────────────────────────────────────

/**
 * Resolve a user-provided identifier to a full 64-char node_id.
 *
 * Accepts:
 *   - A pure number "1" .. "N"  → index into cached match results
 *   - A hex prefix (≥ 8 chars)  → first cached peer whose id starts with it
 *   - A full 64-char hex id     → returned as-is
 */
function resolveNodeId(input: string): string {
  // Full 64-char hex — return directly
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();

  const peers = network.loadCachedPeers();
  const ranked = localMatch(profile, peers).peers;

  // Pure number → 1-based index into ranked match results
  if (/^\d+$/.test(input)) {
    const idx = parseInt(input) - 1;
    if (idx < 0 || idx >= ranked.length) {
      console.error(`序号 ${input} 超出范围 (共 ${ranked.length} 个匹配)`);
      process.exit(1);
    }
    const id = ranked[idx].node_id;
    console.log(`[resolve] #${input} → ${ranked[idx].title}  (${id.slice(0, 16)}…)`);
    return id;
  }

  // Hex prefix (≥ 8 chars) → find first match
  if (/^[0-9a-f]{8,}$/i.test(input)) {
    const lower = input.toLowerCase();
    const found = peers.find((p) => p.node_id.startsWith(lower));
    if (!found) {
      console.error(`未找到以 "${input}" 开头的节点`);
      process.exit(1);
    }
    console.log(`[resolve] ${input.slice(0, 16)}… → ${found.title}`);
    return found.node_id;
  }

  console.error(`无效的节点标识: "${input}"\n  支持: 序号(1,2,3…) / node_id 前缀(≥8位hex) / 完整 node_id`);
  process.exit(1);
}

// 🔀 Standalone CLI Entry Point
if (isCLI) {
  const args = process.argv.slice(2);
  await runCLI(args);
}

async function runCLI(args: string[]): Promise<void> {
  const cmd = args[0] ?? "help";
  const rest = args.slice(1);

  // status/match/deepmatch 需要等 Gun.js 初始化和同步
  const WAIT_CMDS = new Set(["match", "deepmatch", "status"]);
  const delay = WAIT_CMDS.has(cmd) ? 3000 : 0;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  await new Promise((r) => setTimeout(r, delay));

  let action: SkillAction;

  switch (cmd) {
    case "status": action = { type: "status" }; break;
    case "match": action = { type: "match" }; break;
    case "broadcast": action = { type: "broadcast" }; break;
    case "channels": action = { type: "channels" }; break;
    case "rep": action = { type: "reputation", peer_node_id: rest[0] ? resolveNodeId(rest[0]) : "" }; break;

    case "daemon":
      console.log("🛡️ MonadX 哨兵模式已启动！将永久挂靠在暗网倾听 P2P 匹配...");
      // 每 30 秒主动轮询一次意向信号，防止 Gun.js 事件流断开导致漏接
      setInterval(() => {
        network.pollIntents();
      }, 30000);
      return; 
      
    case "stop":
      console.log("🛑 正在停止 MonadX 守护进程...");
      import("child_process").then(({ execSync }) => {
        try { execSync("pm2 stop monadx-agent >/dev/null 2>&1"); } catch {}
        console.log("✅ 守护进程已关闭，你现在处于离线隐身状态。");
        process.exit(0);
      });
      return;


    case "deepmatch":
      action = { type: "deep_match", top_n: rest[0] ? parseInt(rest[0]) : undefined };
      break;

    case "send": {
      const [rawId, ...msgParts] = rest;
      if (!rawId) { console.error("Usage: send <序号|node_id> <message>"); process.exit(1); }
      action = { type: "send", peer_node_id: resolveNodeId(rawId), text: msgParts.join(" ") };
      break;
    }

    case "propose": {
      const [rawId, ...msgParts] = rest;
      if (!rawId) { console.error("Usage: propose <序号|node_id> <message>"); process.exit(1); }
      action = { type: "propose", peer_node_id: resolveNodeId(rawId), message: msgParts.join(" ") };
      break;
    }

    case "accept": {
      if (!rest[0]) { console.error("Usage: accept <序号|node_id>"); process.exit(1); }
      action = { type: "accept", peer_node_id: resolveNodeId(rest[0]) };
      break;
    }

    case "decline": {
      if (!rest[0]) { console.error("Usage: decline <序号|node_id>"); process.exit(1); }
      action = { type: "decline", peer_node_id: resolveNodeId(rest[0]) };
      break;
    }

    case "rate": {
      const [rawRateId, scoreStr] = rest;
      if (!rawRateId || !scoreStr) { console.error("Usage: rate <序号|node_id> <0-100>"); process.exit(1); }
      const score = parseInt(scoreStr);
      if (isNaN(score)) { console.error("Score must be a number 0–100"); process.exit(1); }
      action = { type: "rate", peer_node_id: resolveNodeId(rawRateId), score };
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }

  const result = await run(action);
  console.log("\n" + result + "\n");

  // Give Gun.js a moment to push the networking packets out before the process exits
  const WRITE_CMDS = new Set(["propose", "accept", "decline", "send", "rate", "broadcast"]);
  if (WRITE_CMDS.has(cmd)) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  process.exit(0);
}

function printHelp(): void {
  console.log(`
monadx — decentralised job matching over OpenClaw P2P

Usage:
  tsx src/index.ts <command> [args]

Commands:
  status                       Show node info, peers, connections, channels
  match                        Run local skill-based matching against cached peers
  deepmatch [top_n]            Claude semantic analysis on top N local matches
  broadcast                    Re-publish your profile to the network
  propose <序号|id> <message>   Send a connection proposal to a peer
  accept  <序号|id>             Accept an incoming proposal
  decline <序号|id>             Decline an incoming proposal
  rate    <序号|id> <0-100>     Record a reputation score for a peer
  rep     [序号|id]             Show reputation data (all, or one peer)
  channels                     List all IM channel bindings

Environment:
  monadx_ROLE=seeker|employer  Override role from config (default: seeker)
  monadx_CONFIG=<path>         Override config file path
  ANTHROPIC_API_KEY=<key>       Required for deepmatch (if not inside OpenClaw)

Data directory:  ~/.monadx/
  resume.md / jd.md   Edit these to update your profile
  config.json         Copy from project root and customise
`);
}

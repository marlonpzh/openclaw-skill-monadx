// ─────────────────────────────────────────────
// node_b.ts — 招聘方节点 (employer)
//
// stdin 命令协议（run.ts 通过 stdin 发送）:
//   FETCH:<nodeId>\n  — 主动拉取指定节点的 profile
// ─────────────────────────────────────────────

import { join }                    from "path";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir }                  from "os";

import { loadOrCreateIdentity }      from "../../src/identity.js";
import { buildProfile, toBroadcast } from "../../src/profile.js";
import { P2PNetwork }                from "../../src/network.js";
import { localMatch }                from "../../src/match.js";
import { sign }                      from "../../src/identity.js";
import { TcpDirectChannel }          from "./direct_connect.js";
import { IMBridge }                   from "../../src/im-bridge.js";
import type { BroadcastProfile, IntentSignal } from "../../src/types.js";

const RELAY_URL   = process.env.RELAY_URL   ?? "http://localhost:9765/gun";
const TARGET_NODE = process.env.TARGET_NODE ?? "";
const DATA_DIR    = join(tmpdir(), `monadx-int-b-${process.pid}`);
mkdirSync(DATA_DIR, { recursive: true });

writeFileSync(join(DATA_DIR, "jd.md"), `# 高级 TypeScript 工程师 — 测试科技公司

## 职位要求
我们正在寻找一名高级工程师加入分布式系统团队。
Location: Asia/Shanghai
Salary: 25-45k

## 必须具备
- TypeScript / Node.js 3年以上经验
- React 前端开发经验
- Docker 容器化经验
- 可远程办公

## 关于我们
测试科技公司，完全远程，专注于开源工具开发。
`);

const keyPair = loadOrCreateIdentity(DATA_DIR);
const profile = buildProfile(DATA_DIR, "employer", keyPair);

const network = new P2PNetwork({
  nodeId:  keyPair.nodeId,
  dataDir: DATA_DIR,
  peers:   [RELAY_URL],
});

const tcpChannel = new TcpDirectChannel({
  keyPair,
  network,
  docPath: profile.doc_path,
});

const imBridge = new IMBridge({
  dataDir: DATA_DIR,
  myNodeId: keyPair.nodeId,
  myTitle: profile.title,
});

tcpChannel.onConnected = () => {
  process.stdout.write(`CONNECTED\n`);
};

tcpChannel.onDocumentReceived = async (docText, peerNodeId) => {
  process.stdout.write(`DOC_RECEIVED:${docText.length}\n`);

  const peerTitle = docText.split("\n")[0]?.replace(/^#\s*/, "").trim() || "unknown";
  const result = await imBridge.onDocExchanged(peerNodeId, peerTitle);
  if (result) {
    tcpChannel.send(result.message);
    process.stdout.write(`IM_BIND:${result.im_channel_id}\n`);
  }
};

tcpChannel.onIMBind = (peerNodeId, channelId, peerTitle) => {
  imBridge.onIMBind(peerNodeId, channelId, peerTitle);
  process.stdout.write(`IM_BOUND:${channelId}\n`);
};

// 收到 accept 信号 → 作为 offerer 启动 TCP 服务器
const seenAccepts = new Set<string>();
network.onIntent((signal: IntentSignal) => {
  if (signal.action !== "accept")                 return;
  if (signal.to_node_id !== keyPair.nodeId)       return;
  const key = `${signal.from_node_id}:${signal.timestamp}`;
  if (seenAccepts.has(key))                       return;
  seenAccepts.add(key);

  console.log(`[node_b] 收到 accept，启动 TCP offerer…`);
  tcpChannel.startAsOfferer(signal.from_node_id);
});

// 发现 peer → 匹配 → propose
const proposedTo = new Set<string>();

function handlePeer(peer: BroadcastProfile): void {
  if (peer.node_id === keyPair.nodeId)             return;
  if (TARGET_NODE && peer.node_id !== TARGET_NODE) return;
  if (proposedTo.has(peer.node_id))               return;

  process.stdout.write(`DISCOVERED:${peer.node_id}\n`);

  const result = localMatch(profile, [peer]);
  const score  = result.peers[0]?.score ?? 0;
  process.stdout.write(`MATCH_SCORE:${score}\n`);

  if (score >= 20) {
    proposedTo.add(peer.node_id);
    setTimeout(() => {
      const now = Math.floor(Date.now() / 1000);
      const base = {
        from_node_id: keyPair.nodeId,
        to_node_id:   peer.node_id,
        action:       "propose" as const,
        payload_enc:  "",
        timestamp:    now,
      };
      const intentSig = sign(base as Record<string, unknown>, keyPair);
      network.sendIntent({ ...base, sig: intentSig });
      process.stdout.write(`PROPOSED:${peer.node_id}\n`);
    }, 200);
  }
}

// 当手动运行时（stdin 是 TTY），自动启动 peer 发现
// 当从 run.ts 运行时（stdin 是 pipe），仅通过 FETCH 命令触发
const isManualMode = process.stdin.isTTY || process.env.AUTO_DISCOVER === "1";

if (isManualMode) {
  network.startDiscovery();
  console.log("[node_b] 自动发现模式已启动");
}

network.onPeer(handlePeer);
network.listenIntents();

// 定期轮询意向信号，防止 Gun 的 map().on() 漏发
const intentPollTimer = setInterval(() => network.pollIntents(), 2000);

// ── stdin 命令处理 ────────────────────────────────────────────────────────
// run.ts 发送 FETCH:<nodeId> 触发主动拉取
let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk: string) => {
  stdinBuf += chunk;
  const lines = stdinBuf.split("\n");
  stdinBuf = lines.pop() ?? "";
  for (const line of lines) {
    const cmd = line.trim();
    if (cmd.startsWith("FETCH:")) {
      const nodeId = cmd.slice(6).trim();
      if (!nodeId) continue;
      console.log(`[node_b] 主动拉取 profile: ${nodeId.slice(0, 16)}…`);
      const peer = await network.fetchPeer(nodeId);
      if (peer) {
        console.log(`[node_b] fetchPeer 成功: ${peer.title}`);
      } else {
        console.log(`[node_b] fetchPeer 未找到该节点`);
      }
    }
  }
});

setTimeout(() => {
  network.broadcast(toBroadcast(profile));
  process.stdout.write(`READY:${keyPair.nodeId}\n`);
}, 500);

setTimeout(() => { clearInterval(intentPollTimer); process.stdout.write(`ERROR:node_b timeout\n`); process.exit(1); }, 60_000);

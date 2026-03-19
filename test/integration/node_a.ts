// ─────────────────────────────────────────────
// node_a.ts — 求职者节点 (seeker)
// ─────────────────────────────────────────────

import { join }                    from "path";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir }                  from "os";

import { loadOrCreateIdentity }      from "../../src/identity.js";
import { buildProfile, toBroadcast } from "../../src/profile.js";
import { P2PNetwork }                from "../../src/network.js";
import { sign }                      from "../../src/identity.js";
import { TcpDirectChannel }          from "./direct_connect.js";
import { IMBridge }                   from "../../src/im-bridge.js";
import type { IntentSignal }         from "../../src/types.js";

const RELAY_URL = process.env.RELAY_URL ?? "http://localhost:9765/gun";
const DATA_DIR  = join(tmpdir(), `monadx-int-a-${process.pid}`);
mkdirSync(DATA_DIR, { recursive: true });

writeFileSync(join(DATA_DIR, "resume.md"), `# 张伟 — TypeScript 工程师

## 技能
TypeScript, Node.js, React, PostgreSQL, Docker, remote

## 期望
Location: Asia/Shanghai
Salary: 20-40k

## 经历
### 高级工程师 @ 某科技公司 (2022–至今)
- 构建 P2P 分布式系统
- 负责前端架构设计
`);

const keyPair = loadOrCreateIdentity(DATA_DIR);
const profile = buildProfile(DATA_DIR, "seeker", keyPair);

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

  // 文档交换完成 → 创建 IM 通道绑定
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

// 监听 Gun 上的 TCP 端口广播（作为 answerer）
tcpChannel.listenAsAnswerer();

// 监听 propose，收到后发送 accept
const seenIntents = new Set<string>();
network.onIntent((signal: IntentSignal) => {
  if (signal.action !== "propose") return;
  if (signal.to_node_id !== keyPair.nodeId) return;

  const key = `${signal.from_node_id}:${signal.timestamp}`;
  if (seenIntents.has(key)) return;
  seenIntents.add(key);

  process.stdout.write(`INTENT_RECEIVED\n`);

  setTimeout(() => {
    const now = Math.floor(Date.now() / 1000);
    const base = {
      from_node_id: keyPair.nodeId,
      to_node_id:   signal.from_node_id,
      action:       "accept" as const,
      payload_enc:  "",
      timestamp:    now,
    };
    const intentSig = sign(base as Record<string, unknown>, keyPair);
    network.sendIntent({ ...base, sig: intentSig });
    process.stdout.write(`ACCEPTED\n`);
  }, 300);
});

network.startDiscovery();
network.listenIntents();

// 定期轮询意向信号，防止 Gun 的 map().on() 漏发
const intentPollTimer = setInterval(() => network.pollIntents(), 2000);

setTimeout(() => {
  network.broadcast(toBroadcast(profile));
  process.stdout.write(`READY:${keyPair.nodeId}\n`);
}, 500);

setTimeout(() => { clearInterval(intentPollTimer); process.stdout.write(`ERROR:node_a timeout\n`); process.exit(1); }, 60_000);

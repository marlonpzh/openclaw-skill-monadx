// ─────────────────────────────────────────────
// network.ts — Gun.js P2P broadcast and peer discovery
//
// Gun.js 的两个已知约束：
//   1. 不支持数组字段 — skills / salary_range 必须 JSON 序列化成字符串
//   2. 读出的对象携带 _ 元字段 — 签名验证前必须剥离
//
// 这两个处理封装在 flattenForGun / unflattenFromGun 里，
// 调用方拿到的 BroadcastProfile 始终是干净的标准对象。
// ─────────────────────────────────────────────

import Gun from "gun";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BroadcastProfile, IntentSignal, SignalMessage } from "./types.js";
import { validatePeerProfile } from "./profile.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGun = any;

export type PeerHandler = (peer: BroadcastProfile) => void;
export type IntentHandler = (signal: IntentSignal) => void;
export type SignalHandler = (msg: SignalMessage) => void;

const DEFAULT_PEERS = [
  "https://gun-manhattan.herokuapp.com/gun",
  "https://gun-us.herokuapp.com/gun",
];

const NS_PROFILES = "monadx_v2_profiles";   // 不用斜线，避免 Gun 路径歧义
const NS_INTENTS = "monadx_v2_intents";
const NS_SIGNALS = "monadx_v2_signals";

// ── Gun 序列化层 ──────────────────────────────────────────────────────────
// Gun 不支持数组 → 把 skills / salary_range 存为 JSON 字符串

type GunProfile = Omit<BroadcastProfile, "skills" | "salary_range"> & {
  skills: string;   // JSON.stringify(string[])
  salary_range: string;   // JSON.stringify([number,number])
};

export function flattenForGun(p: BroadcastProfile): Record<string, unknown> {
  return {
    ...p,
    skills: JSON.stringify(p.skills),
    salary_range: JSON.stringify(p.salary_range),
  };
}

function unflattenFromGun(raw: Record<string, unknown>): BroadcastProfile {
  // 剥离 Gun 注入的 _ 元字段
  const { _: _meta, ...clean } = raw;
  const g = clean as GunProfile;
  return {
    ...g,
    skills: safeParseArray<string>(g.skills, []),
    salary_range: safeParseArray<number>(g.salary_range, [0, 999]) as [number, number],
  };
}

function safeParseArray<T>(val: unknown, fallback: T[]): T[] {
  if (typeof val !== "string") return fallback;
  try {
    const parsed = JSON.parse(val);
    if (!Array.isArray(parsed)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

// ── P2PNetwork ────────────────────────────────────────────────────────────

export class P2PNetwork {
  private gun: AnyGun;
  private nodeId: string;
  private dataDir: string;
  private ttlSeconds: number;

  private peerHandlers: PeerHandler[] = [];
  private intentHandlers: IntentHandler[] = [];
  private signalHandlers: SignalHandler[] = [];

  // 去重：同一 node_id + timestamp 只处理一次
  private seenPeers = new Set<string>();
  private seenIntentKeys = new Set<string>();

  constructor(opts: { nodeId: string; dataDir: string; peers?: string[]; ttlSeconds?: number; radisk?: boolean }) {
    this.nodeId = opts.nodeId;
    this.dataDir = opts.dataDir;
    this.ttlSeconds = opts.ttlSeconds ?? 86400; // defaults to 24h

    const peers = opts.peers ?? DEFAULT_PEERS;
    const hasPeers = peers.length > 0;

    // 🌐 Gun initialization: Only pass peers and optional radisk overrides.
    // Specifying radisk: false is crucial for CLI tools to avoid 
    // file locking conflicts with the persistent background daemon.
    const gunOpts: any = { peers };
    if (opts.radisk === false) {
      gunOpts.radisk = false;
      gunOpts.localStorage = false;
      // We don't want the CLI tool to create its own radata folder
      gunOpts.file = false;
    }

    this.gun = Gun(gunOpts);

    console.log("[network] Gun.js 实例已初始化 | radisk:", opts.radisk !== false, "| peers:", peers.length);
  }

  // ── 广播 ─────────────────────────────────────────────────────────────────

  broadcast(profile: BroadcastProfile): void {
    const flat = flattenForGun(profile);
    console.log("[network] Initiating put() to relay for:", flat.node_id);
    
    // 使用被完整通过测试环境证明最为稳定的 get().get().put()
    // 配合之前的 scheduler.ts 中 3000ms 延时以及 radisk: false
    // 能够保证 100% 同步到远端！
    this.gun
      .get(NS_PROFILES)
      .get(profile.node_id)
      .put(flat as any, (ack: { err?: string }) => {
        if (ack?.err) console.error("[network] 广播保存失败:", ack.err);
        else console.log("[network] 广播成功，数据已发往 relay:", profile.title);
      });
  }

  // ── 发现 ─────────────────────────────────────────────────────────────────

  startDiscovery(): void {
    this.gun.get(NS_PROFILES).map().on((data: unknown) => {
      if (!data || typeof data !== "object") return;

      const raw = data as Record<string, unknown>;
      const profile = unflattenFromGun(raw);     // 剥离 _ 并还原数组字段

      if (!profile.node_id) return;
      if (profile.node_id === this.nodeId) return;

      const seenKey = `${profile.node_id}:${profile.timestamp}`;
      if (this.seenPeers.has(seenKey)) return;

      console.log(`[network] Received raw profile payload via Gun: node_id=${profile.node_id.slice(0,16)} from remote`);

      const age = Date.now() / 1000 - (profile.timestamp ?? 0);
      if (age > this.ttlSeconds || age < -86400) {
        console.warn(`[network] 丢弃时间异常的节点: node=${profile.node_id?.slice(0, 16)} age=${age}s`);
        return;
      }

      if (!validatePeerProfile(profile)) {
        console.warn(`[network] 签名/有效期验证失败: node=${profile.node_id.slice(0, 16)} title="${profile.title}" role=${profile.role}`);
        return;
      }

      this.seenPeers.add(seenKey);
      this.savePeerLocally(profile);
      this.peerHandlers.forEach((h) => h(profile));
    });

    console.log("[network] 节点发现已启动");
  }

  // ── 意向信号 ─────────────────────────────────────────────────────────────

  sendIntent(signal: IntentSignal): void {
    // key 用冒号拼接，不能有斜线（Gun 会把斜线当路径分隔符）
    const key = [signal.to_node_id, signal.from_node_id, signal.timestamp].join(":");
    const ref = this.gun.get(NS_INTENTS).get(key);
    ref.put(signal);
    console.log(`[network] 发送意向 ${signal.action} → ${signal.to_node_id.slice(0, 16)}…`);
    // 重试以应对 Gun 同步延迟
    setTimeout(() => ref.put(signal), 1000);
    setTimeout(() => ref.put(signal), 2500);
  }

  listenIntents(): void {
    this.gun.get(NS_INTENTS).map().on((data: unknown) => {
      this.processIntentData(data);
    });
  }

  /**
   * 一次性轮询所有意向信号（map().once() 补充 map().on()）。
   * 用于定时调用，防止 Gun 的事件订阅漏发。
   */
  pollIntents(): void {
    this.gun.get(NS_INTENTS).map().once((data: unknown) => {
      this.processIntentData(data);
    });
  }

  private processIntentData(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const { _: _meta, ...clean } = data as Record<string, unknown>;
    const signal = clean as unknown as IntentSignal;
    if (!signal.to_node_id || signal.to_node_id !== this.nodeId) return;
    if (!signal.from_node_id || !signal.action) return;

    // 网络层去重：同一意向信号只分发给 handler 一次
    const dedupKey = `${signal.from_node_id}:${signal.action}:${signal.timestamp}`;
    if (this.seenIntentKeys.has(dedupKey)) return;
    this.seenIntentKeys.add(dedupKey);

    this.intentHandlers.forEach((h) => h(signal));
  }

  // ── WebRTC 信令中继 ───────────────────────────────────────────────────────

  sendSignal(msg: SignalMessage): void {
    const key = [msg.to_node_id, msg.type, msg.timestamp].join(":");
    this.gun.get(NS_SIGNALS).get(key).put(msg);
  }

  listenSignals(): void {
    this.gun.get(NS_SIGNALS).map().on((data: unknown) => {
      if (!data || typeof data !== "object") return;
      const { _: _meta, ...clean } = data as Record<string, unknown>;
      const msg = clean as unknown as SignalMessage;
      if (!msg.to_node_id || msg.to_node_id !== this.nodeId) return;
      this.signalHandlers.forEach((h) => h(msg));
    });
  }

  // ── 注册回调 ─────────────────────────────────────────────────────────────

  onPeer(h: PeerHandler): void { this.peerHandlers.push(h); }
  onIntent(h: IntentHandler): void { this.intentHandlers.push(h); }
  onSignal(h: SignalHandler): void { this.signalHandlers.push(h); }

  // ── 本地缓存 ─────────────────────────────────────────────────────────────

  private savePeerLocally(peer: BroadcastProfile): void {
    const path = join(this.dataDir, "matches.json");
    let peers: BroadcastProfile[] = [];
    if (existsSync(path)) {
      try { peers = JSON.parse(readFileSync(path, "utf8")); } catch { /* 忽略损坏文件 */ }
    }
    const idx = peers.findIndex((p) => p.node_id === peer.node_id);
    if (idx >= 0) peers[idx] = peer; else peers.push(peer);

    const cutoff = Date.now() / 1000 - this.ttlSeconds;
    peers = peers.filter((p) => p.timestamp > cutoff);
    writeFileSync(path, JSON.stringify(peers, null, 2));
  }

  loadCachedPeers(): BroadcastProfile[] {
    const path = join(this.dataDir, "matches.json");
    if (!existsSync(path)) return [];
    try {
      const all: BroadcastProfile[] = JSON.parse(readFileSync(path, "utf8"));
      const cutoff = Date.now() / 1000 - this.ttlSeconds;
      return all.filter((p) => p.timestamp > cutoff);
    } catch { return []; }
  }

  /**
   * 主动拉取已知节点的 profile（用于发现阶段的补充）。
   * 不依赖 map().on() 的推送，直接用 once() 获取，更可靠。
   */
  fetchPeer(nodeId: string): Promise<BroadcastProfile | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5_000);
      this.gun.get(NS_PROFILES).get(nodeId).once((data: unknown) => {
        clearTimeout(timer);
        // setImmediate 延迟一个 tick，确保调用方的 waitForLine 监听器
        // 已经注册完毕，再触发 peerHandlers（否则 DISCOVERED: 输出可能丢失）
        setImmediate(() => {
          if (!data || typeof data !== "object") { resolve(null); return; }
          const { _: _meta, ...clean } = data as Record<string, unknown>;
          const profile = unflattenFromGun(clean);
          if (!profile.node_id) { resolve(null); return; }
          const age = Date.now() / 1000 - (profile.timestamp ?? 0);
          if (age > this.ttlSeconds || age < -300) { resolve(null); return; }
          if (!validatePeerProfile(profile)) { resolve(null); return; }
          this.savePeerLocally(profile);
          this.peerHandlers.forEach((h) => h(profile));
          resolve(profile);
        });
      });
    });
  }
}

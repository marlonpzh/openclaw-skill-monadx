// ─────────────────────────────────────────────
// test/integration/direct_connect.ts
//
// 在 node-datachannel native binary 不可用时（CI / 沙箱），
// 用 TCP Socket 直接完成文档交换，完全绕开 WebRTC 信令。
//
// 协议：
//   offerer  → 启动 TCP 服务器，通过 Gun 广播端口
//   answerer → 收到端口后直接 connect
//   双方建立连接后互发 {type:"doc", text:"..."} JSON 行
// ─────────────────────────────────────────────

import net               from "net";
import { readFileSync, existsSync } from "fs";
import type { P2PNetwork } from "../../src/network.js";
import type { KeyPair }    from "../../src/identity.js";
import { sign }            from "../../src/identity.js";

// Gun namespace（不同于 WebRTC 信令 namespace，避免混淆）
const NS_TCP = "monadx_v1_tcp";

// ── TcpDirectChannel ─────────────────────────────────────────────────────

export class TcpDirectChannel {
  private keyPair:  KeyPair;
  private network:  P2PNetwork;
  private docPath:  string;
  private server:   net.Server | null = null;
  private seenPorts = new Set<string>(); // 去重
  private tcpPollTimer: ReturnType<typeof setInterval> | null = null;

  onDocumentReceived?: (text: string, peerNodeId: string) => void;
  onConnected?:        (peerNodeId: string) => void;
  onIMBind?:           (peerNodeId: string, channelId: string, peerTitle: string) => void;

  // 活跃的 socket 引用，用于发送 im_bind 消息
  private activeSocket: net.Socket | null = null;

  constructor(opts: { keyPair: KeyPair; network: P2PNetwork; docPath: string }) {
    this.keyPair = opts.keyPair;
    this.network = opts.network;
    this.docPath = opts.docPath;
  }

  // ── offerer 端：启动 TCP 服务器，广播端口 ─────────────────────────────

  async startAsOfferer(targetNodeId: string): Promise<void> {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        console.log(`[tcp-direct] 客户端已连接`);
        this.handleSocket(socket, targetNodeId);
        resolve();
      });

      this.server.listen(0, "127.0.0.1", () => {
        const port = (this.server!.address() as net.AddressInfo).port;
        console.log(`[tcp-direct] 监听端口 ${port}`);

        // 通过 Gun 广播端口信息给目标节点
        const now = Math.floor(Date.now() / 1000);
        const payload = {
          from_node_id: this.keyPair.nodeId,
          to_node_id:   targetNodeId,
          port,
          timestamp:    now,
        };
        const sig = sign(payload as Record<string, unknown>, this.keyPair);
        const broadcastData = { ...payload, sig };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ref = (this.network as any).gun
          .get(NS_TCP)
          .get(`${targetNodeId}:${this.keyPair.nodeId}`);
        ref.put(broadcastData);
        // 重试以应对 Gun 同步延迟
        setTimeout(() => ref.put(broadcastData), 1000);
        setTimeout(() => ref.put(broadcastData), 2500);
      });
    });
  }

  // ── answerer 端：监听 Gun 上的端口广播，然后 connect ─────────────────

  listenAsAnswerer(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.network as any).gun
      .get(NS_TCP)
      .map()
      .on((data: unknown) => this.processTcpBroadcast(data));

    // 定期轮询 TCP 端口广播，防止 Gun map().on() 漏发
    this.tcpPollTimer = setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.network as any).gun
        .get(NS_TCP)
        .map()
        .once((data: unknown) => this.processTcpBroadcast(data));
    }, 2000);
  }

  private processTcpBroadcast(data: unknown): void {
    if (!data || typeof data !== "object") return;

    const { _: _meta, ...clean } = data as Record<string, unknown>;
    const payload = clean as {
      from_node_id: string;
      to_node_id:   string;
      port:         number;
      timestamp:    number;
      sig:          string;
    };

    // 只处理发给自己的消息
    if (payload.to_node_id !== this.keyPair.nodeId) return;

    // 去重
    const key = `${payload.from_node_id}:${payload.port}`;
    if (this.seenPorts.has(key)) return;
    this.seenPorts.add(key);

    console.log(`[tcp-direct] 收到端口广播 from ${payload.from_node_id.slice(0, 16)}… port=${payload.port}`);
    this.connectToOfferer(payload.from_node_id, payload.port);
  }

  private connectToOfferer(offererNodeId: string, port: number): void {
    const socket = net.createConnection(port, "127.0.0.1");

    socket.once("connect", () => {
      console.log(`[tcp-direct] 已连接到 offerer 端口 ${port}`);
      this.handleSocket(socket, offererNodeId);
    });

    socket.once("error", (e) => {
      console.error(`[tcp-direct] 连接失败: ${e.message}`);
    });
  }

  // ── 双端公用：连接建立后的文档交换 ─────────────────────────────────────

  private handleSocket(socket: net.Socket, peerNodeId: string): void {
    this.activeSocket = socket;
    this.onConnected?.(peerNodeId);

    // 发送我们的文档
    if (existsSync(this.docPath)) {
      const text = readFileSync(this.docPath, "utf8");
      const msg  = JSON.stringify({ type: "doc", text }) + "\n";
      socket.write(msg, "utf8");
      console.log(`[tcp-direct] 文档已发送 (${text.length} 字符)`);
    }

    // 接收对方消息（行协议：每条消息以 \n 结尾）
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { type: string; text?: string; im_channel_id?: string; peer_title?: string };
          if (parsed.type === "doc" && parsed.text) {
            console.log(`[tcp-direct] 收到文档 (${parsed.text.length} 字符) from ${peerNodeId.slice(0, 16)}…`);
            this.onDocumentReceived?.(parsed.text, peerNodeId);
          }
          if (parsed.type === "im_bind" && parsed.im_channel_id) {
            console.log(`[tcp-direct] 收到 IM 绑定: ${parsed.im_channel_id}`);
            this.onIMBind?.(peerNodeId, parsed.im_channel_id, parsed.peer_title ?? "");
          }
        } catch { /* 忽略格式错误 */ }
      }
    });

    socket.on("error", (e) => console.error("[tcp-direct] socket error:", e.message));
    socket.on("close", () => console.log("[tcp-direct] 连接关闭"));
  }

  /** 通过活跃的 TCP 连接发送 JSON 行消息 */
  send(jsonLine: string): void {
    if (!this.activeSocket || this.activeSocket.destroyed) {
      console.warn("[tcp-direct] 无法发送：连接已断开");
      return;
    }
    this.activeSocket.write(jsonLine + "\n", "utf8");
  }

  destroy(): void {
    if (this.tcpPollTimer) clearInterval(this.tcpPollTimer);
    this.activeSocket?.end();
    this.server?.close();
  }
}

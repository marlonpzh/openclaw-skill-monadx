// ─────────────────────────────────────────────
// test/integration/tcp_channel.ts
//
// 在 node-datachannel 不可用的环境（CI / 沙箱）里，
// 用 TCP Socket 模拟 DataChannel 的接口。
//
// 只供集成测试使用，不进入生产代码。
// ─────────────────────────────────────────────

import net    from "net";
import { EventEmitter } from "events";

// ── 模拟 DataChannel 接口 ─────────────────────────────────────────────────

export class TcpDataChannel extends EventEmitter {
  private socket: net.Socket | null = null;
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";

  onopen?:    () => void;
  onmessage?: (ev: { data: string }) => void;
  onerror?:   (ev: { message: string }) => void;
  onclose?:   () => void;

  attachSocket(socket: net.Socket): void {
    this.socket    = socket;
    this.readyState = "open";
    this.onopen?.();
    this.emit("open");

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // 按换行分割消息（简单帧协议）
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const ev = { data: line };
        this.onmessage?.(ev);
        this.emit("message", ev);
      }
    });

    socket.on("error", (e) => {
      this.onerror?.({ message: e.message });
      this.emit("error", e);
    });

    socket.on("close", () => {
      this.readyState = "closed";
      this.onclose?.();
      this.emit("close");
    });
  }

  send(data: string): void {
    if (!this.socket || this.readyState !== "open") {
      throw new Error("TcpDataChannel not open");
    }
    // 换行作为消息边界
    this.socket.write(data + "\n", "utf8");
  }

  close(): void {
    this.readyState = "closing";
    this.socket?.end();
  }
}

// ── 模拟 RTCPeerConnection 接口 ───────────────────────────────────────────

export class TcpPeerConnection {
  private port: number;
  private isOfferer: boolean;
  private dc: TcpDataChannel | null = null;
  private server: net.Server | null = null;

  connectionState = "new";

  onicecandidate?:          (ev: { candidate: null }) => void;
  ondatachannel?:           (ev: { channel: TcpDataChannel }) => void;
  onconnectionstatechange?: () => void;

  constructor(port: number, isOfferer: boolean) {
    this.port      = port;
    this.isOfferer = isOfferer;
  }

  createDataChannel(_label: string): TcpDataChannel {
    const dc  = new TcpDataChannel();
    this.dc   = dc;
    return dc;
  }

  // 模拟 SDP offer — 只是携带端口信息的 JSON
  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: JSON.stringify({ port: this.port }) };
  }

  async createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    return { type: "answer", sdp: JSON.stringify({ port: this.port }) };
  }

  // offerer 侧：启动 TCP 服务器等待 answerer 连接
  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    if (desc.type === "offer") {
      await this.startTCPServer();
    }
  }

  // answerer 侧：连接到 offerer 的 TCP 服务器
  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    if (desc.type === "offer") {
      // answerer：连接到 offerer
      const { port } = JSON.parse(desc.sdp) as { port: number };
      await this.connectTCP(port);
    }
    if (desc.type === "answer") {
      // offerer 收到 answer，什么都不用做（连接在 startTCPServer 里建立）
    }
  }

  async addIceCandidate(): Promise<void> {
    // TCP 不需要 ICE
  }

  close(): void {
    this.server?.close();
    this.dc?.close();
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  private startTCPServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        const dc = this.dc ?? new TcpDataChannel();
        this.dc  = dc;
        dc.attachSocket(socket);
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        // 立即发出"no more candidates"
        this.onicecandidate?.({ candidate: null });
        resolve();
      });
    });
  }

  private connectTCP(remotePort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(remotePort, "127.0.0.1");

      socket.once("connect", () => {
        const dc = new TcpDataChannel();
        this.dc  = dc;
        dc.attachSocket(socket);

        this.connectionState = "connected";
        this.onconnectionstatechange?.();

        // answerer 侧触发 ondatachannel（模拟 WebRTC 行为）
        this.ondatachannel?.({ channel: dc });
        resolve();
      });

      socket.once("error", reject);
    });
  }
}

// ── 注入 globalThis（覆盖 webrtc-polyfill 的 shim）───────────────────────

let nextPort = 19500;   // 每次分配一个新端口，避免冲突

export function installTCPPolyfill(): void {
  // 覆盖 webrtc-polyfill 安装的 shim
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).RTCPeerConnection = class {
    private impl: TcpPeerConnection;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set onicecandidate(fn: any)          { this.impl.onicecandidate = fn; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set ondatachannel(fn: any)           { this.impl.ondatachannel = fn; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set onconnectionstatechange(fn: any) { this.impl.onconnectionstatechange = fn; }
    get connectionState()                { return this.impl.connectionState; }

    constructor() {
      const port  = nextPort++;
      // 第一个创建的是 offerer（约定）
      const isOff = true;
      this.impl   = new TcpPeerConnection(port, isOff);
    }

    createDataChannel(label: string) { return this.impl.createDataChannel(label); }
    createOffer()                    { return this.impl.createOffer(); }
    createAnswer()                   { return this.impl.createAnswer(); }
    setLocalDescription(d: { type: string; sdp: string })  { return this.impl.setLocalDescription(d); }
    setRemoteDescription(d: { type: string; sdp: string }) { return this.impl.setRemoteDescription(d); }
    addIceCandidate(c: unknown)      { return this.impl.addIceCandidate(); }
    close()                          { return this.impl.close(); }
  };

  console.log("[tcp-polyfill] TCP DataChannel shim installed (test-only)");
}

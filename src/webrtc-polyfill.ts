// ─────────────────────────────────────────────
// webrtc-polyfill.ts
//
// Node.js doesn't ship RTCPeerConnection or RTCDataChannel.
// We bridge node-datachannel's API to the browser WebRTC shape
// so handshake.ts works identically in both environments.
//
// Call installWebRTCPolyfill() once at startup (before any
// import that constructs an RTCPeerConnection).
// ─────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

type IceServer = { urls: string | string[] };

interface RTCConfig {
  iceServers?: IceServer[];
}

// ── Minimal type stubs (the real types come from lib.dom.d.ts in browsers) ──

type RTCSdpType = "offer" | "answer" | "pranswer" | "rollback";

interface RTCSessionDescriptionInit {
  type: RTCSdpType;
  sdp?: string;
}

interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

// ── Polyfill class ────────────────────────────────────────────────────────

class NodeRTCPeerConnection {
  private pc: any;                          // node-datachannel PeerConnection
  private channels: Map<string, NodeRTCDataChannel> = new Map();
  private _connectionState: string = "new";

  onicecandidate:          ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  ondatachannel:           ((ev: { channel: NodeRTCDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  get connectionState(): string { return this._connectionState; }

  constructor(config: RTCConfig = {}) {
    // Lazy require — avoids crashing when native binary isn't built
    let nodedc: any;
    try {
      nodedc = require("node-datachannel");
    } catch {
      throw new Error(
        "[webrtc-polyfill] node-datachannel not available. " +
        "Install it with: npm install node-datachannel"
      );
    }

    const iceUrls = (config.iceServers ?? [])
      .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

    this.pc = new nodedc.PeerConnection("monadx", {
      iceServers: iceUrls,
    });

    this.pc.onStateChange((state: string) => {
      this._connectionState = state;
      this.onconnectionstatechange?.();
    });

    this.pc.onLocalCandidate((candidate: string, mid: string) => {
      this.onicecandidate?.({
        candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 },
      });
    });

    this.pc.onDataChannel((dc: any) => {
      const wrapped = new NodeRTCDataChannel(dc);
      this.channels.set(dc.getLabel(), wrapped);
      this.ondatachannel?.({ channel: wrapped });
    });
  }

  createDataChannel(label: string, _opts?: { ordered?: boolean }): NodeRTCDataChannel {
    let nodedc: any;
    try { nodedc = require("node-datachannel"); } catch { throw new Error("node-datachannel missing"); }
    const dc = this.pc.createDataChannel(label, { ordered: true });
    const wrapped = new NodeRTCDataChannel(dc);
    this.channels.set(label, wrapped);
    return wrapped;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return new Promise((resolve, reject) => {
      this.pc.onLocalDescription((sdp: string, type: string) => {
        resolve({ type: type as RTCSdpType, sdp });
      });
      try {
        this.pc.setLocalDescription();
      } catch (e) {
        reject(e);
      }
    });
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    // In node-datachannel, answer is created automatically after setRemoteDescription
    return new Promise((resolve) => {
      this.pc.onLocalDescription((sdp: string, type: string) => {
        resolve({ type: type as RTCSdpType, sdp });
      });
    });
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    if (desc?.sdp) {
      this.pc.setLocalDescription(desc.sdp, desc.type);
    }
    // If no desc, node-datachannel auto-generates on createOffer
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (!desc.sdp) throw new Error("Missing SDP");
    this.pc.setRemoteDescription(desc.sdp, desc.type);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (candidate.candidate) {
      this.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? "0");
    }
  }

  close(): void {
    this.pc.close();
  }
}

// ── DataChannel wrapper ───────────────────────────────────────────────────

class NodeRTCDataChannel {
  private dc: any;
  private _readyState: RTCDataChannelState = "connecting";

  onopen:    ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror:   ((ev: Event) => void) | null = null;
  onclose:   ((ev: Event) => void) | null = null;

  get readyState(): RTCDataChannelState { return this._readyState; }

  constructor(dc: any) {
    this.dc = dc;

    dc.onOpen(() => {
      this._readyState = "open";
      this.onopen?.({} as Event);
    });

    dc.onMessage((msg: string | Buffer) => {
      const data = typeof msg === "string" ? msg : msg.toString("utf8");
      this.onmessage?.({ data } as MessageEvent);
    });

    dc.onError((err: string) => {
      this.onerror?.({ message: err } as unknown as Event);
    });

    dc.onClosed(() => {
      this._readyState = "closed";
      this.onclose?.({} as Event);
    });
  }

  send(data: string): void {
    if (this._readyState !== "open") {
      throw new Error("DataChannel is not open");
    }
    this.dc.sendMessage(data);
  }

  close(): void {
    this.dc.close();
  }
}

// ── Install into global scope ─────────────────────────────────────────────

/**
 * Call once before creating any RTCPeerConnection in Node.js.
 * No-op in browser environments where RTCPeerConnection already exists.
 */
export function installWebRTCPolyfill(): void {
  if (typeof globalThis.RTCPeerConnection !== "undefined") return; // browser — skip

  (globalThis as any).RTCPeerConnection = NodeRTCPeerConnection;
  (globalThis as any).RTCDataChannel    = NodeRTCDataChannel;
  console.log("[webrtc-polyfill] Installed node-datachannel shim");
}

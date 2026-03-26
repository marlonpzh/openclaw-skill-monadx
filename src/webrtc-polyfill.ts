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

import { createRequire } from "module";
const require = createRequire(import.meta.url);

type IceServer = { urls: string | string[] };

interface RTCConfig {
  iceServers?: IceServer[];
}

// ── Minimal type stubs ──

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
    // Lazy load binary
    let nodedc: any;
    try {
      nodedc = require("node-datachannel");
    } catch (e: any) {
      throw new Error(`[webrtc-polyfill] node-datachannel loader failed: ${e.message}`);
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
      const label = dc.getLabel();
      const nodeDC = new NodeRTCDataChannel(dc);
      this.channels.set(label, nodeDC);
      this.ondatachannel?.({ channel: nodeDC });
    });
  }

  createDataChannel(label: string, _opts: any): NodeRTCDataChannel {
    const dc = this.pc.createDataChannel(label);
    const nodeDC = new NodeRTCDataChannel(dc);
    this.channels.set(label, nodeDC);
    return nodeDC;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: this.pc.localDescription() };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: this.pc.localDescription() };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc.sdp) {
      this.pc.setLocalDescription(desc.sdp, desc.type);
    }
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (desc.type === "offer") {
      this.pc.setRemoteDescription(desc.sdp, "offer");
    } else {
      this.pc.setRemoteDescription(desc.sdp, "answer");
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (candidate.candidate) {
      this.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || "0");
    }
  }

  close(): void {
    this.pc.close();
  }
}

class NodeRTCDataChannel {
  onopen:    (() => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  onclose:   (() => void) | null = null;
  onerror:   ((e: any) => void) | null = null;

  constructor(private dc: any) {
    this.dc.onOpen(() => this.onopen?.());
    this.dc.onMessage((data: any) => this.onmessage?.({ data }));
    this.dc.onClosed(() => this.onclose?.());
    this.dc.onError((err: string) => this.onerror?.(err));
  }

  send(data: string): void {
    this.dc.sendMessage(data);
  }

  close(): void {
    this.dc.close();
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

export function installWebRTCPolyfill(): void {
  if (typeof (global as any).RTCPeerConnection === "undefined") {
    console.log("[webrtc-polyfill] Installed node-datachannel shim");
    (global as any).RTCPeerConnection = NodeRTCPeerConnection;
    (global as any).RTCDataChannel = NodeRTCDataChannel;
  }
}

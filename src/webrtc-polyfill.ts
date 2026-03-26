// ─────────────────────────────────────────────
// webrtc-polyfill.ts
//
// Stabilized handshake with "Try Both" parameter order strategy.
// node-datachannel's C++ bindings vary across platforms.
// ─────────────────────────────────────────────

import { createRequire } from "module";
const require = createRequire(import.meta.url);

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

class NodeRTCPeerConnection {
  private pc: any;
  private channels: Map<string, NodeRTCDataChannel> = new Map();
  private _connectionState: string = "new";

  onicecandidate:          ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  ondatachannel:           ((ev: { channel: NodeRTCDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  get connectionState(): string { return this._connectionState; }

  constructor(config: any = {}) {
    const nodedc = require("node-datachannel");
    const iceUrls = (config.iceServers ?? [])
      .flatMap((s: any) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

    this.pc = new nodedc.PeerConnection("monadx", { iceServers: iceUrls });
    this.pc.onStateChange((state: string) => {
      this._connectionState = state;
      this.onconnectionstatechange?.();
    });
    this.pc.onLocalCandidate((candidate: string, mid: string) => {
      console.log(`[webrtc-polyfill] Generated local candidate: ${candidate.slice(0, 20)}...`);
      this.onicecandidate?.({ candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 } });
    });
    this.pc.onDataChannel((dc: any) => {
      const nodeDC = new NodeRTCDataChannel(dc);
      this.ondatachannel?.({ channel: nodeDC });
    });
  }

  createDataChannel(label: string, _opts: any): NodeRTCDataChannel {
    const dc = this.pc.createDataChannel(label);
    return new NodeRTCDataChannel(dc);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: this.pc.localDescription() };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: this.pc.localDescription() };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (!desc.sdp) return;
    try {
      this.pc.setLocalDescription(desc.sdp, desc.type);
      console.log(`[webrtc-polyfill] setLocalDescription success (order: sdp, type)`);
    } catch {
      try {
        this.pc.setLocalDescription(desc.type, desc.sdp);
        console.log(`[webrtc-polyfill] setLocalDescription success (order: type, sdp)`);
      } catch (e: any) {
        console.error(`[webrtc-polyfill] setLocalDescription CRITICAL FAILURE: ${e.message}`);
        throw e; // Must throw to let handshake fail early
      }
    }
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (!desc.sdp) return;
    try {
      this.pc.setRemoteDescription(desc.sdp, desc.type);
      console.log(`[webrtc-polyfill] setRemoteDescription success (order: sdp, type)`);
    } catch {
      try {
        this.pc.setRemoteDescription(desc.type, desc.sdp);
        console.log(`[webrtc-polyfill] setRemoteDescription success (order: type, sdp)`);
      } catch (e: any) {
        console.error(`[webrtc-polyfill] setRemoteDescription CRITICAL FAILURE: ${e.message}`);
        throw e;
      }
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (candidate.candidate) {
      console.log(`[webrtc-polyfill] Adding remote candidate: ${candidate.candidate.slice(0, 20)}...`);
      this.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || "0");
    }
  }

  close(): void { this.pc.close(); }
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
  send(data: string): void { this.dc.sendMessage(data); }
  close(): void { this.dc.close(); }
}

export function installWebRTCPolyfill(): void {
  if (typeof (global as any).RTCPeerConnection === "undefined") {
    console.log("[webrtc-polyfill] Installed robust dual-strategy shim with debug logs");
    (global as any).RTCPeerConnection = NodeRTCPeerConnection;
    (global as any).RTCDataChannel = NodeRTCDataChannel;
  }
}

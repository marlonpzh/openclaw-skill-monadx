// ─────────────────────────────────────────────
// handshake.ts — intent signals + WebRTC DataChannel
//
// Flow:
//   A.propose() → Gun relay → B receives intent
//   B.accept()  → Gun relay → A receives accept
//   A initiates WebRTC offer → Gun relay → B answers
//   DataChannel open → direct encrypted P2P channel
//   Both sides exchange full doc text over DataChannel
// ─────────────────────────────────────────────

import type { IntentSignal, SignalMessage } from "./types.js";
import type { KeyPair } from "./identity.js";
import type { P2PNetwork } from "./network.js";
import { sign, encryptFor, decryptFrom } from "./identity.js";
import { readFileSync, existsSync } from "fs";
import { installWebRTCPolyfill } from "./webrtc-polyfill.js";

// ── Pending connection state ─────────────────────────────────────────────

interface PendingConnection {
  peerNodeId:    string;
  peerPubKey:    string;
  status:        "proposed" | "accepted" | "connected";
  docPath:       string;
  onDoc?:        (text: string, peerNodeId: string) => void;
  rtcConn?:      any;
  dataChannel?:  any;
}

// ── Handshake manager ────────────────────────────────────────────────────

export class HandshakeManager {
  private keyPair:  KeyPair;
  private network:  P2PNetwork;
  private docPath:  string;
  private pending:     Map<string, PendingConnection> = new Map();
  private seenIntents: Set<string> = new Set();  // intent 去重

  /** Called when a full document exchange completes */
  onDocumentReceived?: (docText: string, peerNodeId: string) => void;

  /** Called when a real-time chat message arrives over P2P */
  onChatMessageReceived?: (text: string, peerNodeId: string) => void;

  constructor(opts: {
    keyPair:  KeyPair;
    network:  P2PNetwork;
    docPath:  string;
  }) {
    installWebRTCPolyfill();
    this.keyPair = opts.keyPair;
    this.network = opts.network;
    this.docPath = opts.docPath;

    // Wire up incoming message handlers
    this.network.onIntent((signal) => this.handleIncomingIntent(signal));
    this.network.onSignal((msg)    => this.handleIncomingSignal(msg));

    this.network.listenIntents();
    this.network.listenSignals();
  }

  // ── Outgoing ──────────────────────────────────────────────────────────

  /**
   * Send a connection proposal to a peer.
   * @param peerNodeId  — target node_id (= their public key hex)
   * @param message     — a short intro message (≤ 200 chars)
   */
  propose(peerNodeId: string, message: string): void {
    if (this.pending.has(peerNodeId)) {
      console.log("[handshake] Already have a pending connection with this peer");
      return;
    }

    const payload = JSON.stringify({
      intro: message.slice(0, 200),
      from_title: "see my profile",
    });

    const payloadEnc = encryptFor(payload, peerNodeId, this.keyPair);
    const now = Math.floor(Date.now() / 1000);

    const base = {
      from_node_id: this.keyPair.nodeId,
      to_node_id:   peerNodeId,
      action:       "propose" as const,
      payload_enc:  payloadEnc,
      timestamp:    now,
    };

    const signal: IntentSignal = { ...base, sig: sign(base as Record<string, unknown>, this.keyPair) };
    this.network.sendIntent(signal);

    this.pending.set(peerNodeId, {
      peerNodeId,
      peerPubKey:  peerNodeId, // node_id IS the public key hex
      status:      "proposed",
      docPath:     this.docPath,
    });

    console.log(`[handshake] Proposal sent to ${peerNodeId.slice(0, 16)}…`);
  }

  /**
   * Accept a proposal from a peer.
   * This triggers the WebRTC offer from the proposing side.
   */
  accept(peerNodeId: string): void {
    const conn = this.pending.get(peerNodeId);
    
    // 🛠️ Fix: For CLI tools, the pending map is empty. We should allow 
    // forced acceptance signals as long as we have the peerNodeId.
    if (!conn) {
      console.log(`[handshake] Initiating stateless accept for ${peerNodeId.slice(0, 16)}…`);
    }

    const now  = Math.floor(Date.now() / 1000);
    const base = {
      from_node_id: this.keyPair.nodeId,
      to_node_id:   peerNodeId,
      action:       "accept" as const,
      payload_enc:  "",
      timestamp:    now,
    };
    const signal: IntentSignal = { ...base, sig: sign(base as Record<string, unknown>, this.keyPair) };
    this.network.sendIntent(signal);

    if (conn) {
      conn.status = "accepted";
    }
    console.log(`[handshake] Accepted proposal from ${peerNodeId.slice(0, 16)}…`);
  }

  /** Decline a proposal */
  decline(peerNodeId: string): void {
    const now  = Math.floor(Date.now() / 1000);
    const base = {
      from_node_id: this.keyPair.nodeId,
      to_node_id:   peerNodeId,
      action:       "decline" as const,
      payload_enc:  "",
      timestamp:    now,
    };
    const signal: IntentSignal = { ...base, sig: sign(base as Record<string, unknown>, this.keyPair) };
    this.network.sendIntent(signal);
    this.pending.delete(peerNodeId);
    console.log(`[handshake] Declined proposal from ${peerNodeId.slice(0, 16)}…`);
  }

  // ── Incoming intent handler ───────────────────────────────────────────

  private handleIncomingIntent(signal: IntentSignal): void {
    // 去重：同一信号因 Gun map().on() 可能多次触发
    const intentKey = `${signal.from_node_id}:${signal.action}:${signal.timestamp}`;
    if (this.seenIntents.has(intentKey)) return;
    this.seenIntents.add(intentKey);

    console.log(`[handshake] Incoming intent: ${signal.action} from ${signal.from_node_id.slice(0, 16)}…`);

    if (signal.action === "propose") {
      // Decrypt their intro message
      const plain = decryptFrom(signal.payload_enc, signal.from_node_id, this.keyPair);
      const intro = plain ? (JSON.parse(plain) as { intro: string }).intro : "(encrypted)";

      console.log(`[handshake] Proposal received. Message: "${intro}"`);
      console.log(`[handshake] → Call accept("${signal.from_node_id.slice(0, 16)}…") to connect`);

      // Store so we can accept() later
      this.pending.set(signal.from_node_id, {
        peerNodeId:  signal.from_node_id,
        peerPubKey:  signal.from_node_id,
        status:      "proposed",
        docPath:     this.docPath,
      });
    }

    if (signal.action === "accept") {
      const conn = this.pending.get(signal.from_node_id);
      if (!conn) return;
      conn.status = "accepted";
      
      // 🛡️ Guard against missing WebRTC polyfill in some environments
      if (typeof RTCPeerConnection !== "undefined") {
        console.log("[handshake] Peer accepted — initiating WebRTC offer…");
        this.initiateWebRTC(signal.from_node_id);
      } else {
        console.log("[handshake] Peer accepted, but WebRTC is unavailable on this node. Use the background daemon for direct P2P connection.");
      }
    }

    if (signal.action === "decline") {
      this.pending.delete(signal.from_node_id);
      console.log(`[handshake] Peer declined: ${signal.from_node_id.slice(0, 16)}…`);
    }
  }

  // ── WebRTC ────────────────────────────────────────────────────────────

  /**
   * Initiate a WebRTC connection as the offerer.
   * We use a simple STUN server for ICE; no TURN required in most cases.
   */
  private async initiateWebRTC(peerNodeId: string): Promise<void> {
    const conn = this.pending.get(peerNodeId);
    if (!conn) return;

    const rtcConn = this.createRTCConnection(peerNodeId);
    conn.rtcConn = rtcConn;

    // Create data channel (offerer side)
    const dc = rtcConn.createDataChannel("jobs", { ordered: true });
    conn.dataChannel = dc;
    this.wireDataChannel(dc, peerNodeId);

    // Create offer and relay through Gun
    const offer = await rtcConn.createOffer();
    await rtcConn.setLocalDescription(offer);

    const now  = Math.floor(Date.now() / 1000);
    const base = {
      from_node_id: this.keyPair.nodeId,
      to_node_id:   peerNodeId,
      type:         "offer" as const,
      data:         JSON.stringify(offer),
      timestamp:    now,
    };
    const msg: SignalMessage = { ...base, sig: sign(base as Record<string, unknown>, this.keyPair) };
    this.network.sendSignal(msg);
  }

  private async handleIncomingSignal(msg: SignalMessage): Promise<void> {
    const conn = this.pending.get(msg.from_node_id);

    if (msg.type === "offer") {
      // 🛡️ Guard against missing WebRTC polyfill
      if (typeof RTCPeerConnection === "undefined") {
        console.warn("[handshake] WebRTC offer received, but WebRTC is unavailable on this node.");
        return;
      }

      // We are the answerer — create connection and answer
      const rtcConn = this.createRTCConnection(msg.from_node_id);
      if (conn) conn.rtcConn = rtcConn;

      // Wire ondatachannel (answerer side)
      rtcConn.ondatachannel = (ev) => {
        const dc = ev.channel;
        if (conn) conn.dataChannel = dc;
        this.wireDataChannel(dc, msg.from_node_id);
      };

      const offer = JSON.parse(msg.data) as RTCSessionDescriptionInit;
      await rtcConn.setRemoteDescription(offer);

      const answer = await rtcConn.createAnswer();
      await rtcConn.setLocalDescription(answer);

      const now  = Math.floor(Date.now() / 1000);
      const base = {
        from_node_id: this.keyPair.nodeId,
        to_node_id:   msg.from_node_id,
        type:         "answer" as const,
        data:         JSON.stringify(answer),
        timestamp:    now,
      };
      const reply: SignalMessage = { ...base, sig: sign(base as Record<string, unknown>, this.keyPair) };
      this.network.sendSignal(reply);
    }

    if (msg.type === "answer") {
      const rtcConn = conn?.rtcConn;
      if (!rtcConn) return;
      const answer = JSON.parse(msg.data) as RTCSessionDescriptionInit;
      await rtcConn.setRemoteDescription(answer);
    }

    if (msg.type === "ice") {
      const rtcConn = conn?.rtcConn;
      if (!rtcConn) return;
      try {
        const candidate = JSON.parse(msg.data) as RTCIceCandidateInit;
        await rtcConn.addIceCandidate(candidate);
      } catch { /* ignore stale candidates */ }
    }
  }

  private createRTCConnection(peerNodeId: string): any {
    const RTCPeerConnection = (globalThis as any).RTCPeerConnection;
    if (!RTCPeerConnection) {
      throw new Error("[handshake] RTCPeerConnection polyfill not installed. Call installWebRTCPolyfill() first.");
    }

    const rtcConn = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    // Relay ICE candidates through Gun
    rtcConn.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const now  = Math.floor(Date.now() / 1000);
      const base = {
        from_node_id: this.keyPair.nodeId,
        to_node_id:   peerNodeId,
        type:         "ice" as const,
        data:         JSON.stringify(ev.candidate),
        timestamp:    now,
      };
      const msg: SignalMessage = { ...base, sig: sign(base as Record<string, unknown>, this.keyPair) };
      this.network.sendSignal(msg);
    };

    rtcConn.onconnectionstatechange = () => {
      console.log(`[handshake] WebRTC state → ${rtcConn.connectionState}`);
    };

    return rtcConn;
  }

  // ── DataChannel: document exchange ───────────────────────────────────

  private wireDataChannel(dc: any, peerNodeId: string): void {
    dc.onopen = () => {
      console.log(`[handshake] DataChannel open with ${peerNodeId.slice(0, 16)}…`);
      const conn = this.pending.get(peerNodeId);
      if (conn) conn.status = "connected";

      // Send our full document text
      if (existsSync(this.docPath)) {
        const docText = readFileSync(this.docPath, "utf8");
        dc.send(JSON.stringify({ type: "doc", text: docText }));
        console.log(`[handshake] Full document sent (${docText.length} chars)`);
      }
    };

    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; text: string };
        if (msg.type === "doc") {
          console.log(`[handshake] Full document received from ${peerNodeId.slice(0, 16)}…`);
          this.onDocumentReceived?.(msg.text, peerNodeId);
        }
        if (msg.type === "chat") {
          console.log(`[handshake] Chat message received from ${peerNodeId.slice(0, 16)}…`);
          this.onChatMessageReceived?.(msg.text, peerNodeId);
        }
      } catch { /* malformed message */ }
    };

    dc.onerror  = (e) => console.error("[handshake] DataChannel error:", e);
    dc.onclose  = () => console.log(`[handshake] DataChannel closed: ${peerNodeId.slice(0, 16)}…`);
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  /** Send a real-time chat message over an active P2P channel */
  sendMessage(peerNodeId: string, text: string): void {
    const conn = this.pending.get(peerNodeId);
    if (!conn || conn.status !== "connected" || !conn.dataChannel) {
      throw new Error(`[handshake] No active P2P connection to ${peerNodeId.slice(0, 16)}… (Run 'match' and 'accept' first)`);
    }

    if (conn.dataChannel.readyState !== "open") {
      throw new Error(`[handshake] P2P channel not open (status: ${conn.dataChannel.readyState})`);
    }

    conn.dataChannel.send(JSON.stringify({ type: "chat", text }));
    console.log(`[handshake] Message sent to ${peerNodeId.slice(0, 16)}…`);
  }

  // ── Status ────────────────────────────────────────────────────────────

  getStatus(): { peerNodeId: string; status: string }[] {
    return [...this.pending.values()].map((c) => ({
      peerNodeId: c.peerNodeId,
      status:     c.status,
    }));
  }
}

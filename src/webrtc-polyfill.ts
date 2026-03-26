// ─────────────────────────────────────────────
// webrtc-polyfill.ts
//
// Directly use node-datachannel's built-in WebRTC polyfill
// which is fully compatible with the Browser WebRTC API.
// ─────────────────────────────────────────────

import { createRequire } from "module";
const require = createRequire(import.meta.url);

export function installWebRTCPolyfill(): void {
  // If already installed, skip
  if (typeof (global as any).RTCPeerConnection !== "undefined") {
    return;
  }

  try {
    // node-datachannel/polyfill provides RTCPeerConnection, RTCSessionDescription, etc.
    const polyfill = require("node-datachannel/polyfill");
    
    (global as any).RTCPeerConnection = polyfill.RTCPeerConnection;
    (global as any).RTCDataChannel = polyfill.RTCDataChannel;
    (global as any).RTCSessionDescription = polyfill.RTCSessionDescription;
    (global as any).RTCIceCandidate = polyfill.RTCIceCandidate;

    console.log("[webrtc-polyfill] Installed official node-datachannel/polyfill");
  } catch (e: any) {
    console.error(`[webrtc-polyfill] Failed to load node-datachannel/polyfill: ${e.message}`);
    // Fallback or handle error
  }
}

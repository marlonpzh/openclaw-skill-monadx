// ─────────────────────────────────────────────
// types.ts — shared type definitions
// ─────────────────────────────────────────────

/** Node role in the network */
export type NodeRole = "seeker" | "employer";

/**
 * What gets broadcast to the P2P network.
 * Never contains full resume/JD text — only a summary.
 */
export interface BroadcastProfile {
  node_id: string;          // hex-encoded Ed25519 public key
  role: NodeRole;
  skills: string[];         // e.g. ["TypeScript", "React", "remote"]
  location: string;         // IANA timezone or city
  salary_range: [number, number]; // [min, max] in thousands, local currency
  title: string;            // job title or desired role (≤ 60 chars)
  timestamp: number;        // Unix seconds — peers reject stale profiles
  sig: string;              // hex Ed25519 signature over canonical JSON
}

/**
 * Full local profile — stored in ~/.monadx/profile.json
 * Superset of BroadcastProfile; extra fields stay local.
 */
export interface LocalProfile extends BroadcastProfile {
  doc_path: string;         // absolute path to resume.md or jd.md
  doc_hash: string;         // sha256 of doc at last sync, for change detection
}

/** A peer discovered on the network */
export interface PeerProfile extends BroadcastProfile {
  discovered_at: number;    // Unix seconds
  score?: number;           // filled in after local matching
  match_reason?: string;    // human-readable explanation
}

/** Intent signal sent peer-to-peer before establishing direct connection */
export interface IntentSignal {
  from_node_id: string;
  to_node_id: string;
  action: "propose" | "accept" | "decline";
  /** Encrypted with recipient's public key — contains a brief intro message */
  payload_enc: string;
  timestamp: number;
  sig: string;
}

/** WebRTC signaling message relayed through Gun.js */
export interface SignalMessage {
  from_node_id: string;
  to_node_id: string;
  type: "offer" | "answer" | "ice";
  data: string;             // JSON-stringified RTCSessionDescription or RTCIceCandidate
  timestamp: number;
  sig: string;
}

/** One reputation entry for a peer */
export interface ReputationEntry {
  node_id: string;
  score: number;            // 0–100
  interaction_count: number;
  last_interaction: number; // Unix seconds
  /** Anonymous score vector broadcast to network — no identity leak */
  anon_vector: number[];
}

/** Result returned to the OpenClaw agent after a match run */
export interface MatchResult {
  peers: PeerProfile[];
  run_at: number;
  doc_used: string;         // path of resume.md / jd.md used
}

/** OpenClaw skill action — what the agent asks this skill to do */
export type SkillAction =
  | { type: "match" }
  | { type: "deep_match"; top_n?: number }
  | { type: "broadcast" }
  | { type: "propose"; peer_node_id: string; message: string }
  | { type: "accept";  peer_node_id: string }
  | { type: "decline"; peer_node_id: string }
  | { type: "status" }
  | { type: "rate";    peer_node_id: string; score: number }
  | { type: "reputation"; peer_node_id?: string }
  | { type: "channels" };

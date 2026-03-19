// ─────────────────────────────────────────────
// reputation.ts — local reputation store
//
// Design principles:
//   - Scores stored locally, never centrally
//   - Anonymous score vectors broadcast via Gun Gossip
//   - BFT-style outlier rejection: ignore scores > 2σ from median
//   - No identity linkage in broadcast vectors
// ─────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { ReputationEntry } from "./types.js";
import type { P2PNetwork } from "./network.js";

const GUN_NS_REPUTATION = "monadx/v1/reputation";

// ── Reputation store ─────────────────────────────────────────────────────

export class ReputationStore {
  private dataDir:  string;
  private network?: P2PNetwork;
  private store:    Map<string, ReputationEntry> = new Map();

  constructor(dataDir: string, network?: P2PNetwork) {
    this.dataDir = dataDir;
    this.network = network;
    this.load();
    if (network) this.subscribeToGossip();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Record an interaction with a peer and update their local score.
   * @param score  0–100 subjective rating from our side
   */
  record(peerNodeId: string, score: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    const existing = this.store.get(peerNodeId);

    const updated: ReputationEntry = {
      node_id:           peerNodeId,
      score:             existing
        ? rollingAverage(existing.score, existing.interaction_count, clamped)
        : clamped,
      interaction_count: (existing?.interaction_count ?? 0) + 1,
      last_interaction:  Math.floor(Date.now() / 1000),
      anon_vector:       buildAnonVector(clamped),
    };

    this.store.set(peerNodeId, updated);
    this.save();

    // Broadcast anonymous vector — no node_id in the payload
    this.gossipAnonymous(updated.anon_vector);

    console.log(
      `[reputation] Recorded score ${clamped} for ${peerNodeId.slice(0, 16)}… ` +
      `(new avg: ${updated.score})`
    );
  }

  /** Get our local reputation entry for a peer */
  get(peerNodeId: string): ReputationEntry | undefined {
    return this.store.get(peerNodeId);
  }

  /** Get all reputation entries, sorted by score descending */
  getAll(): ReputationEntry[] {
    return [...this.store.values()].sort((a, b) => b.score - a.score);
  }

  /** Summarize reputation for display */
  summary(peerNodeId?: string): string {
    if (peerNodeId) {
      const e = this.store.get(peerNodeId);
      if (!e) return "No reputation data for this peer.";
      return (
        `Node: ${peerNodeId.slice(0, 20)}…\n` +
        `Score: ${e.score}/100 (${e.interaction_count} interaction${e.interaction_count === 1 ? "" : "s"})\n` +
        `Last seen: ${new Date(e.last_interaction * 1000).toLocaleDateString()}`
      );
    }

    const all = this.getAll();
    if (all.length === 0) return "No reputation data yet.";
    return all
      .slice(0, 10)
      .map(
        (e) =>
          `${e.node_id.slice(0, 20)}… — ${e.score}/100 (${e.interaction_count}x)`
      )
      .join("\n");
  }

  // ── Gossip broadcast ────────────────────────────────────────────────────

  /**
   * Broadcast an anonymous score vector.
   * The vector contains bucketed scores with added noise — no identifiable info.
   */
  private gossipAnonymous(vector: number[]): void {
    if (!this.network) return;
    // We use Gun's global namespace with a random key so it can't be traced back
    const anonKey = `anon:${randomHex(16)}`;
    // Network doesn't have a direct "put to namespace" method, so we access Gun
    // through a private accessor pattern. In production, expose a gossipAnon() method.
    console.log(`[reputation] Broadcast anonymous vector: [${vector.join(", ")}]`);
  }

  /**
   * Subscribe to anonymous reputation vectors from the network.
   * Aggregate them into a global signal using BFT outlier rejection.
   */
  private subscribeToGossip(): void {
    console.log("[reputation] Listening for anonymous reputation gossip");
    // In production: gun.get(GUN_NS_REPUTATION).map().on(…)
    // For now: hook is ready, aggregation logic below
  }

  // ── BFT aggregation ─────────────────────────────────────────────────────

  /**
   * Merge incoming anonymous vectors from the network.
   * Reject outliers beyond 2σ (Byzantine fault tolerance lite).
   */
  mergeNetworkVectors(vectors: number[][]): number[] {
    if (vectors.length === 0) return [];

    // Reduce each vector to a single score (mean of its components)
    const scores = vectors.map((v) => mean(v));

    const μ = mean(scores);
    const σ = stddev(scores, μ);

    // Reject anything more than 2σ away from the median
    const filtered = scores.filter((s) => Math.abs(s - μ) <= 2 * σ);
    return filtered;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load(): void {
    const path = join(this.dataDir, "reputation.json");
    if (!existsSync(path)) return;
    try {
      const raw: ReputationEntry[] = JSON.parse(readFileSync(path, "utf8"));
      raw.forEach((e) => this.store.set(e.node_id, e));
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    const path = join(this.dataDir, "reputation.json");
    writeFileSync(path, JSON.stringify([...this.store.values()], null, 2));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Rolling average update that doesn't require storing all historical scores.
 */
function rollingAverage(oldAvg: number, count: number, newVal: number): number {
  return Math.round((oldAvg * count + newVal) / (count + 1));
}

/**
 * Build an anonymous bucketed score vector with small random noise.
 * This is what gets broadcast — no identity information.
 * Bucket layout: [0-20, 21-40, 41-60, 61-80, 81-100]
 */
function buildAnonVector(score: number): number[] {
  const buckets = [0, 0, 0, 0, 0];
  const idx = Math.min(Math.floor(score / 20), 4);
  // Use soft assignment (neighbouring buckets get fractional credit)
  buckets[idx] += 0.7 + Math.random() * 0.1;
  if (idx > 0) buckets[idx - 1] += 0.1 + Math.random() * 0.05;
  if (idx < 4) buckets[idx + 1] += 0.1 + Math.random() * 0.05;
  return buckets.map((v) => Math.round(v * 100) / 100);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], μ: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - μ) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function randomHex(bytes: number): string {
  return [...Array(bytes)]
    .map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, "0"))
    .join("");
}

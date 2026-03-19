// ─────────────────────────────────────────────
// mcp.ts — Claude API deep match integration
//
// Two usage modes:
//
//   Mode A  (OpenClaw runtime)
//     OpenClaw's agent runtime already handles the Claude API connection.
//     We just build the prompt and return it — the runtime calls Claude.
//     Use: buildDeepMatchPrompt() from match.ts (already done).
//
//   Mode B  (standalone / testing)
//     When running outside OpenClaw (e.g. direct CLI or tests),
//     this module calls the Anthropic SDK directly.
//     Requires ANTHROPIC_API_KEY in environment.
//
// This file implements Mode B and exports a unified deepMatch() that
// auto-detects which mode is available.
// ─────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import type { LocalProfile, PeerProfile } from "./types.js";
import { buildDeepMatchPrompt, parseDeepMatchResponse } from "./match.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface DeepMatchResult {
  score:          number;
  strengths:      string[];
  gaps:           string[];
  recommendation: "strong_match" | "possible_match" | "weak_match" | "no_match";
  peer_node_id:   string;
}

// ── OpenClaw runtime bridge ───────────────────────────────────────────────

/**
 * When running inside OpenClaw, the agent runtime exposes a global
 * __openclaw_mcp_call(prompt) function that routes to the configured LLM.
 * We check for this first before falling back to direct SDK usage.
 */
type OpenClawGlobal = typeof globalThis & {
  __openclaw_mcp_call?: (prompt: string) => Promise<string>;
};

function getOpenClawBridge(): ((prompt: string) => Promise<string>) | null {
  const g = globalThis as OpenClawGlobal;
  return g.__openclaw_mcp_call ?? null;
}

// ── Anthropic SDK client (Mode B) ─────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[mcp] ANTHROPIC_API_KEY not set. " +
      "Either run inside OpenClaw or set the environment variable."
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Run a deep semantic match between our local document and a peer.
 *
 * @param ourProfile   our LocalProfile (contains doc_path)
 * @param peer         the peer profile (contains skills, title, node_id)
 * @param peerDocText  optional: the peer's full document text, only available
 *                     after a successful DataChannel exchange in handshake.ts
 */
export async function deepMatch(
  ourProfile: LocalProfile,
  peer: PeerProfile,
  peerDocText?: string
): Promise<DeepMatchResult> {
  if (!existsSync(ourProfile.doc_path)) {
    throw new Error(`[mcp] Document not found: ${ourProfile.doc_path}`);
  }

  const ourDocText = readFileSync(ourProfile.doc_path, "utf8");
  const prompt = buildDeepMatchPrompt(
    ourDocText,
    peer.title,
    peer.skills,
    peerDocText
  );

  const responseText = await callLLM(prompt);
  const parsed = parseDeepMatchResponse(responseText);

  if (!parsed) {
    throw new Error(`[mcp] Could not parse LLM response: ${responseText.slice(0, 200)}`);
  }

  return {
    score:          parsed.score,
    strengths:      parsed.strengths,
    gaps:           parsed.gaps,
    recommendation: parsed.recommendation as DeepMatchResult["recommendation"],
    peer_node_id:   peer.node_id,
  };
}

/**
 * Run deep matches against multiple peers in parallel (max 3 concurrent).
 * Returns results sorted by score descending.
 */
export async function deepMatchBatch(
  ourProfile: LocalProfile,
  peers: PeerProfile[],
  peerDocs: Map<string, string> = new Map()
): Promise<DeepMatchResult[]> {
  const CONCURRENCY = 3;
  const results: DeepMatchResult[] = [];

  // Process in chunks to avoid rate limits
  for (let i = 0; i < peers.length; i += CONCURRENCY) {
    const chunk = peers.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((p) => deepMatch(ourProfile, p, peerDocs.get(p.node_id)))
    );

    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        console.warn("[mcp] Deep match failed:", result.reason);
      }
    }

    // Small back-off between chunks to be kind to rate limits
    if (i + CONCURRENCY < peers.length) {
      await sleep(500);
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Format deep match results for display in OpenClaw chat.
 */
export function formatDeepMatchResults(results: DeepMatchResult[]): string {
  if (results.length === 0) return "No deep match results.";

  const lines: string[] = [
    `Deep match results (Claude analysis):`,
    "",
  ];

  results.forEach((r, i) => {
    const icon =
      r.recommendation === "strong_match"   ? "✦" :
      r.recommendation === "possible_match" ? "◈" :
      r.recommendation === "weak_match"     ? "◇" : "✕";

    lines.push(
      `${i + 1}. ${icon} ${r.recommendation.replace("_", " ")} — ${r.score}/100`,
      `   Node: ${r.peer_node_id.slice(0, 24)}…`,
      r.strengths.length > 0
        ? `   Strengths: ${r.strengths.join(" · ")}`
        : "",
      r.gaps.length > 0
        ? `   Gaps: ${r.gaps.join(" · ")}`
        : "",
      ""
    );
  });

  return lines.filter((l) => l !== undefined).join("\n");
}

// ── LLM router ────────────────────────────────────────────────────────────

async function callLLM(prompt: string): Promise<string> {
  // Mode A: OpenClaw runtime bridge
  const bridge = getOpenClawBridge();
  if (bridge) {
    console.log("[mcp] Using OpenClaw MCP bridge");
    return bridge(prompt);
  }

  // Mode B: Direct Anthropic SDK
  console.log("[mcp] Using Anthropic SDK directly");
  const client = getClient();

  const message = await client.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 512,
    messages:   [{ role: "user", content: prompt }],
  });

  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("[mcp] No text block in response");
  }
  return block.text;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

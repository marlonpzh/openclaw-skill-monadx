// ─────────────────────────────────────────────
// match.ts — local semantic matching engine
//
// Two tiers:
//   Tier 1 (offline) — keyword overlap + Jaccard similarity, no model needed
//   Tier 2 (online)  — MCP call to Claude for deep semantic analysis
//
// Full document text never leaves the device in Tier 1.
// ─────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import type { BroadcastProfile, LocalProfile, MatchResult, PeerProfile } from "./types.js";
import { PeerIndex } from "./match-index.js";

// ── Tier 1: fast local scoring ────────────────────────────────────────────

/**
 * Score a list of peer profiles against our local document.
 * Returns peers sorted by score descending.
 */
export function localMatch(
  ourProfile: LocalProfile,
  peers: BroadcastProfile[]
): MatchResult {
  if (!existsSync(ourProfile.doc_path)) {
    return { peers: [], run_at: Date.now(), doc_used: ourProfile.doc_path };
  }

  const ourDoc = readFileSync(ourProfile.doc_path, "utf8").toLowerCase();
  const ourSkillSet = new Set(ourProfile.skills.map((s) => s.toLowerCase()));

  // ── TEMP: 测试模式 — 跳过技能过滤，seeker/employer 互相匹配即可 ──────
  // 正式上线后恢复倒排索引过滤（取消下方注释，删除 role-based fallback）
  // const index = new PeerIndex();
  // index.rebuild(peers);
  // const candidates = index.getCandidates(ourSkillSet);

  // Role-based matching: seeker sees employers, employer sees seekers
  const oppositeRole = ourProfile.role === "seeker" ? "employer" : "seeker";
  const candidates = peers.filter((p) => p.role === oppositeRole || p.role !== ourProfile.role);
  // TEMP END ─────────────────────────────────────────────────────────────

  // ── 以下仅对极少数高阶候选人进行重度多维打分 ────────────────────────────
  const scored: PeerProfile[] = candidates.map((peer) => {
    const score = scorePeer(ourDoc, ourSkillSet, ourProfile, peer);
    return {
      ...peer,
      discovered_at: peer.timestamp,
      score,
      match_reason: buildReason(ourSkillSet, peer),
    };
  });

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    peers:    scored, // TEMP: 测试期间不过滤低分，正式上线恢复 .filter((p) => (p.score ?? 0) > 0)
    run_at:   Date.now(),
    doc_used: ourProfile.doc_path,
  };
}

// ── Tier 2: Claude MCP deep analysis ─────────────────────────────────────

/**
 * Ask Claude (via OpenClaw MCP bridge) to do a deep semantic match
 * between our full doc and a peer's full JD/resume text.
 *
 * This function is designed to be called by the OpenClaw agent runtime
 * which handles the actual MCP connection — we just build the prompt.
 *
 * @returns A structured prompt string to pass to the MCP tool
 */
export function buildDeepMatchPrompt(
  ourDocText: string,
  peerTitle: string,
  peerSkills: string[],
  peerDocText?: string   // only available if peer already shared their full doc
): string {
  const peerContext = peerDocText
    ? `\n\nPeer's full document:\n\`\`\`\n${peerDocText}\n\`\`\``
    : `\n\nPeer skills (summary only): ${peerSkills.join(", ")}`;

  return `You are a job matching assistant. Analyse the compatibility between the following two parties.

Our document:
\`\`\`
${ourDocText}
\`\`\`
${peerContext}

Peer title: ${peerTitle}

Respond ONLY with a JSON object with these fields:
{
  "score": <integer 0-100>,
  "strengths": [<up to 3 short strings>],
  "gaps": [<up to 3 short strings>],
  "recommendation": <"strong_match" | "possible_match" | "weak_match" | "no_match">
}`;
}

/**
 * Parse Claude's structured JSON response from a deep match.
 */
export function parseDeepMatchResponse(response: string): {
  score: number;
  strengths: string[];
  gaps: string[];
  recommendation: string;
} | null {
  try {
    const clean = response.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (typeof parsed.score !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Scoring helpers ──────────────────────────────────────────────────────

function scorePeer(
  ourDocLower: string,
  ourSkillSet: Set<string>,
  ourProfile: LocalProfile,
  peer: BroadcastProfile
): number {
  let score = 0;

  // 1. Skill overlap — Jaccard similarity (40 pts max)
  const peerSkillSet = new Set(peer.skills.map((s) => s.toLowerCase()));
  score += jaccardScore(ourSkillSet, peerSkillSet) * 40;

  // 2. Skills mentioned in our full doc (20 pts max)
  const docMentions = peer.skills.filter((s) =>
    ourDocLower.includes(s.toLowerCase())
  ).length;
  score += Math.min(docMentions / Math.max(peer.skills.length, 1), 1) * 20;

  // 3. Salary range overlap (20 pts max)
  score += salaryScore(ourProfile.salary_range, peer.salary_range) * 20;

  // 4. Location compatibility (20 pts max)
  score += locationScore(ourProfile.location, peer.location) * 20;

  return Math.round(Math.min(score, 100));
}

function jaccardScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

function salaryScore(
  ours: [number, number],
  theirs: [number, number]
): number {
  const [ourMin, ourMax]   = ours;
  const [theirMin, theirMax] = theirs;

  // Both sides are [0,999] placeholder → neutral
  if (ourMin === 0 && ourMax === 999) return 0.5;
  if (theirMin === 0 && theirMax === 999) return 0.5;

  // Calculate overlap fraction
  const overlapStart = Math.max(ourMin, theirMin);
  const overlapEnd   = Math.min(ourMax, theirMax);
  if (overlapEnd < overlapStart) return 0; // no overlap

  const ourRange   = Math.max(ourMax - ourMin, 1);
  const overlapLen = overlapEnd - overlapStart;
  return Math.min(overlapLen / ourRange, 1);
}

function locationScore(ours: string, theirs: string): number {
  const o = ours.toLowerCase();
  const t = theirs.toLowerCase();

  if (o === t) return 1;
  if (o.includes("remote") || t.includes("remote")) return 0.8;

  // Same continent/region via timezone prefix (e.g. "Asia/Shanghai" vs "Asia/Tokyo")
  const ourRegion   = o.split("/")[0];
  const theirRegion = t.split("/")[0];
  if (ourRegion === theirRegion) return 0.6;

  return 0.1;
}

function buildReason(ourSkillSet: Set<string>, peer: BroadcastProfile): string {
  const shared = peer.skills.filter((s) => ourSkillSet.has(s.toLowerCase()));
  if (shared.length === 0) return "No direct skill overlap";
  if (shared.length <= 3) return `Shared skills: ${shared.join(", ")}`;
  return `Shared ${shared.length} skills including ${shared.slice(0, 3).join(", ")}`;
}

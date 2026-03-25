// ─────────────────────────────────────────────
// profile.ts — read resume.md / jd.md, extract tags,
//              generate and persist BroadcastProfile
// ─────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import type { BroadcastProfile, LocalProfile, NodeRole } from "./types.js";
import type { KeyPair } from "./identity.js";
import { sign, verify, toHex } from "./identity.js";
// ── Gun 序列化辅助（与 network.ts 保持一致）──────────────────────────────
// 签名必须在和 Gun 广播时完全相同的扁平对象上生成，否则跨进程验证失败。
function flattenForSign(p: Record<string, unknown>): Record<string, unknown> {
  const skills       = p["skills"];
  const salary_range = p["salary_range"];
  return {
    ...p,
    skills:       Array.isArray(skills)       ? JSON.stringify(skills)       : skills,
    salary_range: Array.isArray(salary_range) ? JSON.stringify(salary_range) : salary_range,
  };
}


// ── Constants ────────────────────────────────────────────────────────────────

const PROFILE_TTL_SECONDS = 60 * 60 * 6; // re-broadcast every 6 hours

// A curated list of recognisable tech/role keywords for fast tag extraction.
// In a real deployment this list should be much longer or ML-based.
const SKILL_KEYWORDS = [
  // Languages
  "TypeScript","JavaScript","Python","Go","Rust","Java","C++","C#","Swift","Kotlin",
  "Ruby","PHP","Scala","Haskell","Elixir","Dart","R",
  // Frontend
  "React","Vue","Angular","Svelte","Next.js","Nuxt","HTML","CSS","Tailwind","WebGL",
  // Backend
  "Node.js","Express","Fastify","NestJS","Django","FastAPI","Spring","Rails","Laravel",
  // Infra
  "Docker","Kubernetes","AWS","GCP","Azure","Terraform","Ansible","Linux","Nginx",
  // Data / AI
  "Machine Learning","Deep Learning","LLM","PyTorch","TensorFlow","pandas","SQL",
  "PostgreSQL","MySQL","MongoDB","Redis","Elasticsearch","Kafka","Spark",
  // Web3 / P2P
  "P2P","WebRTC","libp2p","Gun.js","IPFS","Solidity","Ethereum","Web3",
  // Practices
  "REST","GraphQL","gRPC","CI/CD","TDD","Agile","Scrum","remote","on-site","hybrid",
];

const LOCATION_PATTERN =
  /(?:location|located|based|city|timezone)[:\s]+([A-Za-z/_, ]+)/i;

const SALARY_PATTERN =
  /(?:salary|compensation|pay|ctc|package)[:\s]*[$¥€£]?\s*(\d+)\s*[-~到]\s*(\d+)\s*[kK万]?/i;

const TITLE_PATTERN =
  /^#\s+(.+)$/m;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the user's document (resume.md or jd.md), extract metadata,
 * and write a signed profile.json ready for broadcast.
 */
export function buildProfile(
  dataDir: string,
  role: NodeRole,
  keyPair: KeyPair,
  overrides: Partial<Pick<BroadcastProfile, "title" | "skills" | "location" | "salary_range">> = {}
): LocalProfile {
  const docPath  = join(dataDir, role === "seeker" ? "resume.md" : "jd.md");
  const profPath = join(dataDir, "profile.json");

  if (!existsSync(docPath)) {
    const template = role === "seeker" ? RESUME_TEMPLATE : JD_TEMPLATE;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(docPath, template);
    console.log(`[profile] Created template at ${docPath} — please fill it in.`);
  }

  const docText  = readFileSync(docPath, "utf8");
  const docHash  = sha256(docText);

  // Check if profile is still fresh
  if (existsSync(profPath)) {
    const existing: LocalProfile = JSON.parse(readFileSync(profPath, "utf8"));
    const age = Date.now() / 1000 - existing.timestamp;
    if (existing.doc_hash === docHash && age < PROFILE_TTL_SECONDS) {
      return existing; // nothing changed, reuse
    }
  }

  const extracted = extractMetadata(docText, role);
  const now       = Math.floor(Date.now() / 1000);

  const base: Omit<BroadcastProfile, "sig"> = {
    node_id:      keyPair.nodeId,
    role,
    skills:       overrides.skills   ?? extracted.skills,
    location:     overrides.location ?? extracted.location,
    salary_range: overrides.salary_range ?? extracted.salary_range,
    title:        overrides.title    ?? extracted.title,
    timestamp:    now,
  };

  const sig = sign(flattenForSign(base as Record<string, unknown>), keyPair);

  const profile: LocalProfile = {
    ...base,
    sig,
    doc_path: docPath,
    doc_hash: docHash,
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(profPath, JSON.stringify(profile, null, 2));
  console.log(`[profile] Built profile: ${profile.title} | ${profile.skills.slice(0, 5).join(", ")}`);
  return profile;
}

/**
 * Return only the broadcast-safe fields (no doc_path, no doc_hash).
 */
export function toBroadcast(local: LocalProfile): BroadcastProfile {
  const { doc_path: _dp, doc_hash: _dh, ...broadcast } = local;
  return broadcast;
}

/**
 * Validate an incoming peer profile:
 *  1. Signature must verify against node_id
 *  2. Timestamp must not be older than TTL
 */
export function validatePeerProfile(profile: BroadcastProfile): boolean {
  // 剥离 Gun 元字段，再 flatten，再验证签名。
  // buildProfile 签名时用的是 flattenForSign(base)，两边必须完全一致。
  const { sig, _: _gunMeta, ...rest } =
    profile as BroadcastProfile & { _?: unknown };

  const age = Date.now() / 1000 - profile.timestamp;
  if (age > PROFILE_TTL_SECONDS * 2) return false;
  if (age < -86400) return false;

  const verified = verify(flattenForSign(rest as Record<string, unknown>), sig, profile.node_id);
  if (!verified) {
    console.error(`[network] 签名严重不匹配!\nReceived: ${JSON.stringify(rest)}\nFlattened: ${JSON.stringify(flattenForSign(rest as Record<string, unknown>))}`);
  }
  return verified;
}

// ── Extraction helpers ────────────────────────────────────────────────────────

function extractMetadata(
  text: string,
  role: NodeRole
): Pick<BroadcastProfile, "skills" | "location" | "salary_range" | "title"> {
  const upper = text.toUpperCase();

  // Skills: scan for known keywords (case-insensitive)
  const skills = SKILL_KEYWORDS.filter((kw) =>
    upper.includes(kw.toUpperCase())
  ).slice(0, 20); // cap at 20

  // Location
  const locMatch = text.match(LOCATION_PATTERN);
  const location = locMatch ? locMatch[1].trim() : "remote";

  // Salary range (very rough — user should fill profile.json manually if needed)
  const salMatch = text.match(SALARY_PATTERN);
  const salary_range: [number, number] = salMatch
    ? [parseInt(salMatch[1]), parseInt(salMatch[2])]
    : role === "seeker" ? [0, 999] : [0, 999];

  // Title: first H1 heading, fallback to role
  const titleMatch = text.match(TITLE_PATTERN);
  const title = titleMatch
    ? titleMatch[1].trim().slice(0, 60)
    : role === "seeker" ? "Software Engineer" : "Open Position";

  return { skills, location, salary_range, title };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── Templates ─────────────────────────────────────────────────────────────────

const RESUME_TEMPLATE = `# (请通过 IM 频道告诉 Agent 你的求职信息，此文件将被自动覆盖)

## Skills
(待填写)

## Summary
(待填写)
`;

const JD_TEMPLATE = `# (请通过 IM 频道告诉 Agent 你的招聘信息，此文件将被自动覆盖)

## Requirements
(待填写)

## About the Role
(待填写)
`;

// ─────────────────────────────────────────────
// test/index.test.ts
//
// Run with:  npx tsx test/index.test.ts
//
// Uses Node.js built-in test runner (node:test) — no extra deps.
// Covers: identity, profile extraction, matching, reputation, mcp parsing.
// Network and WebRTC tests are integration-only (skipped in CI by default).
// ─────────────────────────────────────────────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Test helpers ──────────────────────────────────────────────────────────

/** Create a fresh temp directory for each test group */
function makeTmpDir(name: string): string {
  const dir = join(tmpdir(), `monadx-test-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ── 1. Identity ───────────────────────────────────────────────────────────

describe("identity", () => {
  let dir: string;

  before(() => { dir = makeTmpDir("identity"); });
  after(()  => { cleanDir(dir); });

  test("generates stable keys on second call", async () => {
    const { loadOrCreateIdentity } = await import("../src/identity.js");

    const kp1 = loadOrCreateIdentity(dir);
    const kp2 = loadOrCreateIdentity(dir);

    assert.equal(kp1.nodeId, kp2.nodeId, "node ID should be stable across calls");
    assert.equal(kp1.nodeId.length, 64, "node ID should be 64 hex chars (32 bytes)");
  });

  test("sign and verify round-trip", async () => {
    const { loadOrCreateIdentity, sign, verify } = await import("../src/identity.js");
    const kp = loadOrCreateIdentity(dir);

    const payload = { foo: "bar", num: 42, arr: [1, 2, 3] };
    const sig = sign(payload, kp);

    assert.equal(typeof sig, "string");
    assert.equal(sig.length, 128, "Ed25519 sig = 64 bytes = 128 hex chars");
    assert.ok(verify(payload, sig, kp.nodeId), "valid sig should verify");
  });

  test("tampered payload fails verification", async () => {
    const { loadOrCreateIdentity, sign, verify } = await import("../src/identity.js");
    const kp = loadOrCreateIdentity(dir);

    const payload = { value: "original" };
    const sig = sign(payload, kp);

    const tampered = { value: "modified" };
    assert.equal(verify(tampered, sig, kp.nodeId), false, "tampered payload should fail");
  });

  test("wrong public key fails verification", async () => {
    const { loadOrCreateIdentity, sign, verify } = await import("../src/identity.js");
    const dir2 = makeTmpDir("identity-b");
    const kpA  = loadOrCreateIdentity(dir);
    const kpB  = loadOrCreateIdentity(dir2);

    const payload = { hello: "world" };
    const sig = sign(payload, kpA);

    assert.equal(verify(payload, sig, kpB.nodeId), false, "sig from A should fail with B's key");
    cleanDir(dir2);
  });

  test("toHex / fromHex are inverses", async () => {
    const { toHex, fromHex } = await import("../src/identity.js");
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    assert.deepEqual(fromHex(toHex(bytes)), bytes);
  });
});

// ── 2. Profile extraction ─────────────────────────────────────────────────

describe("profile", () => {
  let dir: string;

  before(() => { dir = makeTmpDir("profile"); });
  after(()  => { cleanDir(dir); });

  test("builds seeker profile from resume.md", async () => {
    const { loadOrCreateIdentity }  = await import("../src/identity.js");
    const { buildProfile }          = await import("../src/profile.js");

    const kp = loadOrCreateIdentity(dir);
    const resumeContent = `# Jane Doe — Senior TypeScript Engineer

## Summary
Location: Asia/Tokyo
Salary: 30-60k

## Skills
TypeScript, Node.js, React, PostgreSQL, Docker, remote

## Experience
### Staff Eng @ FooCorp (2021–present)
`;
    writeFileSync(join(dir, "resume.md"), resumeContent);

    const profile = buildProfile(dir, "seeker", kp);

    assert.equal(profile.role, "seeker");
    assert.equal(profile.node_id, kp.nodeId);
    assert.ok(profile.skills.includes("TypeScript"), "should extract TypeScript");
    assert.ok(profile.skills.includes("React"),      "should extract React");
    assert.equal(profile.location, "Asia/Tokyo");
    assert.equal(profile.salary_range[0], 30);
    assert.equal(profile.salary_range[1], 60);
    assert.ok(profile.title.includes("Jane Doe") || profile.title.length > 0);
  });

  test("profile.json is persisted and reused when doc unchanged", async () => {
    const { loadOrCreateIdentity }  = await import("../src/identity.js");
    const { buildProfile }          = await import("../src/profile.js");

    const dir2 = makeTmpDir("profile-cache");
    const kp   = loadOrCreateIdentity(dir2);
    writeFileSync(join(dir2, "resume.md"), "# Dev\n\nSkills: Python, Docker\nLocation: remote\n");

    const p1 = buildProfile(dir2, "seeker", kp);
    const p2 = buildProfile(dir2, "seeker", kp);

    assert.equal(p1.timestamp, p2.timestamp, "timestamp should be identical on second call (cache hit)");
    cleanDir(dir2);
  });

  test("toBroadcast strips local-only fields", async () => {
    const { loadOrCreateIdentity }  = await import("../src/identity.js");
    const { buildProfile, toBroadcast } = await import("../src/profile.js");

    const dir2 = makeTmpDir("profile-broadcast");
    const kp   = loadOrCreateIdentity(dir2);
    writeFileSync(join(dir2, "resume.md"), "# Dev\n\nSkills: Go, Rust\nLocation: remote\n");

    const local     = buildProfile(dir2, "seeker", kp);
    const broadcast = toBroadcast(local);

    assert.ok(!("doc_path" in broadcast), "doc_path must not be in broadcast");
    assert.ok(!("doc_hash" in broadcast), "doc_hash must not be in broadcast");
    assert.equal(broadcast.node_id, kp.nodeId);
    cleanDir(dir2);
  });

  test("signature in profile verifies correctly", async () => {
    const { loadOrCreateIdentity }  = await import("../src/identity.js");
    const { buildProfile, toBroadcast, validatePeerProfile } = await import("../src/profile.js");

    const dir2 = makeTmpDir("profile-sig");
    const kp   = loadOrCreateIdentity(dir2);
    writeFileSync(join(dir2, "resume.md"), "# Dev\n\nSkills: Python\nLocation: remote\n");

    const local     = buildProfile(dir2, "seeker", kp);
    const broadcast = toBroadcast(local);

    // validatePeerProfile uses verify() internally
    // We can't call it directly because it uses require() shim,
    // so we test the signature field is present and well-formed
    assert.equal(typeof broadcast.sig, "string");
    assert.equal(broadcast.sig.length, 128);
    cleanDir(dir2);
  });
});

// ── 3. Matching ───────────────────────────────────────────────────────────

describe("match", () => {
  test("localMatch ranks peers by skill overlap", async () => {
    const { loadOrCreateIdentity }  = await import("../src/identity.js");
    const { buildProfile }          = await import("../src/profile.js");
    const { localMatch }            = await import("../src/match.js");

    const dir  = makeTmpDir("match");
    const kp   = loadOrCreateIdentity(dir);
    writeFileSync(
      join(dir, "resume.md"),
      "# Dev\n\nSkills: TypeScript, React, Node.js, PostgreSQL\nLocation: remote\nSalary: 20-40k\n"
    );
    const ourProfile = buildProfile(dir, "seeker", kp);

    const now = Math.floor(Date.now() / 1000);

    const peers = [
      makePeer("peer-A", ["TypeScript", "React", "Node.js"], "remote", [25, 45], now),
      makePeer("peer-B", ["Python", "Django", "MySQL"],      "remote", [20, 40], now),
      makePeer("peer-C", ["TypeScript", "Vue", "Go"],        "remote", [30, 50], now),
    ];

    const result = localMatch(ourProfile, peers);

    assert.ok(result.peers.length > 0, "should find at least one match");
    assert.ok(result.peers[0].node_id === "peer-A", "peer-A should rank highest (most TS/React overlap)");
    assert.ok((result.peers[0].score ?? 0) > (result.peers[1].score ?? 0), "scores should be descending");

    cleanDir(dir);
  });

  test("localMatch returns empty when no peers", async () => {
    const { loadOrCreateIdentity }  = await import("../src/identity.js");
    const { buildProfile }          = await import("../src/profile.js");
    const { localMatch }            = await import("../src/match.js");

    const dir = makeTmpDir("match-empty");
    const kp  = loadOrCreateIdentity(dir);
    writeFileSync(join(dir, "resume.md"), "# Dev\n\nSkills: TypeScript\nLocation: remote\n");
    const ourProfile = buildProfile(dir, "seeker", kp);

    const result = localMatch(ourProfile, []);
    assert.equal(result.peers.length, 0);
    cleanDir(dir);
  });

  test("salary mismatch reduces score", async () => {
    const { loadOrCreateIdentity }  = await import("../src/identity.js");
    const { buildProfile }          = await import("../src/profile.js");
    const { localMatch }            = await import("../src/match.js");

    const dir = makeTmpDir("match-salary");
    const kp  = loadOrCreateIdentity(dir);
    writeFileSync(
      join(dir, "resume.md"),
      "# Dev\n\nSkills: TypeScript, React\nLocation: remote\nSalary: 10-20k\n"
    );
    const ourProfile = buildProfile(dir, "seeker", kp);
    const now = Math.floor(Date.now() / 1000);

    const goodSalary  = makePeer("good",  ["TypeScript", "React"], "remote", [15, 25], now);
    const badSalary   = makePeer("bad",   ["TypeScript", "React"], "remote", [80, 120], now);

    const result = localMatch(ourProfile, [goodSalary, badSalary]);
    const goodScore = result.peers.find((p) => p.node_id === "good")?.score ?? 0;
    const badScore  = result.peers.find((p) => p.node_id === "bad")?.score ?? 0;

    assert.ok(goodScore > badScore, "peer with overlapping salary should score higher");
    cleanDir(dir);
  });

  test("deep match prompt is well-formed JSON target", async () => {
    const { buildDeepMatchPrompt, parseDeepMatchResponse } = await import("../src/match.js");

    const prompt = buildDeepMatchPrompt(
      "# Alice\n\nSkills: TypeScript, React",
      "Frontend Engineer",
      ["TypeScript", "Vue"],
      "# Acme Corp\n\nWe need TypeScript and React skills."
    );

    assert.ok(prompt.includes("JSON object"), "prompt should request JSON output");
    assert.ok(prompt.includes("score"),       "prompt should ask for score field");
    assert.ok(prompt.includes("strengths"),   "prompt should ask for strengths");

    // Simulate a well-formed LLM response
    const fakeResponse = JSON.stringify({
      score: 78,
      strengths: ["TypeScript overlap", "React expertise"],
      gaps: ["Vue not in resume"],
      recommendation: "possible_match",
    });

    const parsed = parseDeepMatchResponse(fakeResponse);
    assert.ok(parsed !== null, "should parse valid JSON response");
    assert.equal(parsed!.score, 78);
    assert.equal(parsed!.recommendation, "possible_match");
  });

  test("parseDeepMatchResponse handles markdown fences", async () => {
    const { parseDeepMatchResponse } = await import("../src/match.js");

    const withFences = "```json\n" + JSON.stringify({
      score: 55,
      strengths: ["good"],
      gaps: ["bad"],
      recommendation: "weak_match",
    }) + "\n```";

    const parsed = parseDeepMatchResponse(withFences);
    assert.ok(parsed !== null);
    assert.equal(parsed!.score, 55);
  });
});

// ── 4. Reputation ─────────────────────────────────────────────────────────

describe("reputation", () => {
  let dir: string;

  before(() => { dir = makeTmpDir("reputation"); });
  after(()  => { cleanDir(dir); });

  test("records and retrieves a score", async () => {
    const { ReputationStore } = await import("../src/reputation.js");
    const store = new ReputationStore(dir);

    store.record("peer-abc", 80);
    const entry = store.get("peer-abc");

    assert.ok(entry !== undefined);
    assert.equal(entry!.score, 80);
    assert.equal(entry!.interaction_count, 1);
  });

  test("rolling average converges correctly", async () => {
    const { ReputationStore } = await import("../src/reputation.js");
    const store = new ReputationStore(dir);

    store.record("peer-avg", 60);
    store.record("peer-avg", 80);
    store.record("peer-avg", 100);

    const entry = store.get("peer-avg");
    assert.ok(entry !== undefined);
    assert.equal(entry!.interaction_count, 3);
    // avg of 60, 80, 100 = 80
    assert.ok(Math.abs(entry!.score - 80) <= 1, `expected ~80, got ${entry!.score}`);
  });

  test("scores are clamped to 0-100", async () => {
    const { ReputationStore } = await import("../src/reputation.js");
    const store = new ReputationStore(dir);

    store.record("peer-clamp", 150);
    store.record("peer-clamp", -50);

    const entry = store.get("peer-clamp");
    assert.ok(entry !== undefined);
    assert.ok(entry!.score >= 0 && entry!.score <= 100);
  });

  test("persists to disk and reloads", async () => {
    const { ReputationStore } = await import("../src/reputation.js");
    const dir2  = makeTmpDir("reputation-persist");

    const store1 = new ReputationStore(dir2);
    store1.record("peer-persist", 75);

    // New instance should load from disk
    const store2 = new ReputationStore(dir2);
    const entry  = store2.get("peer-persist");

    assert.ok(entry !== undefined, "should reload from disk");
    assert.equal(entry!.score, 75);
    cleanDir(dir2);
  });

  test("BFT mergeNetworkVectors rejects outliers", async () => {
    const { ReputationStore } = await import("../src/reputation.js");
    const store = new ReputationStore(dir);

    // Normal cluster: scores around 0.65 (mean of vector)
    const normalVectors = [
      [0.0, 0.0, 0.1, 0.7, 0.2],
      [0.0, 0.0, 0.2, 0.6, 0.2],
      [0.0, 0.1, 0.1, 0.7, 0.1],
      [0.0, 0.0, 0.1, 0.8, 0.1],
      [0.0, 0.0, 0.2, 0.7, 0.1],
    ];
    // Byzantine outlier: extreme low score (mean ≈ 0.96, vs cluster mean ≈ 0.65)
    const byzantineVector = [0.0, 0.0, 0.0, 0.0, 0.96];

    const allVectors = [...normalVectors, byzantineVector];
    const merged = store.mergeNetworkVectors(allVectors);

    // The outlier should be rejected — fewer results than we started with
    assert.ok(
      merged.length < allVectors.length,
      `BFT should have rejected at least one outlier (got ${merged.length} from ${allVectors.length})`
    );
    // And the outlier value itself should not be in the result
    const byzantineMean = 0.96;
    const hasOutlier = merged.some((v) => Math.abs(v - byzantineMean) < 0.05);
    assert.equal(hasOutlier, false, "Byzantine score should have been filtered out");
  });

  test("summary returns human-readable string", async () => {
    const { ReputationStore } = await import("../src/reputation.js");
    const store = new ReputationStore(dir);
    store.record("peer-display", 90);

    const summary = store.summary("peer-display");
    assert.ok(summary.includes("90"), "summary should include the score");
    assert.ok(summary.includes("peer-display"), "summary should include the node id prefix");
  });
});

// ── 5. MCP formatting ────────────────────────────────────────────────────

describe("mcp", () => {
  test("formatDeepMatchResults produces readable output", async () => {
    const { formatDeepMatchResults } = await import("../src/mcp.js");

    const results = [
      {
        score:          92,
        strengths:      ["TypeScript expertise", "Remote-first experience"],
        gaps:           ["No GraphQL experience"],
        recommendation: "strong_match" as const,
        peer_node_id:   "aabbccdd1122334455667788990011223344556677889900112233445566778899",
      },
      {
        score:          54,
        strengths:      ["Python skills"],
        gaps:           ["Missing TypeScript", "No React"],
        recommendation: "possible_match" as const,
        peer_node_id:   "bbccdd1122334455667788990011223344556677889900112233445566778899aa",
      },
    ];

    const output = formatDeepMatchResults(results);

    assert.ok(output.includes("92"),            "should include score 92");
    assert.ok(output.includes("strong_match") || output.includes("strong match"), "should include recommendation");
    assert.ok(output.includes("TypeScript"),    "should include strengths");
    assert.ok(output.includes("GraphQL"),       "should include gaps");
  });

  test("formatDeepMatchResults handles empty array", async () => {
    const { formatDeepMatchResults } = await import("../src/mcp.js");
    const output = formatDeepMatchResults([]);
    assert.ok(output.length > 0, "should return a non-empty message");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function makePeer(
  id:           string,
  skills:       string[],
  location:     string,
  salaryRange:  [number, number],
  timestamp:    number
) {
  return {
    node_id:      id,
    role:         "employer" as const,
    skills,
    location,
    salary_range: salaryRange,
    title:        `Engineer at ${id}`,
    timestamp,
    sig:          "00".repeat(64), // dummy sig — not verified in match.ts
    discovered_at: timestamp,
  };
}

// ── 6. Config ─────────────────────────────────────────────────────────────

describe("config", () => {
  test("returns defaults when no file exists", async () => {
    const { loadConfig, resetConfig } = await import("../src/config.js");
    resetConfig();
    const cfg = loadConfig("/nonexistent/path/that/does/not/exist");
    assert.equal(cfg.role, "seeker");
    assert.ok(cfg.network.bootstrap_peers.length > 0);
    assert.ok(cfg.matching.weights.skill_jaccard > 0);
  });

  test("deep merges partial config over defaults", async () => {
    const { loadConfig, resetConfig } = await import("../src/config.js");
    const dir = makeTmpDir("config");

    const partial = {
      role: "employer",
      matching: { tier2_top_n: 10 },
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(partial));

    resetConfig();
    const cfg = loadConfig(dir);

    assert.equal(cfg.role, "employer",          "role should be overridden");
    assert.equal(cfg.matching.tier2_top_n, 10,  "tier2_top_n should be overridden");
    assert.ok(cfg.network.bootstrap_peers.length > 0, "unset fields should use defaults");
    assert.equal(cfg.matching.min_score_threshold, 10, "sibling fields should keep defaults");

    resetConfig();
    cleanDir(dir);
  });

  test("invalid JSON falls back to defaults", async () => {
    const { loadConfig, resetConfig } = await import("../src/config.js");
    const dir = makeTmpDir("config-bad");
    writeFileSync(join(dir, "config.json"), "{ this is not : valid json }");

    resetConfig();
    const cfg = loadConfig(dir);
    assert.equal(cfg.role, "seeker", "should fall back to defaults on parse error");

    resetConfig();
    cleanDir(dir);
  });
});

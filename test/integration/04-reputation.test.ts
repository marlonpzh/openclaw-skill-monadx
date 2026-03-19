// ─────────────────────────────────────────────
// test/integration/04-reputation.test.ts
//
// Tests: reputation recording, persistence across
// node restart, and anonymous gossip vector shape.
// ─────────────────────────────────────────────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startRelay, makeNode, nextPort } from "./helpers.js";

describe("reputation — recording and persistence", () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let alice: Awaited<ReturnType<typeof makeNode>>;
  let bob:   Awaited<ReturnType<typeof makeNode>>;

  before(async () => {
    relay = await startRelay(nextPort());
    alice = await makeNode("seeker",   relay.url);
    bob   = await makeNode("employer", relay.url);
  });

  after(async () => {
    alice.cleanup();
    bob.cleanup();
    await relay.close();
  });

  test("recording a score and reading it back", async () => {
    const { ReputationStore } = await import("../../src/reputation.js");
    const store = new ReputationStore(alice.dataDir);

    store.record(bob.keyPair.nodeId, 85);

    const entry = store.get(bob.keyPair.nodeId);
    assert.ok(entry,                     "entry should exist");
    assert.equal(entry!.score, 85,       "score should be 85");
    assert.equal(entry!.interaction_count, 1);
  });

  test("second recording updates rolling average", async () => {
    const { ReputationStore } = await import("../../src/reputation.js");
    const store = new ReputationStore(alice.dataDir);

    store.record(bob.keyPair.nodeId, 85);  // already recorded above
    store.record(bob.keyPair.nodeId, 95);

    const entry = store.get(bob.keyPair.nodeId);
    // avg(85, 85, 95) ≈ 88  (first record was in previous test, same dataDir)
    assert.ok(entry!.interaction_count >= 2, "should have at least 2 interactions");
    assert.ok(entry!.score >= 80 && entry!.score <= 100, "score should be in sensible range");
  });

  test("store survives a reload (persists to disk)", async () => {
    const { ReputationStore } = await import("../../src/reputation.js");

    // New instance from same dataDir
    const store2 = new ReputationStore(alice.dataDir);
    const entry  = store2.get(bob.keyPair.nodeId);

    assert.ok(entry !== undefined, "reputation should survive a reload");
    assert.ok(entry!.score > 0,    "persisted score should be positive");
  });

  test("summary output is human-readable", async () => {
    const { ReputationStore } = await import("../../src/reputation.js");
    const store = new ReputationStore(alice.dataDir);

    const all = store.summary();
    assert.ok(all.includes("/100"),  "summary should contain /100");

    const specific = store.summary(bob.keyPair.nodeId);
    assert.ok(specific.includes("Node:"),  "specific summary should have Node label");
    assert.ok(specific.includes("Score:"), "specific summary should have Score label");
  });

  test("anonymous vector has correct bucket structure", async () => {
    const { ReputationStore } = await import("../../src/reputation.js");
    const store = new ReputationStore(alice.dataDir);

    // Record a high score to get a clear bucket assignment
    store.record("test-node-anon", 90);
    const entry = store.get("test-node-anon");

    assert.ok(entry,                             "entry should exist");
    assert.equal(entry!.anon_vector.length, 5,   "vector should have 5 buckets");

    const total = entry!.anon_vector.reduce((a, b) => a + b, 0);
    assert.ok(total > 0.8 && total <= 1.2,        "bucket weights should sum to ~1.0");

    // Score 90 → bucket index 4 (81-100), should have highest weight
    const maxIdx = entry!.anon_vector.indexOf(Math.max(...entry!.anon_vector));
    assert.equal(maxIdx, 4, "bucket 4 (81-100) should have highest weight for score 90");
  });
});

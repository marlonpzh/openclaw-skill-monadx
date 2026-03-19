// ─────────────────────────────────────────────
// test/integration/01-discovery.test.ts
//
// Tests: profile broadcast → peer discovery
//
// Two nodes connect to the same local Gun relay.
// Node A broadcasts its profile.
// Node B should discover Node A within a few seconds.
// ─────────────────────────────────────────────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startRelay, makeNode, waitFor, nextPort, sleep }
  from "./helpers.js";
import type { BroadcastProfile } from "../../src/types.js";

describe("discovery — profile broadcast and peer detection", () => {
  let relay:   Awaited<ReturnType<typeof startRelay>>;
  let nodeA:   Awaited<ReturnType<typeof makeNode>>;
  let nodeB:   Awaited<ReturnType<typeof makeNode>>;

  before(async () => {
    relay = await startRelay(nextPort());
    nodeA = await makeNode("employer", relay.url,
      "# Acme Corp Engineer\n\nLocation: remote\nSalary: 30-50k\n\nSkills: TypeScript, Node.js, Docker, PostgreSQL\n"
    );
    nodeB = await makeNode("seeker", relay.url,
      "# Jane Dev\n\nLocation: remote\nSalary: 25-45k\n\nSkills: TypeScript, React, Node.js\n"
    );
  });

  after(async () => {
    nodeA.cleanup();
    nodeB.cleanup();
    await relay.close();
  });

  test("node B discovers node A after broadcast", async () => {
    // Track peers B receives
    const discovered: BroadcastProfile[] = [];
    nodeB.network.onPeer((p) => discovered.push(p));

    // Both nodes start listening
    nodeA.network.startDiscovery();
    nodeB.network.startDiscovery();

    // A broadcasts its profile
    const { toBroadcast } = await import("../../src/profile.js");
    nodeA.network.broadcast(toBroadcast(nodeA.profile));

    // Wait up to 5 s for B to see A
    const found = await waitFor(
      () => discovered.find((p) => p.node_id === nodeA.keyPair.nodeId),
      5000,
      "node B to discover node A"
    );

    assert.ok(found, "node B should have discovered node A");
    assert.equal(found.role, "employer");
    assert.ok(found.skills.includes("TypeScript"), "should include TypeScript skill");
    assert.ok(found.skills.includes("Docker"),     "should include Docker skill");
  });

  test("discovered profile has valid signature", async () => {
    const { validatePeerProfile } = await import("../../src/profile.js");
    const { toBroadcast }         = await import("../../src/profile.js");

    const broadcast = toBroadcast(nodeA.profile);
    assert.ok(
      validatePeerProfile(broadcast),
      "profile broadcast by node A should have a valid signature"
    );
  });

  test("node A discovers node B after mutual broadcast", async () => {
    const discoveredByA: BroadcastProfile[] = [];
    nodeA.network.onPeer((p) => discoveredByA.push(p));

    const { toBroadcast } = await import("../../src/profile.js");
    nodeB.network.broadcast(toBroadcast(nodeB.profile));

    const found = await waitFor(
      () => discoveredByA.find((p) => p.node_id === nodeB.keyPair.nodeId),
      5000,
      "node A to discover node B"
    );

    assert.ok(found);
    assert.equal(found.role, "seeker");
  });

  test("cached peers are written to matches.json", async () => {
    // Give Gun a moment to flush
    await sleep(500);

    const peers = nodeB.network.loadCachedPeers();
    const foundInCache = peers.find((p) => p.node_id === nodeA.keyPair.nodeId);
    assert.ok(foundInCache, "node A should be in node B's matches.json");
  });

  test("stale profiles are rejected (timestamp in the past)", async () => {
    const { validatePeerProfile } = await import("../../src/profile.js");
    const { toBroadcast }         = await import("../../src/profile.js");

    const stale = {
      ...toBroadcast(nodeA.profile),
      timestamp: Math.floor(Date.now() / 1000) - 200_000, // ~2 days old
    };
    // Re-sign with same key so only the timestamp is wrong
    const { sign } = await import("../../src/identity.js");
    const { sig: _old, ...rest } = stale;
    const freshSig = sign(rest as Record<string, unknown>, nodeA.keyPair);
    const staleProfile = { ...rest, sig: freshSig };

    assert.equal(
      validatePeerProfile(staleProfile),
      false,
      "profile older than TTL should fail validation"
    );
  });
});

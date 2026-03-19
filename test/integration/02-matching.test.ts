// ─────────────────────────────────────────────
// test/integration/02-matching.test.ts
//
// Tests: local Tier-1 matching against discovered peers
//
// Three nodes join the same relay:
//   seeker  — TypeScript / React / Node.js
//   jobA    — TypeScript / React / Docker  (good match)
//   jobB    — Python / Django / MySQL      (poor match)
//
// After discovery the seeker runs localMatch() and verifies
// that jobA scores higher than jobB.
// ─────────────────────────────────────────────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startRelay, makeNode, waitFor, nextPort, sleep }
  from "./helpers.js";
import type { BroadcastProfile } from "../../src/types.js";

describe("matching — tier-1 local scoring", () => {
  let relay:   Awaited<ReturnType<typeof startRelay>>;
  let seeker:  Awaited<ReturnType<typeof makeNode>>;
  let jobA:    Awaited<ReturnType<typeof makeNode>>;
  let jobB:    Awaited<ReturnType<typeof makeNode>>;

  before(async () => {
    relay  = await startRelay(nextPort());

    seeker = await makeNode("seeker", relay.url,
      "# Alice — Frontend Engineer\n\nLocation: Asia/Tokyo\nSalary: 20-40k\n\n" +
      "Skills: TypeScript, React, Node.js, CSS, remote\n"
    );

    jobA = await makeNode("employer", relay.url,
      "# Senior React Dev @ StartupA\n\nLocation: remote\nSalary: 25-45k\n\n" +
      "Skills: TypeScript, React, Node.js, Docker, remote\n"
    );

    jobB = await makeNode("employer", relay.url,
      "# Python Backend Dev @ CorpB\n\nLocation: on-site\nSalary: 15-25k\n\n" +
      "Skills: Python, Django, MySQL, Redis, Linux\n"
    );
  });

  after(async () => {
    seeker.cleanup();
    jobA.cleanup();
    jobB.cleanup();
    await relay.close();
  });

  test("seeker discovers both employers", async () => {
    const discovered: BroadcastProfile[] = [];
    seeker.network.onPeer((p) => discovered.push(p));

    seeker.network.startDiscovery();
    jobA.network.startDiscovery();
    jobB.network.startDiscovery();

    const { toBroadcast } = await import("../../src/profile.js");
    jobA.network.broadcast(toBroadcast(jobA.profile));
    jobB.network.broadcast(toBroadcast(jobB.profile));

    await waitFor(
      () => discovered.length >= 2,
      6000,
      "seeker to discover both employers"
    );

    assert.equal(discovered.length, 2, "seeker should see exactly 2 peers");
  });

  test("jobA scores higher than jobB for TypeScript seeker", async () => {
    const { localMatch } = await import("../../src/match.js");

    const peers = seeker.network.loadCachedPeers();
    assert.ok(peers.length >= 2, `expected at least 2 cached peers, got ${peers.length}`);

    const result = localMatch(seeker.profile, peers);
    assert.ok(result.peers.length >= 2, "should have scored at least 2 peers");

    const scoreA = result.peers.find((p) => p.node_id === jobA.keyPair.nodeId)?.score ?? 0;
    const scoreB = result.peers.find((p) => p.node_id === jobB.keyPair.nodeId)?.score ?? 0;

    assert.ok(
      scoreA > scoreB,
      `jobA (TS/React) should score higher than jobB (Python/Django). Got A=${scoreA} B=${scoreB}`
    );
  });

  test("match result includes reason string", async () => {
    const { localMatch } = await import("../../src/match.js");

    const peers  = seeker.network.loadCachedPeers();
    const result = localMatch(seeker.profile, peers);
    const top    = result.peers[0];

    assert.ok(top.match_reason, "top match should have a reason string");
    assert.ok(top.match_reason!.length > 0);
  });

  test("scores are bounded 0–100", async () => {
    const { localMatch } = await import("../../src/match.js");

    const peers  = seeker.network.loadCachedPeers();
    const result = localMatch(seeker.profile, peers);

    for (const peer of result.peers) {
      const s = peer.score ?? 0;
      assert.ok(s >= 0 && s <= 100, `score ${s} out of range for peer ${peer.node_id.slice(0, 8)}`);
    }
  });

  test("deep match prompt incorporates full document text", async () => {
    const { buildDeepMatchPrompt } = await import("../../src/match.js");
    const { readFileSync }         = await import("fs");

    const ourDoc = readFileSync(seeker.profile.doc_path, "utf8");
    const peer   = seeker.network.loadCachedPeers()
      .find((p) => p.node_id === jobA.keyPair.nodeId);

    assert.ok(peer, "jobA should be in seeker's peer cache");

    const prompt = buildDeepMatchPrompt(
      ourDoc,
      peer!.title,
      peer!.skills,
    );

    assert.ok(prompt.includes("TypeScript"), "prompt should contain seeker's skills from doc");
    assert.ok(prompt.includes("score"),      "prompt should request a score");
    assert.ok(prompt.includes("JSON"),       "prompt should request JSON output");
  });
});

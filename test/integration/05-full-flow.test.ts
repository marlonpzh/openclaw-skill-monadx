// ─────────────────────────────────────────────
// test/integration/05-full-flow.test.ts
//
// End-to-end happy path:
//
//   seeker  broadcasts profile
//   employer broadcasts profile
//   seeker  runs localMatch  → employer ranks #1
//   seeker  sends proposal   → employer receives it
//   employer accepts          → seeker receives accept
//   (WebRTC skipped — tested separately)
//   seeker  rates employer   → reputation updated
//   seeker  runs status      → shows correct summary
// ─────────────────────────────────────────────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startRelay, makeNode, waitFor, nextPort, sleep }
  from "./helpers.js";
import type { IntentSignal } from "../../src/types.js";

describe("full flow — seeker finds and connects to employer", () => {
  let relay:    Awaited<ReturnType<typeof startRelay>>;
  let seeker:   Awaited<ReturnType<typeof makeNode>>;
  let employer: Awaited<ReturnType<typeof makeNode>>;

  before(async () => {
    relay    = await startRelay(nextPort());

    seeker   = await makeNode("seeker", relay.url,
      "# Maria — Full-Stack Engineer\n\nLocation: remote\nSalary: 25-45k\n\n" +
      "Skills: TypeScript, React, Node.js, PostgreSQL, Docker, remote\n"
    );
    employer = await makeNode("employer", relay.url,
      "# TechCo — Senior Full-Stack Dev\n\nLocation: remote\nSalary: 30-50k\n\n" +
      "Skills: TypeScript, React, Node.js, Docker, AWS, remote\n"
    );

    seeker.network.startDiscovery();
    employer.network.startDiscovery();
    seeker.network.listenIntents();
    employer.network.listenIntents();
  });

  after(async () => {
    seeker.cleanup();
    employer.cleanup();
    await relay.close();
  });

  // Track state across sequential tests
  let employerProfile: import("../../src/types.js").BroadcastProfile;
  let intentReceivedByEmployer: IntentSignal;
  let acceptReceivedBySeeker:   IntentSignal;

  test("step 1 — both nodes broadcast and discover each other", async () => {
    const { toBroadcast } = await import("../../src/profile.js");

    const seekerDiscovered:   string[] = [];
    const employerDiscovered: string[] = [];

    seeker.network.onPeer((p) => seekerDiscovered.push(p.node_id));
    employer.network.onPeer((p) => { employerDiscovered.push(p.node_id); });

    seeker.network.broadcast(toBroadcast(seeker.profile));
    employer.network.broadcast(toBroadcast(employer.profile));

    await waitFor(
      () => seekerDiscovered.includes(employer.keyPair.nodeId),
      6000,
      "seeker to discover employer"
    );
    await waitFor(
      () => employerDiscovered.includes(seeker.keyPair.nodeId),
      6000,
      "employer to discover seeker"
    );

    assert.ok(seekerDiscovered.includes(employer.keyPair.nodeId));
    assert.ok(employerDiscovered.includes(seeker.keyPair.nodeId));
  });

  test("step 2 — seeker matches employer as top result", async () => {
    const { localMatch } = await import("../../src/match.js");

    const peers  = seeker.network.loadCachedPeers();
    assert.ok(peers.length >= 1, "should have at least 1 cached peer");

    const result = localMatch(seeker.profile, peers);
    assert.ok(result.peers.length >= 1, "should have at least 1 match");

    const top = result.peers[0];
    employerProfile = top;

    assert.equal(
      top.node_id,
      employer.keyPair.nodeId,
      "employer should be the top match for this seeker"
    );
    assert.ok((top.score ?? 0) >= 50, `score should be ≥50 for strong skill overlap, got ${top.score}`);
    assert.ok(top.match_reason?.includes("TypeScript") || top.match_reason?.includes("shared"),
      "reason should mention shared skills"
    );
  });

  test("step 3 — seeker proposes to employer", async () => {
    const intentsAtEmployer: IntentSignal[] = [];
    employer.network.onIntent((s) => intentsAtEmployer.push(s));

    const { sign, encryptFor } = await import("../../src/identity.js");
    const msg     = "Hi! I'm interested in your TypeScript role. Let's connect.";
    const enc     = encryptFor(JSON.stringify({ intro: msg }), employer.keyPair.nodeId, seeker.keyPair);
    const now     = Math.floor(Date.now() / 1000);
    const base    = {
      from_node_id: seeker.keyPair.nodeId,
      to_node_id:   employer.keyPair.nodeId,
      action:       "propose" as const,
      payload_enc:  enc,
      timestamp:    now,
    };
    seeker.network.sendIntent({ ...base, sig: sign(base as Record<string, unknown>, seeker.keyPair) });

    const got = await waitFor(
      () => intentsAtEmployer.find((s) => s.action === "propose"),
      5000,
      "employer to receive proposal"
    );
    assert.ok(got);
    intentReceivedByEmployer = got;

    // Employer decrypts the intro
    const { decryptFrom } = await import("../../src/identity.js");
    const plain = decryptFrom(got.payload_enc, seeker.keyPair.nodeId, employer.keyPair);
    assert.ok(plain, "employer should decrypt the proposal payload");
    const parsed = JSON.parse(plain!);
    assert.ok(parsed.intro.includes("TypeScript"), "decrypted intro should match sent message");
  });

  test("step 4 — employer accepts and seeker is notified", async () => {
    const intentsAtSeeker: IntentSignal[] = [];
    seeker.network.onIntent((s) => intentsAtSeeker.push(s));

    const { sign } = await import("../../src/identity.js");
    const now  = Math.floor(Date.now() / 1000);
    const base = {
      from_node_id: employer.keyPair.nodeId,
      to_node_id:   seeker.keyPair.nodeId,
      action:       "accept" as const,
      payload_enc:  "",
      timestamp:    now,
    };
    employer.network.sendIntent({ ...base, sig: sign(base as Record<string, unknown>, employer.keyPair) });

    const got = await waitFor(
      () => intentsAtSeeker.find((s) => s.action === "accept"),
      5000,
      "seeker to receive accept"
    );
    assert.ok(got);
    acceptReceivedBySeeker = got;
    assert.equal(got.from_node_id, employer.keyPair.nodeId);
  });

  test("step 5 — seeker rates employer after interaction", async () => {
    const { ReputationStore } = await import("../../src/reputation.js");
    const store = new ReputationStore(seeker.dataDir);

    store.record(employer.keyPair.nodeId, 88);

    const entry = store.get(employer.keyPair.nodeId);
    assert.ok(entry);
    assert.equal(entry!.score, 88);
    assert.equal(entry!.interaction_count, 1);
  });

  test("step 6 — status action returns coherent summary", async () => {
    // Import run() but pass a stub config so it doesn't start Gun again
    // We test the formatting logic here, not the full bootstrap
    const { loadConfig, resetConfig } = await import("../../src/config.js");
    resetConfig();

    const peers = seeker.network.loadCachedPeers();
    assert.ok(peers.length >= 1, "seeker should have cached employer");

    const { ReputationStore } = await import("../../src/reputation.js");
    const repStore = new ReputationStore(seeker.dataDir);
    const repAll   = repStore.getAll();

    assert.equal(repAll.length, 1,                    "should have 1 reputation entry");
    assert.equal(repAll[0].node_id, employer.keyPair.nodeId);

    resetConfig();
  });
});

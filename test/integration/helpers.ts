// ─────────────────────────────────────────────
// test/integration/helpers.ts
//
// Shared utilities for integration tests.
//
// Key idea: spin up a local HTTP server as a Gun relay so two
// in-process nodes can discover each other without touching
// the public internet.  Each test gets fresh temp dirs and a
// relay port so tests are fully isolated and can run in parallel.
// ─────────────────────────────────────────────

import { createServer, type Server } from "http";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join }   from "path";
import { tmpdir } from "os";
import Gun        from "gun";

// ── Port pool ─────────────────────────────────────────────────────────────
// Tests each grab a port from this incrementing counter so they don't clash.
let _nextPort = 19000;
export function nextPort(): number { return _nextPort++; }

// ── Local Gun relay ────────────────────────────────────────────────────────

export interface Relay {
  url:   string;
  close: () => Promise<void>;
}

/**
 * Start a local Gun relay on a random port.
 * Returns the WebSocket URL and a close() function.
 */
export async function startRelay(port: number): Promise<Relay> {
  return new Promise((resolve) => {
    const server: Server = createServer();
    // Gun attaches its own WS handler when given `web: server`
    Gun({ web: server, radisk: false, localStorage: false });

    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/gun`;
      resolve({
        url,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ── Node factory ──────────────────────────────────────────────────────────

export interface TestNode {
  dataDir:  string;
  role:     "seeker" | "employer";
  keyPair:  import("../../src/identity.js").KeyPair;
  profile:  import("../../src/profile.js").LocalProfile;
  network:  import("../../src/network.js").P2PNetwork;
  cleanup:  () => void;
}

/**
 * Create a fully initialised skill node backed by a temp directory.
 * Writes a minimal document (resume.md or jd.md) so profile extraction works.
 */
export async function makeNode(
  role:        "seeker" | "employer",
  relayUrl:    string,
  docContent?: string
): Promise<TestNode> {
  // Lazy import so module graph stays clean at the top level
  const { loadOrCreateIdentity }    = await import("../../src/identity.js");
  const { buildProfile }            = await import("../../src/profile.js");
  const { P2PNetwork }              = await import("../../src/network.js");

  const dataDir = join(tmpdir(), `monadx-int-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });

  const docName    = role === "seeker" ? "resume.md" : "jd.md";
  const defaultDoc = role === "seeker"
    ? "# Test Seeker\n\nLocation: remote\nSalary: 20-40k\n\nSkills: TypeScript, Node.js, React, PostgreSQL\n"
    : "# Test Employer\n\nLocation: remote\nSalary: 25-45k\n\nSkills: TypeScript, Node.js, React, Docker\n";

  writeFileSync(join(dataDir, docName), docContent ?? defaultDoc);

  const keyPair = loadOrCreateIdentity(dataDir);
  const profile = buildProfile(dataDir, role, keyPair);
  const network = new P2PNetwork({ nodeId: keyPair.nodeId, dataDir, peers: [relayUrl] });

  return {
    dataDir,
    role,
    keyPair,
    profile,
    network,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

// ── Async wait helpers ─────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `fn` every `intervalMs` until it returns a truthy value or `timeoutMs` expires.
 * Throws with a descriptive message on timeout.
 */
export async function waitFor<T>(
  fn:          () => T | undefined | null | false,
  timeoutMs:   number,
  label:       string,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${label}`);
}

/**
 * Wrap a Promise with a hard timeout.
 */
export function withTimeout<T>(
  promise:    Promise<T>,
  ms:         number,
  label:      string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms)
    ),
  ]);
}

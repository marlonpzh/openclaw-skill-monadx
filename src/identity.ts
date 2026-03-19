// ─────────────────────────────────────────────
// identity.ts — Ed25519 key generation, signing, verification
// No blockchain. Keys live in ~/.monadx/keys/
// ─────────────────────────────────────────────

import naclPkg   from "tweetnacl";
import naclUtil   from "tweetnacl-util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// tweetnacl ships as a CJS module; under ESM it lands on .default
const nacl = naclPkg;

// tweetnacl-util's encodeUTF8 returns a string, not Uint8Array.
// Use the native TextEncoder for all string→bytes conversions.
const enc = new TextEncoder();

export interface KeyPair {
  publicKey: Uint8Array;  // 32 bytes
  secretKey: Uint8Array;  // 64 bytes
  nodeId:    string;      // hex-encoded public key — this IS the node identity
}

// ── Hex helpers ───────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

// ── Key management ────────────────────────────────────────────────────────

/**
 * Load keys from disk, or generate a new pair on first run.
 * Private key stored 0600 base64; public key plain base64.
 */
export function loadOrCreateIdentity(dataDir: string): KeyPair {
  const keysDir  = join(dataDir, "keys");
  const privPath = join(keysDir, "identity.ed25519");
  const pubPath  = join(keysDir, "identity.pub");

  if (existsSync(privPath) && existsSync(pubPath)) {
    const secretKey = naclUtil.decodeBase64(readFileSync(privPath, "utf8").trim());
    const publicKey = naclUtil.decodeBase64(readFileSync(pubPath,  "utf8").trim());
    return { secretKey, publicKey, nodeId: toHex(publicKey) };
  }

  mkdirSync(keysDir, { recursive: true });
  const pair = nacl.sign.keyPair();

  writeFileSync(privPath, naclUtil.encodeBase64(pair.secretKey), { mode: 0o600 });
  writeFileSync(pubPath,  naclUtil.encodeBase64(pair.publicKey));

  console.log("[identity] New identity:", toHex(pair.publicKey).slice(0, 16) + "…");
  return { ...pair, nodeId: toHex(pair.publicKey) };
}

// ── Signing ───────────────────────────────────────────────────────────────

/**
 * Sign an arbitrary object.
 * Canonical form: JSON.stringify with sorted keys → UTF-8 bytes.
 */
export function sign(obj: Record<string, unknown>, keyPair: KeyPair): string {
  const bytes = enc.encode(canonicalJSON(obj));
  const sig   = nacl.sign.detached(bytes, keyPair.secretKey);
  return toHex(sig);
}

/**
 * Verify a signature.  Returns false (never throws) on any failure.
 */
export function verify(
  obj:          Record<string, unknown>,
  sigHex:       string,
  publicKeyHex: string
): boolean {
  try {
    const bytes  = enc.encode(canonicalJSON(obj));
    const sig    = fromHex(sigHex);
    const pubKey = fromHex(publicKeyHex);
    return nacl.sign.detached.verify(bytes, sig, pubKey);
  } catch {
    return false;
  }
}

// ── Encryption ────────────────────────────────────────────────────────────

/**
 * Encrypt a short message for a specific recipient.
 * Uses NaCl box (Curve25519-XSalsa20-Poly1305).
 * Returns base64-encoded nonce‖ciphertext.
 */
export function encryptFor(
  message:           string,
  recipientPubKeyHex: string,
  senderKeyPair:      KeyPair
): string {
  const nonce     = nacl.randomBytes(nacl.box.nonceLength);
  const msgBytes  = enc.encode(message);
  const senderC   = ed25519PrivToCurve25519(senderKeyPair.secretKey);
  const recipC    = ed25519PubToCurve25519(fromHex(recipientPubKeyHex));
  const boxed     = nacl.box(msgBytes, nonce, recipC, senderC);
  const combined  = new Uint8Array(nonce.length + boxed.length);
  combined.set(nonce);
  combined.set(boxed, nonce.length);
  return naclUtil.encodeBase64(combined);
}

/**
 * Decrypt a message produced by encryptFor().  Returns null on failure.
 */
export function decryptFrom(
  ciphertextB64:  string,
  senderPubKeyHex: string,
  recipientKP:     KeyPair
): string | null {
  try {
    const combined = naclUtil.decodeBase64(ciphertextB64);
    const nonce    = combined.slice(0, nacl.box.nonceLength);
    const boxed    = combined.slice(nacl.box.nonceLength);
    const senderC  = ed25519PubToCurve25519(fromHex(senderPubKeyHex));
    const recipC   = ed25519PrivToCurve25519(recipientKP.secretKey);
    const msg      = nacl.box.open(boxed, nonce, senderC, recipC);
    return msg ? new TextDecoder().decode(msg) : null;
  } catch {
    return null;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

function canonicalJSON(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Ed25519 private seed → Curve25519 scalar (RFC 8032 §5.1.5 clamping).
 * tweetnacl stores secretKey as seed‖publicKey (64 bytes); seed = first 32.
 */
function ed25519PrivToCurve25519(secretKey: Uint8Array): Uint8Array {
  const seed = secretKey.slice(0, 32);
  const h    = nacl.hash(seed);         // SHA-512(seed)
  h[0]  &= 248;
  h[31] &= 127;
  h[31] |= 64;
  return h.slice(0, 32);
}

/**
 * Ed25519 public key (y-coordinate, compressed) → Curve25519 u-coordinate.
 * Formula: u = (1 + y) / (1 − y)  over GF(2^255 − 19).
 */
function ed25519PubToCurve25519(edPub: Uint8Array): Uint8Array {
  const p = BigInt(
    "57896044618658097711785492504343953926634992332820282019728792003956564819949"
  );
  // Ed25519 public key is stored little-endian; clear the sign bit
  const ybytes = Uint8Array.from(edPub).reverse();
  ybytes[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(ybytes).toString("hex"));

  const one = 1n;
  const num = (one + y) % p;
  const inv = modpow((one - y + p) % p, p - 2n, p);   // modular inverse of (1−y)
  const u   = (num * inv) % p;

  const out = new Uint8Array(32);
  let tmp = u;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  return out;
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % mod;
    exp >>= 1n;
    base = base * base % mod;
  }
  return result;
}

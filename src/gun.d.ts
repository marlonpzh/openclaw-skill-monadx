// ─────────────────────────────────────────────
// gun.d.ts — minimal ambient declarations for Gun.js
// The published @types/gun are incomplete; we declare
// only what this skill actually uses.
// ─────────────────────────────────────────────
declare module "gun" {
  interface GunOptions {
    peers?:        string[];
    radisk?:       boolean;
    localStorage?: boolean;
    [key: string]: unknown;
  }

  type GunData = Record<string, unknown> | null | undefined;
  type GunAck  = { err?: string; ok?: number };
  type GunCb   = (ack: GunAck) => void;
  type GunOnCb = (data: unknown, key: string) => void;

  interface GunChain {
    get(key: string): GunChain;
    put(data: GunData, cb?: GunCb): GunChain;
    on(cb: GunOnCb): GunChain;
    map(): GunChain;
    once(cb: GunOnCb): GunChain;
    off(): void;
  }

  interface GunInstance extends GunChain {
    // top-level get returns a chain
    get(key: string): GunChain;
  }

  function Gun(opts?: GunOptions): GunInstance;
  export = Gun;
}

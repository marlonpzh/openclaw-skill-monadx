// ─────────────────────────────────────────────
// config.ts — load config.json with sane defaults
//
// Lookup order (first found wins):
//   1. $monadx_CONFIG env var (absolute path)
//   2. ~/.monadx/config.json
//   3. Built-in defaults (no file needed)
// ─────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Shape ─────────────────────────────────────────────────────────────────

export interface SkillConfig {
  role: "seeker" | "employer";

  network: {
    bootstrap_peers:  string[];
    peer_ttl_seconds: number;
    max_cached_peers: number;
  };

  broadcast: {
    active_hours:           [number, number];
    hot_start_count:        number;
    hot_start_interval_sec: number;
    steady_interval_sec:    number;
    sleep_interval_sec:     number;
  };

  matching: {
    tier1_top_n:        number;
    tier2_top_n:        number;
    min_score_threshold: number;
    weights: {
      skill_jaccard: number;
      skill_in_doc:  number;
      salary:        number;
      location:      number;
    };
  };

  handshake: {
    proposal_timeout_seconds: number;
    stun_servers:             string[];
  };

  reputation: {
    bft_sigma_threshold: number;
    anon_vector_noise:   number;
  };

  mcp: {
    model:                             string;
    max_tokens:                        number;
    use_openclaw_bridge_if_available:  boolean;
  };
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS: SkillConfig = {
  role: "seeker",

  network: {
    bootstrap_peers: [
      "https://gun-manhattan.herokuapp.com/gun",
      "https://gun-us.herokuapp.com/gun",
    ],
    peer_ttl_seconds:  172800, // 48 h
    max_cached_peers:  500,
  },

  broadcast: {
    active_hours:           [9, 22], // 9:00 - 22:00
    hot_start_count:        6,       // first 6 broadcasts are frequent
    hot_start_interval_sec: 300,     // 5 mins
    steady_interval_sec:    14400,   // 4 hours
    sleep_interval_sec:     43200,   // 12 hours
  },

  matching: {
    tier1_top_n:         20,
    tier2_top_n:          5,
    min_score_threshold: 10,
    weights: {
      skill_jaccard: 0.40,
      skill_in_doc:  0.20,
      salary:        0.20,
      location:      0.20,
    },
  },

  handshake: {
    proposal_timeout_seconds: 259200,  // 3 days
    stun_servers: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
    ],
  },

  reputation: {
    bft_sigma_threshold: 2.0,
    anon_vector_noise:   0.05,
  },

  mcp: {
    model:                            "claude-sonnet-4-20250514",
    max_tokens:                       512,
    use_openclaw_bridge_if_available: true,
  },
};

// ── Loader ────────────────────────────────────────────────────────────────

let _cached: SkillConfig | null = null;

export function loadConfig(dataDir?: string): SkillConfig {
  if (_cached) return _cached;

  const candidates = [
    process.env.monadx_CONFIG,
    dataDir && join(dataDir, "config.json"),
    join(homedir(), ".openclaw", "jobs", "config.json"),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw  = JSON.parse(readFileSync(path, "utf8"));
        _cached    = deepMerge(DEFAULTS, raw) as SkillConfig;
        console.log(`[config] Loaded from ${path}`);
        return _cached;
      } catch (e) {
        console.warn(`[config] Failed to parse ${path}:`, e);
      }
    }
  }

  console.log("[config] No config file found — using defaults");
  _cached = DEFAULTS;
  return _cached;
}

/** Reset cached config (useful in tests) */
export function resetConfig(): void {
  _cached = null;
}

// ── Deep merge (partial override) ────────────────────────────────────────

function deepMerge(base: unknown, override: unknown): unknown {
  if (
    typeof base     !== "object" || base     === null ||
    typeof override !== "object" || override === null
  ) {
    return override ?? base;
  }

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, val] of Object.entries(override as Record<string, unknown>)) {
    result[key] = deepMerge(result[key], val);
  }
  return result;
}

// 调试工具：连接 relay，观察所有数据变化
import Gun from "gun";
import { mkdirSync } from "fs";
import { join }      from "path";
import { tmpdir }    from "os";

const RELAY = process.env.RELAY_URL ?? "http://localhost:9765/gun";
const DATA  = join(tmpdir(), `dbg-relay-${Date.now()}`);
mkdirSync(DATA, { recursive: true });

console.log(`[debug] 连接到 relay: ${RELAY}`);
const g = Gun({ peers: [RELAY], file: join(DATA, "d"), localStorage: false });

const NS = "monadx/v1/profiles";

// 监听父节点
g.get(NS).on((data: unknown, key: string) => {
  if (!data) return;
  const d = data as Record<string, unknown>;
  const keys = Object.keys(d).filter(k => k !== "_");
  console.log(`[debug] NS.on  key=${key}  子节点数=${keys.length}  keys=[${keys.join(",")}]`);
});

// map 监听
g.get(NS).map().on((data: unknown, key: string) => {
  if (!data) return;
  const d = data as Record<string, unknown>;
  const has_ = "_" in d;
  console.log(`[debug] NS.map.on  key=${key}  node_id=${d.node_id ?? "—"}  has_=${has_}  keys=[${Object.keys(d).join(",")}]`);
});

setTimeout(() => {
  console.log("[debug] 10s 内未收到数据");
  process.exit(0);
}, 10_000);

// relay.ts — 本地 Gun HTTP 中继（必须开启 radisk）
import http from "http";
import Gun  from "gun";
import { mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PORT     = parseInt(process.env.monadx_RELAY_PORT ?? process.argv[2] ?? "9765");
const DATA_DIR = join(tmpdir(), `monadx-relay-${PORT}`);
mkdirSync(DATA_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});

Gun({ web: server, file: join(DATA_DIR, "radata"), localStorage: false });

server.listen(PORT, () => {
  console.log(`[relay] listening on port ${PORT}`);
  process.stdout.write(`RELAY_READY:${PORT}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT",  () => server.close(() => process.exit(0)));

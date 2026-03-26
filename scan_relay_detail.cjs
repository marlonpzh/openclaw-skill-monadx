const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'] });

console.log("Scanning ALL profile keys on relay...");

let found = [];
gun.get("monadx_v2_profiles").map().on((data, key) => {
  if (data) {
    found.push({ key: key.slice(0, 30), node_id: (data.node_id || '').slice(0,20), title: data.title || '(no title)', role: data.role || '?' });
    console.log("FOUND:", key.slice(0, 30), "→", data.node_id?.slice(0,20), data.title, data.role);
  }
});

setTimeout(() => {
  console.log("\n=== SUMMARY: " + found.length + " profiles ===");
  found.forEach((f, i) => console.log(`  ${i+1}. [${f.role}] ${f.title} (${f.node_id}...)`));
  process.exit(0);
}, 10000);

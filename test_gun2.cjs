const Gun = require('/Users/longwind/.openclaw/skills/monadx/node_modules/gun');
const gun = Gun(['http://118.178.88.178:8765/gun']);
console.log("Connecting...");
gun.get("monadx_v2_profiles").map().on((data, key) => {
  if (data) {
    console.log("Found:", key, data.node_id ? data.node_id.slice(0, 8) : "no-id");
  }
});
setTimeout(() => { console.log("Done"); process.exit(0); }, 15000);

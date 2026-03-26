const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');
const gun = Gun(['http://118.178.88.178:8765/gun']);
gun.get("monadx_v2_profiles").map().on((data, key) => {
  if (data) console.log("Received profile key:", key);
});
setTimeout(() => process.exit(0), 10000);

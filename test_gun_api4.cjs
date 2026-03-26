const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'] });

console.log("putting with object peers...");
gun.get("monadx_test_ping_v3").get("childA").put({ data: 123 }, (ack) => {
  console.log("gun put ack:", ack);
});

setTimeout(() => process.exit(0), 5000);

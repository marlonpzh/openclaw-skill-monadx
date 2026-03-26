const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gunA = Gun({ peers: ['http://118.178.88.178:8765/gun'], radisk: true });

gunA.get("monadx_test_ping_v3").get("childA").put({ data: 123 }, (ack) => {
  console.log("gunA put ack:", ack);
});

setTimeout(() => process.exit(0), 5000);

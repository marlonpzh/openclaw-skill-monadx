const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({
  peers: ['http://118.178.88.178:8765/gun'],
  radisk: true,
  localStorage: false,
});

console.log("putting with radisk: true, localStorage: false...");
gun.get("monadx_test_ping_v4").get("childA").put({ data: 123 }, (ack) => {
  console.log("gun put ack:", ack);
});

gun.get("monadx_test_ping_v4").map().on((data) => {
  console.log("Saw data on v4 network:", data.data);
});

setTimeout(() => process.exit(0), 5000);

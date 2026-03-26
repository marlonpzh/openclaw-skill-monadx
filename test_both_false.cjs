const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'], radisk: false, localStorage: false });

console.log("Waiting 3s for WS...");
setTimeout(() => {
  gun.get("monadx_v2_profiles").get("test_localStorage_false").put({ msg: "hello" }, (ack) => {
    console.log("Put ack:", ack);
  });
}, 3000);

setTimeout(() => process.exit(0), 10000);

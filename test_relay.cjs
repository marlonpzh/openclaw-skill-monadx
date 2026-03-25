const Gun = require('/Users/longwind/.openclaw/skills/monadx/node_modules/gun');
const gun = Gun(['http://118.178.88.178:8765/gun']);

console.log("Pushing test data...");
gun.get('monadx_test_ping').put({ time: Date.now(), msg: "hello" }, (ack) => {
  console.log("Put ack:", ack);
});

gun.get('monadx_test_ping').on((data) => {
  console.log("Received data:", data);
  if (data) {
     setTimeout(() => process.exit(0), 1000);
  }
});

setTimeout(() => { console.log("Timeout"); process.exit(1); }, 15000);

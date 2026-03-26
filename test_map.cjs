const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');
const gun = Gun(['http://118.178.88.178:8765/gun']);

console.log("Pushing index ping...");
gun.get("monadx_test_map").get("child_1").put({ msg: "hello" }, (ack) => {
  console.log("Put ack:", ack);
});

gun.get("monadx_test_map").map().on((data, key) => {
  console.log("Map saw:", key, data);
  if (data) {
     setTimeout(() => process.exit(0), 1000);
  }
});

setTimeout(() => { console.log("Timeout"); process.exit(1); }, 10000);

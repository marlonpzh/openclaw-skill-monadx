const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'] });

const uniqueKey = `test_node_${Date.now()}`;
const nodeRef = gun.get(uniqueKey);

nodeRef.put({ msg: 'hello sync' }, (ack) => {
  console.log("nodeRef put ack:", ack);
  gun.get("monadx_v2_profiles").set(nodeRef, (setAck) => {
    console.log("set() ack:", setAck);
  });
});

gun.get("monadx_v2_profiles").map().on((data, key) => {
  console.log("Found on map:", key, data ? data.msg || data.node_id : null);
});

setTimeout(() => process.exit(0), 10000);

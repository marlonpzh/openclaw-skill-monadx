const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');
const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'], radisk: true, localStorage: false });

const uniqueKey = `test_local_${Date.now()}`;
const nodeRef = gun.get(uniqueKey);

nodeRef.put({ msg: 'hello local' }, (ack) => {
  gun.get("monadx_v2_profiles").set(nodeRef, (setAck) => {
    console.log("set local ack done");
  });
});

setTimeout(() => process.exit(0), 10000);

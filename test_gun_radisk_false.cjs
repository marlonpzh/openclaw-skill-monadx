const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'], radisk: false });

const flat = { 
  node_id: "testtesttesttest", timestamp: Date.now()/1000, 
  title: "test-node", role: "seeker", location: "test", 
  skills: "[]", salary_range: "[0,999]", sig: "abc" 
};

setTimeout(() => {
  console.log("putting to monadx_v2_profiles after delay...");
  gun.get("monadx_v2_profiles").get("testtesttesttest").put(flat, (ack) => {
    console.log("Put v2 profile ack:", ack);
    setTimeout(() => process.exit(0), 1000);
  });
}, 3000);

setTimeout(() => process.exit(1), 10000);

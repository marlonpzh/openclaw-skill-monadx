const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');
const gun = Gun(['http://118.178.88.178:8765/gun']);
const flat = { 
  node_id: "testtesttesttest", timestamp: Date.now()/1000, 
  title: "test-node", role: "seeker", location: "test", 
  skills: "[]", salary_range: "[0,999]", sig: "abc" 
};
console.log("putting to monadx_v2_profiles...");
gun.get("monadx_v2_profiles").get("testtesttesttest").put(flat, (ack) => {
  console.log("Put v2 profile ack:", ack);
});
gun.get("monadx_v2_profiles").map().on((data) => {
  console.log("Saw data on v2 network:", data.node_id);
});
setTimeout(() => process.exit(0), 5000);

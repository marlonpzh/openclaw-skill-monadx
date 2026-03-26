const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'], radisk: false });

console.log("Pushing via .set()...");
gun.get("monadx_v2_profiles").set({
  node_id: "test_set_direct",
  timestamp: Date.now() / 1000,
  role: "seeker",
  skills: "[]",
  title: "test",
  location: "test",
  salary_range: "[0,99]",
  sig: "test"
});

console.log("Pushed via .set()! Waiting 3s to read...");

setTimeout(() => {
  gun.get("monadx_v2_profiles").map().on((data, key) => {
    if (data && data.node_id === "test_set_direct") {
      console.log("SUCCESS! Saw my direct .set() payload!");
      process.exit(0);
    }
  });
}, 3000);

setTimeout(() => { console.log("Timeout"); process.exit(1); }, 10000);

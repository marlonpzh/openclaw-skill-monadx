/**
 * 验证 Gun({ peers: [...] }) 也正常工作（不设 radisk/file/localStorage）
 */
const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'] });

console.log("[test] Gun({ peers }) initialized");

gun.get("monadx_v2_profiles").map().on((data) => {
  if (data && data.node_id) {
    console.log("[discovery]", data.node_id.slice(0, 20), data.title);
  }
});

setTimeout(() => {
  const flat = {
    node_id: "peers_obj_test_" + Date.now(),
    role: "seeker",
    skills: '["TypeScript"]',
    location: "remote",
    salary_range: "[0,999]",
    title: "peers-obj-test",
    timestamp: Math.floor(Date.now() / 1000),
    sig: "xxx"
  };

  console.log("[broadcast] put()...");
  gun.get("monadx_v2_profiles").get(flat.node_id).put(flat, (ack) => {
    if (ack?.err) console.error("[broadcast] FAIL:", ack.err);
    else console.log("[broadcast] SUCCESS! ACK:", !!ack.ok);
  });

  setTimeout(() => {
    gun.get("monadx_v2_profiles").get(flat.node_id).once((data) => {
      console.log("[verify]", data ? "FOUND: " + data.title : "NOT FOUND");
      process.exit(data ? 0 : 1);
    });
  }, 5000);
}, 3000);

setTimeout(() => process.exit(1), 15000);

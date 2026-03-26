/**
 * 对比测试：不传 file/radisk/localStorage 参数（Gun 默认值）
 */
const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

// ── 使用 Gun 默认配置（不显式设 radisk/file/localStorage）──
const gun = Gun(['http://118.178.88.178:8765/gun']);

console.log("[test] Gun initialized with DEFAULT config (no radisk/file/localStorage overrides)");

gun.get("monadx_v2_profiles").map().on((data) => {
  if (data && data.node_id) {
    console.log("[discovery] Found:", data.node_id.slice(0, 20), data.title);
  }
});

setTimeout(() => {
  const flat = {
    node_id: "default_cfg_test_" + Date.now(),
    role: "employer",
    skills: '["TypeScript"]',
    location: "remote",
    salary_range: "[0,999]",
    title: "default-cfg-test",
    timestamp: Math.floor(Date.now() / 1000),
    sig: "xxx"
  };

  console.log("[broadcast] put() with default Gun config...");
  gun.get("monadx_v2_profiles").get(flat.node_id).put(flat, (ack) => {
    if (ack?.err) console.error("[broadcast] FAIL:", ack.err);
    else console.log("[broadcast] SUCCESS! ACK:", !!ack.ok);
  });

  setTimeout(() => {
    gun.get("monadx_v2_profiles").get(flat.node_id).once((data) => {
      console.log("[verify]", data ? "FOUND on relay: " + data.title : "NOT on relay");
    });
  }, 5000);
}, 3000);

setTimeout(() => process.exit(0), 15000);

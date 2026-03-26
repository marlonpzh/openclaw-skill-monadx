/**
 * 精确复刻 daemon 的 Gun.js 初始化和广播行为。
 * 目标：定位为什么 put() ACK 在真实 Agent 中永远不触发。
 */
const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

// ── 第1步：精确复制 network.ts 的 Gun 初始化参数 ──
const gun = Gun({
  peers: ['http://118.178.88.178:8765/gun'],
  file: undefined,
  radisk: false,
});

console.log("[test] Gun initialized (radisk:false, file:undefined)");
console.log("[test] Waiting 3s for WebSocket to connect (same as scheduler.ts)...");

// ── 第2步：复制 startDiscovery() 的 map().on() ──
gun.get("monadx_v2_profiles").map().on((data, key) => {
  if (data && data.node_id) {
    console.log("[discovery] Found peer:", data.node_id.slice(0, 16), "role:", data.role, "title:", data.title);
  }
});

// ── 第3步：延迟 3 秒后执行 broadcast (同 scheduler 的逻辑) ──
setTimeout(() => {
  const flat = {
    node_id: "daemon_test_" + Date.now(),
    role: "employer",
    skills: '["TypeScript","React"]',
    location: "remote",
    salary_range: "[0,999]",
    title: "daemon-test-broadcast",
    timestamp: Math.floor(Date.now() / 1000),
    sig: "test_sig_placeholder"
  };

  console.log("[broadcast] Calling gun.get().get().put()...");
  gun
    .get("monadx_v2_profiles")
    .get(flat.node_id)
    .put(flat, (ack) => {
      if (ack?.err) console.error("[broadcast] PUT FAILED:", ack.err);
      else console.log("[broadcast] PUT SUCCESS! ACK received:", !!ack.ok);
    });

  // 5s 后检查是否能读到自己的数据
  setTimeout(() => {
    console.log("[verify] Reading back from relay...");
    gun.get("monadx_v2_profiles").get(flat.node_id).once((data) => {
      if (data) {
        console.log("[verify] SUCCESS - Data found on relay:", data.title);
      } else {
        console.log("[verify] FAILURE - Data NOT on relay");
      }
    });
  }, 5000);
}, 3000);

// 20s 后退出
setTimeout(() => {
  console.log("[test] Done.");
  process.exit(0);
}, 20000);

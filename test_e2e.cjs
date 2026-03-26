/**
 * 终极 E2E 测试：两个完全独立的 Gun 实例，各自使用独立的临时存储
 * 验证数据是否真的通过 118 relay 同步
 */
const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gun-e2e-1-'));
const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gun-e2e-2-'));

console.log("tmpDir1:", tmpDir1);
console.log("tmpDir2:", tmpDir2);

const RELAY = 'http://118.178.88.178:8765/gun';
const testId = "e2e_" + Date.now();

// Gun 实例 1：写入者
const gun1 = Gun({ peers: [RELAY], file: path.join(tmpDir1, 'radata') });

console.log("STEP 1: Writing " + testId + " via gun1...");

setTimeout(() => {
  gun1.get("monadx_v2_profiles").get(testId).put({
    node_id: testId,
    role: "seeker",
    title: "e2e-success",
    timestamp: Math.floor(Date.now()/1000),
    skills: '["test"]',
    location: "test",
    salary_range: "[0,1]",
    sig: "xxx"
  }, (ack) => {
    console.log("STEP 1 ACK:", ack?.ok ? "OK" : "FAIL", ack?.err || "");
  });
}, 3000);

// Gun 实例 2：读取者（延迟 8s 启动，确保完全独立）
setTimeout(() => {
  console.log("\nSTEP 2: Starting independent gun2 and reading...");
  const gun2 = Gun({ peers: [RELAY], file: path.join(tmpDir2, 'radata') });

  gun2.get("monadx_v2_profiles").get(testId).once((data) => {
    if (data) {
      console.log("✅ E2E SUCCESS! Data found via independent reader:", data.title);
    } else {
      console.log("❌ E2E FAIL! Data NOT found on relay.");
    }
    // Cleanup
    fs.rmSync(tmpDir1, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
    process.exit(data ? 0 : 1);
  });
}, 8000);

setTimeout(() => {
  console.log("Timeout");
  fs.rmSync(tmpDir1, { recursive: true, force: true });
  fs.rmSync(tmpDir2, { recursive: true, force: true });
  process.exit(1);
}, 20000);

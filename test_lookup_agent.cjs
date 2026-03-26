const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');
const gun = Gun({ peers: ['http://118.178.88.178:8765/gun'] });

console.log("Looking up agent key 659db254...");
gun.get("monadx_v2_profiles").get("659db254e79ca92adb74108324f757f4c7c386372ef5051ef54adcd3a252e46f").once((data) => {
  console.log("Agent data on relay:", data ? JSON.stringify(data, null, 2) : "NULL");
  process.exit(0);
});

setTimeout(() => { console.log("Timeout"); process.exit(1); }, 10000);

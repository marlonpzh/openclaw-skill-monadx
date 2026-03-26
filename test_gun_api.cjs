const Gun = require('/Users/longwind/.openclaw/workspace/skills/monadx/node_modules/gun');

// Option A: array in opts (monadx-agent style)
const gunA = Gun({ peers: ['http://118.178.88.178:8765/gun'], radisk: false });

// Option B: direct array (test_put_v2 style)
const gunB = Gun(['http://118.178.88.178:8765/gun']);

console.log("gunA peers:", Object.keys(gunA.back('opt.peers')));
console.log("gunB peers:", Object.keys(gunB.back('opt.peers')));

process.exit(0);

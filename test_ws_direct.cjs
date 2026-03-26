/**
 * 诊断 118 relay 的 WebSocket 连接健康状态
 */
const WebSocket = require('ws');

const ws = new WebSocket('http://118.178.88.178:8765/gun');

ws.on('open', () => {
  console.log('✅ WebSocket CONNECTED to 118 relay');
  
  // 发 Gun.js 格式的 put 消息
  const msg = JSON.stringify({
    '#': 'test_' + Date.now(),
    put: {
      'monadx_v2_profiles': {
        '_': { '#': 'monadx_v2_profiles', '>': {} },
        'ws_test_direct': { '#': 'monadx_v2_profiles/ws_test_direct' }
      },
      'monadx_v2_profiles/ws_test_direct': {
        '_': { '#': 'monadx_v2_profiles/ws_test_direct', '>': { node_id: Date.now() } },
        node_id: 'ws_test_direct',
        title: 'ws-direct-test'
      }
    }
  });
  
  console.log('Sending raw Gun put message...');
  ws.send(msg);
});

ws.on('message', (data) => {
  const str = data.toString();
  console.log('Relay response:', str.slice(0, 200));
});

ws.on('error', (err) => {
  console.error('❌ WebSocket ERROR:', err.message);
});

ws.on('close', () => {
  console.log('WebSocket CLOSED');
});

setTimeout(() => process.exit(0), 10000);

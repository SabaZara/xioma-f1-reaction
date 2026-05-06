// Smoke test private room matchmaking: only clients with the same room code match.
const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';

function client(label, room, action) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let roundToken = null;
    let inputSent = false;
    const events = [];

    function send(type, data = {}) {
      ws.send(JSON.stringify({ type, ...data }));
    }

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      events.push(msg.type);
      switch (msg.type) {
        case 'hello':
          send('matchmaking.join', { stake: 5, room });
          break;
        case 'matchmaking.queued':
          console.log(`[${label}] queued room=${msg.room || 'PUBLIC'}`);
          break;
        case 'match.start':
          console.log(`[${label}] matched vs ${msg.opponent.name}`);
          break;
        case 'countdown.begin':
          roundToken = msg.roundToken;
          inputSent = false;
          break;
        case 'lights.green':
          setTimeout(() => {
            if (inputSent) return;
            inputSent = true;
            send('player.input', { roundToken, clientTs: Date.now() });
          }, action === 'fast' ? 70 : 240);
          break;
        case 'match.result':
          console.log(`[${label}] result youWon=${msg.youWon}`);
          ws.close();
          resolve({ label, events, result: msg });
          break;
      }
    });
  });
}

(async () => {
  const room = 'FRIENDS1';
  const results = await Promise.all([
    client('A', room, 'fast'),
    client('B', room, 'slow'),
  ]);
  const bothMatched = results.every(r => r.events.includes('match.start') && r.result.mode === 'pvp');
  console.log(bothMatched ? 'PASS: room clients matched each other' : 'FAIL: room clients did not match');
  process.exit(bothMatched ? 0 : 1);
})();

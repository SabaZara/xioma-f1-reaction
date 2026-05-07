// Smoke test: bot rematch flow through rematch.request and PvP opponent-left fallback.
const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';

function botRematchClient() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let phase = 0; // 0 = first match, 1 = rematch
    let roundToken = null;
    let inputSent = false;

    function s(type, data = {}) { ws.send(JSON.stringify({ type, ...data })); }

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'hello': s('play.bot', { stake: 5 }); break;
        case 'match.start':
          inputSent = false;
          if (msg.requiresReady) setTimeout(() => s('player.ready'), 30);
          break;
        case 'countdown.begin': roundToken = msg.roundToken; inputSent = false; break;
        case 'lights.green':
          setTimeout(() => {
            if (!inputSent) { inputSent = true; s('player.input', { roundToken, clientTs: Date.now() }); }
          }, 90);
          break;
        case 'match.result':
          console.log(`[bot] phase ${phase} won=${msg.youWon} balance=${msg.balance}`);
          if (phase === 0) {
            phase = 1;
            // Click Rematch on the result modal
            setTimeout(() => s('rematch.request'), 50);
          } else {
            ws.close();
            resolve({ ok: true });
          }
          break;
      }
    });
  });
}

function pvpOpponentLeftClient() {
  return new Promise((resolve) => {
    // Two clients pair up, B disconnects after match.result, A clicks Rematch
    // → server should reply rematch.failed { reason: 'opponent_left', stake: 5 }
    // and the client should auto-requeue. We'll just verify server emits the
    // expected fallback message (the auto-requeue is a client behavior).
    let A = null, B = null;
    let roundTokenA = null, roundTokenB = null;
    let aSent = false, bSent = false;
    let aResultSeen = false, bResultSeen = false;
    let receivedFallback = null;

    function open(label, plan) {
      const ws = new WebSocket(WS_URL);
      ws.label = label;
      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        switch (msg.type) {
          case 'hello':
            ws.send(JSON.stringify({ type: 'matchmaking.join', stake: 5, room: 'REMATCH-X' }));
            break;
          case 'match.start':
            if (msg.requiresReady) setTimeout(() => ws.send(JSON.stringify({ type: 'player.ready' })), 30);
            break;
          case 'countdown.begin':
            if (label === 'A') roundTokenA = msg.roundToken;
            else roundTokenB = msg.roundToken;
            break;
          case 'lights.green':
            setTimeout(() => {
              const tok = label === 'A' ? roundTokenA : roundTokenB;
              ws.send(JSON.stringify({ type: 'player.input', roundToken: tok, clientTs: Date.now() }));
            }, label === 'A' ? 90 : 200);
            break;
          case 'match.result':
            console.log(`[pvp ${label}] won=${msg.youWon}`);
            if (label === 'B') {
              // B leaves immediately
              ws.close();
              bResultSeen = true;
            } else {
              aResultSeen = true;
              // Wait a beat for B's close to register on the server, then request rematch
              setTimeout(() => ws.send(JSON.stringify({ type: 'rematch.request' })), 200);
            }
            break;
          case 'rematch.failed':
            console.log(`[pvp ${label}] rematch.failed reason=${msg.reason} stake=${msg.stake}`);
            receivedFallback = msg;
            ws.close();
            resolve({ ok: msg.reason === 'opponent_left' && msg.stake === 5 });
            break;
        }
      });
      ws.on('close', () => {
        if (label === 'A' && aResultSeen && !receivedFallback) {
          // Match closed without fallback — fail
        }
      });
      return ws;
    }
    A = open('A');
    B = open('B');
    // Safety timeout
    setTimeout(() => { if (!receivedFallback) resolve({ ok: false, why: 'timeout' }); }, 30000);
  });
}

(async () => {
  console.log('--- TEST: Bot rematch via rematch.request ---');
  const r1 = await botRematchClient();
  console.log(r1.ok ? 'PASS: bot rematch produced two completed matches' : 'FAIL');

  console.log('\n--- TEST: PvP opponent-left fallback ---');
  const r2 = await pvpOpponentLeftClient();
  console.log(r2.ok ? 'PASS: server replied rematch.failed { opponent_left, stake: 5 }' : 'FAIL ' + (r2.why || ''));

  process.exit(0);
})();

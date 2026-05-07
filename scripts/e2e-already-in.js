// Reproduce: play a bot match, finish it, immediately try Play again.
// Before fix: server replies "already_in_match". After fix: succeeds.
const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';

function open(label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const log = (...a) => console.log(`[${label}]`, ...a);
    let me = null;
    let roundToken = null;
    let phase = 0; // 0 = first match, 1 = retry
    let inputSent = false;
    const errors = [];

    ws.on('open', () => log('connected'));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'hello':
          me = msg.playerId;
          ws.send(JSON.stringify({ type: 'play.bot', stake: 5 }));
          break;
        case 'match.start':
          log('match start, phase', phase);
          inputSent = false;
          if (msg.requiresReady) setTimeout(() => ws.send(JSON.stringify({ type: 'player.ready' })), 50);
          break;
        case 'countdown.begin':
          roundToken = msg.roundToken; inputSent = false;
          break;
        case 'lights.green':
          setTimeout(() => {
            if (!inputSent) {
              inputSent = true;
              ws.send(JSON.stringify({ type: 'player.input', roundToken, clientTs: Date.now() }));
            }
          }, 80);
          break;
        case 'match.result':
          log('result phase', phase, 'youWon=', msg.youWon, 'balance=', msg.balance);
          if (phase === 0) {
            phase = 1;
            // Immediately try to play again — this used to fail with "already_in_match"
            setTimeout(() => {
              log('→ attempting second play.bot WITHOUT calling leave_match');
              ws.send(JSON.stringify({ type: 'play.bot', stake: 5 }));
            }, 50);
          } else {
            log('SECOND match completed cleanly');
            ws.close();
            resolve({ errors });
          }
          break;
        case 'matchmaking.error':
          log('!!! matchmaking.error', msg.reason);
          errors.push(msg.reason);
          ws.close();
          resolve({ errors });
          break;
      }
    });
  });
}

(async () => {
  const r = await open('Player');
  if (r.errors.length === 0) console.log('\nPASS: no "already_in_match" error after a finished match');
  else console.log('\nFAIL: errors =', r.errors);
  process.exit(0);
})();

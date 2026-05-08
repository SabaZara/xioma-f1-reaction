// Multi-player reaction smoke test.
// Spins up N clients, queues them all for a multi match at the same stake
// and party size, and verifies that exactly one wins the full pot minus fee.
const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';
const PARTY_SIZE = Number(process.env.PARTY_SIZE) || 4;
const STAKE = Number(process.env.STAKE) || 10;

function makeClient(label, reactionDelay) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let me = null;
    let matchStarted = false;
    let roundToken = null;

    function s(type, data = {}) { ws.send(JSON.stringify({ type, ...data })); }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      switch (msg.type) {
        case 'hello':
          me = msg.playerId;
          // Top up so the stake is affordable, then queue.
          s('wallet.deposit', { amount: 200 });
          break;
        case 'wallet.update':
          if (!matchStarted) s('matchmaking.join', { stake: STAKE, partySize: PARTY_SIZE, game: 'reaction' });
          break;
        case 'matchmaking.queued':
          if (msg.waiting != null && msg.needed != null) {
            console.log(`[${label}] queued ${msg.waiting}/${msg.needed} (stake $${msg.stake}, party ${msg.partySize})`);
          }
          break;
        case 'match.start':
          matchStarted = true;
          console.log(`[${label}] match.start mode=${msg.mode} party=${msg.partySize} pot=${msg.pot}`);
          // Press READY to start the countdown.
          setTimeout(() => s('player.ready'), 50);
          break;
        case 'countdown.begin':
          roundToken = msg.roundToken;
          break;
        case 'lights.green':
          // Simulate the player's reaction time.
          setTimeout(() => {
            s('player.input', {
              roundToken,
              clientTs: Date.now(),
              clientReactionMs: reactionDelay,
            });
          }, reactionDelay);
          break;
        case 'match.result':
          console.log(`[${label}] RESULT youWon=${msg.youWon} payout=${msg.payout} balance=${msg.balance} party=${msg.partySize}`);
          ws.close();
          resolve({ label, msg });
          break;
        case 'matchmaking.error':
        case 'rematch.failed':
          console.log(`[${label}] ${msg.type}: ${msg.reason}`);
          ws.close();
          resolve({ label, msg });
          break;
      }
    });
    ws.on('error', (e) => console.log(`[${label}] ws error`, e.message));
  });
}

(async () => {
  console.log(`--- Multi-player: ${PARTY_SIZE} clients, $${STAKE} stake, winner takes all ---`);
  const reactions = [180, 250, 320, 400, 220, 280, 360, 200].slice(0, PARTY_SIZE);
  const clients = reactions.map((rt, i) => makeClient(String.fromCharCode(65 + i), rt));
  const results = await Promise.all(clients);

  const winners = results.filter(r => r.msg && r.msg.youWon);
  const expectedPayout = +(STAKE * PARTY_SIZE * 0.94).toFixed(2);

  if (winners.length === 1) {
    console.log(`PASS: exactly 1 winner (${winners[0].label}) with payout $${winners[0].msg.payout}`);
    if (Math.abs(winners[0].msg.payout - expectedPayout) < 0.01) {
      console.log(`PASS: payout = $${expectedPayout} (pot $${STAKE * PARTY_SIZE} - 6% fee)`);
    } else {
      console.log(`FAIL: expected payout $${expectedPayout}, got $${winners[0].msg.payout}`);
    }
    // Winner should have the smallest reaction delay (180 ms by design).
    if (winners[0].label === 'A') console.log('PASS: fastest player won');
    else console.log(`NOTE: winner was ${winners[0].label}, reaction order: ${reactions.join(',')}`);
  } else {
    console.log(`FAIL: expected 1 winner, got ${winners.length}`);
  }

  process.exit(0);
})();

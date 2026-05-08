// End-to-end smoke test for OCTAGON Battle Royale.
// Three clients queue at $5 stake, party of 3. Each round each client
// picks a random offered octagon and locks in. Eventually one player wins
// (or everyone gets eliminated together → split).
const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';

function makeClient(label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let me = null;
    let cfg = null;

    function s(type, data = {}) { ws.send(JSON.stringify({ type, ...data })); }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) { console.log(`[${label}] parse error`); return; }

      switch (msg.type) {
        case 'hello':
          me = msg.playerId;
          cfg = msg.config && msg.config.octagon;
          // Top up so we can afford the $5 stake (we start with $500 anyway)
          s('matchmaking.join', { game: 'octagon', stake: 5, partySize: 3 });
          break;
        case 'matchmaking.queued':
          console.log(`[${label}] queued ${msg.waiting}/${msg.needed}`);
          break;
        case 'octagon.match_start':
          console.log(`[${label}] match start (round ${msg.round}, alive ${msg.aliveCount}/${msg.totalPlayers})`);
          // Acknowledge we're ready
          setTimeout(() => s('octagon.ready'), 60);
          break;
        case 'octagon.round_begin': {
          const opts = (msg.octagons || []).map(o => o.id).join(',');
          console.log(`[${label}] round ${msg.round} begin · choices: ${opts} · alive ${msg.aliveCount}`);
          if (!msg.youAlive) break;
          // Pick a random offered octagon
          const choice = msg.octagons[Math.floor(Math.random() * msg.octagons.length)];
          setTimeout(() => s('octagon.lock_choice', { octagonId: choice.id }), 30 + Math.random() * 100);
          break;
        }
        case 'octagon.round_result': {
          const r = msg.reveal;
          console.log(`[${label}] round ${r.round} result: target=${r.target} · eliminated=${r.eliminated.length} · alive=${msg.aliveCount}`);
          break;
        }
        case 'octagon.match_result': {
          console.log(`[${label}] MATCH RESULT youWon=${msg.youWon} split=${msg.isSplit} payout=${msg.yourPayout} balance=${msg.balance} rounds=${msg.rounds}`);
          ws.close();
          resolve({ label, msg });
          break;
        }
        case 'octagon.error':
          console.log(`[${label}] octagon.error: ${msg.reason}`);
          break;
        case 'matchmaking.error':
          console.log(`[${label}] mm.error: ${msg.reason}`);
          ws.close();
          resolve({ label, msg });
          break;
      }
    });
  });
}

(async () => {
  console.log('--- Octagon: 3-player battle royale at $5 stake ---');
  const r = await Promise.all([
    makeClient('A'),
    makeClient('B'),
    makeClient('C'),
  ]);

  const winners = r.filter(x => x.msg.youWon);
  const expectedShare = winners.length > 0 ? +(15 * 0.94 / winners.length).toFixed(2) : 0;

  console.log(`\n${winners.length} winner(s): ${winners.map(w => w.label).join(', ')} · split share = $${expectedShare}`);

  if (winners.length === 0) {
    console.log('FAIL: no winner emerged');
  } else if (winners.length === 1) {
    if (winners[0].msg.yourPayout === 14.10) {
      console.log('PASS: single survivor took $14.10 (pot $15 - 6% fee)');
    } else {
      console.log(`UNEXPECTED: single survivor payout was ${winners[0].msg.yourPayout} (expected 14.10)`);
    }
  } else {
    // split — N winners share $14.10 equally
    const expected = +(14.10 / winners.length).toFixed(2);
    const actuals = winners.map(w => w.msg.yourPayout);
    if (actuals.every(p => Math.abs(p - expected) < 0.02)) {
      console.log(`PASS: split among ${winners.length} winners, each got ~$${expected}`);
    } else {
      console.log(`FAIL: split payouts mismatched. expected ${expected}, got ${actuals}`);
    }
  }

  process.exit(0);
})();

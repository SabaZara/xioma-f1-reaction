// End-to-end smoke test for the Battleship game.
// Two clients queue for the same arena, lock placements, then play
// rounds shooting random unshot cells until one fleet sinks.
const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';

function makeClient(label, arenaId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let me = null;
    let myShipsCells = [];
    let oppShotsAtMe = [];
    const myShotsAtOpp = []; // [{x,y,hit,sunkShipId}]
    let arenaInfo = null;

    function s(type, data = {}) { ws.send(JSON.stringify({ type, ...data })); }

    function pickRandomTarget(boardSize) {
      const taken = new Set(myShotsAtOpp.map(t => `${t.x},${t.y}`));
      while (true) {
        const x = Math.floor(Math.random() * boardSize);
        const y = Math.floor(Math.random() * boardSize);
        if (!taken.has(`${x},${y}`)) return { x, y };
      }
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) { console.log(`[${label}] parse error: ${e.message}, data length=${data.length}`); return; }
      switch (msg.type) {
        case 'hello':
          me = msg.playerId;
          arenaInfo = msg.config.battleship;
          // Top up if needed
          s('wallet.deposit', { amount: 200 });
          break;
        case 'wallet.update':
          s('matchmaking.join', { game: 'battleship', arenaId });
          break;
        case 'matchmaking.queued':
          console.log(`[${label}] queued for battleship ${arenaId}`);
          break;
        case 'battleship.state':
          console.log(`[${label}] state=${msg.state} youLocked=${msg.you.placementLocked} oppLocked=${msg.opponent.placementLocked} round=${msg.round}`);
          if (msg.state === 'placing' && !msg.you.placementLocked) {
            myShipsCells = msg.you.ships.flatMap(s => s.cells);
            setTimeout(() => s('battleship.lock_placement'), 50 + Math.random() * 100);
          }
          break;
        case 'battleship.combat_begin':
          console.log(`[${label}] combat_begin round=${msg.round}`);
          // Lock the first shot
          {
            const t = pickRandomTarget(arenaInfo.boardSize);
            setTimeout(() => s('battleship.lock_shot', t), 50 + Math.random() * 200);
          }
          break;
        case 'battleship.round_result': {
          const r = msg.reveal;
          if (r && r.yourShot && r.yourShot.x != null) {
            myShotsAtOpp.push({ x: r.yourShot.x, y: r.yourShot.y, hit: r.yourShot.hit, sunkShipId: r.yourShot.sunkShipId });
          }
          if (msg.winnerId || msg.isVoid) break;
          // Lock next shot
          const t = pickRandomTarget(arenaInfo.boardSize);
          setTimeout(() => s('battleship.lock_shot', t), 30 + Math.random() * 80);
          break;
        }
        case 'battleship.match_result': {
          console.log(`[${label}] MATCH RESULT youWon=${msg.youWon} balance=${msg.balance} rounds=${msg.rounds} void=${!!msg.isVoid}`);
          ws.close();
          resolve({ label, msg });
          break;
        }
        case 'battleship.error':
          console.log(`[${label}] error: ${msg.reason}`);
          break;
        case 'matchmaking.error':
          console.log(`[${label}] mm error: ${msg.reason}`);
          ws.close();
          resolve({ label, msg });
          break;
      }
    });
    ws.on('error', (e) => console.log(`[${label}] ws error`, e.message));
  });
}

(async () => {
  console.log('--- Battleship: two clients, full match, $5 stake (Bay of Biscay) ---');
  const r = await Promise.all([
    makeClient('A', 'biscay'),
    makeClient('B', 'biscay'),
  ]);
  const winner = r.find(x => x.msg.youWon);
  const loser = r.find(x => !x.msg.youWon && !x.msg.isVoid);

  if (winner && loser) {
    console.log(`PASS: ${winner.label} won battleship, payout=$${winner.msg.payout}`);
    if (winner.msg.payout === 9.4) console.log('PASS: payout = $9.40 (pot $10 - 6% fee)');
    else console.log(`FAIL: expected payout 9.4, got ${winner.msg.payout}`);
  } else {
    console.log('FAIL: no clean winner. results:', r.map(x => x.msg));
  }

  process.exit(0);
})();

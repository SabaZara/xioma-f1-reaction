// End-to-end smoke tests across all play modes.
const WebSocket = require('ws');
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';

function makeClient(label, plan) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const log = (...a) => console.log(`[${label}]`, ...a);
    let me = null;
    let inputSent = false;
    let roundToken = null;
    const events = [];
    let depositDone = false;

    function maybePlay() {
      if (plan.kind === 'pvp') ws.send(JSON.stringify({ type: 'matchmaking.join', stake: plan.stake }));
      else if (plan.kind === 'bot') ws.send(JSON.stringify({ type: 'play.bot', stake: plan.stake }));
      else if (plan.kind === 'solo') ws.send(JSON.stringify({ type: 'play.solo' }));
    }

    ws.on('open', () => log('connected'));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      events.push(msg.type);
      switch (msg.type) {
        case 'hello':
          me = msg.playerId;
          log('hello id=', me.slice(-6), 'balance=', msg.balance);
          if (plan.deposit) {
            ws.send(JSON.stringify({ type: 'wallet.deposit', amount: plan.deposit }));
          } else {
            maybePlay();
          }
          break;
        case 'wallet.update':
          log('wallet=', msg.balance);
          if (!depositDone) { depositDone = true; maybePlay(); }
          break;
        case 'matchmaking.queued':
          log('queued for $' + msg.stake);
          break;
        case 'match.start':
          log('match start mode=', msg.mode, 'vs', msg.opponent.name, 'pot=', msg.pot);
          break;
        case 'countdown.begin':
          roundToken = msg.roundToken;
          inputSent = false;
          if (plan.action === 'false-start') {
            setTimeout(() => {
              if (!inputSent) {
                inputSent = true;
                ws.send(JSON.stringify({ type: 'player.input', roundToken, clientTs: Date.now() }));
              }
            }, 200);
          }
          break;
        case 'lights.green':
          if (plan.action === 'fast' || plan.action === 'slow') {
            const d = plan.action === 'fast' ? 80 : 280;
            setTimeout(() => {
              if (!inputSent) {
                inputSent = true;
                ws.send(JSON.stringify({ type: 'player.input', roundToken, clientTs: Date.now() }));
              }
            }, d);
          }
          break;
        case 'match.result':
          log('RESULT mode=', msg.mode, 'youWon=', msg.youWon, 'payout=', msg.payout, 'balance=', msg.balance,
              msg.personalBest ? `PB=${Math.round(msg.personalBest)}ms` : '');
          ws.close();
          resolve({ label, msg, events });
          break;
        case 'match.refund':
          log('REFUND', msg.reason); ws.close();
          resolve({ label, msg, events });
          break;
      }
    });
  });
}

(async () => {
  console.log('--- TEST 1: PvP fast vs slow ---');
  const r1 = await Promise.all([
    makeClient('A', { kind: 'pvp', stake: 10, action: 'fast' }),
    makeClient('B', { kind: 'pvp', stake: 10, action: 'slow' }),
  ]);
  const w1 = r1.find(r => r.msg.youWon);
  console.log('=>', w1 && w1.label, 'wins, payout', w1 && w1.msg.payout);
  console.log(w1 && w1.label === 'A' && w1.msg.payout === 18.8 ? 'PASS' : 'FAIL');

  console.log('\n--- TEST 2: PvP false-start vs valid ---');
  const r2 = await Promise.all([
    makeClient('A', { kind: 'pvp', stake: 10, action: 'false-start' }),
    makeClient('B', { kind: 'pvp', stake: 10, action: 'fast' }),
  ]);
  const w2 = r2.find(r => r.msg.youWon);
  console.log('=>', w2 && w2.label, 'wins by walkover');
  console.log(w2 && w2.label === 'B' ? 'PASS' : 'FAIL');

  console.log('\n--- TEST 3: Bot match (player taps fast) ---');
  const r3 = await makeClient('Solo-Player', { kind: 'bot', stake: 5, action: 'fast' });
  console.log('=>', r3.msg.mode, 'youWon=', r3.msg.youWon, 'balance=', r3.msg.balance);
  console.log(r3.msg.mode === 'bot' ? 'PASS: bot match resolved' : 'FAIL');

  console.log('\n--- TEST 4: Solo time-attack ---');
  const r4 = await makeClient('TA', { kind: 'solo', action: 'fast' });
  console.log('=>', r4.msg.mode, 'youWon=', r4.msg.youWon, 'PB=', r4.msg.personalBest);
  console.log(r4.msg.mode === 'solo' && r4.msg.personalBest != null ? 'PASS: solo PB recorded' : 'FAIL');

  console.log('\n--- TEST 5: Wallet deposit ---');
  const r5 = await makeClient('Buyer', { kind: 'bot', stake: 100, action: 'fast', deposit: 1000 });
  console.log('=>', 'final balance', r5.msg.balance);
  console.log(r5.msg.balance >= 1400 ? 'PASS: deposit credited and bot match played' : 'FAIL');

  process.exit(0);
})();

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const CONFIG = {
  feePercent: 0.06,
  greenLightMinMs: 2000,
  greenLightMaxMs: 5500,
  reactionTimeoutMs: 4000,
  maxFalseStartRetries: 3,
  defaultStartingBalance: 500,
  stakeTiers: [1, 5, 10, 25, 50, 100],
  depositPresets: [50, 100, 250, 500, 1000],
  // Bot reaction profile (ms). Random within range; ~3% false-start chance.
  bot: {
    minMs: 180,
    maxMs: 320,
    falseStartChance: 0.03,
    timeoutChance: 0.005,
  },
  // Daily challenge: fixed seed per UTC day
  dailyTargetMs: 220,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/healthz') {
    return send(res, 200, JSON.stringify({
      ok: true,
      players: players.size,
      matches: matches.size,
      queues: [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    }), { 'Content-Type': MIME['.json'] });
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
});

const wss = new WebSocketServer({ server: httpServer });

const players = new Map();
const queues = new Map();
const matches = new Map();
const leaderboard = []; // { name, fastest, when }

function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function randomGreenDelay(seedHex) {
  let t;
  if (seedHex) {
    const buf = Buffer.from(seedHex.slice(0, 8), 'hex');
    t = buf.readUInt32BE(0) / 0xffffffff;
  } else {
    t = crypto.randomBytes(4).readUInt32BE(0) / 0xffffffff;
  }
  return Math.round(CONFIG.greenLightMinMs + t * (CONFIG.greenLightMaxMs - CONFIG.greenLightMinMs));
}

function send_ws(ws, type, data = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function broadcastMatch(match, type, data = {}) {
  for (const p of match.players) {
    if (p.isBot) continue;
    send_ws(p.ws, type, data);
  }
}

function getQueue(stake) {
  return getQueueByKey(queueKey(stake));
}

function queueKey(stake, room = '') {
  const normalizedRoom = normalizeRoom(room);
  return normalizedRoom ? `${stake}:room:${normalizedRoom}` : `${stake}:public`;
}

function normalizeRoom(room) {
  return String(room || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}

function getQueueByKey(key) {
  if (!queues.has(key)) queues.set(key, []);
  return queues.get(key);
}

function removeFromAllQueues(playerId) {
  for (const [, q] of queues) {
    const idx = q.findIndex(p => p.id === playerId);
    if (idx !== -1) q.splice(idx, 1);
  }
}

function tryMatchmake(stake, room = '') {
  const q = getQueueByKey(queueKey(stake, room));
  while (q.length >= 2) {
    const a = q.shift();
    const b = q.shift();
    if (!a.ws || a.ws.readyState !== a.ws.OPEN) { q.unshift(b); continue; }
    if (!b.ws || b.ws.readyState !== b.ws.OPEN) { q.unshift(a); continue; }
    if (a.balance < stake || b.balance < stake) {
      if (a.balance < stake) send_ws(a.ws, 'matchmaking.error', { reason: 'insufficient_funds' });
      else q.unshift(a);
      if (b.balance < stake) send_ws(b.ws, 'matchmaking.error', { reason: 'insufficient_funds' });
      else q.unshift(b);
      continue;
    }
    createMatch(a, b, stake, 'pvp');
  }
}

function makeBotPlayer(opponentName) {
  return {
    id: newId('bot'),
    isBot: true,
    name: pickBotName(opponentName),
    balance: 1e9,
    matchId: null,
  };
}

const BOT_NAMES = ['Stratos', 'Vortex', 'Ronin', 'Helix', 'Phantom', 'Apex', 'Echo', 'Nova', 'Raven', 'Cipher', 'Lynx', 'Onyx', 'Wraith', 'Drift'];
function pickBotName(avoid) {
  let n;
  do { n = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; } while (n === avoid);
  return `${n}-${Math.floor(Math.random()*99+10)}`;
}

function createMatch(a, b, stake, mode) {
  if (a && !a.isBot && stake > 0) a.balance -= stake;
  if (b && !b.isBot && stake > 0) b.balance -= stake;
  const matchId = newId('m');
  const match = {
    id: matchId,
    mode, // 'pvp' | 'bot' | 'solo'
    stake,
    pot: mode === 'solo' ? stake : stake * 2,
    feePercent: mode === 'solo' ? 0 : CONFIG.feePercent,
    feeAmount: mode === 'solo' ? 0 : +(stake * 2 * CONFIG.feePercent).toFixed(2),
    payout: mode === 'solo' ? 0 : +(stake * 2 * (1 - CONFIG.feePercent)).toFixed(2),
    players: [a, b].filter(Boolean),
    state: 'ready',
    falseStartRetries: 0,
    seed: crypto.randomBytes(8).toString('hex'),
    createdAt: Date.now(),
    rematchVotes: new Set(),
    history: [],
  };
  matches.set(matchId, match);
  for (const p of match.players) p.matchId = matchId;

  for (const p of match.players) {
    if (p.isBot) continue;
    const opp = match.players.find(x => x.id !== p.id) || { id: 'solo', name: 'TIME-ATTACK' };
    send_ws(p.ws, 'match.start', {
      matchId, mode, stake,
      pot: match.pot,
      feePercent: match.feePercent,
      feeAmount: match.feeAmount,
      payout: match.payout,
      you: { id: p.id, name: p.name, livery: p.livery || 'red' },
      opponent: { id: opp.id, name: opp.name, livery: (opp.livery || (mode === 'pvp' ? 'blue' : (mode === 'bot' ? 'silver' : 'ghost'))) },
      balance: p.balance,
    });
  }

  setTimeout(() => beginRound(match), 1500);
}

function startSoloMatch(player) {
  // Time-attack: no opponent, no money, just personal best.
  createMatch(player, null, 0, 'solo');
}

function startBotMatch(player, stake) {
  const bot = makeBotPlayer(player.name);
  createMatch(player, bot, stake, 'bot');
}

function scheduleBotInput(match, bot) {
  const greenDelay = match.greenLightDelayMs;
  const cfg = CONFIG.bot;
  const action = Math.random();
  if (action < cfg.falseStartChance) {
    // Bot false-starts during the random wait
    const earlyAt = greenDelay - Math.floor(Math.random() * 400 + 100);
    if (earlyAt > 200) {
      const t = setTimeout(() => simulateBotInput(match, bot, true), earlyAt);
      match.botTimers.push(t);
      return;
    }
  }
  if (action < cfg.falseStartChance + cfg.timeoutChance) {
    return; // Bot doesn't react in time
  }
  const reaction = Math.floor(cfg.minMs + Math.random() * (cfg.maxMs - cfg.minMs));
  const at = greenDelay + reaction;
  const t = setTimeout(() => simulateBotInput(match, bot, false, reaction), at);
  match.botTimers.push(t);
}

function simulateBotInput(match, bot, isFalseStart, reaction) {
  if (!matches.has(match.id)) return;
  if (match.state === 'resolved' || match.state === 'voided') return;
  if (match.inputs.has(bot.id)) return;
  const serverTs = Date.now();
  if (isFalseStart) {
    match.inputs.set(bot.id, {
      playerId: bot.id, isFalseStart: true, reactionTime: null,
      inputTimestampClient: null, inputTimestampServer: serverTs,
    });
    broadcastMatch(match, 'player.falseStart', { playerId: bot.id });
    finalizeRound(match, { walkoverFalseStarter: bot.id });
    return;
  }
  match.inputs.set(bot.id, {
    playerId: bot.id, isFalseStart: false, reactionTime: reaction,
    inputTimestampClient: serverTs, inputTimestampServer: serverTs,
  });
  if (match.inputs.size >= match.players.length) finalizeRound(match);
}

function beginRound(match) {
  if (!matches.has(match.id)) return;
  match.state = 'countdown';
  match.inputs = new Map();
  match.greenAtServer = null;
  match.greenLightDelayMs = randomGreenDelay();
  match.roundToken = newId('rt');
  match.countdownStart = Date.now();
  match.botTimers = [];
  match.history.push({ event: 'countdown.begin', at: match.countdownStart });

  broadcastMatch(match, 'countdown.begin', {
    matchId: match.id,
    roundToken: match.roundToken,
    serverNow: Date.now(),
  });

  // Bot scheduling
  for (const p of match.players) {
    if (p.isBot) scheduleBotInput(match, p);
  }

  match.greenTimer = setTimeout(() => fireGreenLight(match), match.greenLightDelayMs);

  match.timeoutTimer = setTimeout(() => {
    if (match.state === 'green' || match.state === 'awaiting_inputs') {
      finalizeRound(match, { reason: 'timeout' });
    }
  }, match.greenLightDelayMs + CONFIG.reactionTimeoutMs);
}

function fireGreenLight(match) {
  if (!matches.has(match.id)) return;
  if (match.state === 'resolved' || match.state === 'voided') return;
  match.state = 'green';
  match.greenAtServer = Date.now();
  match.history.push({ event: 'lights.green', at: match.greenAtServer });
  broadcastMatch(match, 'lights.green', {
    matchId: match.id,
    serverNow: match.greenAtServer,
  });
}

function recordInput(match, player, clientTs) {
  if (match.inputs.has(player.id)) return;
  const serverTs = Date.now();
  const isFalseStart = match.state !== 'green' || serverTs < match.greenAtServer;
  const reactionTime = isFalseStart ? null : Math.max(0, serverTs - match.greenAtServer);
  match.inputs.set(player.id, {
    playerId: player.id,
    inputTimestampClient: clientTs,
    inputTimestampServer: serverTs,
    isFalseStart,
    reactionTime,
  });

  if (isFalseStart) {
    broadcastMatch(match, 'player.falseStart', { playerId: player.id });
    finalizeRound(match, { walkoverFalseStarter: player.id });
    return;
  }

  if (match.mode === 'solo' || match.inputs.size >= match.players.length) {
    finalizeRound(match);
  } else {
    match.state = 'awaiting_inputs';
  }
}

function finalizeRound(match, opts = {}) {
  if (match.state === 'resolved' || match.state === 'voided') return;
  if (match.greenTimer) clearTimeout(match.greenTimer);
  if (match.timeoutTimer) clearTimeout(match.timeoutTimer);
  if (match.botTimers) match.botTimers.forEach(clearTimeout);

  // SOLO: just record the time, no winner logic
  if (match.mode === 'solo') {
    const p = match.players[0];
    const inp = match.inputs.get(p.id);
    const isFault = !inp || inp.isFalseStart || (inp.reactionTime == null);
    match.state = 'resolved';

    let bestPersonal = null;
    if (!isFault) {
      const stats = getStats(p);
      if (!stats.fastestSolo || inp.reactionTime < stats.fastestSolo) {
        stats.fastestSolo = inp.reactionTime;
        bestPersonal = inp.reactionTime;
        // Leaderboard
        leaderboard.push({ name: p.name, time: inp.reactionTime, when: Date.now() });
        leaderboard.sort((a, b) => a.time - b.time);
        if (leaderboard.length > 25) leaderboard.length = 25;
      }
      stats.solo.runs += 1;
      stats.solo.sumMs += inp.reactionTime;
      stats.solo.bestMs = Math.min(stats.solo.bestMs || Infinity, inp.reactionTime);
    } else {
      const stats = getStats(p);
      stats.solo.falseStarts += 1;
    }

    send_ws(p.ws, 'match.result', {
      matchId: match.id,
      mode: 'solo',
      winnerId: null,
      youWon: !isFault,
      pot: 0, feeAmount: 0, payout: 0,
      times: { [p.id]: inp || { reactionTime: null, isFalseStart: false, timedOut: true } },
      players: { [p.id]: { name: p.name } },
      balance: p.balance,
      seed: match.seed,
      personalBest: bestPersonal,
      stats: snapshotStats(p),
      leaderboard: leaderboard.slice(0, 10),
    });
    cleanupMatch(match);
    return;
  }

  const [pA, pB] = match.players;
  const fsId = opts.walkoverFalseStarter || null;
  const isTimeout = opts.reason === 'timeout';

  const fillMissing = (player) => {
    if (!match.inputs.has(player.id)) {
      const isWalkover = fsId && player.id !== fsId;
      match.inputs.set(player.id, {
        playerId: player.id,
        inputTimestampClient: null,
        inputTimestampServer: null,
        isFalseStart: false,
        reactionTime: null,
        timedOut: isTimeout && !isWalkover,
        walkover: !!isWalkover,
      });
    }
  };
  fillMissing(pA);
  fillMissing(pB);

  const ia = match.inputs.get(pA.id);
  const ib = match.inputs.get(pB.id);

  const aFault = ia.isFalseStart || (ia.timedOut && !ia.walkover);
  const bFault = ib.isFalseStart || (ib.timedOut && !ib.walkover);

  if (aFault && bFault) {
    match.falseStartRetries += 1;
    if (match.falseStartRetries >= CONFIG.maxFalseStartRetries) {
      voidAndRefund(match, 'repeated_false_starts');
      return;
    }
    match.state = 'void_round';
    broadcastMatch(match, 'round.void', {
      matchId: match.id,
      reason: 'both_invalid',
      retry: match.falseStartRetries,
    });
    setTimeout(() => beginRound(match), 1500);
    return;
  }

  let winnerId;
  if (aFault) winnerId = pB.id;
  else if (bFault) winnerId = pA.id;
  else if (ia.reactionTime < ib.reactionTime) winnerId = pA.id;
  else if (ib.reactionTime < ia.reactionTime) winnerId = pB.id;
  else if (ia.inputTimestampServer < ib.inputTimestampServer) winnerId = pA.id;
  else if (ib.inputTimestampServer < ia.inputTimestampServer) winnerId = pB.id;
  else {
    const seedNum = parseInt(match.seed.slice(0, 8), 16);
    winnerId = (seedNum & 1) ? pA.id : pB.id;
  }

  const winner = match.players.find(p => p.id === winnerId);
  if (!winner.isBot) winner.balance += match.payout;

  match.state = 'resolved';
  for (const p of match.players) {
    if (p.isBot) continue;
    const isWinner = p.id === winnerId;
    const stats = getStats(p);
    if (match.mode === 'pvp') {
      stats.pvp.played += 1;
      if (isWinner) { stats.pvp.wins += 1; stats.pvp.netProfit += match.payout - match.stake; }
      else { stats.pvp.losses += 1; stats.pvp.netProfit -= match.stake; }
    } else if (match.mode === 'bot') {
      stats.bot.played += 1;
      if (isWinner) { stats.bot.wins += 1; stats.bot.netProfit += match.payout - match.stake; }
      else { stats.bot.losses += 1; stats.bot.netProfit -= match.stake; }
    }
    const myInp = match.inputs.get(p.id);
    if (myInp.isFalseStart) stats.falseStarts += 1;
    if (myInp.reactionTime != null) {
      stats.bestReactionMs = Math.min(stats.bestReactionMs || Infinity, myInp.reactionTime);
    }
    stats.matchHistory.unshift({
      mode: match.mode,
      stake: match.stake,
      youWon: isWinner,
      yourTime: myInp.reactionTime,
      yourFalse: myInp.isFalseStart,
      payout: isWinner ? match.payout : 0,
      net: isWinner ? (match.payout - match.stake) : -match.stake,
      opponentName: match.players.find(x => x.id !== p.id).name,
      at: Date.now(),
    });
    if (stats.matchHistory.length > 25) stats.matchHistory.length = 25;

    send_ws(p.ws, 'match.result', {
      matchId: match.id,
      mode: match.mode,
      winnerId,
      youWon: isWinner,
      pot: match.pot,
      feeAmount: match.feeAmount,
      payout: isWinner ? match.payout : 0,
      stakeRefunded: 0,
      times: {
        [pA.id]: { reactionTime: ia.reactionTime, falseStart: ia.isFalseStart, timedOut: !!ia.timedOut, walkover: !!ia.walkover },
        [pB.id]: { reactionTime: ib.reactionTime, falseStart: ib.isFalseStart, timedOut: !!ib.timedOut, walkover: !!ib.walkover },
      },
      players: {
        [pA.id]: { name: pA.name },
        [pB.id]: { name: pB.name },
      },
      balance: p.balance,
      seed: match.seed,
      stats: snapshotStats(p),
    });
  }

  // Free players to start new matches. Keep the match record around briefly
  // so rematch.request can still find it via lastMatchId.
  for (const p of match.players) {
    if (p.matchId === match.id) {
      p.lastMatchId = match.id;
      p.matchId = null;
    }
  }
  setTimeout(() => matches.delete(match.id), 30000);
  if (match.greenTimer) clearTimeout(match.greenTimer);
  if (match.timeoutTimer) clearTimeout(match.timeoutTimer);
  if (match.botTimers) match.botTimers.forEach(clearTimeout);
}

function getStats(player) {
  if (!player.stats) {
    player.stats = {
      pvp: { played: 0, wins: 0, losses: 0, netProfit: 0 },
      bot: { played: 0, wins: 0, losses: 0, netProfit: 0 },
      solo: { runs: 0, sumMs: 0, bestMs: Infinity, falseStarts: 0 },
      falseStarts: 0,
      bestReactionMs: Infinity,
      matchHistory: [],
      transactions: [{ kind: 'opening', amount: CONFIG.defaultStartingBalance, at: Date.now(), label: 'Welcome credit' }],
    };
  }
  return player.stats;
}

function snapshotStats(player) {
  const s = getStats(player);
  const totalPlayed = s.pvp.played + s.bot.played;
  const totalWins = s.pvp.wins + s.bot.wins;
  return {
    pvp: s.pvp,
    bot: s.bot,
    solo: {
      runs: s.solo.runs,
      bestMs: s.solo.bestMs === Infinity ? null : s.solo.bestMs,
      avgMs: s.solo.runs ? Math.round(s.solo.sumMs / s.solo.runs) : null,
      falseStarts: s.solo.falseStarts,
    },
    bestReactionMs: s.bestReactionMs === Infinity ? null : s.bestReactionMs,
    falseStarts: s.falseStarts,
    totalPlayed,
    totalWins,
    winRate: totalPlayed ? Math.round((totalWins / totalPlayed) * 100) : 0,
    matchHistory: s.matchHistory.slice(0, 10),
    transactions: s.transactions.slice(0, 20),
  };
}

function voidAndRefund(match, reason) {
  if (match.state === 'voided') return;
  match.state = 'voided';
  for (const p of match.players) {
    if (p.isBot) continue;
    p.balance += match.stake;
    send_ws(p.ws, 'match.refund', {
      matchId: match.id,
      reason,
      refunded: match.stake,
      balance: p.balance,
    });
  }
  cleanupMatch(match);
}

function cleanupMatch(match) {
  if (match.greenTimer) clearTimeout(match.greenTimer);
  if (match.timeoutTimer) clearTimeout(match.timeoutTimer);
  if (match.botTimers) match.botTimers.forEach(clearTimeout);
  for (const p of match.players) {
    if (p.matchId === match.id) p.matchId = null;
  }
  setTimeout(() => matches.delete(match.id), 5000);
}

function handleDisconnect(player) {
  removeFromAllQueues(player.id);
  const matchId = player.matchId;
  if (!matchId) return;
  const match = matches.get(matchId);
  if (!match) return;
  if (match.state === 'resolved' || match.state === 'voided') return;
  const opponent = match.players.find(p => p.id !== player.id);
  if (!opponent || opponent.isBot) { cleanupMatch(match); return; }
  if (match.state === 'ready' || match.state === 'countdown') {
    opponent.balance += match.stake;
    send_ws(opponent.ws, 'match.refund', {
      matchId: match.id,
      reason: 'opponent_disconnected',
      refunded: match.stake,
      balance: opponent.balance,
    });
    match.state = 'voided';
  } else {
    opponent.balance += match.payout;
    send_ws(opponent.ws, 'match.result', {
      matchId: match.id,
      winnerId: opponent.id,
      youWon: true,
      pot: match.pot,
      feeAmount: match.feeAmount,
      payout: match.payout,
      stakeRefunded: 0,
      reason: 'opponent_disconnected',
      times: {},
      players: {
        [opponent.id]: { name: opponent.name },
      },
      balance: opponent.balance,
      seed: match.seed,
      stats: snapshotStats(opponent),
    });
    match.state = 'resolved';
  }
  cleanupMatch(match);
}

function getDailyChallenge() {
  const day = Math.floor(Date.now() / 86400000);
  return { day, target: CONFIG.dailyTargetMs };
}

wss.on('connection', (ws) => {
  const player = {
    id: newId('p'),
    ws,
    name: `Driver-${Math.floor(Math.random() * 9000 + 1000)}`,
    balance: CONFIG.defaultStartingBalance,
    livery: 'red',
    matchId: null,
    lastPing: Date.now(),
  };
  players.set(player.id, player);
  getStats(player);

  send_ws(ws, 'hello', {
    playerId: player.id,
    name: player.name,
    balance: player.balance,
    livery: player.livery,
    serverNow: Date.now(),
    config: {
      feePercent: CONFIG.feePercent,
      stakeTiers: CONFIG.stakeTiers,
      depositPresets: CONFIG.depositPresets,
      reactionTimeoutMs: CONFIG.reactionTimeoutMs,
    },
    stats: snapshotStats(player),
    leaderboard: leaderboard.slice(0, 10),
    daily: getDailyChallenge(),
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type } = msg;

    switch (type) {
      case 'set_name': {
        const n = String(msg.name || '').trim().slice(0, 20);
        if (n) player.name = n;
        send_ws(ws, 'profile', { name: player.name, balance: player.balance, livery: player.livery });
        break;
      }
      case 'set_livery': {
        const allowed = ['red', 'blue', 'silver', 'green', 'yellow', 'magenta'];
        if (allowed.includes(msg.livery)) player.livery = msg.livery;
        send_ws(ws, 'profile', { name: player.name, balance: player.balance, livery: player.livery });
        break;
      }
      case 'wallet.deposit': {
        const amt = Math.max(1, Math.min(10000, Math.round(Number(msg.amount) || 0)));
        if (!amt) { send_ws(ws, 'wallet.error', { reason: 'invalid_amount' }); break; }
        player.balance += amt;
        const stats = getStats(player);
        stats.transactions.unshift({ kind: 'deposit', amount: amt, at: Date.now(), label: 'Demo deposit' });
        if (stats.transactions.length > 50) stats.transactions.length = 50;
        send_ws(ws, 'wallet.update', { balance: player.balance, stats: snapshotStats(player) });
        break;
      }
      case 'wallet.withdraw': {
        const amt = Math.max(1, Math.round(Number(msg.amount) || 0));
        if (amt > player.balance) { send_ws(ws, 'wallet.error', { reason: 'insufficient_funds' }); break; }
        player.balance -= amt;
        const stats = getStats(player);
        stats.transactions.unshift({ kind: 'withdraw', amount: -amt, at: Date.now(), label: 'Demo withdraw' });
        send_ws(ws, 'wallet.update', { balance: player.balance, stats: snapshotStats(player) });
        break;
      }
      case 'ping': {
        send_ws(ws, 'pong', { clientTs: msg.clientTs, serverTs: Date.now() });
        break;
      }
      case 'matchmaking.join': {
        const stake = Number(msg.stake);
        const room = normalizeRoom(msg.room);
        if (!CONFIG.stakeTiers.includes(stake)) {
          send_ws(ws, 'matchmaking.error', { reason: 'invalid_stake' });
          break;
        }
        if (player.balance < stake) {
          send_ws(ws, 'matchmaking.error', { reason: 'insufficient_funds' });
          break;
        }
        if (player.matchId) {
          send_ws(ws, 'matchmaking.error', { reason: 'already_in_match' });
          break;
        }
        removeFromAllQueues(player.id);
        getQueueByKey(queueKey(stake, room)).push(player);
        send_ws(ws, 'matchmaking.queued', { stake, room });
        tryMatchmake(stake, room);
        break;
      }
      case 'play.bot': {
        const stake = Number(msg.stake);
        if (!CONFIG.stakeTiers.includes(stake)) { send_ws(ws, 'matchmaking.error', { reason: 'invalid_stake' }); break; }
        if (player.balance < stake) { send_ws(ws, 'matchmaking.error', { reason: 'insufficient_funds' }); break; }
        if (player.matchId) { send_ws(ws, 'matchmaking.error', { reason: 'already_in_match' }); break; }
        startBotMatch(player, stake);
        break;
      }
      case 'play.solo': {
        if (player.matchId) { send_ws(ws, 'matchmaking.error', { reason: 'already_in_match' }); break; }
        startSoloMatch(player);
        break;
      }
      case 'matchmaking.cancel': {
        removeFromAllQueues(player.id);
        send_ws(ws, 'matchmaking.cancelled', {});
        break;
      }
      case 'player.input': {
        if (!player.matchId) break;
        const match = matches.get(player.matchId);
        if (!match) break;
        if (msg.roundToken !== match.roundToken) break;
        if (match.state !== 'countdown' && match.state !== 'green' && match.state !== 'awaiting_inputs') break;
        recordInput(match, player, Number(msg.clientTs) || Date.now());
        break;
      }
      case 'rematch.request': {
        const lookupId = player.matchId || player.lastMatchId;
        if (!lookupId) break;
        const match = matches.get(lookupId);
        if (!match) break;
        if (match.state !== 'resolved') break;
        // For bot/solo, instant rematch — start a fresh match
        if (match.mode === 'bot' || match.mode === 'solo') {
          if (match.mode === 'bot' && player.balance < match.stake) {
            send_ws(ws, 'rematch.failed', { reason: 'insufficient_funds' });
            break;
          }
          if (match.mode === 'bot') startBotMatch(player, match.stake);
          else startSoloMatch(player);
          break;
        }
        match.rematchVotes.add(player.id);
        broadcastMatch(match, 'rematch.vote', { playerId: player.id, votes: match.rematchVotes.size });
        if (match.rematchVotes.size >= 2) {
          const [pA, pB] = match.players;
          if (pA.balance < match.stake || pB.balance < match.stake) {
            broadcastMatch(match, 'rematch.failed', { reason: 'insufficient_funds' });
            break;
          }
          match.rematchVotes.clear();
          match.state = 'ready';
          match.falseStartRetries = 0;
          pA.balance -= match.stake;
          pB.balance -= match.stake;
          // Reattach players to this match
          pA.matchId = match.id;
          pB.matchId = match.id;
          for (const p of match.players) {
            if (p.isBot) continue;
            const opp = match.players.find(x => x.id !== p.id);
            send_ws(p.ws, 'match.start', {
              matchId: match.id,
              mode: match.mode,
              stake: match.stake,
              pot: match.pot,
              feePercent: match.feePercent,
              feeAmount: match.feeAmount,
              payout: match.payout,
              you: { id: p.id, name: p.name, livery: p.livery || 'red' },
              opponent: { id: opp.id, name: opp.name, livery: opp.livery || 'blue' },
              balance: p.balance,
              isRematch: true,
            });
          }
          setTimeout(() => beginRound(match), 1500);
        }
        break;
      }
      case 'leave_match': {
        if (player.matchId) handleDisconnect(player);
        break;
      }
      case 'request.leaderboard': {
        send_ws(ws, 'leaderboard', { entries: leaderboard.slice(0, 10) });
        break;
      }
      case 'request.stats': {
        send_ws(ws, 'stats', snapshotStats(player));
        break;
      }
    }
  });

  ws.on('close', () => {
    handleDisconnect(player);
    players.delete(player.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`XIOMA F1 Reaction server listening on http://localhost:${PORT}`);
});

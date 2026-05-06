// XIOMA · F1 Reaction — client (v2)
// Server-authoritative. Adds bot/solo modes, wallet, profile, leaderboard, settings.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  ws: null,
  playerId: null,
  name: null,
  livery: 'red',
  balance: 0,
  config: { feePercent: 0.06, stakeTiers: [1,5,10,25,50,100], depositPresets: [50,100,250,500,1000], reactionTimeoutMs: 4000 },
  ping: null,
  serverOffsetMs: 0,
  match: null,
  roundToken: null,
  inputSent: false,
  greenAtServer: null,
  lightsTimers: [],
  pvpStake: null,
  botStake: null,
  roomCode: '',
  audioOn: true,
  stats: null,
  leaderboard: [],
  daily: null,
  page: 'home',
  audioCtx: null,
};

const LIVERIES = ['red','blue','silver','green','yellow','magenta'];

/* ============= boot ============= */
window.addEventListener('DOMContentLoaded', () => {
  initNav();
  initHero();
  initPlay();
  initWallet();
  initSettings();
  initRace();
  connect();
});

/* ============= utilities ============= */
function fmtMoney(n) { return '$' + Number(n).toFixed(2); }
function fmtMs(n) { if (n == null) return '—'; return Math.round(n) + ' ms'; }
function relTime(ts) { const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s/60) + 'm'; if (s < 86400) return Math.floor(s/3600) + 'h'; return Math.floor(s/86400) + 'd'; }
function toast(text, ms = 2400) {
  const el = $('#toast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ============= car SVG ============= */
function makeCarEl(livery) {
  const tpl = $('#f1-car-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const wrapper = document.createElement('div');
  wrapper.className = 'car-wrap livery-' + (livery || 'red');
  wrapper.appendChild(node);
  return wrapper;
}
function setLanesCars(youLivery, oppLivery) {
  const youLane = $('#laneYou');
  const oppLane = $('#laneOpp');
  youLane.innerHTML = ''; youLane.appendChild(makeCarEl(youLivery));
  oppLane.innerHTML = ''; oppLane.appendChild(makeCarEl(oppLivery));
}
function paintHomeScene() {
  $('#sceneCarYou').innerHTML = ''; $('#sceneCarYou').appendChild(makeCarEl(state.livery));
  $('#sceneCarOpp').innerHTML = ''; $('#sceneCarOpp').appendChild(makeCarEl('blue'));
}

/* ============= nav ============= */
function initNav() {
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-nav]');
    if (!target) return;
    e.preventDefault();
    showPage(target.dataset.nav);
  });
}
function showPage(name) {
  state.page = name;
  $$('.page').forEach(p => p.classList.add('hidden'));
  const el = $('#page-' + name);
  if (el) el.classList.remove('hidden');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === name));
  const titles = { home: 'Home', play: 'Play', leaderboard: 'Leaderboard', profile: 'Profile', wallet: 'Wallet', settings: 'Settings' };
  $('#pageTitle').textContent = titles[name] || name;
  if (name === 'leaderboard') send('request.leaderboard');
  if (name === 'profile') send('request.stats');
  if (name === 'home') paintHomeScene();
}

/* ============= hero / home ============= */
function initHero() {
  $$('.quick-card').forEach(c => {
    c.addEventListener('click', () => {
      const m = c.dataset.mode;
      showPage('play');
      activateModeTab(m);
    });
  });
  paintHomeScene();
}

/* ============= play / modes ============= */
function initPlay() {
  $$('.modes-tab').forEach(tab => tab.addEventListener('click', () => activateModeTab(tab.dataset.modetab)));
  $('#btnFindPvP').addEventListener('click', () => {
    if (state.pvpStake == null) return;
    if (state.balance < state.pvpStake) return toast('Insufficient balance — top up in Wallet.');
    send('matchmaking.join', { stake: state.pvpStake, room: state.roomCode });
  });
  $('#btnPlayBot').addEventListener('click', () => {
    if (state.botStake == null) return;
    if (state.balance < state.botStake) return toast('Insufficient balance — top up in Wallet.');
    send('play.bot', { stake: state.botStake });
  });
  $('#btnPlaySolo').addEventListener('click', () => {
    send('play.solo');
  });
  $('#btnCancelMM').addEventListener('click', () => send('matchmaking.cancel'));
  $('#btnQuit').addEventListener('click', () => {
    send('leave_match');
    closeRace();
  });
  initRoomInvite();
}
function activateModeTab(name) {
  $$('.modes-tab').forEach(t => t.classList.toggle('active', t.dataset.modetab === name));
  ['pvp','bot','solo'].forEach(m => {
    $('#modePanel-' + m).classList.toggle('hidden', m !== name);
  });
}

function buildStakeTiers(containerId, onSelect) {
  const wrap = $(containerId);
  wrap.innerHTML = '';
  for (const amt of state.config.stakeTiers) {
    const el = document.createElement('button');
    el.className = 'tier'; el.type = 'button';
    el.innerHTML = `<div class="amt">$${amt}</div><div class="lbl">STAKE</div>`;
    el.addEventListener('click', () => {
      $$('.tier', wrap).forEach(t => t.classList.remove('selected'));
      el.classList.add('selected');
      onSelect(amt);
    });
    wrap.appendChild(el);
  }
}
function updateStakeSummary(stake, prefix) {
  const pot = stake * 2;
  const fee = +(pot * state.config.feePercent).toFixed(2);
  const prize = +(pot - fee).toFixed(2);
  $('#' + prefix + 'Stake').textContent = fmtMoney(stake);
  $('#' + prefix + 'Pot').textContent = fmtMoney(pot);
  $('#' + prefix + 'Fee').textContent = fmtMoney(fee);
  $('#' + prefix + 'Prize').textContent = fmtMoney(prize);
}

function initRoomInvite() {
  const urlRoom = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
  if (urlRoom) setRoomCode(urlRoom, false);

  $('#btnCreateRoom').addEventListener('click', () => {
    const code = makeRoomCode();
    setRoomCode(code, true);
    copyInviteLink();
  });
  $('#btnCopyInvite').addEventListener('click', copyInviteLink);
  $('#btnLeaveRoom').addEventListener('click', () => {
    setRoomCode('', true);
    toast('Back in public queue.');
  });
}

function makeRoomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
}

function normalizeRoomCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}

function setRoomCode(code, updateUrl) {
  state.roomCode = normalizeRoomCode(code);
  $('#roomCodeLabel').textContent = state.roomCode || 'PUBLIC QUEUE';
  $('#btnCopyInvite').disabled = !state.roomCode;
  $('#btnLeaveRoom').classList.toggle('hidden', !state.roomCode);
  if (!updateUrl) return;
  const url = new URL(location.href);
  if (state.roomCode) url.searchParams.set('room', state.roomCode);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

async function copyInviteLink() {
  if (!state.roomCode) return;
  const url = new URL(location.href);
  url.searchParams.set('room', state.roomCode);
  try {
    await navigator.clipboard.writeText(url.toString());
    toast('Invite link copied.');
  } catch {
    prompt('Invite link', url.toString());
  }
}

/* ============= wallet ============= */
function initWallet() {
  $('#btnDeposit').addEventListener('click', () => doDeposit(100));
  $('#btnWithdraw').addEventListener('click', () => {
    const amt = prompt('Withdraw amount? (demo)', '50');
    const n = parseInt(amt, 10);
    if (n > 0) send('wallet.withdraw', { amount: n });
  });
  $('#btnCustomDeposit').addEventListener('click', () => {
    const v = parseInt($('#customAmount').value, 10);
    if (v > 0) doDeposit(v);
    $('#customAmount').value = '';
  });
}
function doDeposit(amt) { send('wallet.deposit', { amount: amt }); }
function paintWallet() {
  $('#balanceBig').textContent = fmtMoney(state.balance);
  // presets
  const wrap = $('#depositPresets'); wrap.innerHTML = '';
  for (const v of state.config.depositPresets) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'preset';
    b.textContent = '+$' + v;
    b.addEventListener('click', () => doDeposit(v));
    wrap.appendChild(b);
  }
  // tx list
  const tx = (state.stats && state.stats.transactions) || [];
  const list = $('#txList');
  if (!tx.length) { list.innerHTML = '<div class="tx-empty">No transactions yet.</div>'; return; }
  list.innerHTML = '';
  for (const t of tx) {
    const row = document.createElement('div');
    row.className = 'tx-row';
    const positive = t.amount > 0;
    row.innerHTML = `
      <div class="tx-kind ${t.kind}">${t.kind.toUpperCase()}</div>
      <div>${t.label || ''} <span style="color:var(--ink-3); font-size:11px;">· ${relTime(t.at)} ago</span></div>
      <div class="tx-amount ${positive ? 'pos' : 'neg'}">${positive ? '+' : ''}${fmtMoney(t.amount)}</div>`;
    list.appendChild(row);
  }
}

/* ============= settings ============= */
function initSettings() {
  // livery picker
  const wrap = $('#liveryPicker'); wrap.innerHTML = '';
  for (const l of LIVERIES) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'livery-swatch livery-' + l;
    sw.style.background = liveryGradient(l);
    sw.dataset.livery = l;
    sw.addEventListener('click', () => {
      send('set_livery', { livery: l });
      paintLiverySelection(l);
    });
    wrap.appendChild(sw);
  }
  $('#settingsName').addEventListener('change', (e) => {
    send('set_name', { name: e.target.value });
  });
  $('#soundToggle').addEventListener('change', (e) => {
    state.audioOn = e.target.checked;
    if (state.audioOn) ensureAudio();
  });
}
function paintLiverySelection(active) {
  $$('.livery-swatch').forEach(s => s.classList.toggle('active', s.dataset.livery === active));
}
function liveryGradient(l) {
  const map = {
    red: 'linear-gradient(135deg, #ff2c3a, #6a0d14)',
    blue: 'linear-gradient(135deg, #5b8cff, #142e6a)',
    silver: 'linear-gradient(135deg, #c8ccd6, #2c2f3a)',
    green: 'linear-gradient(135deg, #2bd47d, #0a4a2c)',
    yellow: 'linear-gradient(135deg, #ffd24a, #6e5611)',
    magenta: 'linear-gradient(135deg, #ff5ec0, #6a1a4d)',
  };
  return map[l] || map.red;
}

/* ============= race init ============= */
function initRace() {
  $('#tapZone').addEventListener('click', sendInput);
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if ($('#overlay-race').classList.contains('hidden')) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    e.preventDefault();
    sendInput();
  });
  $('#btnLobby').addEventListener('click', () => {
    $('#resultModal').classList.add('hidden');
    closeRace();
    showPage('home');
  });
  $('#btnRematch').addEventListener('click', () => {
    $('#resultModal').classList.add('hidden');
    send('rematch.request');
  });
}
function closeRace() {
  $('#overlay-race').classList.add('hidden');
}

/* ============= WS ============= */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;
  ws.addEventListener('open', () => { setInterval(sendPing, 2000); sendPing(); });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleServer(msg);
  });
  ws.addEventListener('close', () => { toast('Disconnected. Reconnecting…'); setTimeout(connect, 1500); });
}
function send(type, data = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type, ...data }));
}
function sendPing() { send('ping', { clientTs: Date.now() }); }

/* ============= server router ============= */
function handleServer(msg) {
  switch (msg.type) {
    case 'hello': {
      state.playerId = msg.playerId;
      state.name = msg.name;
      state.livery = msg.livery || 'red';
      state.balance = msg.balance;
      state.config = { ...state.config, ...msg.config };
      state.stats = msg.stats;
      state.leaderboard = msg.leaderboard || [];
      state.daily = msg.daily;
      $('#nameInput').value = state.name;
      $('#settingsName').value = state.name;
      $('#playerIdShort').textContent = state.playerId.slice(-6).toUpperCase();
      $('#hsFee').textContent = Math.round(state.config.feePercent * 100) + '%';
      $('#pvpFeePct').textContent = Math.round(state.config.feePercent * 100) + '%';
      buildStakeTiers('#pvpTiers', (a) => { state.pvpStake = a; updateStakeSummary(a, 'pvp'); $('#btnFindPvP').disabled = false; });
      buildStakeTiers('#botTiers', (a) => { state.botStake = a; updateStakeSummary(a, 'bot'); $('#btnPlayBot').disabled = false; });
      paintLiverySelection(state.livery);
      paintAvatar();
      paintHomeScene();
      paintWallet();
      paintHomeStats();
      paintHomeHistory();
      paintHomeLeaderboard();
      paintLeaderboardPage();
      paintProfilePage();
      paintSoloStats();
      paintDaily();
      updateTopStrip();
      break;
    }
    case 'pong': {
      const rtt = Date.now() - msg.clientTs;
      state.ping = rtt;
      state.serverOffsetMs = msg.serverTs - (msg.clientTs + rtt / 2);
      $('#pingText').textContent = rtt + ' ms';
      break;
    }
    case 'profile': {
      state.name = msg.name; state.balance = msg.balance; state.livery = msg.livery || state.livery;
      $('#nameInput').value = state.name; $('#settingsName').value = state.name;
      paintAvatar(); updateTopStrip(); paintHomeScene(); paintLiverySelection(state.livery);
      break;
    }
    case 'wallet.update': {
      state.balance = msg.balance; state.stats = msg.stats || state.stats;
      updateTopStrip(); paintWallet();
      toast('Balance updated.');
      break;
    }
    case 'wallet.error': {
      toast(prettyReason(msg.reason)); break;
    }
    case 'stats': {
      state.stats = msg; paintProfilePage(); paintHomeStats(); paintHomeHistory(); paintSoloStats(); paintWallet();
      break;
    }
    case 'leaderboard': {
      state.leaderboard = msg.entries || []; paintLeaderboardPage(); paintHomeLeaderboard();
      break;
    }
    case 'matchmaking.queued': {
      $('#mmStake').textContent = fmtMoney(msg.stake);
      $('#mmRoom').classList.toggle('hidden', !msg.room);
      $('#mmRoomCode').textContent = msg.room || '—';
      $('#overlay-mm').classList.remove('hidden');
      break;
    }
    case 'matchmaking.cancelled': {
      $('#overlay-mm').classList.add('hidden'); break;
    }
    case 'matchmaking.error': {
      $('#overlay-mm').classList.add('hidden');
      toast(prettyReason(msg.reason));
      break;
    }
    case 'match.start': {
      enterMatch(msg);
      break;
    }
    case 'countdown.begin': {
      state.roundToken = msg.roundToken;
      runCountdownLights();
      playBeep('low');
      break;
    }
    case 'lights.green': {
      state.greenAtServer = msg.serverNow;
      onGreenLight();
      playBeep('go');
      break;
    }
    case 'player.falseStart': {
      onFalseStart(msg.playerId); playBeep('bust');
      break;
    }
    case 'round.void': {
      toast(`Round void · both invalid (retry ${msg.retry}/3)`); resetArenaForNextRound(); break;
    }
    case 'match.result': {
      showResult(msg);
      break;
    }
    case 'match.refund': {
      state.balance = msg.balance; updateTopStrip();
      toast(`Refunded ${fmtMoney(msg.refunded)} · ${prettyReason(msg.reason)}`);
      closeRace(); $('#overlay-mm').classList.add('hidden');
      break;
    }
    case 'rematch.vote': {
      if (msg.playerId === state.playerId) toast('Rematch requested.');
      else toast('Opponent wants a rematch.');
      break;
    }
    case 'rematch.failed': {
      toast(prettyReason(msg.reason)); closeRace();
      break;
    }
  }
}

function prettyReason(r) {
  const map = {
    insufficient_funds: 'Insufficient balance.',
    invalid_stake: 'Invalid stake.',
    invalid_amount: 'Invalid amount.',
    already_in_match: 'You are already in a match.',
    opponent_disconnected: 'Opponent disconnected.',
    repeated_false_starts: 'Match cancelled · repeated false starts.',
    both_invalid: 'Both invalid · restarting.',
    timeout: 'Reaction timeout.',
  };
  return map[r] || r;
}

/* ============= top strip + avatar ============= */
function updateTopStrip() {
  $('#walletAmount').textContent = fmtMoney(state.balance);
}
function paintAvatar() {
  $('#profileAvatar').style.background = liveryGradient(state.livery);
}

/* ============= home stats / history / lb ============= */
function paintHomeStats() {
  const s = state.stats; if (!s) return;
  $('#hsBest').textContent = s.bestReactionMs == null ? '—' : Math.round(s.bestReactionMs) + 'ms';
  $('#hsWR').textContent = s.totalPlayed ? s.winRate + '%' : '—';
  $('#hsLive').textContent = '2'; // placeholder
}
function paintDaily() {
  if (!state.daily) return;
  $('#dailyTitle').textContent = `Beat ${state.daily.target} ms`;
  $('#soloDaily').textContent = state.daily.target + ' ms';
}
function paintSoloStats() {
  const s = state.stats; if (!s || !s.solo) return;
  $('#soloBest').textContent = s.solo.bestMs == null ? '—' : Math.round(s.solo.bestMs) + ' ms';
  $('#soloRuns').textContent = s.solo.runs || 0;
  $('#soloAvg').textContent = s.solo.avgMs == null ? '—' : s.solo.avgMs + ' ms';
}
function paintHomeHistory() {
  const list = $('#homeHistory');
  const h = (state.stats && state.stats.matchHistory) || [];
  if (!h.length) { list.innerHTML = '<div class="history-empty">No matches yet. Play your first round.</div>'; return; }
  list.innerHTML = '';
  for (const m of h.slice(0, 5)) list.appendChild(historyRow(m));
}
function paintProfilePage() {
  const s = state.stats; if (!s) return;
  $('#stTotal').textContent = s.totalPlayed || 0;
  $('#stWins').textContent = s.totalWins || 0;
  $('#stWR').textContent = (s.winRate || 0) + '%';
  $('#stBest').textContent = s.bestReactionMs == null ? '—' : Math.round(s.bestReactionMs) + ' ms';
  $('#stPvpNet').textContent = fmtMoney(s.pvp.netProfit || 0);
  $('#stFS').textContent = s.falseStarts || 0;
  $('#prPvp').textContent = `${s.pvp.wins}–${s.pvp.losses}`;
  $('#prPvpNet').textContent = fmtMoney(s.pvp.netProfit || 0);
  $('#prBot').textContent = `${s.bot.wins}–${s.bot.losses}`;
  $('#prBotNet').textContent = fmtMoney(s.bot.netProfit || 0);
  $('#prSolo').textContent = `${s.solo.runs} runs`;
  $('#prSoloBest').textContent = s.solo.bestMs == null ? '— ms best' : Math.round(s.solo.bestMs) + ' ms best';
  // history
  const list = $('#profileHistory');
  if (!s.matchHistory || !s.matchHistory.length) { list.innerHTML = '<div class="history-empty">No matches yet.</div>'; return; }
  list.innerHTML = ''; for (const m of s.matchHistory) list.appendChild(historyRow(m));
}
function historyRow(m) {
  const row = document.createElement('div');
  row.className = 'history-row';
  const won = m.youWon;
  row.innerHTML = `
    <div class="hr-mode ${m.mode}">${m.mode.toUpperCase()}</div>
    <div class="hr-text">vs ${m.opponentName} · ${m.yourFalse ? 'false start' : (m.yourTime != null ? Math.round(m.yourTime) + ' ms' : 'no input')} · ${relTime(m.at)} ago</div>
    <div class="hr-time">${fmtMoney(m.stake)}</div>
    <div class="hr-net ${won ? 'win' : 'lose'}">${won ? '+' : ''}${fmtMoney(m.net)}</div>`;
  return row;
}
function paintHomeLeaderboard() {
  const list = $('#homeLeaderboard');
  if (!state.leaderboard.length) { list.innerHTML = '<div class="lb-empty">No entries yet. Be the first.</div>'; return; }
  list.innerHTML = '';
  state.leaderboard.slice(0, 5).forEach((e, i) => list.appendChild(lbRow(e, i)));
}
function paintLeaderboardPage() {
  const list = $('#leaderboardTable');
  if (!state.leaderboard.length) { list.innerHTML = '<div class="lb-empty">No entries yet. Run a Solo time-attack to claim a spot.</div>'; return; }
  list.innerHTML = ''; state.leaderboard.forEach((e, i) => list.appendChild(lbRow(e, i)));
}
function lbRow(e, i) {
  const r = document.createElement('div'); r.className = 'lb-row';
  const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
  r.innerHTML = `<div class="lb-rank ${rankCls}">#${i+1}</div><div>${e.name}</div><div class="lb-time">${Math.round(e.time)} ms</div>`;
  return r;
}

/* ============= match flow ============= */
function enterMatch(msg) {
  state.match = msg;
  state.balance = msg.balance;
  updateTopStrip();
  $('#overlay-mm').classList.add('hidden');

  $('#youName').textContent = (msg.you.name || 'YOU') + ' · YOU';
  $('#oppName').textContent = msg.opponent.name;
  $('#youStake').textContent = msg.mode === 'solo' ? 'TIME-ATTACK' : fmtMoney(msg.stake);
  $('#oppStake').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.stake);
  $('#youRt').textContent = '—';
  $('#oppRt').textContent = '—';
  $('#hudPot').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.pot);
  $('#hudFee').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.feeAmount);
  $('#hudMode').textContent = msg.mode.toUpperCase();
  $('#hudStatus').textContent = msg.isRematch ? 'REMATCH · GET READY' : 'GET READY';
  $('#hudStatus').className = 'hud-status';

  setLanesCars(msg.you.livery, msg.opponent.livery);
  resetArenaForNextRound();
  $('#overlay-race').classList.remove('hidden');
}

function resetArenaForNextRound() {
  state.inputSent = false;
  state.greenAtServer = null;
  state.lightsTimers.forEach(clearTimeout); state.lightsTimers = [];
  $('#arena').classList.remove('is-armed','is-go','is-finish');
  $$('.lane').forEach(l => l.classList.remove('is-launching','is-loser'));
  $$('.light').forEach(l => l.classList.remove('on','go'));
  $('#tapInstruction').textContent = 'GET READY…';
  $('#hudStatus').className = 'hud-status';
  $('#hudStatus').textContent = 'GET READY';
}

function runCountdownLights() {
  $('#hudStatus').textContent = 'LIGHTS UP'; $('#hudStatus').className = 'hud-status is-armed';
  $('#tapInstruction').textContent = 'TOO EARLY = FALSE START';
  $('#arena').classList.add('is-armed');
  const lights = $$('.light');
  const step = 240;
  for (let i = 0; i < 5; i++) {
    const t = setTimeout(() => { lights[i].classList.add('on'); playBeep('low'); }, 200 + i * step);
    state.lightsTimers.push(t);
  }
}
function onGreenLight() {
  $$('.light').forEach(l => { l.classList.remove('on'); l.classList.add('go'); });
  $('#arena').classList.remove('is-armed'); $('#arena').classList.add('is-go');
  $('#hudStatus').textContent = 'GO!'; $('#hudStatus').className = 'hud-status is-go';
  $('#tapInstruction').textContent = 'TAP NOW';
}
function onFalseStart(playerId) {
  if (playerId === state.playerId) {
    $('#hudStatus').textContent = 'FALSE START';
    $('#tapInstruction').textContent = 'TOO EARLY';
  } else {
    $('#hudStatus').textContent = 'OPPONENT BUSTED';
  }
  $('#hudStatus').className = 'hud-status is-bust';
}
function sendInput() {
  if (state.inputSent) return; state.inputSent = true;
  send('player.input', { roundToken: state.roundToken, clientTs: Date.now() });
}

function showResult(msg) {
  const card = $('#resultCard');
  const me = state.playerId;
  const oppId = Object.keys(msg.times || {}).find(id => id !== me);
  const youLane = $('.lane-you'); const oppLane = $('.lane-opp');
  if (msg.mode === 'solo') {
    youLane.classList.add('is-launching');
  } else if (msg.winnerId) {
    if (msg.youWon) { youLane.classList.add('is-launching'); oppLane.classList.add('is-loser'); }
    else { oppLane.classList.add('is-launching'); youLane.classList.add('is-loser'); }
  }
  setTimeout(() => $('#arena').classList.add('is-finish'), 700);

  setTimeout(() => {
    state.balance = msg.balance; updateTopStrip();
    state.stats = msg.stats || state.stats;
    paintHomeStats(); paintHomeHistory(); paintProfilePage(); paintSoloStats(); paintWallet();
    if (msg.leaderboard) { state.leaderboard = msg.leaderboard; paintLeaderboardPage(); paintHomeLeaderboard(); }

    const myT = (msg.times && msg.times[me]) || {};
    const oppT = oppId ? (msg.times[oppId] || {}) : {};
    $('#rtYouLabel').textContent = (msg.players && msg.players[me] && msg.players[me].name) || 'YOU';
    $('#rtOppLabel').textContent = oppId && msg.players && msg.players[oppId] ? msg.players[oppId].name : (msg.mode === 'solo' ? 'TARGET' : 'OPPONENT');
    $('#rtYou').textContent = formatReaction(myT);
    $('#rtOpp').textContent = msg.mode === 'solo' ? (state.daily ? state.daily.target + ' ms' : '—') : formatReaction(oppT);
    $('#rtYouTag').textContent = reactionTag(myT);
    $('#rtOppTag').textContent = msg.mode === 'solo' ? 'DAILY' : reactionTag(oppT);
    $('#rPot').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.pot);
    $('#rFee').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.feeAmount);
    $('#rPayout').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.payout || 0);
    $('#rSeed').textContent = msg.seed;

    card.classList.remove('win','lose','void','solo-win');
    const youBlock = $('#rtYouBlock'); const oppBlock = $('#rtOppBlock');
    youBlock.classList.remove('win','lose','bust'); oppBlock.classList.remove('win','lose','bust');
    const extra = $('#resultExtra'); extra.classList.remove('show'); extra.innerHTML = '';

    if (msg.mode === 'solo') {
      if (myT.falseStart) {
        card.classList.add('lose'); $('#resultBanner').textContent = 'FALSE START';
        youBlock.classList.add('bust');
      } else if (myT.reactionTime != null) {
        card.classList.add('solo-win');
        $('#resultBanner').textContent = msg.personalBest ? 'NEW PERSONAL BEST' : 'CLEAN RUN';
        youBlock.classList.add('win');
        if (msg.personalBest) { extra.classList.add('show'); extra.innerHTML = `<strong>New best:</strong> ${Math.round(msg.personalBest)} ms.`; }
        playBeep('win');
      } else {
        card.classList.add('void'); $('#resultBanner').textContent = 'NO INPUT';
      }
    } else if (msg.winnerId === me) {
      card.classList.add('win'); $('#resultBanner').textContent = 'YOU WIN';
      youBlock.classList.add('win'); oppBlock.classList.add(oppT.falseStart ? 'bust' : 'lose');
      playBeep('win');
    } else if (msg.winnerId) {
      card.classList.add('lose'); $('#resultBanner').textContent = 'YOU LOSE';
      oppBlock.classList.add('win'); youBlock.classList.add(myT.falseStart ? 'bust' : 'lose');
      playBeep('bust');
    } else {
      card.classList.add('void'); $('#resultBanner').textContent = 'VOID';
    }

    $('#resultModal').classList.remove('hidden');
  }, 1400);
}
function formatReaction(t) {
  if (!t) return '—';
  if (t.falseStart) return 'FALSE START';
  if (t.timedOut && !t.walkover) return 'TIMED OUT';
  if (t.walkover) return 'WALKOVER';
  if (t.reactionTime == null) return '—';
  return Math.round(t.reactionTime) + ' ms';
}
function reactionTag(t) {
  if (!t) return '';
  if (t.falseStart) return 'JUMPED THE START';
  if (t.timedOut && !t.walkover) return 'NO INPUT';
  if (t.walkover) return 'WIN BY DEFAULT';
  return '';
}

/* ============= audio ============= */
function ensureAudio() {
  if (state.audioCtx) return state.audioCtx;
  try { state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  return state.audioCtx;
}
function playBeep(kind) {
  if (!state.audioOn) return;
  const ctx = ensureAudio(); if (!ctx) return;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  const t = ctx.currentTime;
  let freq = 440, dur = 0.08, gain = 0.06, type = 'sine';
  if (kind === 'low') { freq = 600; dur = 0.05; gain = 0.04; type = 'square'; }
  if (kind === 'go') { freq = 880; dur = 0.18; gain = 0.08; type = 'sawtooth'; }
  if (kind === 'win') { freq = 523; dur = 0.25; gain = 0.06; type = 'triangle'; }
  if (kind === 'bust') { freq = 200; dur = 0.3; gain = 0.07; type = 'square'; }
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur);
}

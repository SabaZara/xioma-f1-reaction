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
  config: { feePercent: 0.06, stakeTiers: [1,5,10,25,50,100], depositPresets: [50,100,250,500,1000], reactionTimeoutMs: 4000, partySizes: [3,4,5,6,8] },
  ping: null,
  serverOffsetMs: 0,
  match: null,
  roundToken: null,
  inputSent: false,
  greenAtServer: null,
  lightsTimers: [],
  pvpStake: null,
  botStake: null,
  multiStake: null,
  multiPartySize: 3,
  roomCode: '',
  audioOn: true,
  stats: null,
  leaderboard: [],
  daily: null,
  page: 'home',
  audioCtx: null,
  // Battleship
  bs: {
    arenas: [],
    selectedArenaId: null,
    boardSize: 10,
    fleet: [],
    match: null,        // most recent state snapshot
    pendingTarget: null, // { x, y } picked but not yet locked
  },
  oct: {
    attacker: null,
    minPlayers: 3,
    maxPlayers: 8,
    selectedParty: 3,
    selectedStake: null,
    match: null,         // most recent state snapshot
    pendingChoice: null, // octagonId picked but not yet locked
    timerEndAt: null,
    timerInterval: null,
  },
};

const LIVERIES = [
  { id: 'scuderia',    label: 'Scuderia Rosso',  team: 'Italian Red' },
  { id: 'argent',      label: 'Argent',          team: 'Silver Arrow' },
  { id: 'bavarian',    label: 'Bavarian',        team: 'M-Series Blue' },
  { id: 'granturismo', label: 'Granturismo',     team: 'Papaya Orange' },
  { id: 'astra',       label: 'Astra',           team: 'Racing Green' },
  { id: 'toro',        label: 'Toro',            team: 'Verde Lime' },
  { id: 'stahl',       label: 'Stahl',           team: 'Quattro Red' },
  { id: 'sakura',      label: 'Sakura',          team: 'White & Crimson' },
  { id: 'red',         label: 'Classic Red',     team: 'House' },
  { id: 'blue',        label: 'Classic Blue',    team: 'House' },
  { id: 'silver',      label: 'Classic Silver',  team: 'House' },
  { id: 'green',       label: 'Classic Green',   team: 'House' },
  { id: 'yellow',      label: 'Classic Yellow',  team: 'House' },
  { id: 'magenta',     label: 'Classic Magenta', team: 'House' },
];
const LIVERY_IDS = LIVERIES.map(l => l.id);

/* ============= boot ============= */
window.addEventListener('DOMContentLoaded', () => {
  initNav();
  initHero();
  initPlay();
  initWallet();
  initSettings();
  initRace();
  initBattleship();
  initOctagon();
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
  // Rebuild #carsArena from scratch — guarantees no stale extra lanes left
  // over from a previous multi match.
  const arena = $('#carsArena');
  arena.classList.remove('many-cars');
  arena.style.removeProperty('--lane-count');
  arena.innerHTML = '';
  const youLane = document.createElement('div');
  youLane.id = 'laneYou';
  youLane.className = 'lane lane-you';
  youLane.appendChild(makeCarEl(youLivery));
  const oppLane = document.createElement('div');
  oppLane.id = 'laneOpp';
  oppLane.className = 'lane lane-opp';
  oppLane.appendChild(makeCarEl(oppLivery));
  arena.appendChild(youLane);
  arena.appendChild(oppLane);
}
// Multi-player: rebuild #carsArena with one lane per player so every
// opponent has a visible car. Each lane carries data-player-id so the
// result handler can flag the winner / losers individually.
function setLanesMulti(you, opponents) {
  const arena = $('#carsArena');
  arena.innerHTML = '';
  const total = 1 + opponents.length;
  arena.classList.toggle('many-cars', total > 4);
  arena.style.setProperty('--lane-count', String(total));

  const youLane = document.createElement('div');
  youLane.id = 'laneYou';
  youLane.className = 'lane lane-you';
  youLane.dataset.playerId = you.id;
  youLane.appendChild(makeCarEl(you.livery));
  arena.appendChild(youLane);

  for (let i = 0; i < opponents.length; i++) {
    const opp = opponents[i];
    const lane = document.createElement('div');
    lane.id = i === 0 ? 'laneOpp' : `laneOpp${i}`;
    lane.className = 'lane lane-opp';
    lane.dataset.playerId = opp.id;
    lane.appendChild(makeCarEl(opp.livery));
    arena.appendChild(lane);
  }
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
  const titles = {
    home: 'Home',
    play: 'F1 Reaction',
    battleship: 'Battleship',
    octagon: 'Octagon',
    leaderboard: 'Leaderboard',
    profile: 'Profile',
    wallet: 'Wallet',
    settings: 'Settings',
  };
  $('#pageTitle').textContent = titles[name] || name;
  if (name === 'leaderboard') send('request.leaderboard');
  if (name === 'profile') send('request.stats');
  if (name === 'home') paintHomeScene();
  if (name === 'battleship') paintBsArenaList();
  if (name === 'octagon') paintOctagonLobby();
}

/* ============= hero / home ============= */
function initHero() {
  // .game-card buttons use data-nav; the global nav listener handles them.
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
  $('#btnFindMulti').addEventListener('click', () => {
    if (state.multiStake == null) return;
    if (state.balance < state.multiStake) return toast('Insufficient balance — top up in Wallet.');
    send('matchmaking.join', {
      stake: state.multiStake,
      partySize: state.multiPartySize,
      game: 'reaction',
    });
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
  ['pvp','multi','bot','solo'].forEach(m => {
    const panel = $('#modePanel-' + m);
    if (panel) panel.classList.toggle('hidden', m !== name);
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

function buildPartyTiers(containerId, sizes, onSelect) {
  const wrap = $(containerId);
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const n of sizes) {
    const el = document.createElement('button');
    el.className = 'party-tier'; el.type = 'button';
    el.dataset.party = String(n);
    el.innerHTML = `${n}<div class="lbl">PLAYERS</div>`;
    el.addEventListener('click', () => {
      $$('.party-tier', wrap).forEach(t => t.classList.remove('selected'));
      el.classList.add('selected');
      onSelect(n);
    });
    wrap.appendChild(el);
  }
}

function updateMultiSummary() {
  const stake = state.multiStake;
  const ps = state.multiPartySize;
  if (!stake || !ps) {
    $('#multiStake').textContent = '—';
    $('#multiPartyVal').textContent = ps ? `${ps}` : '—';
    $('#multiPot').textContent = '—';
    $('#multiFee').textContent = '—';
    $('#multiPrize').textContent = '—';
    $('#btnFindMulti').disabled = true;
    return;
  }
  const pot = stake * ps;
  const fee = +(pot * state.config.feePercent).toFixed(2);
  const prize = +(pot - fee).toFixed(2);
  $('#multiStake').textContent = fmtMoney(stake);
  $('#multiPartyVal').textContent = `${ps}`;
  $('#multiPot').textContent = fmtMoney(pot);
  $('#multiFee').textContent = fmtMoney(fee);
  $('#multiPrize').textContent = fmtMoney(prize);
  $('#btnFindMulti').disabled = false;
}

function initRoomInvite() {
  const urlRoom = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
  if (urlRoom) {
    setRoomCode(urlRoom, false);
    toast(`Joined room ${urlRoom}.`);
  }

  $('#btnCreateRoom').addEventListener('click', () => {
    const code = makeRoomCode();
    setRoomCode(code, true);
    copyInviteLink();
    toast(`Room ${code} created — link copied.`);
  });
  $('#btnCopyInvite').addEventListener('click', copyInviteLink);
  $('#btnLeaveRoom').addEventListener('click', () => {
    setRoomCode('', true);
    toast('Back in public queue.');
  });
  $('#btnJoinRoom').addEventListener('click', () => {
    const code = normalizeRoomCode($('#joinRoomInput').value);
    if (!code) { toast('Enter a join code.'); return; }
    setRoomCode(code, true);
    $('#joinRoomInput').value = '';
    toast(`Joined room ${code}. Pick a stake to find your friend.`);
  });
  $('#joinRoomInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#btnJoinRoom').click(); }
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
  const hint = $('#roomHint');
  if (hint) hint.textContent = state.roomCode
    ? 'Only players with this code at the same stake will match you.'
    : 'Match with anyone at this stake.';
  $('#btnCopyInvite').disabled = !state.roomCode;
  $('#btnLeaveRoom').classList.toggle('hidden', !state.roomCode);
  const findBtn = $('#btnFindPvP');
  if (findBtn) findBtn.textContent = state.roomCode ? 'FIND PRIVATE OPPONENT' : 'FIND OPPONENT';
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
  // livery picker — render a mini car + team label per livery
  const wrap = $('#liveryPicker'); wrap.innerHTML = '';
  for (const l of LIVERIES) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'livery-swatch livery-' + l.id;
    sw.dataset.livery = l.id;
    sw.title = `${l.label} · ${l.team}`;
    const carHolder = document.createElement('div'); carHolder.className = 'livery-car';
    carHolder.appendChild(makeCarEl(l.id));
    const meta = document.createElement('div'); meta.className = 'livery-meta';
    meta.innerHTML = `<div class="livery-name">${l.label}</div><div class="livery-team">${l.team}</div>`;
    sw.appendChild(carHolder);
    sw.appendChild(meta);
    sw.addEventListener('click', () => {
      send('set_livery', { livery: l.id });
      paintLiverySelection(l.id);
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
    red:         'linear-gradient(135deg, #ff2c3a, #6a0d14)',
    blue:        'linear-gradient(135deg, #5b8cff, #142e6a)',
    silver:      'linear-gradient(135deg, #c8ccd6, #2c2f3a)',
    green:       'linear-gradient(135deg, #2bd47d, #0a4a2c)',
    yellow:      'linear-gradient(135deg, #ffd24a, #6e5611)',
    magenta:     'linear-gradient(135deg, #ff5ec0, #6a1a4d)',
    scuderia:    'linear-gradient(135deg, #ff1c2c, #6b0008)',
    argent:      'linear-gradient(135deg, #00d2be, #1a2227)',
    bavarian:    'linear-gradient(135deg, #4f8ad6, #0e2c66)',
    toro:        'linear-gradient(135deg, #c9e823, #163a0a)',
    granturismo: 'linear-gradient(135deg, #ff9100, #6b2a00)',
    stahl:       'linear-gradient(135deg, #cf0a2c, #1c1e22)',
    astra:       'linear-gradient(135deg, #00a86b, #052e1f)',
    sakura:      'linear-gradient(135deg, #ffffff, #6a1019)',
  };
  return map[l] || map.red;
}

/* ============= race init ============= */
function initRace() {
  $('#tapZone').addEventListener('click', sendInput);
  $('#btnStartRound').addEventListener('click', sendReady);
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if ($('#overlay-race').classList.contains('hidden')) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    e.preventDefault();
    if (!$('#readyGate').classList.contains('hidden')) sendReady();
    else sendInput();
  });
  $('#btnLobby').addEventListener('click', () => {
    $('#resultModal').classList.add('hidden');
    send('leave_match');
    closeRace();
    showPage('home');
  });
  $('#btnRematch').addEventListener('click', () => {
    $('#resultModal').classList.add('hidden');
    send('rematch.request');
  });
}

function sendReady() {
  if (state.youReady) return;
  state.youReady = true;
  $('#btnStartRound').disabled = true;
  $('#readyStatus').textContent = 'Waiting for opponent…';
  $('#readyStatus').className = 'ready-status waiting';
  send('player.ready');
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
      $('#bsFeePct').textContent = Math.round(state.config.feePercent * 100) + '%';
      const multiFeeEl = $('#multiFeePct'); if (multiFeeEl) multiFeeEl.textContent = Math.round(state.config.feePercent * 100) + '%';
      buildStakeTiers('#pvpTiers', (a) => { state.pvpStake = a; updateStakeSummary(a, 'pvp'); $('#btnFindPvP').disabled = false; });
      buildStakeTiers('#botTiers', (a) => { state.botStake = a; updateStakeSummary(a, 'bot'); $('#btnPlayBot').disabled = false; });
      buildStakeTiers('#multiTiers', (a) => { state.multiStake = a; updateMultiSummary(); });
      const partySizes = (state.config && state.config.partySizes) || [3, 4, 5, 6, 8];
      buildPartyTiers('#multiPartyTiers', partySizes, (n) => { state.multiPartySize = n; updateMultiSummary(); });
      // Pre-select the smallest party size so the player only needs to click stake
      state.multiPartySize = partySizes[0] || 3;
      const firstParty = $('#multiPartyTiers .party-tier');
      if (firstParty) firstParty.classList.add('selected');
      updateMultiSummary();
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
      bsHandleHello(msg);
      octHandleHello(msg);
      break;
    }
    case 'battleship.state': {
      // First time we get this we may be entering placement.
      if (!state.bs.match || state.bs.match.matchId !== msg.matchId) openBsMatch(msg);
      else refreshBsMatch(msg);
      break;
    }
    case 'battleship.combat_begin': {
      refreshBsMatch(msg);
      toast('Combat begun.');
      break;
    }
    case 'battleship.round_result': {
      const r = msg.reveal || {};
      const yourCoord = cellToCoord(r.yourShot || {});
      const oppCoord = cellToCoord(r.opponentShot || {});
      const yourStatus = r.yourShot && r.yourShot.skipped ? 'NO SHOT' : (r.yourShot && r.yourShot.hit ? 'HIT' : 'MISS');
      const oppStatus = r.opponentShot && r.opponentShot.skipped ? 'NO SHOT' : (r.opponentShot && r.opponentShot.hit ? 'HIT' : 'MISS');
      paintBsShots(yourCoord, oppCoord, yourStatus, oppStatus);
      refreshBsMatch(msg);
      break;
    }
    case 'battleship.match_result': {
      bsShowMatchResult(msg);
      break;
    }
    case 'battleship.error': {
      toast(prettyReason(msg.reason));
      break;
    }
    // ============= OCTAGON =============
    case 'octagon.match_start': {
      openOctagonMatch(msg);
      break;
    }
    case 'octagon.state': {
      refreshOctagonMatch(msg);
      break;
    }
    case 'octagon.round_begin': {
      refreshOctagonMatch(msg);
      startOctagonRoundTimer(msg);
      break;
    }
    case 'octagon.round_result': {
      handleOctagonRoundResult(msg);
      break;
    }
    case 'octagon.match_result': {
      showOctagonResult(msg);
      break;
    }
    case 'octagon.error': {
      toast(prettyReason(msg.reason));
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
      // Update the in-page multiplayer status banner if applicable
      const isMulti = msg.partySize && msg.partySize > 2;
      const statusEl = $('#multiQueueStatus');
      if (statusEl) {
        statusEl.classList.toggle('hidden', !isMulti);
        if (isMulti) {
          $('#multiWaiting').textContent = msg.waiting != null ? msg.waiting : 1;
          $('#multiNeeded').textContent = msg.needed != null ? msg.needed : msg.partySize;
        }
      }
      // Show count in the matchmaking overlay
      const mmHint = $('#mmHint');
      if (mmHint) {
        if (isMulti && msg.waiting != null && msg.needed != null) {
          mmHint.textContent = `Multiplayer · ${msg.waiting} / ${msg.needed} drivers in queue`;
        } else {
          mmHint.textContent = '';
        }
      }
      break;
    }
    case 'matchmaking.queue_update': {
      const statusEl = $('#multiQueueStatus');
      const needed = msg.needed || 0;
      if (statusEl && needed > 2) {
        $('#multiWaiting').textContent = msg.waiting != null ? msg.waiting : 0;
        $('#multiNeeded').textContent = needed;
      }
      const mmHint = $('#mmHint');
      if (mmHint && needed > 2) {
        mmHint.textContent = `Multiplayer · ${msg.waiting} / ${needed} drivers in queue`;
      }
      break;
    }
    case 'matchmaking.cancelled': {
      $('#overlay-mm').classList.add('hidden');
      const statusEl = $('#multiQueueStatus');
      if (statusEl) statusEl.classList.add('hidden');
      break;
    }
    case 'matchmaking.error': {
      $('#overlay-mm').classList.add('hidden');
      const statusEl = $('#multiQueueStatus');
      if (statusEl) statusEl.classList.add('hidden');
      toast(prettyReason(msg.reason));
      break;
    }
    case 'player.disconnect': {
      toast('A driver disconnected from the match.');
      break;
    }
    case 'match.start': {
      enterMatch(msg);
      break;
    }
    case 'countdown.begin': {
      state.roundToken = msg.roundToken;
      hideReadyGate();
      runCountdownLights();
      playBeep('low');
      break;
    }
    case 'lights.green': {
      state.greenAtServer = msg.serverNow;
      // Wall clock at the *client* the moment we saw the green packet.
      // Used to compute the user's true reaction time without network bias.
      state.greenAtClient = performance.now();
      onGreenLight();
      playBeep('go');
      break;
    }
    case 'ready.update': {
      const me = state.playerId;
      const status = $('#readyStatus');
      const youReady = msg.playerId === me;
      if (msg.readyCount >= msg.readyNeeded) {
        status.textContent = 'Both ready — lights up!'; status.className = 'ready-status go';
      } else if (youReady) {
        status.textContent = 'Waiting for opponent…'; status.className = 'ready-status waiting';
      } else {
        status.textContent = 'Opponent is ready. Press START.'; status.className = 'ready-status';
      }
      break;
    }
    case 'player.falseStart': {
      onFalseStart(msg.playerId); playBeep('bust');
      break;
    }
    case 'round.void': {
      toast(`Round void · both invalid (retry ${msg.retry}/3) — press START again`);
      resetArenaForNextRound();
      state.youReady = false;
      showReadyGate({ readyNeeded: msg.readyNeeded, mode: state.match && state.match.mode });
      break;
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
      // If the opponent left, auto-requeue at the same stake so the player
      // doesn't have to step back through stake selection.
      if (msg.reason === 'opponent_left' && msg.stake) {
        toast('Opponent left — finding a new opponent…');
        closeRace();
        send('matchmaking.join', { stake: msg.stake, room: state.roomCode });
      } else {
        toast(prettyReason(msg.reason));
        closeRace();
      }
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
    opponent_left: 'Opponent left the match.',
    repeated_false_starts: 'Match cancelled · repeated false starts.',
    both_invalid: 'Both invalid · restarting.',
    timeout: 'Reaction timeout.',
    no_match: 'No active match to rematch.',
    match_expired: 'That match has expired.',
    invalid_arena: 'Pick a valid arena.',
    invalid_cell: 'That cell is off the grid.',
    already_targeted: 'Already targeted that cell.',
    already_locked: 'Already locked in.',
    wrong_state: 'Cannot do that right now.',
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
  state.youReady = false;
  state.requiresReady = !!msg.requiresReady;
  updateTopStrip();
  $('#overlay-mm').classList.add('hidden');
  $('#resultModal').classList.add('hidden');
  const multiStatus = $('#multiQueueStatus');
  if (multiStatus) multiStatus.classList.add('hidden');

  $('#youName').textContent = (msg.you.name || 'YOU') + ' · YOU';
  // For multi-player matches, the opponent lane shows "N drivers" instead of one name.
  const isMulti = msg.mode === 'multi' || (msg.partySize && msg.partySize > 2);
  if (isMulti && Array.isArray(msg.opponents)) {
    $('#oppName').textContent = `${msg.opponents.length} OPPONENTS`;
  } else {
    $('#oppName').textContent = msg.opponent.name;
  }
  $('#youStake').textContent = msg.mode === 'solo' ? 'TIME-ATTACK' : fmtMoney(msg.stake);
  $('#oppStake').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.stake);
  $('#youRt').textContent = '—';
  $('#oppRt').textContent = '—';
  $('#hudPot').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.pot);
  $('#hudFee').textContent = msg.mode === 'solo' ? '—' : fmtMoney(msg.feeAmount);
  $('#hudMode').textContent = isMulti ? `MULTI · ${msg.partySize}P` : msg.mode.toUpperCase();
  $('#hudStatus').textContent = msg.isRematch ? 'REMATCH · READY UP' : 'READY UP';
  $('#hudStatus').className = 'hud-status';

  if (isMulti && Array.isArray(msg.opponents) && msg.opponents.length > 0) {
    setLanesMulti({ id: msg.you.id, livery: msg.you.livery }, msg.opponents);
  } else {
    setLanesCars(msg.you.livery, msg.opponent.livery);
  }
  resetArenaForNextRound();
  $('#overlay-race').classList.remove('hidden');
  if (state.requiresReady) showReadyGate(msg);
  else hideReadyGate();
}

function showReadyGate(msg) {
  const gate = $('#readyGate'); const tap = $('#tapZone');
  gate.classList.remove('hidden');
  tap.classList.add('hidden');
  $('#btnStartRound').disabled = false;
  $('#btnStartRound').textContent = (msg && msg.mode === 'solo') ? 'START RUN' : (msg && msg.mode === 'bot') ? 'START ROUND' : 'START ROUND';
  const needed = (msg && msg.readyNeeded) || (state.match && state.match.readyNeeded) || 1;
  $('#readyStatus').textContent = needed > 1 ? 'Press START — both drivers must confirm.' : 'Press START to begin.';
  $('#readyStatus').className = 'ready-status';
}
function hideReadyGate() {
  $('#readyGate').classList.add('hidden');
  $('#tapZone').classList.remove('hidden');
}

function resetArenaForNextRound() {
  state.inputSent = false;
  state.greenAtServer = null;
  state.greenAtClient = null;
  state.lightsTimers.forEach(clearTimeout); state.lightsTimers = [];
  $('#arena').classList.remove('is-armed','is-go','is-finish');
  $$('.lane').forEach(l => l.classList.remove('is-launching','is-loser'));
  $$('.light').forEach(l => l.classList.remove('on','go'));
  $('#tapInstruction').textContent = 'GET READY…';
  $('#hudStatus').className = 'hud-status';
  $('#hudStatus').textContent = 'READY UP';
  $('#youRt').textContent = '—';
  $('#oppRt').textContent = '—';
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
  // Client-measured reaction time, in ms. Null if we tapped before green
  // (server still treats early taps as false-starts).
  const clientReactionMs = state.greenAtClient != null
    ? Math.max(0, Math.round(performance.now() - state.greenAtClient))
    : null;
  send('player.input', {
    roundToken: state.roundToken,
    clientTs: Date.now(),
    clientReactionMs,
  });
}

function showResult(msg) {
  const card = $('#resultCard');
  const me = state.playerId;
  const isMulti = msg.mode === 'multi' || (msg.partySize && msg.partySize > 2);
  const oppId = Object.keys(msg.times || {}).find(id => id !== me);
  if (msg.mode === 'solo') {
    const youLane = $('.lane-you');
    if (youLane) youLane.classList.add('is-launching');
  } else if (msg.winnerId) {
    // Flag every lane individually so multi-player matches show the winner
    // launching and every other car braking, not just the first opponent.
    const lanes = $$('.lane');
    const taggedLanes = lanes.filter(l => l.dataset.playerId);
    if (taggedLanes.length > 0) {
      for (const lane of taggedLanes) {
        if (lane.dataset.playerId === msg.winnerId) lane.classList.add('is-launching');
        else lane.classList.add('is-loser');
      }
    } else {
      // Legacy 2-player layout (no per-lane player ids).
      const youLane = $('.lane-you'); const oppLane = $('.lane-opp');
      if (msg.youWon) { youLane.classList.add('is-launching'); oppLane.classList.add('is-loser'); }
      else { oppLane.classList.add('is-launching'); youLane.classList.add('is-loser'); }
    }
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

    // Multi-player: hide the head-to-head times block and show a leaderboard
    // with every player ranked by reaction time.
    const headToHead = $('#resultTimes');
    const multiList = $('#multiResults');
    if (isMulti && multiList && msg.times && msg.players) {
      headToHead.classList.add('hidden');
      multiList.classList.remove('hidden');
      const listEl = $('#multiResultsList');
      listEl.innerHTML = '';
      const rows = Object.keys(msg.times).map(id => ({
        id,
        name: (msg.players[id] && msg.players[id].name) || 'Driver',
        t: msg.times[id] || {},
      }));
      // Sort: valid reactions first by time ascending, then false-starts/timeouts last
      rows.sort((a, b) => {
        const aFault = a.t.falseStart || (a.t.timedOut && !a.t.walkover) || a.t.reactionTime == null;
        const bFault = b.t.falseStart || (b.t.timedOut && !b.t.walkover) || b.t.reactionTime == null;
        if (aFault !== bFault) return aFault ? 1 : -1;
        if (aFault) return 0;
        return (a.t.reactionTime || 0) - (b.t.reactionTime || 0);
      });
      rows.forEach((row, idx) => {
        const div = document.createElement('div');
        div.className = 'multi-result-row';
        if (row.id === me) div.classList.add('is-you');
        if (row.id === msg.winnerId) div.classList.add('is-winner');
        const isFault = row.t.falseStart || (row.t.timedOut && !row.t.walkover) || row.t.reactionTime == null;
        if (isFault) div.classList.add('is-fault');
        const rankLabel = row.id === msg.winnerId ? 'WIN' : (idx + 1) + '.';
        div.innerHTML = `<div class="mr-rank">${rankLabel}</div>` +
                        `<div class="mr-name">${row.name}${row.id === me ? ' (you)' : ''}</div>` +
                        `<div class="mr-time">${formatReaction(row.t)}</div>`;
        listEl.appendChild(div);
      });
    } else {
      headToHead.classList.remove('hidden');
      if (multiList) multiList.classList.add('hidden');
    }

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
      card.classList.add('win');
      $('#resultBanner').textContent = isMulti ? `1ST OF ${msg.partySize || Object.keys(msg.times || {}).length} · YOU WIN` : 'YOU WIN';
      youBlock.classList.add('win'); oppBlock.classList.add(oppT.falseStart ? 'bust' : 'lose');
      playBeep('win');
      if (isMulti && msg.payout) toast(`Victory! +${fmtMoney(msg.payout)} added to your balance.`);
    } else if (msg.winnerId) {
      card.classList.add('lose'); $('#resultBanner').textContent = 'YOU LOSE';
      oppBlock.classList.add('win'); youBlock.classList.add(myT.falseStart ? 'bust' : 'lose');
      playBeep('bust');
    } else {
      card.classList.add('void'); $('#resultBanner').textContent = 'VOID';
    }

    // Set the action button label based on mode for clarity.
    // Solo/Bot: instant "Play Again". PvP: "Rematch" (needs opponent vote).
    // Multi: "Find Match" — re-queue at same stake/party size.
    const btn = $('#btnRematch');
    if (msg.mode === 'pvp') {
      btn.textContent = 'REMATCH';
      btn.title = 'Both players must accept to start the next round.';
    } else if (msg.mode === 'bot') {
      btn.textContent = 'PLAY AGAIN';
      btn.title = 'Race the bot again at the same stake.';
    } else if (msg.mode === 'multi') {
      btn.textContent = 'PLAY AGAIN';
      btn.title = 'Re-queue for another multiplayer match at the same stake & party size.';
    } else {
      btn.textContent = 'RUN AGAIN';
      btn.title = 'Start another time-attack run.';
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

/* =====================================================================
   BATTLESHIP — client logic
   ===================================================================== */

function initBattleship() {
  $('#bsBackBtn').addEventListener('click', () => {
    send('leave_match');
    $('#overlay-bsmatch').classList.add('hidden');
    showPage('battleship');
  });
  $('#btnBsFind').addEventListener('click', () => {
    if (!state.bs.selectedArenaId) return;
    const arena = state.bs.arenas.find(a => a.id === state.bs.selectedArenaId);
    if (!arena) return;
    if (state.balance < arena.stake) return toast('Insufficient balance — top up in Wallet.');
    send('matchmaking.join', { game: 'battleship', arenaId: arena.id });
  });
  $('#btnBsShuffle').addEventListener('click', () => send('battleship.shuffle'));
  $('#btnBsLockPlacement').addEventListener('click', () => send('battleship.lock_placement'));
  $('#btnBsLobby').addEventListener('click', () => {
    $('#bsResultModal').classList.add('hidden');
    $('#overlay-bsmatch').classList.add('hidden');
    showPage('battleship');
  });
  $('#btnBsRematch').addEventListener('click', () => {
    $('#bsResultModal').classList.add('hidden');
    // For PvP we re-queue at the same arena instead of needing both votes —
    // simpler UX; opponent likely already left to lobby.
    if (state.bs.match && state.bs.match.arenaId) {
      send('matchmaking.join', { game: 'battleship', arenaId: state.bs.match.arenaId });
    } else {
      showPage('battleship');
    }
  });
}

function paintBsArenaList() {
  const list = $('#bsArenaList');
  if (!list) return;
  list.innerHTML = '';
  for (const arena of state.bs.arenas) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'bs-arena-card';
    if (state.bs.selectedArenaId === arena.id) card.classList.add('selected');
    card.innerHTML = `
      <div class="bs-arena-icon">${arenaIconSvg(arena.id)}</div>
      <div class="bs-arena-name">${arena.name}</div>
      <div class="bs-arena-stake">$${arena.stake}</div>
      <div class="bs-arena-meta">PVP · 6% FEE</div>
    `;
    card.addEventListener('click', () => selectBsArena(arena.id));
    list.appendChild(card);
  }
}

function selectBsArena(arenaId) {
  state.bs.selectedArenaId = arenaId;
  paintBsArenaList();
  const arena = state.bs.arenas.find(a => a.id === arenaId);
  if (!arena) return;
  const pot = arena.stake * 2;
  const fee = +(pot * (state.config.feePercent || 0.06)).toFixed(2);
  const prize = +(pot - fee).toFixed(2);
  $('#bsStake').textContent = '$' + arena.stake.toFixed(2);
  $('#bsPot').textContent = '$' + pot.toFixed(2);
  $('#bsFee').textContent = '$' + fee.toFixed(2);
  $('#bsPrize').textContent = '$' + prize.toFixed(2);
  $('#btnBsFind').disabled = false;
}

function arenaIconSvg(id) {
  const map = {
    arctic:   '<svg viewBox="0 0 64 36"><polygon points="0,30 14,10 22,18 32,4 44,16 54,8 64,30" fill="#cfd6e8" stroke="#6b7595" stroke-width="0.8"/><line x1="0" y1="34" x2="64" y2="34" stroke="#6b7595" stroke-width="0.6"/></svg>',
    coral:    '<svg viewBox="0 0 64 36"><circle cx="14" cy="22" r="6" fill="#5fa66c"/><circle cx="44" cy="20" r="9" fill="#5fa66c"/><line x1="0" y1="30" x2="64" y2="30" stroke="#7e9bbf" stroke-width="0.6"/><polyline points="6,32 12,32 18,32 24,32 30,32 36,32 42,32 48,32 54,32 60,32" stroke="#7e9bbf" stroke-width="0.4" fill="none" stroke-dasharray="2,3"/></svg>',
    biscay:   '<svg viewBox="0 0 64 36"><path d="M0,24 L14,18 L18,22 L26,8 L34,20 L38,16 L46,22 L52,18 L64,24 L64,36 L0,36 Z" fill="#6b7595" stroke="#454f6b" stroke-width="0.6"/><circle cx="50" cy="6" r="2" fill="#ffd24a"/></svg>',
    atlantic: '<svg viewBox="0 0 64 36"><path d="M0,18 q4,-4 8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0" fill="none" stroke="#5b8cff" stroke-width="0.8"/><path d="M0,26 q4,-4 8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0" fill="none" stroke="#5b8cff" stroke-width="0.8"/><rect x="20" y="10" width="20" height="3" fill="#9aa0b3"/><rect x="28" y="6" width="6" height="4" fill="#9aa0b3"/></svg>',
    pacific:  '<svg viewBox="0 0 64 36"><path d="M0,16 q4,-3 8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0" fill="none" stroke="#5b8cff" stroke-width="0.7"/><polygon points="20,30 44,30 38,18 26,18" fill="#fff" stroke="#454f6b" stroke-width="0.6"/><line x1="32" y1="18" x2="32" y2="6" stroke="#454f6b" stroke-width="0.6"/><polygon points="32,8 38,16 32,16" fill="#5b8cff"/></svg>',
    red:      '<svg viewBox="0 0 64 36"><polygon points="0,28 18,22 26,30 36,18 50,28 64,22 64,36 0,36" fill="#cf6e3c" stroke="#8b3f1c" stroke-width="0.6"/><circle cx="48" cy="8" r="3" fill="#ffb547"/></svg>',
    black:    '<svg viewBox="0 0 64 36"><path d="M14,24 q-4,-12 8,-14 q8,2 8,12" fill="none" stroke="#3a4474" stroke-width="2"/><path d="M40,28 q4,-14 16,-12" fill="none" stroke="#3a4474" stroke-width="2"/><line x1="0" y1="32" x2="64" y2="32" stroke="#3a4474" stroke-width="0.6"/></svg>',
  };
  return map[id] || map.atlantic;
}

function bsHandleHello(msg) {
  if (msg.config && msg.config.battleship) {
    state.bs.arenas = msg.config.battleship.arenas || [];
    state.bs.boardSize = msg.config.battleship.boardSize || 10;
    state.bs.fleet = msg.config.battleship.fleet || [];
  }
}

function openBsMatch(snap) {
  state.bs.match = snap;
  state.bs.pendingTarget = null;
  $('#overlay-bsmatch').classList.remove('hidden');
  $('#overlay-mm').classList.add('hidden');
  $('#bsArenaName').textContent = snap.arenaName || '—';
  $('#bsArenaStake').textContent = '$' + snap.stake;
  $('#bsRoundNum').textContent = snap.round || 0;
  $('#bsYouName').textContent = (state.name || 'YOU').toUpperCase();
  $('#bsOppName').textContent = (snap.opponent.name || 'OPPONENT').toUpperCase();
  $('#bsYouBalance').textContent = '$' + state.balance.toFixed(2);
  $('#bsOppBalance').textContent = '$' + snap.stake.toFixed(2);
  paintBsBoards(snap);
  paintBsFleet(snap);
  paintBsControls(snap);
  paintBsMidStatus(snap);
  paintBsShots(null, null);
}

function refreshBsMatch(snap) {
  state.bs.match = snap;
  $('#bsRoundNum').textContent = snap.round || 0;
  paintBsBoards(snap);
  paintBsFleet(snap);
  paintBsControls(snap);
  paintBsMidStatus(snap);
}

function paintBsBoards(snap) {
  const boardYou = $('#bsBoardYou');
  const boardOpp = $('#bsBoardOpp');
  const N = state.bs.boardSize;

  // Render a board with header row (A-J) + header column (1-10).
  function renderBoard(boardEl, isOpp) {
    boardEl.innerHTML = '';
    const cellEls = {};

    // Top-left empty corner
    const corner = document.createElement('div');
    corner.className = 'bs-coord bs-coord-corner';
    boardEl.appendChild(corner);

    // Column headers A-J
    for (let x = 0; x < N; x++) {
      const h = document.createElement('div');
      h.className = 'bs-coord';
      h.textContent = String.fromCharCode(65 + x);
      boardEl.appendChild(h);
    }

    // Each row: header (1-10) + 10 cells
    for (let y = 0; y < N; y++) {
      const rh = document.createElement('div');
      rh.className = 'bs-coord';
      rh.textContent = String(y + 1);
      boardEl.appendChild(rh);

      for (let x = 0; x < N; x++) {
        const c = document.createElement('div');
        c.className = 'bs-cell';
        if (y === 0) c.classList.add('edge-top');
        if (x === 0) c.classList.add('edge-left');
        c.dataset.x = x; c.dataset.y = y;
        cellEls[`${x},${y}`] = c;
        if (isOpp && snap.state === 'playing' && !snap.pending.youLockedIn) {
          c.addEventListener('click', () => bsTargetCell(x, y));
        }
        boardEl.appendChild(c);
      }
    }
    return cellEls;
  }

  // YOU board
  const youCellEls = renderBoard(boardYou, false);
  for (const ship of snap.you.ships) {
    paintShipOnBoard(youCellEls, ship);
  }
  for (const shot of snap.you.shotsAtMe) {
    const el = youCellEls[`${shot.x},${shot.y}`];
    if (el) el.classList.add(shot.hit ? 'bs-cell-hit' : 'bs-cell-miss');
  }

  // OPPONENT board (fog of war until end)
  const oppCellEls = renderBoard(boardOpp, true);
  for (const shot of snap.opponent.myShots) {
    const el = oppCellEls[`${shot.x},${shot.y}`];
    if (el) el.classList.add(shot.hit ? 'bs-cell-hit' : 'bs-cell-miss');
  }
  // Highlight pending target if any
  if (state.bs.pendingTarget) {
    const { x, y } = state.bs.pendingTarget;
    const el = oppCellEls[`${x},${y}`];
    if (el) el.classList.add('bs-cell-target');
  }
}

// Paint a ship onto a cellMap with proper end-cap rounding so it reads as a
// single boat shape across multiple cells.
function paintShipOnBoard(cellMap, ship) {
  if (!ship.cells || !ship.cells.length) return;
  // Detect orientation by comparing first two cells
  const horizontal = ship.cells.length > 1 && ship.cells[0].y === ship.cells[1].y;
  ship.cells.forEach((cell, i) => {
    const el = cellMap[`${cell.x},${cell.y}`];
    if (!el) return;
    el.classList.add('bs-cell-ship');
    if (i === 0) el.classList.add(horizontal ? 'ship-end-h-l' : 'ship-end-v-t');
    if (i === ship.cells.length - 1) el.classList.add(horizontal ? 'ship-end-h-r' : 'ship-end-v-b');
  });
}

function paintBsFleet(snap) {
  const youFleet = $('#bsFleetYou');
  const oppFleet = $('#bsFleetOpp');
  youFleet.innerHTML = '';
  oppFleet.innerHTML = '';
  for (const ship of snap.you.ships) {
    const pip = document.createElement('span');
    pip.className = 'bs-fleet-pip' + (ship.sunk ? ' sunk' : '');
    pip.textContent = `${ship.name.toUpperCase()} ${ship.length}`;
    youFleet.appendChild(pip);
  }
  for (const ship of snap.opponent.shipsSummary) {
    const pip = document.createElement('span');
    pip.className = 'bs-fleet-pip' + (ship.sunk ? ' sunk' : '');
    pip.textContent = `${ship.name.toUpperCase()} ${ship.length}`;
    oppFleet.appendChild(pip);
  }
}

function paintBsControls(snap) {
  const ctrl = $('#bsControls');
  ctrl.innerHTML = '';
  if (snap.state === 'placing') {
    if (!snap.you.placementLocked) {
      const shuffle = document.createElement('button');
      shuffle.className = 'btn btn-ghost';
      shuffle.id = 'btnBsShuffle';
      shuffle.textContent = 'SHUFFLE FLEET';
      shuffle.addEventListener('click', () => send('battleship.shuffle'));
      ctrl.appendChild(shuffle);
      const lock = document.createElement('button');
      lock.className = 'btn btn-primary';
      lock.id = 'btnBsLockPlacement';
      lock.textContent = 'LOCK PLACEMENT';
      lock.addEventListener('click', () => send('battleship.lock_placement'));
      ctrl.appendChild(lock);
    } else {
      const w = document.createElement('div');
      w.style.cssText = 'font-size:13px; color: rgba(0,0,0,0.6); letter-spacing: 0.18em; font-weight: 700;';
      w.textContent = 'WAITING FOR OPPONENT TO LOCK PLACEMENT…';
      ctrl.appendChild(w);
    }
  } else if (snap.state === 'playing') {
    if (!snap.pending.youLockedIn) {
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:13px; color: rgba(0,0,0,0.7); letter-spacing: 0.16em; font-weight: 700;';
      lbl.textContent = state.bs.pendingTarget
        ? `TARGET ${cellToCoord(state.bs.pendingTarget)}`
        : 'PICK A TARGET ON THE OPPONENT GRID';
      ctrl.appendChild(lbl);
      const lock = document.createElement('button');
      lock.className = 'btn btn-primary';
      lock.id = 'btnBsLockShot';
      lock.textContent = 'LOCK IN SHOT';
      lock.disabled = !state.bs.pendingTarget;
      lock.addEventListener('click', bsLockShot);
      ctrl.appendChild(lock);
    } else if (!snap.pending.opponentLockedIn) {
      const w = document.createElement('div');
      w.style.cssText = 'font-size:13px; color: rgba(0,0,0,0.6); letter-spacing: 0.18em; font-weight: 700;';
      w.textContent = 'WAITING FOR OPPONENT TO LOCK SHOT…';
      ctrl.appendChild(w);
    } else {
      const w = document.createElement('div');
      w.style.cssText = 'font-size:13px; color: rgba(0,0,0,0.6); letter-spacing: 0.18em; font-weight: 700;';
      w.textContent = 'RESOLVING…';
      ctrl.appendChild(w);
    }
  }
}

function paintBsMidStatus(snap) {
  const status = $('#bsMidStatus');
  status.classList.remove('is-armed', 'is-resolving');
  if (snap.state === 'placing') {
    status.textContent = 'PLACE YOUR FLEET';
  } else if (snap.state === 'playing') {
    if (snap.pending.youLockedIn && snap.pending.opponentLockedIn) {
      status.textContent = 'BOTH PLAYERS LOCKED IN';
      status.classList.add('is-resolving');
    } else if (snap.pending.youLockedIn) {
      status.textContent = 'AWAITING OPPONENT';
      status.classList.add('is-armed');
    } else if (snap.pending.opponentLockedIn) {
      status.textContent = 'OPPONENT READY · LOCK IN';
      status.classList.add('is-armed');
    } else {
      status.textContent = 'PICK YOUR TARGET';
      status.classList.add('is-armed');
    }
  } else {
    status.textContent = '—';
  }
}

function paintBsShots(yourCoord, oppCoord, yourStatus, oppStatus) {
  $('#bsYouShotCoord').textContent = yourCoord || '—';
  $('#bsOppShotCoord').textContent = oppCoord || '—';
  const yEl = $('#bsYouShotStatus'); const oEl = $('#bsOppShotStatus');
  yEl.textContent = yourStatus || '';
  oEl.textContent = oppStatus || '';
  yEl.className = 'bs-shot-status' + (yourStatus === 'HIT' ? ' is-hit' : (yourStatus ? ' is-locked' : ''));
  oEl.className = 'bs-shot-status' + (oppStatus === 'HIT' ? ' is-hit' : (oppStatus ? ' is-locked' : ''));
}

function bsTargetCell(x, y) {
  if (!state.bs.match || state.bs.match.state !== 'playing') return;
  if (state.bs.match.pending.youLockedIn) return;
  state.bs.pendingTarget = { x, y };
  paintBsBoards(state.bs.match);
  paintBsControls(state.bs.match);
}

function bsLockShot() {
  if (!state.bs.pendingTarget) return;
  const { x, y } = state.bs.pendingTarget;
  send('battleship.lock_shot', { x, y });
  // Show provisional locked-in state (server snapshot will follow)
  paintBsShots(cellToCoord({ x, y }), '—', 'LOCKED IN', '');
  state.bs.pendingTarget = null;
}

function cellToCoord(c) {
  if (!c || c.x == null) return '—';
  const letter = String.fromCharCode(65 + c.x);
  return `${letter}${c.y + 1}`;
}

function bsShowMatchResult(msg) {
  const card = $('#bsResultCard');
  card.classList.remove('win', 'lose', 'void');
  const banner = $('#bsResultBanner');
  if (msg.isVoid) {
    card.classList.add('void');
    banner.textContent = 'VOID — REFUNDED';
  } else if (msg.youWon) {
    card.classList.add('win');
    banner.textContent = 'VICTORY';
  } else {
    card.classList.add('lose');
    banner.textContent = 'DEFEAT';
  }
  $('#bsResultRounds').textContent = msg.rounds || '—';
  // hits: count from each board (the boards show full reveal)
  const me = state.playerId;
  const oppId = Object.keys(msg.boards || {}).find(id => id !== me);
  const myShipsHit = (msg.boards && msg.boards[me] || []).reduce((sum, s) => sum + s.cells.filter(c => c.hit).length, 0);
  const oppShipsHit = oppId ? (msg.boards[oppId] || []).reduce((sum, s) => sum + s.cells.filter(c => c.hit).length, 0) : 0;
  $('#bsResultYouHits').textContent = oppShipsHit; // I dealt this many hits to the opponent
  $('#bsResultOppHits').textContent = myShipsHit;  // opponent dealt this many to me
  $('#bsRPot').textContent = '$' + (msg.pot != null ? msg.pot.toFixed(2) : '—');
  $('#bsRFee').textContent = '$' + (msg.feeAmount != null ? msg.feeAmount.toFixed(2) : '—');
  $('#bsRPayout').textContent = '$' + (msg.payout != null ? msg.payout.toFixed(2) : '0.00');
  $('#bsRSeed').textContent = msg.seed || '—';
  if (msg.balance != null) {
    state.balance = msg.balance;
    updateTopStrip();
    $('#bsYouBalance').textContent = '$' + state.balance.toFixed(2);
  }
  if (msg.stats) state.stats = msg.stats;
  // Refresh other UI surfaces so wallet, history, and stats reflect the win
  paintHomeStats(); paintHomeHistory(); paintProfilePage(); paintWallet();
  if (msg.youWon && msg.payout) {
    toast(`Victory! +${fmtMoney(msg.payout)} added to your balance.`);
    playBeep('win');
  } else if (msg.isVoid && msg.balance != null) {
    toast('Match void — stake refunded.');
  } else if (!msg.youWon && !msg.isVoid) {
    playBeep('bust');
  }
  $('#bsResultModal').classList.remove('hidden');
}

/* =====================================================================
   OCTAGON · UFC Battle Royale — client logic
   ===================================================================== */

const OCT_STAKE_TIERS = [1, 5, 10, 25, 50, 100];

function octHandleHello(msg) {
  const cfg = msg && msg.config && msg.config.octagon;
  if (!cfg) return;
  state.oct.attacker = cfg.attacker;
  state.oct.minPlayers = cfg.minPlayers;
  state.oct.maxPlayers = cfg.maxPlayers;
  // pre-select smallest party + smallest stake so the page is usable on first
  // visit
  if (state.oct.selectedParty == null) state.oct.selectedParty = cfg.minPlayers;
}

function initOctagon() {
  $('#octBackBtn').addEventListener('click', () => {
    send('leave_match');
    closeOctagonOverlay();
    showPage('octagon');
  });
  $('#btnOctFind').addEventListener('click', () => {
    if (!state.oct.selectedStake) return toast('Pick a stake.');
    if (state.balance < state.oct.selectedStake) return toast('Insufficient balance — top up in Wallet.');
    send('matchmaking.join', {
      game: 'octagon',
      stake: state.oct.selectedStake,
      partySize: state.oct.selectedParty,
    });
  });
  $('#btnOctLobby').addEventListener('click', () => {
    $('#octResultModal').classList.add('hidden');
    closeOctagonOverlay();
    showPage('octagon');
  });
  $('#btnOctRematch').addEventListener('click', () => {
    $('#octResultModal').classList.add('hidden');
    if (state.oct.selectedStake) {
      send('matchmaking.join', {
        game: 'octagon',
        stake: state.oct.selectedStake,
        partySize: state.oct.selectedParty,
      });
    } else {
      showPage('octagon');
    }
  });
}

function paintOctagonLobby() {
  const partyWrap = $('#octPartyTiers');
  const stakeWrap = $('#octStakeTiers');
  if (!partyWrap || !stakeWrap) return;
  partyWrap.innerHTML = '';
  stakeWrap.innerHTML = '';
  for (let n = state.oct.minPlayers; n <= state.oct.maxPlayers; n++) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'oct-party-card' + (n === state.oct.selectedParty ? ' selected' : '');
    card.innerHTML = `<div class="lbl">PARTY</div><div class="val">${n}</div>`;
    card.addEventListener('click', () => {
      state.oct.selectedParty = n;
      paintOctagonLobby();
    });
    partyWrap.appendChild(card);
  }
  for (const stake of OCT_STAKE_TIERS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'oct-stake-card' + (state.oct.selectedStake === stake ? ' selected' : '');
    card.innerHTML = `<div class="lbl">STAKE</div><div class="val">$${stake}</div>`;
    card.addEventListener('click', () => {
      state.oct.selectedStake = stake;
      paintOctagonLobby();
    });
    stakeWrap.appendChild(card);
  }
  refreshOctSummary();
  $('#octFeePct').textContent = Math.round((state.config.feePercent || 0.06) * 100) + '%';
}

function refreshOctSummary() {
  const stake = state.oct.selectedStake;
  const party = state.oct.selectedParty;
  $('#btnOctFind').disabled = !(stake != null && party != null);
  if (stake == null || party == null) {
    $('#octStakeOut').textContent = '—';
    $('#octPartyOut').textContent = '—';
    $('#octPotOut').textContent = '—';
    $('#octFeeOut').textContent = '—';
    $('#octPrizeOut').textContent = '—';
    return;
  }
  const fee = state.config.feePercent || 0.06;
  const pot = stake * party;
  const feeAmt = +(pot * fee).toFixed(2);
  const prize = +(pot - feeAmt).toFixed(2);
  $('#octStakeOut').textContent = '$' + stake.toFixed(2);
  $('#octPartyOut').textContent = party + ' players';
  $('#octPotOut').textContent = '$' + pot.toFixed(2);
  $('#octFeeOut').textContent = '$' + feeAmt.toFixed(2);
  $('#octPrizeOut').textContent = '$' + prize.toFixed(2);
}

function openOctagonMatch(snap) {
  state.oct.match = snap;
  state.oct.pendingChoice = null;
  $('#overlay-octmatch').classList.remove('hidden');
  $('#overlay-mm').classList.add('hidden');
  $('#octResultModal').classList.add('hidden');
  $('#octAttackerName').textContent = (snap.attacker && snap.attacker.name) || 'THE BONE CRUSHER';
  $('#octAttackerTagline').textContent = (snap.attacker && snap.attacker.tagline) || '';
  // Send octagon.ready so the server begins round 1 once everyone has
  // acknowledged. Tiny delay to let UI settle.
  setTimeout(() => send('octagon.ready'), 60);
  refreshOctagonMatch(snap);
}

function refreshOctagonMatch(snap) {
  state.oct.match = snap;
  $('#octRoundNum').textContent = snap.round || 0;
  $('#octPotLive').textContent = '$' + (snap.pot != null ? snap.pot.toFixed(2) : '—');
  $('#octFeeLive').textContent = '$' + (snap.feeAmount != null ? snap.feeAmount.toFixed(2) : '—');
  $('#octPayoutLive').textContent = '$' + (snap.payout != null ? snap.payout.toFixed(2) : '—');
  paintOctRoster(snap);
  paintOctCages(snap);
  paintOctStatus(snap);
}

function startOctagonRoundTimer(snap) {
  state.oct.timerEndAt = Date.now() + 18000; // mirrors server ROUND_TIMEOUT_MS
  if (state.oct.timerInterval) clearInterval(state.oct.timerInterval);
  state.oct.timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.round((state.oct.timerEndAt - Date.now()) / 1000));
    $('#octRoundTimer').textContent = `${String(remaining).padStart(2, '0')}s`;
    if (remaining <= 0) {
      clearInterval(state.oct.timerInterval);
      state.oct.timerInterval = null;
    }
  }, 250);
}

function paintOctCages(snap) {
  const wrap = $('#octCages');
  wrap.innerHTML = '';
  const n = (snap.octagons || []).length;
  wrap.className = 'oct-cages cages-' + n;
  if (snap.state !== 'choosing' || !snap.youAlive) {
    // Show placeholder cages with the same shape but disabled
    for (const oct of (snap.octagons || [])) {
      wrap.appendChild(buildOctCage(oct, snap, true));
    }
    return;
  }
  for (const oct of snap.octagons) {
    wrap.appendChild(buildOctCage(oct, snap, false));
  }
}

function buildOctCage(oct, snap, disabled) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'oct-cage';
  if (disabled) card.classList.add('is-eliminated');
  if (state.oct.pendingChoice === oct.id) card.classList.add('selected');
  if (snap.yourChoice === oct.id) card.classList.add('selected');
  card.innerHTML = `
    <div class="oct-cage-shape">
      <svg viewBox="0 0 100 100">
        <polygon points="50,8 78,22 90,52 78,82 22,82 10,52 22,22"
                 fill="rgba(255,44,58,0.06)" stroke="rgba(255,44,58,0.6)" stroke-width="1.6"/>
        <g stroke="rgba(255,44,58,0.18)" stroke-width="0.6">
          <line x1="22" y1="22" x2="78" y2="82"/>
          <line x1="78" y1="22" x2="22" y2="82"/>
          <line x1="50" y1="8" x2="50" y2="82"/>
          <line x1="10" y1="52" x2="90" y2="52"/>
        </g>
      </svg>
      <div class="head">${oct.id.toUpperCase()}</div>
    </div>
    <div class="oct-cage-name">${oct.name}</div>
    <div class="oct-cage-style">${oct.style || ''}</div>
    <div class="oct-cage-occupants" data-oct="${oct.id}"></div>
  `;
  if (!disabled) {
    card.addEventListener('click', () => octChoose(oct.id));
  }
  return card;
}

function octChoose(octagonId) {
  if (!state.oct.match || state.oct.match.state !== 'choosing') return;
  if (!state.oct.match.youAlive) return;
  if (state.oct.match.pending && state.oct.match.pending.youLockedIn) return;
  state.oct.pendingChoice = octagonId;
  // Optimistically lock; server will reject if invalid
  send('octagon.lock_choice', { octagonId });
  // Repaint to show selected state
  refreshOctagonMatch(state.oct.match);
}

function paintOctStatus(snap) {
  const text = $('#octStatusText');
  const meta = $('#octStatusMeta');
  text.classList.remove('is-pick', 'is-locked', 'is-attacker', 'is-eliminated');
  if (snap.state === 'awaiting_ready') {
    text.textContent = 'GET READY…';
  } else if (snap.state === 'choosing') {
    if (!snap.youAlive) {
      text.textContent = 'ELIMINATED — SPECTATING';
      text.classList.add('is-eliminated');
    } else if (snap.pending && snap.pending.youLockedIn) {
      text.textContent = 'LOCKED IN';
      text.classList.add('is-locked');
    } else {
      text.textContent = 'PICK YOUR OCTAGON';
      text.classList.add('is-pick');
    }
  } else if (snap.state === 'awaiting_round') {
    text.textContent = 'BONE CRUSHER STRIKES…';
    text.classList.add('is-attacker');
  } else {
    text.textContent = '—';
  }
  if (snap.pending) {
    meta.textContent = `${snap.pending.lockedCount}/${snap.pending.lockedNeeded} locked · ${snap.aliveCount}/${snap.totalPlayers} alive`;
  } else {
    meta.textContent = '';
  }
}

function paintOctRoster(snap) {
  const wrap = $('#octRoster');
  wrap.innerHTML = '';
  for (const p of (snap.players || [])) {
    const el = document.createElement('div');
    let cls = 'oct-fighter';
    if (p.id === state.playerId) cls += ' you';
    else if (p.alive) cls += ' alive';
    else cls += ' eliminated';
    el.className = cls;
    el.innerHTML = `
      <span class="dot"></span>
      <span>${p.name}${p.id === state.playerId ? ' · YOU' : ''}${!p.alive && p.eliminatedRound ? ' · OUT R' + p.eliminatedRound : ''}</span>
    `;
    wrap.appendChild(el);
  }
}

function handleOctagonRoundResult(msg) {
  if (state.oct.timerInterval) { clearInterval(state.oct.timerInterval); state.oct.timerInterval = null; }
  state.oct.match = msg;
  state.oct.pendingChoice = null;
  // Show the reveal: highlight target cage red, others green
  const reveal = msg.reveal;
  if (reveal && reveal.target) {
    const cages = $$('.oct-cage');
    for (const cage of cages) {
      const occ = cage.querySelector('.oct-cage-occupants');
      const id = occ && occ.dataset.oct;
      if (!id) continue;
      if (id === reveal.target) cage.classList.add('is-target');
      else cage.classList.add('is-safe');
      // Also annotate occupants count for the round
      const inThisCage = Object.entries(reveal.choices || {})
        .filter(([, oct]) => oct === id);
      if (occ) {
        occ.innerHTML = inThisCage.length
          ? inThisCage.map(() => '<span class="pip"></span>').join(' ') + ` <span>${inThisCage.length} fighter${inThisCage.length > 1 ? 's' : ''}</span>`
          : '<span>empty</span>';
      }
    }
  }
  paintOctStatus(msg);
  paintOctRoster(msg);
  // pot/round numbers
  $('#octRoundNum').textContent = msg.round || 0;
}

function showOctagonResult(msg) {
  if (state.oct.timerInterval) { clearInterval(state.oct.timerInterval); state.oct.timerInterval = null; }
  const card = $('#octResultCard');
  const banner = $('#octResultBanner');
  card.classList.remove('win', 'lose', 'void', 'solo-win');
  if (msg.youWon) {
    card.classList.add(msg.isSplit ? 'solo-win' : 'win');
    banner.textContent = msg.isSplit ? `SPLIT · ${msg.splitCount} WAY` : 'CHAMPION';
  } else {
    card.classList.add('lose');
    banner.textContent = 'ELIMINATED';
  }
  $('#octResultRounds').textContent = msg.rounds || 0;
  $('#octResultFate').textContent = msg.youWon
    ? (msg.isSplit ? `SHARED FINAL · ${msg.splitCount} ways` : 'LAST STANDING')
    : 'KO\'D BY BONE CRUSHER';
  $('#octRPot').textContent = '$' + (msg.pot != null ? msg.pot.toFixed(2) : '—');
  $('#octRFee').textContent = '$' + (msg.feeAmount != null ? msg.feeAmount.toFixed(2) : '—');
  $('#octRPayout').textContent = '$' + (msg.yourPayout != null ? msg.yourPayout.toFixed(2) : '0.00');
  $('#octRSeed').textContent = msg.seed || '—';
  if (msg.balance != null) { state.balance = msg.balance; updateTopStrip(); }
  if (msg.stats) state.stats = msg.stats;
  $('#octResultModal').classList.remove('hidden');
}

function closeOctagonOverlay() {
  $('#overlay-octmatch').classList.add('hidden');
  if (state.oct.timerInterval) { clearInterval(state.oct.timerInterval); state.oct.timerInterval = null; }
}

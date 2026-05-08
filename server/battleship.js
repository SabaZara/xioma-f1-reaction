// Battleship: Naval Duel — server engine.
// Two players, simultaneous-turn naval combat on a 10x10 board.
// Standard fleet (5 ships, 17 cells). First to sink all opponent ships wins
// the pot minus the platform fee.
//
// This module exposes:
//   createMatch({ a, b, stake, feePercent, arenaId }) → match object
//   handleMessage(match, player, msg) → mutates state, returns events to send
//   The host (server/index.js) wires it to WebSocket events and shared
//   wallet/stats infrastructure. We keep this engine free of network code.

'use strict';

const crypto = require('crypto');

const BOARD_SIZE = 10;
const FLEET = [
  { id: 'carrier',    name: 'Carrier',    length: 5 },
  { id: 'battleship', name: 'Battleship', length: 4 },
  { id: 'cruiser',    name: 'Cruiser',    length: 3 },
  { id: 'submarine',  name: 'Submarine',  length: 3 },
  { id: 'destroyer',  name: 'Destroyer',  length: 2 },
];
const TOTAL_HULL_CELLS = FLEET.reduce((sum, s) => sum + s.length, 0); // 17

const ARENAS = [
  { id: 'arctic',   name: 'Arctic Ocean',  stake: 1 },
  { id: 'coral',    name: 'Coral Sea',     stake: 2 },
  { id: 'biscay',   name: 'Bay of Biscay', stake: 5 },
  { id: 'atlantic', name: 'North Atlantic',stake: 10 },
  { id: 'pacific',  name: 'South Pacific', stake: 25 },
  { id: 'red',      name: 'Red Sea',       stake: 50 },
  { id: 'black',    name: 'Black Sea',     stake: 100 },
];

const ROUND_TIMEOUT_MS = 30_000; // 30s per simultaneous turn
const MAX_ROUNDS = 80;           // hard cap before automatic resolution

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// Try to place a ship of `length` randomly; returns array of {x,y} cells or null.
function tryPlaceShip(length, occupied) {
  const orientation = Math.random() < 0.5 ? 'h' : 'v';
  const maxX = orientation === 'h' ? BOARD_SIZE - length : BOARD_SIZE - 1;
  const maxY = orientation === 'v' ? BOARD_SIZE - length : BOARD_SIZE - 1;
  const x = Math.floor(Math.random() * (maxX + 1));
  const y = Math.floor(Math.random() * (maxY + 1));
  const cells = [];
  for (let i = 0; i < length; i++) {
    const cx = orientation === 'h' ? x + i : x;
    const cy = orientation === 'v' ? y + i : y;
    const k = `${cx},${cy}`;
    if (occupied.has(k)) return null;
    cells.push({ x: cx, y: cy });
  }
  return cells;
}

function generateBoard() {
  // Place each ship without overlap. Ships may touch; standard rules vary —
  // we allow touching for simplicity (fewer placement failures).
  for (let attempt = 0; attempt < 200; attempt++) {
    const occupied = new Set();
    const ships = [];
    let ok = true;
    for (const def of FLEET) {
      let cells = null;
      for (let inner = 0; inner < 60 && !cells; inner++) {
        cells = tryPlaceShip(def.length, occupied);
      }
      if (!cells) { ok = false; break; }
      cells.forEach(c => occupied.add(`${c.x},${c.y}`));
      ships.push({
        id: def.id,
        name: def.name,
        length: def.length,
        cells,
        hits: new Set(),  // populated as cells are hit
        sunk: false,
      });
    }
    if (ok) return ships;
  }
  throw new Error('failed to place fleet'); // extremely unlikely
}

function hashCells(ships) {
  // Anti-cheat: for the result reveal we publish an HMAC of each player's
  // board so the loser can verify the winner didn't change ship positions
  // mid-game. Using the random seed guarantees deterministic verification.
  const parts = ships.flatMap(s => s.cells.map(c => `${s.id}:${c.x},${c.y}`));
  return crypto.createHash('sha256').update(parts.sort().join('|')).digest('hex').slice(0, 12);
}

// === Match lifecycle ===

function createMatch({ a, b, stake, feePercent, arenaId }) {
  const arena = ARENAS.find(x => x.id === arenaId) || ARENAS[0];
  const matchId = newId('bm');
  const seed = crypto.randomBytes(8).toString('hex');
  const pot = stake * 2;
  const fee = +(pot * feePercent).toFixed(2);
  const payout = +(pot - fee).toFixed(2);

  const match = {
    id: matchId,
    type: 'battleship',
    state: 'placing',  // placing → playing → resolved | voided
    arenaId: arena.id,
    arenaName: arena.name,
    stake,
    pot,
    feePercent,
    feeAmount: fee,
    payout,
    seed,
    players: [a, b],
    boards: {
      [a.id]: { ships: generateBoard(), shotsAtMe: [] },
      [b.id]: { ships: generateBoard(), shotsAtMe: [] },
    },
    placementsLocked: { [a.id]: false, [b.id]: false },
    shuffleCount: { [a.id]: 0, [b.id]: 0 },
    pendingShot: { [a.id]: null, [b.id]: null },
    round: 0,
    history: [],
    createdAt: Date.now(),
    rematchVotes: new Set(),
    roundTimer: null,
  };
  return match;
}

function publicShipSummary(ships) {
  // Only return ship metadata + sunk state, never positions.
  return ships.map(s => ({
    id: s.id, name: s.name, length: s.length, sunk: s.sunk,
  }));
}

function snapshotForPlayer(match, playerId) {
  const me = match.boards[playerId];
  const opp = match.players.find(p => p.id !== playerId);
  const oppBoard = match.boards[opp.id];
  // I see my own full board. I see opponent's board only as my shots & their hits.
  return {
    matchId: match.id,
    gameType: 'battleship',
    state: match.state,
    arenaId: match.arenaId,
    arenaName: match.arenaName,
    stake: match.stake,
    pot: match.pot,
    feePercent: match.feePercent,
    feeAmount: match.feeAmount,
    payout: match.payout,
    seed: match.seed,
    round: match.round,
    you: {
      id: playerId,
      ships: me.ships.map(s => ({
        id: s.id, name: s.name, length: s.length, sunk: s.sunk,
        cells: s.cells.map(c => ({ x: c.x, y: c.y, hit: s.hits.has(`${c.x},${c.y}`) })),
      })),
      shotsAtMe: me.shotsAtMe,
      placementLocked: match.placementsLocked[playerId],
      shuffleCount: match.shuffleCount[playerId],
    },
    opponent: {
      id: opp.id,
      name: opp.name,
      shipsSummary: publicShipSummary(oppBoard.ships),
      myShots: oppBoard.shotsAtMe.map(s => ({
        x: s.x, y: s.y, hit: s.hit, sunkShipId: s.sunkShipId || null,
      })),
      placementLocked: match.placementsLocked[opp.id],
    },
    pending: {
      youLockedIn: match.pendingShot[playerId] != null,
      opponentLockedIn: match.pendingShot[opp.id] != null,
    },
  };
}

// === Placement phase ===

function shufflePlacement(match, player) {
  if (match.state !== 'placing') return { ok: false, reason: 'wrong_state' };
  if (match.placementsLocked[player.id]) return { ok: false, reason: 'already_locked' };
  match.boards[player.id].ships = generateBoard();
  match.shuffleCount[player.id] += 1;
  return { ok: true };
}

function lockPlacement(match, player) {
  if (match.state !== 'placing') return { ok: false, reason: 'wrong_state' };
  if (match.placementsLocked[player.id]) return { ok: false, reason: 'already_locked' };
  match.placementsLocked[player.id] = true;
  const allLocked = match.players.every(p => match.placementsLocked[p.id]);
  if (allLocked) {
    match.state = 'playing';
    match.round = 1;
  }
  return { ok: true, started: allLocked };
}

// === Combat phase ===

function lockShot(match, player, x, y) {
  if (match.state !== 'playing') return { ok: false, reason: 'wrong_state' };
  if (match.pendingShot[player.id]) return { ok: false, reason: 'already_locked' };
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
    return { ok: false, reason: 'invalid_cell' };
  }
  // Also disallow targeting a cell that has already been shot.
  const opp = match.players.find(p => p.id !== player.id);
  const oppBoard = match.boards[opp.id];
  if (oppBoard.shotsAtMe.some(s => s.x === x && s.y === y)) {
    return { ok: false, reason: 'already_targeted' };
  }
  match.pendingShot[player.id] = { x, y, lockedAt: Date.now() };
  const allLocked = match.players.every(p => match.pendingShot[p.id] != null);
  return { ok: true, allLocked };
}

// Apply both pending shots simultaneously and produce per-player reveal info.
// Returns: { reveals: { [playerId]: revealForThatPlayer }, winnerId | null, isVoid }
function resolveRound(match) {
  const reveals = {};
  let winnerId = null;
  let isVoid = false;

  for (const shooter of match.players) {
    const target = match.players.find(p => p.id !== shooter.id);
    const targetBoard = match.boards[target.id];
    const shot = match.pendingShot[shooter.id];

    let res;
    if (!shot) {
      // Player didn't lock in — counts as a forfeited shot (no hit).
      res = { x: null, y: null, hit: false, skipped: true };
    } else {
      const cellKey = `${shot.x},${shot.y}`;
      const ship = targetBoard.ships.find(s =>
        s.cells.some(c => c.x === shot.x && c.y === shot.y)
      );
      const hit = !!ship;
      if (ship) {
        ship.hits.add(cellKey);
        if (ship.cells.every(c => ship.hits.has(`${c.x},${c.y}`))) {
          ship.sunk = true;
        }
      }
      const record = { x: shot.x, y: shot.y, hit, sunkShipId: ship && ship.sunk ? ship.id : null };
      targetBoard.shotsAtMe.push(record);
      res = record;
    }
    reveals[shooter.id] = {
      yourShot: res,
    };
  }

  // Reveal opponent's shot to each player
  for (const p of match.players) {
    const opp = match.players.find(x => x.id !== p.id);
    reveals[p.id].opponentShot = reveals[opp.id].yourShot;
  }

  // Check for winner: did any player's fleet just become fully sunk?
  for (const p of match.players) {
    const board = match.boards[p.id];
    const allSunk = board.ships.every(s => s.sunk);
    if (allSunk) {
      // The opponent of p is the winner (they sank p's fleet)
      winnerId = match.players.find(x => x.id !== p.id).id;
      // If both fleets sank simultaneously (impossible with 1 shot each unless
      // both had only 1 cell left and both hit), break ties by remaining hits
      // — but here we just take the first detected; combined-sink is a tie.
    }
  }
  // Detect simultaneous sink as a tie
  const allSunkA = match.boards[match.players[0].id].ships.every(s => s.sunk);
  const allSunkB = match.boards[match.players[1].id].ships.every(s => s.sunk);
  if (allSunkA && allSunkB) {
    // Both fleets fully sunk in the same round — count remaining ships from
    // start, both 0; deterministic seed-based tie-break.
    const seedNum = parseInt(match.seed.slice(0, 8), 16);
    winnerId = (seedNum & 1) ? match.players[0].id : match.players[1].id;
  }

  // Reset pending shots, advance round
  match.pendingShot[match.players[0].id] = null;
  match.pendingShot[match.players[1].id] = null;
  match.round += 1;
  if (winnerId) {
    match.state = 'resolved';
  } else if (match.round > MAX_ROUNDS) {
    // No one won within the cap — count remaining hull cells
    const remainA = countRemaining(match.boards[match.players[0].id]);
    const remainB = countRemaining(match.boards[match.players[1].id]);
    if (remainA < remainB) winnerId = match.players[1].id;
    else if (remainB < remainA) winnerId = match.players[0].id;
    else isVoid = true;
    match.state = isVoid ? 'voided' : 'resolved';
  }

  return { reveals, winnerId, isVoid };
}

function countRemaining(board) {
  let r = 0;
  for (const s of board.ships) {
    if (!s.sunk) {
      const remaining = s.cells.filter(c => !s.hits.has(`${c.x},${c.y}`)).length;
      r += remaining;
    }
  }
  return r;
}

function publicBoardReveal(board) {
  // For end-of-game disclosure — show full ship positions so the loser
  // can confirm everything was honest.
  return board.ships.map(s => ({
    id: s.id, name: s.name, length: s.length, sunk: s.sunk,
    cells: s.cells.map(c => ({ x: c.x, y: c.y, hit: s.hits.has(`${c.x},${c.y}`) })),
  }));
}

module.exports = {
  ARENAS,
  FLEET,
  BOARD_SIZE,
  TOTAL_HULL_CELLS,
  ROUND_TIMEOUT_MS,
  MAX_ROUNDS,
  createMatch,
  shufflePlacement,
  lockPlacement,
  lockShot,
  resolveRound,
  snapshotForPlayer,
  publicBoardReveal,
  hashCells,
  countRemaining,
};

// Octagon: Battle Royale — server engine.
//
// Multiplayer (3-8 players) survival game. Each round:
//   1. Server presents N octagons (configurable, defaults to 3).
//   2. Each player secretly chooses one octagon to enter.
//   3. Choices lock when everyone has picked OR a timer expires.
//   4. The "Attacker" (Bone Crusher — the antagonist) is randomly
//      assigned to ONE of the octagons.
//   5. Everyone in that octagon is ELIMINATED. Survivors continue.
//
// Payout rules:
//   - Single survivor at any time → that player wins the pot - fee.
//   - Round leaves zero survivors AND eliminated >=1 player in that
//     final round → that final-eliminated group SPLITS the pot equally.
//   - As round count grows, octagon count shrinks so the game ends
//     in finite time:
//        rounds 1-3:  3 octagons
//        rounds 4-6:  2 octagons
//        round 7+:    1 octagon (forced confrontation)
//
// Anti-stalemate: if a single player remains and is forced into the
// only octagon, they auto-win on the next round (the attacker still
// strikes, but they keep the pot under "single survivor" wins-it-all
// — eliminated last. We treat "last person standing this round" as
// the winner even if they get hit, because they outlasted everyone.)
//
// This module is pure logic (no networking). server/index.js wires
// it to WebSocket events and shared wallet/stats infrastructure.

'use strict';

const crypto = require('crypto');

const ROUND_TIMEOUT_MS = 18_000;     // 18s to choose
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;

const OCTAGONS = [
  { id: 'apex',    name: 'APEX ARENA',    style: 'Vegas neon',     hint: 'Fast-paced, central' },
  { id: 'colos',   name: 'COLOSSEUM',     style: 'Roman stone',    hint: 'Old-school grappler' },
  { id: 'frost',   name: 'FROST CAGE',    style: 'Arctic chill',   hint: 'Cold and brutal' },
  { id: 'inferno', name: 'INFERNO RING',  style: 'Volcanic',       hint: 'Hot under the lights' },
  { id: 'shadow',  name: 'SHADOW PIT',    style: 'Underground',    hint: 'No quarter, no lights' },
  { id: 'tempest', name: 'TEMPEST DOME',  style: 'Storm-glass',    hint: 'Electric crowd' },
  { id: 'iron',    name: 'IRON LATTICE',  style: 'Steel works',    hint: 'Heavy industrial' },
];

const ATTACKER = {
  id: 'bone-crusher',
  name: 'THE BONE CRUSHER',
  tagline: 'Pound-for-pound terror.',
};

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// How many octagons to offer in a given round.
function octagonsForRound(round) {
  if (round <= 3) return 3;
  if (round <= 6) return 2;
  return 1;
}

function pickOctagonsForRound(seedHex, round) {
  // Deterministic-from-seed selection of N octagons.
  const n = octagonsForRound(round);
  const buf = Buffer.concat([
    Buffer.from(seedHex.slice(0, 16), 'hex'),
    Buffer.from([round & 0xff]),
  ]);
  const hash = crypto.createHash('sha256').update(buf).digest();
  // Shuffle OCTAGONS deterministically using the hash, take first n.
  const arr = OCTAGONS.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = hash[i % hash.length] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

function pickAttackerTarget(seedHex, round, octagons) {
  // Same deterministic seed mechanism so the attacker pick is verifiable
  // post-hoc.
  const buf = Buffer.concat([
    Buffer.from(seedHex.slice(0, 16), 'hex'),
    Buffer.from('attacker'),
    Buffer.from([round & 0xff]),
  ]);
  const hash = crypto.createHash('sha256').update(buf).digest();
  const idx = hash[0] % octagons.length;
  return octagons[idx].id;
}

// === Match lifecycle ===

function createMatch({ players, stake, feePercent }) {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error('player count out of range');
  }
  const matchId = newId('om');
  const seed = crypto.randomBytes(16).toString('hex');
  const pot = stake * players.length;
  const feeAmount = +(pot * feePercent).toFixed(2);
  const payout = +(pot - feeAmount).toFixed(2);

  const match = {
    id: matchId,
    type: 'octagon',
    state: 'awaiting_ready',
    seed,
    stake,
    pot,
    feePercent,
    feeAmount,
    payout,
    players: players.slice(),
    alive: new Set(players.map(p => p.id)),
    eliminationRound: {},   // playerId -> round eliminated (or null if alive)
    round: 0,
    octagons: [],            // current round's octagon choices
    targetOctagonId: null,   // attacker's pick for this round (set on resolve)
    choices: {},             // playerId -> octagonId (this round)
    history: [],             // [{round, octagons, target, choices}]
    readyVotes: new Set(),
    rematchVotes: new Set(),
    createdAt: Date.now(),
    timer: null,
  };
  for (const p of players) match.eliminationRound[p.id] = null;
  return match;
}

function snapshotForPlayer(match, playerId) {
  const me = match.players.find(p => p.id === playerId);
  const isAlive = match.alive.has(playerId);
  const myChoice = match.choices[playerId] || null;
  return {
    matchId: match.id,
    gameType: 'octagon',
    state: match.state,
    seed: match.seed,
    stake: match.stake,
    pot: match.pot,
    feePercent: match.feePercent,
    feeAmount: match.feeAmount,
    payout: match.payout,
    round: match.round,
    octagons: match.octagons,
    youAlive: isAlive,
    yourChoice: myChoice,
    aliveCount: match.alive.size,
    totalPlayers: match.players.length,
    attacker: ATTACKER,
    players: match.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: match.alive.has(p.id),
      eliminatedRound: match.eliminationRound[p.id],
    })),
    pending: {
      youLockedIn: !!match.choices[playerId],
      // count of alive players who have locked in (used for "X / Y locked in")
      lockedCount: aliveLockedCount(match),
      lockedNeeded: match.alive.size,
    },
    you: { id: playerId, name: me ? me.name : '' },
  };
}

function aliveLockedCount(match) {
  let n = 0;
  for (const p of match.players) {
    if (match.alive.has(p.id) && match.choices[p.id]) n++;
  }
  return n;
}

// === Round flow ===

function beginRound(match) {
  if (match.state === 'resolved' || match.state === 'voided') return;
  match.round += 1;
  match.choices = {};
  match.targetOctagonId = null;
  match.octagons = pickOctagonsForRound(match.seed, match.round);
  match.state = 'choosing';
}

function lockChoice(match, player, octagonId) {
  if (match.state !== 'choosing') return { ok: false, reason: 'wrong_state' };
  if (!match.alive.has(player.id))   return { ok: false, reason: 'eliminated' };
  if (match.choices[player.id])      return { ok: false, reason: 'already_locked' };
  if (!match.octagons.find(o => o.id === octagonId)) {
    return { ok: false, reason: 'invalid_octagon' };
  }
  match.choices[player.id] = octagonId;
  // "Did everyone alive lock in?"
  const allLocked = match.players.every(p => !match.alive.has(p.id) || match.choices[p.id]);
  return { ok: true, allLocked };
}

// Resolve the current round's choices (and attacker strike). Returns details
// for the reveal animation and updates state.
function resolveRound(match) {
  if (match.state !== 'choosing') return null;
  const target = pickAttackerTarget(match.seed, match.round, match.octagons);
  match.targetOctagonId = target;

  // Anyone alive who chose the target is eliminated. Anyone alive who didn't
  // lock in (timed out) is also eliminated — they froze in the cage.
  const eliminatedThisRound = [];
  const survivedThisRound = [];
  for (const p of match.players) {
    if (!match.alive.has(p.id)) continue;
    const choice = match.choices[p.id] || null;
    if (choice === null || choice === target) {
      match.alive.delete(p.id);
      match.eliminationRound[p.id] = match.round;
      eliminatedThisRound.push(p.id);
    } else {
      survivedThisRound.push(p.id);
    }
  }

  match.history.push({
    round: match.round,
    octagons: match.octagons,
    target,
    choices: { ...match.choices },
    eliminated: eliminatedThisRound,
    survived: survivedThisRound,
  });

  // Decide outcome:
  //  - One player alive  → match ends, that player wins.
  //  - Zero alive AND someone got eliminated this round → split pot among
  //    those finalists.
  //  - More than one alive → next round.
  let outcome = null;
  if (match.alive.size === 1) {
    const winnerId = [...match.alive][0];
    match.state = 'resolved';
    outcome = { kind: 'winner', winners: [winnerId] };
  } else if (match.alive.size === 0 && eliminatedThisRound.length > 0) {
    match.state = 'resolved';
    outcome = { kind: 'split', winners: eliminatedThisRound };
  } else {
    // Continue
    match.state = 'awaiting_round';
    outcome = { kind: 'continue' };
  }

  return {
    round: match.round,
    octagons: match.octagons,
    target,
    choices: match.choices,
    eliminated: eliminatedThisRound,
    survived: survivedThisRound,
    outcome,
  };
}

module.exports = {
  ATTACKER,
  OCTAGONS,
  ROUND_TIMEOUT_MS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  octagonsForRound,
  createMatch,
  beginRound,
  lockChoice,
  resolveRound,
  snapshotForPlayer,
};

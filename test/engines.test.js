'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const PB = require('../public/js/engines.js');

const names = n => Array.from({ length: n }, (_, i) => 'Player' + (i + 1));
function mkEvent(over) {
  return Object.assign({
    id: 'TESTEV', format: 'round_robin', courts: ['A', 'B'], numRounds: 6,
    balanceDupr: false, trophy: false,
    players: names(8).map(n => ({ name: n, dupr: null, club: "Franco's" })),
    pairs: null, teams: null, homeClub: null, visitorClub: null, rounds: []
  }, over || {});
}
/* Play out an event: generate every round, scoring with scoreFn(roundIdx, matchIdx, match). */
function playOut(ev, scoreFn) {
  const fn = scoreFn || (() => [11, 7]);
  for (let r = 0; r < ev.numRounds; r++) {
    const round = PB.generateRound(ev, ev.id);
    const errs = PB.validateRound(round, ev);
    assert.deepStrictEqual(errs, [], ev.format + ' round ' + (r + 1) + ': ' + errs.join('; '));
    round.matches.forEach((m, mi) => { const [a, b] = fn(r, mi, m); m.scoreA = a; m.scoreB = b; });
    ev.rounds.push(round);
  }
  return ev;
}
function partnerRepeats(rounds) {
  const seen = new Map(); let repeats = 0;
  rounds.forEach(r => r.matches.forEach(m => {
    [m.a, m.b].forEach(pair => {
      const k = PB.pairKey(pair[0], pair[1]);
      if (seen.has(k)) repeats++;
      seen.set(k, true);
    });
  }));
  return repeats;
}

test('round robin: valid rounds, partner repeats minimized', () => {
  const ev = playOut(mkEvent({ numRounds: 6 }));
  assert.strictEqual(ev.rounds.length, 6);
  ev.rounds.forEach(r => assert.strictEqual(r.matches.length, 2));
  const reps = partnerRepeats(ev.rounds);
  // 8 players: a no-repeat schedule exists for the first several rounds; the
  // optimizer should keep total repeated partnerships very low over 6 rounds.
  assert.ok(reps <= 2, 'expected <=2 repeated partnerships over 6 rounds, got ' + reps);
});

test('round robin: byes are fair when players exceed court spots', () => {
  const ev = mkEvent({ courts: ['A', 'B'], numRounds: 6, players: names(10).map(n => ({ name: n, dupr: null })) });
  playOut(ev);
  const byeCount = {};
  ev.rounds.forEach(r => {
    assert.strictEqual(r.byes.length, 2);
    r.byes.forEach(n => { byeCount[n] = (byeCount[n] || 0) + 1; });
  });
  const counts = names(10).map(n => byeCount[n] || 0);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'bye counts unfair: ' + counts.join(','));
});

test('round robin: DUPR balancing keeps pair sums close', () => {
  const ps = names(8).map((n, i) => ({ name: n, dupr: [5.0, 5.0, 3.0, 3.0, 4.5, 4.5, 3.5, 3.5][i] }));
  const ev = mkEvent({ players: ps, balanceDupr: true, numRounds: 1 });
  playOut(ev);
  const duprOf = n => ps.find(p => p.name === n).dupr;
  ev.rounds[0].matches.forEach(m => {
    const sA = m.a.reduce((s, n) => s + duprOf(n), 0);
    const sB = m.b.reduce((s, n) => s + duprOf(n), 0);
    assert.ok(Math.abs(sA - sB) <= 2.0, 'lopsided pairing: ' + sA + ' vs ' + sB);
  });
});

test('mix-up: valid rounds and fair byes', () => {
  const ev = mkEvent({ format: 'mix_up', courts: ['A'], numRounds: 8, players: names(6).map(n => ({ name: n, dupr: null })) });
  playOut(ev);
  ev.rounds.forEach(r => { assert.strictEqual(r.matches.length, 1); assert.strictEqual(r.byes.length, 2); });
  const byeCount = {};
  ev.rounds.forEach(r => r.byes.forEach(n => { byeCount[n] = (byeCount[n] || 0) + 1; }));
  const counts = names(6).map(n => byeCount[n] || 0);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'mix-up byes unfair: ' + counts.join(','));
});

function fixedPairEvent(format, numPairs, courts) {
  const ps = names(numPairs * 2).map(n => ({ name: n, dupr: null }));
  const pairs = [];
  for (let i = 0; i < ps.length; i += 2) pairs.push({ players: [ps[i].name, ps[i + 1].name], club: "Franco's" });
  return mkEvent({ format, players: ps, pairs, courts, numRounds: 5 });
}

test('mixed doubles: pairs stay fixed, opponents rotate without repeats', () => {
  const ev = playOut(fixedPairEvent('mixed_doubles', 6, ['A', 'B', 'C']));
  const pairSet = new Set(ev.pairs.map(p => PB.pairKey(p.players[0], p.players[1])));
  const oppSeen = new Set();
  ev.rounds.forEach(r => {
    assert.strictEqual(r.matches.length, 3);
    r.matches.forEach(m => {
      assert.ok(pairSet.has(PB.pairKey(m.a[0], m.a[1])), 'team A is not a fixed pair');
      assert.ok(pairSet.has(PB.pairKey(m.b[0], m.b[1])), 'team B is not a fixed pair');
      const ok = PB.pairKey(m.a[0], m.a[1]) + ' vs ' + PB.pairKey(m.b[0], m.b[1]);
      assert.ok(!oppSeen.has(ok), 'opponent repeat: ' + ok);
      oppSeen.add(ok);
    });
  });
});

test('set partners: same engine, pairs fixed across rounds', () => {
  const ev = playOut(fixedPairEvent('set_partners', 4, ['A', 'B']));
  const pairSet = new Set(ev.pairs.map(p => PB.pairKey(p.players[0], p.players[1])));
  ev.rounds.forEach(r => r.matches.forEach(m => {
    assert.ok(pairSet.has(PB.pairKey(m.a[0], m.a[1])));
    assert.ok(pairSet.has(PB.pairKey(m.b[0], m.b[1])));
  }));
});

test('ladder: courts re-seeded by standings after round 1', () => {
  const ev = mkEvent({ format: 'ladder', numRounds: 2 });
  // Round 1: team A wins on both courts -> those 4 players should top the ladder.
  const r1 = PB.generateRound(ev, ev.id);
  r1.matches.forEach(m => { m.scoreA = 11; m.scoreB = 3; });
  ev.rounds.push(r1);
  const winners = r1.matches.flatMap(m => m.a);
  const r2 = PB.generateRound(ev, ev.id);
  assert.deepStrictEqual(PB.validateRound(r2, ev), []);
  const topCourt = r2.matches.find(m => m.court === 'A');
  const topPlayers = topCourt.a.concat(topCourt.b).sort();
  assert.deepStrictEqual(topPlayers, winners.slice().sort(), 'top court should be round-1 winners');
  // Pairing splits seeds 1&4 vs 2&3 on the top court.
  const standings = PB.computeStandings(r1.matches, names(8));
  assert.deepStrictEqual(topCourt.a.slice().sort(), [standings[0].name, standings[3].name].sort());
});

test('king of the court: winners move up, losers down, partners split', () => {
  const ev = mkEvent({ format: 'king_of_court', numRounds: 2 });
  const r1 = PB.generateRound(ev, ev.id);
  // Court A: team A wins. Court B: team B wins.
  r1.matches.forEach(m => {
    if (m.court === 'A') { m.scoreA = 11; m.scoreB = 5; }
    else { m.scoreA = 4; m.scoreB = 11; }
  });
  ev.rounds.push(r1);
  const courtA = r1.matches.find(m => m.court === 'A');
  const courtB = r1.matches.find(m => m.court === 'B');
  const winnersAll = courtA.a.concat(courtB.b); // both winning pairs
  const losersAll = courtA.b.concat(courtB.a);
  const r2 = PB.generateRound(ev, ev.id);
  assert.deepStrictEqual(PB.validateRound(r2, ev), []);
  const top = r2.matches.find(m => m.court === 'A');
  const bottom = r2.matches.find(m => m.court === 'B');
  assert.deepStrictEqual(top.a.concat(top.b).sort(), winnersAll.slice().sort(), 'top court = both winning pairs');
  assert.deepStrictEqual(bottom.a.concat(bottom.b).sort(), losersAll.slice().sort(), 'bottom court = both losing pairs');
  // Partners split: no round-1 pair survives intact on either court.
  const r1Pairs = new Set(r1.matches.flatMap(m => [PB.pairKey(m.a[0], m.a[1]), PB.pairKey(m.b[0], m.b[1])]));
  r2.matches.forEach(m => {
    assert.ok(!r1Pairs.has(PB.pairKey(m.a[0], m.a[1])), 'pair not split');
    assert.ok(!r1Pairs.has(PB.pairKey(m.b[0], m.b[1])), 'pair not split');
  });
});

test('team battle: two doubles games per tie, players once per round', () => {
  const ps = names(8).map(n => ({ name: n, dupr: null }));
  const teams = [
    { name: 'Team 1', members: ps.slice(0, 4).map(p => p.name) },
    { name: 'Team 2', members: ps.slice(4, 8).map(p => p.name) }
  ];
  const ev = playOut(mkEvent({ format: 'team_battle', players: ps, teams, courts: ['A', 'B', 'C', 'D'], numRounds: 3 }));
  ev.rounds.forEach(r => {
    assert.strictEqual(r.matches.length, 2, 'one tie = two games');
    r.matches.forEach(m => {
      assert.deepStrictEqual(m.meta.teams, ['Team 1', 'Team 2']);
      const inTeam = (pair, team) => pair.every(n => team.members.includes(n));
      assert.ok(inTeam(m.a, teams[0]) && inTeam(m.b, teams[1]) || inTeam(m.a, teams[1]) && inTeam(m.b, teams[0]));
    });
  });
  const ts = PB.computeTeamStandings(ev.rounds.flatMap(r => r.matches), teams);
  assert.strictEqual(ts[0].name, 'Team 1'); // default scoreFn: side A wins 11-7; Team 1 is side A in game pairings
  assert.ok(ts[0].W > 0);
});

test('club vs club: home teams keep courts, visitors rotate one court per round', () => {
  const hp = ['H1', 'H2', 'H3', 'H4'], vp = ['V1', 'V2', 'V3', 'V4'];
  const ps = hp.concat(vp).map(n => ({ name: n, dupr: null, club: n[0] === 'H' ? 'Home' : 'Away' }));
  const pairs = [
    { players: ['H1', 'H2'], club: 'Home' }, { players: ['H3', 'H4'], club: 'Home' },
    { players: ['V1', 'V2'], club: 'Away' }, { players: ['V3', 'V4'], club: 'Away' }
  ];
  const ev = playOut(mkEvent({
    format: 'club_vs_club', players: ps, pairs, courts: ['A', 'B'], numRounds: 2,
    homeClub: 'Home', visitorClub: 'Away'
  }));
  const [r1, r2] = ev.rounds;
  const homeOn = (round, court) => round.matches.find(m => m.court === court).a.join('+');
  const awayOn = (round, court) => round.matches.find(m => m.court === court).b.join('+');
  assert.strictEqual(homeOn(r1, 'A'), homeOn(r2, 'A'), 'home team must keep court A');
  assert.strictEqual(homeOn(r1, 'B'), homeOn(r2, 'B'), 'home team must keep court B');
  assert.strictEqual(awayOn(r2, 'A'), awayOn(r1, 'B'), 'visitors move one court');
  assert.strictEqual(awayOn(r2, 'B'), awayOn(r1, 'A'), 'visitors move one court');
  // Club totals: default scoring = side A (home) wins every game 11-7.
  const clubOf = pair => (pairs.find(p => PB.samePair(p.players, pair)) || {}).club;
  const totals = PB.clubTotals(ev.rounds.flatMap(r => r.matches), clubOf);
  const home = totals.find(t => t.club === 'Home');
  assert.strictEqual(home.matchesWon, 4);
  assert.strictEqual(home.points, 44);
});

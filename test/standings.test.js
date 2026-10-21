'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const PB = require('../public/js/engines.js');

const M = (a, b, sa, sb) => ({ court: 'A', a, b, scoreA: sa, scoreB: sb });

test('standings math: W/L/GP/PF/PA/diff/winPct exact', () => {
  const matches = [
    M(['Ann', 'Bob'], ['Cal', 'Dan'], 11, 5),
    M(['Ann', 'Cal'], ['Bob', 'Dan'], 11, 9),
    M(['Ann', 'Dan'], ['Bob', 'Cal'], 6, 11)
  ];
  const table = PB.computeStandings(matches, ['Ann', 'Bob', 'Cal', 'Dan']);
  const by = Object.fromEntries(table.map(s => [s.name, s]));
  // Ann: W,W,L -> PF 11+11+6=28, PA 5+9+11=25
  assert.deepStrictEqual([by.Ann.W, by.Ann.L, by.Ann.GP, by.Ann.PF, by.Ann.PA, by.Ann.diff], [2, 1, 3, 28, 25, 3]);
  assert.ok(Math.abs(by.Ann.winPct - 2 / 3) < 1e-9);
  // Bob: W (g1), L (g2), W (g3) -> PF 11+9+11=31, PA 5+11+6=22
  assert.deepStrictEqual([by.Bob.W, by.Bob.L, by.Bob.PF, by.Bob.PA], [2, 1, 31, 22]);
  // Cal: L, W, W -> PF 5+11+11=27, PA 11+9+6=26
  assert.deepStrictEqual([by.Cal.W, by.Cal.L, by.Cal.PF, by.Cal.PA], [2, 1, 27, 26]);
  // Dan: L, L, L -> PF 5+9+6=20, PA 11+11+11=33
  assert.deepStrictEqual([by.Dan.W, by.Dan.L, by.Dan.PF, by.Dan.PA, by.Dan.diff], [0, 3, 20, 33, -13]);
});

test('standings ranking: win% first, then +/-, then games played', () => {
  const matches = [
    // Eve: 2-0 with tiny margins (diff +2)
    M(['Eve', 'P1'], ['P3', 'P4'], 11, 10),
    M(['Eve', 'P2'], ['P5', 'P6'], 11, 10),
    // Fay: 2-1 with huge margins (diff +20) — more GP, better diff, worse win%
    M(['Fay', 'P1'], ['P3', 'P5'], 11, 2),
    M(['Fay', 'P2'], ['P4', 'P6'], 11, 2),
    M(['P1', 'P3'], ['Fay', 'P2'], 11, 4),
    // Gil vs Hal: both 1-1; Gil diff +5, Hal diff +9 -> Hal ahead on diff.
    M(['Gil', 'P1'], ['Hal', 'P3'], 11, 6),
    M(['Hal', 'P2'], ['Gil', 'P4'], 11, 5)
  ];
  const names = ['Eve', 'Fay', 'Gil', 'Hal', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
  const table = PB.computeStandings(matches, names);
  const idx = n => table.findIndex(s => s.name === n);
  assert.ok(idx('Eve') < idx('Fay'), 'win% (1.000) must outrank better diff with lower win%');
  const fay = table.find(s => s.name === 'Fay'), eve = table.find(s => s.name === 'Eve');
  assert.ok(fay.diff > eve.diff && fay.GP > eve.GP, 'setup check: Fay has better diff and more GP');
  assert.ok(idx('Hal') < idx('Gil'), 'equal win% -> higher +/- ranks first');
});

test('standings: unscored matches ignored; tied score counts GP/points but no W/L', () => {
  const matches = [
    M(['A', 'B'], ['C', 'D'], 11, 11),
    { court: 'A', a: ['A', 'B'], b: ['C', 'D'], scoreA: null, scoreB: null }
  ];
  const table = PB.computeStandings(matches, ['A', 'B', 'C', 'D']);
  table.forEach(s => {
    assert.deepStrictEqual([s.W, s.L, s.GP, s.PF, s.PA], [0, 0, 1, 11, 11]);
  });
});

test('pair standings aggregate by fixed pair', () => {
  const pairs = [{ players: ['A', 'B'] }, { players: ['C', 'D'] }];
  const matches = [M(['A', 'B'], ['C', 'D'], 11, 4), M(['C', 'D'], ['A', 'B'], 11, 9)];
  const table = PB.computePairStandings(matches, pairs);
  assert.strictEqual(table[0].name, 'A & B'); // 1-1, diff 0 vs C&D diff 0... PF decides nothing; name tiebreak? check fields:
  const ab = table.find(s => s.name === 'A & B');
  assert.deepStrictEqual([ab.W, ab.L, ab.PF, ab.PA], [1, 1, 20, 15]);
});

/*
 * Franco's Pickleball — pairing engines & standings math.
 * UMD module: works in the browser (window.PB), in Node (tests), and in
 * Netlify Functions (require). Pure functions only — no I/O.
 *
 * Match shape:  { court:'A', a:[name,name], b:[name,name], scoreA, scoreB, meta? }
 * Round shape:  { matches:[Match], byes:[name] }
 * Event shape (fields the engines read):
 *   { id, format, courts:['A','B'], numRounds, balanceDupr,
 *     players:[{name, dupr, club}],
 *     pairs:[{players:[a,b], club}] | null,          // fixed-pair formats + club vs club
 *     teams:[{name, members:[a,b,c,d]}] | null,      // team battle
 *     homeClub, visitorClub,                          // club vs club
 *     rounds:[Round] }                                // completed/prior rounds
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- deterministic RNG ---------------- */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------- helpers ---------------- */
  const pairKey = (a, b) => [a, b].sort().join(' + ');
  const samePair = (p, q) => pairKey(p[0], p[1]) === pairKey(q[0], q[1]);

  function historyFromRounds(rounds) {
    const partner = {}, opponent = {}, byes = {}, games = {};
    const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
    (rounds || []).forEach(r => {
      (r.byes || []).forEach(n => bump(byes, n));
      (r.matches || []).forEach(mt => {
        bump(partner, pairKey(mt.a[0], mt.a[1]));
        bump(partner, pairKey(mt.b[0], mt.b[1]));
        mt.a.forEach(x => mt.b.forEach(y => bump(opponent, pairKey(x, y))));
        mt.a.concat(mt.b).forEach(n => bump(games, n));
      });
    });
    return { partner, opponent, byes, games };
  }

  /* Choose who sits out: fewest byes, then fewest games, then rng. */
  function pickByes(names, count, hist, rng) {
    if (count <= 0) return { playing: names.slice(), byes: [] };
    const ranked = names.map(n => ({
      n, b: hist.byes[n] || 0, g: hist.games[n] || 0, r: rng()
    })).sort((x, y) => (x.b - y.b) || (x.g - y.g) || (x.r - y.r));
    const byeSet = new Set(ranked.slice(0, count).map(x => x.n));
    return {
      playing: names.filter(n => !byeSet.has(n)),
      byes: names.filter(n => byeSet.has(n))
    };
  }

  /* Best of the 3 pairings for one court of 4. */
  function bestPairing(four, hist, duprOf, balance, rng) {
    const combos = [
      [[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]
    ];
    let best = null, bestCost = Infinity;
    combos.forEach(c => {
      const A = [four[c[0][0]], four[c[0][1]]];
      const B = [four[c[1][0]], four[c[1][1]]];
      let cost = (hist.partner[pairKey(A[0], A[1])] || 0) * 10
               + (hist.partner[pairKey(B[0], B[1])] || 0) * 10;
      A.forEach(x => B.forEach(y => { cost += (hist.opponent[pairKey(x, y)] || 0); }));
      if (balance) {
        const sA = A.reduce((s, n) => s + (duprOf(n) || 0), 0);
        const sB = B.reduce((s, n) => s + (duprOf(n) || 0), 0);
        cost += Math.abs(sA - sB) * 1.5;
      }
      cost += rng() * 0.01; // gentle tie-break jitter
      if (cost < bestCost) { bestCost = cost; best = { a: A, b: B }; }
    });
    return best;
  }

  /* ---------------- standings ---------------- */
  function blankStat(name) { return { name, W: 0, L: 0, GP: 0, PF: 0, PA: 0, diff: 0, winPct: 0 }; }
  function finishStat(s) {
    s.diff = s.PF - s.PA;
    s.winPct = (s.W + s.L) > 0 ? s.W / (s.W + s.L) : 0;
    return s;
  }
  function rankSort(list) {
    return list.sort((x, y) =>
      (y.winPct - x.winPct) || (y.diff - x.diff) || (y.GP - x.GP) ||
      String(x.name).localeCompare(String(y.name)));
  }
  function isScored(m) { return m && m.scoreA !== null && m.scoreA !== undefined && m.scoreB !== null && m.scoreB !== undefined; }

  /* Per-player standings from a flat list of matches. */
  function computeStandings(matches, names) {
    const map = {};
    (names || []).forEach(n => { map[n] = blankStat(n); });
    (matches || []).filter(isScored).forEach(m => {
      const winner = m.scoreA > m.scoreB ? 'a' : (m.scoreB > m.scoreA ? 'b' : null);
      m.a.forEach(n => { if (!map[n]) map[n] = blankStat(n); });
      m.b.forEach(n => { if (!map[n]) map[n] = blankStat(n); });
      m.a.forEach(n => { const s = map[n]; s.GP++; s.PF += m.scoreA; s.PA += m.scoreB; if (winner === 'a') s.W++; else if (winner === 'b') s.L++; });
      m.b.forEach(n => { const s = map[n]; s.GP++; s.PF += m.scoreB; s.PA += m.scoreA; if (winner === 'b') s.W++; else if (winner === 'a') s.L++; });
    });
    return rankSort(Object.values(map).map(finishStat));
  }

  /* Per fixed-pair standings (mixed doubles / set partners / club vs club). */
  function computePairStandings(matches, pairs) {
    const map = {};
    (pairs || []).forEach(p => { map[pairKey(p.players[0], p.players[1])] = blankStat(p.players.join(' & ')); });
    (matches || []).filter(isScored).forEach(m => {
      const kA = pairKey(m.a[0], m.a[1]), kB = pairKey(m.b[0], m.b[1]);
      if (!map[kA]) map[kA] = blankStat(m.a.join(' & '));
      if (!map[kB]) map[kB] = blankStat(m.b.join(' & '));
      const winner = m.scoreA > m.scoreB ? 'a' : (m.scoreB > m.scoreA ? 'b' : null);
      const sA = map[kA], sB = map[kB];
      sA.GP++; sA.PF += m.scoreA; sA.PA += m.scoreB; if (winner === 'a') sA.W++; else if (winner === 'b') sA.L++;
      sB.GP++; sB.PF += m.scoreB; sB.PA += m.scoreA; if (winner === 'b') sB.W++; else if (winner === 'a') sB.L++;
    });
    return rankSort(Object.values(map).map(finishStat));
  }

  /* Per-team standings for Team Battle (uses match.meta.teams = [X, Y]). */
  function computeTeamStandings(matches, teams) {
    const map = {};
    (teams || []).forEach(t => { map[t.name] = blankStat(t.name); });
    (matches || []).filter(isScored).forEach(m => {
      if (!m.meta || !m.meta.teams) return;
      const [x, y] = m.meta.teams;
      if (!map[x]) map[x] = blankStat(x);
      if (!map[y]) map[y] = blankStat(y);
      const winner = m.scoreA > m.scoreB ? 'a' : (m.scoreB > m.scoreA ? 'b' : null);
      map[x].GP++; map[x].PF += m.scoreA; map[x].PA += m.scoreB; if (winner === 'a') map[x].W++; else if (winner === 'b') map[x].L++;
      map[y].GP++; map[y].PF += m.scoreB; map[y].PA += m.scoreA; if (winner === 'b') map[y].W++; else if (winner === 'a') map[y].L++;
    });
    return rankSort(Object.values(map).map(finishStat));
  }

  /* Club totals for Club vs Club: matches won + points, per club. */
  function clubTotals(matches, clubOfPair) {
    const totals = {};
    const ensure = c => { if (!totals[c]) totals[c] = { club: c, matchesWon: 0, points: 0 }; };
    (matches || []).filter(isScored).forEach(m => {
      const cA = clubOfPair(m.a), cB = clubOfPair(m.b);
      if (cA) { ensure(cA); totals[cA].points += m.scoreA; if (m.scoreA > m.scoreB) totals[cA].matchesWon++; }
      if (cB) { ensure(cB); totals[cB].points += m.scoreB; if (m.scoreB > m.scoreA) totals[cB].matchesWon++; }
    });
    return Object.values(totals);
  }

  /* Circle-method round-robin schedule over indices 0..n-1 (pads a -1 bye). */
  function circleSchedule(n) {
    const size = n % 2 === 0 ? n : n + 1;
    const arr = [];
    for (let i = 0; i < size; i++) arr.push(i < n ? i : -1);
    const rounds = [];
    for (let r = 0; r < size - 1; r++) {
      const pairs = [];
      for (let i = 0; i < size / 2; i++) pairs.push([arr[i], arr[size - 1 - i]]);
      rounds.push(pairs);
      arr.splice(1, 0, arr.pop());
    }
    return rounds;
  }

  /* ---------------- round generators ---------------- */

  function genRoundRobin(names, ev, hist, rng) {
    const cap = ev.courts.length * 4;
    const { playing, byes } = pickByes(names, Math.max(0, names.length - cap), hist, rng);
    const duprOf = n => { const p = ev.players.find(x => x.name === n); return p ? p.dupr : null; };
    let best = null, bestCost = Infinity;
    const attempts = playing.length <= 4 ? 1 : 140;
    for (let t = 0; t < attempts; t++) {
      const shuffled = shuffle(playing, rng);
      const matches = [];
      let cost = 0;
      for (let i = 0; i < shuffled.length; i += 4) {
        const four = shuffled.slice(i, i + 4);
        if (four.length < 4) break;
        const pr = bestPairing(four, hist, duprOf, ev.balanceDupr, rng);
        cost += (hist.partner[pairKey(pr.a[0], pr.a[1])] || 0) * 10
              + (hist.partner[pairKey(pr.b[0], pr.b[1])] || 0) * 10;
        matches.push({ court: ev.courts[matches.length], a: pr.a, b: pr.b, scoreA: null, scoreB: null });
      }
      if (cost < bestCost) { bestCost = cost; best = matches; }
      if (bestCost === 0) break;
    }
    return { matches: best || [], byes };
  }

  function genMixUp(names, ev, hist, rng) {
    const cap = ev.courts.length * 4;
    const { playing, byes } = pickByes(names, Math.max(0, names.length - cap), hist, rng);
    const shuffled = shuffle(playing, rng);
    const matches = [];
    for (let i = 0; i + 4 <= shuffled.length; i += 4) {
      matches.push({
        court: ev.courts[matches.length],
        a: [shuffled[i], shuffled[i + 1]],
        b: [shuffled[i + 2], shuffled[i + 3]],
        scoreA: null, scoreB: null
      });
    }
    return { matches, byes };
  }

  /* Shared engine for Mixed Doubles + Set Partners RR. */
  function genFixedPairs(ev, hist) {
    const pairs = ev.pairs || [];
    const sched = circleSchedule(pairs.length);
    if (!sched.length) return { matches: [], byes: [] };
    let pairings = sched[ev._roundIndex % sched.length]
      .filter(([i, j]) => i >= 0 && j >= 0);
    const byePairIdx = sched[ev._roundIndex % sched.length]
      .filter(([i, j]) => i < 0 || j < 0)
      .map(([i, j]) => (i < 0 ? j : i));
    // Fair court access: pairings whose pairs have played least get courts first.
    const pairGames = idx => (hist.games[pairs[idx].players[0]] || 0);
    pairings = pairings.slice().sort((p, q) => (pairGames(p[0]) + pairGames(p[1])) - (pairGames(q[0]) + pairGames(q[1])));
    const used = pairings.slice(0, ev.courts.length);
    const sitting = pairings.slice(ev.courts.length);
    const byes = [];
    byePairIdx.forEach(i => byes.push(...pairs[i].players));
    sitting.forEach(([i, j]) => { byes.push(...pairs[i].players, ...pairs[j].players); });
    const matches = used.map(([i, j], k) => ({
      court: ev.courts[k],
      a: pairs[i].players.slice(), b: pairs[j].players.slice(),
      scoreA: null, scoreB: null,
      meta: { pairIdx: [i, j] }
    }));
    return { matches, byes };
  }

  function seedOrder(names, ev, rng) {
    const withDupr = ev.players.filter(p => p.dupr !== null && p.dupr !== undefined);
    if (withDupr.length === names.length && names.length > 0) {
      const duprOf = n => ev.players.find(p => p.name === n).dupr;
      return names.slice().sort((a, b) => duprOf(b) - duprOf(a));
    }
    return shuffle(names, rng);
  }

  function genLadder(names, ev, hist, rng) {
    const cap = ev.courts.length * 4;
    let order;
    if (ev._roundIndex === 0) {
      order = seedOrder(names, ev, rng);
    } else {
      const played = (ev.rounds || []).flatMap(r => r.matches || []);
      order = computeStandings(played, names).map(s => s.name);
    }
    const playing = order.slice(0, cap);
    const byes = order.slice(cap);
    const matches = [];
    for (let i = 0; i + 4 <= playing.length; i += 4) {
      const f = playing.slice(i, i + 4);
      matches.push({ court: ev.courts[matches.length], a: [f[0], f[3]], b: [f[1], f[2]], scoreA: null, scoreB: null });
    }
    return { matches, byes };
  }

  function genKing(names, ev, hist, rng) {
    const cap = ev.courts.length * 4;
    const courts = ev.courts;
    if (ev._roundIndex === 0) {
      const { playing, byes } = pickByes(seedOrder(names, ev, rng), Math.max(0, names.length - cap), hist, rng);
      const matches = [];
      for (let i = 0; i + 4 <= playing.length; i += 4) {
        const f = playing.slice(i, i + 4);
        matches.push({ court: courts[matches.length], a: [f[0], f[3]], b: [f[1], f[2]], scoreA: null, scoreB: null });
      }
      return { matches, byes };
    }
    const prev = ev.rounds[ev.rounds.length - 1];
    const prevMatches = (prev.matches || []).slice()
      .sort((m1, m2) => courts.indexOf(m1.court) - courts.indexOf(m2.court));
    // Winners/losers per court (tie -> team A counts as winners).
    const W = [], L = [];
    prevMatches.forEach(m => {
      const aWon = (m.scoreA || 0) >= (m.scoreB || 0);
      W.push(aWon ? m.a : m.b);
      L.push(aWon ? m.b : m.a);
    });
    const n = prevMatches.length;
    const rosters = [];
    for (let i = 0; i < n; i++) {
      let g1, g2;
      if (i === 0) { g1 = W[0]; g2 = n > 1 ? W[1] : L[0]; }
      else if (i === n - 1) { g1 = L[n - 2]; g2 = L[n - 1]; }
      else { g1 = L[i - 1]; g2 = W[i + 1]; }
      rosters.push({ g1: g1.slice(), g2: g2.slice() });
    }
    // Sit-out swap: last round's byes rotate in at the bottom court,
    // replacing the bottom-court players with the most games played.
    let byes = [];
    const prevByes = (prev.byes || []).slice();
    if (prevByes.length && rosters.length) {
      const bottom = rosters[rosters.length - 1];
      const bottomPlayers = bottom.g1.concat(bottom.g2);
      const ranked = bottomPlayers.slice().sort((a, b) => (hist.games[b] || 0) - (hist.games[a] || 0));
      const swapOut = ranked.slice(0, Math.min(prevByes.length, 2));
      const swapIn = prevByes.slice(0, swapOut.length);
      const keep = bottomPlayers.filter(p => !swapOut.includes(p));
      const merged = keep.concat(swapIn);
      bottom.g1 = merged.slice(0, 2);
      bottom.g2 = merged.slice(2, 4);
      byes = swapOut.concat(prevByes.slice(swapOut.length));
    }
    const matches = rosters.map((r, i) => ({
      court: courts[i],
      a: [r.g1[0], r.g2[0]],
      b: [r.g1[1], r.g2[1]],
      scoreA: null, scoreB: null
    }));
    return { matches, byes };
  }

  function genTeamBattle(ev, hist) {
    const teams = ev.teams || [];
    const sched = circleSchedule(teams.length);
    if (!sched.length) return { matches: [], byes: [] };
    let pairings = sched[ev._roundIndex % sched.length]
      .filter(([i, j]) => i >= 0 && j >= 0);
    const byeTeamIdx = sched[ev._roundIndex % sched.length]
      .filter(([i, j]) => i < 0 || j < 0).map(([i, j]) => (i < 0 ? j : i));
    const teamGames = idx => (hist.games[teams[idx].members[0]] || 0);
    pairings = pairings.slice().sort((p, q) => (teamGames(p[0]) + teamGames(p[1])) - (teamGames(q[0]) + teamGames(q[1])));
    const tiesFit = Math.max(1, Math.floor(ev.courts.length / 2));
    const used = pairings.slice(0, tiesFit);
    const sitting = pairings.slice(tiesFit);
    const byes = [];
    byeTeamIdx.forEach(i => byes.push(...teams[i].members));
    sitting.forEach(([i, j]) => { byes.push(...teams[i].members, ...teams[j].members); });
    const matches = [];
    used.forEach(([i, j], t) => {
      const X = teams[i], Y = teams[j];
      const xp = [X.members.slice(0, 2), X.members.slice(2, 4)];
      const yp = [Y.members.slice(0, 2), Y.members.slice(2, 4)];
      for (let g = 0; g < 2; g++) {
        const courtIdx = Math.min(t * 2 + g, ev.courts.length - 1);
        matches.push({
          court: ev.courts[courtIdx],
          a: xp[g].slice(), b: yp[g].slice(),
          scoreA: null, scoreB: null,
          meta: { teams: [X.name, Y.name], tie: t, game: g + 1 }
        });
      }
    });
    return { matches, byes };
  }

  function genClubVsClub(ev) {
    const pairs = ev.pairs || [];
    const home = pairs.filter(p => p.club === ev.homeClub);
    const away = pairs.filter(p => p.club === ev.visitorClub);
    const courtsUsed = Math.min(ev.courts.length, home.length, away.length);
    if (!courtsUsed) return { matches: [], byes: [] };
    const r = ev._roundIndex;
    const matches = [];
    const usedHome = new Set(), usedAway = new Set();
    for (let c = 0; c < courtsUsed; c++) {
      const hIdx = home.length <= courtsUsed ? c : (c + r) % home.length;
      const aIdx = (c + r) % away.length;
      usedHome.add(hIdx); usedAway.add(aIdx);
      matches.push({
        court: ev.courts[c],
        a: home[hIdx].players.slice(), b: away[aIdx].players.slice(),
        scoreA: null, scoreB: null,
        meta: { clubs: [ev.homeClub, ev.visitorClub], pairIdx: [hIdx, aIdx] }
      });
    }
    const byes = [];
    home.forEach((p, i) => { if (!usedHome.has(i)) byes.push(...p.players); });
    away.forEach((p, i) => { if (!usedAway.has(i)) byes.push(...p.players); });
    return { matches, byes };
  }

  /**
   * Generate the next round for an event. Pure: reads ev.rounds for history.
   * ev._roundIndex is set internally from rounds.length.
   */
  function generateRound(ev, seedStr) {
    const roundIndex = (ev.rounds || []).length;
    const view = Object.assign({}, ev, { _roundIndex: roundIndex });
    const names = (ev.players || []).map(p => p.name);
    const hist = historyFromRounds(ev.rounds || []);
    const rng = mulberry32(hashSeed((seedStr || ev.id || 'event') + ':' + roundIndex));
    switch (ev.format) {
      case 'round_robin': return genRoundRobin(names, view, hist, rng);
      case 'mix_up': return genMixUp(names, view, hist, rng);
      case 'mixed_doubles':
      case 'set_partners': return genFixedPairs(view, hist);
      case 'ladder': return genLadder(names, view, hist, rng);
      case 'king_of_court': return genKing(names, view, hist, rng);
      case 'team_battle': return genTeamBattle(view, hist);
      case 'club_vs_club': return genClubVsClub(view);
      default: throw new Error('Unknown format: ' + ev.format);
    }
  }

  /* Validate a round: every player at most once, 4 per match, courts valid. */
  function validateRound(round, ev) {
    const errors = [];
    const seen = {};
    (round.matches || []).forEach((m, i) => {
      if (!ev.courts.includes(m.court)) errors.push('match ' + i + ': bad court ' + m.court);
      const all = m.a.concat(m.b);
      if (all.length !== 4) errors.push('match ' + i + ': ' + all.length + ' players');
      all.forEach(n => { if (seen[n]) errors.push('player twice: ' + n); seen[n] = true; });
    });
    (round.byes || []).forEach(n => { if (seen[n]) errors.push('bye also playing: ' + n); seen[n] = true; });
    return errors;
  }

  const FORMATS = [
    { id: 'round_robin', label: 'Round Robin', blurb: 'Rotating partners — new partner every round, fewest repeats' },
    { id: 'mix_up', label: 'Mix-Up / Free-for-All', blurb: 'Random social shuffle each round, byes kept fair' },
    { id: 'mixed_doubles', label: 'Mixed Doubles', blurb: 'Organizer sets the pairs; pairs stay together and rotate opponents' },
    { id: 'set_partners', label: 'Set Partners RR', blurb: 'Same partner all event, rotate opponents' },
    { id: 'king_of_court', label: 'King of the Court', blurb: 'Up & down the river: winners move up a court, losers down, partners split' },
    { id: 'ladder', label: 'Ladder', blurb: 'Courts re-seeded by standings each round: best 4 on the top court' },
    { id: 'team_battle', label: 'Team Battle (4-player teams)', blurb: 'MLP-style: teams of 4 play two doubles games per tie' },
    { id: 'club_vs_club', label: 'Club vs Club', blurb: 'Two clubs, fixed 2-player teams. Home teams keep their court; visiting teams move one court each round' }
  ];

  return {
    hashSeed, mulberry32, shuffle, pairKey, samePair,
    historyFromRounds, computeStandings, computePairStandings,
    computeTeamStandings, clubTotals, circleSchedule,
    generateRound, validateRound, isScored, FORMATS
  };
});

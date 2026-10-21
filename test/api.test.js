'use strict';
process.env.PB_STORE = 'memory'; // must be set before the API module loads

const { test } = require('node:test');
const assert = require('node:assert');
const PB = require('../public/js/engines.js');
// The API is a Functions v2 (ESM) module now: load its default export.
const handlerPromise = import('../netlify/functions/api.js').then(m => m.default);

async function call(method, path, body) {
  const handler = await handlerPromise;
  const init = { method, headers: {} };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await handler(new Request('http://localhost' + path, init), {});
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* csv */ }
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  if (res.headers.get('content-type')) headers['Content-Type'] = res.headers.get('content-type');
  return { status: res.status, body: parsed, raw, headers };
}

test('API smoke: full event lifecycle, stats aggregation, CSV, duplicate, sub', async () => {
  // 1. Create group
  let r = await call('POST', '/api/groups', { clubs: ["Franco's", 'Rivals'] });
  assert.strictEqual(r.status, 201);
  const code = r.body.group.code;
  assert.ok(/^[A-Z0-9]{6}$/.test(code), 'group code format: ' + code);
  assert.deepStrictEqual(r.body.group.clubs, ["Franco's", 'Rivals']);

  // 2. Create event: round robin, 8 players, 2 courts, 2 rounds, trophy on
  const players = Array.from({ length: 8 }, (_, i) => ({ name: 'Player' + (i + 1), dupr: 3.5, club: "Franco's" }));
  r = await call('POST', '/api/groups/' + code + '/events', {
    name: 'Pickleball Tuesday', day: '2026-10-20', time: '18:30', place: "Franco's",
    format: 'round_robin', club: "Franco's", maxPlayers: 8, courts: ['A', 'B'],
    numRounds: 2, balanceDupr: false, trophy: true, players
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const ev = r.body.event;
  const hostToken = r.body.hostToken;
  assert.ok(hostToken && hostToken.length >= 16);
  assert.strictEqual(ev.status, 'open');

  // Group fetch must NOT leak the host token
  r = await call('GET', '/api/groups/' + code);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.group.events[0].hostToken, undefined);
  assert.strictEqual(r.body.group.players.length, 8, 'roster upserted from event');

  // 3. Join at cap -> 409; join existing name -> check-in OK
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/join`, { name: 'Late Larry' });
  assert.strictEqual(r.status, 409);
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/join`, { name: 'player1' }); // case-insensitive
  assert.strictEqual(r.status, 200);

  // 4. Host-only actions reject bad tokens
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/start`, { hostToken: 'nope' });
  assert.strictEqual(r.status, 403);

  // 5. Start -> round 1 generated with 2 matches covering all 8 players
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/start`, { hostToken });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.event.status, 'live');
  assert.strictEqual(r.body.event.rounds.length, 1);
  assert.strictEqual(r.body.event.rounds[0].matches.length, 2);
  assert.deepStrictEqual(PB.validateRound(r.body.event.rounds[0], r.body.event), []);

  // 6. Next round blocked until scores are in
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/next`, { hostToken });
  assert.strictEqual(r.status, 409);

  // 7. Score round 1: team A wins both matches 11-6
  for (let mi = 0; mi < 2; mi++) {
    r = await call('POST', `/api/groups/${code}/events/${ev.id}/score`,
      { hostToken, round: 0, match: mi, scoreA: 11, scoreB: 6 });
    assert.strictEqual(r.status, 200);
  }

  // 8. Next round, score it 11-9 for team B this time
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/next`, { hostToken });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.event.rounds.length, 2);
  const round2 = r.body.event.rounds[1];
  for (let mi = 0; mi < round2.matches.length; mi++) {
    r = await call('POST', `/api/groups/${code}/events/${ev.id}/score`,
      { hostToken, round: 1, match: mi, scoreA: 9, scoreB: 11 });
    assert.strictEqual(r.status, 200);
  }
  // No third round: numRounds = 2
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/next`, { hostToken });
  assert.strictEqual(r.status, 409);

  // 9. Finish -> status finished, trophy awarded to a round-1 winner
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/finish`, { hostToken });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.event.status, 'finished');

  r = await call('GET', '/api/groups/' + code);
  const fin = r.body.group.events.find(e => e.id === ev.id);
  const standings = PB.computeStandings(fin.rounds.flatMap(x => x.matches), fin.players.map(p => p.name));
  assert.strictEqual(standings.reduce((s, p) => s + p.GP, 0), 16, '8 players x 2 games each');
  assert.strictEqual(standings.reduce((s, p) => s + p.W, 0), 8, 'four matches x two winning partners');
  assert.strictEqual(r.body.group.trophies.length, 1, 'trophy match awards exactly one trophy');
  assert.strictEqual(r.body.group.trophies[0].winner, standings[0].name);

  // 10. CSV export
  r = await call('GET', `/api/groups/${code}/events/${ev.id}/export.csv`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['Content-Type'], /text\/csv/);
  const lines = r.raw.trim().split('\n');
  assert.strictEqual(lines.length, 5, 'header + 4 matches');
  assert.match(lines[0], /"Event","Round","Court","Team A","Team B","Score A","Score B"/);
  assert.match(lines[1], /"11","6"/);

  // 11. Duplicate -> fresh open event, new host token, roster copied, no rounds
  r = await call('POST', `/api/groups/${code}/events/${ev.id}/duplicate`, {});
  assert.strictEqual(r.status, 201);
  assert.notStrictEqual(r.body.hostToken, hostToken);
  assert.strictEqual(r.body.event.status, 'open');
  assert.strictEqual(r.body.event.rounds.length, 0);
  assert.strictEqual(r.body.event.players.length, 8);

  // 12. Sub on the duplicate: Player8 -> Sub Sam, pairs/players consistent
  const dupId = r.body.event.id, dupToken = r.body.hostToken;
  r = await call('POST', `/api/groups/${code}/events/${dupId}/sub`,
    { hostToken: dupToken, outName: 'Player8', newName: 'Sub Sam' });
  assert.strictEqual(r.status, 200);
  const namesAfter = r.body.event.players.map(p => p.name);
  assert.ok(namesAfter.includes('Sub Sam') && !namesAfter.includes('Player8'));

  // 13. Unknown group / event 404s
  r = await call('GET', '/api/groups/ZZZZZZ');
  assert.strictEqual(r.status, 404);
  r = await call('POST', `/api/groups/${code}/events/NOPE99/start`, { hostToken: 'x' });
  assert.strictEqual(r.status, 404);
});

test('API: validation rejects bad events', async () => {
  let r = await call('POST', '/api/groups', {});
  const code = r.body.group.code;
  const base = {
    name: 'Bad', format: 'round_robin', maxPlayers: 8, courts: ['A'], numRounds: 3,
    players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }]
  };
  r = await call('POST', '/api/groups/' + code + '/events', base);
  assert.strictEqual(r.status, 400, 'too few players');
  r = await call('POST', '/api/groups/' + code + '/events', Object.assign({}, base, {
    players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'a' }]
  }));
  assert.strictEqual(r.status, 400, 'case-insensitive duplicate names');
  r = await call('POST', '/api/groups/' + code + '/events', Object.assign({}, base, {
    format: 'mixed_doubles',
    players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
    pairs: [{ players: ['A', 'B'] }]
  }));
  assert.strictEqual(r.status, 400, 'pairs must cover all players');
});

/*
 * Franco's Pickleball — JSON API (Netlify Function).
 * One group document per group code, stored via lib/store.js.
 * Routes (after /api):
 *   POST   /groups                                   create group
 *   GET    /groups/:code                             full group state (host tokens stripped)
 *   POST   /groups/:code/clubs        {name}         add club
 *   POST   /groups/:code/players      {name,dupr,club}  upsert roster player
 *   POST   /groups/:code/events       {...}          create event -> {event, hostToken}
 *   POST   /groups/:code/events/:id/join      {name,dupr,club}
 *   POST   /groups/:code/events/:id/checkin   {name}
 *   POST   /groups/:code/events/:id/start     {hostToken}
 *   POST   /groups/:code/events/:id/score     {hostToken, round, match, scoreA, scoreB}
 *   POST   /groups/:code/events/:id/next      {hostToken}   generate next round
 *   POST   /groups/:code/events/:id/finish    {hostToken}
 *   POST   /groups/:code/events/:id/sub       {hostToken, outName, newName, dupr, club}
 *   POST   /groups/:code/events/:id/duplicate {}            -> {event, hostToken}
 *   GET    /groups/:code/events/:id/export.csv
 */
'use strict';

const crypto = require('crypto');
const store = require('./lib/store');
const PB = require('../../public/js/engines.js');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(len) {
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
const newToken = () => crypto.randomBytes(12).toString('hex');
const norm = n => String(n || '').trim().toLowerCase();

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj)
  };
}
const err = (code, msg) => json(code, { error: msg });

function publicGroup(g) {
  const copy = JSON.parse(JSON.stringify(g));
  copy.events.forEach(ev => { delete ev.hostToken; });
  return copy;
}
function findEvent(g, id) { return g.events.find(e => e.id === id); }
function requireHost(ev, body) {
  return body && body.hostToken && ev.hostToken && body.hostToken === ev.hostToken;
}
function upsertGroupPlayer(g, name, dupr, club) {
  const existing = g.players.find(p => norm(p.name) === norm(name));
  if (existing) {
    if (dupr !== undefined && dupr !== null) existing.dupr = dupr;
    if (club) existing.club = club;
    return existing;
  }
  const p = { name: String(name).trim(), dupr: (dupr === undefined ? null : dupr), club: club || null };
  g.players.push(p);
  return p;
}

function validateEventInput(body) {
  const formats = PB.FORMATS.map(f => f.id);
  if (!formats.includes(body.format)) return 'Unknown format';
  if (!Array.isArray(body.players) || body.players.length < 4) return 'Need at least 4 players';
  if (![4, 8, 12, 16].includes(body.maxPlayers)) return 'Max players must be 4, 8, 12 or 16';
  if (body.players.length > body.maxPlayers) return 'More players than the max';
  if (!Array.isArray(body.courts) || !body.courts.length) return 'Pick at least one court';
  if (!Number.isInteger(body.numRounds) || body.numRounds < 1 || body.numRounds > 30) return 'Rounds must be 1-30';
  const names = body.players.map(p => norm(p.name));
  if (new Set(names).size !== names.length) return 'Duplicate player names';
  if (['mixed_doubles', 'set_partners', 'club_vs_club'].includes(body.format)) {
    if (!Array.isArray(body.pairs) || !body.pairs.length) return 'This format needs pairs';
    const covered = [];
    body.pairs.forEach(pr => { (pr.players || []).forEach(n => covered.push(norm(n))); });
    if (covered.length !== names.length || new Set(covered).size !== names.length) {
      return 'Pairs must cover every player exactly once';
    }
  }
  if (body.format === 'club_vs_club' && (!body.homeClub || !body.visitorClub || body.homeClub === body.visitorClub)) {
    return 'Club vs Club needs two different clubs';
  }
  if (body.format === 'team_battle') {
    if (!Array.isArray(body.teams) || !body.teams.length) return 'Team Battle needs teams';
    const covered = [];
    for (const t of body.teams) {
      if (!Array.isArray(t.members) || t.members.length !== 4) return 'Each team needs exactly 4 players';
      t.members.forEach(n => covered.push(norm(n)));
    }
    if (covered.length !== names.length || new Set(covered).size !== names.length) {
      return 'Teams must cover every player exactly once';
    }
  }
  return null;
}

function trophyWinner(ev) {
  const all = (ev.rounds || []).flatMap(r => r.matches || []);
  if (!all.some(PB.isScored)) return null;
  const names = ev.players.map(p => p.name);
  if (ev.format === 'team_battle') {
    const t = PB.computeTeamStandings(all, ev.teams || [])[0];
    return t ? t.name : null;
  }
  if (['mixed_doubles', 'set_partners', 'club_vs_club'].includes(ev.format)) {
    const t = PB.computePairStandings(all, ev.pairs || [])[0];
    return t ? t.name : null;
  }
  const t = PB.computeStandings(all, names)[0];
  return t ? t.name : null;
}

exports.handler = async function (event) {
  try {
    const path = (event.path || '').replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '');
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
    const method = event.httpMethod;
    let body = {};
    if (event.body) { try { body = JSON.parse(event.body); } catch (e) { return err(400, 'Bad JSON'); } }

    /* ---- groups ---- */
    if (seg[0] === 'groups' && seg.length === 1 && method === 'POST') {
      let code = makeCode(6);
      while (await store.get('group:' + code)) code = makeCode(6);
      const g = {
        code, createdAt: new Date().toISOString(),
        clubs: Array.isArray(body.clubs) && body.clubs.length ? body.clubs : ["Franco's"],
        players: [], events: [], trophies: []
      };
      await store.set('group:' + code, g);
      return json(201, { group: publicGroup(g) });
    }

    if (seg[0] !== 'groups' || !seg[1]) return err(404, 'Not found');
    const code = seg[1].toUpperCase();
    const g = await store.get('group:' + code);
    if (!g) return err(404, 'Group not found');

    if (seg.length === 2 && method === 'GET') return json(200, { group: publicGroup(g) });

    if (seg.length === 3 && seg[2] === 'clubs' && method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name) return err(400, 'Club name required');
      if (!g.clubs.some(c => norm(c) === norm(name))) g.clubs.push(name);
      await store.set('group:' + code, g);
      return json(200, { group: publicGroup(g) });
    }

    if (seg.length === 3 && seg[2] === 'players' && method === 'POST') {
      if (!String(body.name || '').trim()) return err(400, 'Player name required');
      upsertGroupPlayer(g, body.name, body.dupr, body.club);
      await store.set('group:' + code, g);
      return json(200, { group: publicGroup(g) });
    }

    if (seg.length === 3 && seg[2] === 'events' && method === 'POST') {
      const problem = validateEventInput(body);
      if (problem) return err(400, problem);
      const club = body.club || g.clubs[0];
      if (!g.clubs.some(c => norm(c) === norm(club))) g.clubs.push(club);
      const ev = {
        id: makeCode(6),
        name: String(body.name || 'Pickleball').trim(),
        day: body.day || null,
        time: body.time || null,
        place: body.place || '',
        format: body.format,
        club,
        homeClub: body.homeClub || null,
        visitorClub: body.visitorClub || null,
        maxPlayers: body.maxPlayers,
        courts: body.courts,
        numRounds: body.numRounds,
        balanceDupr: !!body.balanceDupr,
        trophy: !!body.trophy,
        players: body.players.map(p => ({
          name: String(p.name).trim(),
          dupr: (p.dupr === undefined ? null : p.dupr),
          club: p.club || null,
          checkedIn: false
        })),
        pairs: body.pairs || null,
        teams: body.teams || null,
        status: 'open',
        rounds: [],
        createdAt: new Date().toISOString(),
        startedAt: null, finishedAt: null,
        hostToken: newToken()
      };
      ev.players.forEach(p => upsertGroupPlayer(g, p.name, p.dupr, p.club || club));
      g.events.push(ev);
      await store.set('group:' + code, g);
      const out = JSON.parse(JSON.stringify(ev));
      return json(201, { event: out, hostToken: ev.hostToken });
    }

    if (seg.length >= 4 && seg[2] === 'events') {
      const ev = findEvent(g, seg[3]);
      if (!ev) return err(404, 'Event not found');
      const action = seg[4];

      if (seg.length === 5 && action === 'export.csv' && method === 'GET') {
        const rows = [['Event', 'Round', 'Court', 'Team A', 'Team B', 'Score A', 'Score B']];
        ev.rounds.forEach((r, ri) => (r.matches || []).forEach(m => {
          rows.push([ev.name, ri + 1, m.court, m.a.join(' & '), m.b.join(' & '),
            m.scoreA === null || m.scoreA === undefined ? '' : m.scoreA,
            m.scoreB === null || m.scoreB === undefined ? '' : m.scoreB]);
        }));
        const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
        return { statusCode: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="scores.csv"' }, body: csv };
      }

      if (method !== 'POST' || seg.length !== 5) return err(404, 'Not found');

      if (action === 'join') {
        if (ev.status !== 'open') return err(409, 'The game already started — new players can\'t be added');
        const name = String(body.name || '').trim();
        if (!name) return err(400, 'Name required');
        const existing = ev.players.find(p => norm(p.name) === norm(name));
        if (existing) { existing.checkedIn = true; await store.set('group:' + code, g); return json(200, { event: strip(ev) }); }
        if (ev.players.length >= ev.maxPlayers) return err(409, 'Game is full');
        const p = { name, dupr: (body.dupr === undefined ? null : body.dupr), club: body.club || null, checkedIn: true };
        ev.players.push(p);
        upsertGroupPlayer(g, p.name, p.dupr, p.club || ev.club);
        await store.set('group:' + code, g);
        return json(200, { event: strip(ev) });
      }

      if (action === 'checkin') {
        const p = ev.players.find(p => norm(p.name) === norm(body.name));
        if (!p) return err(404, 'Player not in this game');
        p.checkedIn = true;
        await store.set('group:' + code, g);
        return json(200, { event: strip(ev) });
      }

      if (action === 'duplicate') {
        const copy = JSON.parse(JSON.stringify(ev));
        copy.id = makeCode(6);
        copy.status = 'open';
        copy.rounds = [];
        copy.startedAt = null; copy.finishedAt = null;
        copy.createdAt = new Date().toISOString();
        copy.players.forEach(p => { p.checkedIn = false; });
        copy.hostToken = newToken();
        g.events.push(copy);
        await store.set('group:' + code, g);
        return json(201, { event: copy, hostToken: copy.hostToken });
      }

      /* host-only actions below */
      if (!requireHost(ev, body)) return err(403, 'Host only');

      if (action === 'start') {
        if (ev.status !== 'open') return err(409, 'Already started');
        if (ev.players.length < 4) return err(400, 'Need at least 4 players');
        const round = PB.generateRound(ev, ev.id);
        const problems = PB.validateRound(round, ev);
        if (problems.length) return err(500, 'Round generation failed: ' + problems[0]);
        ev.rounds.push(round);
        ev.status = 'live';
        ev.startedAt = new Date().toISOString();
        await store.set('group:' + code, g);
        return json(200, { event: strip(ev) });
      }

      if (action === 'score') {
        if (ev.status !== 'live') return err(409, 'Game is not live');
        const r = ev.rounds[body.round];
        if (!r || !r.matches[body.match]) return err(404, 'Match not found');
        const sA = Number(body.scoreA), sB = Number(body.scoreB);
        if (!Number.isFinite(sA) || !Number.isFinite(sB) || sA < 0 || sB < 0) return err(400, 'Bad score');
        r.matches[body.match].scoreA = sA;
        r.matches[body.match].scoreB = sB;
        await store.set('group:' + code, g);
        return json(200, { event: strip(ev) });
      }

      if (action === 'next') {
        if (ev.status !== 'live') return err(409, 'Game is not live');
        const cur = ev.rounds[ev.rounds.length - 1];
        if (!cur || !cur.matches.every(PB.isScored)) return err(409, 'Finish scoring this round first');
        if (ev.rounds.length >= ev.numRounds) return err(409, 'That was the final round — finish the event');
        const round = PB.generateRound(ev, ev.id);
        const problems = PB.validateRound(round, ev);
        if (problems.length) return err(500, 'Round generation failed: ' + problems[0]);
        ev.rounds.push(round);
        await store.set('group:' + code, g);
        return json(200, { event: strip(ev) });
      }

      if (action === 'finish') {
        if (ev.status !== 'live') return err(409, 'Game is not live');
        ev.status = 'finished';
        ev.finishedAt = new Date().toISOString();
        if (ev.trophy) {
          const winner = trophyWinner(ev);
          if (winner) g.trophies.push({ eventId: ev.id, eventName: ev.name, day: ev.day, winner });
        }
        await store.set('group:' + code, g);
        return json(200, { event: strip(ev) });
      }

      if (action === 'sub') {
        const outName = String(body.outName || '').trim();
        const newName = String(body.newName || '').trim();
        if (!outName || !newName) return err(400, 'outName and newName required');
        const p = ev.players.find(p => norm(p.name) === norm(outName));
        if (!p) return err(404, 'Player not found');
        if (ev.players.some(p => norm(p.name) === norm(newName))) return err(409, 'That player is already in the game');
        p.name = newName;
        if (body.dupr !== undefined) p.dupr = body.dupr;
        if (body.club) p.club = body.club;
        const swap = n => (norm(n) === norm(outName) ? newName : n);
        if (ev.pairs) ev.pairs.forEach(pr => { pr.players = pr.players.map(swap); });
        if (ev.teams) ev.teams.forEach(t => { t.members = t.members.map(swap); });
        ev.rounds.forEach(r => (r.matches || []).forEach(m => {
          if (!PB.isScored(m)) { m.a = m.a.map(swap); m.b = m.b.map(swap); }
        }));
        upsertGroupPlayer(g, newName, body.dupr, body.club || ev.club);
        await store.set('group:' + code, g);
        return json(200, { event: strip(ev) });
      }

      return err(404, 'Unknown action');
    }

    return err(404, 'Not found');
  } catch (e) {
    return err(500, 'Server error: ' + (e && e.message ? e.message : String(e)));
  }
};

function strip(ev) {
  const copy = JSON.parse(JSON.stringify(ev));
  delete copy.hostToken;
  return copy;
}

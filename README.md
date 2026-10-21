# Franco's Pickleball

A no-login, link-based pickleball session organizer for **Franco's Health Club & Spa** (Mandeville, LA), functionally equivalent to the Stone Creek Pickleball web app: a host creates a game, shares a group link (`?g=CODE`), players open it on their phones, tap their name to check in, and the app generates court assignments each round, collects scores, and computes standings, club stats, and trophies automatically.

## Features

- **Home** — Create a game / Join a game (upcoming list) / Overall stats / Past matches
- **Create-game wizard (3 steps)** — event name, day, time, place; format; club (stats go to that club, clubs can be added); roster selection with optional DUPR; max players 4/8/12/16 (join closes at the cap, a dropout reopens the spot); courts A–H; number of rounds; *Balance matchups by DUPR* and *Trophy match* toggles
- **8 formats** — Round Robin (rotating partners, fewest repeats), Mix-Up / Free-for-All (random shuffle, fair byes), Mixed Doubles (organizer-set pairs), Set Partners RR, King of the Court (winners move up, losers down, partners split), Ladder (courts re-seeded by standings), Team Battle (4-player teams, two doubles games per tie), Club vs Club (fixed 2-player teams; home teams keep their court, visitors rotate one court per round)
- **Event view, 5 tabs** — Courts (round picker, per-court match cards, prev/next), Me (tap-your-name check-in, your current match, locked after start), Rounds, Standings (win % → point differential → games played; per-team tables for pair/team formats; club totals for Club vs Club; top-player banner), Manage (share link, roster with host sub-in, settings, Export scores CSV, Duplicate as new event, Remove from my list)
- **Host authority without accounts** — the creating device receives a host token (kept in that device's local storage). Only the host can start/end rounds, enter or edit scores, sub players, and finish the event. Players are identified by name (case-insensitive), DUPR optional.
- **Live feel** — the client polls the API every ~5 seconds and on pull-to-refresh / tap-refresh, with an "Updated HH:MM" indicator.
- **Overall stats** — per-club player leaderboard across finished events, plus a Trophies tab for trophy-match winners.

## Architecture

| Piece | Tech |
|---|---|
| Frontend | Static single-page app in `public/` (vanilla JS, no CDN dependencies), mobile-first narrow column with a bottom tab bar |
| Pairing engines & standings | `public/js/engines.js` — one UMD library shared by the browser, the API function, and the tests |
| API | `netlify/functions/api.js` — a small JSON API (groups, clubs, players, events, join/check-in, host actions, CSV export) |
| Storage | `netlify/functions/lib/store.js` — adapter interface: **Netlify Blobs** in production; in-memory or JSON-file adapter locally (`PB_STORE=memory\|file`, `PB_DATA_DIR`) |

One group document per group code holds that group's clubs, roster, events, and trophies. Group codes are 6 characters and double as the share link.

## Deploy to Netlify

**Option A — drag and drop (fastest)**

1. Zip the project folder (or use the Netlify CLI below — drag-and-drop deploys of sites with functions must be a zip of the *project root*, including `netlify.toml`, `netlify/functions/`, and `public/`).
2. In Netlify: *Add new site → Deploy manually*, drop the zip.
3. Netlify reads `netlify.toml`: publishes `public/`, installs `@netlify/blobs` from `package.json`, and bundles the function with `public/js/engines.js` included.

**Option B — Netlify CLI**

```bash
npm install -g netlify-cli
cd francos-pickleball-app
netlify deploy --build --prod
```

**Option C — Git**: push this folder to a repo and connect it in Netlify; the same `netlify.toml` drives the build.

No environment variables are required in production — Netlify Blobs is provisioned automatically for the site. The first visit creates a group when the first game is created; share the `?g=CODE` link with players.

## Local development & tests

```bash
npm test        # node --test test/  (engines, standings, full API smoke test)
```

The tests run the real API handler against the in-memory storage adapter: create a group → create an event → join → start → score → next round → finish → verify standings aggregation, trophy award, and CSV export.

For a local server with hot reload, `netlify dev` also works (uses the same Blobs-backed API, emulated locally).

## Notes & simplifications

- Rounds are generated one at a time by the server (Ladder, King of the Court, and Club vs Club depend on prior results).
- Mixed Doubles / Set Partners pairs and Team Battle teams are formed **in the order players are tapped** in step 2 of the wizard (1st with 2nd, first 4 = Team 1, …) — the wizard previews pairs/teams before creating.
- King of the Court with more players than court spots: last round's sit-outs rotate in at the bottom court.
- Team Battle pairs within a team are fixed (members 1–2 and 3–4).
- Scores are entered by the host only; a tied score counts games/points but no win/loss.
- Data is per group code — anyone with a group's link can view that group and join its open games (same trust model as the original app).

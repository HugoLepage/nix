# Nix

A modern take on Qix and Xonix. Draw lines across the field, seal off areas and claim 75% of the board while the
enemies hunt you and your unfinished trail.

**Play:** https://hugolepage.github.io/nix/

## How to play

- **Move:** WASD or the arrow keys on a computer; swipe on a phone (the game goes fullscreen on mobile).
- Leave the rail to draw a trail; reach the rail again to seal it and capture the smaller side.
- Fill the bottom bar (75% of the board) to clear the level. Three lives per attempt; extra-life pick-ups can
  raise that to five.
- Touching an enemy, or letting a qix, chipper or spawner touch your unfinished trail, costs a life (the seeker
  only goes for your ship). Trap a flying enemy inside captured land to destroy it.

### Enemies

| Enemy | First seen | What it does |
|---|---|---|
| Sparx | level 2 | Crawls the rail, including captured areas. Holds still after you lose a life until you move again. |
| Qix | level 3 | A plasma orb that flies in straight lines, a touch faster than you, bouncing off the walls. |
| Chipper | level 8 | A spiky qix that cracks the captured land it hits. Six hits on one area and that area is open field again. |
| Seeker | level 12 | A bullet that dozes while you are on the rail, then speeds up and homes in on you once you leave it. |
| Spawner | level 18 | A large holed sphere that launches a new qix from one of its ports every ten seconds. |

### Power-ups

Pick-ups float in the open field for half a minute or so; touch one, or capture the area it sits in, to collect it.
A death ends every running power.

| Power-up | First seen | Effect |
|---|---|---|
| Boost | level 6 | Moves you faster for a few seconds. |
| Shield | level 10 | Stays up until it absorbs one hit to you or your unfinished line. |
| Slow-mo | level 14 | Slows every enemy down for a few seconds. |
| Extra life | level 16 | One more life, up to five. |
| Time stop | level 20 | Freezes every enemy for a few seconds (they stay deadly to touch). |
| Instant cut | level 22 | Finishes your line straight ahead the next time you draw, closing the area at once. |

### Levels

Thirty levels, each bringing in at most one new thing, which its intro card presents:

| Levels | What happens |
|---|---|
| 1–3 | An empty board, then a sparx, then the first qix. |
| 4–7 | Two and three qix; Boost arrives at 6, a second sparx at 7. |
| 8–11 | The Chipper (8) and the Shield (10). |
| 12–17 | The Seeker (12), Slow-mo (14) and Extra life (16), mixed with what came before. |
| 18–22 | The Spawner (18), Time stop (20) and Instant cut (22). |
| 23–30 | Mixes of everything, up to three sparx on the rail and every power-up in play by level 30. |

Levels are addressed by URL (`?level=12`); later levels unlock as earlier ones are cleared.
`?view=chapters` and `?view=howto` open those screens directly.

## Accounts

Sign in with a username and password. An unknown name creates the account, a known one checks the password.
Progress is saved to a Firebase Realtime Database over its REST API, with no server and no SDK. Before going live,
publish the security rules in `database.rules.json`; see [FIREBASE.md](FIREBASE.md).

**Updating from the three-level version: publish the new `database.rules.json` again.** The old rules refuse any
save beyond level 3, so until the new ones are live, progress past level 3 stays on the player's device and is
retried rather than saved to the database.

## Development

Requires Node 22.12 or newer.

```bash
npm install
npm run dev
```

The dev server runs at http://localhost:4321/nix/. `npm run build` writes the static site to `dist/`.

## Deployment

Every push to `main` builds and deploys through GitHub Actions (`.github/workflows/deploy.yml`). In the repository
settings, under **Pages → Build and deployment → Source**, choose **GitHub Actions**.

## Layout

```
src/pages/index.astro       the single page: static screens + one client script
src/components/             static markup for each screen (login, menu, chapters, how to play, game) + icon symbols
src/styles/                 global.css, ui.css, howto.css, game.css
src/scripts/main.js         composition root: session, routing, screens
src/scripts/ui/             router, screens, menu, chapters, HUD, overlays, play session, catalog (enemy and
                            power-up names, hints and icons)
src/scripts/game/           simulation (grid, player, sparx, qix and the other foes, power-ups, levels, game) and
                            canvas rendering (renderer, fx-*, particles)
src/scripts/auth.js         sign-in / sign-up (PBKDF2), session
src/scripts/store.js        progress: local cache first, synced to Firebase
```

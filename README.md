# Nix

A modern take on Qix and Xonix. Draw lines across the field, seal off areas and claim 75% of the board while the
enemies hunt you and your unfinished trail.

**Play:** https://hugolepage.github.io/nix/

## How to play

- **Move:** WASD or the arrow keys on a computer; swipe on a phone (the game goes fullscreen on mobile).
- Leave the rail to draw a trail; reach the rail again to seal it and capture the smaller side.
- Fill the bottom bar (75% of the board) to clear the level. Three lives per attempt.
- **Level 1:** an empty board. **Level 2:** a sparx crawls the rail, including captured areas.
  **Level 3:** a sparx plus a qix that roams the open field. Touching an enemy, or letting the qix touch your
  unfinished trail, costs a life. Trap the qix inside captured land to destroy it.

Levels are addressed by URL (`?level=2`); later levels unlock as earlier ones are cleared.
`?view=chapters` and `?view=howto` open those screens directly.

## Accounts

Sign in with a username and password. An unknown name creates the account, a known one checks the password.
Progress is saved to a Firebase Realtime Database over its REST API, with no server and no SDK. Before going live,
publish the security rules in `database.rules.json`; see [FIREBASE.md](FIREBASE.md).

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
src/components/             static markup for each screen (login, menu, chapters, how to play, game)
src/styles/                 global.css, ui.css, howto.css, game.css
src/scripts/main.js         composition root: session, routing, screens
src/scripts/ui/             router, screens, menu, chapters, HUD, overlays, play session
src/scripts/game/           simulation (grid, player, sparx, qix, game) and canvas rendering (renderer, fx-*, particles)
src/scripts/auth.js         sign-in / sign-up (PBKDF2), session
src/scripts/store.js        progress: local cache first, synced to Firebase
```

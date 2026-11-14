# GoalForgeX FlightLink

The GoalForgeX flight sim integration app. FlightLink reads **Microsoft Flight Simulator 2024** (2020 works too) over SimConnect and sends live telemetry and flight events to the streamer's GoalForgeX account. Their **Scene Studio** scenes then use it (`GFX.flight`, `{{flight-…}}` tags, `flight-*` events).

- Streamer page: `https://goalforgex.com/flightlink` (download, connect, live status)
- Scene author docs: `https://goalforgex.com/scene-studio?tab=flight` (also `/scene-studio-flight-docs.md`)

## How it works

```
MSFS ──SimConnect (local pipe / TCP)──► src/sim.js ──► src/tracker.js ──► src/cloud.js ──HTTPS──► goalforgex.com
                                         (or src/demo.js)  derived values     POST /api/flightsim/telemetry
                                                           + events           (flightsim.js, memory only)
                                                                                     │
                                                         Scene Studio scenes ◄── WebSocket (only scenes that use flight data)
```

- **sim.js**: [node-simconnect](https://github.com/EvenAR/node-simconnect) is a pure-JavaScript SimConnect client, so no Microsoft SDK DLL is needed. Variables are read in small groups. A variable the sim rejects gets dropped from its group, and the other groups keep working.
- **tracker.js**: rounds and derives values (phase, flight time, distance, fuel %, landing rate and rating) and detects events (takeoff, landing, gear, flaps, stall, waypoint…).
- **cloud.js**: handles linking (a device code approved at `/flightlink?code=…`) and the upload. The upload runs at 1–10 posts a second while flying, with a heartbeat every 3 s otherwise. Only one request is in flight at a time, and it backs off when the site is slow.
- **demo.js**: a pretend 4-minute flight. Use it to test without the sim (*Demo flight* switch, or `npm run demo`).
- The token is stored encrypted with Windows DPAPI (`safeStorage`) in `%APPDATA%\GoalForgeX FlightLink\settings.json`.

## Develop

```
npm install
npm start                                   # real sim
npm run demo                                # demo flight
npx electron . --server=http://localhost:3000   # against a local GoalForgeX
npm run check                               # syntax + demo-flight sanity check
npm run dist                                # dist/goalforgex-flightlink-X.Y.Z-windows-x64-installer.exe
```

If you run it from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first. VS Code sets it, and it makes Electron start as plain Node.

## Release

Bump `version` in `package.json`, commit, tag `vX.Y.Z` and push the tag. `.github/workflows/release.yml` builds the installer and publishes the GitHub release. The site's download button picks up the newest release within 10 minutes.

The site looks up releases in the repository `Mark0212/GFXFlightSimApp`, or in `FLIGHTLINK_REPO` if that's set. If it finds no release, it falls back to `FLIGHTLINK_DOWNLOAD_URL`, and then to any installer file placed in the site's `downloads/flightlink/` folder.

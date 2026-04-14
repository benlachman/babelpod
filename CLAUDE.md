# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

BabelPod is an audio streaming system with two repositories:

- **This repo** (`benlachman/babelpod`) — Node.js server + web UI. The server (`index.js`) captures audio from a selected input and streams it to multiple outputs. The web UI (`index.html`) is served by Express. Both are plain JavaScript, no build step.
- **iOS/macOS app** (`nicemohawk/airspin`) at `/Users/ben/Development/BabelUI` — SwiftUI client that connects to the same server. Separate repo, separate release cycle, but must maintain API parity.

The server runs on a **Raspberry Pi Zero 2 W** (ARM64, 512MB RAM, Debian/Trixie). Audio capture and playback use ALSA tools (`arecord`, `aplay`) via spawned child processes. AirPlay streaming uses `node_airtunes2`. Bluetooth input uses `bluetoothctl` via a Node wrapper. Device discovery uses `dnssd2` (mDNS) and `mdns-js`.

## Commands

- **Run server:** `node index.js`
- **Run tests:** `npm test` (Jest)
- **Run single test:** `npx jest --testPathPattern='unit' -t 'test name pattern'`
- **Watch tests:** `npm run test:watch`
- **Syntax check:** `node -c index.js`
- **Environment variables:** `BABEL_PORT=3000` (default), `DISABLE_PCM=1` (skip ALSA scanning)

## Deployment

Target is a Raspberry Pi (currently Pi Zero 2 W at `pi@PattyPi.local`, passwordless sudo). Deploy via git:

```bash
ssh pi@PattyPi.local 'cd /home/pi/babelpod && git pull origin master && sudo systemctl restart babelpod'
```

Do not use `scp` to deploy files — always commit and pull through git so the Pi stays in sync.

Check logs: `ssh pi@PattyPi.local 'journalctl -u babelpod -f'`

## Architecture

The entire server is a single file (`index.js`, ~900 lines). The web UI is a single file (`index.html`).

### Audio Pipeline

```
Input (arecord/bluetooth/void)
  → inputStream
    → duplicator (PassThrough)
      → airtunes (AirPlay devices)
      → aplay processes (local ALSA outputs)
      → fallbackSink (discard)
```

All audio is 2-channel, signed 16-bit LE, 44.1kHz. The duplicator is the central fan-out point — one input pipes in, multiple outputs pipe out.

### Socket.IO API (v1)

Documented in `API.md`. Key design points:

- **All payloads are wrapped objects** — no bare strings or numbers
- **Single `state` event on connection** replaces multiple initial emits
- **Session ownership** — one client controls at a time, others observe. Controlled by `takeover` event
- **Echo detection** — server broadcasts to ALL clients including sender. Clients must track `lastEmitted` values to avoid feedback loops
- **Event naming:** server-to-client uses nouns (`input`, `output`, `volume`, `session`), client-to-server uses `set`-prefixed verbs (`setInput`, `setOutput`, `setVolume`)
- **`serverError` not `error`** — `error` is a reserved Socket.IO event name

### Device Discovery

- **AirPlay:** mDNS via `dnssd2`, browsing `_airplay._tcp`. Stereo pairs detected via `gpn` TXT record
- **PCM:** Reads `/proc/asound/pcm` every 10 seconds
- **Bluetooth:** Optional `bluetoothctl` module, discovers paired devices
- **Self-advertisement:** Advertises as `_babelpod._tcp` for client discovery

### Process Management

`arecord` processes can fail with "Device or resource busy" — the server handles this with:
- SIGTERM with SIGKILL fallback for cleanup
- Orphaned process cleanup via `pkill` before starting new instances
- Exponential backoff retry (up to 5 attempts) on busy errors
- Auto-restart on unexpected exit (up to 3 attempts)

## Companion iOS/macOS App

The SwiftUI client lives at `/Users/ben/Development/BabelUI` (separate repo: `nicemohawk/airspin`). It consumes the same v1 API. Key files:
- `BabelPodClientView.swift` — ViewModel with Socket.IO client, Combine publishers for state sync
- `ContentView.swift` — NavigationStack with connection Menu
- `ServiceDiscoveryManager.swift` — Bonjour discovery via NWBrowser

## Workflow

- **Always use branches and PRs.** Do not commit directly to master/main. Squash merge and delete the branch after merging.
- **Prefer new commits over amending.** Amending pushed commits should be extremely rare. Only amend unpushed commits when the change is a correction to that commit, not new work. When in doubt, create a new commit.
- **Lint and build after every change.** Run `node -c index.js` after any server edit. Build the iOS app after any Swift edit.
- **Ask before making breaking API changes.** The API has multiple clients (web UI, iOS app). Discuss versioning strategy before changing event names, payload shapes, or removing events.
- **iOS and web UI must have feature parity.** Any feature added to one client must be added to the other.
- **Always include PR URLs.** When referencing pull requests, include the full URL so they're clickable.

## Code Style

- **Readable names everywhere.** No abbreviations or non-well-known acronyms in variables, functions, methods, parameters, or files. Use `selectedOutputs` not `selOuts`, `deviceIdentifier` not `devId`. Well-known acronyms like `id`, `url`, `tcp` are fine.
- **Modern, idiomatic code.** JavaScript should use modern Node.js patterns (destructuring, async/await where appropriate, const/let). Swift should follow Apple conventions — use the sosumi MCP server (`searchAppleDocumentation`, `fetchAppleDocumentation`) to verify API usage and follow platform idioms.
- **Don't guess at fixes.** If the same approach hasn't worked after two attempts, do a web search before trying a third variation.

## Testing

- **Tests are required.** Write tests for new functionality wherever possible.
- **100% API test coverage is required.** Every Socket.IO event (both directions) must have corresponding test cases.
- Run `npm test` to verify before committing.

## Known Issues

See `BACKLOG.md` for tracked issues including an unresolved iOS first-interaction gesture delay.

# Improvement Plan

A prioritized plan for improving the BabelPod server repo, based on a full review (July 2026). Feature-level work items live in [BACKLOG.md](BACKLOG.md); this document covers codebase health, structure, and sequencing.

## Current state

- 126 tests passing across 4 suites; hardware-free logic extracted into `lib/` (`devices.js`, `turntable.js`, `plugController.js`)
- Documentation current: [API.md](API.md), [BACKLOG.md](BACKLOG.md), `CLAUDE.md`
- No build step; runs comfortably on a Raspberry Pi Zero 2 W (matter.js lazy-loaded)

## Findings, in priority order

### 1. Security: production-dependency vulnerabilities (1 critical)

`npm audit --omit=dev` reports 15 vulnerabilities, nearly all pulled in by our `airtunes2` fork's dependency tree:

- **`castv2-client` → `protobufjs` (critical)** — Chromecast support BabelPod never uses
- **`pkg` (moderate)** — binary packager, only needed to build standalone airtunes2 binaries
- **`yargs@9`** — pulls vulnerable `cross-spawn`/`mem`, only used by airtunes2's CLI

Since we own `benlachman/node_airtunes2#babelpod-sender-name`:

- Move `pkg` to devDependencies (or drop), make `castv2-client` optional or remove it, bump/drop `yargs`
- Tag the fork (e.g. `v2.4.9-babelpod.1`) instead of referencing a moving branch, for reproducible Pi deploys
- The remaining `ws` 8.20.1 advisory comes via socket.io's `engine.io` — a plain `npm update` likely clears it

### 2. Structure: `index.js` is ~1450 lines / 40 top-level functions

It mixes six concerns: config load/save, the autoconnect state machine, plug orchestration, the arecord input lifecycle, mDNS discovery/advertisement, and the Socket.IO API. Extract along seams that already exist, one behavior-preserving PR each, tests first:

- `lib/config.js` — `loadConfig`/`saveConfig`/`publicConfig`; pure enough to unit test the pairing-code redaction guarantee directly
- `lib/autoconnect.js` — the tick/state machine around `tickAutoconnect`, currently only testable through the API harness
- `lib/inputPipeline.js` — arecord spawn/retry/backoff/cleanup; the most failure-prone code in the repo, currently untestable

### 3. Consolidate dual mDNS libraries

Both `dnssd2` and `mdns-js` are dependencies. Two mDNS stacks on a 512MB Pi is memory and socket overhead. Audit what `mdns-js` still does and fold everything into one library.

### 4. Test hygiene and CI

- Jest needs `forceExit: true` and warns about leaked handles — find the open handle (likely a socket/timer in `tests/api.test.js`'s child-process harness), add proper teardown, remove `forceExit`
- Add a GitHub Actions CI workflow: `node -c index.js` + `npm test` on push/PR (with `DISABLE_PCM=1`). Nothing currently enforces the "tests required" rule mechanically
- Add ESLint (flat config, minimal ruleset) — the repo has no linter

### 5. Dead code / stale markers

- `index.js` has a `TODO: Bluetooth input discovery not yet implemented` on `availableBluetoothInputs`, while `CLAUDE.md` and the README describe bluetoothctl discovery as working; reconcile (implement or remove the vestige)
- The `bluetoothctl` dependency is a raw git URL to an 8-year-old repo — vendor the small portion used, or drop it if the feature is dead

### 6. Feature backlog

Already tracked in [BACKLOG.md](BACKLOG.md); sequenced by value:

1. From-scratch Matter plug commissioning test on real hardware — blocking confidence in the in-app setup path
2. HTTP command endpoint (AirSpin spec §4) — unlocks Siri Shortcuts, small server surface
3. Software input gain (sox/softvol in the capture pipeline) — fixes a real usability problem with line-level sources
4. HAP-NodeJS volume accessory (spec §5) — nice-to-have, heaviest memory cost on the Pi; do last
5. iOS parity items (plug setup form, per-speaker defaults) — live in the airspin repo

## Suggested order of work

| Phase | Items | Why first |
|---|---|---|
| 1 | Fork dependency prune + tag, `npm update` for ws, CI workflow | Security + safety net, no behavior change |
| 2 | Jest teardown fix, ESLint | Cheap, makes everything after safer |
| 3 | `index.js` extraction (config → autoconnect → inputPipeline) | Biggest maintainability win |
| 4 | mDNS consolidation, Bluetooth reconcile | Memory/cruft cleanup |
| 5 | Backlog features (HTTP endpoint, input gain, HAP accessory) | New value on a cleaner base |

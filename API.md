# BabelPod Socket.IO API (v1)

BabelPod uses [Socket.IO](https://socket.io/) for real-time communication between clients and the server. All payloads are JSON objects. The API version is included in the `state` event on connection.

Additions marked **v1.1** are additive and backward compatible — v1 clients keep working unchanged. New capabilities are signaled by the *presence* of their field in `state` (capability by presence); servers without a feature omit the field entirely and clients hide the corresponding controls.

## Connection

Connect to the server's Socket.IO endpoint (default `http://<host>:3000`). On connection, the server emits a single `state` event containing the full current state. Subsequent changes are sent as individual events.

## Server to Client Events

### `state`

Sent once immediately after connection. Contains the full server state.

```json
{
  "version": 1,
  "sessionOwner": "socket-id" | null,
  "inputs": [{ "id": "plughw:0,0", "name": "USB Audio" }, ...],
  "outputs": [{ "id": "air:Kitchen", "name": "Kitchen (AirPlay)" }, ...],
  "selectedInput": "plughw:0,0",
  "selectedOutputs": ["air:Kitchen", "air:Bedroom"],
  "volume": 50,
  "turntablePower": { "on": true, "reachable": true }
}
```

`turntablePower` (v1.1) is present only when the server has a turntable smart plug configured — see [Turntable Power & Silence Auto-Off](#turntable-power--silence-auto-off-v11).

### `inputs`

Sent when the available input device list changes.

```json
{ "inputs": [{ "id": "void", "name": "None" }, { "id": "plughw:0,0", "name": "USB Audio" }] }
```

### `outputs`

Sent when the available output device list changes (AirPlay devices discovered/lost, etc.).

```json
{ "outputs": [{ "id": "air:Kitchen", "name": "Kitchen (AirPlay)" }] }
```

### `input`

Sent when the active input device changes.

```json
{ "id": "plughw:0,0" }
```

### `output`

Sent when the active output selection changes.

```json
{ "ids": ["air:Kitchen", "air:Bedroom"] }
```

### `volume`

Sent when the volume changes.

```json
{ "value": 75 }
```

### `turntablePower` (v1.1)

Sent on **every** turntable plug state or reachability change — including changes made from Apple Home, the plug's physical button, or the server's silence auto-off — not just in response to `setTurntablePower`. The payload always reflects the real hardware state (the server subscribes to the plug's Matter OnOff attribute and never synthesizes this from a command).

```json
{ "on": true, "reachable": true }
```

`reachable: false` means the server currently cannot confirm or command the plug (Matter node offline); `on` is then the last known state and may be stale. Clients should disable their power toggle while unreachable.

Only sent by servers with a configured turntable plug. The `state` event includes the same object as `turntablePower` — its presence is the capability signal for showing the power control.

### `session`

Sent when session ownership changes. The owner is the only client allowed to make changes. `null` means no owner.

```json
{ "owner": "socket-id" }
```

### `status`

Informational message from the server.

```json
{ "message": "Input switched to plughw:0,0" }
```

### `serverError`

Error message from the server.

```json
{ "message": "Failed to connect to Bluetooth: Connection timeout" }
```

## Client to Server Events

All commands require session ownership. If a non-owner sends a command, it is silently ignored. Use `takeover` to claim ownership.

### `setInput`

Select an input device.

```json
{ "id": "plughw:0,0" }
```

Special values:
- `"void"` - No input (silence)
- `"bluealsa:SRV=org.bluealsa,DEV=AA:BB:CC:DD:EE:FF,PROFILE=a2dp"` - Bluetooth device

### `setOutput`

Set the active outputs. Always send the full list of desired outputs (not a toggle).

```json
{ "ids": ["air:Kitchen", "air:Bedroom"] }
```

Output ID prefixes:
- `plughw:` - Local ALSA PCM device
- `air:` - Single AirPlay device
- `airpair:` - Stereo-paired AirPlay devices

### `setVolume`

Set the volume (0-100). Applies to AirPlay outputs.

```json
{ "value": 75 }
```

### `setTurntablePower` (v1.1)

Request a turntable plug power change. Requires session ownership. The server does **not** echo this back directly — it commands the plug and lets the Matter OnOff subscription drive the `turntablePower` broadcast, so the confirmation always reflects actual hardware state (and self-corrects if the command failed). Clients should show a pending state rather than flipping their toggle optimistically, and give up after ~8 seconds without a `turntablePower` broadcast.

```json
{ "on": false }
```

If the plug is unreachable, the server broadcasts `serverError` plus `turntablePower` with the last known state and `reachable: false`.

### `takeover`

Claim session ownership. No payload required.

```json
{}
```

### `setConfig`

Update instance configuration. Partial updates allowed — only fields present are changed. Requires session ownership.

```json
{
  "displayName": "Living Room Pi",
  "defaultInputId": "plughw:0,0",
  "defaultOutputIds": ["air:Kitchen", "air:Living Room"],
  "defaultVolume": 50,
  "autoconnectEnabled": true,
  "autoconnectThreshold": 0.01,
  "autoOffEnabled": true,
  "autoOffSilenceThresholdDb": -43,
  "autoOffNoiseFloorDb": -62,
  "autoOffSilenceMinutes": 20
}
```

The `autoOff*` fields (v1.1) configure silence auto-off for the turntable plug. To calibrate: watch `rmsLevel` (20·log10(level) = dBFS) with the turntable off to find the line's noise floor, and again with a record spinning in the runout groove to find the surface-noise level. Set `autoOffNoiseFloorDb` a few dB above the former and `autoOffSilenceThresholdDb` ~5 dB above the latter — runout noise must land *between* the two or auto-off will never fire (music is far louder, typically −30 dBFS and up, so the threshold has plenty of headroom). The plug itself (`turntablePlugEnabled`, `turntablePlugPairingCode`) can only be configured in `babelpod.config.json` on the server, since commissioning is a one-time operator step that requires a server restart.

### `setAutoconnect`

Toggle the autoconnect state machine. `"listening"` arms autoconnect (enters idle/listening). `"paused"` is a master kill switch — stops all outputs immediately. Requires session ownership.

```json
{ "state": "listening" }
```

## Instance Configuration

BabelPod stores instance configuration in `babelpod.config.json` alongside the server. Configuration persists across restarts and is editable from any client via the `setConfig` event.

### Server to Client

**`config`** — Sent when configuration changes. Also included in the `state` event on connection.

```json
{
  "displayName": "PattyPi",
  "defaultInputId": "plughw:0,0",
  "defaultOutputIds": ["air:Kitchen"],
  "defaultVolume": 50,
  "autoconnectEnabled": true,
  "autoconnectThreshold": 0.01
}
```

## Autoconnect

BabelPod can automatically detect audio on the input and route it to configured default speakers. Uses RMS level monitoring with an exponential moving average to distinguish sustained music from transient surface noise.

### Server to Client

**`autoconnect`** — Sent when the autoconnect state changes.

```json
{ "state": "idle" }
```

Valid states: `"paused"`, `"idle"`, `"detecting"`, `"connected"`, `"silence"`

**`rmsLevel`** — Sent at ~4Hz with the current input audio level (0.0-1.0 range).

```json
{ "level": 0.042 }
```

### State Machine

- **paused** — Master kill switch. All outputs stopped. Autoconnect won't trigger.
- **idle** — Armed and listening. Monitoring input RMS level. Outputs disconnected.
- **detecting** — Signal above threshold detected, sustaining for 250ms to filter transient bumps (e.g., table bumps). Uses raw RMS.
- **connected** — Audio routing active. Default outputs connected. Uses smoothed RMS with hysteresis (threshold/4) to avoid flip-flopping during quiet passages.
- **silence** — Silence detected while connected. Outputs disconnect after 5 minutes of sustained silence. Uses smoothed RMS.

The `"listening"` client command enters `idle` (arms autoconnect). The `"paused"` command stops everything immediately. On server restart, state is determined by `config.autoconnectEnabled`.

### Threshold Configuration

- **Phono mode** (with preamp): threshold `0.01` — music at 0.03-0.08 smoothed, surface noise at 0.001-0.002 smoothed
- **Line mode** (no preamp): threshold `0.0005` — much quieter signal

### Extended `state` Event

The `state` event includes config and autoconnect state:

```json
{
  ...existing fields...,
  "config": { ... },
  "autoconnectState": "idle"
}
```

## Turntable Power & Silence Auto-Off (v1.1)

The turntable can be plugged into a HomeKit-enabled **Matter** smart plug. BabelPod commissions the plug onto its own Matter fabric (multi-admin — it stays paired with Apple Home) and:

- Exposes the plug over the API: `setTurntablePower` / `turntablePower` and `state.turntablePower`.
- Subscribes to the plug's OnOff attribute, so changes made from Apple Home or the physical button are broadcast to all clients.
- Optionally powers the plug **off** after sustained input silence (a record left spinning in the runout groove). The silence detector taps the same RMS pipeline as autoconnect, converts to dBFS (with ~1s smoothing), and fires only after `autoOffSilenceMinutes` of continuous signal in the dead band between `autoOffNoiseFloorDb` and `autoOffSilenceThresholdDb` — the signature of a powered turntable with nothing playing. Louder audio (music) resets the window, so inter-track gaps and quiet passages never trigger; so does a level **below the noise floor**, which means the turntable itself is already off and cutting the outlet would only be an annoyance. After firing it disarms until power returns.

### Setup

1. In Apple Home, open the plug's settings and **Turn On Pairing Mode** to get a fresh setup code (the original code is consumed by Apple Home).
2. In `babelpod.config.json` set `"turntablePlugEnabled": true` and `"turntablePlugPairingCode": "<code>"`, then restart the server.
3. Commissioning credentials persist in `.matter-storage/`, so the pairing code is only needed once.

A Wi-Fi Matter plug is reachable directly over IP. A Thread-only plug would additionally require a Thread Border Router on the Pi.

### Ownership and automation

`setTurntablePower` is owner-gated like every other client command. Internal automation (the silence auto-off) uses a privileged path that bypasses the session-owner check without changing session ownership — it never emits `session`, only the resulting `turntablePower`/`status` broadcasts.

## Session Ownership

Only one client controls BabelPod at a time. The session model works as follows:

- The first client to connect becomes the owner automatically.
- Additional clients connect as observers and can see all state but cannot make changes.
- A non-owner can call `takeover` to claim control.
- When the owner disconnects, if only one client remains it automatically becomes the owner. Otherwise ownership is released (`session.owner` becomes `null`).
- All clients receive `session` events when ownership changes.

## Service Discovery

BabelPod advertises itself via mDNS/Bonjour as `_babelpod._tcp` on the configured port. Clients can use this to discover servers on the local network without manual configuration.

## Echo Detection

The server broadcasts state changes to all connected clients, including the client that initiated the change. Clients should implement echo detection to avoid feedback loops (e.g., a volume slider snapping back when the server echoes the client's own change). A recommended approach:

1. Track the last value emitted to the server (`lastEmitted`).
2. When a server event arrives, compare against `lastEmitted`.
3. If they match, skip updating the UI (it already reflects the user's action).
4. Reset `lastEmitted` on reconnection and ownership changes.

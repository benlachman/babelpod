# BabelPod Socket.IO API (v1)

BabelPod uses [Socket.IO](https://socket.io/) for real-time communication between clients and the server. All payloads are JSON objects. The API version is included in the `state` event on connection.

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
  "volume": 50
}
```

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

### `takeover`

Claim session ownership. No payload required.

```json
{}
```

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

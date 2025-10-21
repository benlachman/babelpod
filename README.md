# BabelPod

BabelPod is a lightweight Node.js application that captures audio from a selected input device (like a USB mic or line-in) and sends it in real-time to multiple output devices, including:

- AirPlay speakers or receivers (via [node_airtunes2](https://github.com/ciderapp/node_airtunes2))
- Local aplay processes on a Raspberry Pi or similar

## Features

- Select input devices (including `arecord`-recognized hardware).
- Stream to multiple outputs in parallel (local or AirPlay).
- Automatic discovery of AirPlay devices via mDNS.
- Simple UI served by Express + Socket.IO.

## Prerequisites

- Node.js (LTS version recommended)
- `arecord` and `aplay` installed (often in `alsa-utils` package on Linux).
- On macOS, `sox` or other tools might be needed for capturing audio, but this is primarily tested on Linux.

## Installation & Setup

### [Start here: Overarching instructions to set up and use BabelPod.](http://faden.me/2018/03/18/babelpod.html)

### Then…

1. **Clone** this repository.
2. **Install dependencies** in `babelpod` folder:

```bash
cd babelpod
npm install
```

3. **node_airtunes2** must also be installed (the dependency is included in package.json).

### _Note: Potential Node-Gyp Issues_

If you have trouble building airtunes2, ensure:

- You have a proper C++ build environment (e.g., build-essential on Debian/Ubuntu or Xcode Command Line Tools on macOS).
- Node.js version is not too new to break older C++ code. If you get errors like “C++20 or later required,” you can consider installing an LTS version of Node (e.g., 18 or 20).

## Usage

1. Start:

`node index.js`

or if you have nodemon:

`nodemon index.js`

2. Open `http://<your-pi-ip>:3000` in a web browser (mobile or desktop).
3. Select an input device from the dropdown. If using a microphone or USB interface, choose the correct `plughw:{...}`.
4. Adjust volume and choose outputs. You can select multiple AirPlay or local outputs simultaneously.

### Verifying Audio

1. Manual **arecord** test

`arecord -D plughw:1,0 -c2 -f S16_LE -r44100 test.wav`

- Speak or play audio, then **Ctrl+C** to stop.

`aplay test.wav`

- You should hear your recording on local playback. This ensures your input device is working.

2. **Confirm single AirPlay device with node_airtunes2**

`cat test.wav | npx airtunes2 --host <AirPlay device IP> --port 7000`

- If you hear playback on that AirPlay device, the streaming chain works.

3. **BabelPod**

- Start the server: `node index.js`
- Go to the UI, pick the same input device used above, select your AirPlay or local device. You should hear real-time audio.

### Debugging

    •	Use console.log lines or the Node process logs to see activity.
    •	mDNS scanning logs can be checked if needed: watch for “update” events or data.txt.
    •	If audio is silent, confirm volumes, passcodes, or if your device demands a pin. Check if any firewall blocks UDP traffic.

### Error Handling & Reliability

BabelPod now includes comprehensive error handling to prevent crashes and provide better visibility:

- **UI Error Messages**: The web interface displays error and status messages so you can see what's happening without checking server logs.
- **Process Error Handling**: The server won't crash if `arecord` or `aplay` processes fail - errors are logged and reported to the UI.
- **Network Resilience**: AirPlay connection errors and mDNS issues are handled gracefully.
- **Graceful Shutdown**: Clean shutdown on Ctrl+C (SIGINT) or SIGTERM properly stops all audio processes.

### Testing

See [TESTING.md](TESTING.md) for a comprehensive testing guide including manual test checklists and expected behavior documentation.

Run unit tests with:
```bash
npm test
```

## Contributing

Please open issues or PRs for improvements or bugfixes.

## License

MIT License (See LICENSE.md)

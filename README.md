# BabelPod

BabelPod is a lightweight Node.js application that captures audio from a selected input device (like a USB mic or line-in) and sends it in real-time to multiple output devices, including:

- AirPlay speakers or receivers (via [node_airtunes2](https://github.com/ciderapp/node_airtunes2))
- Local aplay processes on a Raspberry Pi or similar

## Features

- Select input devices (including `arecord`-recognized hardware and Bluetooth audio devices).
- Stream to multiple outputs in parallel (local or AirPlay).
- Automatic discovery of AirPlay devices via mDNS with support for stereo paired HomePods.
- Bluetooth input support for wireless audio streaming.
- Optional PCM device scanning (can be disabled for better performance on systems that don't use ALSA devices).
- Enhanced mDNS service handling for dynamic IP address changes.
- Simple UI served by Express + Socket.IO.

## Prerequisites

- Node.js (LTS version recommended)
- `arecord` and `aplay` installed (often in `alsa-utils` package on Linux).
- On macOS, `sox` or other tools might be needed for capturing audio, but this is primarily tested on Linux.
- **Optional:** For Bluetooth input support, install `bluetoothctl` and pair your Bluetooth audio devices.
- **Optional:** For PCM device support, ensure your ALSA devices are properly configured. PCM scanning is enabled by default.

## Installation & Setup

### [Start here: Overarching instructions to set up and use BabelPod.](http://faden.me/2018/03/18/babelpod.html)

### Then…

1. **Clone** this repository.
2. **Install dependencies** in `babelpod` folder:

```bash
cd babelpod
npm install
```

   **Note for Raspberry Pi Zero/Zero 2 W**: If you're running on a low-memory device like the Raspberry Pi Zero or Zero 2 W, you may need to use a lower-memory npm install option:

   ```bash
   npm install --omit=dev --omit=peer --omit=optional --no-audit --no-fund --jobs=1 --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=10000 --fetch-timeout=600000
   ```

   If `npm install` fails with out-of-memory errors, check your swap space with `swapon --show` to determine if you're running out of swap space.

3. **node_airtunes2** must also be installed (the dependency is included in package.json).

### _Note: Potential Node-Gyp Issues_

If you have trouble building airtunes2, ensure:

- You have a proper C++ build environment (e.g., build-essential on Debian/Ubuntu or Xcode Command Line Tools on macOS).
- Node.js version is not too new to break older C++ code. If you get errors like “C++20 or later required,” you can consider installing an LTS version of Node (e.g., 18 or 20).

## Usage

### Environment Variables

BabelPod supports the following environment variables for configuration:

- **`DISABLE_PCM=1`**: Disable PCM device scanning. By default, PCM scanning is enabled. Set this to `1` if you don't use ALSA PCM input/output devices and want better performance.
- **`BABEL_PORT=3000`**: Set the HTTP server port (default: 3000).

Example:
```bash
DISABLE_PCM=1 node index.js
```

### Starting the Server

1. Start:

`node index.js`

or if you have nodemon:

`nodemon index.js`

2. Open `http://<your-pi-ip>:3000` in a web browser (mobile or desktop).
3. Select an input device from the dropdown. If using a microphone or USB interface, choose the correct `plughw:{...}`. For Bluetooth devices, they will appear as "Bluetooth: [device name]".
4. Adjust volume and choose outputs. You can select multiple AirPlay or local outputs simultaneously.

### Pairing Bluetooth Devices

To use Bluetooth audio devices as input sources, you'll need to pair them first using `bluetoothctl`:

1. **Install Bluetooth tools** (if not already installed):
```bash
sudo apt-get install bluez
```

2. **Start bluetoothctl**:
```bash
bluetoothctl
```

3. **Enable the Bluetooth agent and scan for devices**:
```
power on
agent on
default-agent
scan on
```

4. **Wait for your device to appear** in the scan results. You'll see something like:
```
[NEW] Device AA:BB:CC:DD:EE:FF My Bluetooth Speaker
```

5. **Pair with the device** using its MAC address:
```
pair AA:BB:CC:DD:EE:FF
trust AA:BB:CC:DD:EE:FF
connect AA:BB:CC:DD:EE:FF
```

6. **Exit bluetoothctl**:
```
exit
```

Once paired and trusted, the Bluetooth device will appear in BabelPod's input device list as "Bluetooth: [device name]". BabelPod will automatically connect to the device when you select it as an input source.

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

### Running as a System Service

BabelPod can be configured to run automatically as a systemd service on boot. This is especially useful for permanent installations on Raspberry Pi.

#### Installing the Service

1. Copy the service file to the systemd directory:

```bash
sudo cp babelpod.service /etc/systemd/system/
```

2. Edit the service file to match your setup:

```bash
sudo nano /etc/systemd/system/babelpod.service
```

   Update the following fields (and others) as needed:
   - `User` and `Group`: Change from `pi` to your username
   - `WorkingDirectory`: Set to the full path of your babelpod installation
   - `ExecStart`: Update the path to your babelpod installation
   - `XDG_RUNTIME_DIR`: Update the UID (1000) to match your user's UID (run `id -u` to find it)

3. Reload systemd to recognize the new service:

```bash
sudo systemctl daemon-reload
```

4. Enable the service to start on boot:

```bash
sudo systemctl enable babelpod
```

5. Start the service:

```bash
sudo systemctl start babelpod
```

#### Useful Service Commands

- Check service status:
  ```bash
  sudo systemctl status babelpod
  ```

- View service logs:
  ```bash
  sudo journalctl -u babelpod # add -f to follow logs in real-time, which is useful for debugging
  ```
  

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

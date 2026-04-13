/*
  Babelpod index.js 
  This script handles audio input (arecord) and pipes it to multiple outputs,
  including AirPlay devices (via node_airtunes2) and local aplay processes.
*/

// =======================
// 1) Required modules
// =======================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const stream = require('stream');
const util = require('util');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const mdns = require('mdns-js');
const dnssd = require('dnssd2');
const AirTunes = require('airtunes2');
const { hostname } = require('os');
const path = require('path');

// =======================
// 1b) Instance configuration
// =======================
const CONFIG_PATH = path.join(__dirname, 'babelpod.config.json');

const DEFAULT_CONFIG = {
  displayName: hostname().replace('.local', ''),
  defaultInputId: null,
  defaultOutputIds: [],
  defaultVolume: 50,
  autoconnectEnabled: false,
  autoconnectThreshold: 0.002
};

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(data);
    config = { ...DEFAULT_CONFIG, ...parsed };
    console.log("Loaded config:", config);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log("No config file found, using defaults");
    } else {
      console.error("Error reading config file, using defaults:", error.message);
    }
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig(partial) {
  config = { ...config, ...partial };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log("Config saved:", config);
  } catch (error) {
    console.error("Error saving config:", error.message);
  }
  io.emit('config', config);
}

loadConfig();

// Bluetooth support - optional, may not be available on all systems
let blue = null;
try {
  blue = require('bluetoothctl');
} catch (e) {
  console.log("Bluetooth support not available (bluetoothctl module not found)");
}

// =======================
// 2) Basic server setup
// =======================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// =======================
// 3) Global AirTunes & local processes
// =======================
const airtunes = new AirTunes();
let activeLocalOutputs = [];
let activeAirPlayDevices = []; // Track active AirPlay devices for volume control

// =======================
// 4) Fallback sink setup
//    (stream to nowhere)
// =======================
util.inherits(DiscardSink, stream.Writable);
function DiscardSink() {
  if (!(this instanceof DiscardSink)) return new DiscardSink();
  stream.Writable.call(this);
}
DiscardSink.prototype._write = function (_chunk, _enc, cb) {
  cb();
};
const fallbackSink = new DiscardSink();

// =======================
// 4b) RMS audio level monitor
// =======================
class RmsMonitorTransform extends stream.Transform {
  constructor() {
    super();
    this.currentRms = 0;
    this.chunkCount = 0;
  }

  _transform(chunk, encoding, callback) {
    // Skip RMS calculation when autoconnect is paused (save CPU)
    if (autoconnectState.state === 'paused') {
      callback(null, chunk);
      return;
    }

    this.chunkCount++;
    // Process every 4th chunk for efficiency (~5-10 readings/sec)
    if (this.chunkCount % 4 === 0) {
      const sampleCount = Math.floor(chunk.length / 2);
      let sumOfSquares = 0;
      for (let i = 0; i < sampleCount; i++) {
        const sample = chunk.readInt16LE(i * 2) / 32768;
        sumOfSquares += sample * sample;
      }
      this.currentRms = Math.sqrt(sumOfSquares / sampleCount);
      this.emit('rms', this.currentRms);

      // Throttled emission to clients (~4Hz)
      const now = Date.now();
      if (now - lastRmsEmitTime >= 250) {
        lastRmsEmitTime = now;
        io.emit('rmsLevel', { level: this.currentRms });
      }
    }
    callback(null, chunk);
  }
}

let rmsMonitor = new RmsMonitorTransform();
let lastRmsEmitTime = 0;

// =======================
// 4c) Autoconnect state machine
// =======================
const AUTOCONNECT_DETECT_SUSTAIN_MS = 250;
const AUTOCONNECT_SILENCE_TIMEOUT_MS = 300000; // 5 minutes

let autoconnectState = {
  state: config.autoconnectEnabled ? 'idle' : 'paused',
  detectingSince: null,
  silenceSince: null,
};

function emitAutoconnectState() {
  io.emit('autoconnect', { state: autoconnectState.state });
}

function activateDefaultOutputs() {
  if (config.defaultOutputIds.length === 0) {
    io.emit('status', { message: 'Autoconnect: no default outputs configured' });
    console.log("Autoconnect: no default outputs configured");
    return;
  }

  volume = config.defaultVolume || 50;
  const validOutputIds = config.defaultOutputIds.filter(outputId =>
    unifiedOutputs.some(output => output.uiId === outputId)
  );
  if (validOutputIds.length > 0) {
    syncOutputs(validOutputIds);
    io.emit('output', { ids: validOutputIds });
    io.emit('volume', { value: volume });
    const missing = config.defaultOutputIds.length - validOutputIds.length;
    const message = missing > 0
      ? `Autoconnect activated (${missing} default output${missing > 1 ? 's' : ''} unavailable)`
      : 'Autoconnect activated';
    io.emit('status', { message });
    console.log("Autoconnect: activated default outputs:", validOutputIds);
  } else {
    io.emit('serverError', { message: 'Autoconnect: default outputs not available' });
    console.log("Autoconnect: all default outputs unavailable:", config.defaultOutputIds);
  }
}

function deactivateOutputs() {
  syncOutputs([]);
  io.emit('output', { ids: [] });
  io.emit('status', { message: 'Autoconnect: speakers released after silence' });
  console.log("Autoconnect: deactivated outputs after silence timeout");
}

function tickAutoconnect(rmsLevel) {
  const threshold = config.autoconnectThreshold || 0.002;
  const now = Date.now();

  switch (autoconnectState.state) {
    case 'paused':
      return; // Do nothing

    case 'idle':
      if (rmsLevel > threshold) {
        autoconnectState.state = 'detecting';
        autoconnectState.detectingSince = now;
        emitAutoconnectState();
      }
      break;

    case 'detecting':
      if (rmsLevel <= threshold) {
        // Signal dropped — false trigger
        autoconnectState.state = 'idle';
        autoconnectState.detectingSince = null;
        emitAutoconnectState();
      } else if (now - autoconnectState.detectingSince >= AUTOCONNECT_DETECT_SUSTAIN_MS) {
        // Sustained signal — activate!
        autoconnectState.state = 'connected';
        autoconnectState.detectingSince = null;
        emitAutoconnectState();
        activateDefaultOutputs();
      }
      break;

    case 'connected':
      if (rmsLevel <= threshold) {
        autoconnectState.state = 'silence';
        autoconnectState.silenceSince = now;
        emitAutoconnectState();
      }
      break;

    case 'silence':
      if (rmsLevel > threshold) {
        // Sound returned
        autoconnectState.state = 'connected';
        autoconnectState.silenceSince = null;
        emitAutoconnectState();
      } else if (now - autoconnectState.silenceSince >= AUTOCONNECT_SILENCE_TIMEOUT_MS) {
        // Extended silence — release speakers
        autoconnectState.state = 'idle';
        autoconnectState.silenceSince = null;
        emitAutoconnectState();
        deactivateOutputs();
      }
      break;
  }
}

function setAutoconnectState(newState) {
  if (newState === 'paused') {
    autoconnectState.state = 'paused';
    autoconnectState.detectingSince = null;
    autoconnectState.silenceSince = null;
    // Master kill switch — stop all outputs
    syncOutputs([]);
    io.emit('output', { ids: [] });
    emitAutoconnectState();
    console.log("Autoconnect: paused (all outputs stopped)");
  } else if (newState === 'listening') {
    autoconnectState.state = 'idle'; // Enter idle, let RMS detection handle the rest
    autoconnectState.detectingSince = null;
    autoconnectState.silenceSince = null;
    emitAutoconnectState();
    console.log("Autoconnect: armed and listening");
  }
}

// Hook RMS readings into autoconnect state machine
function wireRmsMonitor() {
  rmsMonitor.on('rms', tickAutoconnect);
}
wireRmsMonitor();

// =======================
// 5) Main audio duplicator
// =======================
const duplicator = new stream.PassThrough({ highWaterMark: 65536 });
duplicator.pipe(fallbackSink);
duplicator.pipe(airtunes, { end: false }).on('error', e => {
  console.error("AirTunes piping error:", e);
  // Don't crash on AirTunes errors
});

// Handle duplicator errors
duplicator.on('error', e => {
  console.error("Duplicator stream error:", e);
});

// =======================
// 6) Current audio input
// =======================
let currentInput = "void";
let arecordInstance = null;
let isManualInputSwitch = false; // Track if input switch was intentional
let inputRestartAttempts = 0;
const MAX_INPUT_RESTART_ATTEMPTS = 3;
const INPUT_RESTART_DELAY = 2000; // 2 seconds
const CLEANUP_DELAY = 500; // Delay after cleanup before starting new process
let busyRetryAttempts = 0;
const MAX_BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BASE_DELAY = 200; // Base delay for busy retry (exponential backoff)

util.inherits(FromVoid, stream.Readable);
function FromVoid() {
  if (!(this instanceof FromVoid)) return new FromVoid();
  stream.Readable.call(this);
}
FromVoid.prototype._read = function () { };
let inputStream = new FromVoid();
rmsMonitor.pipe(duplicator);
inputStream.pipe(rmsMonitor);

// Clean up current input, stop processes
function cleanupCurrentInput() {
  try {
    if (inputStream) {
      inputStream.unpipe(rmsMonitor);
      inputStream = null;
    }
    if (arecordInstance) {
      try {
        arecordInstance.kill('SIGTERM');
        const instance = arecordInstance;
        setTimeout(() => {
          if (instance && !instance.killed) {
            console.log('arecord did not terminate gracefully, force killing...');
            instance.kill('SIGKILL');
          }
        }, 100);
      } catch (e) {
        console.error("Error killing arecord instance:", e);
      }
      arecordInstance = null;
    }
  } catch (e) {
    console.error("Error cleaning up input:", e);
  }
}

// Kill any orphaned arecord processes for the specified device
function killOrphanedArecord(devId) {
  if (devId === "void" || !devId) return;
  try {
    const result = execSync(`pgrep -f "arecord.*${devId}"`, { encoding: 'utf8' }).trim();
    if (result) {
      console.log(`Found orphaned arecord processes for ${devId}, terminating: ${result}`);
      execSync(`pkill -9 -f "arecord.*${devId}"`);
    }
  } catch (e) {
    // pgrep returns non-zero if no processes found, which is fine
    if (e.status !== 1) {
      console.error(`Error checking for orphaned arecord processes: ${e.message}`);
    }
  }
}

// Start arecord for a specific device with orphan cleanup
function startArecordForDevice(devId, isRetry = false) {
  if (devId === "void") return;
  try {
    console.log(`Starting arecord for device: ${devId}${isRetry ? ' (retry)' : ''}`);
    killOrphanedArecord(devId);

    arecordInstance = spawn("arecord", [
      "-D", devId, "-c", "2", "-f", "S16_LE", "-r", "44100"
    ]);

    setupArecordHandlers(devId, isRetry);
    inputStream = arecordInstance.stdout;
    inputStream.on('error', (error) => {
      console.error(`Error with input stream for ${devId}:`, error);
    });
    rmsMonitor = new RmsMonitorTransform();
    wireRmsMonitor();
    rmsMonitor.pipe(duplicator);
    inputStream.pipe(rmsMonitor);

    if (isRetry) {
      busyRetryAttempts = 0;
      isManualInputSwitch = false;
    } else {
      busyRetryAttempts = 0;
    }
    io.emit('input', { id: currentInput });
    io.emit('status', { message: `Input ${isRetry ? 'reconnected' : 'switched'} to ${currentInput}` });
    console.log(`Successfully started arecord for device: ${devId}`);
  } catch (e) {
    console.error(`Failed to start arecord for device ${devId}:`, e);
    io.emit('serverError', { message: `Failed to start input: ${e.message}` });
  }
}

// Restart input device (for automatic recovery)
function restartInputDevice(devId, delayMs = 0) {
  if (devId === "void") return;

  setTimeout(() => {
    console.log(`Attempting to restart input device: ${devId} (attempt ${inputRestartAttempts + 1}/${MAX_INPUT_RESTART_ATTEMPTS})`);
    try {
      cleanupCurrentInput();
      setTimeout(() => {
        startArecordForDevice(devId, true);
        inputRestartAttempts++;
      }, CLEANUP_DELAY);
    } catch (e) {
      console.error(`Failed to restart input device ${devId}:`, e);
      io.emit('serverError', { message: `Failed to reconnect input: ${e.message}` });
    }
  }, delayMs);
}

// Setup arecord process event handlers
function setupArecordHandlers(devId, isRetry = false) {
  if (!arecordInstance) return;

  arecordInstance.on('error', (error) => {
    console.error(`Error with arecord process for ${devId}:`, error);
    io.emit('serverError', { message: `Input device error: ${error.message}` });
  });

  arecordInstance.stderr.on('data', (data) => {
    const msg = data.toString();
    console.error(`arecord stderr for ${devId}:`, msg);

    // Handle "Device or resource busy" with retry
    if (msg.includes('Device or resource busy') || msg.includes('audio open error')) {
      console.log(`Device busy detected for ${devId}, will retry after cleanup`);
      if (busyRetryAttempts < MAX_BUSY_RETRY_ATTEMPTS) {
        busyRetryAttempts++;
        const delay = BUSY_RETRY_BASE_DELAY * Math.pow(2, busyRetryAttempts - 1);
        console.log(`Busy retry ${busyRetryAttempts}/${MAX_BUSY_RETRY_ATTEMPTS} in ${delay}ms`);
        cleanupCurrentInput();
        setTimeout(() => {
          startArecordForDevice(devId, true);
        }, delay);
      } else {
        console.error(`Max busy retries reached for ${devId}`);
        io.emit('serverError', { message: `Input device busy after ${MAX_BUSY_RETRY_ATTEMPTS} retries` });
        busyRetryAttempts = 0;
      }
      return;
    }

    if (msg.includes('error') || msg.includes('failed')) {
      io.emit('serverError', { message: `Input error: ${msg.substring(0, 100)}` });
    }
  });
  
  arecordInstance.on('exit', (code, signal) => {
    console.log(`arecord exited for ${devId} - code: ${code}, signal: ${signal}, manual: ${isManualInputSwitch}`);
    
    // Only attempt restart if:
    // 1. Exit was unexpected (non-zero code or killed by signal)
    // 2. It wasn't a manual input switch
    // 3. We haven't exceeded retry attempts
    // 4. The current input is still this device
    if (!isManualInputSwitch && currentInput === devId) {
      if (code !== 0 || signal) {
        console.error(`arecord exited unexpectedly with code ${code}, signal ${signal} for ${devId}`);
        io.emit('serverError', { message: `Input device disconnected - attempting to reconnect...` });
        
        if (inputRestartAttempts < MAX_INPUT_RESTART_ATTEMPTS) {
          restartInputDevice(devId, INPUT_RESTART_DELAY);
        } else {
          console.error(`Max restart attempts (${MAX_INPUT_RESTART_ATTEMPTS}) reached for ${devId}`);
          io.emit('serverError', { message: `Input device failed after ${MAX_INPUT_RESTART_ATTEMPTS} reconnection attempts. Please reselect the input.` });
          inputRestartAttempts = 0; // Reset for next manual selection
        }
      }
    }
    
    // Reset flag after handling exit
    if (isManualInputSwitch) {
      isManualInputSwitch = false;
    }
  });
}

// =======================
// 7) Volume & outputs
// =======================
let volume = config.defaultVolume || 50;
let selectedOutputs = [];

let availablePcmOutputs = [];
let availablePcmInputs = [];
let availableBluetoothInputs = []; // TODO: Bluetooth input discovery not yet implemented
let availableAirplayOutputs = [];
let unifiedOutputs = [];

// Scan for PCM devices
function scanPcmDevices() {
  try {
    const text = fs.readFileSync('/proc/asound/pcm', 'utf8');
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const all = lines.map(line => {
      const parts = line.split(':');
      if (parts.length < 3) return null;
      const devName = parts[2].trim();
      const devId = "plughw:" + parts[0].split("-").map(x => parseInt(x, 10)).join(",");
      return {
        id: devId,
        name: devName,
        output: parts.some(t => t.includes("playback")),
        input: parts.some(t => t.includes("capture"))
      };
    }).filter(Boolean);
    availablePcmOutputs = all.filter(d => d.output);
    availablePcmInputs = all.filter(d => d.input);
  } catch (e) {
    console.error("Error scanning /proc/asound/pcm:", e);
    // Don't crash - just log and continue with empty lists
  }
}

// Organize available outputs into a single list
function buildUnifiedOutputs() {
  let local = availablePcmOutputs.map(o => ({
    uiId: o.id,
    name: o.name + ' - Output',
    isStereo: false,
    devices: [{ localId: o.id }]
  }));

  // unify airplay outputs that might appear multiple times if it's the same device
  // we can unify them by name and host:port, ignoring duplicates
  let unique = {};
  for (const device of availableAirplayOutputs) {
    // create a key to unify duplicates
    const key = (device.name || "") + "_" + device.host + "_" + device.port;
    if (!unique[key]) {
      unique[key] = device;
    }
  }
  let cleanedAirplayOutputs = Object.values(unique);

  let grouped = {};
  for (const device of cleanedAirplayOutputs) {
    const st = device.stereo || `${device.host}:${device.port}`;
    if (!grouped[st]) grouped[st] = [];
    grouped[st].push(device);
  }

  let air = [];
  for (const stereoName in grouped) {
    const arr = grouped[stereoName];
    if (arr.length === 1) {
      const d = arr[0];
      air.push({
        uiId: 'air:' + d.name,
        name: (d.name || d.host) + ' - AirPlay',
        isStereo: false,
        devices: [{ host: d.host, port: d.port, isStereo: false }]
      });
    } else {
      air.push({
        uiId: 'airpair:' + stereoName,
        name: stereoName + ' - AirPlay Stereo',
        isStereo: true,
        devices: arr.map(d => ({ host: d.host, port: d.port, isStereo: true }))
      });
    }
  }
  return local.concat(air);
}

// Build clean payloads for clients (strip server internals)
function buildCleanInputs() {
  const defInputs = [{ name: 'None', id: 'void' }];
  return defInputs.concat(availablePcmInputs, availableBluetoothInputs)
    .map(i => ({ id: i.id, name: i.name }));
}

function buildCleanOutputs() {
  return unifiedOutputs.map(o => ({ id: o.uiId, name: o.name }));
}

function buildStatePayload() {
  return {
    version: 1,
    sessionOwner,
    inputs: buildCleanInputs(),
    outputs: buildCleanOutputs(),
    selectedInput: currentInput,
    selectedOutputs,
    volume,
    config,
    autoconnectState: autoconnectState.state
  };
}

// Emit updates to clients
function updateAllOutputs() {
  unifiedOutputs = buildUnifiedOutputs();
  io.emit('outputs', { outputs: buildCleanOutputs() });
}
function updateAllInputs() {
  io.emit('inputs', { inputs: buildCleanInputs() });
}

// Initial device scan - PCM enabled by default
// Set DISABLE_PCM=1 to disable PCM input/output device scanning for better performance
if (!process.env.DISABLE_PCM) {
  console.log("PCM device scanning enabled");
  scanPcmDevices();
  // Auto-select input on startup: prefer config default, then first available
  if (currentInput === "void" && availablePcmInputs.length > 0) {
    const configuredInput = config.defaultInputId && availablePcmInputs.some(d => d.id === config.defaultInputId)
      ? config.defaultInputId
      : availablePcmInputs[0].id;
    const autoDevId = configuredInput;
    console.log("Auto-selecting input:", autoDevId);
    cleanupCurrentInput();
    currentInput = autoDevId;
    arecordInstance = spawn("arecord", [
      "-D", autoDevId, "-c", "2", "-f", "S16_LE", "-r", "44100"
    ]);
    setupArecordHandlers(autoDevId);
    inputStream = arecordInstance.stdout;
    inputStream.on('error', (error) => {
      console.error(`Error with auto-selected input stream for ${autoDevId}:`, error);
    });
    rmsMonitor = new RmsMonitorTransform();
    wireRmsMonitor();
    rmsMonitor.pipe(duplicator);
    inputStream.pipe(rmsMonitor);
  }
  setInterval(scanPcmDevices, 10000);
} else {
  console.log("PCM device scanning disabled via DISABLE_PCM environment variable");
}

// =======================
// 7b) Bluetooth device discovery
// =======================
if (blue) {
  try {
    blue.Bluetooth();
    // Give bluetoothctl time to initialize before getting paired devices
    setTimeout(() => {
      if (blue.getPairedDevices) {
        blue.getPairedDevices();
      }
    }, 5000);

    blue.on(blue.bluetoothEvents.Device, function (devices) {
      availableBluetoothInputs = [];
      for (const device of blue.devices || []) {
        availableBluetoothInputs.push({
          name: 'Bluetooth: ' + device.name,
          id: 'bluealsa:SRV=org.bluealsa,DEV=' + device.mac + ',PROFILE=a2dp',
          mac: device.mac,
          connected: device.connected === 'yes'
        });
      }
      updateAllInputs();
    });
    console.log("Bluetooth device scanning enabled");
  } catch (e) {
    console.error("Error initializing Bluetooth:", e);
  }
}

// =======================
// 8) AirPlay + BabelPod Discovery
// =======================
// Use dnssd2 for better service change/down event handling
let browser = dnssd.Browser(dnssd.tcp('airplay'));

browser.on('serviceUp', data => {
  try {
    if (!data.fullname || !data.addresses?.length) return;
    const match = /(.*)\._airplay\._tcp\.local/.exec(data.fullname);
    if (match && match.length > 1) {
      const address = data.addresses[0];
      const port = data.port;
      const st = data.txt?.gpn || null;
      if (!availableAirplayOutputs.some(o => o.host === address && o.port === port)) {
        availableAirplayOutputs.push({
          name: match[1],
          stereo: st,
          host: address,
          port
        });
        console.log(`AirPlay device discovered: ${match[1]} at ${address}:${port}`);
        updateAllOutputs();
      }
    }
  } catch (e) {
    console.error("Error processing mDNS serviceUp:", e);
  }
});

browser.on('serviceChanged', data => {
  try {
    if (!data.fullname || !data.addresses?.length) return;
    const match = /(.*)\._airplay\._tcp\.local/.exec(data.fullname);
    if (match && match.length > 1) {
      const address = data.addresses[0];
      const port = data.port;
      const st = data.txt?.gpn || null;
      const oldId = 'airplay_' + address + '_' + port;
      
      // Find and update existing device
      const device = availableAirplayOutputs.find(o => o.host === address && o.port === port);
      if (device) {
        device.name = match[1];
        device.stereo = st;
        console.log(`AirPlay device updated: ${match[1]} at ${address}:${port}`);
        updateAllOutputs();
      } else {
        // Device not found, treat as new
        availableAirplayOutputs.push({
          name: match[1],
          stereo: st,
          host: address,
          port
        });
        console.log(`AirPlay device added via change event: ${match[1]} at ${address}:${port}`);
        updateAllOutputs();
      }
    }
  } catch (e) {
    console.error("Error processing mDNS serviceChanged:", e);
  }
});

browser.on('serviceDown', data => {
  try {
    if (!data.fullname || !data.addresses?.length) return;
    const match = /(.*)\._airplay\._tcp\.local/.exec(data.fullname);
    if (match && match.length > 1) {
      const address = data.addresses[0];
      const port = data.port;
      const beforeCount = availableAirplayOutputs.length;
      availableAirplayOutputs = availableAirplayOutputs.filter(
        o => !(o.host === address && o.port === port)
      );
      if (availableAirplayOutputs.length < beforeCount) {
        console.log(`AirPlay device removed: ${match[1]} at ${address}:${port}`);

        // Stop streaming to the removed device
        const deviceKey = `${address}:${port}`;
        if (activeAirPlayDevices.includes(deviceKey)) {
          try {
            airtunes.stop(deviceKey);
          } catch (e) {
            console.error(`Error stopping removed AirPlay device ${deviceKey}:`, e);
          }
          activeAirPlayDevices = activeAirPlayDevices.filter(k => k !== deviceKey);
        }

        updateAllOutputs();

        // Remove offline devices from selectedOutputs
        const validIds = new Set(unifiedOutputs.map(o => o.uiId));
        const cleanedOutputs = selectedOutputs.filter(id => validIds.has(id));
        if (cleanedOutputs.length !== selectedOutputs.length) {
          selectedOutputs = cleanedOutputs;
          io.emit('output', { ids: selectedOutputs });
        }
      }
    }
  } catch (e) {
    console.error("Error processing mDNS serviceDown:", e);
  }
});

browser.on('error', (error) => {
  console.error("mDNS browser error:", error);
  // Continue operating even if mDNS has issues
});

// Start the browser
browser.start();

// ============ Advertise BabelPod service
let advertise = null;
function advertiseService() {
  try {
    const p = Number(process.env.BABEL_PORT || 3000);
    advertise = mdns.createAdvertisement(mdns.tcp('babelpod'), p, {
      name: config.displayName || hostname().replace('.local', ''),
      txt: {
        info: "A BabelPod audio server"
      }
    });
    console.log("Advertising BabelPod service:", advertise);
    advertise.start();
  } catch (err) {
    console.log("Error advertising BabelPod service:", err);
  }
}
function restartAdvertisement() {
  try {
    if (advertise) advertise.stop();
  } catch (err) {
    console.error("Error stopping advertisement:", err);
  }
  advertiseService();
}
advertiseService();

// =======================
// 9) Sync outputs
//    (add/remove from duplicator)
// =======================
function syncOutputs(newSelected) {
  try {
    const old = selectedOutputs.slice();
    selectedOutputs = newSelected.slice();

    const removed = old.filter(r => !selectedOutputs.includes(r));
    const added = selectedOutputs.filter(a => !old.includes(a));

    // Remove old outputs
    removed.forEach(rid => {
      try {
        if (rid.startsWith("plughw:")) {
          for (let i = activeLocalOutputs.length - 1; i >= 0; i--) {
            if (activeLocalOutputs[i].id === rid) {
              const p = activeLocalOutputs[i];
              try {
                duplicator.unpipe(p.process.stdin);
                p.process.kill();
              } catch (e) {
                console.error(`Error stopping local output ${rid}:`, e);
              }
              activeLocalOutputs.splice(i, 1);
            }
          }
        } else if (rid.startsWith("air:") || rid.startsWith("airpair:")) {
          const ud = unifiedOutputs.find(u => u.uiId === rid);
          if (ud) {
            ud.devices.forEach(d => {
              if (d.host && d.port) {
                try {
                  const deviceKey = `${d.host}:${d.port}`;
                  airtunes.stop(deviceKey);
                  // Remove from active AirPlay devices
                  activeAirPlayDevices = activeAirPlayDevices.filter(k => k !== deviceKey);
                } catch (e) {
                  console.error(`Error stopping AirPlay device ${d.host}:${d.port}:`, e);
                }
              }
            });
          }
        }
      } catch (e) {
        console.error(`Error removing output ${rid}:`, e);
      }
    });

    // Add new outputs
    added.forEach(aid => {
      try {
        if (aid === "void") return;
        if (aid.startsWith("plughw:")) {
          const child = spawn("aplay", [
            "-D", aid,
            "-c", "2",
            "-f", "S16_LE",
            "-r", "44100"
          ]);
          
          // Handle child process errors
          child.on('error', (error) => {
            console.error(`Error with aplay process for ${aid}:`, error);
            io.emit('serverError', { message: `Local output error: ${error.message}` });
          });
          
          child.stderr.on('data', (data) => {
            console.error(`aplay stderr for ${aid}:`, data.toString());
          });
          
          child.on('exit', (code, signal) => {
            if (code !== 0 && code !== null) {
              console.error(`aplay exited with code ${code} for ${aid}`);
            }
            // Clean up dead process from activeLocalOutputs
            try { duplicator.unpipe(child.stdin); } catch (e) { /* already gone */ }
            activeLocalOutputs = activeLocalOutputs.filter(o => o.process !== child);
          });
          
          duplicator.pipe(child.stdin).on('error', (e) => {
            console.error(`Error piping to local output ${aid}:`, e);
          });
          activeLocalOutputs.push({ id: aid, process: child });
        } else if (aid.startsWith("air:") || aid.startsWith("airpair:")) {
          const ud = unifiedOutputs.find(u => u.uiId === aid);
          if (!ud) return;
          ud.devices.forEach(device => {
            if (device.host && device.port) {
              try {
                const deviceKey = `${device.host}:${device.port}`;
                airtunes.add(device.host, {
                  port: device.port,
                  volume,
                  stereo: !!device.isStereo
                });
                // Track active AirPlay devices
                if (!activeAirPlayDevices.includes(deviceKey)) {
                  activeAirPlayDevices.push(deviceKey);
                }
              } catch (e) {
                console.error(`Error adding AirPlay device ${device.host}:${device.port}:`, e);
                io.emit('serverError', { message: `AirPlay error: ${e.message}` });
              }
            }
          });
        }
      } catch (e) {
        console.error(`Error adding output ${aid}:`, e);
        io.emit('serverError', { message: `Error adding output: ${e.message}` });
      }
    });
    
    // Set volume on all active AirPlay devices
    try {
      activeAirPlayDevices.forEach(deviceKey => {
        try {
          airtunes.setVolume(deviceKey, volume);
        } catch (e) {
          console.error(`Error setting volume for ${deviceKey}:`, e);
        }
      });
    } catch (e) {
      console.error("Error setting AirTunes volume:", e);
    }
  } catch (e) {
    console.error("Error in syncOutputs:", e);
    io.emit('serverError', { message: `Output sync error: ${e.message}` });
  }
}

// =======================
// 10) Express routes
// =======================
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// =======================
// 11) Socket.IO events
// =======================
let sessionOwner = null;

io.on('connection', socket => {
  console.log("Client connected:", socket.id);

  if (!sessionOwner) {
    sessionOwner = socket.id;
    io.emit('session', { owner: sessionOwner });
  }

  socket.on('takeover', () => {
    console.log("User takeover:", socket.id);

    if (sessionOwner !== socket.id) {
      sessionOwner = socket.id;
      io.emit('session', { owner: sessionOwner });
    }
  });

  socket.emit('state', buildStatePayload());

  socket.on('setInput', (data) => {
    const devId = data?.id;
    if (!devId) return;
    console.log("Switching input to:", devId);

    if (socket.id !== sessionOwner) return;
    
    try {
      // Mark this as a manual switch to prevent auto-restart
      isManualInputSwitch = true;
      inputRestartAttempts = 0;
      busyRetryAttempts = 0;

      cleanupCurrentInput();
      currentInput = devId;

      if (devId === "void") {
        inputStream = new FromVoid();
        rmsMonitor = new RmsMonitorTransform();
        wireRmsMonitor();
        rmsMonitor.pipe(duplicator);
        inputStream.pipe(rmsMonitor);
        io.emit('input', { id: currentInput });
        io.emit('status', { message: `Input switched to ${currentInput}` });
        isManualInputSwitch = false;
      } else if (devId.includes('bluealsa') && blue) {
        const btDevice = availableBluetoothInputs.find(d => d.id === devId);
        if (btDevice && !btDevice.connected) {
          io.emit('status', { message: `Connecting to Bluetooth device ${btDevice.name}...` });
          try {
            blue.connect(btDevice.mac);
            const switchDevId = devId;
            setTimeout(() => {
              if (currentInput !== switchDevId) return;
              if (blue.info) blue.info(btDevice.mac);
              setTimeout(() => {
                startArecordForDevice(switchDevId, false);
              }, CLEANUP_DELAY);
            }, 5000);
            return;
          } catch (e) {
            console.error("Error connecting to Bluetooth device:", e);
            io.emit('serverError', { message: `Failed to connect to Bluetooth: ${e.message}` });
            isManualInputSwitch = false;
          }
        } else {
          setTimeout(() => {
            startArecordForDevice(devId, false);
          }, CLEANUP_DELAY);
        }
      } else {
        setTimeout(() => {
          startArecordForDevice(devId, false);
        }, CLEANUP_DELAY);
      }
      
    } catch (e) {
      console.error("Error switching input:", e);
      io.emit('serverError', { message: `Failed to switch input: ${e.message}` });
    }
  });

  socket.on('setOutput', (data) => {
    const outs = data?.ids;
    if (!Array.isArray(outs)) return;
    console.log("Switching output to:", outs);

    if (socket.id !== sessionOwner) return;
    try {
      syncOutputs(outs);
      io.emit('output', { ids: outs });
      io.emit('status', { message: `Outputs updated` });
    } catch (e) {
      console.error("Error switching output:", e);
      io.emit('serverError', { message: `Failed to switch output: ${e.message}` });
    }
  });

  socket.on('setVolume', (data) => {
    const vol = data?.value;
    if (typeof vol !== 'number') return;
    console.log("Changing output volume to:", vol);

    if (socket.id !== sessionOwner) return;
    try {
      volume = vol;
      // Set volume on all active AirPlay devices
      activeAirPlayDevices.forEach(deviceKey => {
        try {
          airtunes.setVolume(deviceKey, volume);
        } catch (e) {
          console.error(`Error setting volume for ${deviceKey}:`, e);
        }
      });
      io.emit('volume', { value: volume });
    } catch (e) {
      console.error("Error changing volume:", e);
      io.emit('serverError', { message: `Failed to change volume: ${e.message}` });
    }
  });

  socket.on('setConfig', (data) => {
    if (socket.id !== sessionOwner) return;
    if (!data || typeof data !== 'object') return;

    console.log("Updating config:", data);
    const oldDisplayName = config.displayName;

    // Only allow known fields
    const allowedFields = ['displayName', 'defaultInputId', 'defaultOutputIds', 'defaultVolume', 'autoconnectEnabled', 'autoconnectThreshold'];
    const filtered = {};
    for (const key of allowedFields) {
      if (key in data) filtered[key] = data[key];
    }

    saveConfig(filtered);

    if (config.displayName !== oldDisplayName) {
      restartAdvertisement();
    }

    io.emit('status', { message: 'Settings saved' });
  });

  socket.on('setAutoconnect', (data) => {
    if (socket.id !== sessionOwner) return;
    const newState = data?.state;
    if (newState !== 'listening' && newState !== 'paused') return;

    console.log("Setting autoconnect state:", newState);
    setAutoconnectState(newState);
  });

  socket.on('disconnect', () => {
    console.log("Client disconnected:", socket.id);

    if (socket.id === sessionOwner) {
      sessionOwner = null;
      // If exactly one client remains, auto-assign ownership
      const remaining = io.sockets.sockets;
      if (remaining.size === 1) {
        const [onlyClient] = remaining.values();
        sessionOwner = onlyClient.id;
        console.log("Auto-assigned ownership to sole remaining client:", sessionOwner);
      }
      io.emit('session', { owner: sessionOwner });
    }
  });
});

// =======================
// 12) Start server
// =======================
let PORT = process.env.BABEL_PORT || 3000;
server.listen(PORT, () => {
  console.log("Babelpod listening on port:", PORT);
});

// =======================
// 13) Global error handlers
// =======================
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  io.emit('serverError', { message: 'Server encountered an unexpected error' });
  // Don't exit - try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  io.emit('serverError', { message: 'Server encountered an unexpected error' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log("\nShutting down gracefully...");
  cleanupCurrentInput();
  activeLocalOutputs.forEach(o => {
    try {
      o.process.kill();
    } catch (e) {
      console.error("Error killing local output:", e);
    }
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log("\nShutting down gracefully...");
  cleanupCurrentInput();
  activeLocalOutputs.forEach(o => {
    try {
      o.process.kill();
    } catch (e) {
      console.error("Error killing local output:", e);
    }
  });
  process.exit(0);
});
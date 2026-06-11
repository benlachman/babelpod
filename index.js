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
const { spawn } = require('child_process');
const fs = require('fs');
const mdns = require('mdns-js');
const dnssd = require('dnssd2');
const AirTunes = require('airtunes2');
const { hostname } = require('os');
const path = require('path');
const { parsePcmDevices, parseAirplayService, buildUnifiedOutputs, clampVolume } = require('./lib/devices');
const { SilenceAutoOff } = require('./lib/turntable');
const { MatterPlugController } = require('./lib/plugController');

// =======================
// 1a) Log level
// =======================
// LOG_LEVEL env var: debug | info | warn | error (default: info)
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;
const log = {
  debug: (...args) => { if (currentLogLevel <= LOG_LEVELS.debug) console.log(...args); },
  info: (...args) => { if (currentLogLevel <= LOG_LEVELS.info) console.log(...args); },
  warn: (...args) => { if (currentLogLevel <= LOG_LEVELS.warn) console.warn(...args); },
  error: (...args) => { if (currentLogLevel <= LOG_LEVELS.error) console.error(...args); },
};
log.info(`Log level: ${process.env.LOG_LEVEL || 'info'}`);

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
  autoconnectThreshold: 0.01,
  // Turntable smart plug (Matter). Commission once by putting the plug in
  // pairing mode from Apple Home and setting the code here; credentials then
  // persist in .matter-storage and the code is no longer needed.
  turntablePlugEnabled: false,
  turntablePlugPairingCode: null,
  // Silence auto-off: cut the plug after sustained silence (record left
  // spinning in the runout groove).
  autoOffEnabled: false,
  autoOffSilenceThresholdDb: -50,
  autoOffSilenceMinutes: 20
};

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(data);
    // Only keep known fields; drop legacy keys
    const clean = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key in parsed) clean[key] = parsed[key];
    }
    config = { ...DEFAULT_CONFIG, ...clean };
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
  // Only merge known fields to avoid polluting config with legacy keys
  const clean = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key in partial) clean[key] = partial[key];
  }
  config = { ...config, ...clean };
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
    lastInputDataTime = Date.now();

    // Skip RMS calculation when nothing consumes it (save CPU): autoconnect
    // paused and silence auto-off not armed
    if (autoconnectState.state === 'paused' && !silenceAutoOff.armed) {
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
// 4b-ii) Input stream watchdog
// =======================
// Detects stalled/dead input streams that don't produce data.
// arecord can die silently without triggering the 'exit' event,
// or the stream can break without the process exiting.
const INPUT_WATCHDOG_INTERVAL_MS = 15000; // check every 15s
const INPUT_WATCHDOG_TIMEOUT_MS = 30000;  // 30s without data = dead
let lastInputDataTime = Date.now();

setInterval(() => {
  if (currentInput === 'void') return;
  if (!arecordInstance) return;

  const silentDuration = Date.now() - lastInputDataTime;
  if (silentDuration > INPUT_WATCHDOG_TIMEOUT_MS) {
    log.error(`[watchdog] No input data for ${Math.round(silentDuration/1000)}s — exiting for systemd restart`);
    io.emit('serverError', { message: 'Input device stalled — service will restart' });
    process.exit(1);
  }
}, INPUT_WATCHDOG_INTERVAL_MS);

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

// Periodic RMS logging — helps diagnose missed triggers
let lastRmsLogTime = 0;
let maxRmsSinceLastLog = 0;
const RMS_LOG_INTERVAL_MS = 10000; // every 10 seconds

setInterval(() => {
  const mem = process.memoryUsage();
  log.debug(`[memory] rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB external=${Math.round(mem.external / 1024 / 1024)}MB`);
}, 300000);

// Smoothed RMS via exponential moving average — distinguishes sustained
// music from transient spikes like surface noise pops.
// alpha=0.15 with ~10 samples/sec ≈ 1s time constant.
let smoothedRms = 0;
const RMS_SMOOTHING_ALPHA = 0.15;

function logStateTransition(fromState, toState, rmsLevel, reason) {
  log.info(`[autoconnect] ${fromState} → ${toState} (rms=${rmsLevel.toFixed(4)}, reason=${reason})`);
}

function tickAutoconnect(rawRms) {
  const threshold = config.autoconnectThreshold || 0.002;
  const now = Date.now();

  // Smoothed RMS filters transient spikes (surface noise pops) while
  // preserving sustained signal detection (music). Used for steady-state
  // decisions; raw RMS is used for initial detection to catch transients fast.
  smoothedRms = RMS_SMOOTHING_ALPHA * rawRms + (1 - RMS_SMOOTHING_ALPHA) * smoothedRms;

  // Periodic RMS sample logging
  if (rawRms > maxRmsSinceLastLog) maxRmsSinceLastLog = rawRms;
  if (now - lastRmsLogTime >= RMS_LOG_INTERVAL_MS) {
    log.debug(`[autoconnect] state=${autoconnectState.state} threshold=${threshold} peak_raw=${maxRmsSinceLastLog.toFixed(4)} smoothed=${smoothedRms.toFixed(4)}`);
    lastRmsLogTime = now;
    maxRmsSinceLastLog = 0;
  }

  switch (autoconnectState.state) {
    case 'paused':
      return;

    case 'idle':
      // Use raw RMS — catch transient signal like needle drop immediately
      if (rawRms > threshold) {
        logStateTransition('idle', 'detecting', rawRms, `raw above threshold ${threshold}`);
        autoconnectState.state = 'detecting';
        autoconnectState.detectingSince = now;
        emitAutoconnectState();
      }
      break;

    case 'detecting':
      // Use raw RMS for sustain check — filters pops (they don't sustain 250ms)
      // but still catches sustained lead-in groove noise
      if (rawRms <= threshold) {
        const heldFor = now - autoconnectState.detectingSince;
        logStateTransition('detecting', 'idle', rawRms, `dropped after ${heldFor}ms (needed ${AUTOCONNECT_DETECT_SUSTAIN_MS}ms)`);
        autoconnectState.state = 'idle';
        autoconnectState.detectingSince = null;
        emitAutoconnectState();
      } else if (now - autoconnectState.detectingSince >= AUTOCONNECT_DETECT_SUSTAIN_MS) {
        logStateTransition('detecting', 'connected', rawRms, `sustained ${AUTOCONNECT_DETECT_SUSTAIN_MS}ms`);
        autoconnectState.state = 'connected';
        autoconnectState.detectingSince = null;
        emitAutoconnectState();
        activateDefaultOutputs();
      }
      break;

    case 'connected':
      // Use SMOOTHED RMS — don't flip to silence on brief quiet passages
      // or between-track gaps. Hysteresis: only leave when well below threshold.
      if (smoothedRms <= threshold / 4) {
        logStateTransition('connected', 'silence', smoothedRms, `smoothed below stop threshold ${(threshold/4).toFixed(4)}`);
        autoconnectState.state = 'silence';
        autoconnectState.silenceSince = now;
        emitAutoconnectState();
      }
      break;

    case 'silence':
      // Use SMOOTHED RMS — don't flip back to connected on surface noise pops.
      // Surface noise has brief spikes but low average; music is sustained.
      if (smoothedRms > threshold) {
        logStateTransition('silence', 'connected', smoothedRms, `smoothed signal returned`);
        autoconnectState.state = 'connected';
        autoconnectState.silenceSince = null;
        emitAutoconnectState();
        // If outputs were manually cleared while in silence, re-activate defaults
        if (selectedOutputs.length === 0) {
          log.info('[autoconnect] outputs were cleared during silence; re-activating defaults');
          activateDefaultOutputs();
        }
      } else if (now - autoconnectState.silenceSince >= AUTOCONNECT_SILENCE_TIMEOUT_MS) {
        const silentFor = now - autoconnectState.silenceSince;
        logStateTransition('silence', 'idle', smoothedRms, `silent for ${Math.round(silentFor/1000)}s`);
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

// Hook RMS readings into autoconnect state machine and silence auto-off
function wireRmsMonitor() {
  rmsMonitor.on('rms', tickAutoconnect);
  rmsMonitor.on('rms', rms => silenceAutoOff.handleRms(rms));
}
wireRmsMonitor();

// =======================
// 4d) Turntable smart plug & silence auto-off
// =======================
// The turntable is plugged into a Matter smart plug commissioned onto
// BabelPod's own fabric (it stays paired with Apple Home — multi-admin).
// The OnOff attribute subscription reports every hardware state change,
// including ones made from Apple Home or the plug's physical button, and
// each one is broadcast to all clients as `turntablePower`.
let plugController = null;

const silenceAutoOff = new SilenceAutoOff({
  thresholdDb: config.autoOffSilenceThresholdDb,
  durationMs: (config.autoOffSilenceMinutes || 20) * 60 * 1000,
  onTrigger: handleAutoOffTrigger
});

function buildTurntablePowerPayload() {
  return { on: plugController.isOn, reachable: plugController.isReachable };
}

function broadcastTurntablePower() {
  if (!plugController) return;
  io.emit('turntablePower', buildTurntablePowerPayload());
}

// Monitor for silence only when it can lead to an auto-off: feature enabled,
// a real input selected, and the plug actually on.
function updateAutoOffArming() {
  silenceAutoOff.configure({
    thresholdDb: config.autoOffSilenceThresholdDb,
    durationMs: (config.autoOffSilenceMinutes || 20) * 60 * 1000
  });
  const armed = !!plugController && config.autoOffEnabled &&
    currentInput !== 'void' && plugController.isOn;
  silenceAutoOff.setArmed(armed);
}

function handleAutoOffTrigger() {
  const minutes = config.autoOffSilenceMinutes || 20;
  log.info(`[auto-off] ${minutes} min of silence — powering turntable off`);
  io.emit('status', { message: `Turntable powered off after ${minutes} min of silence` });
  applyTurntablePower(false);
}

// Shared control core for turntable power. Socket.IO handlers gate on session
// ownership before calling this; internal automation (silence auto-off) calls
// it directly — the privileged channel that bypasses the owner lock without
// touching session ownership. The resulting `turntablePower` broadcast comes
// from the OnOff subscription, never synthesized from the command, so clients
// always see the real hardware state (self-correcting on failed commands).
function applyTurntablePower(on) {
  if (!plugController) {
    io.emit('serverError', { message: 'No turntable plug configured' });
    return;
  }
  if (!plugController.isReachable) {
    io.emit('serverError', { message: 'Turntable plug is unreachable' });
    broadcastTurntablePower();
    return;
  }
  plugController.setPower(on).catch(e => {
    console.error("Error setting turntable plug power:", e);
    io.emit('serverError', { message: `Turntable plug error: ${e.message}` });
    broadcastTurntablePower();
  });
}

async function startTurntablePlug() {
  if (!config.turntablePlugEnabled) return;

  plugController = new MatterPlugController({
    pairingCode: config.turntablePlugPairingCode,
    storagePath: path.join(__dirname, '.matter-storage'),
    log
  });

  plugController.on('change', ({ on, reachable }) => {
    log.info(`[plug] state changed: on=${on} reachable=${reachable}`);
    if (on) silenceAutoOff.reset(); // power restored — start a fresh silence window
    updateAutoOffArming();
    broadcastTurntablePower();
  });

  try {
    await plugController.start();
    log.info(`[plug] connected: on=${plugController.isOn} reachable=${plugController.isReachable}`);
    updateAutoOffArming();
    broadcastTurntablePower();
  } catch (e) {
    // Keep the controller so clients see the capability with reachable: false
    console.error("Turntable plug setup failed:", e.message);
    io.emit('serverError', { message: `Turntable plug setup failed: ${e.message}` });
    broadcastTurntablePower();
  }
}
startTurntablePlug();

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
let inputGeneration = 0;
const CLEANUP_DELAY = 500;

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
    if (rmsMonitor) {
      rmsMonitor.unpipe(duplicator);
      rmsMonitor.removeAllListeners('rms');
    }
    if (arecordInstance) {
      try {
        arecordInstance.kill('SIGTERM');
        const instance = arecordInstance;
        setTimeout(() => {
          if (instance && !instance.killed) {
            log.warn('arecord did not terminate gracefully, force killing...');
            instance.kill('SIGKILL');
          }
        }, 2000);
      } catch (e) {
        console.error("Error killing arecord instance:", e);
      }
      arecordInstance = null;
    }
  } catch (e) {
    console.error("Error cleaning up input:", e);
  }
}

// Start arecord for a specific device
function startArecordForDevice(devId, isRetry = false) {
  if (devId === "void") return;

  const generation = ++inputGeneration;

  try {
    console.log(`Starting arecord for device: ${devId}${isRetry ? ' (retry)' : ''}`);

    arecordInstance = spawn("arecord", [
      "-D", devId, "-t", "raw", "-c", "2", "-f", "S16_LE", "-r", "44100", "--buffer-size=131072"
    ]);

    inputStream = arecordInstance.stdout;
    inputStream.on('error', (error) => {
      console.error(`Error with input stream for ${devId}:`, error);
    });
    rmsMonitor = new RmsMonitorTransform();
    wireRmsMonitor();
    rmsMonitor.pipe(duplicator);
    inputStream.pipe(rmsMonitor);

    setupArecordHandlers(devId, generation);

    io.emit('input', { id: currentInput });
    io.emit('status', { message: `Input ${isRetry ? 'reconnected' : 'switched'} to ${currentInput}` });
    console.log(`Successfully started arecord for device: ${devId}`);
  } catch (e) {
    console.error(`Failed to start arecord for device ${devId}:`, e);
    io.emit('serverError', { message: `Failed to start input: ${e.message}` });
  }
}

function exitForRestart(devId, reason) {
  log.error(`arecord failed for ${devId} (${reason}) — exiting for systemd restart`);
  io.emit('serverError', { message: `Input device failed — service will restart` });
  process.exit(1);
}

// Setup arecord process event handlers — tagged with generation so stale handlers are no-ops
function setupArecordHandlers(devId, generation) {
  if (!arecordInstance) return;

  arecordInstance.on('error', (error) => {
    if (generation !== inputGeneration) return;
    console.error(`Error with arecord process for ${devId}:`, error);
    io.emit('serverError', { message: `Input device error: ${error.message}` });
  });

  arecordInstance.stderr.on('data', (data) => {
    if (generation !== inputGeneration) return;
    const msg = data.toString();
    console.error(`arecord stderr for ${devId}:`, msg);

    if (msg.includes('Device or resource busy') || msg.includes('audio open error')) {
      log.warn(`Device busy for ${devId} — exit handler will schedule retry`);
      return;
    }

    if (msg.includes('error') || msg.includes('failed')) {
      io.emit('serverError', { message: `Input error: ${msg.substring(0, 100)}` });
    }
  });

  arecordInstance.on('exit', (code, signal) => {
    if (generation !== inputGeneration) {
      log.debug(`Ignoring stale exit handler for ${devId} (generation ${generation}, current ${inputGeneration})`);
      return;
    }
    console.log(`arecord exited for ${devId} - code: ${code}, signal: ${signal}`);

    if (currentInput !== devId) return;

    exitForRestart(devId, `code=${code} signal=${signal}`);
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
    const { outputs, inputs } = parsePcmDevices(text);
    availablePcmOutputs = outputs;
    availablePcmInputs = inputs;
  } catch (e) {
    console.error("Error scanning /proc/asound/pcm:", e);
    // Don't crash - just log and continue with empty lists
  }
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
  const state = {
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
  // Capability signaling: present only when a plug is configured — clients
  // show the turntable power control based on this field's presence
  if (plugController) {
    state.turntablePower = buildTurntablePowerPayload();
  }
  return state;
}

// Emit updates to clients
function updateAllOutputs() {
  unifiedOutputs = buildUnifiedOutputs(availablePcmOutputs, availableAirplayOutputs);
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
  unifiedOutputs = buildUnifiedOutputs(availablePcmOutputs, availableAirplayOutputs);
  // Auto-select input on startup: prefer config default, then first available
  if (currentInput === "void" && availablePcmInputs.length > 0) {
    const configuredInput = config.defaultInputId && availablePcmInputs.some(d => d.id === config.defaultInputId)
      ? config.defaultInputId
      : availablePcmInputs[0].id;
    console.log("Auto-selecting input:", configuredInput);
    cleanupCurrentInput();
    currentInput = configuredInput;
    startArecordForDevice(configuredInput, false);
  }
  // Rescan periodically and notify clients when devices appear or disappear
  setInterval(() => {
    const before = JSON.stringify([availablePcmInputs, availablePcmOutputs]);
    scanPcmDevices();
    if (JSON.stringify([availablePcmInputs, availablePcmOutputs]) !== before) {
      updateAllInputs();
      updateAllOutputs();
    }
  }, 10000);
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

// serviceUp and serviceChanged share the same upsert logic; only notify
// clients when the device list actually changed.
function upsertAirplayDevice(data, eventName) {
  try {
    const service = parseAirplayService(data);
    if (!service) return;
    const existing = availableAirplayOutputs.find(o => o.host === service.host && o.port === service.port);
    if (!existing) {
      availableAirplayOutputs.push(service);
      console.log(`AirPlay device discovered: ${service.name} at ${service.host}:${service.port}`);
      updateAllOutputs();
    } else if (existing.name !== service.name || existing.stereo !== service.stereo) {
      existing.name = service.name;
      existing.stereo = service.stereo;
      console.log(`AirPlay device updated: ${service.name} at ${service.host}:${service.port}`);
      updateAllOutputs();
    }
  } catch (e) {
    console.error(`Error processing mDNS ${eventName}:`, e);
  }
}

browser.on('serviceUp', data => upsertAirplayDevice(data, 'serviceUp'));
browser.on('serviceChanged', data => upsertAirplayDevice(data, 'serviceChanged'));

browser.on('serviceDown', data => {
  try {
    const service = parseAirplayService(data);
    if (!service) return;
    const { name, host, port } = service;
    const beforeCount = availableAirplayOutputs.length;
    availableAirplayOutputs = availableAirplayOutputs.filter(
      o => !(o.host === host && o.port === port)
    );
    if (availableAirplayOutputs.length < beforeCount) {
      console.log(`AirPlay device removed: ${name} at ${host}:${port}`);

      // Stop streaming to the removed device
      const deviceKey = `${host}:${port}`;
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
      cleanupCurrentInput();
      currentInput = devId;
      updateAutoOffArming();

      if (devId === "void") {
        inputGeneration++;
        inputStream = new FromVoid();
        rmsMonitor = new RmsMonitorTransform();
        wireRmsMonitor();
        rmsMonitor.pipe(duplicator);
        inputStream.pipe(rmsMonitor);
        io.emit('input', { id: currentInput });
        io.emit('status', { message: `Input switched to ${currentInput}` });
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
    if (typeof vol !== 'number' || !Number.isFinite(vol)) return;
    console.log("Changing output volume to:", vol);

    if (socket.id !== sessionOwner) return;
    try {
      volume = clampVolume(vol);
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
    const allowedFields = [
      'displayName', 'defaultInputId', 'defaultOutputIds', 'defaultVolume',
      'autoconnectEnabled', 'autoconnectThreshold',
      'autoOffEnabled', 'autoOffSilenceThresholdDb', 'autoOffSilenceMinutes'
    ];
    const filtered = {};
    for (const key of allowedFields) {
      if (key in data) filtered[key] = data[key];
    }

    saveConfig(filtered);
    updateAutoOffArming();

    if (config.displayName !== oldDisplayName) {
      restartAdvertisement();
    }

    io.emit('status', { message: 'Settings saved' });
  });

  socket.on('setTurntablePower', (data) => {
    const on = data?.on;
    if (typeof on !== 'boolean') return;
    if (socket.id !== sessionOwner) return;

    console.log("Setting turntable power:", on);
    applyTurntablePower(on);
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
  try {
    io.emit('serverError', { message: 'Server encountered an unexpected error — restarting' });
  } catch (e) { /* socket may be dead */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  io.emit('serverError', { message: 'Server encountered an unexpected error' });
});

// Graceful shutdown
function shutdownGracefully() {
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
}

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);
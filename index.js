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
inputStream.pipe(duplicator);

// Clean up current input, stop processes
function cleanupCurrentInput() {
  try {
    if (inputStream) {
      inputStream.unpipe(duplicator);
    }
    if (arecordInstance) {
      try {
        // Try graceful termination first
        arecordInstance.kill('SIGTERM');
        // If process doesn't die, force kill after a short delay
        setTimeout(() => {
          if (arecordInstance && !arecordInstance.killed) {
            console.log('arecord did not terminate gracefully, force killing...');
            arecordInstance.kill('SIGKILL');
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
    // Use pkill to find and kill any arecord processes using this device
    // First, try to find if there are any arecord processes for this device
    try {
      const result = execSync(`pgrep -f "arecord.*${devId}"`, { encoding: 'utf8' }).trim();
      if (result) {
        console.log(`Found orphaned arecord processes for ${devId}, terminating: ${result}`);
        // Kill them with SIGKILL to ensure they die
        execSync(`pkill -9 -f "arecord.*${devId}"`);
        console.log(`Killed orphaned arecord processes for ${devId}`);
      }
    } catch (e) {
      // pgrep returns non-zero exit code if no processes found, which is fine
      if (e.status !== 1) {
        console.error(`Error checking for orphaned arecord processes: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`Error in killOrphanedArecord: ${e.message}`);
  }
}

// Start arecord for a specific device
function startArecordForDevice(devId, isRetry = false) {
  if (devId === "void") return;
  
  try {
    console.log(`Starting arecord for device: ${devId}${isRetry ? ' (retry)' : ''}`);
    
    // Kill any orphaned arecord processes before starting a new one
    killOrphanedArecord(devId);
    
    arecordInstance = spawn("arecord", [
      "-D", devId,
      "-c", "2",
      "-f", "S16_LE",
      "-r", "44100"
    ]);
    
    setupArecordHandlers(devId, isRetry);
    
    inputStream = arecordInstance.stdout;
    inputStream.on('error', (error) => {
      console.error(`Error with input stream for ${devId}:`, error);
    });
    inputStream.pipe(duplicator);
    
    if (!isRetry) {
      // Only reset busy retry counter on initial start (not retries)
      busyRetryAttempts = 0;
      io.emit('switched_input', currentInput);
      io.emit('server_status', { message: `Input switched to ${currentInput}` });
    } else {
      // On successful retry, emit success message
      io.emit('switched_input', currentInput);
      io.emit('server_status', { message: `Input successfully connected to ${currentInput}` });
      busyRetryAttempts = 0; // Reset on success
      isManualInputSwitch = false;
    }
    
    console.log(`Successfully started arecord for device: ${devId}`);
  } catch (e) {
    console.error(`Failed to start arecord for device ${devId}:`, e);
    io.emit('server_error', { message: `Failed to start input: ${e.message}` });
  }
}

// Restart input device (for automatic recovery)
function restartInputDevice(devId, delayMs = 0) {
  if (devId === "void") return;
  
  setTimeout(() => {
    console.log(`Attempting to restart input device: ${devId} (attempt ${inputRestartAttempts + 1}/${MAX_INPUT_RESTART_ATTEMPTS})`);
    
    try {
      cleanupCurrentInput();
      
      // Add delay to ensure cleanup completes
      setTimeout(() => {
        startArecordForDevice(devId, false);
        inputRestartAttempts++;
        io.emit('server_status', { message: `Input device reconnected: ${devId}` });
      }, CLEANUP_DELAY);
    } catch (e) {
      console.error(`Failed to restart input device ${devId}:`, e);
      io.emit('server_error', { message: `Failed to reconnect input: ${e.message}` });
    }
  }, delayMs);
}

// Setup arecord process event handlers
function setupArecordHandlers(devId, isRetry = false) {
  if (!arecordInstance) return;
  
  let stderrBuffer = '';
  
  arecordInstance.on('error', (error) => {
    console.error(`Error with arecord process for ${devId}:`, error);
    io.emit('server_error', { message: `Input device error: ${error.message}` });
  });
  
  arecordInstance.stderr.on('data', (data) => {
    const msg = data.toString();
    stderrBuffer += msg;
    console.error(`arecord stderr for ${devId}:`, msg);
    
    // Check for "Device or resource busy" error
    if (msg.includes('Device or resource busy') || msg.includes('audio open error')) {
      console.log(`Device busy detected for ${devId}, will retry after cleanup`);
      // Don't emit error to UI yet, we'll retry
      return;
    }
    
    // Only report critical errors to UI (excluding busy errors which we'll handle with retry)
    if (msg.includes('error') || msg.includes('failed')) {
      io.emit('server_error', { message: `Input error: ${msg.substring(0, 100)}` });
    }
  });
  
  arecordInstance.on('exit', (code, signal) => {
    console.log(`arecord exited for ${devId} - code: ${code}, signal: ${signal}, manual: ${isManualInputSwitch}`);
    
    // Check if exit was due to "Device or resource busy" error
    const isBusyError = stderrBuffer.includes('Device or resource busy') || 
                       stderrBuffer.includes('audio open error');
    
    if (isBusyError && isManualInputSwitch && busyRetryAttempts < MAX_BUSY_RETRY_ATTEMPTS) {
      // Device is busy, retry with exponential backoff
      busyRetryAttempts++;
      const retryDelay = BUSY_RETRY_BASE_DELAY * Math.pow(2, busyRetryAttempts - 1);
      console.log(`Device busy, retrying in ${retryDelay}ms (attempt ${busyRetryAttempts}/${MAX_BUSY_RETRY_ATTEMPTS})`);
      io.emit('server_status', { message: `Device busy, retrying... (${busyRetryAttempts}/${MAX_BUSY_RETRY_ATTEMPTS})` });
      
      setTimeout(() => {
        startArecordForDevice(devId, true);
      }, retryDelay);
      return;
    }
    
    // Reset busy retry counter on successful start or max retries reached
    if (isBusyError && busyRetryAttempts >= MAX_BUSY_RETRY_ATTEMPTS) {
      console.error(`Max busy retry attempts (${MAX_BUSY_RETRY_ATTEMPTS}) reached for ${devId}`);
      io.emit('server_error', { message: `Device is busy and could not be opened after ${MAX_BUSY_RETRY_ATTEMPTS} attempts. Please try again later.` });
      busyRetryAttempts = 0;
      isManualInputSwitch = false;
      return;
    }
    
    // Only attempt restart if:
    // 1. Exit was unexpected (non-zero code or killed by signal)
    // 2. It wasn't a manual input switch
    // 3. We haven't exceeded retry attempts
    // 4. The current input is still this device
    if (!isManualInputSwitch && currentInput === devId) {
      if (code !== 0 || signal) {
        console.error(`arecord exited unexpectedly with code ${code}, signal ${signal} for ${devId}`);
        io.emit('server_error', { message: `Input device disconnected - attempting to reconnect...` });
        
        if (inputRestartAttempts < MAX_INPUT_RESTART_ATTEMPTS) {
          restartInputDevice(devId, INPUT_RESTART_DELAY);
        } else {
          console.error(`Max restart attempts (${MAX_INPUT_RESTART_ATTEMPTS}) reached for ${devId}`);
          io.emit('server_error', { message: `Input device failed after ${MAX_INPUT_RESTART_ATTEMPTS} reconnection attempts. Please reselect the input.` });
          inputRestartAttempts = 0; // Reset for next manual selection
        }
      }
    }
    
    // Reset flag after handling exit
    if (isManualInputSwitch) {
      isManualInputSwitch = false;
      busyRetryAttempts = 0; // Reset busy retry counter
    }
  });
}

// =======================
// 7) Volume & outputs
// =======================
let volume = 50;
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
      const devName = parts[2].trim();
      const devId = "plughw:" + parts[0].split("-").map(x => parseInt(x, 10)).join(",");
      return {
        id: devId,
        name: devName,
        output: parts.some(t => t.includes("playback")),
        input: parts.some(t => t.includes("capture"))
      };
    });
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
    name: o.name + ' (Output)',
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
        name: (d.name || d.host) + ' (AirPlay)',
        isStereo: false,
        devices: [{ host: d.host, port: d.port, isStereo: false }]
      });
    } else {
      air.push({
        uiId: 'airpair:' + stereoName,
        name: stereoName + ' (AirPlay Stereo)',
        isStereo: true,
        devices: arr.map(d => ({ host: d.host, port: d.port, isStereo: true }))
      });
    }
  }
  return local.concat(air);
}

// Emit updates to clients
function updateAllOutputs() {
  unifiedOutputs = buildUnifiedOutputs();
  io.emit('available_outputs', unifiedOutputs);
}
function updateAllInputs() {
  const defInputs = [{ name: 'None', id: 'void' }];
  const finalIn = defInputs.concat(availablePcmInputs, availableBluetoothInputs);
  io.emit('available_inputs', finalIn);
}

// Initial device scan - PCM enabled by default
// Set DISABLE_PCM=1 to disable PCM input/output device scanning for better performance
if (!process.env.DISABLE_PCM) {
  console.log("PCM device scanning enabled");
  scanPcmDevices();
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
    if (!data.fullname) return;
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
    if (!data.fullname) return;
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
    if (!data.fullname) return;
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
        updateAllOutputs();
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
    // use random port if needed, otherwise use 3000
    const p = Number(process.env.BABEL_PORT || 3000);
    advertise = mdns.createAdvertisement(mdns.tcp('babelpod'), p, {
      name: hostname().replace('.local', ''),
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
            io.emit('server_error', { message: `Local output error: ${error.message}` });
          });
          
          child.stderr.on('data', (data) => {
            console.error(`aplay stderr for ${aid}:`, data.toString());
          });
          
          child.on('exit', (code, signal) => {
            if (code !== 0 && code !== null) {
              console.error(`aplay exited with code ${code} for ${aid}`);
            }
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
                io.emit('server_error', { message: `AirPlay error: ${e.message}` });
              }
            }
          });
        }
      } catch (e) {
        console.error(`Error adding output ${aid}:`, e);
        io.emit('server_error', { message: `Error adding output: ${e.message}` });
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
    io.emit('server_error', { message: `Output sync error: ${e.message}` });
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

  if (sessionOwner && sessionOwner !== socket.id) {
    io.to(sessionOwner).emit('sessionLostControl');
    sessionOwner = socket.id;
  } else if (!sessionOwner) {
    sessionOwner = socket.id;
  }
  socket.emit('sessionOwnerUpdate', sessionOwner);

  socket.on('user_takeover', () => {
    console.log("User takeover:", socket.id);

    if (sessionOwner !== socket.id) {
      if (sessionOwner) {
        io.to(sessionOwner).emit('sessionLostControl');
      }
      sessionOwner = socket.id;
      io.emit('sessionOwnerUpdate', sessionOwner);
    }
  });

  updateAllInputs();
  updateAllOutputs();
  socket.emit('switched_input', currentInput);
  socket.emit('switched_output', selectedOutputs);
  socket.emit('changed_output_volume', volume);

  socket.on('switch_input', (devId) => {
    console.log("Switching input to:", devId);

    if (socket.id !== sessionOwner) return;
    
    try {
      // Mark this as a manual switch to prevent auto-restart
      isManualInputSwitch = true;
      inputRestartAttempts = 0; // Reset restart counter on manual switch
      busyRetryAttempts = 0; // Reset busy retry counter on new manual switch
      
      cleanupCurrentInput();
      currentInput = devId;
      
      if (devId === "void") {
        inputStream = new FromVoid();
        inputStream.pipe(duplicator);
        io.emit('switched_input', currentInput);
        io.emit('server_status', { message: `Input switched to ${currentInput}` });
        isManualInputSwitch = false; // Reset immediately for void input
      } else if (devId.includes('bluealsa') && blue) {
        // Handle Bluetooth input
        const btDevice = availableBluetoothInputs.find(d => d.id === devId);
        if (btDevice && !btDevice.connected) {
          // Connect to Bluetooth device if not connected
          io.emit('server_status', { message: `Connecting to Bluetooth device ${btDevice.name}...` });
          try {
            blue.connect(btDevice.mac);
            // Wait for connection before starting arecord
            setTimeout(() => {
              if (blue.info) {
                blue.info(btDevice.mac);
              }
              // Add cleanup delay before starting
              setTimeout(() => {
                startArecordForDevice(devId, false);
              }, CLEANUP_DELAY);
            }, 5000); // 5 second delay for BT connection
            return; // Exit early, will emit after timeout
          } catch (e) {
            console.error("Error connecting to Bluetooth device:", e);
            io.emit('server_error', { message: `Failed to connect to Bluetooth: ${e.message}` });
            isManualInputSwitch = false;
          }
        } else {
          // Already connected, add cleanup delay before starting arecord
          setTimeout(() => {
            startArecordForDevice(devId, false);
          }, CLEANUP_DELAY);
        }
      } else {
        // Regular PCM input - add cleanup delay before starting arecord
        setTimeout(() => {
          startArecordForDevice(devId, false);
        }, CLEANUP_DELAY);
      }
      
    } catch (e) {
      console.error("Error switching input:", e);
      io.emit('server_error', { message: `Failed to switch input: ${e.message}` });
      isManualInputSwitch = false;
    }
  });

  socket.on('switch_output', (outs) => {
    console.log("Switching output to:", outs);

    if (socket.id !== sessionOwner) return;
    try {
      if (!Array.isArray(outs)) outs = [outs];
      syncOutputs(outs);
      io.emit('switched_output', outs);
      io.emit('server_status', { message: `Outputs updated` });
    } catch (e) {
      console.error("Error switching output:", e);
      io.emit('server_error', { message: `Failed to switch output: ${e.message}` });
    }
  });

  socket.on('change_output_volume', (vol) => {
    console.log("Changing output volume to:", vol);

    if (socket.id !== sessionOwner) return;
    try {
      volume = Number(vol) || 0;
      // Set volume on all active AirPlay devices
      activeAirPlayDevices.forEach(deviceKey => {
        try {
          airtunes.setVolume(deviceKey, volume);
        } catch (e) {
          console.error(`Error setting volume for ${deviceKey}:`, e);
        }
      });
      io.emit('changed_output_volume', volume);
    } catch (e) {
      console.error("Error changing volume:", e);
      io.emit('server_error', { message: `Failed to change volume: ${e.message}` });
    }
  });

  socket.on('disconnect', () => {
    console.log("Client disconnected:", socket.id);

    if (socket.id === sessionOwner) {
      sessionOwner = null;
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
  io.emit('server_error', { message: 'Server encountered an unexpected error' });
  // Don't exit - try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  io.emit('server_error', { message: 'Server encountered an unexpected error' });
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
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
const spawn = require('child_process').spawn;
const fs = require('fs');
const mdns = require('mdns-js');
const AirTunes = require('airtunes2');
const { hostname } = require('os');

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
duplicator.pipe(airtunes).on('error', e => {
  console.log("AirTunes piping error:", e);
});

// =======================
// 6) Current audio input
// =======================
let currentInput = "void";
let arecordInstance = null;

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
  if (inputStream) {
    inputStream.unpipe(duplicator);
  }
  if (arecordInstance) {
    arecordInstance.kill();
    arecordInstance = null;
  }
}

// =======================
// 7) Volume & outputs
// =======================
let volume = 50;
let selectedOutputs = [];

let availablePcmOutputs = [];
let availablePcmInputs = [];
let availableBluetoothInputs = [];
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
    console.log("Error scanning /proc/asound/pcm:", e);
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

// Initial device scan
scanPcmDevices();
setInterval(scanPcmDevices, 10000);

// =======================
// 8) AirPlay + BabelPod Discovery
// =======================
let browser = mdns.createBrowser(mdns.tcp('airplay'));
browser.on('ready', () => {
  browser.discover();
});
browser.on('update', data => {
  if (!data.fullname) return;
  const match = /(.*)\._airplay\._tcp\.local/.exec(data.fullname);
  if (match && match.length > 1) {
    const address = data.addresses[0];
    const port = data.port;
    const st = data.txt.find(t => t.startsWith('gpn='))?.slice(4) || null;
    if (!availableAirplayOutputs.some(o => o.host === address && o.port === port)) {
      availableAirplayOutputs.push({
        name: match[1],
        stereo: st,
        host: address,
        port
      });
      updateAllOutputs();
    }
  }
});

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
  const old = selectedOutputs.slice();
  selectedOutputs = newSelected.slice();

  const removed = old.filter(r => !selectedOutputs.includes(r));
  const added = selectedOutputs.filter(a => !old.includes(a));

  // Remove old outputs
  removed.forEach(rid => {
    if (rid.startsWith("plughw:")) {
      for (let i = activeLocalOutputs.length - 1; i >= 0; i--) {
        if (activeLocalOutputs[i].id === rid) {
          const p = activeLocalOutputs[i];
          duplicator.unpipe(p.process.stdin);
          p.process.kill();
          activeLocalOutputs.splice(i, 1);
        }
      }
    } else if (rid.startsWith("air:") || rid.startsWith("airpair:")) {
      const ud = unifiedOutputs.find(u => u.uiId === rid);
      if (ud) {
        ud.devices.forEach(d => {
          if (d.host && d.port) {
            airtunes.stop(`${d.host}:${d.port}`);
          }
        });
      }
    }
  });

  // Add new outputs
  added.forEach(aid => {
    if (aid === "void") return;
    if (aid.startsWith("plughw:")) {
      const child = spawn("aplay", [
        "-D", aid,
        "-c", "2",
        "-f", "S16_LE",
        "-r", "44100"
      ]);
      duplicator.pipe(child.stdin);
      activeLocalOutputs.push({ id: aid, process: child });
    } else if (aid.startsWith("air:") || aid.startsWith("airpair:")) {
      const ud = unifiedOutputs.find(u => u.uiId === aid);
      if (!ud) return;
      ud.devices.forEach(device => {
        if (device.host && device.port) {
          airtunes.add(device.host, {
            port: device.port,
            volume,
            stereo: !!device.isStereo
          });
        }
      });
    }
  });
  airtunes.setVolume("all", volume);
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
    cleanupCurrentInput();
    currentInput = devId;
    if (devId === "void") {
      inputStream = new FromVoid();
      inputStream.pipe(duplicator);
    } else {
      arecordInstance = spawn("arecord", [
        "-D", devId,
        "-c", "2",
        "-f", "S16_LE",
        "-r", "44100"
      ]);
      inputStream = arecordInstance.stdout;
      inputStream.pipe(duplicator);
    }
    io.emit('switched_input', currentInput);
  });

  socket.on('switch_output', (outs) => {
    console.log("Switching output to:", outs);

    if (socket.id !== sessionOwner) return;
    if (!Array.isArray(outs)) outs = [outs];
    syncOutputs(outs);
    io.emit('switched_output', outs);
  });

  socket.on('change_output_volume', (vol) => {
    console.log("Changing output volume to:", vol);

    if (socket.id !== sessionOwner) return;
    volume = Number(vol) || 0;
    airtunes.setVolume("all", volume);
    io.emit('changed_output_volume', volume);
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
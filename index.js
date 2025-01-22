/*
 Babelpod index.js
 => Now actually pipes input data to each selected output.
 => We use a PassThrough "duplicator" to broadcast to multiple outputs:
    - A single global AirTunes instance for all AirPlay devices.
    - Child processes (aplay) for local outputs.

 If no outputs are selected, we pipe to fallback /dev/null so data is discarded.

 This code is only a demonstration. Customize as needed.
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const stream = require('stream');
const util = require('util');
const spawn = require('child_process').spawn;
const fs = require('fs');
const mdns = require('mdns-js');
const AirTunes = require('airtunes2');

// Express + Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

//////////////////////////////////////////////////////////
// 1) A single AirTunes instance for all AirPlay outputs
const airtunes = new AirTunes();

/** We'll also keep track of local child process output streams. */
let activeLocalOutputs = []; // array of { id, process, piped: boolean }

/** For discard if no outputs */
util.inherits(DiscardSink, stream.Writable);
function DiscardSink() {
  if (!(this instanceof DiscardSink)) return new DiscardSink();
  stream.Writable.call(this);
}
DiscardSink.prototype._write = function (_chunk, _enc, cb) { cb(); };

// Our fallback sink if zero outputs are selected
let fallbackSink = new DiscardSink();

// We have a "duplicator" pass-through to pipe input to multiple outputs
let duplicator = new stream.PassThrough({ highWaterMark: 65536 });

// Always pipe duplicator -> fallback (discard)
duplicator.pipe(fallbackSink).on('error', e => {
  console.log("error piping to fallbackDiscard:", e);
});

// Also pipe duplicator -> AirTunes. If no AirTunes devices are added, it just won't do anything.
duplicator.pipe(airtunes).on('error', e => {
  console.log("error piping to AirTunes:", e);
});

//////////////////////////////////////////////////////////
// Current input (arecord) management
let currentInput = "void";
let arecordInstance = null;

// The inputStream we read from => duplicator
// We default to a "FromVoid" so there's no data if none
util.inherits(FromVoid, stream.Readable);
function FromVoid() {
  if (!(this instanceof FromVoid)) return new FromVoid();
  stream.Readable.call(this);
}
FromVoid.prototype._read = function () { };

let inputStream = new FromVoid();
// pipe input -> duplicator
inputStream.pipe(duplicator).on('error', err => {
  console.log("Error piping input->duplicator:", err);
});

/** Cleans up the old input (arecord) if any, unpipes from duplicator. */
function cleanupCurrentInput() {
  if (inputStream) {
    inputStream.unpipe(duplicator);
  }
  if (arecordInstance) {
    arecordInstance.kill();
    arecordInstance = null;
  }
}

//////////////////////////////////////////////////////////
// Track volume (0..100)
let volume = 50;

// For multiple outputs, we keep a "selectedOutputs" array of string IDs
let selectedOutputs = [];

// We'll define these from scanning: local (PCM) + airplay
let availablePcmOutputs = [];
let availablePcmInputs = [];
let availableBluetoothInputs = [];
let availableAirplayOutputs = [];

/** We also unify them for the UI: each item => { uiId, name, isStereo, devices[...] } or local. */
let unifiedOutputs = [];

//////////////////////////////////////////////////////////
// PCM scanning
function scanPcmDevices() {
  try {
    let text = fs.readFileSync('/proc/asound/pcm', 'utf8');
    let lines = text.split('\n').filter(l => l.trim() !== '');
    let all = lines.map(line => {
      let parts = line.split(':');
      let devName = parts[2].trim();
      let devId = "plughw:" + parts[0].split("-").map(x => parseInt(x, 10)).join(",");
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
    console.log("Could not scan /proc/asound/pcm:", e);
  }
}

// We'll unify them into "unifiedOutputs" for the UI
function buildUnifiedOutputs() {
  // local
  let local = availablePcmOutputs.map(o => {
    return {
      uiId: o.id,
      name: 'Local: ' + o.name,
      isStereo: false,
      devices: [{ localId: o.id }]
    };
  });

  // group airplay by stereo name
  let grouped = {};
  for (let dev of availableAirplayOutputs) {
    let st = dev.stereo || dev.host + ":" + dev.port;
    if (!grouped[st]) grouped[st] = [];
    grouped[st].push(dev);
  }
  let airplayMerged = [];
  for (let stereoName in grouped) {
    let arr = grouped[stereoName];
    if (arr.length === 1) {
      // single
      let d = arr[0];
      airplayMerged.push({
        uiId: 'air:' + d.host + ':' + d.port,
        name: 'Air: ' + (d.name || 'Device'),
        isStereo: false,
        devices: [{ host: d.host, port: d.port, isStereo: false }]
      });
    } else {
      // multiple => treat as stereo
      airplayMerged.push({
        uiId: 'airpair:' + stereoName,
        name: 'AirPair: ' + stereoName,
        isStereo: true,
        devices: arr.map(d => ({
          host: d.host, port: d.port, isStereo: true
        }))
      });
    }
  }
  return local.concat(airplayMerged);
}

function updateAllOutputs() {
  unifiedOutputs = buildUnifiedOutputs();
  io.emit('available_outputs', unifiedOutputs);
}

function updateAllInputs() {
  let defIn = [{ name: 'None', id: 'void' }];
  let final = defIn.concat(availablePcmInputs, availableBluetoothInputs);
  io.emit('available_inputs', final);
}

scanPcmDevices();
setInterval(scanPcmDevices, 10000);
//////////////////////////////////////////////////////////
// mdns for airplay
let browser = mdns.createBrowser(mdns.tcp('airplay'));
browser.on('ready', () => {
  browser.discover();
});
browser.on('update', data => {
  if (!data.fullname) return;
  let reg = /(.*)\._airplay\._tcp\.local/;
  let m = reg.exec(data.fullname);
  if (m && m.length > 1) {
    let address = data.addresses[0];
    let port = data.port;
    let exId = "air_" + address + "_" + port;
    if (!availableAirplayOutputs.find(d => d.host === address && d.port === port)) {
      let stName = null;
      data.txt.forEach(t => {
        if (t.startsWith("gpn=")) stName = t.substring(4);
      });
      availableAirplayOutputs.push({
        name: m[1],
        stereo: stName,
        host: address,
        port: port
      });
      updateAllOutputs();
    }
  }
});

//////////////////////////////////////////////////////////
// “syncOutputs” => add or remove outputs from the duplicator
// For local => spawn aplay and pipe duplicator -> child.stdin
// For airplay => call airtunes.add(...) or airtunes.stop(...) in that single global instance
// stored in activeLocalOutputs or airtunes devices.

function syncOutputs(newSelected) {
  let old = selectedOutputs.slice();
  selectedOutputs = newSelected.slice();

  // find removed
  let removed = old.filter(r => !selectedOutputs.includes(r));
  let added = selectedOutputs.filter(a => !old.includes(a));

  // remove local aplay for each removed
  removed.forEach(rid => {
    // local or air?
    if (rid.startsWith("plughw:")) {
      // find it
      for (let i = activeLocalOutputs.length - 1; i >= 0; i--) {
        if (activeLocalOutputs[i].id === rid) {
          let p = activeLocalOutputs[i];
          try {
            duplicator.unpipe(p.process.stdin);
          } catch (e) { }
          try {
            p.process.kill();
          } catch (e) { }
          activeLocalOutputs.splice(i, 1);
        }
      }
    } else if (rid.startsWith("air:") || rid.startsWith("airpair:")) {
      // find the unified device
      let ud = unifiedOutputs.find(u => u.uiId === rid);
      if (ud) {
        // for each sub device => call airtunes.stop
        ud.devices.forEach(sub => {
          if (sub.host && sub.port) {
            // key?
            let key = sub.host + ":" + sub.port;
            airtunes.stop(key);
          }
        });
      }
    }
  });

  // add local aplay or air
  added.forEach(aid => {
    if (aid === "void") return; // ignore
    if (aid.startsWith("plughw:")) {
      // local
      let child = spawn("aplay", [
        '-D', aid,
        '-c', '2',
        '-f', 'S16_LE',
        '-r', '44100'
      ]);
      duplicator.pipe(child.stdin).on('error', e => {
        console.log("Error piping to local aplay for", aid, e);
      });
      activeLocalOutputs.push({ id: aid, process: child });
    } else if (aid.startsWith("air:") || aid.startsWith("airpair:")) {
      // air
      let ud = unifiedOutputs.find(u => u.uiId === aid);
      if (!ud) return;
      // add each device
      ud.devices.forEach(sub => {
        if (sub.host && sub.port) {
          airtunes.add(sub.host, {
            port: sub.port,
            volume,
            stereo: !!sub.isStereo,
            debug: false
          }).on('status', st => {
            console.log("air device =>", st);
          });
        }
      });
    }
  });

  // fallback => if user selected zero real outputs, ensure fallback is still piped
  // which is always the case since duplicator->fallback is set. no changes needed.

  // set volume on all air devices
  // (the new ones got volume in constructor, but let's be consistent)
  airtunes.setVolume("all", volume);

  console.log("Active outputs =>", selectedOutputs);
}

//////////////////////////////////////////////////////////
// Express
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

//////////////////////////////////////////////////////////
// Socket.io
io.on('connection', socket => {
  console.log("client connected");
  // push current info
  updateAllInputs();
  updateAllOutputs();
  socket.emit('switched_input', currentInput);
  socket.emit('switched_output', selectedOutputs);
  socket.emit('changed_output_volume', volume);

  socket.on('switch_input', devId => {
    console.log("switch_input =>", devId);
    cleanupCurrentInput();
    currentInput = devId;
    if (devId === "void") {
      inputStream = new FromVoid();
      inputStream.pipe(duplicator);
    } else {
      // spawn arecord
      arecordInstance = spawn("arecord", [
        '-D', devId,
        '-c', '2',
        '-f', 'S16_LE',
        '-r', '44100'
      ]);
      inputStream = arecordInstance.stdout;
      inputStream.pipe(duplicator);
    }
    io.emit('switched_input', currentInput);
  });

  socket.on('switch_output', newList => {
    if (!Array.isArray(newList)) newList = [newList];
    syncOutputs(newList);
    io.emit('switched_output', newList);
  });

  socket.on('change_output_volume', vol => {
    volume = Number(vol) || 0;
    // set on airtunes
    airtunes.setVolume("all", volume);
    // local doesn't do direct setVolume. you'd do amixer if you want
    io.emit('changed_output_volume', volume);
  });

  socket.on('disconnect', () => {
    console.log("client disconnected");
  });
});

//////////////////////////////////////////////////////////
// Start
server.listen(3000, () => {
  console.log("Babelpod started on port 3000");
});
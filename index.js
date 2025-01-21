/*
 Babelpod index.js

 - Collapses stereo pairs: if two devices share the same stereoName (from gpn=).
 - Replaces multi-select with a set of checkboxes in index.html.
 - When user selects a “stereo device,” we add both underlying devices with stereo:true.

 For more details, see usage in index.html.
*/

var app = require('express')();
var http = require('http').Server(app);
var { Server } = require('socket.io');
var io = new Server(http);

var spawn = require('child_process').spawn;
var util = require('util');
var stream = require('stream');
var mdns = require('mdns-js');
var fs = require('fs');
var AirTunes = require('airtunes2');

var airtunes = new AirTunes();

// Streams that do nothing
util.inherits(ToVoid, stream.Writable);
function ToVoid() {
  if (!(this instanceof ToVoid)) return new ToVoid();
  stream.Writable.call(this);
}
ToVoid.prototype._write = function (_chunk, _enc, cb) {
  cb();
};

util.inherits(FromVoid, stream.Readable);
function FromVoid() {
  if (!(this instanceof FromVoid)) return new FromVoid();
  stream.Readable.call(this);
}
FromVoid.prototype._read = function () { };

// Current input
var currentInput = "void";
var inputStream = new FromVoid();
var arecordInstance = null;

// Fallback for “no real output”
var fallbackOutputStream = new ToVoid();
inputStream.pipe(fallbackOutputStream).on('error', e => {
  console.log('fallback pipe error: ', e);
});

// Our active devices
var activeDevices = [];
// Our “selected outputs” from the user, an array of “UI IDs.”
var selectedOutputs = [];
// Our master volume
var volume = 20;

// Raw discovered outputs
var availableBluetoothInputs = [];
var availablePcmOutputs = [];
var availablePcmInputs = [];
var availableAirplayOutputs = [];

// Merged / grouped devices for the UI (some might be stereo pairs).
// Each entry has shape: { uiId, name, isStereo, devices: [ {host, port, stereoFlag} ... ] }
var unifiedOutputs = [];

////////////////////////////
// PCM scanning
function pcmDeviceSearch() {
  try {
    var pcm = fs.readFileSync('/proc/asound/pcm', 'utf8');
  } catch (e) {
    console.log("Could not read /proc/asound/pcm for PCM devices");
    return;
  }
  var lines = pcm.split("\n").filter(l => l);
  var all = lines.map(line => {
    var splitDev = line.split(":");
    var idVal = "plughw:" + splitDev[0].split("-").map(num => parseInt(num, 10)).join(",");
    return {
      id: idVal,
      name: splitDev[2].trim(),
      output: splitDev.some(part => part.includes("playback")),
      input: splitDev.some(part => part.includes("capture"))
    };
  });
  availablePcmOutputs = all.filter(d => d.output);
  availablePcmInputs = all.filter(d => d.input);
  updateAllInputs();
  updateAllOutputs();
}
pcmDeviceSearch();
setInterval(pcmDeviceSearch, 10000);

function updateAllInputs() {
  // we combine all possible inputs
  var defaultIn = [{ name: 'None', id: 'void' }];
  var list = defaultIn.concat(availablePcmInputs, availableBluetoothInputs);
  io.emit('available_inputs', list);
}

// The main function that merges AirPlay devices by stereoName
function buildUnifiedOutputs() {
  // We combine local outputs + grouped airplay
  // local outputs => pass directly
  // airplay => group by stereoName
  let local = availablePcmOutputs.map(o => {
    return {
      uiId: o.id,   // same as the actual id
      name: "Local: " + o.name,
      isStereo: false,
      devices: [{ host: null, port: null, localId: o.id }] // indicates local
    };
  });

  // group airplay
  // e.g. { stereoName -> [ {host, port, name, stereoName}, {host, port, ...}, ... ] }
  let grouped = {};
  // If no stereoName, treat them individually with a pseudo name
  for (let dev of availableAirplayOutputs) {
    let sname = dev.stereo || dev.stereoName || dev.host + ":" + dev.port;
    if (!grouped[sname]) grouped[sname] = [];
    grouped[sname].push(dev);
  }

  let airplayMerged = [];
  for (let sname in grouped) {
    let arr = grouped[sname];
    if (arr.length === 1) {
      // single device
      let d = arr[0];
      let uiId = "air:" + sname;
      airplayMerged.push({
        uiId: uiId,
        name: d.name + (d.stereo ? " (StereoCandidate)" : ""),
        isStereo: false,
        devices: [{ host: d.host, port: d.port, stereoFlag: !!d.stereo }]
      });
    } else {
      // multiple => treat as stereo pair
      // if you want to confirm exactly 2, you can do that
      let devName = arr.map(x => x.name).join(" & ");
      let uiId = "airpair:" + sname;
      airplayMerged.push({
        uiId: uiId,
        name: sname + " (Stereo)",  // or devName
        isStereo: true,
        devices: arr.map(x => ({
          host: x.host,
          port: x.port,
          stereoFlag: true
        }))
      });
    }
  }

  let combined = local.concat(airplayMerged);
  return combined;
}

// push to front end
function updateAllOutputs() {
  unifiedOutputs = buildUnifiedOutputs();
  io.emit('available_outputs', unifiedOutputs);
}

//////////////////////////////
// mdns for airplay
var browser = mdns.createBrowser(mdns.tcp('airplay'));
browser.on('ready', () => {
  browser.discover();
});
browser.on('update', data => {
  if (!data.fullname) return;
  let re = /(.*)\._airplay\._tcp\.local/;
  let m = re.exec(data.fullname);
  if (m && m.length > 1) {
    let address = data.addresses[0];
    let port = data.port;
    let id = "airplay_" + address + "_" + port;
    if (!availableAirplayOutputs.some(e => e.host === address && e.port === port)) {
      let stName = null;
      data.txt.forEach(t => {
        if (t.startsWith("gpn=")) stName = t.substring(4);
      });
      availableAirplayOutputs.push({
        name: m[1],
        id: id,
        stereo: stName, // store it in .stereo
        stereoName: stName,
        host: address,
        port: port
      });
      updateAllOutputs();
    }
  }
});

//////////////////////////////
// Cleanup current input
function cleanupCurrentInput() {
  inputStream.unpipe(fallbackOutputStream);
  if (arecordInstance) {
    arecordInstance.kill();
    arecordInstance = null;
  }
}

// spawn local aplay
function spawnAplay(localId) {
  let aplayProc = spawn("aplay", [
    '-D', localId,
    '-c', '2',
    '-f', 'S16_LE',
    '-r', '44100'
  ]);
  inputStream.pipe(aplayProc.stdin).on('error', err => {
    console.log('pipe to aplay error:', err);
  });
  return {
    _id: localId,
    stop(cb) {
      try { aplayProc.kill(); } catch (e) { }
      if (cb) cb();
    },
    setVolume() {
      // local volume => do amixer if wanted
    }
  };
}

// spawn airplay device
function spawnAirplayDevice(opts) {
  // opts => {host, port, stereoFlag}
  let dev = airtunes.add(opts.host, {
    port: opts.port,
    volume: volume,
    stereo: !!opts.stereoFlag
  });
  dev.on('status', s => {
    console.log('airplay device =>', s);
  });
  return dev;
}

// for each UI device => add devices
function addUnifiedDevice(ud) {
  // ud => { uiId, name, isStereo, devices: [ {host,port, localId?, stereoFlag?} ] }
  let devs = [];
  for (let d of ud.devices) {
    if (d.localId) {
      // local
      let localObj = spawnAplay(d.localId);
      devs.push(localObj);
    } else {
      // airplay
      let airObj = spawnAirplayDevice(d);
      devs.push(airObj);
    }
  }
  return devs;
}

/**
 * syncOutputs:
 *  - newOutputs is an array of uiId from user’s checkbox selection
 *  - we remove everything not in newOutputs
 *  - we add new devices for newly selected
 */
function syncOutputs(newOutputs) {
  let old = selectedOutputs.slice();
  selectedOutputs = newOutputs.slice();

  // find removed
  let removed = old.filter(o => !selectedOutputs.includes(o));
  let added = selectedOutputs.filter(o => !old.includes(o));

  // remove
  removed.forEach(rid => {
    // find in activeDevices
    // but we have no direct “uiId” on them. We can store a property ._ui
    // so we need to do: find all devices that have ._ui===rid, remove them
    for (let i = activeDevices.length - 1; i >= 0; i--) {
      if (activeDevices[i]._ui === rid) {
        try { activeDevices[i].stop(); } catch (e) { }
        activeDevices.splice(i, 1);
      }
    }
  });

  // add
  added.forEach(aid => {
    if (aid === "void") return;
    let foundUD = unifiedOutputs.find(u => u.uiId === aid);
    if (!foundUD) return; // unknown device
    let newDevs = addUnifiedDevice(foundUD);
    // we store ._ui
    newDevs.forEach(nd => {
      nd._ui = aid;
      activeDevices.push(nd);
    });
  });

  // fallback if none
  if (!selectedOutputs.length || selectedOutputs.every(x => x === "void")) {
    inputStream.unpipe(fallbackOutputStream);
    fallbackOutputStream = new ToVoid();
    inputStream.pipe(fallbackOutputStream).on('error', e => {
      console.log('fallback pipe error:', e);
    });
  } else {
    // we do the same fallback but it’s unused
    inputStream.unpipe(fallbackOutputStream);
    fallbackOutputStream = new ToVoid();
    inputStream.pipe(fallbackOutputStream).on('error', e => {
      console.log('fallback pipe error:', e);
    });
  }
}

// Express
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Socket.io
io.on('connection', socket => {
  console.log('client connected');
  // push our lists
  updateAllInputs();
  updateAllOutputs();

  socket.emit('switched_input', currentInput);
  socket.emit('switched_output', selectedOutputs);
  socket.emit('changed_output_volume', volume);

  socket.on('change_output_volume', vol => {
    volume = vol;
    for (let dev of activeDevices) {
      if (dev.setVolume) dev.setVolume(vol);
    }
    io.emit('changed_output_volume', volume);
  });

  socket.on('switch_output', newOutputs => {
    console.log('switch_output => ', newOutputs);
    if (!Array.isArray(newOutputs)) newOutputs = [newOutputs];
    syncOutputs(newOutputs);
    io.emit('switched_output', newOutputs);
  });

  socket.on('switch_input', inputSel => {
    console.log('switch_input => ', inputSel);
    currentInput = inputSel;
    cleanupCurrentInput();
    if (currentInput === "void") {
      inputStream = new FromVoid();
      inputStream.pipe(fallbackOutputStream);
    } else {
      arecordInstance = spawn("arecord", [
        '-D', currentInput,
        '-c', "2",
        '-f', "S16_LE",
        '-r', "44100"
      ]);
      inputStream = arecordInstance.stdout;
      inputStream.pipe(fallbackOutputStream);
    }
    io.emit('switched_input', currentInput);
  });

  socket.on('disconnect', () => {
    console.log('client disconnected');
  });
});

http.listen(3000, () => {
  console.log("Babelpod listening on :3000");
});
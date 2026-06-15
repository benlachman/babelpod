/*
  Pure device-list helpers used by the server (index.js) and unit tests.
  No I/O here — callers read /proc/asound/pcm, mDNS records, etc. and pass
  the raw data in.
*/

// Parse the contents of /proc/asound/pcm into input/output device lists.
function parsePcmDevices(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  const all = lines.map(line => {
    const parts = line.split(':');
    if (parts.length < 3) return null;
    const deviceName = parts[2].trim();
    const deviceId = "plughw:" + parts[0].split("-").map(x => parseInt(x, 10)).join(",");
    return {
      id: deviceId,
      name: deviceName,
      output: parts.some(t => t.includes("playback")),
      input: parts.some(t => t.includes("capture"))
    };
  }).filter(Boolean);
  return {
    outputs: all.filter(d => d.output),
    inputs: all.filter(d => d.input)
  };
}

// Parse an mDNS _airplay._tcp service record into a device descriptor,
// or null if the record is not a usable AirPlay service.
function parseAirplayService(data) {
  if (!data.fullname || !data.addresses?.length) return null;
  const match = /(.*)\._airplay\._tcp\.local/.exec(data.fullname);
  if (!match || match.length < 2) return null;
  return {
    name: match[1],
    stereo: data.txt?.gpn || null,
    host: data.addresses[0],
    port: data.port
  };
}

// Organize available outputs into a single list for clients.
// Deduplicates AirPlay devices by name+host:port and groups stereo pairs
// (devices sharing a gpn TXT record) into one selectable output.
function buildUnifiedOutputs(availablePcmOutputs, availableAirplayOutputs) {
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

// Clamp a volume value to the 0-100 range.
function clampVolume(value) {
  return Math.max(0, Math.min(100, value));
}

// Whether an output supports independent per-output volume. Only AirPlay
// outputs have a software gain knob (via node_airtunes2 per-device volume);
// local ALSA outputs are piped raw to aplay with no volume control.
function outputSupportsVolume(uiId) {
  return typeof uiId === 'string' && (uiId.startsWith('air:') || uiId.startsWith('airpair:'));
}

module.exports = { parsePcmDevices, parseAirplayService, buildUnifiedOutputs, clampVolume, outputSupportsVolume };

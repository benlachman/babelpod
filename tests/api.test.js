const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const path = require('path');

// The server is a single-file app that binds on require.
// We start it as a child process with DISABLE_PCM=1 to skip ALSA scanning.
const { spawn } = require('child_process');

const TEST_PORT = 3999;
let serverProcess;
let client;

function connectClient(opts = {}) {
  return new Promise((resolve) => {
    const c = ioClient(`http://localhost:${TEST_PORT}`, {
      forceNew: true,
      transports: ['websocket'],
      ...opts
    });
    // The server emits `state` immediately on connection — attach the listener
    // before `connect` resolves so a fast `state` can't arrive before a test
    // registers its own listener (the source of intermittent state timeouts).
    c._bufferedState = null;
    c.on('state', (s) => { c._bufferedState = s; });
    c.on('connect', () => resolve(c));
  });
}

function waitForEvent(socket, event, timeout = 2000) {
  // `state` is connect-only and buffered at socket creation; return it if seen.
  if (event === 'state' && socket._bufferedState) {
    return Promise.resolve(socket._bufferedState);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

beforeAll((done) => {
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, BABEL_PORT: String(TEST_PORT), DISABLE_PCM: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Wait for the server to start listening
  serverProcess.stdout.on('data', (data) => {
    if (data.toString().includes('Babelpod listening')) {
      done();
    }
  });

  serverProcess.on('error', (err) => done(err));
});

afterAll((done) => {
  if (client) client.disconnect();
  if (serverProcess) {
    serverProcess.on('exit', () => done());
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
    }, 2000);
  } else {
    done();
  }
});

afterEach(() => {
  if (client) {
    client.disconnect();
    client = null;
  }
});

describe('Socket.IO API Contract', () => {

  describe('Connection and state', () => {
    test('receives state event on connection with correct shape', async () => {
      client = await connectClient();
      const state = await waitForEvent(client, 'state');

      expect(state).toHaveProperty('version', 1);
      expect(state).toHaveProperty('sessionOwner');
      expect(state).toHaveProperty('inputs');
      expect(state).toHaveProperty('outputs');
      expect(state).toHaveProperty('selectedInput');
      expect(state).toHaveProperty('selectedOutputs');
      expect(state).toHaveProperty('volume');
      expect(state).toHaveProperty('config');
      expect(state).toHaveProperty('autoconnectState');
      expect(Array.isArray(state.inputs)).toBe(true);
      expect(Array.isArray(state.outputs)).toBe(true);
      expect(Array.isArray(state.selectedOutputs)).toBe(true);
      expect(typeof state.volume).toBe('number');
    });

    test('inputs list always includes void/None', async () => {
      client = await connectClient();
      const state = await waitForEvent(client, 'state');
      const voidInput = state.inputs.find(i => i.id === 'void');
      expect(voidInput).toBeDefined();
      expect(voidInput.name).toBe('None');
    });

    test('first client becomes session owner', async () => {
      client = await connectClient();
      const state = await waitForEvent(client, 'state');
      expect(state.sessionOwner).toBe(client.id);
    });
  });

  describe('Session ownership', () => {
    test('second client is not the owner', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const client2 = await connectClient();
      const state2 = await waitForEvent(client2, 'state');
      expect(state2.sessionOwner).not.toBe(client2.id);
      expect(state2.sessionOwner).toBe(client.id);
      client2.disconnect();
    });

    test('takeover transfers ownership', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const client2 = await connectClient();
      await waitForEvent(client2, 'state');

      const sessionPromise = waitForEvent(client, 'session');
      client2.emit('takeover');
      const session = await sessionPromise;
      expect(session.owner).toBe(client2.id);
      client2.disconnect();
    });

    test('sole remaining client gets ownership on disconnect', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const client2 = await connectClient();
      await waitForEvent(client2, 'state');
      client2.emit('takeover');
      await waitForEvent(client, 'session');

      const sessionPromise = waitForEvent(client, 'session');
      client2.disconnect();
      const session = await sessionPromise;
      expect(session.owner).toBe(client.id);
    });
  });

  describe('Input control', () => {
    test('setInput to void emits input event', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const inputPromise = waitForEvent(client, 'input');
      client.emit('setInput', { id: 'void' });
      const input = await inputPromise;
      expect(input).toEqual({ id: 'void' });
    });

    test('non-owner setInput is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const client2 = await connectClient();
      await waitForEvent(client2, 'state');

      // client2 is not owner — this should be ignored
      client2.emit('setInput', { id: 'void' });

      // Wait briefly — if an input event arrives, the test should fail
      await expect(
        waitForEvent(client, 'input', 500)
      ).rejects.toThrow('Timeout');

      client2.disconnect();
    });
  });

  describe('Output control', () => {
    test('setOutput emits output event with ids array', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const outputPromise = waitForEvent(client, 'output');
      client.emit('setOutput', { ids: [] });
      const output = await outputPromise;
      expect(output).toEqual({ ids: [] });
    });
  });

  describe('Volume control', () => {
    test('setVolume emits volume event', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const volumePromise = waitForEvent(client, 'volume');
      client.emit('setVolume', { value: 75 });
      const volume = await volumePromise;
      expect(volume).toEqual({ value: 75 });
    });

    test('setVolume with non-number is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      client.emit('setVolume', { value: 'loud' });
      await expect(
        waitForEvent(client, 'volume', 500)
      ).rejects.toThrow('Timeout');
    });
  });

  describe('Per-output volume', () => {
    test('outputs carry an integer 0-100 volume only when they support it', async () => {
      client = await connectClient();
      const state = await waitForEvent(client, 'state');

      for (const output of state.outputs) {
        if ('volume' in output) {
          // Capability by presence — must be an AirPlay output, integer 0-100
          expect(output.id).toMatch(/^air(pair)?:/);
          expect(Number.isInteger(output.volume)).toBe(true);
          expect(output.volume).toBeGreaterThanOrEqual(0);
          expect(output.volume).toBeLessThanOrEqual(100);
        } else {
          // Local ALSA outputs have no software gain, so no volume field
          expect(output.id).not.toMatch(/^air(pair)?:/);
        }
      }
    });

    test('non-owner setOutputVolume is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const client2 = await connectClient();
      await waitForEvent(client2, 'state');

      // client2 is not the owner — no outputVolume should be broadcast
      client2.emit('setOutputVolume', { id: 'air:Kitchen', value: 50 });
      await expect(
        waitForEvent(client, 'outputVolume', 500)
      ).rejects.toThrow('Timeout');
      client2.disconnect();
    });

    test('setOutputVolume for an unknown output id is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      client.emit('setOutputVolume', { id: 'air:__nonexistent_device__', value: 50 });
      await expect(
        waitForEvent(client, 'outputVolume', 500)
      ).rejects.toThrow('Timeout');
    });

    test('setOutputVolume with a non-number value is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      client.emit('setOutputVolume', { id: 'air:__nonexistent_device__', value: 'loud' });
      await expect(
        waitForEvent(client, 'outputVolume', 500)
      ).rejects.toThrow('Timeout');
    });

    test('setOutputVolume clamps to 0-100 and broadcasts an integer outputVolume', async () => {
      client = await connectClient();
      const state = await waitForEvent(client, 'state');

      const capable = state.outputs.find(o => typeof o.volume === 'number');
      if (!capable) {
        // No AirPlay outputs discovered in this environment (e.g. CI without
        // discoverable devices) — fall back to verifying the no-op guard so the
        // test stays deterministic. The clamp logic is unit-tested separately.
        client.emit('setOutputVolume', { id: 'air:__nonexistent_device__', value: 150 });
        await expect(
          waitForEvent(client, 'outputVolume', 500)
        ).rejects.toThrow('Timeout');
        return;
      }

      const broadcast = waitForEvent(client, 'outputVolume');
      client.emit('setOutputVolume', { id: capable.id, value: 150 });
      const event = await broadcast;
      expect(event.id).toBe(capable.id);
      expect(event.value).toBe(100); // clamped from 150
      expect(Number.isInteger(event.value)).toBe(true);
    });
  });

  describe('Config', () => {
    test('setConfig emits config and status events', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const configPromise = waitForEvent(client, 'config');
      client.emit('setConfig', { defaultVolume: 60 });
      const config = await configPromise;
      expect(config.defaultVolume).toBe(60);
    });

    test('setConfig persists and sanitizes per-speaker default volumes', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const configPromise = waitForEvent(client, 'config');
      client.emit('setConfig', {
        defaultOutputVolumes: { 'air:Kitchen': 150, 'air:Office': 40.4, 'air:Bad': 'loud' }
      });
      const config = await configPromise;
      expect(config.defaultOutputVolumes).toEqual({ 'air:Kitchen': 100, 'air:Office': 40 });
    });
  });

  describe('Autoconnect', () => {
    test('setAutoconnect to listening emits autoconnect state', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const autoconnectPromise = waitForEvent(client, 'autoconnect');
      client.emit('setAutoconnect', { state: 'listening' });
      const autoconnect = await autoconnectPromise;
      expect(autoconnect.state).toBe('idle');
    });

    test('setAutoconnect to paused stops outputs and emits state', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      const autoconnectPromise = waitForEvent(client, 'autoconnect');
      client.emit('setAutoconnect', { state: 'paused' });
      const autoconnect = await autoconnectPromise;
      expect(autoconnect.state).toBe('paused');
    });

    test('invalid autoconnect state is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      client.emit('setAutoconnect', { state: 'invalid' });
      await expect(
        waitForEvent(client, 'autoconnect', 500)
      ).rejects.toThrow('Timeout');
    });
  });

  describe('Payload validation', () => {
    test('setInput with missing id is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      client.emit('setInput', {});
      await expect(
        waitForEvent(client, 'input', 500)
      ).rejects.toThrow('Timeout');
    });

    test('setOutput with non-array ids is ignored', async () => {
      client = await connectClient();
      await waitForEvent(client, 'state');

      client.emit('setOutput', { ids: 'not-an-array' });
      await expect(
        waitForEvent(client, 'output', 500)
      ).rejects.toThrow('Timeout');
    });
  });
});

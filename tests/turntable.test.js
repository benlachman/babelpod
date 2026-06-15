/**
 * Tests for turntable power support: silence auto-off detection and
 * plug controller state/change-event behavior.
 */

const { dbfsFromRms, SilenceAutoOff } = require('../lib/turntable');
const { MatterPlugController } = require('../lib/plugController');

describe('dbfsFromRms', () => {
  test('full scale RMS is 0 dBFS', () => {
    expect(dbfsFromRms(1.0)).toBeCloseTo(0);
  });

  test('silence is -Infinity', () => {
    expect(dbfsFromRms(0)).toBe(-Infinity);
  });

  test('RMS 0.00316 is about -50 dBFS', () => {
    expect(dbfsFromRms(0.00316)).toBeCloseTo(-50, 0);
  });

  test('RMS 0.1 is -20 dBFS', () => {
    expect(dbfsFromRms(0.1)).toBeCloseTo(-20);
  });
});

describe('SilenceAutoOff', () => {
  const MINUTE = 60 * 1000;
  const LOUD = 0.05;       // ~-26 dBFS: music playing
  const SILENT = 0.0015;   // ~-56 dBFS: turntable on, runout-groove surface noise (dead band)
  const DEAD_LINE = 0.0001; // -80 dBFS: no source at all — turntable already off

  function createDetector({ durationMs = 20 * MINUTE, thresholdDb = -50, noiseFloorDb = -62 } = {}) {
    let currentTime = 0;
    const onTrigger = jest.fn();
    const detector = new SilenceAutoOff({
      thresholdDb,
      noiseFloorDb,
      durationMs,
      smoothingAlpha: 1, // disable smoothing for deterministic single-sample tests
      onTrigger,
      now: () => currentTime
    });
    return {
      detector,
      onTrigger,
      advance(ms) { currentTime += ms; }
    };
  }

  test('does nothing when not armed', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.handleRms(SILENT);
    advance(30 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test('fires after sustained silence reaches the configured duration', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(SILENT); // starts the silence window
    advance(20 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test('does not fire before the duration elapses', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(SILENT);
    advance(19 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test('audio above the threshold resets the silence window (inter-track gaps never trigger)', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(SILENT);
    advance(15 * MINUTE);
    detector.handleRms(LOUD); // next track starts
    advance(10 * MINUTE);
    detector.handleRms(SILENT); // new window starts here
    advance(19 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).not.toHaveBeenCalled();
    advance(1 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test('fires only once, then stays disarmed until reset', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(SILENT);
    advance(20 * MINUTE);
    detector.handleRms(SILENT);
    advance(40 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    detector.reset(); // power came back
    detector.handleRms(SILENT);
    advance(20 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  test('re-arming clears any accumulated silence', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(SILENT);
    advance(19 * MINUTE);
    detector.setArmed(false);
    detector.setArmed(true);
    advance(2 * MINUTE);
    detector.handleRms(SILENT); // fresh window — only now starts counting
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test('configure updates threshold and duration', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.configure({ thresholdDb: -30, durationMs: 5 * MINUTE });
    detector.setArmed(true);
    detector.handleRms(0.01); // -40 dBFS: silent under the new -30 threshold
    advance(5 * MINUTE);
    detector.handleRms(0.01);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test('configure ignores invalid values', () => {
    const { detector } = createDetector();
    detector.configure({ thresholdDb: NaN, noiseFloorDb: 'low', durationMs: -5 });
    expect(detector.thresholdDb).toBe(-50);
    expect(detector.noiseFloorDb).toBe(-62);
    expect(detector.durationMs).toBe(20 * 60 * 1000);
  });

  test('a dead line never triggers (turntable already off)', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(DEAD_LINE);
    advance(40 * MINUTE);
    detector.handleRms(DEAD_LINE);
    advance(40 * MINUTE);
    detector.handleRms(DEAD_LINE);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test('digital silence (RMS 0) never triggers', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(0);
    advance(40 * MINUTE);
    detector.handleRms(0);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test('dropping below the noise floor resets an accumulating window', () => {
    const { detector, onTrigger, advance } = createDetector();
    detector.setArmed(true);
    detector.handleRms(SILENT); // runout groove — window starts
    advance(19 * MINUTE);
    detector.handleRms(DEAD_LINE); // turntable switched off — window resets
    advance(5 * MINUTE);
    detector.handleRms(SILENT); // back in the dead band — fresh window
    advance(19 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).not.toHaveBeenCalled();
    advance(1 * MINUTE);
    detector.handleRms(SILENT);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test('smoothing rides out a momentary dip below the noise floor', () => {
    let currentTime = 0;
    const onTrigger = jest.fn();
    const detector = new SilenceAutoOff({
      thresholdDb: -50,
      noiseFloorDb: -62,
      durationMs: 20 * MINUTE,
      onTrigger,
      now: () => currentTime
    }); // default smoothingAlpha 0.15
    detector.setArmed(true);

    // Sustained surface noise seeds the smoothed level in the dead band
    for (let i = 0; i < 20; i++) detector.handleRms(SILENT);
    expect(detector.silentSince).not.toBeNull();
    const windowStart = detector.silentSince;

    // One raw sample at the dead-line level: smoothed stays in the dead band
    detector.handleRms(DEAD_LINE);
    expect(detector.silentSince).toBe(windowStart);

    // ...and the window still fires on schedule
    currentTime += 20 * MINUTE;
    detector.handleRms(SILENT);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});

describe('MatterPlugController state tracking', () => {
  test('starts off and unreachable', () => {
    const controller = new MatterPlugController({ storagePath: '/tmp/unused' });
    expect(controller.isOn).toBe(false);
    expect(controller.isReachable).toBe(false);
  });

  test('emits change with the full {on, reachable} payload when power state changes', () => {
    const controller = new MatterPlugController({ storagePath: '/tmp/unused' });
    const changes = [];
    controller.on('change', payload => changes.push(payload));

    controller.updateState({ reachable: true });
    controller.updateState({ on: true });
    expect(changes).toEqual([
      { on: false, reachable: true },
      { on: true, reachable: true }
    ]);
  });

  test('does not emit change when nothing changed', () => {
    const controller = new MatterPlugController({ storagePath: '/tmp/unused' });
    const changes = [];
    controller.on('change', payload => changes.push(payload));

    controller.updateState({ on: false, reachable: false });
    expect(changes).toEqual([]);
  });

  test('reports unreachable transitions (node offline)', () => {
    const controller = new MatterPlugController({ storagePath: '/tmp/unused' });
    controller.updateState({ on: true, reachable: true });

    const changes = [];
    controller.on('change', payload => changes.push(payload));
    controller.updateState({ reachable: false });

    // Last known power state is preserved while unreachable
    expect(changes).toEqual([{ on: true, reachable: false }]);
  });

  test('setPower rejects when not connected', async () => {
    const controller = new MatterPlugController({ storagePath: '/tmp/unused' });
    await expect(controller.setPower(true)).rejects.toThrow('not connected');
  });

  test('normalizes Apple Home pairing codes to digits', () => {
    expect(MatterPlugController.normalizePairingCode('1406-013-3112')).toBe('14060133112');
    expect(MatterPlugController.normalizePairingCode('14060133112')).toBe('14060133112');
    expect(MatterPlugController.normalizePairingCode(null)).toBe('');
    expect(MatterPlugController.normalizePairingCode('')).toBe('');
  });

  test('isCommissioned is false before init', () => {
    const controller = new MatterPlugController({ storagePath: '/tmp/unused' });
    expect(controller.isCommissioned()).toBe(false);
  });
});

describe('MatterPlugController OnOff cluster discovery', () => {
  // Fake matter.js PairedNode: mutable device list, structureChanged observable
  function createFakeNode(devices = []) {
    const listeners = new Set();
    return {
      getDevices: () => devices,
      devices,
      events: {
        structureChanged: {
          on: fn => listeners.add(fn),
          off: fn => listeners.delete(fn)
        }
      },
      fireStructureChanged() { listeners.forEach(fn => fn()); },
      listenerCount: () => listeners.size
    };
  }

  function createController(node) {
    const controller = new MatterPlugController({ storagePath: '/tmp/unused' });
    controller.node = node;
    controller.OnOffCluster = { id: 6 };
    return controller;
  }

  const fakeOnOffClient = { on: async () => {}, off: async () => {}, getOnOffAttribute: async () => true };
  const onOffDevice = { getClusterClient: () => fakeOnOffClient };
  const otherDevice = { getClusterClient: () => undefined };

  test('resolves when the OnOff cluster appears after a structure change', async () => {
    const node = createFakeNode([otherDevice]);
    const controller = createController(node);

    const pending = controller.waitForOnOffClient(1000);
    node.devices.push(onOffDevice);
    node.fireStructureChanged();

    await expect(pending).resolves.toBe(fakeOnOffClient);
    expect(node.listenerCount()).toBe(0); // listener cleaned up
  });

  test('resolves immediately when the cluster already exists', async () => {
    const node = createFakeNode([onOffDevice]);
    const controller = createController(node);
    await expect(controller.waitForOnOffClient(1000)).resolves.toBe(fakeOnOffClient);
  });

  test('rejects after the timeout when no OnOff cluster appears', async () => {
    const node = createFakeNode([otherDevice]);
    const controller = createController(node);
    await expect(controller.waitForOnOffClient(50)).rejects.toThrow('timed out waiting for device structure');
    expect(node.listenerCount()).toBe(0);
  });

  test('skips devices whose getClusterClient throws', () => {
    const throwing = { getClusterClient: () => { throw new Error('unsupported'); } };
    const node = createFakeNode([throwing, onOffDevice]);
    const controller = createController(node);
    expect(controller.findOnOffClient()).toBe(fakeOnOffClient);
  });

  test('setPower drives the cluster client commands', async () => {
    const calls = [];
    const client = { on: async () => calls.push('on'), off: async () => calls.push('off') };
    const controller = createController(createFakeNode());
    controller.onOffClient = client;
    await controller.setPower(true);
    await controller.setPower(false);
    expect(calls).toEqual(['on', 'off']);
  });
});

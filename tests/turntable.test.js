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

  test('RMS 0.00316 is about -50 dBFS (the default threshold)', () => {
    expect(dbfsFromRms(0.00316)).toBeCloseTo(-50, 0);
  });

  test('RMS 0.1 is -20 dBFS', () => {
    expect(dbfsFromRms(0.1)).toBeCloseTo(-20);
  });
});

describe('SilenceAutoOff', () => {
  const MINUTE = 60 * 1000;
  const LOUD = 0.05;     // ~-26 dBFS, well above -50
  const SILENT = 0.0001; // -80 dBFS, well below -50

  function createDetector({ durationMs = 20 * MINUTE, thresholdDb = -50 } = {}) {
    let currentTime = 0;
    const onTrigger = jest.fn();
    const detector = new SilenceAutoOff({
      thresholdDb,
      durationMs,
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
    detector.configure({ thresholdDb: NaN, durationMs: -5 });
    expect(detector.thresholdDb).toBe(-50);
    expect(detector.durationMs).toBe(20 * 60 * 1000);
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
});

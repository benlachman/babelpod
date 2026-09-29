const { DiscoveryWatchdog } = require('../lib/discoveryWatchdog');

describe('DiscoveryWatchdog', () => {
  let deviceCount;
  let restarts;
  let watchdog;
  const quietLog = { info: jest.fn(), warn: jest.fn() };

  beforeEach(() => {
    jest.useFakeTimers();
    deviceCount = 0;
    restarts = 0;
    quietLog.info.mockClear();
    quietLog.warn.mockClear();
    watchdog = new DiscoveryWatchdog({
      getDeviceCount: () => deviceCount,
      restartDiscovery: () => { restarts++; },
      log: quietLog,
      initialDelayMs: 30000,
      checkIntervalMs: 60000,
      maximumBackoffMs: 240000
    });
  });

  afterEach(() => {
    watchdog.stop();
    jest.useRealTimers();
  });

  test('does nothing before the initial delay', () => {
    watchdog.start();
    jest.advanceTimersByTime(29999);
    expect(restarts).toBe(0);
  });

  test('restarts discovery when nothing has been discovered (the cold-boot failure)', () => {
    watchdog.start();
    jest.advanceTimersByTime(30000);
    expect(restarts).toBe(1);
    expect(quietLog.warn).toHaveBeenCalledWith(expect.stringContaining('No AirPlay devices discovered'));
  });

  test('leaves healthy discovery alone', () => {
    deviceCount = 11;
    watchdog.start();
    jest.advanceTimersByTime(30000 + 60000 * 10);
    expect(restarts).toBe(0);
  });

  test('backs off exponentially while discovery stays empty, capped at the maximum', () => {
    watchdog.start();
    jest.advanceTimersByTime(30000);   // check 1 → restart, next in 60s
    expect(restarts).toBe(1);
    jest.advanceTimersByTime(60000);   // check 2 → restart, next in 120s
    expect(restarts).toBe(2);
    jest.advanceTimersByTime(119999);
    expect(restarts).toBe(2);
    jest.advanceTimersByTime(1);       // check 3 → restart, next in 240s (cap)
    expect(restarts).toBe(3);
    jest.advanceTimersByTime(240000);  // check 4 → restart, next still 240s
    expect(restarts).toBe(4);
    jest.advanceTimersByTime(240000);
    expect(restarts).toBe(5);
  });

  test('resets the backoff and logs recovery once devices appear', () => {
    watchdog.start();
    jest.advanceTimersByTime(30000 + 60000); // two restarts, backoff now 120s
    expect(restarts).toBe(2);
    deviceCount = 3;
    jest.advanceTimersByTime(120000);
    expect(restarts).toBe(2);
    expect(quietLog.info).toHaveBeenCalledWith(expect.stringContaining('recovered after 2 restart(s)'));
    // Discovery dies later: detected within the base interval again
    deviceCount = 0;
    jest.advanceTimersByTime(60000);
    expect(restarts).toBe(3);
  });

  test('keeps running if a restart throws', () => {
    watchdog = new DiscoveryWatchdog({
      getDeviceCount: () => 0,
      restartDiscovery: () => { restarts++; throw new Error('socket closed'); },
      log: quietLog,
      initialDelayMs: 1000,
      checkIntervalMs: 1000,
      maximumBackoffMs: 1000
    });
    watchdog.start();
    jest.advanceTimersByTime(3000);
    expect(restarts).toBe(3);
  });

  test('stop cancels pending checks', () => {
    watchdog.start();
    watchdog.stop();
    jest.advanceTimersByTime(600000);
    expect(restarts).toBe(0);
  });
});

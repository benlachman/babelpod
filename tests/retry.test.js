const { retryWithBackoff } = require('../lib/retry');

describe('retryWithBackoff', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('returns the result without retrying on success', async () => {
    const operation = jest.fn(async () => 'ready');
    await expect(retryWithBackoff(operation)).resolves.toBe('ready');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('retries with growing, capped delays until it succeeds', async () => {
    let attempts = 0;
    const delays = [];
    const pending = retryWithBackoff(async () => {
      attempts++;
      if (attempts <= 4) throw new Error('offline');
      return attempts;
    }, { initialDelayMs: 100, maximumDelayMs: 300, onFailure: (error, delayMs) => delays.push(delayMs) });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(5);
    expect(delays).toEqual([100, 200, 300, 300]);
  });
});

// Run an async operation until it succeeds, waiting longer after each failure.
// Resolves with the operation's result; never rejects.
async function retryWithBackoff(operation, {
  initialDelayMs = 30000,
  maximumDelayMs = 10 * 60000,
  onFailure = () => {}
} = {}) {
  let delayMs = initialDelayMs;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      onFailure(error, delayMs);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, maximumDelayMs);
    }
  }
}

module.exports = { retryWithBackoff };

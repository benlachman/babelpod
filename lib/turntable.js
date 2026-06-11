/*
  Turntable power helpers: silence detection for auto-off.
  Pure logic — no Matter or Socket.IO dependencies — so it can be unit tested.
*/

// Convert a linear RMS level (0.0-1.0) to dBFS. Silence (0) maps to -Infinity.
function dbfsFromRms(rms) {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/*
  Tracks sustained silence on the input and fires onTrigger once silence has
  lasted the configured duration. Loud samples reset the timer, so inter-track
  gaps and quiet passages never trigger.

  After firing, the detector disarms itself; call reset() to re-arm (the server
  does this when the plug reports power-on, or when audio resumes).
*/
class SilenceAutoOff {
  constructor({ thresholdDb = -50, durationMs = 20 * 60 * 1000, onTrigger, now = Date.now } = {}) {
    this.thresholdDb = thresholdDb;
    this.durationMs = durationMs;
    this.onTrigger = onTrigger;
    this.now = now;
    this.armed = false;
    this.triggered = false;
    this.silentSince = null;
  }

  configure({ thresholdDb, durationMs }) {
    if (typeof thresholdDb === 'number' && Number.isFinite(thresholdDb)) this.thresholdDb = thresholdDb;
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) this.durationMs = durationMs;
  }

  setArmed(armed) {
    if (this.armed === armed) return;
    this.armed = armed;
    this.silentSince = null;
    if (armed) this.triggered = false;
  }

  // Clear a previous trigger and start a fresh silence window.
  reset() {
    this.triggered = false;
    this.silentSince = null;
  }

  handleRms(rms) {
    if (!this.armed || this.triggered) return;

    const db = dbfsFromRms(rms);
    if (db >= this.thresholdDb) {
      this.silentSince = null;
      return;
    }

    const now = this.now();
    if (this.silentSince === null) {
      this.silentSince = now;
    } else if (now - this.silentSince >= this.durationMs) {
      this.triggered = true;
      this.silentSince = null;
      if (this.onTrigger) this.onTrigger();
    }
  }
}

module.exports = { dbfsFromRms, SilenceAutoOff };

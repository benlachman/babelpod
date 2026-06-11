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
  Fires onTrigger once the input has stayed in the silence dead band for the
  configured duration. The dead band sits between two levels:

    level >= thresholdDb               music is playing        -> reset window
    noiseFloorDb <= level < threshold  turntable on, no music  -> accumulate
    level < noiseFloorDb               dead line               -> reset window

  The dead band is the "record left spinning in the runout groove" signature:
  surface noise from a powered turntable. A level below the noise floor means
  there is no source at all — the turntable is already off — and cutting the
  outlet would only be an annoyance (measured on PattyPi: turntable-off line
  noise is -62..-71 dBFS, runout surface noise -54..-60 dBFS).

  Levels are smoothed with a ~1s EMA before classification so momentary dips
  across either boundary don't reset an otherwise-accumulating window.

  After firing, the detector disarms itself; call reset() to re-arm (the server
  does this when the plug reports power-on).
*/
class SilenceAutoOff {
  constructor({
    thresholdDb = -50,
    noiseFloorDb = -62,
    durationMs = 20 * 60 * 1000,
    smoothingAlpha = 0.15,
    onTrigger,
    now = Date.now
  } = {}) {
    this.thresholdDb = thresholdDb;
    this.noiseFloorDb = noiseFloorDb;
    this.durationMs = durationMs;
    this.smoothingAlpha = smoothingAlpha;
    this.onTrigger = onTrigger;
    this.now = now;
    this.armed = false;
    this.triggered = false;
    this.silentSince = null;
    this.smoothedRms = null;
  }

  configure({ thresholdDb, noiseFloorDb, durationMs }) {
    if (typeof thresholdDb === 'number' && Number.isFinite(thresholdDb)) this.thresholdDb = thresholdDb;
    if (typeof noiseFloorDb === 'number' && Number.isFinite(noiseFloorDb)) this.noiseFloorDb = noiseFloorDb;
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) this.durationMs = durationMs;
  }

  setArmed(armed) {
    if (this.armed === armed) return;
    this.armed = armed;
    this.silentSince = null;
    this.smoothedRms = null;
    if (armed) this.triggered = false;
  }

  // Clear a previous trigger and start a fresh silence window.
  reset() {
    this.triggered = false;
    this.silentSince = null;
    this.smoothedRms = null;
  }

  handleRms(rms) {
    if (!this.armed || this.triggered) return;

    this.smoothedRms = this.smoothedRms === null
      ? rms
      : this.smoothingAlpha * rms + (1 - this.smoothingAlpha) * this.smoothedRms;
    const db = dbfsFromRms(this.smoothedRms);

    // Music playing, or a dead line (turntable already off): either way this
    // is not a forgotten spinning record — reset the window.
    if (db >= this.thresholdDb || db < this.noiseFloorDb) {
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

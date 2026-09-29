/*
  mDNS discovery watchdog.

  dnssd2 can start before the network is usable (on a cold boot systemd's
  network-online.target fires before Wi-Fi associates) and then never
  discovers anything; nothing short of restarting the browser recovers it.
  An empty AirPlay device list is the observable symptom, so the watchdog
  checks the device count periodically and restarts discovery while it stays
  empty, backing off so a network that genuinely has no AirPlay devices isn't
  hammered. Once devices appear the backoff resets and monitoring continues,
  which also catches discovery dying mid-life.

  Timers are injectable so the schedule can be tested with fake timers.
*/
class DiscoveryWatchdog {
  constructor({
    getDeviceCount,
    restartDiscovery,
    log = console,
    initialDelayMs = 30000,
    checkIntervalMs = 60000,
    maximumBackoffMs = 15 * 60000,
    timers = { setTimeout, clearTimeout }
  }) {
    this.getDeviceCount = getDeviceCount;
    this.restartDiscovery = restartDiscovery;
    this.log = log;
    this.initialDelayMs = initialDelayMs;
    this.checkIntervalMs = checkIntervalMs;
    this.maximumBackoffMs = maximumBackoffMs;
    this.timers = timers;
    this.backoffMs = checkIntervalMs;
    this.consecutiveEmptyChecks = 0;
    this.timer = null;
  }

  start() {
    this.schedule(this.initialDelayMs);
  }

  stop() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delayMs) {
    this.stop();
    this.timer = this.timers.setTimeout(() => this.check(), delayMs);
    if (this.timer?.unref) this.timer.unref();
  }

  check() {
    this.timer = null;
    if (this.getDeviceCount() > 0) {
      if (this.consecutiveEmptyChecks > 0) {
        this.log.info(`[mdns] AirPlay discovery recovered after ${this.consecutiveEmptyChecks} restart(s)`);
      }
      this.consecutiveEmptyChecks = 0;
      this.backoffMs = this.checkIntervalMs;
      this.schedule(this.checkIntervalMs);
      return;
    }
    this.consecutiveEmptyChecks++;
    this.log.warn(`[mdns] No AirPlay devices discovered; restarting discovery (attempt ${this.consecutiveEmptyChecks}, next check in ${Math.round(this.backoffMs / 1000)}s)`);
    try {
      this.restartDiscovery('no AirPlay devices discovered');
    } catch (error) {
      this.log.warn('[mdns] Discovery restart failed:', error);
    }
    this.schedule(this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maximumBackoffMs);
  }
}

module.exports = { DiscoveryWatchdog };

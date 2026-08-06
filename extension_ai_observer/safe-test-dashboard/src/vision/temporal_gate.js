// =============================================================================
// Temporal Smoothing & Dwell Gate — AI Observer Extension
//
// Nothing in this pipeline may alert on a single frame. Two mechanisms enforce
// that, and they solve genuinely different problems:
//
//   TemporalSmoother removes per-frame NOISE — a keypoint that jumps for one
//   frame because of motion blur or a bad detection.
//
//   DwellGate removes short but REAL movements — glancing down to read the
//   question, or shifting position. These are not noise; the head genuinely
//   moved. They must be ignored because they are normal exam behaviour.
//
// Everything is measured in WALL-CLOCK MILLISECONDS, never frame counts. The
// inference loop runs at a variable rate that drops under load, so "15 frames"
// can mean 1.5 seconds on one machine and 15 seconds on another. A dwell
// requirement expressed in frames is not a dwell requirement at all.
// =============================================================================

const DEFAULT_SMOOTHER_OPTS = {
  // Rolling window length. At 5-10 FPS this holds roughly 6-12 samples, which
  // matches the 10-15 frame window in the spec while staying correct if the
  // frame rate collapses.
  windowMs: 1200,
  maxSamples: 30,
  // 'median' rejects a single wild outlier outright; 'mean' lets it drag the
  // result. Median is the default precisely because one bad keypoint frame is
  // the most common noise mode here.
  mode: 'median',
};

/** Rolling time-windowed smoother over a scalar signal. */
class TemporalSmoother {
  constructor(options = {}) {
    this.opt = { ...DEFAULT_SMOOTHER_OPTS, ...options };
    this.reset();
  }

  reset() {
    /** @type {Array<{v:number, t:number}>} */
    this._buf = [];
  }

  /**
   * Add a sample and return the current smoothed value.
   * @param {number} value
   * @param {number} nowMs
   * @returns {number}
   */
  push(value, nowMs) {
    this._buf.push({ v: value, t: nowMs });

    const cutoff = nowMs - this.opt.windowMs;
    while (this._buf.length && this._buf[0].t < cutoff) this._buf.shift();
    while (this._buf.length > this.opt.maxSamples) this._buf.shift();

    return this.value();
  }

  /** @returns {number} Smoothed value, or NaN when empty. */
  value() {
    const n = this._buf.length;
    if (!n) return NaN;

    if (this.opt.mode === 'mean') {
      let sum = 0;
      for (const s of this._buf) sum += s.v;
      return sum / n;
    }

    const sorted = this._buf.map((s) => s.v).sort((a, b) => a - b);
    const mid = n >> 1;
    return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** @returns {number} Samples currently in the window. */
  size() {
    return this._buf.length;
  }
}

const GateState = {
  IDLE: 'idle',       // Nothing happening.
  ARMING: 'arming',   // Deviation present but too brief to be worth reporting.
  GLANCE: 'glance',   // Long enough to record, too short to accuse. Telemetry only.
  ALERT: 'alert',     // Sustained. High severity.
};

const DEFAULT_GATE_OPTS = {
  // Below this, the movement is normal screen-reading behaviour and is not
  // recorded at all.
  glanceMs: 1500,
  // At or above this, the deviation is treated as sustained and alertable.
  alertMs: 2500,

  // A momentary non-deviant sample does NOT break the streak. Without this,
  // "persist continuously" is unachievable in practice: one noisy frame mid
  // look-away would reset the dwell timer and the alert would never fire.
  // Dwell is measured to the last genuinely deviant sample, so grace time never
  // counts toward the threshold.
  graceMs: 400,

  // If consecutive samples are further apart than this, continuity across the
  // gap is unproven and the streak resets. Protects against a slow device
  // producing two deviant samples 6 s apart and claiming 6 s of sustained
  // deviation from two data points.
  maxSampleGapMs: 2000,

  // Minimum spacing between consecutive ALERT events.
  minRealertMs: 15000,
};

/**
 * Dwell-time state machine over a boolean deviation signal.
 *
 * Emits at most one event per transition:
 *   'glance'  - crossed glanceMs (low severity, telemetry)
 *   'alert'   - crossed alertMs  (high severity)
 *   'release' - a reported episode ended
 */
class DwellGate {
  constructor(options = {}) {
    this.opt = { ...DEFAULT_GATE_OPTS, ...options };
    this.reset();
  }

  reset() {
    this.state = GateState.IDLE;
    this._onsetMs = null;
    this._lastTrueMs = null;
    this._lastSampleMs = null;
    this._lastAlertMs = -Infinity;
    this._peak = 0;
  }

  /**
   * Advance the state machine by one sample.
   *
   * @param {boolean|null} deviant - true/false, or null when pose was unusable.
   *   null is treated like false but is expected to be transient; a long run of
   *   nulls simply lets graceMs expire and releases the episode.
   * @param {number} nowMs
   * @param {number} [magnitude=0] - Excursion magnitude, tracked for reporting.
   * @returns {{state:string, event:string|null, dwellMs:number, peak:number}}
   */
  update(deviant, nowMs, magnitude = 0) {
    // A gap we did not observe cannot count as continuous deviation.
    if (this._lastSampleMs !== null && (nowMs - this._lastSampleMs) > this.opt.maxSampleGapMs) {
      const wasReported = this.state === GateState.GLANCE || this.state === GateState.ALERT;
      this._clearEpisode();
      this._lastSampleMs = nowMs;
      if (wasReported) return this._emit('release', 0);
    }
    this._lastSampleMs = nowMs;

    if (deviant === true) {
      if (this._onsetMs === null) {
        this._onsetMs = nowMs;
        this._peak = 0;
      }
      this._lastTrueMs = nowMs;
      this._peak = Math.max(this._peak, magnitude);

      const dwell = nowMs - this._onsetMs;

      if (dwell >= this.opt.alertMs && this.state !== GateState.ALERT) {
        if (nowMs - this._lastAlertMs < this.opt.minRealertMs) {
          // Refractory: hold in GLANCE rather than latching, so the alert can
          // fire as soon as the refractory lapses without needing a full
          // release/re-arm cycle.
          this.state = GateState.GLANCE;
          return this._emit(null, dwell);
        }
        this.state = GateState.ALERT;
        this._lastAlertMs = nowMs;
        return this._emit('alert', dwell);
      }

      if (dwell >= this.opt.glanceMs && this.state === GateState.ARMING) {
        this.state = GateState.GLANCE;
        return this._emit('glance', dwell);
      }

      if (this.state === GateState.IDLE) this.state = GateState.ARMING;
      return this._emit(null, dwell);
    }

    // Not deviant (or no data).
    if (this._onsetMs === null) return this._emit(null, 0);

    const sinceTrue = nowMs - this._lastTrueMs;
    if (sinceTrue < this.opt.graceMs) {
      // Still inside grace — hold the episode open. Dwell stays pinned to the
      // last genuinely deviant sample.
      return this._emit(null, this._lastTrueMs - this._onsetMs);
    }

    const wasReported = this.state === GateState.GLANCE || this.state === GateState.ALERT;
    const finalDwell = this._lastTrueMs - this._onsetMs;
    this._clearEpisode();
    return this._emit(wasReported ? 'release' : null, finalDwell);
  }

  _clearEpisode() {
    this.state = GateState.IDLE;
    this._onsetMs = null;
    this._lastTrueMs = null;
    this._peak = 0;
  }

  _emit(event, dwellMs) {
    return { state: this.state, event, dwellMs: Math.max(0, dwellMs), peak: this._peak };
  }

  /** @returns {number} Dwell of the in-progress episode, 0 when idle. */
  currentDwellMs() {
    if (this._onsetMs === null || this._lastTrueMs === null) return 0;
    return Math.max(0, this._lastTrueMs - this._onsetMs);
  }
}

// ---------------------------------------------------------------------------
// >>> ESM PORT
/* eslint-disable no-unused-vars -- `__temporalGateExports` below is retained byte-identical
   from upstream so scripts/check-vision-sync.mjs can prove the port. The real ESM
   export follows it, naming the same identifiers in the same order. */
// <<< ESM PORT
const __temporalGateExports = {
  DEFAULT_SMOOTHER_OPTS,
  DEFAULT_GATE_OPTS,
  GateState,
  TemporalSmoother,
  DwellGate,
};

// >>> ESM PORT
/* eslint-enable no-unused-vars */

// Upstream lines 231-232 were two `if (typeof module|window …)` lines that
// published the object above as a CommonJS export / a set of browser globals. Both are
// dropped; these named ESM exports replace them. Same identifiers, same order.
export {
  DEFAULT_SMOOTHER_OPTS,
  DEFAULT_GATE_OPTS,
  GateState,
  TemporalSmoother,
  DwellGate,
};
// <<< ESM PORT

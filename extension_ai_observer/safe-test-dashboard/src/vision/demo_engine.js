// =============================================================================
// ProctorDemoEngine — PLAN.md §6 Phase 3.
//
// The browser is the FIRST environment in which this math has ever executed.
// The engine's whole job is to feed the ported extension modules exactly what
// they expect and to route their output through one choke point, so that every
// safety property the extension proved in Node still holds here.
//
// Every external dependency is INJECTED — landmarkSource, now, schedule/cancel,
// captureSnapshot. `tickOnce(nowMs)` neither schedules nor touches the DOM,
// which is what lets demo_engine.test.js run 30 simulated seconds with no
// camera, no WASM and no real timers.
// =============================================================================

import { HeadPoseAnalyzer, PoseCondition } from './pose_pipeline.js';
import { GazeLandmarkAnalyzer } from './gaze_landmarks.js';
import { EarVetoGate } from './ear_veto.js';
import { toPixelLandmarks, faceToCocoPerson } from './adapters/landmark_adapter.js';

/** PLAN.md §6 violation taxonomy, restricted to what this demo can raise. */
export const VIOLATION = Object.freeze({
  AI_CHEATING_POSE: 'AI_CHEATING_POSE',
  HEAD_POSE_GLANCE: 'HEAD_POSE_GLANCE',
  NO_FACE_DETECTED: 'NO_FACE_DETECTED',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  SIDE_GAZE_PEEKING: 'SIDE_GAZE_PEEKING',
});

/** Per-type cooldown. Without it a sustained look-away emits every frame. */
const DEFAULT_COOLDOWN_MS = 4000;

/** Target cadence. Measured FROM COMPLETION, never setInterval. */
const DEFAULT_INTERVAL_MS = 66;   // ~15 fps
const DEFAULT_MIN_GAP_MS = 33;

export class ProctorDemoEngine {
  constructor(opts = {}) {
    if (!opts.landmarkSource) {
      throw new TypeError('ProctorDemoEngine requires a landmarkSource');
    }
    this.source = opts.landmarkSource;
    this.now = opts.now ?? (() => performance.now());
    // ⚠ setTimeout, NOT requestAnimationFrame. rAF is throttled to ~0 Hz when
    // the tab is hidden, which would freeze analysis while the UI still looked
    // live — a stale reading presented as current. Visibility is handled
    // explicitly by pause()/resume() instead, so the UI can say "paused".
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h));
    this.captureSnapshot = opts.captureSnapshot ?? (() => null);

    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    this.head = opts.headAnalyzer ?? new HeadPoseAnalyzer(opts.headOpts);
    this.gaze = opts.gazeAnalyzer ?? new GazeLandmarkAnalyzer(opts.gazeOpts);
    this.veto = opts.vetoGate ?? new EarVetoGate(opts.vetoOpts);

    this.video = null;
    this.running = false;
    this.paused = false;
    this._timer = null;
    this._cooldowns = new Map();
    this._listeners = new Map();
    this._tickCount = 0;
    this.lastFrame = null;
  }

  // --- tiny event emitter -------------------------------------------------
  on(name, fn) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(fn);
    return () => this._listeners.get(name)?.delete(fn);
  }

  _emit(name, payload) {
    const set = this._listeners.get(name);
    if (!set) return;
    // A throwing listener must not abort the tick — a broken UI subscriber
    // would otherwise take the safety pipeline down with it.
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error('[demo_engine]', name, err); }
    }
  }

  // --- lifecycle ----------------------------------------------------------
  attachVideo(video) { this.video = video; }

  /** Idempotent — StrictMode double-invokes effects. */
  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this._loop();
  }

  pause() {
    this.paused = true;
    if (this._timer !== null) { this.cancel(this._timer); this._timer = null; }
    // The UI must render "paused", NOT the last reading. A stale value shown
    // as live is the exact class of lie this codebase exists to prevent.
    this._emit('paused', { tMs: this.now() });
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this._loop();
  }

  stop() {
    this.running = false;
    this.paused = false;
    if (this._timer !== null) { this.cancel(this._timer); this._timer = null; }
    // Order matters: close the source (releasing the WASM heap) before dropping
    // references. See PLAN.md §6 Phase 6 teardown order.
    try { this.source.close?.(); } catch { /* already closed */ }
    this.video = null;
    this.lastFrame = null;
  }

  reset() {
    this.head.reset?.();
    this.gaze.reset?.();
    this.veto.reset?.();
    this._cooldowns.clear();
    this._tickCount = 0;
    this.lastFrame = null;
  }

  /** Self-scheduling from COMPLETION, so a slow machine degrades to a lower
   *  frame rate instead of queueing ticks it can never drain. */
  _loop() {
    if (!this.running || this.paused) return;
    const started = this.now();
    try {
      this.tickOnce(started);
    } catch (err) {
      console.error('[demo_engine] tick failed', err);
      this._emit('error', { error: err });
    }
    const elapsed = this.now() - started;
    const delay = Math.max(this.minGapMs, this.intervalMs - elapsed);
    this._timer = this.schedule(() => { this._timer = null; this._loop(); }, delay);
  }

  // =========================================================================
  // ONE TICK. Order mirrors monitor.js exactly (PLAN.md §6 Phase 3).
  // =========================================================================
  tickOnce(nowMs) {
    this._tickCount++;
    const video = this.video;

    // 1. Video not ready -> an UNREADABLE frame, and return.
    //    "We could not see" is not "the student did something".
    if (video && video.readyState < 2) {
      // The veto still ages out: a stale EAR must not license suppression
      // indefinitely just because the camera stalled.
      this.veto.submitLandmarks(null, nowMs);
      return this._emitFrame({ tMs: nowMs, readable: false, reason: 'VIDEO_NOT_READY' });
    }

    // 2. Detect.
    const { faces, w, h } = this.source.detect(video, nowMs);
    const primary = faces && faces.length > 0 ? faces[0] : null;

    // R1: pixel space, with width/height REQUIRED. Never normalised.
    const pixels = primary ? toPixelLandmarks(primary, w, h) : null;

    // 3. ⚠ FEED THE VETO BEFORE ANYTHING CAN REPORT — including the null case.
    //    The null call is what ages the sample out; skipping it would let one
    //    good reading license suppression forever.
    this.veto.submitLandmarks(pixels, nowMs);

    // 4 + 5. Project to COCO and run the REAL head-pose pipeline (R2).
    const persons = (faces || [])
      .map((f) => faceToCocoPerson(toPixelLandmarks(f, w, h)))
      .filter(Boolean);
    const headResult = this.head.process(persons, nowMs);

    // 6. Gaze, gated on the real head channel.
    const gazeResult = this.gaze.process(pixels, headResult, nowMs, false);

    // 7. Map events -> violations, through the choke point.
    for (const ev of headResult.events || []) {
      if (ev.condition === PoseCondition.LOOK_AWAY) {
        // HIGH = sustained look-away; LOW = a 1.5-2.5 s glance, which the
        // taxonomy records rather than escalates.
        this._reportViolation(
          ev.severity === 'HIGH' ? VIOLATION.AI_CHEATING_POSE : VIOLATION.HEAD_POSE_GLANCE,
          ev.severity, nowMs, ev.detail,
        );
      } else if (ev.condition === PoseCondition.NO_FACE) {
        this._reportViolation(VIOLATION.NO_FACE_DETECTED, 'MEDIUM', nowMs, ev.detail);
      } else if (ev.condition === PoseCondition.MULTIPLE_FACES) {
        this._reportViolation(VIOLATION.MULTIPLE_FACES, 'MEDIUM', nowMs, ev.detail);
      }
    }
    for (const ev of gazeResult?.events || []) {
      // Severity reused VERBATIM. The gaze analyser already caps itself at
      // MEDIUM; re-deriving it here would let this file quietly promote a
      // coarse signal the module deliberately limited.
      this._reportViolation(VIOLATION.SIDE_GAZE_PEEKING, ev.severity, nowMs, ev.detail);
    }

    // 8. Emit frame state.
    return this._emitFrame({
      tMs: nowMs,
      readable: !!pixels,
      landmarks: pixels,
      frameW: w,
      frameH: h,
      faceCount: faces ? faces.length : 0,
      head: headResult,
      gaze: gazeResult,
      ear: this._readEar(nowMs),
      calibrated: !!headResult.calibrated,
      calibrationProgress: headResult.calibrationProgress ?? 0,
    });
  }

  /** EAR for the gauge. NaN/null means UNKNOWN and MUST render as a hatch —
   *  never 0, never the last-known value (PLAN.md §7).
   *
   * ⚠ THE FIELD IS `ear`, NOT `lastEar`. An earlier draft read `t.lastEar`,
   * which EarVetoGate does not expose — so this returned null on every frame and
   * the gauge was permanently hatched. That failure was silent and it read as
   * legitimate: "unknown" is a state the contract explicitly allows, so a dead
   * gauge looks like honest degradation rather than a typo. The safeguard would
   * have appeared inert for the whole demo — the one thing the page exists to
   * show working.
   *
   * ⚠ STALENESS IS CHECKED, using the gate's OWN maxAgeMs. telemetry().ear is
   * the last sample submitted regardless of age; publishing it unconditionally
   * would put a stale number on a live gauge, which is precisely the lie §7
   * forbids. Past maxAgeMs the honest answer is UNKNOWN — and it is the same
   * threshold evaluate() uses to stop trusting the sample, so the gauge and the
   * safeguard can never disagree about whether we can currently see the eyes.
   */
  _readEar(nowMs) {
    const t = this.veto.telemetry?.();
    if (!t || t.sampledAt === null || !Number.isFinite(t.ear)) return null;
    if (nowMs - t.sampledAt > t.maxAgeMs) return null;
    return t.ear;
  }

  _emitFrame(state) {
    this.lastFrame = state;
    this._emit('frame', state);
    return state;
  }

  // =========================================================================
  // THE CHOKE POINT. Private, synchronous, the ONLY path to a violation.
  // =========================================================================
  _reportViolation(type, severity, nowMs, meta) {
    // ⚠ VETO STRICTLY BEFORE COOLDOWN (monitor.js:512). A suppressed violation
    // must NOT burn its type's cooldown slot: if the eyes reopen a second later
    // and the condition still holds, that genuinely IS reportable, and a
    // consumed cooldown would swallow it silently.
    const verdict = this.veto.evaluate(type, nowMs);
    if (verdict.veto) {
      this._emit('suppressed', {
        type, severity, tMs: nowMs,
        reason: verdict.reason,
        ear: verdict.ear,
        meta,
      });
      return null;
    }

    const until = this._cooldowns.get(type) ?? 0;
    if (nowMs < until) return null;
    this._cooldowns.set(type, nowMs + this.cooldownMs);

    // ⚠ SNAPSHOT ON THE HIT FRAME, synchronously, inside the same tick.
    // Deferring it photographs an empty desk.
    const snapshot = this.video ? this.captureSnapshot(this.video) : null;

    const record = {
      id: `${type}-${Math.round(nowMs)}-${this._tickCount}`,
      type,
      severity,
      tMs: nowMs,
      snapshot,
      ear: verdict.ear,
      earChecked: verdict.reason ?? null,
      meta: meta ?? null,
    };
    this._emit('violation', record);
    return record;
  }

  telemetry() {
    return {
      ticks: this._tickCount,
      running: this.running,
      paused: this.paused,
      delegate: this.source?.delegate ?? null,
      veto: this.veto.telemetry?.() ?? null,
    };
  }
}

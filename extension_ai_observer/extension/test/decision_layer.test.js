// Regression tests for the proctoring decision layer.
//
//   node extension/test/decision_layer.test.js
//
// No dependencies and no build step: this loads the REAL content/monitor.js in a
// vm context with stubbed browser globals and drives it frame by frame. A
// test-only shim is appended to the source IN MEMORY so the harness can reach
// module-scope `let` bindings — the shipped file is never modified.
//
// Covers the sliding-window verdict (including the boundary-straddle case the
// previous tumbling window could miss), the focus-loss coalescing that stops one
// Ctrl-Tab counting twice, and the screen-track mute grace period.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.resolve(__dirname, '../content/monitor.js');
const REST_SRC = path.resolve(__dirname, '../content/supabase_rest.js');

function makeContext() {
  const violations = [];
  const noop = () => {};

  // Seeded so monitor.js's own `restoreSession(data)` rehydrates a signed-in
  // Supabase session exactly the way it does in the browser. Synthetic values —
  // the stubbed fetch never validates them; what is under test is that a token
  // IS present, because without one every write degrades to the `anon` role and
  // RLS discards it silently.
  const storage = {
    sbAccessToken: 'test-token',
    sbRefreshToken: 'test-refresh',
    sbUserId: '11111111-1111-4111-8111-111111111111',
  };
  const chrome = {
    runtime: { id: 'test', sendMessage: noop, lastError: null },
    storage: {
      local: {
        get: (keys, cb) => cb && cb(storage),
        set: (obj, cb) => { Object.assign(storage, obj); cb && cb(); },
        remove: (k, cb) => { delete storage[k]; cb && cb(); },
      },
      onChanged: { addListener: noop },
    },
  };

  const ctx = {
    console: { log: noop, warn: noop, error: console.error },
    chrome,
    // Controllable clock. The classifier is time-sliced now, so a harness that
    // replays frames faster than wall clock would only ever feed it one sample.
    __clock: 0,
    performance: { now: () => ctx.__clock },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise,
    navigator: { sendBeacon: noop, mediaDevices: {} },
    location: { href: 'https://lms.test/mod/quiz/attempt.php?attempt=1' },
    document: {
      addEventListener: noop, removeEventListener: noop,
      getElementById: () => null,
      createElement: () => ({ style: {}, getContext: () => null, remove: noop, addEventListener: noop }),
      body: { appendChild: noop },
      head: { appendChild: noop },
      visibilityState: 'visible',
      fullscreenElement: null,
    },
    // supabase_rest.js wraps every request in an abort timeout.
    AbortController,
    // Capture outbound violation reports.
    //
    // The path moved from the FastAPI `/api/proctor/incident` to PostgREST
    // `/rest/v1/violations`, but the assertions below are unchanged: they read
    // `cheat_reason` and `cheat_probability` off the request body, and those are
    // still the wire field names. Capturing at the socket rather than stubbing
    // SafeTestSupabase means the real field mapping in supabase_rest.js is under
    // test too, which it was not before.
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.includes('/incident') || u.includes('/rest/v1/violations')) {
        violations.push(JSON.parse(opts.body));
      }
      return { ok: true, status: 200, json: async () => ([{ id: 'test-session-row' }]) };
    },
    __violations: violations,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return ctx;
}

const SHIM = `
;globalThis.__t = {
  get win()   { return cheatFrameWindow; },
  get state() { return aiFlagState; },
  activate()  { isProctoringActive = true; webcamStream = {}; videoElement = {}; },
  isActive()  { return isProctoringActive; },
  reset()     { resetAiDecisionState(); lastAiFlagAt = 0; },
  clearRefractory() { lastAiFlagAt = 0; },
  // The harness replays minutes of frames in milliseconds, so the 4 s transport
  // cooldown in reportViolation would mask decision-layer behaviour. Clearing it
  // isolates the sliding window, which is what these tests are about.
  clearCooldowns() { for (const k of Object.keys(violationCooldowns)) delete violationCooldowns[k]; },
  runOnce: runProctorInference,
  AI_WINDOW_FRAMES, AI_ARM_RATIO, AI_DISARM_RATIO,
};
`;

function load() {
  const ctx = makeContext();
  vm.createContext(ctx);
  // monitor.js reaches Supabase through window.SafeTestSupabase, which is a
  // separate manifest script loaded ahead of it. Load the REAL module here in
  // the same order the manifest declares, rather than stubbing it — a stub would
  // let a mistake in the REST payload mapping pass unnoticed.
  vm.runInContext(fs.readFileSync(REST_SRC, 'utf8'), ctx, { filename: 'supabase_rest.js' });
  vm.runInContext(fs.readFileSync(SRC, 'utf8') + SHIM, ctx, { filename: 'monitor.js' });

  const t = ctx.__t;
  t.activate();
  // frameSignature needs a canvas; force it to bail out so the stale-frame guard
  // is inert and every scripted frame reaches the classifier.
  ctx.window.predictFrame = null;
  return { ctx, t };
}

// Feed a sequence of booleans (true = cheating frame) through the real loop.
//
// The clock advances past CLASSIFIER_INTERVAL_MS between frames because the
// classifier is time-sliced now; without that only the first frame would ever
// reach it and the window would never fill.
async function feed(ctx, t, seq, prob = 0.9, stepMs = 3100) {
  let i = 0;
  ctx.window.isModelReady = () => true;
  ctx.window.getCheatThreshold = () => 0.5;
  ctx.window.predictFrame = async () => {
    const cheating = seq[i++];
    return {
      label: cheating ? 'cheating' : 'normal',
      confidence: prob,
      probs: { cheating: cheating ? prob : 1 - prob, normal: cheating ? 1 - prob : prob },
      inferenceMs: 5,
      croppedCanvas: null,
    };
  };
  for (let n = 0; n < seq.length; n++) {
    await t.runOnce();
    ctx.__clock += stepMs;
  }
}

const R = (n, v) => Array(n).fill(v);
let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

(async () => {
  {
    const { ctx, t } = load();
    console.log(`config: window=${t.AI_WINDOW_FRAMES} arm=${t.AI_ARM_RATIO} disarm=${t.AI_DISARM_RATIO} min=${t.AI_MIN_FRAMES_TO_DECIDE}\n`);
  }

  // ==========================================================================
  // CLASSIFIER CORROBORATION
  //
  // The binary classifier used to be the primary trigger and was the direct
  // cause of the false-positive reports: it has no representation of head
  // direction, so there is nothing in its output to calibrate against a
  // student's neutral, and a student who merely sits differently from the
  // training distribution gets flagged for sitting still.
  //
  // It is now a CORROBORATING signal only. Head-pose geometry decides; the
  // classifier can raise the severity of a pose-confirmed episode and can no
  // longer raise one by itself. These tests pin that contract down.
  //
  // No VisionEngine global exists in this harness, so the pose path is skipped
  // entirely and the classifier is genuinely isolated here.
  // ==========================================================================

  // 1. HEADLINE REGRESSION: the classifier alone must never accuse anyone.
  {
    const { ctx, t } = load();
    await feed(ctx, t, R(30, true)); // maximally incriminating input
    check('CLASSIFIER_ALONE: 30 cheating frames report NO violation', ctx.__violations.length, 0);
    check('CLASSIFIER_ALONE: corroboration state is armed', t.state, 'flagged');
  }

  // 2. Corroboration arms only on a full window at or above the arm ratio.
  {
    const { ctx, t } = load();
    await feed(ctx, t, [...R(3, false), ...R(7, true)]);
    check('7/10 cheating arms corroboration', t.state, 'flagged');
    check('arming still reports nothing', ctx.__violations.length, 0);
  }

  // 3. Below the arm ratio, corroboration stays clear.
  {
    const { ctx, t } = load();
    await feed(ctx, t, [...R(6, true), ...R(14, false)]);
    check('6/10 cheating leaves corroboration clear', t.state, 'clear');
  }

  // 4. A partial warm-up buffer never arms, however damning it looks.
  {
    const { ctx, t } = load();
    await feed(ctx, t, R(t.AI_WINDOW_FRAMES - 1, true));
    check('partial buffer does not arm corroboration', t.state, 'clear');
  }

  // 5. Corroboration disarms once the student is clearly normal again, so a
  //    stale arm cannot escalate an unrelated later episode.
  {
    const { ctx, t } = load();
    await feed(ctx, t, R(12, true));
    check('armed after sustained cheating frames', t.state, 'flagged');
    await feed(ctx, t, R(12, false));
    check('disarms after sustained normal frames', t.state, 'clear');
    check('no violations across the whole cycle', ctx.__violations.length, 0);
  }

  // 6. The classifier is time-sliced: replaying frames faster than
  //    CLASSIFIER_INTERVAL_MS must not fill the window. This is what keeps the
  //    640px model off the critical path on low-spec machines.
  {
    const { ctx, t } = load();
    await feed(ctx, t, R(30, true), 0.9, 0); // clock never advances
    check('time-sliced: a stalled clock never arms corroboration', t.state, 'clear');
  }

  // 7. The new detector violation types travel through the normal transport
  //    with the right severities.
  {
    const { ctx } = load();
    await ctx.reportViolation(ctx.ViolationType.PHONE_DETECTED, {
      aiConfidence: 0.82,
      metadata: { coco_class: 67, detector: 'yolo11n_coco' },
    });
    check('PHONE_DETECTED reports one violation', ctx.__violations.length, 1);
    check('PHONE_DETECTED is CRITICAL',
      /\[CRITICAL\] PHONE_DETECTED/.test(ctx.__violations[0].cheat_reason), true);
    check('detector confidence is carried through', ctx.__violations[0].cheat_probability, 0.82);
  }

  // 8. A sub-alert head movement is recorded at LOW severity, never escalated.
  {
    const { ctx } = load();
    await ctx.reportViolation(ctx.ViolationType.HEAD_POSE_GLANCE, {
      aiConfidence: 1.4,
      metadata: { axis: 'pitch', direction: 'down', dwell_ms: 1800 },
    });
    check('HEAD_POSE_GLANCE is LOW severity',
      /\[LOW\] HEAD_POSE_GLANCE/.test(ctx.__violations[0].cheat_reason), true);
  }

  // 9. Focus-loss coalescing: one Ctrl-Tab (blur + visibilitychange) = ONE
  //    violation, reported at the higher of the two severities.
  {
    const { ctx, t } = load();
    ctx.document.visibilityState = 'hidden';
    ctx.handleTabBlur();          // WINDOW_BLUR   (MEDIUM)
    ctx.handleVisibilityChange(); // VISIBILITY_HIDDEN (HIGH)
    await new Promise((r) => setTimeout(r, 400)); // let the coalesce window close
    check('blur + visibilitychange -> 1 violation', ctx.__violations.length, 1);
    check('coalesced report uses the higher severity',
      /VISIBILITY_HIDDEN/.test(ctx.__violations[0].cheat_reason), true);
  }

  // 10. A lone blur (Alt-Tab to another app) still reports.
  {
    const { ctx, t } = load();
    ctx.handleTabBlur();
    await new Promise((r) => setTimeout(r, 400));
    check('lone blur -> 1 violation', ctx.__violations.length, 1);
    check('lone blur reported as WINDOW_BLUR',
      /WINDOW_BLUR/.test(ctx.__violations[0].cheat_reason), true);
  }

  // 11. Screen-track mute is transient: it must NOT end the session on its own,
  //     and an unmute inside the grace window must cancel it entirely.
  {
    const { ctx, t } = load();
    ctx.handleScreenTrackMuted();
    check('mute alone does not immediately violate', ctx.__violations.length, 0);
    ctx.handleScreenTrackUnmuted();
    await new Promise((r) => setTimeout(r, 100));
    check('unmute inside grace -> still no violation', ctx.__violations.length, 0);
    check('unmute inside grace -> session still active', t.isActive(), true);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();

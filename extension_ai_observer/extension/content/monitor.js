// =============================================================================
// Proctoring Compliance Engine — AI Observer Extension
// Enterprise-grade monitoring with screen-share tab snapshots, fullscreen enforcement,
// violation taxonomy, quiz timing audit, and offline-first resilience.
// =============================================================================

console.log('[AI Observer] Proctoring Compliance Engine loaded.');

// ---------------------------------------------------------------------------
// Violation Taxonomy
// ---------------------------------------------------------------------------

/** @enum {string} */
const ViolationType = {
  TAB_SWITCH:           'TAB_SWITCH',
  FULLSCREEN_EXIT:      'FULLSCREEN_EXIT',
  SCREEN_SHARE_STOPPED: 'SCREEN_SHARE_STOPPED',
  WINDOW_BLUR:          'WINDOW_BLUR',
  VISIBILITY_HIDDEN:    'VISIBILITY_HIDDEN',
  AI_CHEATING_POSE:     'AI_CHEATING_POSE',
  // The trained whole-frame classifier (best.onnx) raising an alert on its own
  // evidence, rather than only corroborating a pose episode. Kept as a SEPARATE
  // type from AI_CHEATING_POSE on purpose: a teacher reviewing an incident must
  // be able to tell "head geometry measured this" from "a learned model thought
  // the frame looked wrong", because those warrant very different confidence.
  AI_CHEATING_CLASSIFIER: 'AI_CHEATING_CLASSIFIER',
  MULTIPLE_FACES:       'MULTIPLE_FACES',
  NO_FACE_DETECTED:     'NO_FACE_DETECTED',
  PHONE_DETECTED:       'PHONE_DETECTED',
  SECONDARY_DEVICE:     'SECONDARY_DEVICE',
  // Eyes held off-axis while the HEAD stayed inside its calibrated neutral
  // band — the one thing head pose structurally cannot see. Capped at MEDIUM:
  // the signal is coarse by construction (see gaze_roi.js), and it is only ever
  // raised on an open, readable pair of eyes. Closed eyes cannot reach it.
  GAZE_OFF_SCREEN:      'GAZE_OFF_SCREEN',
  // Iris parked off-axis while the head stayed square to the camera, measured
  // from landmark geometry (gaze_landmarks.js) rather than pixel darkness.
  // Kept SEPARATE from GAZE_OFF_SCREEN so a reviewer can tell which instrument
  // produced the claim — they have very different reliability.
  SIDE_GAZE_PEEKING:    'SIDE_GAZE_PEEKING',
  DOWNWARD_GAZE_LOOKAWAY: 'DOWNWARD_GAZE_LOOKAWAY',
  // The student's head did not move toward the corner target within the
  // response window, after 45 s+ of unnaturally static pose. Consistent with a
  // photograph or a looped/frozen video feed in front of the camera.
  LIVENESS_FAILED:      'LIVENESS_FAILED',
  // Two-tier confirmation: the feed stopped producing new pixels AND the
  // subject could not answer an unpredictable corner prompt. Either signal
  // alone is explainable; together they are not.
  CAMERA_FEED_SYNTHETIC: 'CAMERA_FEED_SYNTHETIC',
  // Sub-alert head movement. Recorded for review, never escalated on its own —
  // this is what a 1.5-2.5 s glance produces instead of an accusation.
  HEAD_POSE_GLANCE:     'HEAD_POSE_GLANCE',
};

/** @enum {string} */
const Severity = {
  LOW:      'LOW',
  MEDIUM:   'MEDIUM',
  HIGH:     'HIGH',
  CRITICAL: 'CRITICAL',
};

/** Maps violation types to their default severity. */
const VIOLATION_SEVERITY = {
  [ViolationType.TAB_SWITCH]:           Severity.HIGH,
  [ViolationType.FULLSCREEN_EXIT]:      Severity.CRITICAL,
  [ViolationType.SCREEN_SHARE_STOPPED]: Severity.CRITICAL,
  [ViolationType.WINDOW_BLUR]:          Severity.MEDIUM,
  [ViolationType.VISIBILITY_HIDDEN]:    Severity.HIGH,
  [ViolationType.AI_CHEATING_POSE]:     Severity.HIGH,
  [ViolationType.AI_CHEATING_CLASSIFIER]: Severity.HIGH,
  [ViolationType.MULTIPLE_FACES]:       Severity.MEDIUM,
  [ViolationType.NO_FACE_DETECTED]:     Severity.MEDIUM,
  [ViolationType.PHONE_DETECTED]:       Severity.CRITICAL,
  [ViolationType.SECONDARY_DEVICE]:     Severity.HIGH,
  [ViolationType.GAZE_OFF_SCREEN]:      Severity.MEDIUM,
  // MEDIUM ceiling, same as GAZE_OFF_SCREEN and for the same reason: the signal
  // resolves left/centre/right, not point-of-regard. Never CRITICAL.
  [ViolationType.SIDE_GAZE_PEEKING]:    Severity.MEDIUM,
  // Sustained downward gaze — reading a phone or notes below the camera.
  // MEDIUM like the rest of the gaze family; gaze_fusion may raise a single
  // episode to HIGH when the classifier independently agrees, never CRITICAL.
  [ViolationType.DOWNWARD_GAZE_LOOKAWAY]: Severity.MEDIUM,
  [ViolationType.HEAD_POSE_GLANCE]:     Severity.LOW,
  [ViolationType.LIVENESS_FAILED]:      Severity.CRITICAL,
  [ViolationType.CAMERA_FEED_SYNTHETIC]: Severity.CRITICAL,
};

// ---------------------------------------------------------------------------
// State Variables
// ---------------------------------------------------------------------------

let isProctoringActive = false;
let webcamStream = null;
let screenStream = null;
let screenVideoElement = null; // Hidden video element bound to screenStream for tab/screen snapshots

/**
 * Guest demo session (anonymous /demo-quiz visitor) rather than a real exam.
 *
 * ⚠ THIS EXISTS BECAUSE GUEST MODE HAS NO USER GESTURE TO SPEND.
 *
 * A real exam starts from a click on the consent gate, and that click's transient
 * activation is what getDisplayMedia() and requestFullscreen() require. Guest
 * mode deliberately bypasses the gate (there is no screen recording to consent
 * to), so it starts from a chrome.storage change callback, which carries no
 * activation at all. Requesting screen capture there does not merely fail to
 * share the screen: the rejection propagates into the setup catch, which sets
 * isProctoringActive = false and stops the webcam — so the entire vision
 * pipeline never runs a single tick and the demo silently shows nothing.
 *
 * A guest session is therefore WEBCAM-ONLY. Everything driven by the webcam —
 * pose, gaze, phone detection, liveness — is unaffected; only the screen-share
 * signals are absent, and those are the ones a demo does not need.
 */
let guestSessionMode = false;

// ---------------------------------------------------------------------------
// Extension context validity
//
// ⚠ THE CONTENT SCRIPT OUTLIVES THE EXTENSION THAT INJECTED IT.
//
// Reloading the extension (or an update, or a crash) destroys the background
// context while this script keeps running in a page that is still open. Every
// chrome.* call then throws `Extension context invalidated` — including the
// storage writes inside the inference loop, which turns one orphaned tab into a
// throw per frame. `chrome.runtime.id` is the documented liveness probe: it is
// undefined precisely when the context is gone.
//
// Callers must not treat `false` as "try again later". It is terminal for this
// page — nothing revives an orphaned content script — so the correct response is
// to release the camera and stop, which `handleContextInvalidated()` does.
// ---------------------------------------------------------------------------

let contextInvalidatedHandled = false;

/** @returns {boolean} True while chrome.* is still callable from this page. */
function extensionContextAlive() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    // Touching chrome.runtime can itself throw once the context is torn down.
    return false;
  }
}

/**
 * Terminal teardown for an orphaned content script.
 *
 * Runs at most once and must never throw: it is called from catch blocks and
 * from the inference loop, and a throw here would defeat the guard it belongs
 * to. It deliberately does NOT call stopProctoring() — that path writes to
 * chrome.storage and posts to the worker, both of which are exactly what is
 * unavailable now. The camera is what actually matters to the person whose tab
 * this is, so it is released directly.
 */
function handleContextInvalidated(where) {
  if (contextInvalidatedHandled) return;
  contextInvalidatedHandled = true;

  console.warn(
    `[AI Observer] Extension context invalidated (${where}). `
    + 'Releasing camera and detaching listeners — reload the page to resume.'
  );

  isProctoringActive = false;

  try { if (inferenceTimer) { clearTimeout(inferenceTimer); inferenceTimer = null; } } catch (e) {}
  try { if (heartbeatInterval) clearInterval(heartbeatInterval); } catch (e) {}
  try { if (screenTrackPollInterval) clearInterval(screenTrackPollInterval); } catch (e) {}
  try { if (navigationWatchInterval) clearInterval(navigationWatchInterval); } catch (e) {}
  try { if (focusLossTimer) { clearTimeout(focusLossTimer); focusLossTimer = null; } } catch (e) {}

  for (const s of [webcamStream, screenStream, preflightWebcamStream]) {
    try { if (s) s.getTracks().forEach((t) => t.stop()); } catch (e) {}
  }
  webcamStream = null;
  screenStream = null;
  preflightWebcamStream = null;

  try { document.removeEventListener('fullscreenchange', handleFullscreenChange); } catch (e) {}
  try { document.removeEventListener('visibilitychange', handleVisibilityChange); } catch (e) {}
  try { window.removeEventListener('blur', handleTabBlur); } catch (e) {}
  try { window.removeEventListener('focus', handleTabFocus); } catch (e) {}
  try { window.removeEventListener('beforeunload', handleBeforeUnload); } catch (e) {}

  try { removeFloatingWidget(); } catch (e) {}
  try { removeProctoringConsentGate(); } catch (e) {}
  try { removeFullscreenPromptOverlay(); } catch (e) {}
}

/**
 * chrome.runtime.sendMessage that cannot throw into the caller.
 * @returns {boolean} True if the message was handed to the runtime.
 */
function safeSendMessage(message, where = 'sendMessage') {
  if (!extensionContextAlive()) { handleContextInvalidated(where); return false; }
  try {
    const p = chrome.runtime.sendMessage(message);
    // MV3 returns a promise when no callback is passed; an unhandled rejection
    // here surfaces as a console error the operator cannot act on.
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return true;
  } catch (e) {
    handleContextInvalidated(where);
    return false;
  }
}

/** chrome.storage.local.set that cannot throw into the caller. */
function safeStorageSet(items, where = 'storageSet') {
  if (!extensionContextAlive()) { handleContextInvalidated(where); return false; }
  try {
    chrome.storage.local.set(items);
    return true;
  } catch (e) {
    handleContextInvalidated(where);
    return false;
  }
}

/** chrome.storage.local.get that cannot throw into the caller. */
function safeStorageGet(keys, cb, where = 'storageGet') {
  // Callers read fields straight off the result, so the failure value is an
  // empty object rather than null — a guard that turns a chrome.* throw into a
  // TypeError one line later has not helped anyone.
  if (!extensionContextAlive()) { handleContextInvalidated(where); cb({}); return false; }
  try {
    chrome.storage.local.get(keys, (data) => cb(data || {}));
    return true;
  } catch (e) {
    handleContextInvalidated(where);
    cb({});
    return false;
  }
}

let heartbeatInterval = null;
let screenTrackPollInterval = null;

let studentName = '';
let studentId = '';
let sessionCode = '';
// ⚠ STILL PRESENT, AND STILL NEEDED — but ONLY for model delivery.
// `secure_loader.js` fetches the chunked, XOR-obfuscated, SHA-256-verified ONNX
// weights from this host; Supabase Storage has no equivalent protocol, so that
// path deliberately stays on FastAPI. Every piece of *telemetry* — auth,
// sessions, heartbeats, violations — now goes to Supabase instead. Do not
// reintroduce a telemetry POST against this URL.
let serverUrl = 'http://localhost:8000';

/** The public.proctor_sessions row this sitting is writing to. */
let proctorSessionId = null;

/** The institution's own student number, when the ProctorCode asked for one.
 *  ⚠ A LABEL FOR THE REGISTRAR, NEVER AN IDENTITY — RLS compares `student_id`
 *  (the auth.users uuid), never this. */
let studentUniversityId = null;

// Timing audit timestamps
let proctorStartedAtIso = null;
let monitorQuizOpenedAtIso = null;
let timingStatus = 'ON_TIME_BEFORE_QUIZ';

// Quiz page guard — the URL where proctoring was started
let quizPageUrl = null;
let navigationWatchInterval = null;

// UI References
let floatingWidget = null;
let videoElement = null;
let statusDot = null;
let statusLabel = null;
let violationCounter = null;

// Inference cadence. These are the DEFAULTS used before the hardware probe
// resolves; runtime_profile.js then replaces them with the tier's budget
// (Tier A ~20 FPS, Tier B ~9 FPS) in applyRuntimeProfile(). They are `let`
// rather than `const` for exactly that reason.
let proctorIntervalMs = 1000;  // Target cadence between inference STARTS
let proctorMinGapMs = 150;     // Floor so a slow device never busy-loops
/** @type {object|null} Resolved runtime profile, once known. */
let runtimeProfile = null;
const HEARTBEAT_INTERVAL_MS = 10000;
const SCREEN_TRACK_POLL_MS = 2000;
const VIOLATION_COOLDOWN_MS = 4000;

// A screen track 'mute' is TRANSIENT (OS screen lock, display sleep, GPU process
// recovery, some RDP/multi-monitor transitions) and is normally followed by
// 'unmute'. Treating it as an immediate stop terminated honest students' exams
// unrecoverably, so escalate only if the track does not come back.
const SCREEN_MUTE_GRACE_MS = 3000;

// A single Ctrl-Tab fires BOTH window 'blur' and 'visibilitychange'. Cooldowns
// are keyed per violation type, so both used to land and one action inflated the
// count by two. Coalesce them into a single report that keeps the highest
// severity cause observed in the window.
const FOCUS_LOSS_COALESCE_MS = 300;

// Offline queue caps. chrome.storage.local is 10 MB without 'unlimitedStorage';
// screen snapshots are the dominant cost, so bound both the queue length and how
// many entries keep their image payload.
const OFFLINE_QUEUE_MAX = 40;
const OFFLINE_QUEUE_SNAPSHOT_KEEP = 15;

// Snapshot resolution caps. Screen shares are captured at native monitor
// resolution (often 1920x1080), which produced ~200-400 KB of base64 per
// violation and exhausted the storage quota after ~30 queued events.
const SNAPSHOT_MAX_EDGE_WEBCAM = 640;
const SNAPSHOT_MAX_EDGE_SCREEN = 960;

// ---------------------------------------------------------------------------
// Camera AI decision layer — SLIDING window with hysteresis.
//
// The previous design was a TUMBLING window of randomised length (6-10 frames)
// decided by simple majority. Two problems it had:
//   1. Boundary blindness — a sustained look-away straddling a window boundary
//      could split 3/3 across two windows and reach a majority in neither.
//   2. The randomised length made the effective threshold non-deterministic
//      (4-of-6 vs 6-of-10 for identical behaviour), so the operating point was
//      unreportable and false positives were not reproducible.
//
// Now: a fixed-length ring buffer evaluated every frame. Arm above ARM_RATIO,
// disarm below DISARM_RATIO. The gap between them is the hysteresis band that
// stops a borderline student flapping in and out of "flagged".
// ---------------------------------------------------------------------------
// Verdicts are only reached on a FULL window, so at 1 FPS the first possible
// flag is ~10 s into the session and arming requires ~7 s of sustained
// classification. That is deliberately stricter than the old 4-of-6 majority.
const AI_WINDOW_FRAMES = 10;     // ~10 s of context at 1 FPS
const AI_ARM_RATIO = 0.7;        // >=70% cheating frames -> flag
const AI_DISARM_RATIO = 0.3;     // <=30% -> return to clear
const AI_MIN_REFLAG_MS = 15000;  // Refractory between consecutive AI flags

/** @type {Array<{prob: number, cheating: boolean}>} */
let cheatFrameWindow = [];
/** @type {'clear'|'flagged'} */
let aiFlagState = 'clear';
let lastAiFlagAt = 0;
/** Highest-P(cheating) evidence frame for the current episode. @type {{prob:number, snapshot:string|null}|null} */
let bestEvidence = null;

// ---------------------------------------------------------------------------
// NO_FACE dwell — "continuously absent for 2.0 s".
//
// Absence is measured by the SAME per-frame predicate the pipeline already
// uses: `!faceReadable` in pose_pipeline.js, i.e. the frame produced no usable
// face geometry. With MediaPipe as the keypoint source (the normal path now),
// persons are projected from FaceMesh output, so "no readable face" IS "FaceMesh
// found no face" — the quantity the brief asks about, not a proxy for it.
//
// ⚠ CONFIGURATION, NOT NEW CODE, AND DELIBERATELY SO. pose_pipeline.js and
// temporal_gate.js are frozen (CLAUDE.md §5) and DwellGate already implements
// exactly this state machine, with the continuity protections a hand-rolled
// timer would have to re-earn: maxSampleGapMs stops two samples 6 s apart
// claiming 6 s of continuous absence, and the episode is anchored to the first
// absent frame rather than to a counter that a variable frame rate would skew.
// Re-implementing it in monitor.js would fork the semantics.
//
// Three deliberate values:
//
//   alertMs 2000   The brief's threshold. DwellGate tests alertMs BEFORE
//                  glanceMs, so with glanceMs at the same value the LOW glance
//                  tier is unreachable and 2.0 s produces exactly ONE HIGH
//                  event — which is what handlePoseEvents reports. Previously
//                  alertMs was 5000, so a student out of frame was not reported
//                  for five seconds.
//
//   graceMs 0      The brief: "if a face reappears before the 2.0-second
//                  threshold breaches, reset the timer to 0 immediately". The
//                  default 800 ms grace does the opposite — it holds the episode
//                  open across a brief reappearance so the dwell keeps
//                  accumulating. Zero makes one readable frame end the episode,
//                  which is both what was asked and the direction that favours
//                  the student.
//
//   minRealertMs   Kept at 20 s. Without it a student who steps away for two
//                  minutes generates an alert every 2 s, which buries the
//                  incident log rather than informing it.
// ---------------------------------------------------------------------------
const NO_FACE_GATE = {
  glanceMs: 2000,
  alertMs: 2000,
  graceMs: 0,
  minRealertMs: 20000,
};

// ---------------------------------------------------------------------------
// Evidence ring buffer — the frame a violation is ILLUSTRATED with.
//
// Every gated detector reports 2.5-3 s after the behaviour started, so a live
// snapshot at report time routinely shows a student who has already returned to
// neutral. This holds ~4 s of scored frames so the alert can carry the frame
// that actually earned it. See evidence_buffer.js for why entries are strings
// and why encoding is lazy.
// ---------------------------------------------------------------------------
/** @type {EvidenceRingBuffer|null} */
let evidenceBuffer = null;
/** @type {GazeClassifierFusion|null} */
let gazeFusion = null;
/** @type {DownwardGazeDetector|null} */
let downwardGaze = null;
/**
 * Identity of the last landmark sample seen, and when it was first seen. Used
 * ONLY to age `analyzer.lastSample`, which the analyser never clears — see
 * handleDownwardGaze. Not a cache: the value is always read fresh off the
 * analyser, and these two only answer "how old is that reading".
 */
let _downSampleRef = null;
let _downSampleAtMs = NaN;
/**
 * Raw p_cheating awaiting the next evidence capture. One-shot by design: the
 * classifier runs every 3-6 s, and holding its value across the frames in
 * between would score them all identically and destroy the peak ranking.
 */
let _pCheatingFresh = NaN;

// ---------------------------------------------------------------------------
// Vision engine — head pose (every frame) + phone detection (time-sliced).
//
// The binary classifier is NO LONGER a primary trigger. It is a whole-frame
// cheating/normal model with no notion of where the head is pointing, and it is
// the direct cause of the "I looked straight at the camera and got flagged"
// reports: it cannot be calibrated, because there is no angle in its output to
// re-centre. Geometry from the pose model decides now, and the classifier only
// corroborates — it can raise the severity of a pose-confirmed episode, never
// raise one by itself.
//
// It is also time-sliced. At 640x640 it was the single most expensive thing in
// the loop; as a corroborating signal it does not need to run every frame.
// ---------------------------------------------------------------------------
let classifierIntervalMs = 3000; // Tier-adjusted in applyRuntimeProfile()
const USE_CLASSIFIER_CORROBORATION = true;

/**
 * Let the classifier raise AI_CHEATING_CLASSIFIER on its OWN evidence, instead
 * of only corroborating a pose-confirmed episode.
 *
 * ⚠ THIS IS SAFETY-COUPLED TO THE EAR VETO. Read before changing.
 *
 * The classifier was demoted because it produced two distinct false positives:
 *
 *   (a) eyes closed          -> flagged
 *   (b) sitting still, facing the camera, just differently from the training
 *       distribution -> flagged  ("I looked straight at the camera and got
 *       flagged")
 *
 * The EAR veto removes (a) and ONLY (a). Nothing here addresses (b) — that one
 * is a property of the weights, and the honest fix is retraining with the
 * offending frames labelled correctly. Promoting the classifier therefore
 * accepts (b) as a known, deliberate risk in exchange for catching behaviour
 * head-pose geometry cannot see.
 *
 * Because the exception is "unless MediaPipe says the eyes are closed", the
 * rule is UNIMPLEMENTABLE when MediaPipe is not running: the veto fails open,
 * so promotion without it would resurrect (a) in full. classifierMayAlertAlone()
 * enforces that coupling rather than trusting a comment to be read.
 */
const CLASSIFIER_PRIMARY = true;

/** @type {VisionEngine|null} */
let visionEngine = null;
// -Infinity, not 0: the first frame must always run the corroborating
// classifier regardless of where the clock's origin happens to sit.
let lastClassifierRunMs = -Infinity;

// ---------------------------------------------------------------------------
// Phone state — LATCH AND HOLD, not dwell.
//
// The phone detector previously shared the second-screen dwell gate: a phone
// had to survive ~3 s across two detection rounds before it was reported. That
// is the correct model for a laptop or a TV, which sit in the room for the
// whole exam. It is the WRONG model for a phone, because the actual cheating
// behaviour is a 1-5 frame glance — at ~20 FPS that is 250 ms, and no dwell
// gate on earth will ever see it.
//
// So the phone path is inverted. The detector runs on EVERY frame, the
// confidence floor and the aspect-ratio guard do the false-positive work
// up front (see PHONE_SHAPE_DEFAULTS), and the first frame that clears both
// latches instantly. PHONE_DETECTED then stays true for at least 45 frames AND
// 1.5 s so a fast hide cannot erase the alert or the evidence snapshot.
//
// The tradeoff is explicit: precision now rests on the confidence + shape gate
// rather than on temporal persistence. Lowering that confidence floor without
// restoring a dwell requirement WILL produce false accusations.
// ---------------------------------------------------------------------------
/** @type {boolean} True while a phone alert is latched. Read via getPhoneDetected(). */
let PHONE_DETECTED = false;
/** Best evidence frame captured during the current latched episode. */
let lastPhoneEvidence = null;
/** Frames processed since proctoring started; used for latch diagnostics. */
let phoneFrameIndex = 0;

// Laptops / TVs are standing objects, so they keep the dwell gate — a monitor
// visible for 4 s is meaningful, a monitor visible for one frame is a decoding
// artifact.
let deviceGate = null;

// ---------------------------------------------------------------------------
// Active liveness — anti-spoofing.
//
// Every other detector in this file answers "where is the head pointing?". A
// photograph taped in front of the webcam answers that perfectly, forever, and
// would sail through the entire pipeline. The liveness manager watches for a
// pose that is TOO static to be human (peak-to-peak < 1 deg for 45 s+), then
// puts a dot in a screen corner and checks the head actually pivots to it.
//
// It runs on the yaw/pitch the pose pipeline already computes — no extra model,
// no extra inference. See content/liveness_challenge.js.
// ---------------------------------------------------------------------------
/** @type {LivenessChallengeManager|null} */
let livenessManager = null;

/**
 * Cascading safeguard. Consulted by reportViolation() for every violation, and
 * by classifierCorroborates() before the classifier is allowed to escalate.
 *
 * Constructed unconditionally — it is harmless without landmarks because an
 * absent sample fails OPEN, which is exactly today's behaviour.
 * @type {EarVetoGate|null}
 */
let earVetoGate = (typeof EarVetoGate !== 'undefined') ? new EarVetoGate() : null;

// ---------------------------------------------------------------------------
// PRE-EXAM LIGHTING READINESS GATE
//
// Samples the webcam at 5 FPS during setup and withholds the Start button until
// the room is usable. It is a READINESS GATE, NOT A DETECTOR: it never calls
// reportViolation and has no entry in ViolationType. See content/lighting_checker.js.
//
// The stream acquired here is handed to beginProctoringSession() rather than
// re-requested, so the student sees one camera prompt, not two.
// ---------------------------------------------------------------------------
/** @type {LightingChecker|null} */
let lightingChecker = null;
/** @type {MediaStream|null} Webcam opened by the lighting stage, before the session. */
let preflightWebcamStream = null;
/** @type {HTMLVideoElement|null} Preview element the checker samples from. */
let preflightVideoEl = null;
/**
 * Lighting reading captured at the moment the student left the setup stage.
 * Sent once with the join payload so a teacher reviewing a poor-quality session
 * can see the room was flagged at setup.
 *
 * ⚠ TELEMETRY ONLY. This is not a violation, is never shown as one, and the
 * student proceeded regardless of what it says.
 * @type {object|null}
 */
let lightingSetupTelemetry = null;

let totalViolationCount = 0;

// Inference scheduling. A bare setInterval had no in-flight guard: if one
// inference exceeded the interval, calls queued without bound, each holding its
// own multi-MB input tensor while ORT serialised them on a single WASM thread.
// A self-scheduling timeout measured from COMPLETION makes overlap structurally
// impossible.
let inferenceInFlight = false;
let inferenceTimer = null;
let lastInferenceMs = 0;
let slowInferenceWarned = false;

// Frozen-feed detection: a stuck webcam frame would be classified identically
// forever, so if it froze on a "cheating" pose it would flag nonstop. Checked
// BEFORE inference now — the old order paid full inference cost on frames it was
// about to discard.
let lastFrameSignature = null;
let staleFrameCount = 0;
let _sigCanvas = null;
let _sigCtx = null;
// Previous 32x32 RGB downsample, for the Tier-1 pixel-delta measurement.
let _prevFramePixels = null;
let _hasPrevFrame = false;

// Screen-share mute grace timer (see SCREEN_MUTE_GRACE_MS).
let screenMuteTimer = null;

// Focus-loss coalescing state (see FOCUS_LOSS_COALESCE_MS).
let focusLossTimer = null;
let focusLossPending = null;

const violationCooldowns = {};
let offlineQueue = [];

// ---------------------------------------------------------------------------
// Telemetry Payload Builder
// ---------------------------------------------------------------------------

function buildTelemetryPayload(violationType, options = {}) {
  // severityOverride lets a detector escalate a specific instance above its
  // type's baseline — e.g. a head-pose episode that the independent classifier
  // also flagged. Two agreeing signals is a materially stronger claim than
  // either alone, and that has to reach the payload, not just the metadata.
  const severity = options.severityOverride || VIOLATION_SEVERITY[violationType] || Severity.MEDIUM;

  return {
    violation_type: violationType,
    severity: severity,
    timestamp_iso: new Date().toISOString(),
    session_code: sessionCode,
    student_id_str: studentId,
    student_name: studentName,
    ai_confidence: options.aiConfidence || null,
    snapshot_b64: options.snapshotB64 || null,
    // Alias of snapshot_b64 under the name the evidence spec uses. Added
    // rather than renamed: `snapshot_b64` is what backend/main.py and the
    // teacher dashboard already read, and renaming it would silently blank
    // every incident image in the UI. For a gated violation this frame is the
    // episode's MAX(p_cheating) frame, not the frame at report time — see
    // peakEvidenceFor().
    evidence_snapshot: options.snapshotB64 || null,
    metadata: options.metadata || {},
    page_url: window.location.href,
    execution_provider: window.getExecutionProvider ? window.getExecutionProvider() : 'unknown',
    timing_status: timingStatus,
    quiz_opened_at: monitorQuizOpenedAtIso,
    proctor_started_at: proctorStartedAtIso,
  };
}

// ---------------------------------------------------------------------------
// Cooldown Deduplication
// ---------------------------------------------------------------------------

function isOnCooldown(violationType) {
  const lastTime = violationCooldowns[violationType];
  if (!lastTime) return false;
  return (Date.now() - lastTime) < VIOLATION_COOLDOWN_MS;
}

function markCooldown(violationType) {
  violationCooldowns[violationType] = Date.now();
}

// ---------------------------------------------------------------------------
// Snapshot Capture (Webcam vs Screen Share Stream)
// ---------------------------------------------------------------------------

/**
 * Draw a media element into a JPEG data URL, downscaled so its longest edge is
 * at most maxEdge. Bounding the resolution is what keeps the offline queue
 * inside the chrome.storage.local quota — a native-resolution screen grab is
 * ~10x the bytes of a 960px one and adds nothing for human review.
 *
 * @param {HTMLVideoElement} source
 * @param {number} maxEdge - Longest-edge cap in pixels.
 * @param {number} quality - JPEG quality 0-1.
 * @returns {string|null} data URL, or null if the source has no dimensions.
 */
// One canvas for every snapshot, reused.
//
// This used to allocate a fresh <canvas> per capture. Each one is a GPU-backed
// surface the compositor holds until GC gets to it, and captures are bursty —
// a focus loss, a phone latch and a pose alert inside the same second meant
// three full-size surfaces churned at once, on the machine least able to afford
// it. Same reasoning as onnx_inference.js's frame buffers.
//
// SAFETY: sound only because every caller is synchronous — drawImage and
// toDataURL both complete before the function returns, so no two captures can
// share the surface. Do NOT make this async or hand the canvas to a caller.
let _snapCanvas = null;
let _snapCtx = null;

function drawScaledToDataURL(source, maxEdge, quality) {
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  if (!w || !h) return null;

  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  if (!_snapCanvas) {
    _snapCanvas = document.createElement('canvas');
    _snapCtx = _snapCanvas.getContext('2d');
  }
  // Assigning width/height also clears the surface, so a smaller frame cannot
  // leave the previous, larger capture's pixels around its edges.
  if (_snapCanvas.width !== cw || _snapCanvas.height !== ch) {
    _snapCanvas.width = cw;
    _snapCanvas.height = ch;
  } else {
    _snapCtx.clearRect(0, 0, cw, ch);
  }

  _snapCtx.drawImage(source, 0, 0, cw, ch);
  return _snapCanvas.toDataURL('image/jpeg', quality);
}

/**
 * Capture a snapshot of the student's WEBCAM (face feed).
 * Used for AI pose and facial cheating detections.
 */
function captureWebcamSnapshot(quality = 0.7) {
  if (!videoElement) return null;
  try {
    return drawScaledToDataURL(videoElement, SNAPSHOT_MAX_EDGE_WEBCAM, quality);
  } catch (err) {
    console.error('[AI Observer] Webcam snapshot failed:', err);
    return null;
  }
}

/**
 * Offer the current frame to the evidence ring buffer.
 *
 * Called once per processed pose frame, BEFORE any handler can report. The
 * buffer applies its own throttle and score floor, so most calls cost two
 * comparisons and never touch the canvas — the JPEG encode is behind a thunk
 * and only runs for admitted frames.
 *
 * ⚠ The score ranks frames INSIDE an episode. It is not a detection threshold
 * and nothing may be reported or suppressed because of it; every decision about
 * whether a violation occurred stays with the detectors and their dwell gates.
 *
 * @param {object|null} poseResult - HeadPoseAnalyzer output for this frame.
 * @param {number} nowMs
 */
function captureEvidenceFrame(poseResult, nowMs) {
  if (!evidenceBuffer || !poseResult || typeof evidenceScore !== 'function') return;

  // Gaze excursion from whichever analyser produced one this frame. Landmark
  // gaze is preferred: it measures ratios of landmark distances, where the pixel
  // path measures darkness and failed field testing on lighting and skin tone.
  const landmarkGaze = poseResult.landmarkGaze;
  const pixelGaze = poseResult.gaze;
  const gazeExcursion = (landmarkGaze && Number.isFinite(landmarkGaze.smoothedExcursion))
    ? landmarkGaze.smoothedExcursion
    : ((pixelGaze && Number.isFinite(pixelGaze.smoothedExcursion))
      ? pixelGaze.smoothedExcursion
      : NaN);

  // p_cheating from the classifier, but ONLY on the frame it was actually
  // produced. It is time-sliced at 3-6 s, so carrying the value forward would
  // give every frame in between an identical score and flatten exactly the
  // ranking this buffer exists to provide. `_pCheatingFresh` is set by the
  // classifier block and consumed once, here.
  const pCheating = Number.isFinite(_pCheatingFresh) ? _pCheatingFresh : NaN;
  _pCheatingFresh = NaN;

  const scored = evidenceScore({
    poseExcursion: poseResult.smoothedExcursion,
    gazeExcursion,
    classifierProb: pCheating,
  });

  evidenceBuffer.capture(nowMs, { ...scored, pCheating }, () => captureWebcamSnapshot(0.8));
}

/**
 * Best available evidence image for an episode that began `dwellMs` ago.
 *
 * Falls back to a live snapshot whenever the buffer holds nothing for the
 * window — a missing history must degrade to the previous behaviour, never to
 * an alert with no image at all.
 *
 * @param {number} nowMs
 * @param {number} dwellMs - Reported dwell of the episode.
 * @param {number} [quality=0.8]
 * @returns {{image: string|null, evidence: object|null}}
 */
function peakEvidenceFor(nowMs, dwellMs, quality = 0.8) {
  const live = () => ({ image: captureWebcamSnapshot(quality), evidence: null });
  if (!evidenceBuffer) return live();

  // Reach back over the whole episode plus a margin. The margin matters: dwell
  // is measured from the first DEVIANT sample, while the behaviour that produced
  // it usually starts a frame or two earlier, and the smoother's own 1200 ms
  // window means the excursion was already climbing before it crossed.
  const since = Number.isFinite(dwellMs) ? nowMs - dwellMs - 1200 : -Infinity;

  // MAX(p_cheating) across the episode wins when the classifier actually ran
  // inside the window. It is the raw model score the brief asks for, and it
  // beats the geometry ranking because it is the same quantity a reviewer sees
  // in `aiConfidence`. The classifier is time-sliced at 3-6 s, though, so most
  // short episodes contain no scored frame at all — hence the fallback, and
  // hence `basis` recording which one was used rather than leaving a reviewer
  // to guess whether 0.91 came from a model or from head geometry.
  const byCheating = evidenceBuffer.peakCheatingSince(since);
  const peak = (byCheating && byCheating.image) ? byCheating : evidenceBuffer.peakSince(since);
  if (!peak || !peak.image) return live();

  return {
    image: peak.image,
    evidence: {
      basis: byCheating ? 'p_cheating' : 'geometry',
      peak_score: Number(peak.score.toFixed(3)),
      p_cheating: Number.isFinite(peak.pCheating) ? Number(peak.pCheating.toFixed(3)) : null,
      source: peak.source,
      age_ms: Math.round(nowMs - peak.t),
      buffered: evidenceBuffer.size,
    },
  };
}

/**
 * Capture a snapshot of the student's SCREEN SHARE STREAM (tab/page contents).
 * Used for Tab Switches, Fullscreen Exits, Window Blurs, and Screen Violations.
 */
function captureScreenSnapshot(quality = 0.6) {
  if (!screenVideoElement) return captureWebcamSnapshot(quality);

  try {
    const shot = drawScaledToDataURL(screenVideoElement, SNAPSHOT_MAX_EDGE_SCREEN, quality);
    return shot || captureWebcamSnapshot(quality);
  } catch (err) {
    console.error('[AI Observer] Screen snapshot failed, falling back to webcam:', err);
    return captureWebcamSnapshot(quality);
  }
}

// ---------------------------------------------------------------------------
// Timing & Audit Calculations
// ---------------------------------------------------------------------------

/**
 * Calculate proctoring timing compliance status.
 * Determines if proctoring started BEFORE opening the quiz, AT the time of opening,
 * or LATE (after student opened/started the quiz).
 */
function calculateTimingCompliance() {
  proctorStartedAtIso = new Date().toISOString();

  // ⚠ A GUEST SESSION ALWAYS STARTS ITS OWN CLOCK.
  //
  // `quizOpenedAtIso` is PERSISTENT and deliberately sticky: lms_detector.js
  // adopts an existing stamp rather than re-stamping, so a paginated quiz that
  // reloads per question keeps one baseline. That is right for an exam and
  // wrong for a demo — the second visit to /demo-quiz inherited the FIRST
  // visit's stamp, so the gap was however long ago that was, and every repeat
  // visitor was greeted with "LATE PROCTORING DETECTED".
  //
  // There is also no such thing as late proctoring here: the guest demo starts
  // proctoring and the quiz in the same action, so the honest baseline is now.
  if (guestSessionMode) {
    monitorQuizOpenedAtIso = proctorStartedAtIso;
    timingStatus = 'ON_TIME_AT_QUIZ';
    // Keep storage consistent with the value in play, so anything reading the
    // key later (including a subsequent re-entry) sees this session's baseline
    // rather than a stamp from an earlier visit.
    try { safeStorageSet({ quizOpenedAtIso: proctorStartedAtIso }); } catch (e) {}
    return;
  }

  // Try to get quiz opened timestamp
  if (window.getQuizOpenedTimestamp) {
    monitorQuizOpenedAtIso = window.getQuizOpenedTimestamp();
  }

  if (!monitorQuizOpenedAtIso) {
    safeStorageGet(['quizOpenedAtIso'], (data) => {
      if (data.quizOpenedAtIso) {
        monitorQuizOpenedAtIso = data.quizOpenedAtIso;
        evaluateTimingDifference();
      } else {
        timingStatus = 'ON_TIME_BEFORE_QUIZ';
      }
    });
  } else {
    evaluateTimingDifference();
  }

  function evaluateTimingDifference() {
    if (!monitorQuizOpenedAtIso) {
      timingStatus = 'ON_TIME_BEFORE_QUIZ';
      return;
    }

    const quizTime = new Date(monitorQuizOpenedAtIso).getTime();
    const proctorTime = new Date(proctorStartedAtIso).getTime();
    const diffSeconds = (proctorTime - quizTime) / 1000;

    if (diffSeconds < -5) {
      // Proctoring started BEFORE opening quiz
      timingStatus = 'ON_TIME_BEFORE_QUIZ';
    } else if (diffSeconds <= 60) {
      // Proctoring started within 60s of opening quiz
      timingStatus = 'ON_TIME_AT_QUIZ';
    } else {
      // Proctoring started >60s AFTER opening quiz (LATE PROCTORING)
      timingStatus = 'LATE_PROCTORING_STARTED';
      console.warn(`[AI Observer] LATE PROCTORING DETECTED! Started ${diffSeconds.toFixed(0)}s after quiz opened.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Violation Reporting
// ---------------------------------------------------------------------------

async function reportViolation(violationType, options = {}) {
  // --- CASCADING SAFEGUARD: EAR VETO GATE ------------------------------
  // Runs FIRST, before the cooldown is claimed. A vetoed violation must not
  // consume its type's cooldown slot: if the student opens their eyes a second
  // later and the same condition still holds, that IS reportable, and burning
  // the cooldown here would silently swallow it.
  //
  // Only the allowlist in ear_veto.js is eligible, and an unavailable or stale
  // EAR fails OPEN. Both properties are safety-critical — see that file's
  // header before changing anything here.
  const veto = earVetoGate
    ? earVetoGate.evaluate(violationType, performance.now())
    : { veto: false, vetoable: false, ear: null, reason: 'NO_GATE' };

  if (veto.veto) {
    // Name WHICH safeguard fired. "Suppressed" alone is unreadable in a field
    // log: an eyes-closed veto and a forgiven keyboard glance are different
    // claims about the student, and telling them apart is how a deployment
    // finds out that one of the two is misfiring.
    const ear = veto.ear !== null ? veto.ear.toFixed(3) : 'n/a';
    if (veto.reason === 'KEYBOARD_GLANCE') {
      console.log(
        `[SUPPRESSED] Downward keyboard glance vetoed by EAR/Pitch safeguard — ` +
        `${violationType}, ${veto.glance}, ${veto.permitMs}ms of ` +
        `${earVetoGate.permit.opt.permitMs}ms permit, EAR ${ear}.`
      );
    } else if (veto.reason === 'CLOSURE_HINT') {
      console.log(
        `[SUPPRESSED] Eye violation vetoed by EAR safeguard (coarse closure channel) — ` +
        `${violationType}. No landmark EAR available.`
      );
    } else {
      console.log(
        `[SUPPRESSED] Eye violation vetoed by EAR safeguard (Eye Closed/Blink) — ` +
        `${violationType}, EAR ${ear} < ${earVetoGate.opt.earThreshold}.`
      );
    }
    return;
  }

  if (isOnCooldown(violationType)) return;
  markCooldown(violationType);

  // Annotate what the safeguard actually confirmed, so a reviewer can tell
  // "eyes verified open" apart from "we could not check" — they are different
  // claims and only one of them is corroboration.
  if (veto.vetoable) {
    options = {
      ...options,
      metadata: {
        ...(options.metadata || {}),
        ear_confirmed: veto.ear,
        ear_check: veto.reason,
      },
    };
  }

  totalViolationCount++;

  // Every caller invokes this fire-and-forget (no await, no .catch), so anything
  // that throws OUTSIDE the fetch try-block below would surface as an unhandled
  // rejection and silently lose the violation. Keep the pre-flight work guarded.
  let payload;
  try {
    updateViolationCounter();
    payload = buildTelemetryPayload(violationType, options);
  } catch (err) {
    console.error('[AI Observer] Failed to build violation payload:', err);
    return;
  }

  console.warn(`[AI Observer] VIOLATION: ${violationType} (severity: ${payload.severity}, timing: ${payload.timing_status})`);

  try {
    if (chrome.runtime && chrome.runtime.id) {
      safeSendMessage({ type: 'VIOLATION_EVENT', payload: payload });
    }
  } catch (e) {
    // Context invalidated during extension reload
  }

  // ⚠ A GUEST SESSION HAS NO BACKEND TO RETRY AGAINST — DO NOT QUEUE.
  //
  // The anonymous visitor is not signed in (and `ANONYMOUS_AUTH_FAILED` makes
  // that permanent for the visit), so writeViolation() can only ever return
  // NOT_SIGNED_IN / NO_SESSION. The old path took that as "offline", enqueued the
  // payload and wrote the whole queue to chrome.storage — per violation, for a
  // queue that can never drain. On a busy demo that is a storage write every few
  // seconds, each one carrying base64 snapshots toward the quota, plus a console
  // warning that reads like a fault when it is the expected state.
  //
  // The page already has the evidence by this point: the VIOLATION_EVENT posted
  // above reaches the worker, which relays GUEST_VIOLATION_RELAY to
  // guest_bridge.js, which posts SAFETEST_GUEST_VIOLATION to the React page. That
  // is the ONLY delivery path a guest session has or needs, so the remote write
  // is skipped outright rather than attempted and mourned.
  if (guestSessionMode) return;

  const result = await writeViolation(payload, false);
  if (!result.ok) {
    console.warn('[AI Observer] Violation not recorded, queuing for retry:', result.reason);
    enqueueOffline(payload);
    persistOfflineQueue();
  }
}

/**
 * One violation -> one row in public.violations.
 *
 * ⚠ THE EAR IS PASSED THROUGH, NOT DEFAULTED. `payload.ear` is whatever the veto
 * gate actually measured on the hit frame, and it is legitimately absent when
 * the gate had no fresh sample and failed open. supabase_rest.js writes NULL in
 * that case; a `|| 0` anywhere along this path would turn "we could not see the
 * eyes" into a recorded measurement of closed eyes.
 *
 * @param {object} payload
 * @param {boolean} delayed - true when replayed from the offline queue.
 */
async function writeViolation(payload, delayed) {
  const rest = window.SafeTestSupabase;
  if (!rest || !rest.signedIn) {
    return { ok: false, reason: 'NOT_SIGNED_IN' };
  }
  return rest.insertViolation({
    sessionId: proctorSessionId,
    violationType: payload.violation_type,
    severity: payload.severity,
    ear: payload.ear,
    earChecked: payload.ear_check || payload.ear_confirmed || null,
    cheatProbability: payload.ai_confidence,
    cheatReason: `[${payload.severity}] ${payload.violation_type} (${payload.timing_status})`
      + (delayed ? ' [DELAYED]' : ''),
  });
}

/**
 * Append to the offline queue under a hard length cap.
 *
 * The queue is persisted to chrome.storage.local (10 MB quota) WITH its base64
 * snapshots. Uncapped, ~30 screen violations exhausted the quota and every
 * subsequent write failed silently, losing evidence at exactly the moment the
 * backend was already down. Oldest entries are evicted first; the violation
 * metadata is what matters most and it stays small.
 *
 * @param {object} payload - Telemetry payload to queue.
 */
function enqueueOffline(payload) {
  offlineQueue.push(payload);
  if (offlineQueue.length > OFFLINE_QUEUE_MAX) {
    const dropped = offlineQueue.length - OFFLINE_QUEUE_MAX;
    offlineQueue.splice(0, dropped);
    console.warn(`[AI Observer] Offline queue full — dropped ${dropped} oldest violation(s).`);
  }
}

async function flushOfflineQueue() {
  // A guest session must make no server calls at all. reportViolation() no longer
  // enqueues in guest mode, but a queue PERSISTED BY AN EARLIER SIGNED-IN SESSION
  // is restored from chrome.storage on load — without this guard a visitor who
  // opens the demo would replay someone else's backlog against an endpoint they
  // have no token for, once per flush trigger, forever.
  if (guestSessionMode) return;
  if (offlineQueue.length === 0) return;

  const queue = [...offlineQueue];
  offlineQueue = [];

  for (const payload of queue) {
    // Re-queue on a REPORTED failure too, not just a thrown one. supabase_rest
    // returns {ok:false} rather than throwing for an HTTP error, so a `try`
    // alone would silently discard every row the server rejected — draining the
    // queue into nothing and calling it a successful flush.
    const result = await writeViolation(payload, true);
    if (!result.ok) enqueueOffline(payload);
  }
  persistOfflineQueue();
}

/**
 * Persist the offline queue, shedding image payloads before giving up.
 *
 * chrome.storage.local.set fails ASYNCHRONOUSLY on quota exhaustion and the old
 * call passed no callback, so the error surfaced nowhere and the queue was
 * silently lost. Now a quota failure retries with snapshots stripped from all
 * but the newest OFFLINE_QUEUE_SNAPSHOT_KEEP entries — losing images is
 * recoverable, losing the violation record is not.
 */
function persistOfflineQueue() {
  try {
    if (!chrome.runtime || !chrome.runtime.id) return;

    safeStorageSet({ offlineViolationQueue: offlineQueue }, () => {
      if (!chrome.runtime.lastError) return;

      console.warn('[AI Observer] Offline queue write failed:', chrome.runtime.lastError.message);

      // Shed images from the oldest entries and try once more.
      const cutoff = Math.max(0, offlineQueue.length - OFFLINE_QUEUE_SNAPSHOT_KEEP);
      const slimmed = offlineQueue.map((p, i) =>
        i < cutoff ? { ...p, snapshot_b64: null, snapshot_dropped: true } : p
      );

      safeStorageSet({ offlineViolationQueue: slimmed }, () => {
        if (chrome.runtime.lastError) {
          console.error('[AI Observer] Offline queue could not be persisted even without snapshots:', chrome.runtime.lastError.message);
        } else {
          offlineQueue = slimmed;
          console.warn('[AI Observer] Offline queue persisted with snapshots dropped from oldest entries.');
        }
      });
    });
  } catch (e) {}
}

function loadOfflineQueue() {
  try {
    if (chrome.runtime && chrome.runtime.id) {
      safeStorageGet(['offlineViolationQueue'], (data) => {
        if (data.offlineViolationQueue && Array.isArray(data.offlineViolationQueue)) {
          offlineQueue = data.offlineViolationQueue;
        }
      });
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Event Handlers — Screen Stream Capture & Fullscreen Gesture Prompt
// ---------------------------------------------------------------------------

function handleFullscreenChange() {
  if (!isProctoringActive) return;

  if (!document.fullscreenElement) {
    console.warn('[AI Observer] Student exited fullscreen!');

    // Capture SCREEN frame (tab content), NOT webcam face
    const screenSnapshot = captureScreenSnapshot();

    reportViolation(ViolationType.FULLSCREEN_EXIT, {
      snapshotB64: screenSnapshot,
      metadata: { action: 'fullscreen_exit_flagged', guest: guestSessionMode },
    });

    // Show user-gesture click prompt overlay.
    //
    // Not in guest mode. The demo never enters fullscreen in the first place, so
    // this can only be reached by a visitor who pressed F11 themselves — and
    // answering that by covering their screen with a modal they cannot dismiss
    // would break the very page being demonstrated. The violation above still
    // reports, so the evidence panel shows the incident; the page renders its
    // own dismissible advisory alongside it.
    if (!guestSessionMode) {
      showFullscreenPromptOverlay();
    }
  } else {
    removeFullscreenPromptOverlay();
  }
}

/**
 * Show a sleek full-screen click prompt overlay to re-enter fullscreen.
 * Resolves the "requestFullscreen can only be initiated by a user gesture" DOMException.
 */
function showFullscreenPromptOverlay(isViolation = true) {
  removeFullscreenPromptOverlay();

  const promptOverlay = document.createElement('div');
  promptOverlay.id = 'ai-proctor-fullscreen-prompt';
  Object.assign(promptOverlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    backgroundColor: 'rgba(13, 13, 17, 0.95)',
    backdropFilter: 'blur(20px)',
    zIndex: '9999999',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    fontFamily: "'Inter', 'Outfit', system-ui, sans-serif",
    cursor: 'pointer',
    textAlign: 'center',
    padding: '20px',
  });

  // Two modes: the exam-start prompt (neutral) and the mid-exam exit warning.
  const icon = isViolation ? '⚠️' : '🖥️';
  const heading = isViolation ? 'FULLSCREEN EXIT FLAGGED' : 'FULLSCREEN REQUIRED';
  const headingColor = isViolation ? '#ef4444' : '#818cf8';
  const body = isViolation
    ? 'Exiting fullscreen during an exam is recorded as a violation.<br>Click anywhere on this screen to return to Fullscreen mode.'
    : 'This exam must run in fullscreen.<br>Click anywhere to enter fullscreen and continue.';

  promptOverlay.innerHTML = `
    <div style="font-size: 48px; margin-bottom: 16px;">${icon}</div>
    <div style="font-size: 20px; font-weight: 800; color: ${headingColor}; margin-bottom: 8px;">${heading}</div>
    <div style="font-size: 13px; color: #9ca3af; max-width: 400px; line-height: 1.5; margin-bottom: 24px;">
      ${body}
    </div>
    <div style="padding: 12px 24px; background: linear-gradient(135deg, #818cf8, #6366f1); border-radius: 8px; font-weight: 700; font-size: 13px; box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);">
      Click to ${isViolation ? 'Re-enter' : 'Enter'} Fullscreen
    </div>
  `;

  promptOverlay.addEventListener('click', async () => {
    await requestFullscreen();
    removeFullscreenPromptOverlay();
  });

  document.body.appendChild(promptOverlay);
}

function removeFullscreenPromptOverlay() {
  const existing = document.getElementById('ai-proctor-fullscreen-prompt');
  if (existing) existing.remove();
}


/** Severity ordering used to pick the reported type when causes coalesce. */
const FOCUS_LOSS_RANK = {
  [ViolationType.WINDOW_BLUR]: 1,       // MEDIUM — also fires on Alt-Tab to an app
  [ViolationType.VISIBILITY_HIDDEN]: 2, // HIGH — tab actually backgrounded
};

/**
 * Funnel every focus-loss signal through a short coalescing window so ONE
 * student action produces ONE violation.
 *
 * A Ctrl-Tab fires window 'blur' and 'visibilitychange' back to back; because
 * cooldowns are keyed per violation type, both used to be reported, inflating
 * the count and capturing two screen snapshots for a single event. The reported
 * type is the highest-severity cause seen in the window; all causes are kept in
 * metadata so review still shows exactly what happened.
 *
 * @param {string} violationType
 * @param {object} [extraMetadata]
 */
function reportFocusLoss(violationType, extraMetadata = {}) {
  if (!isProctoringActive) return;

  const rank = FOCUS_LOSS_RANK[violationType] || 0;

  if (focusLossPending) {
    // Already coalescing — fold this cause in and let the running timer fire.
    focusLossPending.causes.push(violationType);
    Object.assign(focusLossPending.metadata, extraMetadata);
    if (rank > focusLossPending.rank) {
      focusLossPending.rank = rank;
      focusLossPending.type = violationType;
    }
    return;
  }

  // Snapshot NOW: the screen contents at the instant of the switch are the
  // evidence, and they may be gone by the time the coalesce window closes.
  focusLossPending = {
    type: violationType,
    rank: rank,
    snapshot: captureScreenSnapshot(),
    causes: [violationType],
    metadata: { ...extraMetadata },
  };

  focusLossTimer = setTimeout(() => {
    const pending = focusLossPending;
    focusLossPending = null;
    focusLossTimer = null;
    if (!pending || !isProctoringActive) return;

    console.warn(`[AI Observer] Focus loss: ${pending.causes.join(' + ')} -> reporting ${pending.type}`);
    reportViolation(pending.type, {
      snapshotB64: pending.snapshot,
      metadata: { ...pending.metadata, focus_loss_causes: pending.causes },
    });
  }, FOCUS_LOSS_COALESCE_MS);
}

function handleVisibilityChange() {
  if (!isProctoringActive) return;
  if (document.visibilityState !== 'hidden') return;

  reportFocusLoss(ViolationType.VISIBILITY_HIDDEN, {
    visibilityState: document.visibilityState,
  });
}

function handleTabBlur() {
  if (!isProctoringActive) return;
  reportFocusLoss(ViolationType.WINDOW_BLUR);
}

function handleTabFocus() {
  if (!isProctoringActive) return;
  console.log('[AI Observer] Window focus regained.');
}

/**
 * Terminal screen-share loss. Ends the session — only call once the loss is
 * confirmed, never straight off a transient 'mute'.
 * @param {string} [cause] - What established the loss, recorded for review.
 */
function handleScreenShareStopped(cause = 'ended') {
  if (!isProctoringActive) return;
  clearScreenMuteTimer();
  console.warn(`[AI Observer] Screen sharing stopped (${cause})`);

  const screenSnapshot = captureScreenSnapshot();

  reportViolation(ViolationType.SCREEN_SHARE_STOPPED, {
    snapshotB64: screenSnapshot,
    metadata: { action: 'session_terminated', cause: cause },
  });
  stopProctoring('screen_share_stopped');
}

function clearScreenMuteTimer() {
  if (screenMuteTimer) {
    clearTimeout(screenMuteTimer);
    screenMuteTimer = null;
  }
}

/**
 * A screen track reported 'mute'. This is NOT the same as 'ended' — OS screen
 * lock, display sleep and GPU process recovery all mute a track that then
 * unmutes on its own. Escalate only if it fails to come back.
 */
function handleScreenTrackMuted() {
  if (!isProctoringActive || screenMuteTimer) return;

  console.warn(`[AI Observer] Screen track muted — allowing ${SCREEN_MUTE_GRACE_MS}ms to recover before flagging.`);
  screenMuteTimer = setTimeout(() => {
    screenMuteTimer = null;
    const track = screenStream && screenStream.getVideoTracks()[0];
    if (!track || track.muted || track.readyState !== 'live') {
      handleScreenShareStopped('mute_not_recovered');
    } else {
      console.log('[AI Observer] Screen track recovered before grace expiry.');
    }
  }, SCREEN_MUTE_GRACE_MS);
}

/** The track came back inside the grace window — no violation occurred. */
function handleScreenTrackUnmuted() {
  if (!screenMuteTimer) return;
  console.log('[AI Observer] Screen track unmuted within grace period — not a violation.');
  clearScreenMuteTimer();
}

function pollScreenTrackState() {
  if (!isProctoringActive || !screenStream) return;
  const track = screenStream.getVideoTracks()[0];
  // 'ended' is terminal and readyState catches it. A muted-but-live track is
  // deliberately NOT treated as a stop here — that is the grace timer's job.
  if (!track || track.readyState !== 'live') {
    handleScreenShareStopped('track_not_live');
  }
}

// ---------------------------------------------------------------------------
// Fullscreen Management
// ---------------------------------------------------------------------------

/**
 * The element currently presented fullscreen, under either spelling.
 *
 * `webkitFullscreenElement` is the legacy alias; current Chrome sets both, but
 * a page that entered fullscreen through the prefixed API on an older embedded
 * webview can have only the second one populated. Reading just the standard
 * property there reports "not fullscreen" about a document that plainly is.
 *
 * @returns {Element|null}
 */
function currentFullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.msFullscreenElement
    || null;
}

/**
 * Enter fullscreen, unless the document already is.
 *
 * ⚠ THE EARLY RETURN IS THE WHOLE POINT — DO NOT "SIMPLIFY" IT AWAY.
 *
 * The live demo page opens itself fullscreen. The extension then called
 * requestFullscreen() again on `document.documentElement`, and in that state the
 * second request does not no-op: when a DIFFERENT element already holds the
 * fullscreen lock the request re-targets it, and browsers have been observed
 * dropping straight back to windowed instead. The student watched the demo
 * fall out of fullscreen the instant proctoring started — and because
 * handleFullscreenChange() reads that transition as the student leaving, it
 * also manufactured a CRITICAL FULLSCREEN_EXIT out of the extension's own call.
 *
 * Being already fullscreen satisfies the requirement completely, so there is
 * nothing to request. Checking is also strictly safer than requesting: a
 * redundant request can only spend the transient activation and change state,
 * never improve it.
 */
async function requestFullscreen() {
  // Already fullscreen — by any spelling — so the goal is met. Returning here
  // also preserves the caller's user activation for anything after it.
  if (currentFullscreenElement()) {
    console.log('[AI Observer] Already fullscreen — skipping redundant request.');
    return;
  }

  try {
    const el = document.documentElement;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else if (el.msRequestFullscreen) await el.msRequestFullscreen();
  } catch (err) {
    console.warn('[AI Observer] Fullscreen request failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Core Lifecycle
// ---------------------------------------------------------------------------

/**
 * Entry point for proctoring. Screen capture (getDisplayMedia) and fullscreen
 * BOTH require a transient user gesture, which storage-driven starts (popup
 * click or quiz-URL auto-start) do not carry into the page. So instead of
 * calling the capture APIs directly, we show an in-page consent gate; the
 * student's click on it provides the gesture that beginProctoringSession needs.
 */
async function startProctoring() {
  if (isProctoringActive) return;
  
  const isGuest = await new Promise((res) => {
    try {
      chrome.storage.local.get(['guestMode'], (d) => res(d?.guestMode === true));
    } catch { res(false); }
  });

  const isDemoUrl = window.location.href.includes('/demo-quiz') || window.location.href.includes('/demo');

  if (isGuest || isDemoUrl) {
    guestSessionMode = true;
    if (document.getElementById('ai-proctor-consent-gate')) return;
    // Straight to the consent stage: it blurs the quiz behind it until setup
    // completes, and its click is the only place screen capture and fullscreen
    // can legally be requested from.
    showProctoringConsentGate({ skipLighting: true });
    return;
  }
  guestSessionMode = false;

  if (document.getElementById('ai-proctor-consent-gate')) return;
  showProctoringConsentGate();
}

/**
 * The pre-exam overlay. TWO STAGES, each with its own click.
 *
 * ⚠ WHY TWO STAGES, AND WHY THIS ORDER.
 *
 * getDisplayMedia() and requestFullscreen() both need a live user gesture, and
 * getDisplayMedia() CONSUMES it (see beginProctoringSession). An async lighting
 * check inserted between the click and those calls would spend the activation
 * and break both. So the lighting check gets its own earlier click and its own
 * camera prompt, and the consent click that follows arrives with a fresh,
 * unspent gesture:
 *
 *   stage 1  "Enable Camera & Check Lighting"  -> getUserMedia only
 *              live preview + alignment oval, 5 FPS sampling, live feedback
 *              Continue unlocks only when lightingChecker.isReady()
 *   stage 2  "Begin Secure Proctoring"          -> getDisplayMedia + fullscreen
 *              reuses the stream stage 1 already opened
 *
 * Both stages render into the SAME element, so the id, the duplicate-gate guard
 * in startProctoring(), and removeProctoringConsentGate() are all unchanged.
 */
function showProctoringConsentGate(opts = {}) {
  removeProctoringConsentGate();

  const gate = document.createElement('div');
  gate.id = 'ai-proctor-consent-gate';
  Object.assign(gate.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    backgroundColor: 'rgba(13, 13, 17, 0.97)', backdropFilter: 'blur(20px)',
    zIndex: '2147483647', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', color: '#ffffff',
    fontFamily: "'Inter', 'Outfit', system-ui, sans-serif", textAlign: 'center', padding: '24px',
  });

  document.body.appendChild(gate);

  // ⚠ THE GATE IS WHAT SUPPLIES THE USER GESTURE. That is its load-bearing
  // function, not the copy on it — getDisplayMedia() and requestFullscreen()
  // are callable only from inside its button's click handler.
  //
  // Guest sessions skip STAGE 1 ONLY. The lighting check exists to warn about a
  // room that will produce a low-confidence exam recording; a visitor trying a
  // 5-minute demo has no recording to protect and no reason to be held at a
  // camera-alignment screen. They still get stage 2, which is the consent
  // itself — and, critically, the gesture. Bypassing the gate entirely (as
  // guest mode previously did) is what left the demo with no screen stream, so
  // every tab-switch violation photographed the candidate's face instead of the
  // thing they switched to.
  if (opts.skipLighting) {
    renderConsentStage(gate);
  } else {
    renderLightingStage(gate);
  }
}

/**
 * Stage 1 — camera + lighting readiness.
 *
 * The alignment oval is positioned from FACE_BOX_RATIOS, the SAME constant the
 * analyser measures with. That is what makes the box a contract with the
 * student rather than a guess: they are told to fill the region we actually
 * sample. If the two ever drift apart, students are asked to align to something
 * the gate is not looking at.
 */
function renderLightingStage(gate) {
  const R = (typeof FACE_BOX_RATIOS !== 'undefined')
    ? FACE_BOX_RATIOS
    : { w: 0.38, h: 0.55, cx: 0.5, cy: 0.48 };

  const ovalStyle = `
    position:absolute;
    left:${((R.cx - R.w / 2) * 100).toFixed(2)}%;
    top:${((R.cy - R.h / 2) * 100).toFixed(2)}%;
    width:${(R.w * 100).toFixed(2)}%;
    height:${(R.h * 100).toFixed(2)}%;
    border:2px dashed rgba(255,255,255,0.55);
    border-radius:50%;
    box-sizing:border-box;
    pointer-events:none;
    transition:border-color .25s ease;
  `.replace(/\s+/g, ' ');

  gate.innerHTML = `
    <div style="font-size: 40px; margin-bottom: 14px;">💡</div>
    <div style="font-size: 22px; font-weight: 800; margin-bottom: 8px;">Lighting Check</div>
    <div style="font-size: 13px; color: #9ca3af; max-width: 440px; line-height: 1.6; margin-bottom: 18px;">
      Poor lighting makes the proctoring models unreliable, so we check it before the exam starts.
      Position your face inside the oval.
    </div>

    <div id="ai-proctor-preview-wrap" style="position:relative;width:320px;max-width:80vw;aspect-ratio:4/3;
      background:#000;border-radius:12px;overflow:hidden;margin-bottom:16px;
      box-shadow:0 8px 30px rgba(0,0,0,0.55);">
      <video id="ai-proctor-preview" autoplay playsinline muted
        style="width:100%;height:100%;object-fit:cover;transform:scaleX(-1);"></video>
      <div id="ai-proctor-face-oval" style="${ovalStyle}"></div>
    </div>

    <div id="ai-proctor-light-msg" style="font-size:13px;font-weight:600;color:#9ca3af;
      max-width:440px;min-height:38px;line-height:1.5;margin-bottom:6px;">
      Click below to turn on your camera.
    </div>
    <div id="ai-proctor-light-hint" style="font-size:11px;color:#6b7280;max-width:440px;
      line-height:1.5;margin-bottom:14px;visibility:hidden;">
      This is a suggestion, not a requirement — you can continue either way.
    </div>

    <button id="ai-proctor-light-btn" style="padding: 13px 28px; background: linear-gradient(135deg, #818cf8, #6366f1);
      color: #fff; border: none; border-radius: 10px; font-weight: 700; font-size: 14px; cursor: pointer;
      box-shadow: 0 6px 20px rgba(99,102,241,0.45); font-family: inherit;">
      Enable Camera &amp; Check Lighting
    </button>
    <div id="ai-proctor-consent-error" style="color:#ef4444;font-size:12px;margin-top:14px;min-height:16px;"></div>
  `;

  const btn = gate.querySelector('#ai-proctor-light-btn');
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === 'continue') {
      // Fresh, unspent gesture -> hand over to the consent stage.
      renderConsentStage(gate);
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Starting camera…';
    startLightingPreflight(gate);
  });
}

/** Open the webcam and begin 5 FPS sampling. */
async function startLightingPreflight(gate) {
  const btn = gate.querySelector('#ai-proctor-light-btn');
  const msg = gate.querySelector('#ai-proctor-light-msg');

  try {
    preflightWebcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
  } catch (err) {
    console.error('[AI Observer] Lighting preflight camera error:', err);
    btn.disabled = false;
    btn.textContent = 'Retry — Enable Camera';
    setConsentGateError('Camera access is required. Please allow it, then retry.');
    return;
  }

  preflightVideoEl = gate.querySelector('#ai-proctor-preview');
  preflightVideoEl.srcObject = preflightWebcamStream;
  try { await preflightVideoEl.play(); } catch (e) { /* autoplay attr covers this */ }

  // ⚠ Continue is enabled the moment the camera is live, BEFORE any lighting
  // reading exists, and it is never disabled again. The advisory text below it
  // updates at 5 FPS; the student decides what to do about it.
  btn.disabled = false;
  btn.dataset.mode = 'continue';
  btn.textContent = 'Continue';
  setConsentGateError('');

  if (typeof LightingChecker === 'undefined') {
    // A stale unpacked build without the module changes nothing that matters:
    // there was never anything to enforce. Say so and carry on.
    console.warn('[AI Observer] LightingChecker unavailable — no lighting advice this session.');
    msg.textContent = 'Lighting check unavailable on this build.';
    msg.style.color = '#9ca3af';
    return;
  }

  lightingChecker = new LightingChecker({
    onUpdate: (result) => paintLightingFeedback(gate, result),
  });
  lightingChecker.start(preflightVideoEl);
}

/**
 * Real-time advisory feedback. Runs once per sample (5 FPS).
 *
 * ⚠ ADVISORY. THE BUTTON IS NEVER DISABLED ON LIGHTING GROUNDS.
 *
 * An earlier revision gated Continue on the lighting verdict. That was wrong:
 * `backlitFaceMax: 35` is an absolute grey level measured on skin, so a
 * dark-skinned student in a well-lit room can read below it — and as a launch
 * gate the failure mode was denial of exam access. `result.optimal` decides
 * only whether the text is green or amber.
 *
 * Do not reintroduce a `btn.disabled` here. If lighting ever needs to hold
 * someone back, that is a policy decision for the institution, not a threshold.
 */
function paintLightingFeedback(gate, result) {
  const msg = gate.querySelector('#ai-proctor-light-msg');
  const hint = gate.querySelector('#ai-proctor-light-hint');
  const oval = gate.querySelector('#ai-proctor-face-oval');
  if (!msg) return;

  const good = !!result.optimal;
  msg.textContent = result.userMessage;
  msg.style.color = good ? '#34d399' : (result.sampled ? '#f59e0b' : '#9ca3af');
  if (oval) oval.style.borderColor = good ? 'rgba(52,211,153,0.9)' : 'rgba(255,255,255,0.55)';

  // The escape hatch is always visible when the advice is not "good", so a
  // student who cannot change their room knows they are not stuck.
  if (hint) {
    hint.style.visibility = (result.sampled && !good) ? 'visible' : 'hidden';
  }
}

/**
 * Stage 2 — the original consent copy, unchanged in substance. Its click is a
 * fresh user gesture, which is what getDisplayMedia and fullscreen need.
 */
function renderConsentStage(gate) {
  // Snapshot the advice the student saw before tearing the checker down. They
  // are proceeding either way; this only records what the room looked like.
  if (lightingChecker) {
    const t = lightingChecker.telemetry();
    lightingSetupTelemetry = {
      status: t.lastStatus,
      optimal: t.optimal,
      samples: t.samples,
      counts: t.statusCounts,
      detail: t.lastDetail,
    };
    console.log('[AI Observer] Setup lighting state:', lightingSetupTelemetry);
  }
  // Stop sampling, but KEEP the stream — the session is about to adopt it.
  teardownLightingCheck({ releaseStream: false });

  gate.innerHTML = `
    <div style="font-size: 46px; margin-bottom: 18px;">🎥</div>
    <div style="font-size: 22px; font-weight: 800; margin-bottom: 10px;">Secure Proctoring Required</div>
    <div style="font-size: 13px; color: #9ca3af; max-width: 440px; line-height: 1.6; margin-bottom: 26px;">
      This exam is monitored by AI Observer. When you continue, you will be asked to
      share your <strong>entire screen</strong>, and the page will enter fullscreen.
      Leaving fullscreen, switching tabs, or stopping the share is recorded.
    </div>
    <button id="ai-proctor-consent-btn" style="padding: 13px 28px; background: linear-gradient(135deg, #818cf8, #6366f1);
      color: #fff; border: none; border-radius: 10px; font-weight: 700; font-size: 14px; cursor: pointer;
      box-shadow: 0 6px 20px rgba(99,102,241,0.45); font-family: inherit;">
      Begin Secure Proctoring
    </button>
    <div id="ai-proctor-consent-error" style="color:#ef4444;font-size:12px;margin-top:14px;min-height:16px;"></div>
  `;

  const btn = gate.querySelector('#ai-proctor-consent-btn');
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Requesting permissions…';
    // Call synchronously inside the click handler so the user gesture is live.
    beginProctoringSession();
  });
}

/**
 * Stop the 5 FPS loop and detach the preview.
 *
 * @param {{releaseStream:boolean}} [opts] - releaseStream:false hands the open
 *   webcam to the session; true stops its tracks (the student abandoned setup).
 *   Getting this wrong either leaves a camera light on after the gate closes,
 *   or kills the stream the session is about to use.
 */
function teardownLightingCheck(opts = {}) {
  const releaseStream = opts.releaseStream !== false;

  if (lightingChecker) { lightingChecker.stop(); lightingChecker = null; }
  if (preflightVideoEl) {
    try { preflightVideoEl.pause(); } catch (e) { /* detached */ }
    preflightVideoEl.srcObject = null;
    preflightVideoEl = null;
  }
  if (releaseStream && preflightWebcamStream) {
    preflightWebcamStream.getTracks().forEach((t) => t.stop());
    preflightWebcamStream = null;
  }
}

function removeProctoringConsentGate() {
  // The gate is going away, so any sampling loop behind it must go too. If the
  // session already adopted the stream, webcamStream !== null and it is not
  // ours to stop.
  teardownLightingCheck({ releaseStream: webcamStream !== preflightWebcamStream });
  const existing = document.getElementById('ai-proctor-consent-gate');
  if (existing) existing.remove();
}

function setConsentGateError(message) {
  const gate = document.getElementById('ai-proctor-consent-gate');
  if (!gate) return;
  const err = gate.querySelector('#ai-proctor-consent-error');
  const btn = gate.querySelector('#ai-proctor-consent-btn');
  if (err) err.textContent = message;
  if (btn) { btn.disabled = false; btn.textContent = 'Retry — Begin Secure Proctoring'; }
}

/**
 * Perform the actual proctoring startup. MUST be called from within a user
 * gesture handler: the gesture-gated calls (getDisplayMedia, requestFullscreen)
 * are issued synchronously before any await so the activation is not consumed.
 */
async function beginProctoringSession() {
  if (isProctoringActive) return;
  isProctoringActive = true;
  totalViolationCount = 0;
  resetAiDecisionState();
  lastFrameSignature = null;
  staleFrameCount = 0;
  // The previous session's last frame must not be diffed against this
  // session's first — that would fabricate a large delta (or, worse, a zero
  // one) out of two unrelated feeds.
  _hasPrevFrame = false;
  inferenceInFlight = false;
  slowInferenceWarned = false;
  // Re-measure per session: the machine's spare capacity depends on what else
  // the student has open, which is not the same from one exam to the next.
  retierOverrunCount = 0;
  retierApplied = false;
  classifierPrimaryBlockedLogged = false;

  console.log('[AI Observer] Initializing proctoring session for:', studentName, studentId);
  calculateTimingCompliance();
  loadOfflineQueue();

  // --- Gesture-gated calls first (synchronous, before any await) ---
  let screenPromise, fullscreenPromise;
  // The lighting stage already opened the camera and the student already
  // granted it. Re-requesting would prompt a second time for the same device
  // and drop the frames in between, so adopt the open stream when we have one.
  const webcamPromise = preflightWebcamStream
    ? Promise.resolve(preflightWebcamStream)
    : navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
  if (guestSessionMode) {
    // The consent gate's button is a live gesture, so screen capture IS
    // requestable here — and it must be requested, because focus-loss evidence
    // is worthless without it: captureScreenSnapshot() falls back to the webcam,
    // which photographs the candidate's face rather than whatever they switched
    // to. That fallback was the reported "blur events take a face snapshot".
    //
    // But a REFUSAL must not end the demo, which is why this does not share the
    // exam path's abort-on-throw. A visitor declining to share their screen gets
    // a webcam-only session and a console line saying so; an exam candidate
    // doing the same is a failed setup. Same call, different stakes.
    screenPromise = navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor' },
      audio: false,
    }).catch((err) => {
      console.warn(
        '[AI Observer] Guest Mode: screen share declined — focus-loss snapshots '
        + 'will fall back to the webcam.', err && err.name
      );
      return null;
    });
    fullscreenPromise = Promise.resolve(requestFullscreen()).catch(() => {});
  } else {
    try {
      screenPromise = navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor' },
        audio: false,
      });
      fullscreenPromise = requestFullscreen();
    } catch (err) {
      // Synchronous throw (e.g. no user activation)
      isProctoringActive = false;
      setConsentGateError('Screen sharing was blocked. Please click again and allow it.');
      console.error('[AI Observer] getDisplayMedia setup error:', err);
      return;
    }
  }

  // Model download/compile needs no gesture — do it in parallel.
  //
  // ⚠ THE CLASSIFIER IS SKIPPED ENTIRELY IN GUEST MODE.
  //
  // best.onnx lives on the operator's model server, which a guest does not
  // have. Attempting it produced `model_load_failed`, and that is thrown as a
  // FATAL error below — so an absent server did not merely cost the classifier,
  // it aborted the whole session before a single frame was read.
  //
  // Losing it costs the demo nothing it is allowed to use: the classifier is
  // corroboration-only (see CLAUDE.md §4) and can never raise an alert on its
  // own evidence, so a guest session that runs without it reports exactly the
  // same violations it would have reported with it.
  const modelPromise = guestSessionMode
    ? Promise.resolve(true)
    : window.initONNXSession(serverUrl);
  const visionPromise = initVisionEngine(serverUrl);

  try {
    screenStream = await screenPromise;
    webcamStream = await webcamPromise;
    // Ownership transfers here: from this point the session stops the stream,
    // and the preflight handle must not also claim it. Exactly one owner.
    preflightWebcamStream = null;

    const loaded = await modelPromise;
    if (!loaded) {
      throw new Error('model_load_failed');
    }

    // Vision failures are non-fatal: proctoring still runs on the screen and
    // focus signals. It degrades loudly rather than silently.
    await visionPromise;

    await fullscreenPromise;
    removeProctoringConsentGate();

    // Screen-derived plumbing only exists when a screen was actually captured.
    // In guest mode screenStream is null by design; captureScreenSnapshot()
    // already falls back to the webcam when screenVideoElement is null, and
    // pollScreenTrackState() already no-ops without a stream.
    if (screenStream) {
      // Hidden screen video element for screen snapshot frame capture
      screenVideoElement = document.createElement('video');
      screenVideoElement.srcObject = screenStream;
      screenVideoElement.autoplay = true;
      screenVideoElement.playsInline = true;
      screenVideoElement.muted = true;

      // Guard screen share track. 'ended' is terminal; 'mute' is transient and
      // goes through a grace period so a screen lock does not kill the exam.
      const screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.onended = () => handleScreenShareStopped('ended');
      screenTrack.onmute = () => handleScreenTrackMuted();
      screenTrack.onunmute = () => handleScreenTrackUnmuted();
      screenTrackPollInterval = setInterval(pollScreenTrackState, SCREEN_TRACK_POLL_MS);
    }

    createFloatingWidget();

    // getDisplayMedia() consumes the click's user activation, so the parallel
    // requestFullscreen() above frequently cannot engage (this is why fullscreen
    // "did not always" open). If we are not actually in fullscreen now, show a
    // one-click prompt that carries its own fresh user gesture.
    //
    // Never in guest mode: the demo page is a normal web page the visitor is
    // reading, and covering it with a full-viewport "click to enter fullscreen"
    // overlay would block the exam UI it is supposed to be proctoring.
    if (!guestSessionMode && !document.fullscreenElement) {
      showFullscreenPromptOverlay(false);
    }

    // Bind event listeners
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleTabBlur);
    window.addEventListener('focus', handleTabFocus);
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Inference & Heartbeat loops. Inference is a self-scheduling chain rather
    // than an interval so a slow frame can never queue behind itself.
    scheduleNextInference(0);
    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    // Remember the quiz page URL for navigation detection
    quizPageUrl = window.location.href;
    startNavigationWatch();

    // Open the public.proctor_sessions row. Still non-fatal on failure — the
    // local detection pipeline is what protects the exam, and refusing to
    // proctor because a network write failed would be the wrong trade. But the
    // id is captured, because every violation row references it.
    const opened = await (window.SafeTestSupabase
      ? window.SafeTestSupabase.startSession({
        sessionCode,
        fullName: studentName,
        timingStatus,
        quizOpenedAt: monitorQuizOpenedAtIso,
        proctorStartedAt: proctorStartedAtIso,
        lighting: lightingSetupTelemetry,
        studentUniversityId,
      })
      : { ok: false, id: null, reason: 'NO_REST_MODULE' });

    proctorSessionId = opened.id;
    if (!opened.ok) {
      console.warn(`[AI Observer] session row not created (${opened.reason}) — `
        + 'violations will still be recorded locally and queued.');
    }

    try {
      if (chrome.runtime && chrome.runtime.id) {
        safeSendMessage({
          type: 'START_PROCTOR',
          data: { studentName, studentId, sessionCode },
        });
      }
    } catch (e) { /* context invalidated */ }

    console.log('[AI Observer] ✓ Proctoring active. Timing status:', timingStatus);

  } catch (err) {
    console.error('[AI Observer] Setup error:', err);
    // Release anything we already acquired so a retry starts clean.
    if (webcamStream) { webcamStream.getTracks().forEach((t) => t.stop()); webcamStream = null; }
    if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
    // The adopted preflight stream is the same object we just stopped. Clearing
    // the handle matters: a retry would otherwise resolve to a stream whose
    // tracks are all ended, and produce a permanently black feed.
    if (preflightWebcamStream) {
      preflightWebcamStream.getTracks().forEach((t) => t.stop());
      preflightWebcamStream = null;
    }
    isProctoringActive = false;
    if (err && err.message === 'model_load_failed') {
      setConsentGateError('Could not load the AI model. Check the backend server, then retry.');
    } else {
      setConsentGateError('Camera & full-screen screen sharing are required. Please allow both, then retry.');
    }
  }
}

function stopProctoring(reason) {
  // Always clear a pending consent gate, even if a session never fully began.
  removeProctoringConsentGate();
  removeFullscreenPromptOverlay();
  if (!isProctoringActive) return;
  isProctoringActive = false;

  const stopReason = reason || 'manual';
  console.log(`[AI Observer] Stopping proctoring. Reason: ${stopReason}`);

  if (inferenceTimer) { clearTimeout(inferenceTimer); inferenceTimer = null; }
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (screenTrackPollInterval) clearInterval(screenTrackPollInterval);
  if (navigationWatchInterval) clearInterval(navigationWatchInterval);
  clearScreenMuteTimer();
  if (focusLossTimer) { clearTimeout(focusLossTimer); focusLossTimer = null; }
  focusLossPending = null;
  inferenceInFlight = false;

  // Release the pose/detect ONNX sessions. A fresh VisionEngine is built on
  // every session start, so skipping this leaks ~21 MB of weights per attempt.
  if (visionEngine) {
    const engine = visionEngine;
    visionEngine = null;
    Promise.resolve(engine.dispose()).catch(() => {});
  }

  // And the classifier, which is a SEPARATE session owned by onnx_inference.js.
  // Disposing only the VisionEngine left best.onnx (640x640 — the most expensive
  // graph here) resident for the life of the page, and initONNXSession() builds
  // a fresh one on the next start. Re-entering the demo a few times was enough
  // to exhaust memory on a low-spec machine.
  if (window.disposeONNXSession) {
    Promise.resolve(window.disposeONNXSession()).catch(() => {});
  }
  deviceGate = null;
  PHONE_DETECTED = false;
  lastPhoneEvidence = null;
  // A real exam started later in this same tab must re-acquire the screen. Leaving
  // this true would silently downgrade it to webcam-only.
  guestSessionMode = false;

  // reset() also tears down the corner dot, so a session that ends mid-challenge
  // cannot leave a pulsing overlay stuck on the page.
  if (livenessManager) {
    livenessManager.reset();
    livenessManager = null;
  }

  if (webcamStream) {
    webcamStream.getTracks().forEach((track) => track.stop());
    webcamStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
  if (screenVideoElement) {
    screenVideoElement.remove();
    screenVideoElement = null;
  }

  document.removeEventListener('fullscreenchange', handleFullscreenChange);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('blur', handleTabBlur);
  window.removeEventListener('focus', handleTabFocus);
  window.removeEventListener('beforeunload', handleBeforeUnload);

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }

  removeFloatingWidget();
  flushOfflineQueue();

  // Clear proctoringActive so it won't restart on other pages
  safeStorageSet({ proctoringActive: false });

  // Close the session row.
  //
  // ⚠ NOT sendBeacon. See supabase_rest.endSession — a beacon cannot set
  // headers, PostgREST requires `apikey` + `Authorization` on every request, so
  // a beacon port would 401 on every end, during unload, invisibly.
  if (window.SafeTestSupabase && proctorSessionId) {
    window.SafeTestSupabase.endSession(proctorSessionId, {
      endedAt: new Date().toISOString(),
    }).then((r) => {
      if (!r.ok) console.warn('[AI Observer] end-session write failed:', r.reason);
    }).catch(() => {});
  }
  proctorSessionId = null;

  resetAiDecisionState();
  lastFrameSignature = null;
  staleFrameCount = 0;
  // The previous session's last frame must not be diffed against this
  // session's first — that would fabricate a large delta (or, worse, a zero
  // one) out of two unrelated feeds.
  _hasPrevFrame = false;
  totalViolationCount = 0;
  quizPageUrl = null;

  // The quiz-open timestamp is per-session, not per-page. Clearing it here is
  // what lets the next session establish a fresh timing baseline (lms_detector
  // deliberately never re-stamps it while one is already stored).
  try {
    if (chrome.runtime && chrome.runtime.id) {
      chrome.storage.local.remove('quizOpenedAtIso');
    }
  } catch (e) {}

  try {
    safeSendMessage({ type: 'STOP_PROCTOR' });
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// AI Inference Loop
// ---------------------------------------------------------------------------

/** Clear the sliding window and hysteresis state between sessions. */
function resetAiDecisionState() {
  cheatFrameWindow = [];
  aiFlagState = 'clear';
  lastAiFlagAt = 0;
  bestEvidence = null;
  lastClassifierRunMs = -Infinity;
  lastPhoneEvidence = null;
  PHONE_DETECTED = false;
  phoneFrameIndex = 0;
  if (visionEngine) visionEngine.reset();
  if (deviceGate) deviceGate.reset();
  if (livenessManager) livenessManager.reset();
  if (earVetoGate) earVetoGate.reset();
  // Drops every retained data URL. Not merely hygiene: without it, evidence
  // frames from a previous session remain eligible for peakSince() and could be
  // attached to a new session's alert — a student illustrated with a photograph
  // of someone else.
  if (evidenceBuffer) evidenceBuffer.clear();
  if (gazeFusion) gazeFusion.reset();
  if (downwardGaze) downwardGaze.reset();
  _pCheatingFresh = NaN;
  // A sample from before the reset must not be aged against the new session's
  // clock — it would read as fresh and re-arm the very mix the guard prevents.
  _downSampleRef = null;
  _downSampleAtMs = NaN;
}

/**
 * Build the liveness manager and route its outcomes into the violation
 * taxonomy.
 *
 * Only FAILED becomes a violation. PASSED is a log line, and INCONCLUSIVE
 * (the face was not readable often enough to judge) deliberately reports
 * nothing — a student we could not see is a NO_FACE_DETECTED case, which the
 * pose pipeline already raises on its own evidence. Accusing them of spoofing
 * as well would be two accusations from one absence.
 */
function initLivenessManager() {
  if (typeof LivenessChallengeManager === 'undefined') {
    console.warn('[AI Observer] Liveness module not loaded; anti-spoofing challenges disabled.');
    livenessManager = null;
    return;
  }

  livenessManager = new LivenessChallengeManager({
    onEvent: (name, payload) => {
      if (name !== 'LIVENESS_CHALLENGE_FAILED') return;

      // ONE student action produces ONE violation. When Tier 1 raised the
      // challenge and the student failed it, the meaningful finding is the
      // synthetic feed — reporting LIVENESS_FAILED alongside it would double
      // count a single event, the same mistake the focus-loss coalescer exists
      // to prevent. The liveness detail rides along as the evidence for it.
      const synthetic = payload.synthetic_confirmed === true;

      reportViolation(
        synthetic ? ViolationType.CAMERA_FEED_SYNTHETIC : ViolationType.LIVENESS_FAILED,
        {
          // There is no probability here — this is a behavioural challenge the
          // student did not answer, not a model score. 1.0 keeps the incident
          // API's cheat_probability meaningful rather than inventing a number.
          aiConfidence: 1.0,
          snapshotB64: captureWebcamSnapshot(0.85),
          metadata: {
            detector: synthetic
              ? 'two_tier_synthetic_feed_detection'
              : 'active_liveness_corner_challenge',
            reason: synthetic
              ? 'CRITICAL: CAMERA_FEED_SYNTHETIC + LIVENESS_FAILED (zero pixel delta confirmed by failed corner challenge)'
              : 'FLAG_CHEATING: Failed Liveness Challenge (Static Image/Spoofing Detected)',
            ...payload,
            tier: runtimeProfile ? runtimeProfile.tier : null,
          },
        }
      );
    },
  });
}

/**
 * Adopt the hardware tier's frame budget.
 *
 * Tier A (WebGPU): pose/gaze at ~20 FPS, phone YOLO on every one of those
 * frames. Tier B (CPU/WASM): the same pipeline sub-sampled to ~9 FPS with
 * inputs capped at 320px, which is what keeps a budget laptop's UI responsive.
 *
 * Note what does NOT change between tiers: the phone detector still runs on
 * every PROCESSED frame in both. Tier B lowers the frame rate, not the
 * coverage — dropping detection frames is precisely how a 5-frame glimpse gets
 * missed.
 *
 * @param {object|null} profile
 */
function applyRuntimeProfile(profile) {
  if (!profile) return;
  runtimeProfile = profile;

  proctorIntervalMs = profile.frameIntervalMs || proctorIntervalMs;
  proctorMinGapMs = profile.minFrameGapMs || proctorMinGapMs;
  classifierIntervalMs = profile.classifierIntervalMs || classifierIntervalMs;

  console.log(
    `[AI Observer] Runtime tier ${profile.tier} (${profile.label}): ` +
    `target ${profile.targetFps} FPS (interval ${proctorIntervalMs}ms, floor ${proctorMinGapMs}ms), ` +
    `classifier every ${classifierIntervalMs}ms, phone detect ${profile.detectMode}.`
  );
}

/** @returns {boolean} True while a phone alert is latched and held. */
function getPhoneDetected() {
  return PHONE_DETECTED;
}

/**
 * Load the pose + object detection sessions.
 *
 * Deliberately non-fatal. If the pose model cannot load we lose head-pose
 * analysis, and the correct response is to stop making head-pose accusations —
 * NOT to fall back to the uncalibrated classifier, which is the very thing
 * generating false positives. Under-reporting is recoverable; falsely accusing
 * a student is not.
 *
 * @param {string} url - Backend base URL.
 * @returns {Promise<boolean>} True if head-pose analysis is available.
 */
/**
 * Tell the page whether the vision pipeline is actually running.
 *
 * ⚠ A DEAD PIPELINE MUST NOT LOOK LIKE A QUIET ONE. When FaceLandmarker failed
 * to build (the MV3 `unsafe-eval` rejection did exactly this on both delegates)
 * the extension stayed "connected" and simply never reported anything — which
 * reads on screen as a calm, compliant session rather than as no proctoring at
 * all. The HUD needs to be able to say so.
 *
 * Posted straight to the page: monitor.js is a content script in this same
 * window, so it needs no worker relay. `guest_bridge.js` is not involved.
 *
 * @param {'ONLINE'|'OFFLINE'} state
 * @param {string} [reason] Short operator-facing cause.
 */
function postVisionStatus(state, reason) {
  try {
    window.postMessage({
      type: 'SAFETEST_VISION_STATUS',
      state,
      reason: reason || null,
    }, '*');
  } catch (e) { /* page going away */ }
}

async function initVisionEngine(url) {
  if (typeof VisionEngine === 'undefined') {
    console.warn('[AI Observer] Vision engine scripts not loaded; head pose disabled.');
    postVisionStatus('OFFLINE', 'vision scripts not loaded');
    return false;
  }

  try {
    // A guest has no model server. Skipping the fetch outright is not a
    // degraded path — it is the correct one: pose.onnx/detect.onnx live on the
    // operator's backend, while MediaPipe ships inside the extension and gives
    // head pose, landmarks, gaze and blink immunity with no network at all.
    visionEngine = new VisionEngine({
      ...(guestSessionMode ? { offlineOnly: true } : {}),
      analyzer: { absenceGate: NO_FACE_GATE },
    });
    const { pose, detect, poseSource } = await visionEngine.load(url);

    // The engine resolved (or reused) the hardware probe during load; adopt its
    // frame budget now that we know which tier this machine is.
    applyRuntimeProfile(visionEngine.profile);

    // Secondary-screen dwell gate. Phones deliberately do NOT get one — see the
    // PHONE_DETECTED block above for why a dwell requirement cannot see a
    // 5-frame glance. Laptops and TVs are standing objects and keep it.
    if (typeof DwellGate !== 'undefined') {
      deviceGate = new DwellGate({
        glanceMs: 0, alertMs: 4000, graceMs: 2600,
        maxSampleGapMs: 8000, minRealertMs: 30000,
      });
    }

    // Evidence history and gaze/classifier fusion. Both guarded on their globals
    // for the same reason deviceGate is: a stale unpacked build missing one
    // script must degrade to "that feature is off", never to a load failure that
    // takes proctoring down with it. Every call site below null-checks and falls
    // back to the previous live-snapshot behaviour.
    if (typeof EvidenceRingBuffer !== 'undefined') {
      evidenceBuffer = new EvidenceRingBuffer();
    }
    if (typeof GazeClassifierFusion !== 'undefined') {
      gazeFusion = new GazeClassifierFusion();
    }
    if (typeof DownwardGazeDetector !== 'undefined') {
      downwardGaze = new DownwardGazeDetector();
    }

    // ── Guest frame budget ────────────────────────────────────────────────
    //
    // A demo runs the landmarker on the same thread that paints the quiz the
    // visitor is reading. With a GPU delegate that is affordable; on CPU it is
    // not, and chasing Tier A's 50 ms target with a ~100 ms tick leaves zero
    // idle (see maybeRetierForMeasuredCost) — the camera preview visibly stalls
    // and the page stops responding. That is the reported "extreme frame lag".
    //
    // maybeRetierForMeasuredCost would eventually find this, but only after 8
    // consecutive overruns, i.e. after the visitor has already seen the stall.
    // The delegate tells us up front, so act on it up front. 15 FPS is enough
    // for every gate here (the shortest is the 1.5 s liveness challenge).
    if (guestSessionMode) {
      const delegate = visionEngine.mediaPipeSource && visionEngine.mediaPipeSource.delegate;
      const accelerated = delegate === 'GPU';

      // No delegate means FaceLandmarker built on NEITHER GPU nor CPU, so there
      // are no landmarks and nothing downstream can fire. Report it — see
      // postVisionStatus for why silence here is the dangerous outcome.
      if (!delegate) {
        postVisionStatus('OFFLINE', 'FaceLandmarker unavailable (CSP/WASM)');
      } else {
        postVisionStatus('ONLINE', `delegate=${delegate}`);
      }
      // ── Guest tick budget: 15 FPS on BOTH delegates ──────────────────────
      //
      // CPU used to get 100 ms (~10 FPS) on the assumption that a WASM delegate
      // could not hold 15. That was over-cautious: the guest pipeline is
      // MediaPipe ONLY — `offlineOnly` means pose.onnx and detect.onnx are never
      // fetched and best.onnx is skipped outright — so a guest tick is one
      // FaceLandmarker pass, not the three-graph load the 100 ms was sized for.
      //
      // ⚠ WHY A TIGHTER TARGET CANNOT PILE UP FRAMES. The loop is a
      // self-scheduling setTimeout measured FROM COMPLETION, never setInterval:
      //
      //     scheduleNextInference(max(proctorMinGapMs, proctorIntervalMs - lastInferenceMs))
      //
      // A machine that cannot hold the cadence therefore runs SLOWER; it can
      // never queue a tick it has not finished, so there is no buffer to build
      // up. `proctorIntervalMs` is a target, not a promise, and
      // `MIN_IDLE_FRACTION` is the real protection — it guarantees a floor of
      // idle time after every pass however long that pass took, so the
      // compositor always gets the camera feed painted. Two further nets sit
      // behind it: `inferenceInFlight` (no re-entry) and
      // `maybeRetierForMeasuredCost()` (8 consecutive overruns -> adopt
      // measured x1.35), which is what catches a machine slower than this
      // assumption rather than letting it saturate a core.
      const targetMs = 66;                  // ~15 FPS, both delegates
      const MIN_IDLE_FRACTION = 0.6;        // >=40 ms idle after every pass
      if (proctorIntervalMs < targetMs) {
        proctorIntervalMs = targetMs;
        proctorMinGapMs = Math.max(proctorMinGapMs, Math.round(targetMs * MIN_IDLE_FRACTION));
        console.log(
          `[AI Observer] Guest Mode: capping inference at ~${Math.round(1000 / targetMs)} FPS `
          + `(MediaPipe delegate: ${delegate || 'none'}${accelerated ? '' : ', CPU fallback'}) `
          + `to keep the exam UI responsive.`
        );
      }
    }

    // Anti-spoofing is only meaningful when there IS a head pose to watch, so
    // it is bound to the pose model's availability rather than started blindly.
    if (pose) initLivenessManager();

    // In guest mode the absent server is EXPECTED, so it gets one clean line
    // rather than an error per missing graph. Reporting a fault the visitor
    // cannot act on — and did not cause — trains people to ignore the console.
    if (guestSessionMode) {
      console.log(
        '[AI Observer] Guest Mode: Running local vision pipeline (standalone model server offline)'
        + ` — head pose via ${poseSource}, phone detection unavailable.`
      );
    } else {
      if (!pose) {
        console.error('[AI Observer] Pose model unavailable — head-pose alerts are DISABLED for this session.');
      }
      if (!detect) {
        console.warn('[AI Observer] Object detector unavailable — phone detection disabled.');
      }
    }
    return pose;
  } catch (err) {
    console.error('[AI Observer] Vision engine init failed:', err);
    visionEngine = null;
    return false;
  }
}

/**
 * Queue the next inference tick.
 * @param {number} delayMs
 */
function scheduleNextInference(delayMs) {
  if (!isProctoringActive) return;
  if (inferenceTimer) clearTimeout(inferenceTimer);
  inferenceTimer = setTimeout(runProctorInferenceTick, Math.max(0, delayMs));
}

/**
 * One inference cycle, then reschedule.
 *
 * This replaces setInterval(runProctorInference, proctorIntervalMs). That had
 * no in-flight guard: because the callback is async, an inference slower than
 * the interval caused calls to queue without bound, each holding its own
 * multi-MB input tensor while ORT serialised them on one WASM thread — the queue
 * could never drain. Scheduling from COMPLETION makes overlap impossible by
 * construction and degrades to a lower frame rate instead of collapsing.
 */
async function runProctorInferenceTick() {
  inferenceTimer = null;
  if (!isProctoringActive) return;

  // Checked once per tick rather than at each chrome.* call inside it. An
  // orphaned script would otherwise keep decoding frames and running inference
  // for a background context that no longer exists — burning the CPU of a tab
  // whose owner cannot see anything happening, and throwing on every violation
  // it tried to report.
  if (!extensionContextAlive()) { handleContextInvalidated('inferenceTick'); return; }

  if (document.hidden) {
    scheduleNextInference(1000);
    return;
  }

  const startedAt = performance.now();
  try {
    await runProctorInference();
  } catch (err) {
    console.error('[AI Observer] Inference tick failed:', err);
  }
  lastInferenceMs = performance.now() - startedAt;

  if (lastInferenceMs > proctorIntervalMs && !slowInferenceWarned) {
    slowInferenceWarned = true;
    const provider = window.getExecutionProvider ? window.getExecutionProvider() : 'unknown';
    const inputSize = window.getModelInputSize ? window.getModelInputSize() : '?';
    const tier = runtimeProfile ? runtimeProfile.tier : '?';
    console.warn(
      `[AI Observer] Inference took ${lastInferenceMs.toFixed(0)}ms vs the ${proctorIntervalMs}ms tier-${tier} target ` +
      `(provider: ${provider}, classifier input: ${inputSize}x${inputSize}). Effective rate ~${(1000 / lastInferenceMs).toFixed(2)} FPS. ` +
      `The loop degrades to this rate rather than queueing; re-export the models at a smaller imgsz to recover headroom.`
    );
  }

  maybeRetierForMeasuredCost();

  // Cadence is measured from completion, with a floor so a slow device never
  // busy-loops the main thread. A machine that cannot hold the tier's target
  // simply runs slower — it never queues work it can't drain.
  scheduleNextInference(Math.max(proctorMinGapMs, proctorIntervalMs - lastInferenceMs));
}

/**
 * Adopt a cadence the machine can actually hold.
 *
 * ⚠ Why this is needed even though the loop already "degrades gracefully".
 *
 * Scheduling from completion means we never queue work we cannot drain — but
 * with a 447 ms tick against a 50 ms target, `proctorIntervalMs - lastInferenceMs`
 * is negative on every tick, so the scheduler falls to `proctorMinGapMs` and the
 * loop runs FLAT OUT with zero idle. That is correct for detector throughput and
 * bad for everything else: it saturates a core for the whole exam, and the
 * student's actual exam UI stutters. A proctor that degrades the exam it is
 * proctoring has failed at its job.
 *
 * So once the tier's target is provably unreachable, stop chasing it. Adopt the
 * measured cost plus headroom, and leave the machine some air.
 *
 * The tier itself is NOT rewritten — `runtimeProfile.tier` still records what
 * the hardware probe decided, so telemetry stays honest about the difference
 * between "we chose Tier A" and "Tier A was not achievable here".
 */
const RETIER_SAMPLES = 8;        // consecutive overruns before acting
const RETIER_HEADROOM = 1.35;    // schedule at cost x this, so ~26% of time is idle
const RETIER_MAX_INTERVAL = 1000; // never degrade past 1 FPS — below this we are blind
let retierOverrunCount = 0;
let retierApplied = false;

function maybeRetierForMeasuredCost() {
  if (retierApplied || !Number.isFinite(lastInferenceMs)) return;

  if (lastInferenceMs <= proctorIntervalMs) {
    retierOverrunCount = 0;   // a single slow frame is noise, not a verdict
    return;
  }

  if (++retierOverrunCount < RETIER_SAMPLES) return;

  const realistic = Math.min(RETIER_MAX_INTERVAL, Math.round(lastInferenceMs * RETIER_HEADROOM));
  if (realistic <= proctorIntervalMs) return;

  const was = proctorIntervalMs;
  proctorIntervalMs = realistic;
  proctorMinGapMs = Math.max(proctorMinGapMs, Math.round(realistic * 0.5));
  retierApplied = true;

  // The classifier is corroboration-only and, at 640x640, is the single most
  // expensive thing in the tick. Back it off proportionally rather than letting
  // it dominate a budget it cannot justify — it can never raise an alert alone,
  // so sampling it less often costs accuracy nowhere.
  classifierIntervalMs = Math.max(classifierIntervalMs, realistic * 4);

  // ⚠ ONE LINE, ONCE PER SESSION — `retierApplied` above guarantees it, and the
  // per-frame overrun warning is separately gated by `slowInferenceWarned`.
  // Neither may become per-frame: at a 1340ms tick that is a console message
  // roughly every second, which buries the one line that actually says what
  // changed and costs measurable time in the very loop being diagnosed.
  //
  // Leads with the summary sentence, then the evidence. The provider is named
  // because "CPU fallback" and "GPU that failed to bind" need different fixes.
  const fps = (1000 / realistic).toFixed(1);
  const provider = (runtimeProfile && runtimeProfile.degradedToWasm) ? 'CPU fallback mode' : 'CPU mode';
  console.warn(
    `[AI Observer] Performance Tier adjusted: ${provider} operating at ~${fps} FPS. `
    + `(Tier-${runtimeProfile ? runtimeProfile.tier : '?'} target ${was}ms was unachievable — `
    + `measured ${lastInferenceMs.toFixed(0)}ms over ${RETIER_SAMPLES} ticks; classifier backed off to `
    + `${Math.round(classifierIntervalMs)}ms.) `
    + `To recover speed: re-export best.onnx at 224 — it is a STATIC 640x640 graph, `
    + `which is the bulk of this cost and cannot be downscaled at runtime.`
  );
}

async function runProctorInference() {
  if (!isProctoringActive || !webcamStream || !videoElement) return;
  if (inferenceInFlight) return; // belt-and-braces; the scheduler already serialises
  // ⚠ THE CLASSIFIER IS NOT A PREREQUISITE FOR THE TICK IN GUEST MODE.
  //
  // Guest sessions deliberately never load best.onnx, so isModelReady() is
  // permanently false there. Gating on it unconditionally would return before
  // the pose, gaze, phone and liveness stages — silently disabling every
  // detector because the ONE model that is not allowed to accuse anyone on its
  // own is missing.
  if (!guestSessionMode && window.isModelReady && !window.isModelReady()) return;

  inferenceInFlight = true;
  try {
    // Frozen-feed guard, BEFORE inference. A stuck webcam frame classifies the
    // same way every cycle, so a freeze on a cheating pose would flag forever.
    // The old code ran this on the model's own output canvas, i.e. after paying
    // the full inference cost on a frame it was about to throw away.
    const now = performance.now();
    const frame = analyzeFrameChange(videoElement);
    const sig = frame ? frame.signature : null;
    const pixelDelta = frame ? frame.delta : null;

    // TIER 1 — feed the pixel-delta watcher on EVERY frame, before any early
    // exit. This is the fix for the hole a frozen-feed short-circuit created:
    // the guard below used to `return` above the liveness code, which meant an
    // injected still image was permanently invisible to the challenge that
    // exists to catch it. Suspicion is raised here; only Tier 2 can confirm it.
    const syntheticSuspected = !!(livenessManager
      && livenessManager.syntheticMonitor.stats().suspected);
    const challengeActive = !!(livenessManager && livenessManager.isChallengeActive());

    if (sig !== null && sig === lastFrameSignature) {
      staleFrameCount++;
      if (staleFrameCount >= 2) {
        try { if (videoElement.paused) videoElement.play().catch(() => {}); } catch (e) {}

        // Keep running the models while a challenge is open, EVEN on identical
        // frames. A static image still yields a perfectly readable pose, and
        // those samples are what let the corner test conclude FAILED rather
        // than INCONCLUSIVE. Skipping them would make an injected still
        // unfalsifiable — it could never supply the evidence against itself.
        if (!challengeActive && !syntheticSuspected) {
          // Still advance the liveness clock so Tier 1 can accumulate and
          // escalate; just skip the expensive inference.
          if (livenessManager) livenessManager.update(null, now, pixelDelta);
          if (statusDot) statusDot.style.backgroundColor = '#9ca3af';
          if (statusLabel) statusLabel.textContent = 'Camera paused…';
          return; // do not count a frozen frame toward a pose/phone verdict
        }
      }
    } else {
      staleFrameCount = 0;
      lastFrameSignature = sig;
    }

    // --- 1. HEAD POSE (every frame, 256px, cheap) -------------------------
    // This is the primary detector. All head-movement alerting flows from the
    // calibrated, temporally-gated pipeline, never from a single frame.
    let poseResult = null;
    if (visionEngine && visionEngine.isPoseReady()) {
      // Set BEFORE the frame is analysed: the engine reads this flag while it
      // runs, so setting it afterwards would let one frame of ordered
      // corner-gazing through as an accusation.
      visionEngine.setGazeSuppressed(!!(livenessManager && livenessManager.isChallengeActive()));

      poseResult = await visionEngine.analyzeFrame(videoElement, now);
      if (poseResult) {
        // Feed the safeguard BEFORE any handler can report. Called on every
        // frame including landmark-less ones, so the sample ages out honestly
        // rather than licensing suppression off a reading that has gone stale.
        // faceLandmarks is null until a 478-point model is in the pipeline.
        if (earVetoGate) {
          earVetoGate.submitLandmarks(poseResult.faceLandmarks || null, now);
          // Coarse fallback channel. While faceLandmarks is null this is the
          // ONLY thing keeping blink immunity real rather than vacuous — with
          // neither, every evaluate() fails open and the safeguard is a no-op.
          // It can only ever add suppression; see submitClosureHint().
          earVetoGate.submitClosureHint(
            poseResult.eyeClosure ? poseResult.eyeClosure.closed : null, now);
        }

        // ⚠ CAPTURE BEFORE THE HANDLERS REPORT.
        //
        // The handlers call reportViolation, which reads the buffer to pick its
        // peak frame. Capturing afterwards would leave the frame that triggered
        // the alert missing from the very lookup the alert performs — worst on
        // the alert frame itself, which is often the strongest evidence in the
        // episode. This one line's ordering is the whole difference between
        // "peak of the episode" and "peak of the episode minus its climax".
        captureEvidenceFrame(poseResult, now);

        handlePoseEvents(poseResult);
        // Gaze rides on the same keypoints and the same frame. It self-
        // suppresses when the head is off neutral, so it never double-reports
        // an episode AI_CHEATING_POSE already owns.
        handleGazeEvents(poseResult.gaze);
        handleLandmarkGazeEvents(poseResult.landmarkGaze);
        handleDownwardGaze(poseResult, now);
      }
    }

    // --- 1b. ACTIVE LIVENESS (same yaw/pitch, no extra inference) ---------
    // Driven off the pose result rather than its own timer, so it advances in
    // lockstep with the loop and stops dead when the loop stops. A frame with
    // no usable pose is passed through as null, which the manager treats as
    // "unobserved" — never as "the student held still".
    if (livenessManager) {
      livenessManager.update(poseResult, now, pixelDelta);
    }

    // --- 2. OBJECT DETECTION (EVERY frame, alongside the pose model) ------
    // Runs continuously so a 1-5 frame phone glimpse cannot fall between two
    // sampling slots. null means "no new information" (a run was already in
    // flight, or the frame was unusable) and must NOT be treated as an
    // all-clear — handleObjectDetections is skipped entirely so the latch's
    // frame counter only advances on frames we actually looked at.
    if (visionEngine) {
      const detections = await visionEngine.maybeDetectObjects(videoElement, now);
      if (detections !== null) handleObjectDetections(detections, now);
    }

    // --- 3. CLASSIFIER (time-sliced corroboration ONLY) -------------------
    // Cannot raise an alert by itself; it only escalates severity on an episode
    // that the pose pipeline has already confirmed.
    // Skipped outright in guest mode, where best.onnx was never loaded — calling
    // predictFrame() against a null session throws once per classifier interval.
    if (!guestSessionMode
      && USE_CLASSIFIER_CORROBORATION
      && (now - lastClassifierRunMs) >= classifierIntervalMs) {
      lastClassifierRunMs = now;
      const prediction = await window.predictFrame(videoElement);
      if (prediction) {
        const cheatingProb = prediction.probs.cheating;
        const isCheatingFrame = prediction.label === 'cheating';

        cheatFrameWindow.push({ prob: cheatingProb, cheating: isCheatingFrame });
        if (cheatFrameWindow.length > AI_WINDOW_FRAMES) cheatFrameWindow.shift();

        // Timestamped, so the fusion can refuse a reading that pre-dates the
        // gaze episode. At a 3-6 s classifier interval an untimed value would
        // routinely describe a different moment entirely.
        if (gazeFusion) gazeFusion.submitClassifier(cheatingProb, now);

        // Hand the raw p_cheating to the NEXT evidence capture, which happens
        // on the following frame. One-shot: see captureEvidenceFrame for why a
        // held-forward value would flatten the peak ranking.
        _pCheatingFresh = cheatingProb;

        if (isCheatingFrame && (!bestEvidence || cheatingProb > bestEvidence.prob)) {
          bestEvidence = { prob: cheatingProb, snapshot: captureWebcamSnapshot(0.8) };
        }

        const votes = cheatFrameWindow.reduce((n, f) => n + (f.cheating ? 1 : 0), 0);
        const ratio = cheatFrameWindow.length ? votes / cheatFrameWindow.length : 0;
        evaluateCheatWindow(votes, ratio, prediction);
      }
    }

    updatePoseStatus(poseResult);
  } catch (err) {
    console.error('[AI Observer] Inference error:', err);
  } finally {
    inferenceInFlight = false;
  }
}

/**
 * Live widget status driven by the pose pipeline. Display only — never reports.
 *
 * Surfacing the calibration phase matters: for the first few seconds the system
 * genuinely is not watching head pose yet, and showing "Calibrating" is both
 * honest and tells the student to sit normally while the neutral is measured.
 *
 * @param {object|null} result - HeadPoseAnalyzer result, or null when unavailable.
 */
function updatePoseStatus(result) {
  if (!statusDot || !statusLabel) return;

  // The challenge takes over the widget: during those 3.5 s "Flagged" would be
  // both wrong and alarming, since looking away is the instruction.
  if (livenessManager && livenessManager.isChallengeActive()) {
    statusDot.style.backgroundColor = '#00ffc3';
    statusLabel.textContent = 'Quick check';
    return;
  }

  if (!result) {
    statusDot.style.backgroundColor = '#9ca3af';
    statusLabel.textContent = visionEngine && visionEngine.isPoseReady() ? 'Watching' : 'Pose off';
    return;
  }

  switch (result.status) {
    case 'calibrating':
      statusDot.style.backgroundColor = '#818cf8';
      statusLabel.textContent = `Calibrating ${Math.round(result.calibrationProgress * 100)}%`;
      break;
    case 'alert':
      statusDot.style.backgroundColor = '#ff3333';
      statusLabel.textContent = 'Flagged';
      break;
    case 'glance':
      statusDot.style.backgroundColor = '#f59e0b';
      statusLabel.textContent = 'Checking';
      break;
    case 'no_face':
      statusDot.style.backgroundColor = '#f59e0b';
      statusLabel.textContent = 'No face';
      break;
    case 'multi_face':
      statusDot.style.backgroundColor = '#ff3333';
      statusLabel.textContent = 'Multiple people';
      break;
    case 'face_lost':
      statusDot.style.backgroundColor = '#9ca3af';
      statusLabel.textContent = 'Face not visible';
      break;
    default:
      statusDot.style.backgroundColor = '#10b981';
      statusLabel.textContent = 'Normal';
  }
}

/**
 * Turn pose-pipeline events into violations.
 *
 * By the time an event arrives here it has already survived calibration,
 * median smoothing and a dwell gate, so no further windowing is applied. A
 * 'HIGH' event means the deviation persisted past 2.5 s; 'LOW' means it lasted
 * between 1.5 s and 2.5 s and is recorded for review WITHOUT being escalated.
 *
 * @param {object} result - HeadPoseAnalyzer result.
 */
function handlePoseEvents(result) {
  // A liveness challenge ORDERS the student to look at a screen corner. Holding
  // that gaze past 2.5 s is exactly what the look-away dwell gate reports as
  // AI_CHEATING_POSE — so without this the system would flag a student for
  // obeying its own instruction.
  //
  // Suppression happens HERE, in the reporting layer, and only for the
  // look-away conditions. The pose pipeline itself is untouched: it still runs,
  // still gates, still tracks dwell, and its events still reach telemetry. Only
  // the accusation is withheld, and only while the dot is up. NO_FACE and
  // MULTIPLE_FACES stay live throughout — nothing about a corner prompt
  // excuses a second person in frame.
  const inLivenessChallenge = !!(livenessManager && livenessManager.isChallengeActive());

  for (const ev of result.events) {
    const corroborated = classifierCorroborates();

    if (inLivenessChallenge && (ev.condition === 'LOOK_AWAY')) {
      console.log(
        `[AI Observer] Suppressing ${ev.condition}/${ev.severity} — the student is responding to ` +
        `a liveness challenge at ${livenessManager.activeCorner}.`
      );
      continue;
    }

    if (ev.condition === 'LOOK_AWAY') {
      if (ev.severity === 'LOW') {
        reportViolation(ViolationType.HEAD_POSE_GLANCE, {
          aiConfidence: ev.peak,
          metadata: { ...ev.detail, dwell_ms: ev.dwellMs, escalated: false },
        });
        continue;
      }

      // Peak frame of the episode, not the live one. The dwell gate fires
      // 2.5 s after onset, by which point a student who glanced at notes is
      // usually facing forward again — the live snapshot then contradicts the
      // alert it is supposed to evidence.
      const evidence = peakEvidenceFor(performance.now(), ev.dwellMs);

      reportViolation(ViolationType.AI_CHEATING_POSE, {
        aiConfidence: ev.peak,
        snapshotB64: evidence.image,
        // Escalate only when the independent classifier agrees.
        severityOverride: corroborated ? Severity.CRITICAL : undefined,
        metadata: {
          ...ev.detail,
          dwell_ms: ev.dwellMs,
          detector: 'head_pose_geometry',
          classifier_corroborated: corroborated,
          evidence: evidence.evidence,
          vision: visionEngine ? visionEngine.telemetry() : null,
          liveness: livenessManager ? livenessManager.telemetry() : null,
        },
      });
      continue;
    }

    if (ev.condition === 'NO_FACE' && ev.severity === 'HIGH') {
      reportViolation(ViolationType.NO_FACE_DETECTED, {
        snapshotB64: captureWebcamSnapshot(0.8),
        metadata: { ...ev.detail, dwell_ms: ev.dwellMs },
      });
      continue;
    }

    if (ev.condition === 'MULTIPLE_FACES' && ev.severity === 'HIGH') {
      reportViolation(ViolationType.MULTIPLE_FACES, {
        snapshotB64: captureWebcamSnapshot(0.8),
        metadata: { ...ev.detail, dwell_ms: ev.dwellMs },
      });
    }
  }
}

/**
 * Report eye-gaze events.
 *
 * ⚠ READ THIS BEFORE ADDING ANY CONDITION HERE.
 *
 * The trained classifier's original defect was flagging CLOSED EYES as
 * cheating, and a naive iris tracker reproduces it — a shut lid's darkest
 * feature is the lash line, which sits low, so a centroid reads it as "looking
 * down at notes". gaze_roi.js makes that impossible upstream by returning
 * UNKNOWN (never a direction) for an unreadable eye, and DwellGate needs
 * sustained TRUE to fire.
 *
 * This function must never weaken that. It reports what the analyser already
 * decided and adds no condition of its own. In particular: an absent or
 * unreadable gaze sample is NOT a finding here. Silence is the correct output
 * for a student who blinks, dozes, wears heavy glasses, or sits too far from
 * the camera for their irises to resolve.
 *
 * @param {{events:Array<object>}|null} gazeResult - GazeAnalyzer output.
 */
function handleGazeEvents(gazeResult) {
  if (!gazeResult || !gazeResult.events || !gazeResult.events.length) return;

  for (const ev of gazeResult.events) {
    if (ev.condition !== 'GAZE_OFF_SCREEN') continue;

    // LOW is the glance tier: recorded for the teacher's context, never
    // escalated. Same treatment HEAD_POSE_GLANCE gets.
    if (ev.severity === 'LOW') {
      reportViolation(ViolationType.GAZE_OFF_SCREEN, {
        aiConfidence: ev.peak,
        severityOverride: Severity.LOW,
        metadata: { ...ev.detail, dwell_ms: ev.dwellMs, detector: 'gaze_roi', escalated: false },
      });
      continue;
    }

    // Sustained. Capped at MEDIUM and deliberately NOT escalated by the
    // classifier: this signal is coarse (left/centre/right, not point-of-
    // regard), and the classifier has no notion of eye direction either, so
    // pairing them would stack two weak signals into a strong-looking claim.
    //
    // ⚠ The fusion in handleLandmarkGazeEvents does NOT extend here. That path
    // measures ratios of landmark distances; this one measures pixel darkness
    // and was withdrawn over lighting and skin-tone variance. Boosting a signal
    // whose errors are unevenly distributed across students is a fairness
    // problem, not just an accuracy one.
    const gazeEvidence = peakEvidenceFor(performance.now(), ev.dwellMs);

    reportViolation(ViolationType.GAZE_OFF_SCREEN, {
      aiConfidence: ev.peak,
      snapshotB64: gazeEvidence.image,
      metadata: {
        ...ev.detail,
        dwell_ms: ev.dwellMs,
        detector: 'gaze_roi',
        head_neutral: true,
        evidence: gazeEvidence.evidence,
      },
    });
  }
}

/**
 * Report landmark-geometry side gaze (gaze_landmarks.js).
 *
 * Kept as a SEPARATE violation type from GAZE_OFF_SCREEN even though both mean
 * "the eyes were off-axis". The two are produced by instruments with very
 * different reliability — one measures ratios of landmark distances (invariant
 * to illumination and pigmentation by construction), the other measures pixel
 * darkness (which failed field testing on exactly those axes). Collapsing them
 * would hide from a reviewer which one made the claim.
 *
 * Both eye-related types are on ear_veto.js's allowlist, so the EAR veto is
 * inherited at reportViolation() with no code here — a blink cannot reach a
 * teacher through this path.
 *
 * ⚠ INERT while `faceLandmarks` is null. The analyser runs and reaches
 * telemetry, but produces no samples, so no events. That is correct: an
 * unreadable observation is UNKNOWN, never deviant.
 */
function handleLandmarkGazeEvents(gazeResult) {
  if (!gazeResult || !gazeResult.events || !gazeResult.events.length) return;

  for (const ev of gazeResult.events) {
    if (ev.condition !== 'SIDE_GAZE_PEEKING') continue;

    // Glance tier: context for the teacher, never an escalation. Same treatment
    // HEAD_POSE_GLANCE and the gaze_roi glance tier get.
    if (ev.severity === 'LOW') {
      reportViolation(ViolationType.SIDE_GAZE_PEEKING, {
        aiConfidence: ev.peak,
        severityOverride: Severity.LOW,
        metadata: { ...ev.detail, dwell_ms: ev.dwellMs, detector: 'gaze_landmarks', escalated: false },
      });
      continue;
    }

    // Sustained (>= alertMs). MEDIUM by default.
    //
    // ⚠ THE ONE CASE THAT ESCALATES, AND WHY IT IS NOT THE THING THIS COMMENT
    // USED TO FORBID. The rule was "never escalated by the classifier", because
    // best.onnx has no notion of eye direction and pairing two weak signals
    // manufactures a strong-looking claim. That still holds for MANUFACTURING a
    // claim — and fusion cannot do that here. The event has already been raised
    // by GazeLandmarkAnalyzer on its own evidence, through its own calibration,
    // absolute band, head-neutrality test and dwell gate. Fusion only answers
    // "does an independent instrument agree about this same moment?", and can
    // move MEDIUM to HIGH. It can never turn silence into an accusation, it
    // cannot reach CRITICAL, and because the type is unchanged the event stays
    // on ear_veto.js's allowlist, so a blink still suppresses it. See
    // gaze_fusion.js for the four bounds.
    const nowFusion = performance.now();
    const fusion = gazeFusion
      ? gazeFusion.evaluate({
        excursion: ev.detail ? ev.detail.excursion : NaN,
        absOffset: (ev.detail && Number.isFinite(ev.detail.hRatio))
          ? ev.detail.hRatio - 0.5
          : NaN,
        dwellMs: ev.dwellMs,
      }, nowFusion)
      : null;

    const landmarkEvidence = peakEvidenceFor(nowFusion, ev.dwellMs);

    reportViolation(ViolationType.SIDE_GAZE_PEEKING, {
      aiConfidence: (fusion && fusion.boost) ? fusion.aggregate : ev.peak,
      snapshotB64: landmarkEvidence.image,
      severityOverride: (fusion && fusion.boost) ? Severity.HIGH : undefined,
      metadata: {
        ...ev.detail,
        dwell_ms: ev.dwellMs,
        detector: 'gaze_landmarks',
        head_neutral: true,
        evidence: landmarkEvidence.evidence,
        fusion: fusion ? { verdict: fusion.verdict, ...fusion.detail } : null,
      },
    });
  }
}

/**
 * Drive the downward-gaze detector and report its outcome.
 *
 * ⚠ WHY THIS EXISTS AS A SEPARATE DETECTOR. Live testing found a student
 * reading a phone flat on the desk went completely unflagged: the object
 * detector saw a foreshortened, hand-occluded rectangle and correctly rejected
 * it against the phone shape gate, the head barely left its calibrated band,
 * and the classifier has no notion of gaze direction. The only thing that moved
 * was the iris, dropping in the eye opening for as long as the screen was read.
 *
 * ⚠ TWO SIGN CONVENTIONS, AND THEY DISAGREE. `deviation.pitchDev` comes from
 * gaze_landmarks.js:510, which negates vRatio into pose convention, so
 * NEGATIVE IS DOWN here. `ear_veto.js`'s vOffset uses the opposite sign. Both
 * quantities are passed through under their own names and never derived from
 * one another — see downward_gaze.js.
 *
 * ⚠ THE KEYBOARD PERMIT IS CONSULTED, NOT BYPASSED. Looking down is what typing
 * looks like, and ear_veto.js's KeyboardGlancePermit exists to forgive exactly
 * that. Passing `permitGranted` in means a forgiven frame accumulates no dwell
 * at all, so a typist is never accused; a reader is, because the permit expires
 * mid-episode and its long-glance budget withdraws forgiveness outright.
 *
 * @param {object} poseResult - Vision engine frame result.
 * @param {number} nowMs
 */
function handleDownwardGaze(poseResult, nowMs) {
  if (!downwardGaze || !poseResult) return;

  const lg = poseResult.landmarkGaze;
  const analyzer = visionEngine ? visionEngine.landmarkGazeAnalyzer : null;
  // The absolute iris height lives on the analyser's last sample; the per-frame
  // result carries only the calibrated deviation. Both are required — see
  // downward_gaze.js for why either alone is unfair or exploitable.
  const sample = analyzer ? analyzer.lastSample : null;

  // ⚠ AGE THE ABSOLUTE READING. `lastSample` is assigned only on a VALID sample
  // and is never cleared on an unreadable frame, so it can outlive the frame
  // that produced it and get mixed with a fresh pitchDev — see maxSampleAgeMs
  // in downward_gaze.js for why that combination would be a false accusation.
  //
  // Freshness is detected by OBJECT IDENTITY, not by inspecting the values.
  // analyzeGazeLandmarks() returns a new object per call and gaze_landmarks.js
  // assigns it only in its valid branch, so "the reference changed" is a direct
  // observation that a new reading was produced on this frame. That is strictly
  // better than inferring freshness from `lg.deviation` being non-null:
  // deviation is additionally gated on the baseline being calibrated, so during
  // calibration it is null while lastSample updates perfectly well. Identity
  // tracks the thing we actually care about, and stays correct if that coupling
  // ever changes — which is the entire point of this guard.
  if (sample && sample !== _downSampleRef) {
    _downSampleRef = sample;
    _downSampleAtMs = nowMs;
  }
  const sampleAgeMs = Number.isFinite(_downSampleAtMs) ? nowMs - _downSampleAtMs : Infinity;

  const res = downwardGaze.process({
    sampleAgeMs,
    vRatio: sample && Number.isFinite(sample.vRatio) ? sample.vRatio : NaN,
    pitchDev: lg && lg.deviation && Number.isFinite(lg.deviation.pitchDev)
      ? lg.deviation.pitchDev : NaN,
    ear: lg && Number.isFinite(lg.ear) ? lg.ear : NaN,
    // gaze_landmarks already refuses to sample off-neutral, so an unreadable
    // frame arrives as NaN above rather than as a false head-neutral claim.
    headNeutral: !(lg && lg.status === 'head_off_neutral'),
    permitGranted: !!(earVetoGate && earVetoGate.permit
      && earVetoGate.permit.isGranted(nowMs)),
  }, nowMs, !!(livenessManager && livenessManager.isChallengeActive()));

  if (!res.events.length) return;

  for (const ev of res.events) {
    // Fusion may raise this one episode to HIGH when the classifier
    // independently agrees on the same moment. It can never create the event —
    // the dwell gate above already did, on iris geometry alone.
    const fusion = gazeFusion
      ? gazeFusion.evaluate({
        excursion: lg ? lg.smoothedExcursion : NaN,
        absOffset: NaN,                       // this is the vertical case
        pitchDev: ev.detail.pitchDev,
        dwellMs: ev.dwellMs,
      }, nowMs)
      : null;

    const evidence = peakEvidenceFor(nowMs, ev.dwellMs);

    reportViolation(ViolationType.DOWNWARD_GAZE_LOOKAWAY, {
      aiConfidence: (fusion && fusion.boost) ? fusion.aggregate : ev.peak,
      snapshotB64: evidence.image,
      severityOverride: (fusion && fusion.boost) ? Severity.HIGH : undefined,
      metadata: {
        ...ev.detail,
        dwell_ms: ev.dwellMs,
        head_neutral: true,
        // Recorded so a reviewer can see this fired WITHOUT a phone label —
        // which is the entire point of the detector.
        phone_label_present: PHONE_DETECTED,
        keyboard_permit: (earVetoGate && earVetoGate.permit)
          ? earVetoGate.permit.snapshot(nowMs) : null,
        evidence: evidence.evidence,
        fusion: fusion ? { verdict: fusion.verdict, ...fusion.detail } : null,
      },
    });
  }
}

/**
 * Report object detections. Called once per PROCESSED frame.
 *
 * PHONES — latch and hold. Every detection reaching this point has already
 * cleared the high confidence floor and the aspect-ratio guard in
 * vision_engine._applyPhoneGate, so a single qualifying frame is treated as
 * real and reported immediately. No dwell, no second round: the behaviour being
 * caught is a 1-5 frame glance, and anything that waits for persistence will
 * miss it by construction. The latch then holds PHONE_DETECTED true for at
 * least 45 frames and 1.5 s so hiding the phone cannot un-report it.
 *
 * DEVICES (laptop/TV) — still dwell-gated. They are furniture; one frame of a
 * monitor edge means nothing and four seconds of one means something.
 *
 * @param {Array<{score:number, classId:number, box:object, shape?:object}>} detections
 * @param {number} nowMs
 */
function handleObjectDetections(detections, nowMs) {
  if (!visionEngine) return;

  phoneFrameIndex++;

  const phones = detections.filter((d) => d.classId === COCO_CELL_PHONE);
  const devices = detections.filter((d) => d.classId === COCO_LAPTOP || d.classId === COCO_TV);

  const bestPhone = phones.reduce((a, b) => (!a || b.score > a.score ? b : a), null);

  // Snapshot on the FRAME OF THE HIT. Capturing later — after the latch has
  // been held for a second — photographs an empty desk, which is worthless as
  // evidence and is exactly what a student hiding the phone is counting on.
  if (bestPhone && (!lastPhoneEvidence || bestPhone.score > lastPhoneEvidence.score)) {
    lastPhoneEvidence = {
      score: bestPhone.score,
      snapshot: captureWebcamSnapshot(0.85),
      frame: phoneFrameIndex,
      box: bestPhone.box,
      shape: bestPhone.shape || null,
    };
  }

  const latch = visionEngine.updatePhoneLatch(
    phones.length > 0,
    nowMs,
    bestPhone ? bestPhone.score : 0
  );

  if (latch) {
    PHONE_DETECTED = latch.active;

    if (latch.event === 'latch') {
      // Fires on the FIRST qualifying frame. reportViolation's per-type cooldown
      // (VIOLATION_COOLDOWN_MS) is what stops a phone left on the desk from
      // producing an alert every time the latch cycles.
      const evidence = lastPhoneEvidence;
      reportViolation(ViolationType.PHONE_DETECTED, {
        aiConfidence: bestPhone ? bestPhone.score : latch.peakScore,
        snapshotB64: (evidence && evidence.snapshot) || captureWebcamSnapshot(0.85),
        metadata: {
          detector: 'yolo11n_coco',
          coco_class: COCO_CELL_PHONE,
          decision: 'latch_and_hold',
          detections: phones.length,
          max_score: Number((bestPhone ? bestPhone.score : latch.peakScore).toFixed(3)),
          // What the shape guard concluded, so a review can tell a clear
          // rectangular phone from a borderline square that only passed
          // because it was very high confidence.
          shape: bestPhone && bestPhone.shape ? bestPhone.shape : null,
          // ⚠ THE OPERATING POINT THAT ADMITTED THIS DETECTION.
          //
          // The phone floor was lowered to 0.30 with no dwell requirement (see
          // PHONE_SHAPE_DEFAULTS), so this violation can now be raised from a
          // single frame scoring barely above a third. PHONE_DETECTED is
          // CRITICAL, and a teacher reviewing the incident must be able to tell
          // a 0.31 detection from a 0.95 one — without this field both render
          // identically as "phone detected", which is the difference between an
          // auditable call and an unfalsifiable one.
          confidence_floor: (typeof PHONE_SHAPE_DEFAULTS !== 'undefined')
            ? PHONE_SHAPE_DEFAULTS.minConfidence : null,
          square_confidence_floor: (typeof PHONE_SHAPE_DEFAULTS !== 'undefined')
            ? PHONE_SHAPE_DEFAULTS.squareConfidence : null,
          hold_frames: (visionEngine.phoneLatch && visionEngine.phoneLatch.opt.holdFrames) || null,
          hold_ms: (visionEngine.phoneLatch && visionEngine.phoneLatch.opt.holdMs) || null,
          frame_index: phoneFrameIndex,
          tier: runtimeProfile ? runtimeProfile.tier : null,
          boxes: phones.slice(0, 3).map((d) => ({
            x1: Math.round(d.box.x1), y1: Math.round(d.box.y1),
            x2: Math.round(d.box.x2), y2: Math.round(d.box.y2),
            score: Number(d.score.toFixed(3)),
            aspect_ratio: d.shape ? d.shape.aspectRatio : null,
          })),
        },
      });
      console.warn(
        `[AI Observer] PHONE LATCHED on frame ${phoneFrameIndex} ` +
        `(score ${(bestPhone ? bestPhone.score : 0).toFixed(2)}, ` +
        `ar ${bestPhone && bestPhone.shape ? bestPhone.shape.aspectRatio : '?'}) — ` +
        `holding for >=${latch.framesRemaining} frames.`
      );
    } else if (latch.event === 'release') {
      console.log(
        `[AI Observer] Phone latch released after ${latch.heldFrames} frames / ` +
        `${Math.round(latch.heldMs)}ms (${latch.hitCount} hit frames).`
      );
      lastPhoneEvidence = null;
    }
  }

  // Only run the device gate if the decoder was actually asked for those
  // classes — otherwise `devices` is permanently empty and this is dead code
  // masquerading as a working detector. Enable via VisionEngine's
  // detectClassFilter (see VISION_DEFAULTS).
  if (deviceGate && visionEngine && visionEngine.detectsClass(COCO_LAPTOP)) {
    const bestDev = devices.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
    const devRes = deviceGate.update(devices.length > 0, nowMs, bestDev ? bestDev.score : 0);
    if (devRes.event === 'alert') {
      reportViolation(ViolationType.SECONDARY_DEVICE, {
        aiConfidence: devRes.peak,
        snapshotB64: captureWebcamSnapshot(0.85),
        metadata: {
          detector: 'yolo11n_coco',
          classes: devices.map((d) => d.classId),
          dwell_ms: devRes.dwellMs,
        },
      });
    }
  }
}

/** @returns {boolean} True if the corroborating classifier is currently flagged. */
function classifierCorroborates() {
  if (!USE_CLASSIFIER_CORROBORATION || aiFlagState !== 'flagged') return false;

  // ⚠ The original defect, closed at its source. This classifier is what
  // produced the "I closed my eyes and got flagged" reports; its only remaining
  // power is escalating a pose-confirmed episode to CRITICAL. On a frame where
  // the eyes are VERIFIABLY closed, its opinion is exactly the one we know to
  // be untrustworthy, so it does not get to escalate.
  //
  // eyesVerifiablyClosed() is false when we cannot tell, so this inherits the
  // fail-open property and changes nothing until landmarks exist.
  if (earVetoGate && earVetoGate.eyesVerifiablyClosed(performance.now())) {
    console.warn(
      '[AI Observer] Primary model alert vetoed by EAR safeguard (Eye Closed/Blink) — ' +
      'classifier corroboration withheld.'
    );
    return false;
  }
  return true;
}

/**
 * Cheap perceptual signature of a frame. Two consecutive identical signatures
 * indicate a frozen feed (live webcams always vary from sensor noise).
 *
 * Uses a 32x32 downsample of the RAW video via a reusable canvas, and an FNV-1a
 * style hash that mixes position. The previous version summed channel values,
 * which is order-independent and collides readily on low-texture frames.
 *
 * @param {HTMLVideoElement|HTMLCanvasElement} source
 * @returns {number|null}
 */
function frameSignature(source) {
  const r = analyzeFrameChange(source);
  return r ? r.signature : null;
}

/**
 * Hash AND measure the frame in ONE pass.
 *
 * The hash answers "is this byte-identical to the last frame?" (the frozen-feed
 * guard). The delta answers "by how much did it change?" — Tier 1 of the
 * anti-spoofing architecture.
 *
 * Both come off the same 32x32 downsample and the same single getImageData, so
 * adding the delta costs one extra subtract-and-accumulate per pixel and no
 * extra readback. That matters: getImageData is the expensive part and this
 * runs on every frame of the loop.
 *
 * NOTE ON THE DOWNSAMPLE: averaging to 32x32 suppresses sensor noise, which is
 * part of why zero delta CANNOT be read as proof of a synthetic feed on its own
 * — a real camera on a still, well-lit subject can round to the same values.
 * Confirming it is Tier 2's job. See SyntheticFrameMonitor.
 *
 * @param {HTMLVideoElement|HTMLCanvasElement} source
 * @returns {{signature:number, delta:number|null}|null}
 *   delta is the mean absolute per-channel difference (0-255), or null on the
 *   first frame where there is nothing to compare against.
 */
function analyzeFrameChange(source) {
  try {
    const w = source.videoWidth || source.width;
    const h = source.videoHeight || source.height;
    if (!w || !h) return null;

    if (!_sigCanvas) {
      _sigCanvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(32, 32)
        : document.createElement('canvas');
      _sigCanvas.width = 32;
      _sigCanvas.height = 32;
      _sigCtx = _sigCanvas.getContext('2d', { willReadFrequently: true });
    }

    _sigCtx.drawImage(source, 0, 0, 32, 32);
    const data = _sigCtx.getImageData(0, 0, 32, 32).data;

    const px = 32 * 32;
    if (!_prevFramePixels) _prevFramePixels = new Uint8ClampedArray(px * 3);

    let hash = 0x811c9dc5 | 0;
    let diffSum = 0;
    for (let i = 0, p = 0, q = 0; i < px; i++, p += 4, q += 3) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];

      hash = Math.imul(hash ^ r, 16777619);
      hash = Math.imul(hash ^ g, 16777619);
      hash = Math.imul(hash ^ b, 16777619);

      diffSum += Math.abs(r - _prevFramePixels[q])
        + Math.abs(g - _prevFramePixels[q + 1])
        + Math.abs(b - _prevFramePixels[q + 2]);

      _prevFramePixels[q] = r;
      _prevFramePixels[q + 1] = g;
      _prevFramePixels[q + 2] = b;
    }

    const delta = _hasPrevFrame ? diffSum / (px * 3) : null;
    _hasPrevFrame = true;
    return { signature: hash, delta };
  } catch (e) {
    return null;
  }
}

/**
 * Sliding-window verdict with hysteresis.
 *
 * Arms when >= AI_ARM_RATIO of the window is cheating, disarms when it falls to
 * <= AI_DISARM_RATIO. The band between the two is what stops a borderline
 * student flapping between flagged and clear. Evaluated EVERY frame, so a
 * sustained episode can no longer hide by straddling a window boundary the way
 * it could with the old tumbling window.
 *
 * @param {number} votes - Cheating frames in the window.
 * @param {number} ratio - votes / window length.
 * @param {object} prediction - The current frame's prediction (evidence fallback).
 */
function evaluateCheatWindow(votes, ratio, prediction) {
  // Decide only on a FULL window, so AI_ARM_RATIO always means the same thing.
  // On a partial buffer during warm-up, 6 consecutive cheating frames give a
  // ratio of 1.0 and would arm off a 6-frame sample — a materially laxer
  // threshold than the 7-of-10 the configuration advertises. The buffer is only
  // ever partial at session start (it is not cleared on disarm), so this just
  // means the first verdict cannot land before AI_WINDOW_FRAMES frames.
  if (cheatFrameWindow.length < AI_WINDOW_FRAMES) return;

  // Already flagged: only look for the disarm condition.
  if (aiFlagState === 'flagged') {
    if (ratio <= AI_DISARM_RATIO) {
      aiFlagState = 'clear';
      bestEvidence = null;
      console.log('[AI Observer] Camera state -> CLEAR');
    }
    return;
  }

  if (ratio < AI_ARM_RATIO) return;

  aiFlagState = 'flagged';
  lastAiFlagAt = Date.now();

  console.log(
    `[AI Observer] Classifier ARMED ` +
    `(${votes}/${cheatFrameWindow.length}, ratio ${(ratio * 100).toFixed(0)}%).`
  );

  // The classifier alerts on its own evidence ONLY when the EAR safeguard is
  // actually running. See CLASSIFIER_PRIMARY. Without it this stays exactly
  // what it was before: corroboration state that handlePoseEvents reads to
  // escalate a pose-CONFIRMED episode.
  if (!classifierMayAlertAlone()) return;

  // The eyes-closed exception is applied inside reportViolation() via the
  // shared veto gate, so it cannot be bypassed by a future caller reaching this
  // path some other way. AI_CHEATING_CLASSIFIER is on VETOABLE_VIOLATIONS.
  reportViolation(ViolationType.AI_CHEATING_CLASSIFIER, {
    aiConfidence: bestEvidence ? bestEvidence.prob : (prediction && prediction.probs
      ? prediction.probs.cheating : ratio),
    snapshotB64: (bestEvidence && bestEvidence.snapshot) || captureWebcamSnapshot(0.8),
    metadata: {
      detector: 'best_onnx_classifier',
      votes,
      window: cheatFrameWindow.length,
      ratio: Number(ratio.toFixed(3)),
      arm_ratio: AI_ARM_RATIO,
      // Recorded so a reviewer can see whether head geometry agreed. The
      // classifier is NOT gated on this — it alerts independently — but an
      // episode both detectors saw is worth more than one only this saw.
      pose_agrees: !!(visionEngine && visionEngine.analyzer
        && visionEngine.analyzer.snapshot().poseState === 'alert'),
      classifier_input: window.getModelInputSize ? window.getModelInputSize() : null,
    },
  });
}

/**
 * May the classifier raise an alert without pose confirmation?
 *
 * ⚠ Requires the EAR safeguard to be LIVE, not merely configured. The veto
 * fails open, so an absent landmark model means no protection at all — and the
 * rule the user specified ("classify as cheating, except when MediaPipe detects
 * closed eyes") cannot be applied when MediaPipe is not there to detect
 * anything. Promoting the model anyway would reinstate the exact false positive
 * the exception exists to prevent.
 *
 * Logged once so the reason is visible rather than mysterious.
 *
 * @returns {boolean}
 */
let classifierPrimaryBlockedLogged = false;
function classifierMayAlertAlone() {
  if (!CLASSIFIER_PRIMARY) return false;

  const live = !!(earVetoGate && earVetoGate.hasFreshSample(performance.now()));
  if (!live) {
    if (!classifierPrimaryBlockedLogged) {
      classifierPrimaryBlockedLogged = true;
      console.warn(
        '[AI Observer] Classifier is configured as a primary detector, but the EAR safeguard ' +
        'has no live landmark data, so the "unless the eyes are closed" exception cannot be ' +
        'applied. Holding the classifier at corroboration-only until a face-landmark model is ' +
        'served. This is deliberate: promoting it now would reinstate the closed-eyes false ' +
        'positive it was demoted for.'
      );
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

async function sendHeartbeat() {
  if (!isProctoringActive) return;
  flushOfflineQueue();

  if (!window.SafeTestSupabase || !proctorSessionId) return;
  const result = await window.SafeTestSupabase.heartbeat(proctorSessionId, timingStatus);
  if (!result.ok) {
    console.error('[AI Observer] Heartbeat failed:', result.reason);
  }
}

// ---------------------------------------------------------------------------
// Floating Widget UI
// ---------------------------------------------------------------------------

function createFloatingWidget() {
  removeFloatingWidget();

  // A slim horizontal bar pinned to the TOP-CENTER of the page — right under the
  // laptop webcam. This way, when the student glances at their status their eyes
  // travel UP toward the camera (not down), so checking the status does not read
  // as "looking away". It is deliberately tiny to stay unobtrusive.
  floatingWidget = document.createElement('div');
  floatingWidget.id = 'ai-proctor-floating-widget';
  Object.assign(floatingWidget.style, {
    position: 'fixed',
    top: '0',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    height: '24px',
    padding: '0 12px',
    backgroundColor: 'rgba(13, 13, 17, 0.9)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderTop: 'none',
    borderRadius: '0 0 10px 10px',
    boxShadow: '0 4px 18px rgba(0, 0, 0, 0.45)',
    zIndex: '2147483646',
    fontFamily: "'Inter', 'Outfit', system-ui, sans-serif",
    color: '#f3f4f6',
    fontSize: '10px',
    lineHeight: '1',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    cursor: 'move',
  });

  const makeDivider = () => {
    const d = document.createElement('div');
    Object.assign(d.style, { width: '1px', height: '11px', backgroundColor: 'rgba(255,255,255,0.14)' });
    return d;
  };

  // --- REC indicator (always on) ---
  const recDot = document.createElement('div');
  Object.assign(recDot.style, {
    width: '7px', height: '7px', borderRadius: '50%',
    backgroundColor: '#ef4444', boxShadow: '0 0 7px rgba(239,68,68,0.9)',
    animation: 'ai-rec-pulse 1.8s ease-in-out infinite', flexShrink: '0',
  });
  const recText = document.createElement('span');
  Object.assign(recText.style, { fontSize: '10px', fontWeight: '800', color: '#ef4444', letterSpacing: '1px' });
  recText.textContent = 'REC';

  // --- Live status (Normal / Checking / Flagged) ---
  statusDot = document.createElement('div');
  Object.assign(statusDot.style, {
    width: '7px', height: '7px', borderRadius: '50%',
    backgroundColor: '#10b981', boxShadow: '0 0 6px rgba(16, 185, 129, 0.5)', flexShrink: '0',
  });
  statusLabel = document.createElement('span');
  Object.assign(statusLabel.style, { fontSize: '10px', fontWeight: '600', color: '#e5e7eb' });
  statusLabel.textContent = 'Normal';

  // --- Violation counter ---
  violationCounter = document.createElement('span');
  Object.assign(violationCounter.style, { fontSize: '9.5px', color: '#9ca3af', fontWeight: '600' });
  violationCounter.textContent = '0 flags';

  floatingWidget.append(
    recDot, recText,
    makeDivider(),
    statusDot, statusLabel,
    makeDivider(),
    violationCounter,
  );

  // Hidden inference video: kept rendered (not display:none) at 1px/near-zero
  // opacity so the browser keeps decoding full-resolution frames for drawImage,
  // while the student cannot actually see the feed.
  videoElement = document.createElement('video');
  videoElement.srcObject = webcamStream;
  videoElement.autoplay = true;
  videoElement.playsInline = true;
  videoElement.muted = true;
  Object.assign(videoElement.style, {
    position: 'absolute', left: '0', top: '0',
    width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none',
  });
  floatingWidget.appendChild(videoElement);

  _injectRecPulseKeyframes();

  // Draggable so students with an off-center / external camera can align the bar
  // under their own camera. Defaults to top-center for built-in laptop webcams.
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  floatingWidget.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = floatingWidget.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    floatingWidget.style.transform = 'none';
    floatingWidget.style.left = `${e.clientX - offsetX}px`;
    floatingWidget.style.top = `${e.clientY - offsetY}px`;
    floatingWidget.style.bottom = 'auto';
    floatingWidget.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => { isDragging = false; });

  document.body.appendChild(floatingWidget);
}

let _recPulseInjected = false;
/** Inject the subtle REC-dot pulse keyframes once. */
function _injectRecPulseKeyframes() {
  if (_recPulseInjected) return;
  _recPulseInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes ai-rec-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.35; }
    }
  `;
  document.head.appendChild(style);
}

function updateViolationCounter() {
  if (violationCounter) {
    violationCounter.textContent = `${totalViolationCount} flag${totalViolationCount !== 1 ? 's' : ''}`;
    if (totalViolationCount > 0) violationCounter.style.color = '#f59e0b';
    if (totalViolationCount >= 3) violationCounter.style.color = '#ef4444';
  }
}

function removeFloatingWidget() {
  const existing = document.getElementById('ai-proctor-floating-widget');
  if (existing) existing.remove();
  floatingWidget = null;
  videoElement = null;
  statusDot = null;
  statusLabel = null;
  violationCounter = null;
}

// ---------------------------------------------------------------------------
// Navigation Watch — auto-stop proctoring when student leaves quiz page
// ---------------------------------------------------------------------------

/**
 * Detect if the student navigated away from the quiz page (e.g. submitted the
 * quiz, clicked a link, hit the back button). This handles SPA navigations
 * that don't fire beforeunload.
 */
function startNavigationWatch() {
  if (navigationWatchInterval) clearInterval(navigationWatchInterval);
  navigationWatchInterval = setInterval(() => {
    if (!isProctoringActive || !quizPageUrl) return;
    const currentUrl = window.location.href;
    // If URL changed and new URL is NOT a quiz page → student left the quiz
    if (currentUrl !== quizPageUrl) {
      const stillOnQuiz = window.detectQuizActive ? window.detectQuizActive() : false;
      if (!stillOnQuiz) {
        console.log('[AI Observer] Student navigated away from quiz page. Auto-stopping proctoring.');
        stopProctoring('quiz_navigation_away');
      } else {
        // Updated quiz URL (e.g. paginated quiz)
        quizPageUrl = currentUrl;
      }
    }
  }, 1500);
}

/**
 * Handle page unload — fires when student closes the tab, refreshes, or
 * submits a form that navigates to a new page.
 */
function handleBeforeUnload() {
  if (!isProctoringActive) return;
  console.log('[AI Observer] Page unloading — ending proctoring session.');
  // Reliability during unload comes from `keepalive: true`, not sendBeacon.
  // `keepalive: true` inside endSession is what lets this survive unload. It is
  // deliberately NOT awaited — an unload handler cannot await anything, and the
  // request is already in flight by the time this returns.
  try {
    if (window.SafeTestSupabase && proctorSessionId) {
      window.SafeTestSupabase.endSession(proctorSessionId, {
        endedAt: new Date().toISOString(),
      });
    }
  } catch (e) { /* context invalidated mid-unload */ }
  // Mark inactive so it won't restart on new page
  safeStorageSet({ proctoringActive: false });
}

// ---------------------------------------------------------------------------
// Activation — ONLY start on quiz pages
// ---------------------------------------------------------------------------

chrome.storage.local.get(
  ['proctoringActive', 'guestMode', 'studentName', 'studentId', 'sessionCode', 'serverUrl', 'userRole',
   'sbAccessToken', 'sbRefreshToken', 'sbUserId', 'studentUniversityId'],
  (data) => {
    studentUniversityId = data.studentUniversityId || null;
    if (data.serverUrl) serverUrl = data.serverUrl;   // model host only
    window.SafeTestSupabase?.restoreSession(data);

    const isQuizPage = window.detectQuizActive ? window.detectQuizActive() : false;
    const isGuest = data.guestMode || window.location.href.includes('/demo-quiz') || window.location.href.includes('/demo');

    if ((data.userRole === 'student' || isGuest) && data.proctoringActive && isQuizPage) {
      studentName = data.studentName || 'Guest Visitor';
      studentId = data.studentId || 'GUEST-ID';
      sessionCode = data.sessionCode || 'GUEST-DEMO';
      startProctoring();
    } else if (data.userRole === 'student' && data.proctoringActive && !isQuizPage) {
      console.log('[AI Observer] Not a quiz page. Clearing stale proctoringActive flag.');
      safeStorageSet({ proctoringActive: false });
    }
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (!extensionContextAlive()) { handleContextInvalidated('storageOnChanged'); return; }
  if (area === 'local' && (changes.proctoringActive || changes.guestMode)) {
    chrome.storage.local.get(
      ['proctoringActive', 'guestMode', 'studentName', 'studentId', 'sessionCode', 'serverUrl', 'userRole',
       'sbAccessToken', 'sbRefreshToken', 'sbUserId', 'studentUniversityId'],
      (data) => {
        const isGuest = data.guestMode || window.location.href.includes('/demo-quiz') || window.location.href.includes('/demo');
        if (data.userRole !== 'student' && !isGuest) return;
        studentUniversityId = data.studentUniversityId || null;
        window.SafeTestSupabase?.restoreSession(data);

        const isQuizPage = window.detectQuizActive ? window.detectQuizActive() : false;
        if (data.proctoringActive || data.guestMode) {
          if (!isQuizPage) {
            console.log('[AI Observer] proctoringActive set but NOT on quiz page. Ignoring.');
            return;
          }
          if (data.serverUrl) serverUrl = data.serverUrl;
          studentName = data.studentName || 'Guest Visitor';
          studentId = data.studentId || 'GUEST-ID';
          sessionCode = data.sessionCode || 'GUEST-DEMO';
          startProctoring();
        } else {
          stopProctoring('manual_stop');
        }
      }
    );
  }
});

// Exports
window.startProctoring = startProctoring;
window.stopProctoring = stopProctoring;
window.ViolationType = ViolationType;
window.Severity = Severity;
window.reportViolation = reportViolation;
window.isProctoringActive = () => isProctoringActive;
// PHONE_DETECTED is held for the full latch window, so a consumer polling this
// at any point during those ~45 frames still sees the alert even if the phone
// left frame after one.
window.getPhoneDetected = getPhoneDetected;
window.getRuntimeTier = () => (runtimeProfile ? runtimeProfile.tier : null);
window.getLivenessState = () => (livenessManager ? livenessManager.telemetry() : null);
window.getEarVetoState = () => (earVetoGate ? earVetoGate.telemetry() : null);
// Live during the pre-exam lighting stage only; null once the exam starts.
// Read this to see the raw luminance numbers behind a verdict — the thresholds
// are reasoned rather than measured, and this is how they get measured.
window.getLightingState = () => (lightingChecker ? lightingChecker.telemetry() : null);
window.getGazeState = () => (
  visionEngine && visionEngine.gazeAnalyzer ? visionEngine.gazeAnalyzer.snapshot() : null
);
// Landmark gaze. `calibrated:false` with no samples forever means faceLandmarks
// is still null — i.e. no FaceMesh model is being served and this is inert.
window.getLandmarkGazeState = () => (
  visionEngine && visionEngine.landmarkGazeAnalyzer
    ? visionEngine.landmarkGazeAnalyzer.snapshot() : null
);
// Coarse eye-closure channel feeding the EAR veto. `closed:null` every frame
// means the fallback is not reading and the veto is running on nothing.
window.getEyeClosureState = () => (visionEngine ? visionEngine.lastEyeClosure : null);
// Evidence ring buffer. `size: 0` with a rising `below_floor` means the student
// is simply sitting still — expected. A rising `encode_failures` means snapshots
// are failing and alerts are silently falling back to live capture.
window.getEvidenceBufferState = () => (evidenceBuffer ? evidenceBuffer.telemetry() : null);
// Gaze/classifier fusion. `verdicts` shows WHY each gaze alert was or was not
// boosted; a high CLASSIFIER_STALE count means the classifier interval is too
// long relative to gaze episodes for fusion to contribute anything.
window.getGazeFusionState = () => (gazeFusion ? gazeFusion.telemetry() : null);
// Downward gaze. `forgiven` climbing with `events` at zero is the keyboard
// safeguard doing its job on a typist. `unreadable` climbing means no landmark
// source is feeding it and the detector is inert.
window.getDownwardGazeState = () => (downwardGaze ? downwardGaze.telemetry() : null);

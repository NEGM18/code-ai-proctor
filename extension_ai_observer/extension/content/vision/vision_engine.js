// =============================================================================
// Vision Engine — AI Observer Extension
//
// Owns the two ONNX sessions and decides when each is allowed to run.
//
//   POSE   every frame  -> persons + COCO-17 keypoints -> HeadPoseAnalyzer
//   DETECT every frame  -> COCO objects filtered to phones/screens
//
// SCHEDULING. Both models share one heap. On Tier B (CPU/WASM) they also share
// one or two threads, so the detector must never be allowed to pile up behind
// itself. Each session is therefore strictly single-flight, and the detector
// yields to the pose loop rather than competing with it.
//
// The detector used to run on a ~0.5 FPS jittered slice. It no longer does: a
// phone lifted into frame for 1-5 frames falls straight through a 1.75 s
// sampling gap, so the detector now runs CONTINUOUSLY (every processed frame)
// and precision is bought back with a high confidence floor plus a shape guard
// instead of with sampling. Frame rate — not coverage — is what the tier
// reduces on weak hardware. detectMode: 'sliced' restores the old behaviour if
// a deployment needs the headroom back.
//
// RESOLUTION comes from the runtime profile, clamped to what each exported
// graph will actually accept (export_vision_models.py uses dynamic=False, so a
// 448 graph cannot be fed 320 — see runtime_profile.clampInputSize).
//
// Everything is best-effort: if a model fails to load the engine degrades to
// whatever did load rather than failing the session outright. Losing phone
// detection should never take down proctoring.
// =============================================================================

/* global ort, HeadPoseAnalyzer, letterbox, rgbaToNCHW, decodePoseOutput, decodeDetectOutput,
          TimeSlicedScheduler, DetectionLatch, filterPhoneDetections, PHONE_SHAPE_DEFAULTS,
          COCO_CELL_PHONE, resolveRuntimeProfile, configureOrtEnv, createSession,
          resolveSessionInputSize, clampInputSize, GazeSampler, GazeAnalyzer */

const VISION_DEFAULTS = {
  // Fallbacks only. The runtime profile supplies the real values at load().
  poseInputSize: 256,
  detectInputSize: 448,

  // 'continuous' = run on every processed frame (default).
  // 'sliced'     = the legacy ~0.5 FPS jittered slice.
  detectMode: 'continuous',
  detectIntervalMs: 0,
  detectJitterMs: 0,
  detectMinGapMs: 0,

  // ⚠ PIXEL GAZE IS OFF. gaze_roi.js infers the iris from raw pixel contrast,
  // and it failed field testing on lighting, skin-tone and eyelash-shadow
  // variance — a fairness failure, not just an accuracy one, because the
  // variance is not evenly distributed across students. It is superseded by
  // gaze_landmarks.js (ratios of landmark distances, invariant to illumination
  // and pigmentation by construction), which stays inert until a face-landmark
  // model is in the pipeline. The module and its tests are kept, not deleted,
  // so this is one flag to flip if the landmark route hits its own wall.
  // Do NOT re-enable without re-validating across skin tones.
  enableGaze: false,

  // Landmark gaze (gaze_landmarks.js). Every quantity is a RATIO OF DISTANCES
  // between landmark coordinates, so it is invariant to illumination and
  // pigmentation by construction — the failure that disabled enableGaze above
  // cannot occur in this formulation. Wired ON, but INERT until something
  // populates `faceLandmarks`: pose.onnx is COCO-17 and has no eyelid contour,
  // so today it silently produces nothing. Serving a 478-point FaceMesh ONNX
  // activates it with no further change here.
  enableLandmarkGaze: true,

  // Coarse eye-closure sampling for the EAR veto's fallback channel.
  //
  // ⚠ This is NOT the disabled gaze path above being switched back on. It runs
  // gaze_roi.js's openness gate ONLY, and discards gazeH/gazeV entirely — no
  // direction is computed, so no direction can be wrong. Its single output is a
  // boolean fed to EarVetoGate.submitClosureHint(), which can only SUPPRESS
  // alerts. See that method for why a coarse signal is sound in that direction
  // and unsound in every other.
  enableClosureHint: true,

  // Coarse pre-filter used while decoding. Phones are then re-judged against
  // the much stricter PHONE_SHAPE_DEFAULTS gate; this only exists to keep NMS
  // off obvious garbage, and MUST stay at or below the phone floor or the
  // strict gate would never see the candidates it is meant to judge.
  detectScoreThreshold: 0.35,

  // Overrides for the phone confidence + aspect-ratio gate. See
  // PHONE_SHAPE_DEFAULTS in detectors.js for what each field means and why the
  // confidence floor is high on purpose.
  phoneShape: {},

  // Latch-and-hold window for phone alerts. Defaults come from
  // DEFAULT_LATCH_OPTS (45 frames AND 1500 ms after the last hit).
  phoneLatch: {},

  // Phones only by DEFAULT, deliberately.
  //
  // Adding COCO_LAPTOP / COCO_TV costs nothing at inference time (the model
  // scores all 80 classes regardless; the decoder just reads two more channels
  // per anchor) and secondary-screen detection is genuinely useful. But an
  // external monitor or TV sitting behind a student is common and permanent,
  // so enabling it by default would manufacture exactly the kind of standing
  // false positive this whole pipeline exists to eliminate. Opt in per
  // deployment once you know the room:
  //   new VisionEngine({ detectClassFilter: [COCO_CELL_PHONE, COCO_LAPTOP, COCO_TV] })
  detectClassFilter: [COCO_CELL_PHONE],
};

class VisionEngine {
  constructor(options = {}) {
    this.opt = { ...VISION_DEFAULTS, ...options };

    this.poseSession = null;
    this.detectSession = null;
    this.analyzer = null;

    // Eye gaze. Built alongside the pose analyser in load(), because it is
    // driven entirely by the pose model's keypoints and is meaningless without
    // them. Off when enableGaze is explicitly false.
    this.gazeSampler = null;
    this.gazeAnalyzer = null;
    /** Openness-only sampler feeding the EAR veto's coarse fallback channel. */
    this.closureSampler = null;
    /** Landmark gaze — wired, but inert until faceLandmarks are populated. */
    this.landmarkGazeAnalyzer = null;
    this.lastEyeClosure = { closed: null, reason: 'not_sampled' };
    this.gazeSuppressed = false;
    this.lastGazeMs = 0;

    /** Resolved hardware tier. Populated by load(). */
    this.profile = options.profile || null;

    this._poseBuffers = null;
    this._detectBuffers = null;

    this._poseInFlight = false;
    this._detectScheduler = this._makeDetectScheduler();

    // Latch-and-hold over phone hits. Lives here rather than in monitor.js so
    // that anything reading the engine (telemetry, teacher overlay, tests) sees
    // the same held state the alert was raised from.
    this.phoneLatch = (typeof DetectionLatch !== 'undefined')
      ? new DetectionLatch(this.opt.phoneLatch)
      : null;

    this.lastPhoneDetections = [];
    this.lastRejectedPhones = [];
    this.lastPhoneCheckMs = 0;
    this.lastPoseMs = 0;
    this.lastDetectMs = 0;
    this.detectFrameCount = 0;
    this.phoneRejectCount = 0;

    this.status = { pose: 'unloaded', detect: 'unloaded' };
  }

  /**
   * Build the detector's scheduler for the configured mode.
   *
   * In 'continuous' mode every gap is zero, so shouldRun() is governed purely
   * by the single-flight lock — the detector runs on every frame it can and
   * never queues behind itself.
   */
  _makeDetectScheduler() {
    if (this.opt.detectMode === 'sliced') {
      // Legacy slice. The || fallbacks matter: the continuous defaults are all
      // zero, so opting back into 'sliced' without restating the numbers would
      // silently produce a scheduler that never throttles.
      return new TimeSlicedScheduler({
        intervalMs: this.opt.detectIntervalMs || 1750,
        jitterMs: this.opt.detectJitterMs || 250,
        minGapMs: this.opt.detectMinGapMs || 250,
      });
    }
    return new TimeSlicedScheduler({ intervalMs: 0, jitterMs: 0, minGapMs: 0 });
  }

  /**
   * Load both sessions. Resolves once loading has been attempted for each;
   * check `status` to see what actually came up.
   *
   * @param {string} serverUrl
   * @param {Function} [onProgress] - (modelName, downloaded, total)
   * @returns {Promise<{pose:boolean, detect:boolean}>}
   */
  async load(serverUrl, onProgress) {
    // One shared hardware answer for every session in the extension. The
    // classifier resolves the same cached profile, so both cannot disagree.
    this.profile = this.profile || await resolveRuntimeProfile();
    configureOrtEnv(ort, this.profile);

    // ⚠ OFFLINE MODE SKIPS THE SERVER ENTIRELY — IT DOES NOT "TRY AND FAIL".
    //
    // A guest visitor has no model server. Attempting localhost:8000 anyway
    // costs a fetch timeout per graph and fills the console with errors that
    // describe a server the visitor was never expected to run.
    const offline = this.opt.offlineOnly === true;

    const [pose, detect] = offline
      ? [null, null]
      : await Promise.all([
        this._loadOne('pose', serverUrl, onProgress),
        this._loadOne('detect', serverUrl, onProgress),
      ]);

    this.poseSession = pose;
    this.detectSession = detect;
    this.status.pose = pose ? 'ready' : (offline ? 'skipped' : 'failed');
    this.status.detect = detect ? 'ready' : (offline ? 'skipped' : 'failed');

    // ── MediaPipe FaceLandmarker ────────────────────────────────────────────
    //
    // ⚠ THIS IS NOT NESTED UNDER `if (pose)` — AND THAT IS THE WHOLE POINT.
    //
    // It used to be, which coupled a fully self-contained local model to a
    // network fetch that has nothing to do with it. `face_landmarker.task` and
    // its WASM ship inside the extension and load over chrome-extension://, so
    // a missing model server cannot affect them. Nesting meant one unreachable
    // host disabled head pose, gaze, landmarks and blink immunity together —
    // exactly the "Pose & Object detector unavailable" state a guest hit.
    if (typeof MediaPipeExtensionSource !== 'undefined') {
      try {
        this.mediaPipeSource = new MediaPipeExtensionSource(this.opt.mediaPipe || {});
        await this.mediaPipeSource.load();
        if (this.mediaPipeSource.delegate) {
          this.faceLandmarkSource = () => this.mediaPipeSource.lastPixelLandmarks;
          this.status.mediaPipe = 'ready';
        } else {
          this.status.mediaPipe = 'unloaded';
        }
      } catch (err) {
        console.warn('[Vision] MediaPipeExtensionSource load failed:', err);
        this.status.mediaPipe = 'failed';
      }
    }

    // Head pose can be driven by EITHER source: the ONNX pose graph, or
    // MediaPipe's 478 points projected onto the 5 COCO face keypoints
    // pose_geometry.js actually consumes (MediaPipeExtensionSource.faceToCocoPerson).
    // The analyser and every eye detector are therefore gated on "some keypoint
    // source exists", not on the ONNX graph specifically.
    if (pose || this._mediaPipeLive()) {
      this.analyzer = new HeadPoseAnalyzer(this.opt.analyzer || {});

      // Guarded on the globals: gaze_roi.js is registered before this file in
      // the manifest, but a stale unpacked build could be missing it, and a
      // missing optional detector must degrade to "off", not to a load failure.
      if (this.opt.enableGaze !== false
        && typeof GazeSampler !== 'undefined' && typeof GazeAnalyzer !== 'undefined') {
        this.gazeSampler = new GazeSampler(this.opt.gaze || {});
        this.gazeAnalyzer = new GazeAnalyzer(this.opt.gaze || {});
      }

      // Closure-hint sampler. Shares GazeSampler with the path above but is
      // constructed independently, because enableGaze is OFF and this must
      // still run: it consumes only the openness verdict, never a direction.
      if (!this.gazeSampler
        && this.opt.enableClosureHint !== false
        && typeof GazeSampler !== 'undefined') {
        this.closureSampler = new GazeSampler(this.opt.gaze || {});
      }

      if (this.opt.enableLandmarkGaze !== false
        && typeof GazeLandmarkAnalyzer !== 'undefined') {
        this.landmarkGazeAnalyzer = new GazeLandmarkAnalyzer(this.opt.landmarkGaze || {});
      }
    }

    if (pose) {
      this._poseBuffers = this._makeBuffers(this._resolveInputSize(pose, 'pose'));
    }
    if (detect) {
      this._detectBuffers = this._makeBuffers(this._resolveInputSize(detect, 'detect'));
    }

    console.log(
      `[Vision] pose=${this.status.pose}(${this._poseBuffers ? this._poseBuffers.size : '-'}px) ` +
      `detect=${this.status.detect}(${this._detectBuffers ? this._detectBuffers.size : '-'}px) ` +
      `tier=${this.profile ? this.profile.tier : '?'} mode=${this.opt.detectMode}`
    );
    // `pose` reports whether HEAD-POSE ANALYSIS is available, not whether the
    // ONNX graph loaded — MediaPipe satisfies it on its own. `poseSource` keeps
    // the two distinguishable for telemetry and for the caller's logging.
    return {
      pose: this.isPoseReady(),
      detect: !!detect,
      poseSource: this.poseSession ? 'onnx' : (this._mediaPipeLive() ? 'mediapipe' : 'none'),
    };
  }

  /**
   * Pick the input edge length for one model: what the tier wants, clamped to
   * what the graph accepts.
   *
   * The clamp is not a nicety. pose.onnx and detect.onnx are exported with
   * dynamic=False, so their spatial dims are baked in and feeding anything else
   * throws at run(). Tier B's 320 cap can only be honoured once the model is
   * re-exported (export_vision_models.py --detect-imgsz 320), and this logs
   * exactly that when the cap is being ignored.
   *
   * @param {object} session
   * @param {'pose'|'detect'} which
   * @returns {number}
   */
  _resolveInputSize(session, which) {
    const preferred = which === 'pose'
      ? ((this.profile && this.profile.poseInputSize) || this.opt.poseInputSize)
      : ((this.profile && this.profile.detectInputSize) || this.opt.detectInputSize);
    const cap = (this.profile && this.profile.maxInputSize) || preferred;

    const modelStatic = (typeof resolveSessionInputSize === 'function')
      ? resolveSessionInputSize(session)
      : null;
    const resolved = clampInputSize(preferred, modelStatic, cap);

    if (!resolved.honored) {
      console.warn(
        `[Vision] '${which}' graph has a fixed ${resolved.size}px input, above this tier's ${cap}px cap. ` +
        `Re-export with export_vision_models.py --${which}-imgsz ${cap} to collect the CPU saving.`
      );
    }
    return resolved.size;
  }

  /** Load one named model, preferring the chunked/obfuscated route. */
  async _loadOne(name, serverUrl, onProgress) {
    const base = (serverUrl || 'http://localhost:8000').replace(/\/+$/, '');
    let source = null;
    let loader = null;

    try {
      if (window.SecureModelLoader) {
        loader = new window.SecureModelLoader(base, name);
        try {
          const buf = await loader.loadModel(
            onProgress ? (d, t) => onProgress(name, d, t) : undefined
          );
          source = new Uint8Array(buf);
        } catch (err) {
          loader.dispose();
          loader = null;

          // Same reasoning as onnx_inference.js: the direct URL points at the
          // host that just failed to answer, and ORT's internal fetch carries
          // no timeout, so falling back to it after an UNREACHABLE turns a
          // bounded failure into an unbounded one. Alive-but-erroring servers
          // still get the fallback.
          if (err && err.code === 'MODEL_SERVER_UNREACHABLE') {
            console.error(
              `[Vision] model server unreachable at ${base} — not retrying the same host for '${name}'.`,
              err.message
            );
            throw err;
          }

          console.warn(`[Vision] secure load failed for '${name}', trying direct URL:`, err.message);
          source = `${base}/static/models/${name}.onnx`;
        }
      } else {
        source = `${base}/static/models/${name}.onnx`;
      }

      // Provider chain comes from the shared profile — Tier A gets
      // ['webgpu','wasm'], Tier B gets ['wasm'] — and createSession retries on
      // pure WASM if this particular graph will not build on the GPU.
      const { session } = await createSession(ort, source, this.profile, name);

      // ORT has copied the weights into its own heap; release ours.
      if (loader) loader.dispose();
      return session;
    } catch (err) {
      console.error(`[Vision] could not load '${name}':`, err);
      if (loader) loader.dispose();
      return null;
    }
  }

  /** Allocate the reusable canvas + tensor backing store for one input size. */
  _makeBuffers(size) {
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(size, size)
      : document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return {
      size,
      canvas,
      ctx: canvas.getContext('2d', { willReadFrequently: true }),
      tensor: new Float32Array(3 * size * size),
    };
  }

  /** Shared preprocess: letterbox into the buffer and build the input tensor. */
  _preprocess(buffers, source) {
    const lb = letterbox(buffers.ctx, source, buffers.size);
    if (!lb) return null;
    const rgba = buffers.ctx.getImageData(0, 0, buffers.size, buffers.size).data;
    rgbaToNCHW(rgba, buffers.size, buffers.tensor);
    return {
      lb,
      tensor: new ort.Tensor('float32', buffers.tensor, [1, 3, buffers.size, buffers.size]),
    };
  }

  /** @returns {boolean} True when a live MediaPipe FaceLandmarker is attached. */
  _mediaPipeLive() {
    return !!(this.mediaPipeSource && this.mediaPipeSource.delegate);
  }

  /**
   * @returns {boolean} True when head-pose analysis is available from EITHER
   * the ONNX pose graph or the bundled MediaPipe landmarker.
   */
  isPoseReady() {
    return !!(this.analyzer && (this.poseSession || this._mediaPipeLive()));
  }

  /**
   * COCO classes this engine is actually decoding.
   * Callers must consult this before acting on a class — filtering downstream
   * for something the decoder was never asked to emit is silently dead code.
   * @returns {number[]}
   */
  activeClasses() {
    return this.opt.detectClassFilter && this.opt.detectClassFilter.length
      ? this.opt.detectClassFilter
      : [COCO_CELL_PHONE];
  }

  /** @param {number} classId @returns {boolean} */
  detectsClass(classId) {
    return this.activeClasses().indexOf(classId) !== -1;
  }

  /**
   * Run pose estimation on one frame and advance the head-pose analyser.
   *
   * @param {HTMLVideoElement} source
   * @param {number} nowMs
   * @returns {Promise<object|null>} Analyser result, or null if skipped.
   */
  async analyzeFrame(source, nowMs) {
    if (!this.isPoseReady() || this._poseInFlight) return null;

    this._poseInFlight = true;
    try {
      let persons;

      if (this.poseSession) {
        const pre = this._preprocess(this._poseBuffers, source);
        if (!pre) return null;

        const started = performance.now();
        const out = await this.poseSession.run({ [this.poseSession.inputNames[0]]: pre.tensor });
        this.lastPoseMs = performance.now() - started;

        const tensor = out[this.poseSession.outputNames[0]];
        persons = decodePoseOutput(tensor.data, tensor.dims, pre.lb);

        // The landmarker still runs alongside the graph — it is what feeds the
        // 478-point seam that the EAR veto and landmark gaze consume.
        if (this.mediaPipeSource) this.mediaPipeSource.detect(source, nowMs);
      } else {
        // MediaPipe-only path. `detect()` already returns COCO-projected persons
        // in SOURCE PIXEL SPACE — the same space decodePoseOutput un-letterboxes
        // into — so everything downstream (analyser, eye ROI, gaze) is unchanged
        // and needs no coordinate mapping.
        //
        // Fewer keypoints, not different ones: this yields NOSE / L_EYE / R_EYE /
        // L_EAR / R_EAR, which is precisely the set pose_geometry.js reads. The
        // frozen head-pose modules are untouched and cannot tell the difference.
        const started = performance.now();
        const mp = this.mediaPipeSource.detect(source, nowMs);
        this.lastPoseMs = performance.now() - started;
        persons = mp.persons || [];
      }

      const result = this.analyzer.process(persons, nowMs);

      // --- Eye gaze, off the SAME keypoints -------------------------------
      // No second inference: the keypoints are already in source pixel space,
      // so the eye ROI can be cropped straight from the video element. Adds one
      // small getImageData, not a model.
      result.gaze = this._analyzeGaze(source, persons, result, nowMs);

      // --- Face landmarks seam --------------------------------------------
      result.faceLandmarks = this._collectFaceLandmarks(persons);

      // --- Landmark gaze (inert until the seam above is fed) ---------------
      result.landmarkGaze = this._analyzeLandmarkGaze(result, nowMs);

      // --- Coarse eye-closure hint for the EAR veto ------------------------
      // Openness verdict only; the direction is computed and discarded.
      result.eyeClosure = this._analyzeEyeClosure(source, persons, result);

      return result;
    } catch (err) {
      console.error('[Vision] pose inference failed:', err);
      return null;
    } finally {
      this._poseInFlight = false;
    }
  }

  /**
   * Advance the gaze analyser for one frame.
   *
   * ALWAYS called once per pose frame, even when the eyes cannot be read. A
   * frame that is skipped entirely is invisible to the dwell gate, whereas a
   * frame reported as unreadable is an explicit UNKNOWN — and only the second
   * one lets an in-progress episode age out correctly.
   *
   * @param {HTMLVideoElement} source
   * @param {Array} persons - Decoded pose detections, source pixel space.
   * @param {object} poseResult - HeadPoseAnalyzer output for this frame.
   * @param {number} nowMs
   * @returns {object|null} GazeAnalyzer result, or null when gaze is disabled.
   */
  _analyzeGaze(source, persons, poseResult, nowMs) {
    if (!this.gazeAnalyzer) return null;

    let sample = null;
    // Only the primary person, and only when their face was actually readable.
    // An unreadable face is NO_FACE_DETECTED's business, on its own evidence.
    if (this.gazeSampler && poseResult && poseResult.pose && poseResult.pose.valid && persons.length) {
      const primary = persons.reduce((a, b) => (b.score > a.score ? b : a));
      try {
        sample = this.gazeSampler.sample(source, primary.keypoints);
      } catch (err) {
        // A failed crop is "no data", never a verdict.
        console.debug('[Vision] gaze sample failed:', err);
        sample = null;
      }
    }

    this.lastGazeMs = this.gazeSampler ? this.gazeSampler.lastSampleMs : 0;
    return this.gazeAnalyzer.process(sample, poseResult, nowMs, this.gazeSuppressed);
  }

  /**
   * Face landmarks for this frame, or null.
   *
   * ⚠ ALWAYS NULL TODAY, and that is correct rather than a bug to patch.
   * pose.onnx is yolo11n-pose -> COCO-17, whose only face points are NOSE /
   * L-EYE / R-EYE / L-EAR / R-EAR: one point per eye, no eyelid contour, no eye
   * corners, no iris. EAR = V/H is therefore not computable from it, and
   * neither is any iris-offset ratio.
   *
   * A future FaceMesh decoder returns its 478-point set from here and nothing
   * else in the pipeline changes. Do NOT fabricate the missing points from the
   * eye centre — see the warning at the call site.
   *
   * @param {Array} persons
   * @returns {Array|null}
   */
  _collectFaceLandmarks(persons) {
    void persons;
    return this.faceLandmarkSource ? this.faceLandmarkSource(persons) : null;
  }

  /**
   * Advance the landmark gaze analyser.
   *
   * Like _analyzeGaze, called on EVERY pose frame including unreadable ones, so
   * an in-progress episode ages out instead of freezing mid-dwell.
   *
   * @param {object} poseResult
   * @param {number} nowMs
   * @returns {object|null}
   */
  _analyzeLandmarkGaze(poseResult, nowMs) {
    if (!this.landmarkGazeAnalyzer) return null;
    return this.landmarkGazeAnalyzer.process(
      poseResult ? poseResult.faceLandmarks : null,
      poseResult,
      nowMs,
      this.gazeSuppressed,
    );
  }

  /**
   * Coarse eye-closure verdict for the EAR veto's fallback channel.
   *
   * ⚠ OPENNESS ONLY. `analyzeEyeRegion` also returns gazeH/gazeV; they are
   * deliberately discarded here and must stay discarded. The direction estimate
   * is what failed field testing on lighting and skin tone, and it is disabled
   * (`enableGaze: false`). The openness gate that precedes it is a different
   * test with a different failure mode: it can only cause EXTRA SUPPRESSION
   * downstream, which harms no one. See EarVetoGate.submitClosureHint().
   *
   * Reports `closed: true` when EITHER eye reads shut, matching computeFaceEar's
   * min-of-two-eyes semantics — blink immunity is not a per-eye property.
   *
   * @returns {{closed: boolean|null, reason: string}} closed:null = unreadable.
   */
  _analyzeEyeClosure(source, persons, poseResult) {
    const unknown = (reason) => {
      this.lastEyeClosure = { closed: null, reason };
      return this.lastEyeClosure;
    };

    if (!this.closureSampler) return unknown('disabled');
    if (!poseResult || !poseResult.pose || !poseResult.pose.valid || !persons.length) {
      // An unreadable face is not evidence of open eyes OR shut ones.
      return unknown('no_face');
    }

    const primary = persons.reduce((a, b) => (b.score > a.score ? b : a));
    let sample = null;
    try {
      sample = this.closureSampler.sample(source, primary.keypoints);
    } catch (err) {
      return unknown('sample_failed');
    }
    if (!sample) return unknown('sample_failed');

    // combineEyes rejects one-eye samples, so read the per-eye reasons it
    // carries in `detail` rather than its fused verdict.
    const d = sample.detail || {};
    const shut = (e) => !!(e && e.valid === false && e.reason === 'eye_closed');
    if (shut(d.left) || shut(d.right)) {
      this.lastEyeClosure = { closed: true, reason: 'eye_closed' };
      return this.lastEyeClosure;
    }
    if (sample.valid) {
      this.lastEyeClosure = { closed: false, reason: 'eyes_open' };
      return this.lastEyeClosure;
    }
    // Rejected for any other reason (too small, no iris, low confidence) is
    // UNKNOWN — never "open", which would license an alert we cannot support.
    return unknown(sample.reason || 'unreadable');
  }

  /**
   * Withhold gaze REPORTING without stopping the analysis.
   *
   * Set while a liveness challenge is on screen: the corner dot orders the
   * student to look off-axis, and reporting that would punish compliance. The
   * analyser keeps running and keeps reaching telemetry — only the accusation
   * is withheld, the same arrangement monitor.js uses for LOOK_AWAY.
   *
   * Applies to BOTH gaze analysers. A corner prompt orders the student to look
   * off-axis; whichever detector notices, reporting it punishes compliance.
   *
   * @param {boolean} on
   */
  setGazeSuppressed(on) {
    this.gazeSuppressed = !!on;
  }

  /**
   * Run phone/object detection on this frame.
   *
   * In the default 'continuous' mode the only thing that can skip a frame is
   * the single-flight lock (the previous run has not finished yet). That is the
   * point: a phone visible for 1-5 frames has to be sampled on those frames or
   * it is gone forever.
   *
   * Returns null only when there is genuinely no new information — no session,
   * the pose model is mid-inference, a run is already in flight, or the frame
   * had no dimensions. Callers must treat null as "unchanged", NOT as "no
   * phone", or a busy frame would read as an all-clear and drop the latch.
   *
   * Phones in the returned array have already passed the confidence + shape
   * gate and carry a `.shape` verdict; the rejects are kept in
   * `lastRejectedPhones` for telemetry.
   *
   * @param {HTMLVideoElement} source
   * @param {number} nowMs
   * @returns {Promise<Array|null>}
   */
  async maybeDetectObjects(source, nowMs) {
    if (!this.detectSession) return null;
    // Never contend with the pose loop for the same thread.
    if (this._poseInFlight) return null;
    if (!this._detectScheduler.shouldRun(nowMs)) return null;

    this._detectScheduler.begin(nowMs);
    try {
      const pre = this._preprocess(this._detectBuffers, source);
      if (!pre) return null;

      const started = performance.now();
      const out = await this.detectSession.run({ [this.detectSession.inputNames[0]]: pre.tensor });
      this.lastDetectMs = performance.now() - started;
      this.detectFrameCount++;

      const tensor = out[this.detectSession.outputNames[0]];
      const raw = decodeDetectOutput(tensor.data, tensor.dims, pre.lb, {
        classFilter: this.activeClasses(),
        scoreThreshold: this.opt.detectScoreThreshold,
      });

      const detections = this._applyPhoneGate(raw, pre.lb);
      this.lastPhoneDetections = detections;
      this.lastPhoneCheckMs = nowMs;
      return detections;
    } catch (err) {
      console.error('[Vision] object detection failed:', err);
      return null;
    } finally {
      this._detectScheduler.end(performance.now());
    }
  }

  /**
   * Replace the raw class-67 candidates with the ones that survive the
   * confidence + aspect-ratio gate. Non-phone classes pass through untouched —
   * laptops and TVs are judged by their own dwell gate downstream and have
   * nothing to do with phone geometry.
   *
   * @param {Array} raw - Decoded detections in SOURCE pixel space.
   * @param {{srcW:number, srcH:number}} lb - Letterbox mapping, for frame size.
   * @returns {Array}
   */
  _applyPhoneGate(raw, lb) {
    if (typeof filterPhoneDetections !== 'function') return raw;

    const frame = { width: lb.srcW, height: lb.srcH };
    const { phones, rejected } = filterPhoneDetections(raw, frame, this.opt.phoneShape);

    this.lastRejectedPhones = rejected;
    this.phoneRejectCount += rejected.length;

    if (rejected.length) {
      // Left at debug level on purpose — this fires on ordinary desk clutter
      // and would drown the console at warn.
      console.debug(
        '[Vision] phone candidates rejected:',
        rejected.map((r) => `${r.score.toFixed(2)}@ar${r.shape.aspectRatio} (${r.shape.reason})`).join(', ')
      );
    }

    const others = raw.filter((d) => d.classId !== COCO_CELL_PHONE);
    return phones.concat(others);
  }

  /**
   * Advance the phone latch by one processed frame and return its state.
   *
   * Kept separate from maybeDetectObjects so the caller drives it once per
   * frame with an explicit hit/miss — including on frames where detection was
   * skipped, which must count as "no new hit" but must NOT be allowed to expire
   * the hold faster than real frames would.
   *
   * @param {boolean} hit - A gated phone was present on this frame.
   * @param {number} nowMs
   * @param {number} [score=0]
   * @returns {object|null} Latch state, or null if the latch is unavailable.
   */
  updatePhoneLatch(hit, nowMs, score = 0) {
    if (!this.phoneLatch) return null;
    return this.phoneLatch.update(hit, nowMs, score);
  }

  /** @returns {boolean} True while a phone alert is latched and held. */
  isPhoneLatched() {
    return !!(this.phoneLatch && this.phoneLatch.active);
  }

  /** Reset per-session state (keeps the loaded sessions). */
  reset() {
    if (this.analyzer) this.analyzer.reset();
    if (this.gazeAnalyzer) this.gazeAnalyzer.reset();
    if (this.gazeSampler) this.gazeSampler.reset();
    if (this.landmarkGazeAnalyzer) this.landmarkGazeAnalyzer.reset();
    if (this.closureSampler) this.closureSampler.reset();
    if (this.mediaPipeSource) this.mediaPipeSource.lastPixelLandmarks = null;
    this.lastEyeClosure = { closed: null, reason: 'not_sampled' };
    this.gazeSuppressed = false;
    this.lastGazeMs = 0;
    if (this.phoneLatch) this.phoneLatch.reset();
    this.lastPhoneDetections = [];
    this.lastRejectedPhones = [];
    this.lastPhoneCheckMs = 0;
    this.detectFrameCount = 0;
    this.phoneRejectCount = 0;
  }

  /**
   * Release both ONNX sessions and the frame buffers.
   *
   * A new VisionEngine is built per proctoring session, so without this the
   * previous session's two sessions (~21 MB of weights plus their WASM arena)
   * stay resident for the life of the page. Two or three exam attempts in one
   * tab and the low-spec machine this is all tuned for is out of memory.
   */
  async dispose() {
    for (const key of ['poseSession', 'detectSession']) {
      const session = this[key];
      this[key] = null;
      if (session && typeof session.release === 'function') {
        try {
          await session.release();
        } catch (err) {
          console.warn(`[Vision] failed to release ${key}:`, err);
        }
      }
    }
    // ⚠ close(), NOT dispose(). MediaPipeSource exposes `close()` — see
    // mediapipe_source.js. A SECOND, near-duplicate dispose() used to be defined
    // below this one, and in a JS class body the later definition silently wins:
    // that copy called `this.mediaPipeSource.dispose()` behind a
    // `typeof === 'function'` guard which is FALSE for this object, so the
    // FaceLandmarker was never closed and its WASM instance leaked on every
    // session. The same copy also left `_poseBuffers`/`_detectBuffers` — two
    // canvases plus two Float32Arrays sized 3*N*N — attached to the engine.
    // Do not reintroduce a second dispose(); there must be exactly one.
    if (this.mediaPipeSource) {
      try { this.mediaPipeSource.close(); } catch {}
      this.mediaPipeSource = null;
    }
    this.analyzer = null;
    this._poseBuffers = null;
    this._detectBuffers = null;
    this.lastPhoneDetections = [];
    this.status = { pose: 'disposed', detect: 'disposed', mediaPipe: 'disposed' };
  }

  /** Timing and state summary for telemetry. */
  telemetry() {
    const p = this.profile;
    return {
      pose_ms: Math.round(this.lastPoseMs),
      detect_ms: Math.round(this.lastDetectMs),
      pose_status: this.status.pose,
      detect_status: this.status.detect,
      pose_input: this._poseBuffers ? this._poseBuffers.size : null,
      detect_input: this._detectBuffers ? this._detectBuffers.size : null,
      detect_mode: this.opt.detectMode,
      detect_frames: this.detectFrameCount,
      phone_rejects: this.phoneRejectCount,
      phone_latched: this.isPhoneLatched(),
      tier: p ? p.tier : null,
      providers: p ? p.executionProviders : null,
      wasm_threads: p ? p.appliedThreads : null,
      analyzer: this.analyzer ? this.analyzer.snapshot() : null,
      // Watch this on Tier B: it is one small getImageData plus a pass over a
      // ~64x24 crop, so it should stay in low single-digit ms. If it does not,
      // the eye box is being sized off an unexpectedly large interocular.
      gaze_ms: Math.round(this.lastGazeMs),
      gaze: this.gazeAnalyzer ? this.gazeAnalyzer.snapshot() : null,
      landmark_gaze: this.landmarkGazeAnalyzer ? this.landmarkGazeAnalyzer.snapshot() : null,
      // closed:null on every frame means the coarse channel is not reading, so
      // the EAR veto is running on nothing. Same signal as `failedOpen`.
      eye_closure: this.lastEyeClosure,
    };
  }
}

if (typeof window !== 'undefined') {
  window.VisionEngine = VisionEngine;
  window.VISION_DEFAULTS = VISION_DEFAULTS;
}

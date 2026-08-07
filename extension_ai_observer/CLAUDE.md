# CLAUDE.md — AI Observer

Working notes for future sessions. Read this before touching the vision stack.

---

## 1. What this project is

An AI-proctored online exam platform in two halves:

- **`backend/`** — FastAPI app (`backend/main.py`) serving the exam portal, teacher/student
  dashboards, incident API, and the ONNX models the extension downloads.
- **`extension/`** — Chrome MV3 content-script extension that runs **all vision inference
  locally in the browser** via onnxruntime-web. No video ever leaves the machine; only
  violation events and JPEG evidence snapshots are POSTed.

Python at the repo root (`train_cheating_yolo.py`, `export_onnx.py`, `export_vision_models.py`,
`cheating_detector.py`) is the **training/export** side, not the serving path.

---

## 2. Layout

```
extension_ai_observer/
├── backend/
│   ├── main.py                    FastAPI app; /api/proctor/*, /api/model/{name}/{manifest,chunks}
│   ├── core/security.py
│   ├── services/ai_tutor.py
│   ├── static/models/             best.onnx, pose.onnx, detect.onnx  (served to the extension)
│   ├── static/{css,js}/, templates/
├── extension/
│   ├── manifest.json              MV3. content_scripts[0].js ORDER IS LOAD-BEARING.
│   ├── lib/ort.min.js + *.wasm/.mjs
│   ├── background/worker.js
│   ├── content/
│   │   ├── lms_detector.js        Is this page a quiz?
│   │   ├── secure_loader.js       Chunked + XOR-obfuscated model download, SHA-256 verified
│   │   ├── onnx_inference.js      Binary cheating/normal CLASSIFIER session
│   │   ├── lighting_checker.js    ★ PRE-EXAM LIGHTING GATE (see §4). Not a detector.
│   │   ├── liveness_challenge.js  ★ ANTI-SPOOFING corner challenge (see §4)
│   │   ├── monitor.js             Proctoring engine: loop, violations, UI, offline queue
│   │   ├── teacher_overlay.js, role_router.js
│   │   └── vision/
│   │       ├── runtime_profile.js  ★ HARDWARE TIER + EXECUTION PROVIDERS (see §4)
│   │       ├── pose_geometry.js    ⚠ HEAD POSE — DO NOT MODIFY
│   │       ├── pose_calibration.js ⚠ HEAD POSE — DO NOT MODIFY
│   │       ├── temporal_gate.js    ⚠ Smoother + DwellGate — DO NOT MODIFY
│   │       ├── pose_pipeline.js    ⚠ HeadPoseAnalyzer — DO NOT MODIFY
│   │       ├── gaze_roi.js         Pixel eye-gaze (disabled; enableGaze:false)
│   │       ├── gaze_landmarks.js   Landmark gaze + EAR (inert — needs FaceMesh)
│   │       ├── ear_veto.js         ★ Cascading EAR veto gate (see §4)
│   │       ├── detectors.js        Decoders, NMS, phone precision gate, DetectionLatch
│   │       └── vision_engine.js    Owns the pose + detect ONNX sessions
│   ├── popup/, test/
├── export_vision_models.py        yolo11n-pose -> pose.onnx, yolo11n -> detect.onnx
├── export_onnx.py                 trained classifier -> best.onnx
├── train_cheating_yolo.py, prepare_demo_weights.py, cheating_detector.py
└── weights/, Dockerfile, docker-compose.yml
```

---

## 3. Commands

```bash
# Backend
uvicorn backend.main:app --reload --port 8000
docker compose up --build                      # GPU-reserved container, port 127.0.0.1:8000

# Extension tests — no deps, no build step, CI-ready
node extension/test/run_all.js                 # runs every *.test.js
node extension/test/phone_detection.test.js    # phone gate + latch
node extension/test/runtime_profile.test.js    # WebGPU probe + provider chain
node extension/test/liveness_challenge.test.js # corner targets + pose verification

# Model export (imgsz here MUST match what the extension feeds)
python export_vision_models.py                             # pose@256, detect@448, static
python export_vision_models.py --detect-imgsz 320          # Tier B friendly
python export_vision_models.py --dynamic                   # dynamic axes; lets Tier B downscale
python export_onnx.py                                      # classifier -> best.onnx

# Training
python train_cheating_yolo.py                  # needs CUDA torch (+cu124, NOT +cpu)
python prepare_demo_weights.py                 # tiny synthetic weights to get end-to-end
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.

---

## 4. Active pipelines

### The proctoring loop (`monitor.js: runProctorInferenceTick`)

Self-scheduling `setTimeout` measured **from completion**, never `setInterval`. A machine that
cannot hold the cadence degrades to a lower frame rate instead of queueing inferences it can
never drain. Each tick:

1. **Frozen-feed guard** — 32×32 FNV-1a frame hash; a stuck webcam is skipped *before* paying
   inference cost.
2. **Pose** (every frame) → `HeadPoseAnalyzer` → look-away / no-face / multi-face events.
   **This is the only primary trigger.**
2b. **Eye gaze** (every frame, same keypoints, no extra inference) → eye-ROI crop → openness
   gate → iris centroid → `GAZE_OFF_SCREEN`. Runs **only while the head is inside its
   calibrated neutral band**; see *Eye gaze* below.
3. **Liveness** (every frame, same yaw/pitch, no extra inference) → frozen-pose watch →
   corner challenge.
4. **Object detect** (every frame) → phone precision gate → latch → `PHONE_DETECTED`.
5. **Classifier** (time-sliced) → corroboration state only. It can *escalate severity* on a
   pose-confirmed episode; it can **never** raise an alert alone. That restriction is the fix
   for the "I looked straight at the camera and got flagged" reports — the classifier has no
   notion of head direction, so there is nothing in its output to calibrate against.

### Execution-provider tiers (`vision/runtime_profile.js`)

One probe (`navigator.gpu` → `requestAdapter()` → non-null adapter), cached and shared by every
session so the classifier and the vision engine can never disagree.

|                       | **Tier A** (GPU)      | **Tier B** (CPU only)         |
|-----------------------|-----------------------|-------------------------------|
| `executionProviders`  | `['webgpu','wasm']`   | `['wasm']`                    |
| Target FPS            | 20 (band 15–30)       | 9 (band 8–10)                 |
| Frame interval / floor| 50 ms / 25 ms         | 111 ms / 100 ms               |
| Pose input            | 256                   | 256                           |
| Detect input          | 448                   | 320 (cap `maxInputSize`)      |
| WASM threads / SIMD   | 1 / on                | 2 *if permitted* / on         |
| Phone detect          | **every frame**       | **every frame**               |
| Classifier interval   | 3000 ms               | 6000 ms                       |

Three things that are easy to get wrong here:

- **`'wasm'` stays in the Tier A chain.** One unsupported operator then degrades that *node* to
  CPU instead of failing the whole session. `createSession()` additionally retries the entire
  session on pure WASM if the GPU path throws — a driver can pass the adapter probe and still
  fail to compile a specific graph.
- **2 WASM threads are requested, not assumed.** `resolveThreadCount()` returns 1 unless
  `SharedArrayBuffer` exists **and** the document is cross-origin isolated. A content script on
  an ordinary LMS page is not isolated, so in practice this is usually 1. Forcing 2 anyway is
  what previously broke loading: ORT spawns a proxy worker and the `.mjs` dynamic import fails
  inside the content-script world. SIMD — the bigger win — is unaffected.
- **The 320 cap is a request.** `export_vision_models.py` uses `dynamic=False`, so `detect.onnx`
  has a **static** 448 input and feeding it 320 throws at `run()`. `clampInputSize()` lets the
  graph win and logs a warning. To actually collect the Tier B saving, re-export with
  `--detect-imgsz 320` or `--dynamic`.

### Phone detection — precision + latch (`detectors.js`, `vision_engine.js`, `monitor.js`)

Two requirements pull in opposite directions; they are satisfied by different mechanisms.

**Precision** — kill background rectangles, via `PHONE_SHAPE_DEFAULTS`:
- `minConfidence: 0.60` for a clearly rectangular box. **Do not lower this.** A notebook,
  sticky-note block or framed picture clears 0.35 routinely and rarely clears 0.60.
- `squareConfidence: 0.75` for a box with aspect ratio `< 1.25`. Squares are not discarded
  outright (a steeply angled phone foreshortens toward square) but must be much more
  convincing. Real phones are 1.33 / 1.78 / 2.17.
- `maxAspectRatio: 4.0` — slivers (pens, cables, edge artifacts) are rejected at any score.
- Area guards: `0.0006 … 0.35` of frame area.

**Recall** — never miss a 1–5 frame glimpse:
- The detector runs **continuously**, on every processed frame. It used to run on a ~0.5 FPS
  jittered slice; a 250 ms glimpse falls straight through a 1.75 s sampling gap.
- `DetectionLatch` latches on the **first** qualifying frame — no dwell, no vote — then holds
  `PHONE_DETECTED = true` until **both** ≥45 frames and ≥1500 ms have elapsed since the last
  hit. Both floors matter: 45 frames is 2.2 s at 20 FPS but 5 s at 9 FPS, and a stalled machine
  could otherwise satisfy 1500 ms in three frames.
- The evidence snapshot is captured **on the hit frame**. Capturing later photographs an empty
  desk, which is exactly what a student hiding the phone is counting on.

**The explicit tradeoff:** phone precision now rests entirely on the confidence + shape gate,
not on temporal persistence. Lowering `minConfidence` without restoring a dwell requirement
*will* produce false accusations.

Laptops/TVs (`SECONDARY_DEVICE`) keep the 4 s `DwellGate` — they are standing objects, and one
frame of a monitor edge means nothing. They are also **off by default** (`detectClassFilter`);
a TV behind a student is common and permanent.

### Cascading safeguard — the EAR veto gate (`vision/ear_veto.js`)

The last line of defence against the defect that started this whole thread: the trained
classifier reporting **closed eyes** as cheating.

That defect was contained *per detector* — the classifier demoted to corroboration-only,
`gaze_landmarks.js` gating on EAR before it computes anything. Per-detector containment has a
structural weakness: every future eye-dependent detector has to re-earn the property, and
nothing stops the next one from repeating the mistake. The veto sits at the **reporting choke
point** (`monitor.js: reportViolation`) instead, so a detector cannot route around it by being
new.

```
detector -> reportViolation(type, payload)
      |
      +-- type not on the allowlist? ---> report unchanged
      +-- EAR unavailable or stale? ----> report unchanged   (FAIL-OPEN)
      +-- EAR <  0.20 ------------------> SUPPRESS + log
      +-- EAR >= 0.20 ------------------> report, annotated `ear_confirmed`
```

**⚠ 1. The allowlist is a constant, not a category.** Vetoing on eye state is valid only for
violations whose *evidence depends on the eyes being open*. A blanket veto would hand every
student a way to mute unrelated alerts by closing their eyes.

| Vetoable | Never vetoable |
|---|---|
| `GAZE_OFF_SCREEN`, `SIDE_GAZE_PEEKING`, and the classifier's corroboration (its escalation of `AI_CHEATING_POSE` to CRITICAL — the thing the closed-eye defect actually corrupted) | `PHONE_DETECTED`, `NO_FACE_DETECTED`, `MULTIPLE_FACES`, `SECONDARY_DEVICE`, `AI_CHEATING_POSE`, `HEAD_POSE_GLANCE`, `FULLSCREEN_EXIT`, `SCREEN_SHARE_STOPPED`, `TAB_SWITCH`, `WINDOW_BLUR`, `VISIBILITY_HIDDEN`, `LIVENESS_FAILED`, `CAMERA_FEED_SYNTHETIC` |

A phone on the desk is a phone whether or not the student blinked. `AI_CHEATING_POSE` is head
geometry and stands on its own evidence. **`NO_FACE_DETECTED` is the sharpest case**: covering
the camera destroys the landmarks, so vetoing it would turn camera-covering into a way to
silence the detector built to catch it. Both lists are explicit constants and both are asserted
by name in `ear_veto.test.js` — an unrecognised type is **not** vetoable, so new detectors opt
in deliberately rather than inheriting suppression by accident.

**⚠ 2. Unavailable EAR fails OPEN.** No landmarks, or a sample older than `maxAgeMs: 500`, and
the report proceeds unchanged. Fail-*closed* would be a suppression exploit far more attractive
than the false positive the gate prevents — anything defeating landmark detection would mute
every gaze alert at once. Staleness matters on its own: one good reading must not license
suppression indefinitely.

This is sound **only because the veto is a second line of defence**. Never delete a detector's
own EAR handling on the grounds that the veto covers it.

**Other decisions:** the face EAR is the **min** of the two eyes, not the mean — blink immunity
is not a per-eye property, and a mean lets one wide eye drag a genuine blink over the line. The
cost is that holding one eye shut suppresses gaze violations; that is bounded (the vetoable set
is gaze-only, everything else stays live) and surfaced as `telemetry().oneEyeClosedSamples`
rather than left silent. The veto runs **before** the cooldown is claimed, so a suppressed
violation does not burn its type's cooldown slot and can be reported the moment the eyes reopen.
`eyeAspectRatio` and `LANDMARK_CONTRACT` are imported from `gaze_landmarks.js`, never
re-derived — one definition of the threshold semantics in the codebase.

**Watch `telemetry().failedOpen`.** High and rising means the landmark model is absent or
failing and the safeguard is doing nothing.

#### The coarse closure channel — why a weak signal is sound *here*

`pose.onnx` is COCO-17, so `poseResult.faceLandmarks` is null and the landmark EAR is not
computable. Without a second channel every `evaluate()` fails open, and Rule 3 ("closed
eyes must never produce an alert") holds only **vacuously** — no eye detector can fire at
all. `submitClosureHint(closed, nowMs)` fixes that: `vision_engine._analyzeEyeClosure()`
runs `gaze_roi.js`'s **openness gate only** and discards `gazeH`/`gazeV` entirely.

**The veto is MONOTONE — it can only ever SUPPRESS.** That makes its two error modes
asymmetric in the student's favour:

| | consequence |
|---|---|
| false "closed" | an alert is suppressed → favours the student |
| false "open" | no suppression, i.e. today's fail-open behaviour |

This *inverts* `gaze_roi.js`'s known weakness. Its openness gate degrades on dark irises,
heavy lids and glasses glare; as a **direction** estimator that produced unequal false
accusations, which is why `enableGaze: false`. As a **suppression** input the identical
degradation produces extra suppression, which harms nobody. A coarse signal is therefore
acceptable here and nowhere else in the pipeline.

**⚠ It must never touch `hasFreshSample()`.** That predicate gates
`classifierMayAlertAlone()`. Letting this channel satisfy it would promote `best.onnx` to
a **primary accuser** on the strength of a signal explicitly too coarse to be trusted in
that direction. *Permission to suppress is not permission to accuse.* The two channels are
separate fields for exactly this reason — do not merge them. `blink_immunity.test.js`
asserts `hasFreshSample()` stays false after 30 s of coarse-channel closure.

Precedence: a **fresh landmark EAR wins outright in both directions**, including when it
says the eyes are open. The hint only speaks where the better instrument is silent.
`closureHintSamples` / `closureHintVetoes` keep the two distinguishable in the field.

#### Keyboard & downward gaze veto (same file)

The classifier also over-flags students **looking down at their keyboard**. Same family as
the closed-eyes bug — §7 (2026-08-02 e) item **(b)**, a property of the weights, not of the
reporting path — so it is contained the same way: at the choke point, where no detector can
route around it. Looking down at a keyboard is the most common benign behaviour in a typed
exam; flagging it accuses students of cheating for typing badly, which is a skill
difference, not misconduct.

Offsets are centred versions of the ratios `gaze_landmarks.js` already emits
(`hOffset = hRatio − 0.5`, `vOffset = vRatio − 0.5`). **⚠ SIGN — no flip, and adding one
would be a bug.** `verticalIrisRatio` projects the iris from upper lid toward lower lid, so
a *larger* ratio means the iris sits *lower* = looking DOWN. Positive `vOffset` is
genuinely downward, agreeing with the module's `downThreshold: 0.62`. Unlike
`GAZE_V_TO_PITCH_SIGN` in `gaze_roi.js`, this axis needs no constant — inverting it would
forgive upward glances and flag keyboard use, the exact opposite of the intent.

**Classification — first match wins, and the order IS the safeguard:**

| # | Condition | Class |
|---|---|---|
| 1 | `abs(hOffset) >= 0.15` | `SIDE_PEEK` — **never forgiven**, outranks everything below |
| 2 | `abs(hOffset) < 0.12` **and** `vOffset > 0.15` | `KEYBOARD_GLANCE` (spec Rule 1) |
| 3 | `0.14 <= ear <= 0.22` | `DESK_LOOKING` (spec Rule 2) |
| 4 | otherwise | `UNKNOWN` — reports normally |

**⚠ 1. Step 1 is what makes Rule 2 safe.** Rule 2 as specified classifies on EAR *alone*,
with no geometry condition. Resting eyelid aperture varies substantially between
individuals (lid shape, age, epicanthic folds, ptosis), so on its own it would hand a
student whose *neutral* EAR sits at 0.21 blanket immunity from every eye violation —
including a hard side-peek at their notes. A security hole and an arbitrary fairness
advantage at once. Rule 3 is only *reachable* below the side-peek bound, which closes it.
Pinned by name in `keyboard_glance.test.js`; **never reorder these**.

**⚠ 2. Most of Rule 2 was already implemented.** `analyzeEye` gates on `ear < 0.20` *before*
reading the iris, returning `hRatio: NaN, vRatio: NaN`. So `[0.14, 0.20)` was already
suppressed by the `EYE_CLOSED` path and carries no geometry at all; the genuine delta is
the narrow `[0.20, 0.22]` band. It also means Rule 1 can only ever evaluate on an open eye.

**The permit (`KeyboardGlancePermit`).** A forgiven episode may run `permitMs: 5000`, with
`graceMs: 400` so a 1–2 frame blip does not restart the budget. A `SIDE_PEEK` ends the
episode **immediately** rather than after grace — otherwise a student could alternate
down/side inside the grace window and hold a live permit for the whole time they peeked.

**⚠ 3. The anti-bypass cap.** A bare 5 s permit that resets on look-up is a *complete*
bypass: 4.9 s down, 0.5 s up, repeat, forever. So an episode passing `longGlanceMs: 3000`
is recorded once, and `maxLongGlances: 3` inside `windowMs: 60000` withdraws forgiveness
altogether. This discriminates on the axis that actually separates the behaviours — a
typist glances down **briefly and often**, a reader glances down **at length and
repeatedly**. A cumulative-time cap was rejected because it would punish hunt-and-peck
typists, precisely the students this safeguard exists to protect.

Not `DwellGate`: that class answers "fire an event after sustained truth", this needs "how
long has this episode run, and may it still be forgiven". `temporal_gate.js` is untouched.

Ordering inside `evaluate()`: `EYE_CLOSED` is tested **first** — it is the stronger claim
and needs no geometry, so a blink during a keyboard glance is attributed to the blink.
Watch `telemetry().keyboardPermit.longInWindow`; at the cap the safeguard has disengaged
and downward gaze is alerting normally.

### Eye gaze — ROI crop, no new model (`vision/gaze_roi.js`)

Every other detector answers *"where is the head pointing?"*. A student who holds their head
square and moves only their eyes — to notes on the desk, or a second monitor — is invisible to
all of them. This reads pixels from the eye region `pose.onnx` already located. **No third ONNX
graph**, one extra small `getImageData`.

**⚠ The bug this is shaped around.** The trained classifier flagged **closed eyes** as cheating.
A naive iris tracker does not merely fail on closed eyes, it fails *in that same direction*:
with the lid down the darkest feature in the eye box is the **lash line**, which sits low, so a
darkness centroid reads a shut eye as an extreme *downward gaze* — "looking down at notes".
Blinking would become cheating again.

Three layers make that structurally impossible, not merely unlikely:

1. **The openness gate runs before any centroid exists.** A closed eye returns `valid: false`,
   `reason: 'eye_closed'`. It never yields a direction.
2. **Unknown ≠ deviant.** The rule `pose_pipeline.js` already follows. `DwellGate` needs
   sustained `true` to fire, so an unbroken run of unknowns can never accumulate into an alert.
3. **Gaze only runs while the head is neutral** (`maxHeadExcursion: 0.75`, below the pose
   pipeline's own 1.0). Off-neutral frames belong to `AI_CHEATING_POSE`.

A student who blinks, dozes, or wears heavy glasses generates **silence**, not evidence.

**Openness without eyelid landmarks.** COCO-17 gives one point per eye *centre* — no eyelid
contour, so Eye-Aspect-Ratio is unavailable. Two pixel tests, both must pass, mirroring
`evaluatePhoneShape`:

| Test | Open eye | Closed eye |
|---|---|---|
| Intensity spread (`p95−p05`) ≥ 26 | high — dark iris vs bright sclera | low — uniform eyelid skin |
| Dark-blob aspect ≤ 3.0 | compact, roughly round | absent, or a thin horizontal lash line |

⚠ **`p05/p95`, not `p10/p90`.** A small or distant iris occupies under 10% of the box, and a
p10 cut-off never reaches that dark population — the region reads flat and an **open** eye is
rejected as closed. The wider percentiles keep small irises readable *and* push the lash line
onto the shape test, which is the test actually built to catch it. Narrowing them silently
shrinks coverage for the students hardest to read.

**Measurement.** Eye box sized off `interocular` (same scale-invariant basis as the whole pose
stack). Keypoints arrive already un-letterboxed by `decodePoseOutput`, so the crop needs no
coordinate mapping. Darkness threshold is `p05 + 0.35 × spread` — **adaptive**, so it tracks
iris colour and skin tone instead of assuming them. Centroid is intensity-weighted. Both eyes
must read; a one-eye sample is rejected rather than averaged into a plausible wrong number.

**Calibration reuses the frozen modules unmodified.** The result is shaped as
`{yawRatio: gazeH, pitchRatio: −gazeV, rollDeg: 0}` and fed to a **second `PoseBaseline`**
instance — its `addSample`/`deviation` are duck-typed, so gaze gets the tested median-neutral,
per-axis-tolerance and drift-suppression machinery for free. Deviation is from the student's
**own** neutral gaze, never an absolute angle.

**⚠ SIGN.** Horizontal inherits the house convention for free: frames are unmirrored, so a
student looking toward their **own left** moves the iris toward the **right of the image** →
`gazeH` positive — exactly `yawRatio`'s meaning. **Vertical does not.** Image *y* grows
downward so looking down *increases* centroid y, while `pitchRatio` *decreases*. The flip is
encoded once in `GAZE_V_TO_PITCH_SIGN = -1` and pinned by a test. Never patch it by inverting
an individual threshold.

**Severity is capped at MEDIUM**, and deliberately *not* escalated by the classifier — that
model has no notion of eye direction either, and pairing two weak signals manufactures a
strong-looking claim. Vertical tolerance is wider than horizontal (`0.24` vs `0.16`): the upper
lid always occludes part of the iris by a varying amount, so the vertical centroid carries a
wandering bias the horizontal one does not.

**Limitations — design boundaries, not bugs to fix later:**
- **Coarse, not point-of-regard.** Resolves left/centre/right and up/down. Catches "eyes parked
  off-axis for 3 s"; cannot tell which line of a cheat sheet was read. Never describe it as if
  it could.
- **Resolution floor `minInterocularPx: 45`** (vs 12 for head pose). Students seated far from
  the camera get **no** gaze analysis — which must degrade to *nothing*, never to a guess.
- **Looking down narrows the eye aperture**, so genuine downward gaze may trip the openness
  gate and be missed. Accepted: a miss is the safe direction.
- **Glasses glare and frame edges** reduce coverage for that student; the shape gate rejects
  rather than guesses.
- **Fairness needs explicit validation.** The adaptive percentile is chosen so iris and skin
  tone do not move the threshold, but that must be *verified across tones*, not assumed.
  Unequal coverage is a fairness failure even when it never produces a false accusation. Treat
  as a release gate.

### Pre-exam lighting advisory (`content/lighting_checker.js`)

Every detector here degrades in poor light, and none of them *say so* — they just get
quieter or noisier. `gaze_roi.js` was withdrawn over exactly this, and the pose stack
silently loses keypoint confidence in a dark room. A student could start an exam backlit
by a window and generate low-confidence output for the whole session with nothing
recording that the **setup**, not the student, was the problem.

**⚠ ADVISORY. IT CANNOT ACCUSE AND IT CANNOT BLOCK.** No entry in §6, never calls
`reportViolation`, and — since the hardening pass — **no launch gate**. There is
deliberately no predicate a caller could hang the Start button on: `isOptimal()` exists
to colour a message and its doc comment says so. `lighting_checker.test.js` asserts the
module exports no severity, no violation type, and nothing matching `/block|readiness/`.

Both halves are load-bearing for different reasons. It must never **accuse**, or an
unlucky room becomes evidence of misconduct. It must never **block**, because
`backlitFaceMax: 35` is an absolute grey level measured on skin — as a launch gate its
failure mode was *denial of exam access* for dark-skinned students, which is strictly
worse than the low-confidence session it was preventing. Advisory removes that failure
mode outright instead of tuning around it.

What survives is a suggestion the student may ignore, plus one telemetry record sent with
the join payload (`ProctorSessionJoin.lighting`, logged, deliberately not persisted) so a
teacher reviewing a low-confidence session can see the room was flagged at setup.

**No model.** Canvas pixel sampling only: one `getImageData` per tick on a frame
downsampled to 128 px wide. Safe here in a way it is not for the eye ROI, because every
quantity is a mean or a standard deviation over a large region and resampling does not
move either. `rgbaToGray` is imported from `gaze_roi.js` — already exactly the specified
BT.601 form (`0.299R + 0.587G + 0.114B`) — never re-derived. One definition of
brightness in the codebase, the same rule `ear_veto.js` follows for `eyeAspectRatio`.

**Two-stage consent gate, and why it must be two.** `getDisplayMedia()` and
`requestFullscreen()` both need a live user gesture, and `getDisplayMedia()` **consumes**
it. An async lighting check between the click and those calls would spend the activation
and break both — the constraint documented at `monitor.js`'s `startProctoring`. So the
check gets its own earlier click, and the consent click that follows is unspent:

```
stage 1  "Enable Camera & Check Lighting" -> getUserMedia only
           preview + alignment oval, 5 FPS, live message
           Continue unlocks only on lightingChecker.isReady()
stage 2  "Begin Secure Proctoring"        -> getDisplayMedia + fullscreen
           ADOPTS the stream stage 1 opened (one camera prompt, not two)
```

Ownership of that stream transfers exactly once, at `webcamStream = await webcamPromise`.
Getting it wrong either leaves a camera light on after the gate closes, or kills the
stream the session is about to use.

**The face box is geometric, not detected.** The gate runs before `initVisionEngine()`,
so `pose.onnx` is not loaded and the brief forbids extra model overhead.
`FACE_BOX_RATIOS` (38% × 55%, centred at y = 0.48) is read by **both** the analyser and
the on-screen oval, so the box is a *contract with the student* — "fill the oval" — not
a guess about where their face is. They must never drift apart, or students are told to
align to a region the gate is not measuring. Background = the frame outside that rect,
derived by subtracting the face sums from the whole-frame sums rather than a second pass.

**Evaluation — first match wins:**

| Test | Verdict |
|---|---|
| `avg < 40` | `TOO_DARK` — "Your room is too dark. Please turn on overhead lights." |
| `avg > 215` | `OVEREXPOSED` — "Camera feed is washed out. Avoid bright lights pointing at the lens." |
| `face < 35` **and** `bg > 160` | `HIGH_BACKLIGHT` — "Strong backlight detected behind you. Move your camera away from bright windows." |
| `(bg − face) > 70` **and** `faceStdDev < 12` | `HIGH_BACKLIGHT` (silhouette) |
| otherwise | `PASS` |

Global exposure is settled **first** on purpose: in a near-black frame the face/background
comparison is measuring sensor noise, and its answer means nothing.

**`isOptimal()` gates the WORDING, not the exam.** It requires `sampleCount > 0` and
**3 consecutive** PASS samples (~600 ms), so the message cannot flicker while a student
adjusts a lamp. An unreadable frame neither advances nor resets the run — it is not
evidence in either direction. `advisory()` is the accessor; `checkLightingStatus()` is
the spec's name for the same object.

**⚠ UNREADABLE ≠ FAILING.** A flat face crop at normal luminance returns `PASS`. The
likely cause is a student who has not aligned to the oval yet, and "we cannot see a face"
is not a lighting fault — §5's rule for detectors, applied to a gate. Blocking on it would
lock someone out for sitting slightly off-centre, and the in-exam pose pipeline already
reports an absent face on its own evidence. The silhouette branch therefore needs
flatness **and** a much brighter background before it fires.

**Fairness — why the ADVICE is still shaped carefully.** Going advisory removes the
access risk, not the risk of telling a student something wrong about their room. Two
properties keep the advice itself fair, and both are pinned by tests:

1. `HIGH_BACKLIGHT` is **relative** — it needs a dark face **and** a bright background, so
   an evenly-lit room cannot trigger it at any skin tone. **Never reduce it to a face-only
   test.** Four checks under "FAIRNESS REGRESSION" go red if anyone does.
2. Low face contrast **alone** never warns; the silhouette branch also needs a much
   brighter background, because a flat face box usually just means nobody is in it.

`minFaceStdDev: 12` and `silhouetteDelta: 70` are reasoned, not measured, and set
conservatively. `window.getLightingState()` exposes every reading so they can be
calibrated against real sessions rather than assumed.

### Active liveness — 2-tiered anti-spoofing (`content/liveness_challenge.js`)

Every other detector answers *"where is the head pointing?"*. A photograph taped in front of
the webcam answers that perfectly and forever. This module asks a question a photo cannot
answer. **No extra model, no extra inference** — it consumes the yaw/pitch the pose pipeline
already emits, one pixel-delta accumulator, and one DOM element.

**The governing rule: no passive signal may accuse anyone.** Both entry paths lead to the same
active challenge, and only a *failed challenge* produces a violation.

```
        ┌─ TIER 0  pose peak-to-peak < 1° for 45 s ──┐
        │                                            ├─▶ CHALLENGE ─3.5 s─▶ pass: cleared
        └─ TIER 1  pixel delta == 0 for 30 f / 1 s ──┘        │              fail: CRITICAL
                                                              └─▶ COOLDOWN 60 s
```

**Why Tier 1 cannot stand alone.** Physical sensors produce photon noise, so in theory a live
camera never repeats a buffer. In practice plenty of benign software destroys that evidence:
webcam 3D noise reduction, frame duplication in low-spec decoders, and VM/RDP display drivers
all re-emit an identical buffer for a still subject. Flagging on zero delta alone would falsely
accuse students on ordinary hardware. (The 32×32 downsample used for the measurement averages
noise away too, making this *more* likely, not less.)

So zero delta buys the student a challenge, nothing more. A frozen driver clears it the instant
its owner looks at the dot — which also un-freezes the feed. A photo or injected stream cannot
react to an unpredictable corner inside 3.5 s. Only that combination is reported.

**1a. Pixel-delta watch — Tier 1 (`SyntheticFrameMonitor`).** `analyzeFrameChange()` in
`monitor.js` computes the FNV hash and the mean absolute per-channel delta of a 32×32
downsample **in one pass, off one `getImageData`** — the readback is the expensive part, so the
delta is nearly free. Suspicion needs `delta == 0` for **≥30 frames AND ≥1000 ms** (both
floors, since 30 frames is 1.5 s on Tier A but 3.3 s on Tier B). Suspicion is *not* cumulative:
one changed frame clears it. It escalates ahead of the cooldown — a dead feed is more urgent
than the 45 s pose watch — bounded by `forcedRechallengeMs: 30000` so a stuck feed cannot
prompt forever.

**⚠ The bug this fixed.** The frozen-feed guard used to `return` *above* the liveness call, so
an OBS still image was short-circuited into "Camera paused…" and **permanently invisible** to
the very challenge built to catch it (found by live test with an OBS virtual camera). The guard
now (a) always advances the liveness clock before returning, and (b) **does not skip inference
while a challenge is open or suspicion is raised** — a static image yields a perfectly readable
pose, and those samples are exactly what makes the verdict `FAILED` rather than `INCONCLUSIVE`.
Never reinstate an early `return` above `livenessManager.update()`.

**1b. Frozen-pose watch — Tier 0 (`FrozenPoseMonitor`).** Rolling 60 s window; declares *frozen* when
peak-to-peak yaw **and** pitch stay under 1.0° across ≥45 s and ≥60 samples.
- **Peak-to-peak, not statistical variance.** The threshold is `abs(Yaw_change) < 1.0 degree`,
  which is a *range* statement; variance in deg² is not comparable to it. Range is also
  stricter — one real movement clears it instantly, where it would barely move a variance over
  400 samples. Variance is computed and exposed for telemetry but does not gate.
- Only **readable, calibrated** frames are admitted. An unreadable frame is not evidence of
  stillness; counting it would let a student build a "frozen" streak by covering the camera
  (which is `NO_FACE_DETECTED`, a different violation). Gaps > 3 s reset the streak.
- No live human holds < 1° for 45 s. This fires on photos, looped clips, and paused virtual
  cameras — it is complementary to `monitor.js`'s `frameSignature` guard, which only catches a
  *pixel-identical* frame.

**2. Corner-only targets.** Four positions, and only four:

| Corner | CSS | Required head shift (student's own frame) |
|---|---|---|
| `TOP-LEFT` | `20px, 20px` | left + up |
| `TOP-RIGHT` | `calc(100vw - 60px), 20px` | right + up |
| `BOTTOM-LEFT` | `20px, calc(100vh - 60px)` | left + down |
| `BOTTOM-RIGHT` | `calc(100vw - 60px), calc(100vh - 60px)` | right + down |

`assertCornerOnly()` is a **runtime guard**, not a comment — centre and mid-edge targets throw.
A target near the centre sits in the reading area and can be satisfied by eye movement alone,
which the pose model cannot see; that would degrade the challenge into something a photograph
passes. 40 px pulsing neon dot, `position: fixed` (so it survives fullscreen without exiting
it), `pointer-events: none` (cannot intercept exam clicks or be dismissed), z-index
`2147483645` — under the consent gate and widget, over the exam.

**3. ⚠ SIGN CONVENTION — the highest-risk part of this module.**

`pose_geometry.js` yaw is **image-relative**: *"positive means the nose moved toward the right
of the frame … It is the subject's own left."* `getUserMedia` frames are **unmirrored**. So:

```
dot at the SCREEN's LEFT edge
  → student turns toward THEIR OWN left
  → nose moves toward the RIGHT of the camera image
  → yawDeg is POSITIVE
```

A literal reading of *"TOP-LEFT ⇒ Yaw < −12"* tests the **exact opposite of compliance**: the
student does what they were told and is flagged as a spoofer at CRITICAL severity. The flip is
encoded once, in `SCREEN_LEFT_YAW_SIGN = +1`, and pinned by tests written from the student's
point of view. If a deployment ever mirrors the feed, set `response.mirrored = true` — flip
that one flag, never the individual thresholds.

Pitch needs no mirroring (`pitchDeg > 0` is up, `< 0` is down, per `pose_calibration`).

**4. Verification.** 3.5 s window; **both** axes must satisfy the corner simultaneously.
- Yaw threshold **12°** (as specified). Pitch threshold **6°**, deliberately lower: the
  nose-below-eye-line cue compresses hard on the vertical axis, so a pivot that easily clears
  12° of yaw produces well under 12° of pitch. Symmetric thresholds would make the top corners
  physically unreachable and convert honest compliance into a spoofing flag.
- Degrees are **deviation from the student's own calibrated neutral** (`ratioToApproxDegrees`),
  never absolute pose. Absolute angles from 5 keypoints are untrustworthy by design — see the
  header of `pose_geometry.js`.
- Outcomes, by `trigger`:

| Outcome | Trigger | Violation |
|---|---|---|
| `PASSED` | any | none — clears suspicion, resets both monitors, 60 s cooldown |
| `FAILED` | `frozen_pose` | `LIVENESS_FAILED` CRITICAL — *"FLAG_CHEATING: Failed Liveness Challenge (Static Image/Spoofing Detected)"* |
| `FAILED` | `synthetic_frame` | `CAMERA_FEED_SYNTHETIC` CRITICAL — *"CRITICAL: CAMERA_FEED_SYNTHETIC + LIVENESS_FAILED"* |
| `INCONCLUSIVE` | any | **none** |

  A synthetic-triggered failure reports `CAMERA_FEED_SYNTHETIC` **instead of**
  `LIVENESS_FAILED`, not both — one student action, one violation, the same rule the focus-loss
  coalescer follows. The liveness detail rides in its `metadata` as the evidence.

  `INCONCLUSIVE` (< 3 usable pose samples) reports nothing: "we could not see" and "the student
  did not move" are different answers and only one is an accusation; the absent-face case is
  already reported by the pose pipeline on its own evidence.
- One qualifying sample passes (`requiredConsecutiveSamples: 1`). The errors are asymmetric: a
  false PASS lets a spoofer survive one challenge and be re-tested in 60 s; a false FAIL brands
  an honest student. Marginal evidence must favour the student.

**5. Look-away suppression (`monitor.js: handlePoseEvents`).** The challenge *orders* the
student to look at a corner; holding that gaze past 2.5 s is exactly what the look-away dwell
gate reports as `AI_CHEATING_POSE`. `LOOK_AWAY` events are therefore suppressed **at the
reporting layer only**, and only while the dot is up. The pose pipeline is untouched — it still
runs, gates, and reaches telemetry; only the accusation is withheld. `NO_FACE` and
`MULTIPLE_FACES` stay live throughout: a corner prompt excuses nothing about a second person.

---

## 5. Hard constraints

- ⚠ **Head pose / gaze / gesture logic is frozen.** `pose_geometry.js`, `pose_calibration.js`,
  `pose_pipeline.js`, `temporal_gate.js` are working well and must not be modified. Behaviour is
  pinned by `extension/test/pose_pipeline.test.js`.
- **`manifest.json` script order is load-bearing.** Content scripts resolve dependencies off
  `window` at load time; a wrong order fails at runtime, not at parse time.
  `runtime_profile.js` must precede `onnx_inference.js` and `vision_engine.js`;
  `liveness_challenge.js` must precede `monitor.js`.
  `extension/test/vision_integration.test.js` enforces this.
- **Head-pose signs are image-relative, not student-relative.** Positive yaw = the subject's
  own LEFT. Any new feature that maps a screen position to an expected head angle must go
  through `SCREEN_LEFT_YAW_SIGN`, not re-derive the flip. Eye gaze inherits the same convention
  horizontally; its vertical flip lives once in `GAZE_V_TO_PITCH_SIGN`.
- **The EAR veto allowlist is safety-critical.** Adding a type to `VETOABLE_VIOLATIONS` asserts
  "a student with closed eyes cannot commit this". `NO_FACE_DETECTED` and `PHONE_DETECTED` must
  never be added. The veto must always **fail open** — a suppression exploit is a worse failure
  than the false positive it prevents.
- **The lighting advisory may never accuse and may never block.** `lighting_checker.js`
  must not call `reportViolation`, gain a severity, appear in §6, or grow a predicate that
  disables the Start button. `HIGH_BACKLIGHT` must keep **both** its face and background
  conditions — a face-only test would tell dark-skinned students their room is broken —
  and low face contrast alone must never warn. Pinned by `lighting_checker.test.js`.
- **The coarse closure hint may suppress, never license an accusation.**
  `submitClosureHint()` must never satisfy `hasFreshSample()`. That predicate is what
  promotes the classifier to a primary accuser, and this signal is explicitly too coarse
  for that. A fresh landmark EAR always outranks it, in both directions. Pinned by
  `blink_immunity.test.js`.
- **A side peek is never forgiven by the keyboard veto.** `classifyGlance` tests
  `abs(hOffset) >= sidePeekOffset` **first**, before either classification rule. Reordering
  it below Rule 2 would hand blanket immunity to any student whose resting eyelid aperture
  falls in the 0.14–0.22 band. The 5 s permit must also keep its long-glance cap, or
  downward gaze detection is defeatable by anyone who looks up for half a second. Both are
  pinned by name in `keyboard_glance.test.js`.
- **Blink immunity must not become an off switch.** Every type in `NEVER_VETOABLE` is
  asserted by name in `blink_immunity.test.js` to still fire after 30 s of closed eyes.
  `NO_FACE_DETECTED` is the sharpest case: covering the camera destroys the landmarks, so
  vetoing it would turn camera-covering into a way to silence the detector built to catch it.
- **No detector may accuse on an unreadable observation.** "We could not see" and "the student
  did something" are different answers and only one is an accusation. Closed eyes, an
  unresolvable face, and a too-distant subject must all yield UNKNOWN — never a direction, a
  magnitude, or a deviant sample. This is what keeps the closed-eyes-means-cheating defect from
  coming back through a new door.
- **Inference is single-flight.** `onnx_inference.js` reuses one canvas and one `Float32Array`;
  two concurrent `predictFrame()` calls corrupt each other's input.
- **Export imgsz must match what the extension feeds.** A mismatch silently destroys accuracy
  rather than erroring.
- **Nothing alerts on a single frame** — except a gated phone, deliberately (see above).

---

## 6. Violation taxonomy

| Type | Severity | Raised by |
|---|---|---|
| `FULLSCREEN_EXIT`, `SCREEN_SHARE_STOPPED` | CRITICAL | DOM/track events |
| `PHONE_DETECTED` | CRITICAL | phone gate + latch, first qualifying frame |
| `LIVENESS_FAILED` | CRITICAL | failed corner challenge (frozen-pose trigger) |
| `CAMERA_FEED_SYNTHETIC` | CRITICAL | zero pixel delta **confirmed by** a failed corner challenge |
| `TAB_SWITCH`, `VISIBILITY_HIDDEN`, `AI_CHEATING_POSE`, `SECONDARY_DEVICE` | HIGH | focus / pose / dwell |
| `AI_CHEATING_CLASSIFIER` | HIGH | `best.onnx` on its own evidence, EAR-vetoed. Requires a live landmark model |
| `WINDOW_BLUR`, `MULTIPLE_FACES`, `NO_FACE_DETECTED` | MEDIUM | focus / pose |
| `GAZE_OFF_SCREEN` | MEDIUM | eye ROI, head-neutral only; LOW on a glance. Never CRITICAL |
| `SIDE_GAZE_PEEKING` | MEDIUM | landmark geometry, head-neutral only; LOW on a glance. Never CRITICAL. Wired, inert until a FaceMesh model is served |
| `HEAD_POSE_GLANCE` | LOW | 1.5–2.5 s look-away, recorded not escalated |

**Not in this table, deliberately:** the pre-exam lighting gate (§4). `TOO_DARK`,
`OVEREXPOSED` and `HIGH_BACKLIGHT` are *readiness verdicts*, not violations — they block
the Start button and are never reported, stored, or shown to a teacher. Do not add them.

---

## 7. Session log

### 2026-08-03 (c) — Keyboard & downward gaze veto

**Why** — the classifier over-flags students looking down at their keyboard. Same family
as the closed-eyes defect (entry e, item **(b)**): a property of the weights, so it gets
contained at the reporting choke point rather than tuned out of a detector.

**Changed** — `ear_veto.js` only. `GLANCE_CLASS`, `KEYBOARD_VETO_DEFAULTS`,
`classifyGlance()` (pure), `isForgivableGlance()`, `KeyboardGlancePermit`,
`VETO_REASON.KEYBOARD_GLANCE`; `submitLandmarks()` now also classifies and advances the
permit; one new branch in `evaluate()` ordered after `EYE_CLOSED`; telemetry + reset
extended. `analyzeGazeLandmarks` is destructured from the **existing**
`gaze_landmarks.js` import — no new require, **no manifest change, no load-order change**.
`monitor.js` suppression logs now name *which* safeguard fired, with the spec's
`[SUPPRESSED]` prefix.

**Added** `extension/test/keyboard_glance.test.js` (95 checks), including the two the brief
names: **3 s at the keyboard → ZERO alerts**, **2 s looking sideways → an alert fires**.

**Tests** — **All 13 suites pass (881 checks).** Frozen head-pose modules and
`temporal_gate.js` untouched.

**Three deviations, all documented in §4:**

1. **Implemented in `ear_veto.js`, not a new `reporting_gatekeeper.js`.** That file already
   *is* the reporting gatekeeper; the name was settled last session, and it keeps the
   property that the allowlist is enforced in exactly one place.
2. **⚠ A side peek is an unconditional override, tested BEFORE both rules.** Rule 2 as
   written classifies on EAR alone, which would give any student whose *resting* eyelid
   aperture sits in `[0.14, 0.22]` blanket immunity from every eye violation — including a
   hard side-peek. Resting EAR varies with lid shape, age, epicanthic folds and ptosis, so
   that is a security hole and an arbitrary fairness advantage at once. The spec's own
   reporting rule ("IF horizontal peeking is present … Dispatch") is what closes it.
3. **⚠ The 5 s permit carries a long-glance cap that the brief does not specify.** Without
   it the permit is a *complete* bypass — 4.9 s down, 0.5 s up, repeat, forever. Three
   episodes over 3 s inside a 60 s window withdraw forgiveness. Chosen over a
   cumulative-time cap because a typist glances down briefly and often while a reader
   glances down at length and repeatedly; a time budget would have punished hunt-and-peck
   typists, exactly the students this safeguard protects.

**Also worth knowing:** most of Rule 2 was already implemented. `analyzeEye` gates on
`ear < 0.20` *before* reading the iris, so `[0.14, 0.20)` was already suppressed by the
`EYE_CLOSED` path and has no geometry at all — the real delta is the `[0.20, 0.22]` band.

**⚠ Inert in production, like the rest of the eye stack.** Needs 478-point FaceMesh
landmarks; `pose.onnx` is COCO-17, so `classifyGlance` receives nothing and every
`evaluate()` fails open. The coarse pixel channel deliberately does **not** extend here:
the horizontal test is used to *deny* suppression, so a noisy horizontal reading causes
wrongful suppression — it is not monotone-safe the way pure closure detection is.


### 2026-08-03 (b) — Pipeline audit, blink immunity made real, lighting made advisory

Four-point conformance audit of `extension/content/vision/` against the architectural
rules, plus the changes to close the gaps.

| Component | Audit verdict |
|---|---|
| Synthetic feed (`CAMERA_FEED_SYNTHETIC`) | ✅ **Compliant, unchanged.** `maxDelta 0.0`, `minFrames 30`, `minDurationMs 1000`; escalates to the 3.5 s corner challenge, never to a direct violation; pass clears suspicion; fail → `CAMERA_FEED_SYNTHETIC + LIVENESS_FAILED`. |
| EAR veto | ✅ Logic correct — ❌ **was inert** (no landmarks). Now backed by a coarse channel. |
| Side-gaze | ⚠️ **Was never wired** — `GazeLandmarkAnalyzer` was constructed nowhere outside its test file, so `SIDE_GAZE_PEEKING` could not reach `reportViolation`. Now wired. |
| Lighting gate | ❌ **Hard-blocked. Now advisory.** |

**⚠ THE FINDING THAT MATTERED.** Rules 2 and 3 held **vacuously**. `backend/static/models/`
contains only `best.onnx`, `detect.onnx`, `pose.onnx`; `pose.onnx` is COCO-17 with one
point per eye, so `faceLandmarks` was always null, every `evaluate()` failed open, and no
eye detector could fire at all. Blink immunity was satisfied by the *absence of the
feature*, not by the safeguard working. That is not the same property and would have
evaporated the moment a landmark model was served.

**Changed**
- `lighting_checker.js` — `isReady()` → `isOptimal()` (cosmetic, gates message colour);
  `advisory()` added, `checkLightingStatus()` delegates. Thresholds untouched.
- `monitor.js` — Continue is enabled the moment the camera is live and **never disabled**;
  advisory line + "this is a suggestion, not a requirement" hint; lighting snapshot sent
  with the join payload; `SIDE_GAZE_PEEKING` type (MEDIUM) + `handleLandmarkGazeEvents()`;
  `submitClosureHint()` fed once per frame; `getLandmarkGazeState()`, `getEyeClosureState()`.
- `vision_engine.js` — `enableLandmarkGaze` (on) and `enableClosureHint` (on);
  `_collectFaceLandmarks()` seam, `_analyzeLandmarkGaze()`, `_analyzeEyeClosure()`;
  `setGazeSuppressed()` now covers both analysers; telemetry + reset extended.
- `gaze_landmarks.js` — `maxHeadYawDeg: 15`, required **in addition to** the calibrated
  `maxHeadExcursion: 0.75`. Unmeasurable yaw is UNKNOWN, never "straight ahead".
- `ear_veto.js` — `submitClosureHint()`, `VETO_REASON.CLOSURE_HINT`, telemetry split.
- `backend/main.py` — optional `lighting` field on `ProctorSessionJoin`, logged only.

**Added** `extension/test/blink_immunity.test.js` (62 checks) — 30 s at both tier cadences
through the real analysers *and* the real veto *and* a `reportViolation` stand-in. The
existing suites each proved one half in isolation; neither would have caught a detector
wired to a path that skips the veto.

**Tests** — **All 12 suites pass (777 checks).** The four frozen head-pose modules are
untouched; `pose_pipeline.test.js` still green at 73.

**Deviations, both deliberate:**
1. **`ear_veto.js` was NOT renamed to `reporting_gatekeeper.js`.** It already is that
   interceptor, and the name is referenced by `manifest.json`, two suites and this file —
   a rename is churn against a load-bearing load-order contract.
2. **`abs(Head_Yaw) < 15°` is measured as deviation from the student's own calibrated
   neutral**, not from the optical axis — the same quantity `liveness_challenge.js` uses.
   Absolute angles from 5 keypoints are untrustworthy by design, and an absolute reading
   would penalise anyone whose camera sits off to one side.

**⚠ Still blocked on a model we do not have.** `SIDE_GAZE_PEEKING` and the landmark EAR
are now fully wired and tested but produce nothing until a 478-point FaceMesh ONNX is
served and decoded into `_collectFaceLandmarks()`. The coarse closure channel covers the
*suppression* half in the meantime; it does not provide side-gaze detection, and it must
never be extended to.

**Proposed, not implemented** — four safeguards for cheat vectors nothing currently
covers. Costed for Tier B; each escalates to the corner challenge or to telemetry, never
straight to an accusation.

1. **Loop/replay detection (perceptual-hash revisit).** A looped clip has *nonzero*
   variance, so Tier 1 misses it entirely. Ring-buffer the 32×32 FNV hash
   `analyzeFrameChange()` already computes; flag a run of ≥8 consecutive hashes recurring
   at lag > 2 s. One Map lookup per frame. FP guard: a *sequence* match, not a frame match
   — a genuinely static scene is Tier 1's business.
2. **Background perimeter occupancy.** `MULTIPLE_FACES` needs a *face*; a second person
   turned away or in shadow has none. Decode COCO class 0 from the `detect.onnx` tensor
   already being decoded every frame, dwell-gate a non-overlapping second person box for
   4 s. Marginal cost ≈ 0. FP guard: the 4 s dwell plus a minimum box area, same treatment
   `SECONDARY_DEVICE` gets.
3. **Lens obstruction vs. dark room.** A covered lens is low luminance **and** near-zero
   spatial gradient **and** near-zero temporal delta; an unlit room retains sensor noise
   and gradient. Sobel-lite on the existing 32×32 downsample, ~2k ops. FP guard: it
   accuses nobody — it escalates to the corner challenge, which a covered camera cannot
   pass, and `NO_FACE_DETECTED` already owns the accusation on its own evidence.
4. **Illumination transient (monitor glow / phone screen).** A second screen opening in a
   dark room is a sustained luminance step concentrated on the face with a blue-shifted
   channel ratio. All three channel means come free from the same `getImageData`. FP
   guard: LOW/telemetry only, must corroborate with pitch-down or gaze, and suppressed
   around known events (fullscreen change, tab switch) that legitimately change the glow.


### 2026-08-03 — Pre-exam lighting readiness gate (superseded by 2026-08-03 (b))

**Why** — every detector degrades in poor light and none of them say so. A student could
start backlit by a window and produce low-confidence output all session with nothing
recording that the setup was at fault. This measures the room *before* the exam and
withholds the Start button, with live feedback naming the fix.

**Added**
- `extension/content/lighting_checker.js` — `LIGHTING_STATUS`, `LIGHTING_MESSAGES`,
  `LIGHTING_THRESHOLDS`, `FACE_BOX_RATIOS`, `clampBox`, `faceBoxFor`, `regionStats`,
  `frameStats`, `evaluateLighting`, `LightingSampler`, `LightingChecker`. Imports
  `rgbaToGray` from `gaze_roi.js` rather than re-deriving BT.601.
- `extension/test/lighting_checker.test.js` — 107 checks.

**Changed**
- `monitor.js` — two-stage consent gate (`renderLightingStage`, `startLightingPreflight`,
  `paintLightingFeedback`, `renderConsentStage`, `teardownLightingCheck`);
  `beginProctoringSession()` adopts the preflight webcam stream instead of calling
  `getUserMedia` twice; `window.getLightingState()`.
- `manifest.json` — `lighting_checker.js` after `gaze_roi.js`, before `monitor.js`.
- `vision_integration.test.js` — load-order contract. The `content/vision/` count stays
  **10**; the gate is setup UI and lives in `content/`, like `liveness_challenge.js`.

**Tests** — **All 11 suites pass (699 checks).** Head-pose modules untouched.

**Two deviations from the brief, both documented in §4:**

1. **The face bounding box is geometric, not detected.** The gate runs before
   `initVisionEngine()`, so `pose.onnx` is not loaded, and "zero extra AI model overhead"
   forbids loading one. `FACE_BOX_RATIOS` drives both the analyser and the on-screen
   alignment oval, which makes the box a *contract* with the student instead of a guess.
2. **`checkLightingStatus()` returns the specified 4 statuses, but launch is gated on
   `isReady()`**, which also requires real samples and a 3-sample stable run. `status`
   alone is insufficient: a never-sampled checker reports `PASS` meaning "no fault found",
   and a camera producing no frames would otherwise start an exam.

Spec item 1's face standard deviation feeds the **silhouette** branch of
`HIGH_BACKLIGHT`, since it would otherwise be computed and unused. It requires flatness
*and* a much brighter background — flatness alone almost always means the student has not
sat down in front of the oval yet, and locking someone out for that would violate §5.

**⚠ Known follow-up — this has an unvalidated fairness risk.** `backlitFaceMax: 35` is an
absolute grey level measured on skin. `HIGH_BACKLIGHT` being a *relative* test contains
most of it (an evenly-lit room cannot trigger it at any skin tone, pinned by four
regression checks), but a dark-skinned student in front of a merely bright wall is still
exposed — and here the failure mode is **denial of exam access**. Measure lockout rates
across skin tones from `window.getLightingState()` before relying on this. `minFaceStdDev`
and `silhouetteDelta` are reasoned, not measured, and want the same treatment.

**Untested by CI** — the `monitor.js` UI wiring. The suites cover the pure evaluation
logic and the manifest contract; the two-stage gesture flow needs the manual browser
checks (dark room / lamp in lens / bright window behind, then confirm the screen-share
prompt still appears — that last one proves the user gesture survived the split).


### 2026-08-02 (e) — Classifier promoted to primary, EAR veto as the sole exception

**The rule, as specified:** `best.onnx` classifies the frame; if it says cheating, treat it as
cheating — **except** when MediaPipe reports the eyes closed.

This is the classifier restored as a primary detector. The arming state machine
(`evaluateCheatWindow`, 7-of-10 window with hysteresis) already existed and already computed the
verdict; it simply refused to report. It now reports `AI_CHEATING_CLASSIFIER` (HIGH), and the
eyes-closed exception is applied inside `reportViolation()` through the shared veto gate — not
at the call site, so a future caller reaching this path another way cannot bypass it.

**Kept as a SEPARATE violation type from `AI_CHEATING_POSE`** on purpose. A teacher reviewing an
incident must be able to tell "head geometry measured this" from "a learned model thought the
frame looked wrong". Those warrant different confidence and collapsing them would hide that.

**⚠ The classifier had TWO false positives. The veto fixes ONE.**

| | Fixed? |
|---|---|
| (a) eyes closed → flagged | **yes** — this is exactly what the EAR veto removes |
| (b) sitting still, facing the camera, just differently from the training distribution → flagged (*"I looked straight at the camera and got flagged"*) | **no** |

(b) is a property of the weights, not of the reporting path. Nothing in this change touches it,
and no gate can — the honest fix is retraining with those frames labelled correctly. Promotion
accepts (b) as a deliberate, known risk in exchange for catching behaviour head-pose geometry
cannot see. If false positives reappear on students sitting normally with their eyes open,
that is (b), and the fix is the dataset.

**⚠ Promotion is safety-coupled to the safeguard actually running.** `classifierMayAlertAlone()`
requires `earVetoGate.hasFreshSample()`. The veto **fails open**, so an absent landmark model
means no protection — and a rule of the form "trust X unless the eyes are closed" is
unimplementable when nothing can see the eyes. Without live landmarks the classifier stays at
corroboration-only, exactly as before, and logs why once. Promoting it anyway would reinstate
(a) in full.

**Changed** — `monitor.js`: `AI_CHEATING_CLASSIFIER` type + HIGH severity, `CLASSIFIER_PRIMARY`,
`classifierMayAlertAlone()`, report path in `evaluateCheatWindow()` carrying `votes`/`ratio`/
`pose_agrees`. `ear_veto.js`: `AI_CHEATING_CLASSIFIER` added to `VETOABLE_VIOLATIONS`, new
`hasFreshSample()`. `ear_veto.test.js` grew to 70 checks including 30 s of
classifier-says-cheating with eyes shut → zero events.

**Tests** — **All 10 suites pass (574 checks).**

**Net effect today:** still inert, because there is no landmark model. The classifier keeps its
current corroboration-only behaviour and prints one warning explaining the hold. Serving a
478-point FaceMesh ONNX activates the veto, the promotion, `gaze_landmarks.js` and
`ear_veto.js` — all four — in one step.


### 2026-08-02 (d) — WebGPU never bound; cadence chased an impossible target

**Symptom** — `removing requested execution provider "webgpu" ... backend not found`, followed
by `Inference took 447ms vs the 50ms tier-A target (provider: webgpu ...)`. The log contradicted
itself: webgpu was removed, yet reported as the provider.

**Root cause — the probe asked the wrong question.** `probeWebGPU()` tests `navigator.gpu` +
`requestAdapter()`, i.e. *does the BROWSER support WebGPU*. Chrome says yes on nearly any modern
machine, so Tier A was selected. But `extension/lib/ort.min.js` is the **wasm-only** ORT bundle
with no webgpu backend to bind. ORT dropped the EP and **succeeded on wasm**, so the fallback
`catch` in `createSession` never ran, `degradedToWasm` was never set, and `provider: chain[0]`
reported the *requested* EP. Net effect: CPU inference driven at Tier A's 50 ms cadence.

**Fixed**
- `runtime_profile.js` — new `ortSupportsWebGpu(ortRef)` (checks `ort.env.webgpu`, present only
  in JSEP/WebGPU builds). `createSession` now strips unbindable providers *before* the call, so
  the reported provider is the truth, and sets `ortLacksWebGpu` + `degradedToWasm`.
- `monitor.js` — `maybeRetierForMeasuredCost()`. Scheduling from completion already avoided
  queueing, but with a 447 ms tick against a 50 ms target the scheduler fell to `proctorMinGapMs`
  every time and the loop ran **flat out with zero idle** — saturating a core and stuttering the
  exam UI. *A proctor that degrades the exam it is proctoring has failed at its job.* After 8
  consecutive overruns it adopts `measured × 1.35` (capped at 1000 ms) and backs the classifier
  off to 4× that. `runtimeProfile.tier` is deliberately **not** rewritten, so telemetry keeps
  "we chose Tier A" distinct from "Tier A was unachievable here".
- `runtime_profile.test.js` — both fakes gained `env`; new checks separate *wasm-only build*
  from *webgpu build whose graph fails to compile*. These are different failures needing
  different mechanisms.

**To actually get the GPU:** replace `extension/lib/ort.min.js` with `ort.webgpu.min.js` (or
`ort.all.min.js`). The matching `ort-wasm-simd-threaded.jsep.{mjs,wasm}` are already in `lib/`.

**The real cost driver is `best.onnx` at 640×640.** Verified input `[1,3,640,640]`, output
`[1,2]`. A 2-class classifier does not need a detector-sized input; 224 would be ~8× cheaper and
is already flagged at `onnx_inference.js:25`. Re-export via `train_cheating_yolo.py --imgsz 224`
→ `export_onnx.py`. Until then the classifier dominates every tick it runs in.

**Not errors** — `FULLSCREEN_EXIT` (the student did exit fullscreen) and `HEAD_POSE_GLANCE` at
LOW (a 1.5–2.5 s look-away, recorded not escalated, exactly as §6 specifies).

**⚠ `best.onnx` cannot do eye tracking.** Its output is 2 numbers — P(cheating), P(normal).
There is no eye, iris or eyelid information in that tensor to extract. Eye tracking needs either
`gaze_roi.js` (`enableGaze: true`, works today, still carries the lighting/skin-tone weakness)
or a FaceMesh model to activate `gaze_landmarks.js` + `ear_veto.js`. Tests tell them apart:
`gaze_roi.test.js` proves the pixel path already refuses to emit a direction for a closed eye,
so re-enabling it does **not** reintroduce the closed-eyes-flagged defect.


### 2026-08-02 (c) — Cascading safeguard: universal EAR veto gate

**Why** — per-detector blink immunity does not compose. The classifier's containment and
`gaze_landmarks.js`'s pre-gate each solve the problem locally, but every future eye-dependent
detector has to re-earn the property. This puts one safeguard where no detector can route around
it.

**Where it went, and why there.** `reportViolation()` in `monitor.js` is the single choke point
every violation already flows through, so the allowlist is enforced in exactly one place and
future detectors inherit it unmodified. A wrapper around one model would not have done that.

**Added**
- `extension/content/vision/ear_veto.js` — `VETOABLE_VIOLATIONS`, `NEVER_VETOABLE`,
  `VETO_REASON`, `computeFaceEar`, `EarVetoGate` (`submitLandmarks`, `submitEar`, `evaluate`,
  `eyesVerifiablyClosed`, `telemetry`). Imports `eyeAspectRatio` + `LANDMARK_CONTRACT` from
  `gaze_landmarks.js` rather than re-deriving EAR.
- `extension/test/ear_veto.test.js` — 59 checks.

**Changed**
- `monitor.js` — gate consulted at the top of `reportViolation()`, **before** the cooldown is
  claimed (a vetoed violation must not burn its cooldown slot, or reopening the eyes a second
  later would be silently swallowed); landmarks fed once per frame from `poseResult.faceLandmarks`;
  `classifierCorroborates()` now withholds escalation when `eyesVerifiablyClosed()`;
  confirmed violations annotated `ear_confirmed` / `ear_check`; `window.getEarVetoState()`;
  gate reset in `resetAiDecisionState()`.
- `manifest.json` — `ear_veto.js` after `gaze_landmarks.js`, before `monitor.js`;
  `vision_integration.test.js` count 9 → 10 plus load-order.

**Tests** — **All 10 suites pass (568 checks).** Head-pose modules untouched.

**Design decisions worth knowing:**
- **Fail-open, deliberately.** A suppression exploit is a worse failure than the false positive
  the gate prevents. `eyesVerifiablyClosed()` is *not* the negation of "open" — it is false when
  we cannot tell, so callers inherit fail-open for free.
- **`min` of the two eyes, not the mean.** A mean lets one wide eye drag a genuine blink over
  the threshold. The cost — one eye shut suppresses gaze violations — is bounded to the
  gaze-only allowlist and made observable via `oneEyeClosedSamples` rather than hidden.
- **Unknown types are not vetoable.** New detectors opt in deliberately.

**⚠ INERT IN PRODUCTION.** `pose.onnx` is COCO-17 with no eyelid points, so
`poseResult.faceLandmarks` is always null and **every evaluate() currently fails open**. The
gate is correct, tested and a complete no-op until a 478-point FaceMesh ONNX is served. This is
the same blocker as entry (b); nothing here resolves it.

**Known follow-up**
1. Acquire/export FaceMesh-with-iris as ONNX, serve via `/api/model/`, decode to the 478-point
   contract, and populate `analyzeFrame().faceLandmarks`. That single step activates the veto
   *and* `gaze_landmarks.js` together.
2. Once live, watch `getEarVetoState().failedOpen` — high and rising means the safeguard is
   silently doing nothing.
3. `earThreshold: 0.20` is the spec's number for the **2-point** EAR form, not the 6-point
   Soukupová–Čech form. Measure it against real sessions before trusting it, and note that
   landmark-detector accuracy varies by demographic, so the fairness gate from entry (b) applies
   to the veto as well.


### 2026-08-02 (b) — Landmark geometry + EAR gate replaces pixel gaze

**Why** — the pixel engine (`gaze_roi.js`, same day) failed field testing on lighting, skin
tone and eyelash-shadow variance. That is a **fairness** failure before it is an accuracy one:
the variance is not evenly distributed across students, so coverage degrades unequally. It was
the exact risk logged as a release gate in the previous entry, and it materialised.

**The architectural fix.** Every quantity in the replacement is a **ratio of distances between
landmark coordinates**. A ratio of distances is invariant to illumination and pigmentation *by
construction*, so the failure mode cannot occur in this formulation — it is not tuned away, it
is absent. No `getImageData`, no contrast, no percentiles, no canvas.

**⚠ BLOCKED ON A MODEL WE DO NOT HAVE.** `pose.onnx` is `yolo11n-pose` → COCO-17 **body**
keypoints. Its only face points are NOSE / LEFT_EYE / RIGHT_EYE / LEFT_EAR / RIGHT_EAR — **one
point per eye**. No eyelid contour, no eye corners, no iris. `EAR = V/H` is therefore *not
computable* from the current pipeline, and neither is any iris-offset ratio. `gaze_landmarks.js`
consumes a **478-point MediaPipe FaceMesh-with-iris** set and is **inert until that model is
added**. Indices are declared in `LANDMARK_CONTRACT`.

**Never synthesise the missing landmarks from the eye centre.** A fabricated eyelid produces a
confident, principled-looking number containing no information — strictly worse than the pixel
method it replaces, because it is harder to distrust.

**Added**
- `extension/content/vision/gaze_landmarks.js` — `eyeAspectRatio`, `orientedGazeRatio`,
  `verticalIrisRatio`, `projectionRatio`, `analyzeEye`, `analyzeGazeLandmarks`,
  `classifyAbsolute`, `GazeLandmarkAnalyzer`, `LANDMARK_CONTRACT`, `GAZE_STATE`.
  Emits `SIDE_GAZE_PEEKING` (MEDIUM sustained / LOW glance, **never** CRITICAL).
- `extension/test/gaze_landmarks.test.js` — 63 checks on synthetic landmarks, so assertions are
  exact geometry rather than tolerance-fitting.

**Changed**
- `vision_engine.js` — `enableGaze: false`. The pixel path no longer constructs, so
  `GAZE_OFF_SCREEN` cannot fire. Module and tests **kept, not deleted**: one flag to flip back
  if the landmark route hits its own wall.
- `manifest.json` — `gaze_landmarks.js` after `gaze_roi.js`; `vision_integration.test.js` count
  8 → 9 plus its load-order contract.

**Tests** — **All 9 suites pass (506 checks).** The four head-pose modules remain untouched;
`PoseBaseline`, `TemporalSmoother` and `DwellGate` are consumed via a second instance as before.

**Two deviations from the brief, both documented in-file:**

1. **Projection, not the literal `Distance(P,A)/Distance(B,A)`.** A raw distance ratio is
   *unsigned*: an iris a few px off the corner axis inflates the numerator identically whether
   it drifted nasally or temporally, and an iris beyond the anchor reads as travel toward the
   far corner. The projection answers the question the ratio was meant to ask and stays correct
   under head roll. Same cost — one dot product.

2. **⚠ `orientedGazeRatio` overrides the spec's anchor choice, and this is the highest-risk
   part of the module.** "Inner" is nasal, so it sits on **opposite image sides for the two
   eyes**. Anchoring both at `inner` — as the formula literally reads — makes the two ratios
   increase in *opposite* image directions; averaging them cancels a real side-glance back to
   ≈0.5 and the detector reports CENTRE while the student stares at their notes. Both eyes are
   anchored at whichever corner has the smaller `x`, resolved **from the data**, never by
   hard-coding which eye to invert (which would break the moment a deployment mirrors the
   feed). Pinned by a test that asserts the two eyes agree.

**Also deviated:** the spec's absolute bands (0.35–0.65 neutral, <0.25 / >0.75 off-screen) are
required **in addition to** the calibrated per-student deviation, not instead of it. Absolute
thresholds alone repeat the defect `pose_geometry.js` §7 was written to prevent — resting iris
position genuinely differs between honest students. Requiring both is strictly more
conservative than either.

**Rule 2 could not be honoured as written.** "Zero computational cost" and "no raw pixel math"
are in tension: the only way to get landmarks without reading pixels ourselves is a model that
reads them for us. The *geometry* here is genuinely free (a handful of dot products per frame);
the landmark model is not, and it will be a fourth ONNX graph on a Tier B budget CLAUDE.md
already flags as at its ceiling. Run it on the face crop, not the full frame.

**Known follow-up — this is not shippable yet:**
1. Export/acquire FaceMesh-with-iris as ONNX, serve it via `/api/model/`, decode to the
   478-point contract, and wire `GazeLandmarkAnalyzer` into `vision_engine.analyzeFrame`.
2. Measure `earThreshold: 0.20` against real sessions. It is the spec's number for the 2-point
   EAR form, **not** the 6-point Soukupová–Čech form — do not import a threshold from that
   literature without rescaling.
3. Re-validate across skin and iris tones *and* eye shapes. Landmark geometry removes the
   pigmentation sensitivity of the pixel method, but landmark **detector accuracy** itself
   varies by demographic, so the fairness gate moves rather than disappears.


### 2026-08-02 — Eye gaze via ROI crop (no new model)

**Why** — head pose cannot see eye movement, which §4 already named as the gap the corner
challenge works around. The constraint was to add gaze *without* reviving the trained
classifier's defect of flagging closed eyes as cheating.

**The trap, and why it is not a hypothetical.** A darkness-centroid iris tracker reproduces that
exact bug: a shut lid's darkest feature is the lash line, it sits low in the box, and the
centroid therefore reads a closed eye as a downward gaze. The fix is structural, not
statistical — closed eyes yield UNKNOWN, and `DwellGate` cannot fire on unknowns.

**Added** `extension/content/vision/gaze_roi.js` — `analyzeEyeRegion`, `eyeRoiBoxes`,
`combineEyes`, `percentile`, `rgbaToGray`, `GazeSampler` (one `drawImage` + one `getImageData`
over a strip spanning both eyes), `GazeAnalyzer` (second `PoseBaseline` + `TemporalSmoother` +
`DwellGate`), `GAZE_V_TO_PITCH_SIGN`.

**Changed**
- `vision_engine.js` — `analyzeFrame()` now returns `gaze` alongside `pose`; new
  `_analyzeGaze()` (always called, even on unreadable frames, so the gate ages out correctly)
  and `setGazeSuppressed()`; `telemetry()` gained `gaze_ms` + `gaze`; `reset()` clears both.
  Guarded on the globals so a stale unpacked build degrades to gaze-off, not a load failure.
- `monitor.js` — `GAZE_OFF_SCREEN` (MEDIUM); `handleGazeEvents()`; suppression set **before**
  `analyzeFrame` so no ordered corner-gaze frame slips through; `window.getGazeState()`.
- `manifest.json` — `gaze_roi.js` between `pose_pipeline.js` and `detectors.js`.
- `vision_integration.test.js` — load-order contract, module count 7 → 8.

**Tests** — new `gaze_roi.test.js` (55 checks). **All 8 suites pass (443 checks).**

**Not touched** — the four head-pose modules. `PoseBaseline` and `DwellGate` are *consumed* via
a second instance, never modified.

**Found while building** — the contrast test originally used `p10/p90` and rejected the lash
line at the *contrast* stage rather than the shape stage. Same insensitivity would have
misread a genuine small or distant iris as a closed eye, silently costing coverage for exactly
the students hardest to read. Switched to `p05/p95`, which fixes both; pinned by a small-iris
test.

**Known follow-up** — every threshold here (`minIntensitySpread: 26`, `maxDarkAspectRatio: 3.0`,
`minInterocularPx: 45`, the `0.16`/`0.24` tolerance floors) is reasoned, not measured. They are
set conservatively — toward misses rather than false accusations — but they need calibrating
against logged `gaze` telemetry from real sessions, **across skin and iris tones**, before this
is relied on. Unequal coverage is a fairness failure even when it never produces a false
accusation.


### 2026-07-31 — Adaptive execution providers + high-precision phone engine

**Added** `extension/content/vision/runtime_profile.js` — async WebGPU probe, Tier A/B profiles,
`configureOrtEnv()`, `createSession()` with per-session WASM fallback, `resolveSessionInputSize()`
/ `clampInputSize()`.

**Changed**
- `onnx_inference.js` — provider chain and `ort.env` now come from the shared profile; the
  duplicated inline WebGPU probe is gone; added `getRuntimeProfileInfo()`.
- `vision_engine.js` — resolves the profile at `load()`, sizes buffers from the real graph
  shape, runs detection continuously, applies the phone gate, owns the `DetectionLatch`,
  richer `telemetry()`.
- `detectors.js` — added `PHONE_SHAPE_DEFAULTS`, `boxAspectRatio`, `evaluatePhoneShape`,
  `filterPhoneDetections`, `DetectionLatch`; `TimeSlicedScheduler` gained `minGapMs` (0 =
  continuous). Existing decoders untouched.
- `monitor.js` — tier-driven cadence (`proctorIntervalMs` / `proctorMinGapMs` /
  `classifierIntervalMs` are now `let`), `applyRuntimeProfile()`, phone path switched from
  `DwellGate` to latch-and-hold, `PHONE_DETECTED` state exposed via `window.getPhoneDetected()`.
- `manifest.json` — registered `content/vision/runtime_profile.js` before `onnx_inference.js`.
- `export_vision_models.py` — added `--dynamic`.

**Tests** — new `runtime_profile.test.js` (48 checks) and `phone_detection.test.js` (73 checks);
`vision_integration.test.js` updated for the new module and globals. **All 6 suites pass.**

**Not touched** — the four head-pose modules, verified by their suites still passing.

**Known follow-up** — `detect.onnx` is still exported static at 448, so Tier B logs the
unhonoured 320 cap and runs at 448 on CPU. Re-export (`--detect-imgsz 320`) to realise the
budget. Running two YOLO graphs every frame on a CPU-only laptop is the heaviest configuration
this codebase has ever had; watch `telemetry().detect_ms` and switch to
`new VisionEngine({ detectMode: 'sliced' })` if a deployment cannot hold it.

### 2026-07-31 — Corner-only active liveness challenge

**Added** `extension/content/liveness_challenge.js` — `FrozenPoseMonitor`,
`evaluateCornerResponse`, `assertCornerOnly`, `CornerTargetRenderer`,
`LivenessChallengeManager`, `CORNER_DIRECTIONS`/`CORNER_POSITIONS`, `SCREEN_LEFT_YAW_SIGN`.
Pure JS in the overlay layer; consumes existing yaw/pitch, adds no inference.

**Changed**
- `monitor.js` — new `LIVENESS_FAILED` violation type (CRITICAL); `initLivenessManager()`
  routes only `FAILED` into `reportViolation`; the manager is driven once per frame from
  `runProctorInference` right after the pose step, reset in `resetAiDecisionState()` and torn
  down in `stopProctoring()`; `LOOK_AWAY` suppressed while a challenge is up; widget shows
  "Quick check"; `liveness` added to `AI_CHEATING_POSE` metadata;
  `window.getLivenessState()` exported.
- `manifest.json` — `content/liveness_challenge.js` registered between `vision_engine.js` and
  `monitor.js`.
- `vision_integration.test.js` — asserts the new load-order contract.

**Tests** — new `liveness_challenge.test.js` (89 checks). **All 7 suites pass (348 checks).**

**Not touched** — the four head-pose modules. The look-away suppression is in monitor.js's
reporting layer; `pose_pipeline.js` and friends still run and gate unchanged.

**Deviations from the brief, and why** — both documented in §4:
1. The spec's `TOP-LEFT ⇒ Yaw < -12°` is inverted for this codebase's image-relative yaw. It
   is implemented as the student-relative direction the corner actually demands; the literal
   reading would flag compliant students as spoofers.
2. Pitch uses a 6° threshold rather than reusing 12°, because the vertical cue compresses.

### 2026-07-31 — 2-tiered anti-spoofing (Tier 1 pixel delta → corner challenge)

**Why** — a live test with an **OBS virtual camera showing a still image** was not flagged: it
only produced "Camera paused…". Root cause: the frozen-feed guard `return`ed above
`livenessManager.update()`, so an injected still was permanently invisible to the challenge
designed to catch it. The guard that prevented a false positive guaranteed a false negative.

**Changed**
- `liveness_challenge.js` — added `SyntheticFrameMonitor` (Tier 1), `LivenessTrigger`,
  `forceChallenge()`, `forcedRechallengeMs`; `update()` takes a third `pixelDelta` argument;
  outcomes carry `trigger` + `synthetic_confirmed`; a pass resets the suspicion monitor.
- `monitor.js` — `analyzeFrameChange()` computes hash **and** mean-abs pixel delta in one pass
  (`frameSignature` kept as a wrapper); the stale-frame guard now always advances the liveness
  clock and no longer skips inference while a challenge is open or suspicion is raised; new
  `CAMERA_FEED_SYNTHETIC` CRITICAL violation reported *instead of* `LIVENESS_FAILED` on a
  synthetic-triggered failure; `_hasPrevFrame` reset per session.

**Design constraint honoured** — Tier 1 has **no route to a violation**. Benign causes of zero
pixel delta (3D noise reduction, decoder frame duplication, VM display drivers) are
indistinguishable from spoofing at the pixel level, so it can only request a challenge.

**Tests** — `liveness_challenge.test.js` grew to 125 checks, including the innocent
frozen-driver path (passes, never flagged) and the OBS-static path (fails, confirmed
synthetic). **All 7 suites pass (384 checks).** Head-pose modules still untouched.

**Deviation** — the brief said "inside the media worker". There is no media worker; all frame
processing runs on the content script's main thread, and adding one would be a large
architectural change for no gain here (the delta reuses an existing `getImageData`). Implemented
in the existing per-frame path in `monitor.js`.

**Known follow-up** — the 1.0°/45 s frozen trigger is calibrated against
`ratioToApproxDegrees`, whose `RATIO_TO_DEG = 60` constant is explicitly "empirical and
deliberately coarse". The threshold is sound for detecting a *static image* (range is ~0 there,
orders of magnitude clear of the bar), but if it ever needs tightening toward real human
micro-movement, recalibrate against logged `frozen_yaw_range_deg` telemetry rather than
guessing — and do not change `RATIO_TO_DEG` itself, which the pose modules own.

// =============================================================================
// MCQQuizModal — a real exam, proctored live. Replaces SandboxQuiz.
//
// The sandbox asked visitors to perform actions at a checklist. This asks them
// to sit an exam and lets the proctoring happen around them, which is the only
// way to show what the product actually feels like: the prompts are inline cues
// beside a question, not instructions from a wizard.
//
// ⚠ THE CAMERA STARTS ON A CLICK, NEVER ON MOUNT. `useProctorDemo.start()` is
// gesture-invoked by contract, and opening straight into a live camera would
// make consent invisible on a page whose entire argument is that this product is
// honest about what it does.
//
// ⚠ TEARDOWN IS DRIVEN BY UNMOUNT. App renders this conditionally, so closing it
// runs the hook's ordered cleanup: engine.stop() (closing the FaceLandmarker and
// its WASM heap) -> cancel the paint loop -> stop tracks then null srcObject ->
// revoke object URLs -> clearDemoSessionData() -> drop frame state. `stopGuestQuiz`
// is called first so the extension stops relaying before that runs.
// =============================================================================

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { usePaintLoop } from '../../hooks/usePaintLoop.js';
import { useProctorDemo, DEMO_STATUS } from '../../hooks/useProctorDemo.js';
import { useExtensionBridge } from '../../hooks/useExtensionBridge.js';
import CameraStage from '../ProctorDemo/CameraStage.jsx';
import DemoFallback from '../ProctorDemo/DemoFallback.jsx';
import EvidencePanel from './EvidencePanel.jsx';

const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

/** A short sitting — long enough to feel like an exam, short enough to finish. */
const EXAM_SECONDS = 5 * 60;

/** Where to send someone who does not have the extension. Store root rather
 *  than a listing path: the add-on is not published, and a fabricated listing
 *  URL is a dead link that looks live. */
const EDGE_ADDONS_URL = 'https://microsoftedge.microsoft.com/addons';

/**
 * ⚠ THE CUES ARE INVITATIONS, NOT INSTRUCTIONS TO CHEAT.
 *
 * Each one names a detector and asks the visitor to trigger it deliberately, so
 * what they see afterwards is a system reacting to something they know they did.
 * That is the difference between a demo and an accusation. Q1 has no cue on
 * purpose: the first minute is calibration, and a clean baseline is what every
 * later verdict is measured against.
 */
const QUESTIONS = [
  {
    id: 'q1',
    prompt: 'A dataset has mean 50 and standard deviation 0. What can you conclude?',
    options: [
      'The values are evenly spread around 50.',
      'Every value in the dataset is exactly 50.',
      'The dataset contains exactly one value.',
      'The mean was computed incorrectly.',
    ],
    answer: 1,
    cue: null,
  },
  {
    id: 'q2',
    prompt: 'In a binary search over a sorted array of n elements, the worst-case number of comparisons grows as:',
    options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
    answer: 1,
    cue: 'Try looking away from the screen for about 3 seconds — head pose and iris position are tracked separately.',
  },
  {
    id: 'q3',
    prompt: 'Which property makes a hash function suitable for a hash table?',
    options: [
      'It is reversible.',
      'It distributes keys uniformly across buckets.',
      'It always returns a prime number.',
      'It is slow enough to resist brute force.',
    ],
    answer: 1,
    cue: 'Try holding up a smartphone — this one needs the extension\'s 2nd-layer ONNX object detector.',
    extensionOnly: true,
  },
  {
    id: 'q4',
    prompt: 'A function is idempotent when:',
    options: [
      'It returns the same type it accepts.',
      'Calling it twice has the same effect as calling it once.',
      'It has no return value.',
      'It never throws.',
    ],
    answer: 1,
    cue: 'Try stepping out of frame, or have someone lean in — both answer the same question: is exactly one person present?',
  },
];

function formatClock(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** One row of the proctoring HUD. Null renders as an em-dash, never as 0. */
function HudRow({ label, value, tone = 'text-slate-200' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-800/70 py-1.5 last:border-0">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className={`tnum font-mono text-xs ${tone}`}>
        {value === null || value === undefined
          ? <span className="text-unknown">—</span>
          : value}
      </dd>
    </div>
  );
}

/**
 * @param {{onClose: () => void}} props
 */
export default function MCQQuizModal({ onClose }) {
  const paintLoop = usePaintLoop();
  const demo = useProctorDemo({ paintLoop });
  const bridge = useExtensionBridge();

  const [started, setStarted] = useState(false);
  const [remaining, setRemaining] = useState(EXAM_SECONDS);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const dialogRef = useRef(null);
  const titleId = useId();

  const busy = demo.status === DEMO_STATUS.REQUESTING_CAMERA
    || demo.status === DEMO_STATUS.LOADING_MODEL;

  // ---- close ---------------------------------------------------------------
  const handleClose = useCallback(() => {
    // Stop the extension relaying BEFORE unmount tears the engine down, so no
    // violation arrives for a session that no longer exists.
    bridge.stopGuestQuiz();
    onClose();
  }, [bridge, onClose]);

  // ---- Esc + focus trap ----------------------------------------------------
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return undefined;

    const previouslyFocused = document.activeElement;
    node.querySelector(FOCUSABLE)?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE))
        .filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      node.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [handleClose]);

  // ---- countdown -----------------------------------------------------------
  // The setState lives in the interval callback, not the effect body — an
  // effect that sets state synchronously is the cascading-render pattern the
  // compiler rule forbids.
  useEffect(() => {
    if (!started || submitted) return undefined;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          // Time is up: the paper is collected whether or not it is finished.
          setSubmitted(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [started, submitted]);

  // ---- start ---------------------------------------------------------------
  const handleStart = useCallback(async () => {
    await demo.start();
    if (bridge.extensionDetected) {
      // Awaited: this resolves an anonymous Supabase session and hands the
      // extension a token. Firing it un-awaited would let the first violations
      // arrive before the extension knows where it may write them.
      await bridge.startGuestQuiz();
    }
    setStarted(true);
  }, [demo, bridge]);

  // ---- merged evidence -----------------------------------------------------
  const allViolations = useMemo(() => {
    const combined = [
      // `wallTime` is stamped by useProctorDemo at capture time — both streams
      // are therefore on the same epoch and this sort is meaningful.
      ...demo.violations.map((v) => ({ ...v, source: 'browser' })),
      ...bridge.extensionViolations,
    ];
    combined.sort((a, b) => (b.wallTime ?? 0) - (a.wallTime ?? 0));
    return combined;
  }, [demo.violations, bridge.extensionViolations]);

  const answered = Object.keys(answers).length;
  const score = submitted
    ? QUESTIONS.filter((q) => answers[q.id] === q.answer).length
    : null;

  const lowTime = remaining <= 30;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-base">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex h-full flex-col">

        {/* ---- exam chrome ---- */}
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold text-slate-100">
              Foundations of Computing — Practice Assessment
            </h2>
            <p className="text-[11px] text-slate-500">
              4 questions · answers are not recorded anywhere
            </p>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div
              className={`tnum rounded-md px-3 py-1.5 font-mono text-sm font-semibold ${
                lowTime ? 'bg-violation/15 text-violation' : 'bg-slate-800/80 text-slate-200'
              }`}
              role="timer"
              aria-live="off"
            >
              {formatClock(remaining)}
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
            >
              Exit exam
            </button>
          </div>
        </header>

        {/* ---- extension banner ---- */}
        <div className="px-4 pt-3 sm:px-6">
          {bridge.extensionDetected === null ? (
            <div className="rounded-md border border-slate-700 bg-surface px-4 py-2 text-sm text-slate-300">
              Checking for the AI Observer extension…
            </div>
          ) : bridge.extensionDetected ? (
            <div className="rounded-md border border-verified/30 bg-verified/10 px-4 py-2 text-sm text-verified">
              Extension Connected ✓ (2-Layer ONNX Phone Detector Active)
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-glance/30 bg-glance/10 px-4 py-2 text-sm text-glance">
              <span>
                Install AI Observer extension on Microsoft Edge for full phone
                detection. Running browser-only MediaPipe engine — gaze, head
                pose, face count and absence still work.
              </span>
              <a
                href={EDGE_ADDONS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline hover:text-glance-dim"
              >
                Edge Add-ons
              </a>
            </div>
          )}
        </div>

        {/* ---- 70 / 30 ---- */}
        <div className="grid min-h-0 flex-1 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">

          {/* ================= LEFT: the exam ================= */}
          <div className="min-h-0 overflow-y-auto pr-1">
            {!started ? (
              <div className="grid h-full place-items-center rounded-card border border-slate-800 bg-surface-raised/60 p-8 text-center">
                <div className="max-w-md">
                  <h3 className="text-xl font-semibold text-slate-100">Ready to begin?</h3>
                  <p className="mt-3 text-sm leading-relaxed text-slate-400">
                    This is a real proctoring session running entirely on your
                    device. The camera stops the moment you exit, and the
                    evidence it captures is deleted with it. Your answers are
                    never sent anywhere.
                  </p>
                  <button
                    type="button"
                    onClick={handleStart}
                    disabled={busy}
                    className="beam mt-6 rounded-lg bg-verified px-6 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-verified disabled:opacity-50"
                  >
                    {busy ? 'Starting…' : 'Enable camera and begin'}
                  </button>
                  {demo.status === DEMO_STATUS.ERROR ? (
                    <div className="mt-6 text-left">
                      <DemoFallback errorCode={demo.errorCode} onRetry={demo.restart} />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : submitted ? (
              <div className="grid h-full place-items-center rounded-card border border-slate-800 bg-surface-raised/60 p-8 text-center">
                <div>
                  <h3 className="text-xl font-semibold text-verified">Paper submitted</h3>
                  <p className="tnum mt-3 font-mono text-3xl text-slate-100">
                    {score} / {QUESTIONS.length}
                  </p>
                  <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-400">
                    {allViolations.length === 0
                      ? 'Nothing was flagged during this sitting. An empty evidence stream is the expected result — the system reports what it measured, and it measured nothing worth reporting.'
                      : `${allViolations.length} ${allViolations.length === 1 ? 'incident was' : 'incidents were'} recorded. Each one is in the stream beside you, with the frame that triggered it.`}
                  </p>
                </div>
              </div>
            ) : (
              <ol className="flex flex-col gap-4">
                {QUESTIONS.map((q, index) => {
                  const cueUnavailable = q.extensionOnly && !bridge.extensionDetected;
                  return (
                    <li key={q.id} className="rounded-card border border-slate-800 bg-surface-raised/50 p-5">
                      <fieldset>
                        <legend className="text-sm font-medium text-slate-100">
                          <span className="tnum mr-2 font-mono text-slate-500">
                            Q{index + 1}.
                          </span>
                          {q.prompt}
                        </legend>

                        <div className="mt-4 flex flex-col gap-2">
                          {q.options.map((option, optionIndex) => {
                            const id = `${q.id}-${optionIndex}`;
                            const checked = answers[q.id] === optionIndex;
                            return (
                              <label
                                key={id}
                                htmlFor={id}
                                className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm transition ${
                                  checked
                                    ? 'border-verified/50 bg-verified/10 text-slate-100'
                                    : 'border-slate-800 text-slate-300 hover:border-slate-600'
                                }`}
                              >
                                <input
                                  type="radio"
                                  id={id}
                                  name={q.id}
                                  value={optionIndex}
                                  checked={checked}
                                  onChange={() => setAnswers((a) => ({ ...a, [q.id]: optionIndex }))}
                                  className="mt-0.5 accent-[var(--color-verified)]"
                                />
                                <span>{option}</span>
                              </label>
                            );
                          })}
                        </div>

                        {q.cue ? (
                          <p className={`mt-4 border-l-2 pl-3 text-xs leading-relaxed ${
                            cueUnavailable
                              ? 'border-slate-700 text-slate-600'
                              : 'border-glance/50 text-slate-400'
                          }`}>
                            <span className="font-medium text-glance">While you answer: </span>
                            {q.cue}
                            {cueUnavailable ? (
                              <span className="mt-1 block text-slate-600">
                                Needs the extension — this cue is inactive in browser-only mode.
                              </span>
                            ) : null}
                          </p>
                        ) : null}
                      </fieldset>
                    </li>
                  );
                })}

                <li className="flex items-center gap-4 pt-1">
                  <button
                    type="button"
                    onClick={() => setSubmitted(true)}
                    className="rounded-lg bg-verified px-6 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
                  >
                    Submit paper
                  </button>
                  <span className="tnum font-mono text-xs text-slate-500">
                    {answered} / {QUESTIONS.length} answered
                  </span>
                </li>
              </ol>
            )}
          </div>

          {/* ================= RIGHT: proctoring HUD + evidence ================= */}
          <aside className="flex min-h-0 flex-col gap-4">
            <CameraStage
              videoRef={demo.videoRef}
              frameStateRef={demo.frameStateRef}
              paintLoop={paintLoop}
              isRunning={demo.isRunning}
              isPaused={demo.isPaused}
              cpuMode={demo.cpuMode}
              lowFps={demo.lowFps}
              fps={demo.readout.fps}
            />

            <section aria-label="AI Observer proctoring status" className="glass rounded-card p-4">
              <h3 className="mb-2 text-xs font-medium tracking-wide text-slate-400 uppercase">
                AI Observer — Proctoring Status
              </h3>
              <dl>
                <HudRow
                  label="Session"
                  value={demo.isRunning ? 'monitoring' : demo.isPaused ? 'paused' : 'not started'}
                  tone={demo.isRunning ? 'text-verified' : 'text-slate-400'}
                />
                <HudRow
                  label="Detection layers"
                  value={bridge.extensionDetected ? '2 (MediaPipe + ONNX)' : '1 (MediaPipe)'}
                  tone={bridge.extensionDetected ? 'text-verified' : 'text-glance'}
                />
                <HudRow
                  label="Calibration"
                  value={demo.readout.calibrated
                    ? 'complete'
                    : demo.isRunning
                      ? `${Math.round((demo.readout.calibrationProgress ?? 0) * 100)}%`
                      : null}
                />
                <HudRow label="Faces in frame" value={demo.isRunning ? demo.readout.faceCount : null} />
                {/* null, never 0 — an unreadable EAR is not a measurement of
                    closed eyes. */}
                <HudRow
                  label="Eye aspect ratio"
                  value={demo.readout.ear === null ? null : demo.readout.ear.toFixed(3)}
                />
                <HudRow
                  label="Frame rate"
                  value={demo.readout.fps === null ? null : `${demo.readout.fps} fps`}
                />
                <HudRow
                  label="Incidents"
                  value={allViolations.length}
                  tone={allViolations.length > 0 ? 'text-violation' : 'text-verified'}
                />
              </dl>
            </section>

            <div className="min-h-0 flex-1 rounded-card border border-slate-800 bg-surface-raised/40 p-4">
              <EvidencePanel violations={allViolations} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

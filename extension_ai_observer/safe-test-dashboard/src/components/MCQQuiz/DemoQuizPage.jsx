// =============================================================================
// DemoQuizPage — signed-in practice assessment (/demo-quiz).
//
// 5-Question Practice Assessment proctored live by AI Observer.
//
// ⚠ THIS PAGE IS NO LONGER REACHABLE ANONYMOUSLY, AND ITS COPY SAYS SO.
// It used to open on page load for anybody and labelled the result "Anonymous
// Guest Session". `App.jsx` now renders it only inside `<DemoGate>`, which
// requires a session verified by Google or by the emailed code. This component
// does NOT re-check that — one gate, in one place — but it must never be
// mounted outside it, because its mount effect opens the camera.
//
// The identity shown below is display only. Authorisation happened at the gate
// and is re-enforced by RLS on every upload.
// =============================================================================

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { VISION_STATUS, useExtensionBridge } from '../../hooks/useExtensionBridge.js';
import { useAuth } from '../../lib/auth/useAuth.js';
import { createReviewBudget, reviewFlaggedSnapshot } from '../../lib/ai/snapshotReview.js';
import { wrapReviewFlaggedSnapshot } from '../../lib/telemetry/index.js';
import { navigate } from '../../lib/route.js';
import EvidencePanel from './EvidencePanel.jsx';

const instrumentedReviewFlaggedSnapshot = wrapReviewFlaggedSnapshot(reviewFlaggedSnapshot);

const EXAM_SECONDS = 5 * 60;

/**
 * Extension violation types that pause the exam behind the overlay.
 *
 * Deliberately only the two focus-loss types. A gaze or phone violation must NOT
 * veil the paper: those fire while the candidate is sitting right there working,
 * and covering the questions over one glance away would make the demo unusable —
 * and, in a real exam, would be a proctoring tool obstructing the assessment it
 * exists to observe.
 */
const PAUSE_VIOLATION_TYPES = new Set(['WINDOW_BLUR', 'VISIBILITY_HIDDEN']);

/** Continuous compliant time required before the overlay lifts itself. */
const RESUME_DELAY_MS = 2000;

/** Where to acquire the extension. */
const EDGE_ADDONS_URL = 'https://microsoftedge.microsoft.com/addons';

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
    cue: 'Try looking away from the screen for about 3 seconds — head pose and iris position are tracked separately by AI Observer.',
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
    cue: 'Try holding up a smartphone — this triggers AI Observer\'s 2nd-layer ONNX object detector.',
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
    cue: 'Try stepping out of frame, turning your head, or having someone lean in — each produces a real-time evidence snapshot.',
  },
  {
    id: 'q5',
    prompt: 'In software engineering, what does the acronym "API" stand for?',
    options: [
      'Automated Program Integration',
      'Application Programming Interface',
      'Advanced Process Instruction',
      'Array Performance Index',
    ],
    answer: 1,
    cue: 'Try covering your camera or leaning far to the side to see a posture or visibility incident snapshot.',
  },
];

function formatClock(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Diagnostic HUD row. */
function HudRow({ label, value, tone = 'text-slate-200' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-800/70 py-1.5 last:border-0">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className={`tnum font-mono text-xs ${tone}`}>
        {value === null || value === undefined ? <span className="text-unknown">—</span> : value}
      </dd>
    </div>
  );
}

export default function DemoQuizPage() {
  const bridge = useExtensionBridge();
  const { user, profile } = useAuth();
  const candidateEmail = user?.email ?? null;
  const candidateName = profile?.full_name
    ?? user?.user_metadata?.full_name
    ?? user?.user_metadata?.name
    ?? null;

  const [remaining, setRemaining] = useState(EXAM_SECONDS);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenWarning, setFullscreenWarning] = useState(false);
  // Focus loss blurs the paper. Cleared only by an explicit click, so the
  // candidate cannot tab away, read something, and tab back to an already-clear
  // screen — the acknowledgement is the point, not the blur itself.
  const [focusLost, setFocusLost] = useState(false);

  // ---- AI review of flagged frames ----
  //
  // ⚠ A REF, NOT STATE, AND NOT A MODULE CONSTANT.
  //
  // State would re-render the exam on every budget change, for a number the
  // candidate must never see. A module-level counter would survive a re-entry
  // into /demo-quiz and hand the second sitting a budget already spent by the
  // first — which presents as "the AI review stopped working", with nothing in
  // any log to explain it. The budget belongs to the sitting, so it lives as
  // long as this component and no longer.
  const reviewBudgetRef = useRef(createReviewBudget());
  // A single in-flight guard. Violations arrive in bursts (a phone episode
  // refreshes its hold for seconds), and without this a burst would fire three
  // concurrent uploads that each read the budget as 0-used and spend the whole
  // sitting's allowance on one incident.
  const reviewInFlightRef = useRef(false);
  // Non-null only when the pipeline itself is misconfigured — never when a frame
  // was simply not flagged. See the banner note in EvidencePanel.
  const [reviewUnavailable, setReviewUnavailable] = useState(null);

  const containerRef = useRef(null);
  // Tracks the PREVIOUS fullscreen state so the warning fires on a genuine
  // exit, not on the initial windowed render (where nobody has left anything).
  const wasFullscreenRef = useRef(false);
  const titleId = useId();

  // ---- start guest session on mount ----
  //
  // ⚠ DEPEND ON THE CALLBACKS, NEVER ON `bridge`.
  //
  // `useExtensionBridge` returns a fresh object literal on every render, so
  // `[bridge]` made this a per-RENDER effect rather than a mount effect. With a
  // 1 Hz countdown re-rendering the page, the cleanup and the body ran once a
  // second: stop proctoring, delete the visitor's uploaded snapshots, clear the
  // evidence list, then start the whole vision stack again — camera reopened and
  // ONNX sessions rebuilt every tick. The HUD could never accumulate evidence,
  // because the list was wiped a second after anything landed in it.
  // Both callbacks are stable (see the hook), so this now runs exactly once.
  const { startGuestQuiz, stopGuestQuiz } = bridge;
  useEffect(() => {
    // Fullscreen is requested BEFORE the guest session starts, so the vision
    // pipeline initialises against the viewport the exam will actually run in.
    //
    // ⚠ THIS CAN LEGITIMATELY FAIL, AND THAT IS NOT AN ERROR STATE.
    // requestFullscreen() needs transient user activation, which does NOT
    // survive the navigation into /demo-quiz — so on a cold entry it rejects.
    // The rejection is caught and converted into the SAME soft warning any other
    // route out of fullscreen raises, which carries a click that does have
    // activation. Proctoring must start either way: refusing to start because
    // the browser withheld fullscreen would mean a candidate who declines it is
    // simply not monitored, which is worse than a windowed session.
    const el = document.documentElement;
    Promise.resolve()
      .then(() => (el.requestFullscreen ? el.requestFullscreen() : Promise.reject()))
      .catch(() => setFullscreenWarning(true))
      .finally(() => { startGuestQuiz(); });

    return () => {
      stopGuestQuiz();
    };
  }, [startGuestQuiz, stopGuestQuiz]);

  // ---- full screen handling ----
  const exitFullscreenMode = useCallback(async () => {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Ignore exit errors
    }
  }, []);

  // Leaving fullscreen is a SOFT event: it raises a warning and nothing else.
  // The proctoring loop is owned by the extension and keeps running regardless —
  // this only reflects the state and tells the visitor what happened.
  useEffect(() => {
    const handleFsChange = () => {
      const active = !!document.fullscreenElement;
      setIsFullscreen(active);
      if (!active && wasFullscreenRef.current) setFullscreenWarning(true);
      wasFullscreenRef.current = active;
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // ---- exit exam ----
  // Same rule as the mount effect: `bridge` is a new object each render, and
  // keying this on it re-created `handleExit` every second, which in turn
  // rebound the keydown listener below every second.
  const handleExit = useCallback(async () => {
    await stopGuestQuiz();
    await exitFullscreenMode();
    navigate('/');
  }, [stopGuestQuiz, exitFullscreenMode]);

  // ---- Esc key handling ----
  //
  // ⚠ ESC MUST NOT END THE SESSION.
  //
  // This previously called handleExit() whenever Escape was pressed outside
  // fullscreen — so the single keystroke a browser ALREADY uses to leave
  // fullscreen tore down the whole demo. Chrome clears `document.fullscreenElement`
  // before dispatching the keydown, so one press could satisfy the guard and
  // navigate away, which is the opposite of "warn without breaking the loop".
  // Leaving is now an explicit action on the Exit button only; Escape raises the
  // same soft warning as any other route out of fullscreen.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !document.fullscreenElement) {
        setFullscreenWarning(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---- focus loss → blur the paper ----
  //
  // The extension records the violation and captures the screen frame; this is
  // purely the candidate-facing half. Blurring on `blur` as well as on
  // visibilitychange matters because switching to another WINDOW (rather than
  // another tab) fires only the former, and that is the case where the exam
  // stays fully visible on screen next to whatever was opened over it.
  useEffect(() => {
    const onHide = () => { if (document.hidden) setFocusLost(true); };
    const onBlur = () => setFocusLost(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ---- the EXTENSION's verdict also raises the overlay ----
  //
  // The DOM listeners above see only what this document sees. The extension sees
  // more: it owns the focus-loss coalescer and reports WINDOW_BLUR /
  // VISIBILITY_HIDDEN after its own debounce, on evidence this page does not have
  // (screen-share frames, its own timers). Driving the same `focusLost` state
  // from both keeps ONE overlay with one dismissal path — a second, independent
  // "paused" flag would let the two disagree and strand the candidate behind a
  // veil neither of them owns.
  //
  // Idempotent by construction: setting `true` when already `true` is a no-op, so
  // an extension event arriving after the DOM event costs nothing.
  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (msg?.type !== 'SAFETEST_GUEST_VIOLATION') return;
      if (PAUSE_VIOLATION_TYPES.has(msg.violationType)) setFocusLost(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ---- flagged frame → second opinion from the model ----
  //
  // ⚠ THE ON-DEVICE DETECTOR RAISES THE FLAG; THE MODEL ONLY GRADES IT.
  //
  // This never initiates a capture. It reacts to a violation the extension has
  // already confirmed through its own gates (the 3-of-5 phone window, the 2.2 s
  // pose dwell, the EAR veto), and asks a second, independent reader whether the
  // frame actually supports the claim. That ordering is what keeps the API cost
  // bounded by the detector's own precision rather than by how long the exam is.
  //
  // ⚠ WHAT IS DELIBERATELY NOT DONE WITH THE ANSWER: it is not rendered, not
  // counted on screen, and not fed back into anything the candidate can observe.
  // The only visible consequence during the sitting is nothing at all.
  //
  // The 3-per-sitting cap and the >= 95% early stop are ENFORCED SERVER-SIDE.
  // `reviewBudgetRef` mirrors the server's count so an exhausted page stops
  // uploading webcam frames it already knows will be refused; it is not the
  // control, and editing it in devtools buys nothing.
  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (msg?.type !== 'SAFETEST_GUEST_VIOLATION') return;

      const image = msg.snapshotB64;
      if (!image) return;                       // nothing to review
      if (!bridge.guestSessionId) return;       // no verified session, no upload
      if (!bridge.sittingId) return;            // no sitting open, nothing to charge
      if (reviewBudgetRef.current.closed) return;
      if (reviewInFlightRef.current) return;

      reviewInFlightRef.current = true;
      void instrumentedReviewFlaggedSnapshot({
        budget: reviewBudgetRef.current,
        // ⚠ THE SITTING ID, NOT THE UID. This used to send
        // `bridge.guestSessionId`, which IS `auth.uid()`, on the stated
        // reasoning that it "dies with the page". It does not — it is the
        // account id and is constant for the life of the account — so the
        // server's "3 reviewed frames per sitting" was really 3 per student
        // ever, and a candidate's second sitting found the budget spent with
        // nothing in any log explaining why the review had stopped. The uid is
        // still what the Edge Function charges and files under; it comes from
        // the caller's own token there, never from this body.
        demoSessionId: bridge.sittingId,
        violationType: msg.violationType,
        severity: msg.severity ?? null,
        imageBase64: image,
      })
        .then((result) => {
          // ⚠ ONLY A CONFIGURATION FAULT IS SURFACED. A refused review, an
          // exhausted budget or a NOT_CHEATING verdict are all normal and must
          // stay invisible; a deployment with no GEMINI_API_KEY looks identical
          // to a clean session unless it is named.
          if (!result.ok && (result.reason === 'GEMINI_NOT_CONFIGURED' || result.reason === 'CALL_FAILED')) {
            setReviewUnavailable(result.reason);
          } else if (result.ok) {
            setReviewUnavailable(null);
          }
        })
        .finally(() => {
          reviewInFlightRef.current = false;
        });
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // Re-bound when the sitting changes as well as when the session does: the
    // handler closes over `bridge.sittingId`, and a listener left holding the
    // previous sitting's id would charge sitting two's frames to sitting one.
  }, [bridge.guestSessionId, bridge.sittingId]);

  // ---- automatic recovery ----
  //
  // Resume once the candidate is genuinely back: focused, visible AND in
  // fullscreen, held continuously for RESUME_DELAY_MS.
  //
  // ⚠ THE DELAY IS RESTARTED BY ANY LAPSE, NOT PAUSED. `compliant` is re-evaluated
  // on every relevant event, and one failing check clears the pending timer, so
  // two 1.9 s visits cannot add up to a resume. Nothing auto-resumes while the
  // candidate is still away.
  //
  // ⚠ THE MANUAL BUTTON STAYS. Fullscreen is a REQUIREMENT of this path, so a
  // candidate who never entered it — or whose browser refuses it — would other-
  // wise sit behind the overlay forever with no way out. Auto-recovery is the
  // convenience; the click is the guarantee.
  useEffect(() => {
    if (!focusLost) return undefined;

    let timer = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

    const evaluate = () => {
      const compliant = document.hasFocus()
        && !document.hidden
        && !!document.fullscreenElement;

      if (!compliant) { cancel(); return; }
      if (timer) return;   // already counting down — do not restart on re-entry
      timer = setTimeout(() => {
        timer = null;
        setFocusLost(false);
      }, RESUME_DELAY_MS);
    };

    evaluate();
    window.addEventListener('focus', evaluate);
    window.addEventListener('blur', evaluate);
    document.addEventListener('visibilitychange', evaluate);
    document.addEventListener('fullscreenchange', evaluate);
    return () => {
      cancel();
      window.removeEventListener('focus', evaluate);
      window.removeEventListener('blur', evaluate);
      document.removeEventListener('visibilitychange', evaluate);
      document.removeEventListener('fullscreenchange', evaluate);
    };
  }, [focusLost]);

  // ---- countdown timer ----
  useEffect(() => {
    if (submitted) return undefined;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          setSubmitted(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [submitted]);

  // ⚠ `bridge.extensionViolations` IS DELIBERATELY NOT READ HERE ANY MORE.
  //
  // This page used to merge, sort and render that list, and derive a live
  // "INCIDENT ACTIVE" reading from `bridge.liveStatus`. Both were removed on
  // 2026-08-16: they told the candidate, during the exam, exactly what the
  // detector had just concluded about them, which is a labelled feedback loop
  // for evading it. The hook still maintains the list — it is what drives the
  // focus-loss overlay and the AI review above — it is simply never displayed.
  //
  // Strict equality on the vision status, never a falsy check: `null` means
  // "still loading", and treating it as offline would flash the fault banner on
  // every entry. This one stays visible because it reports the health of the
  // proctoring stack, not a finding about the person.
  const visionOffline = bridge.visionStatus === VISION_STATUS.OFFLINE;

  const answeredCount = Object.keys(answers).length;
  const score = submitted ? QUESTIONS.filter((q) => answers[q.id] === q.answer).length : null;
  const lowTime = remaining <= 30;

  return (
    <div ref={containerRef} className="fixed inset-0 z-50 flex flex-col bg-base text-slate-100 font-sans">
      {/* ---- Header Chrome ---- */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-surface/80 px-4 py-3 sm:px-6 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          <img
            src="/brand/logo-transparent.png"
            alt="Procminds"
            className="h-6 w-auto shrink-0 drop-shadow-[0_0_8px_rgba(0,210,255,0.4)]"
          />
          <div className="min-w-0">
            <h1 id={titleId} className="truncate text-sm sm:text-base font-semibold text-slate-100">
              Foundations of Computing — Practice Assessment (5 Questions)
            </h1>
            <p className="text-[11px] text-slate-500 truncate">
              {candidateName || candidateEmail || 'Signed-in session'}
              {' · '}Proctored by AI Observer Browser Extension
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3 shrink-0">
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
            onClick={handleExit}
            className="rounded-md border border-slate-700 bg-surface-raised/50 px-3.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
          >
            Exit Exam
          </button>
        </div>
      </header>

      {/* ---- Extension Detection & Status Banner ---- */}
      <div className="px-4 pt-3 sm:px-6">
        {bridge.extensionDetected === null ? (
          <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-surface px-4 py-2 text-xs sm:text-sm text-slate-300">
            <span className="h-2 w-2 animate-ping rounded-full bg-cyan-400" />
            Connecting to AI Observer extension…
          </div>
        ) : bridge.extensionDetected ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-verified/30 bg-verified/10 px-4 py-2 text-xs sm:text-sm text-verified">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-verified animate-pulse" />
              <span className="font-semibold">AI Observer Extension Connected</span>
              <span className="hidden sm:inline text-slate-400">|</span>
              <span className="hidden sm:inline text-slate-300 text-xs">2-Layer ONNX Object Detector &amp; Gaze Telemetry Active</span>
            </div>
            <span className="rounded bg-verified/20 px-2 py-0.5 text-[11px] font-mono text-verified uppercase">
              Proctoring Active
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs sm:text-sm text-amber-200">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span>
                <strong>AI Observer Extension Required:</strong> Please install or enable the browser extension to complete the full computer-vision live demo.
              </span>
            </div>
            <a
              href={EDGE_ADDONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded bg-amber-500/20 px-3 py-1 text-xs font-semibold text-amber-300 underline hover:bg-amber-500/30"
            >
              Get Extension
            </a>
          </div>
        )}
      </div>

      {/* ---- Proctoring refused for want of a verified session ----
           ⚠ NOT AN ADVISORY, AND NOT DISMISSIBLE. Every other banner on this
           page describes a degraded-but-running session; this one means the
           proctoring stack never started. In a product that accuses people of
           misconduct, "nothing is watching" must never be presented in the same
           register as "your window is not fullscreen". It should be unreachable
           — DemoGate stops this page mounting unverified — so if it is on
           screen, the gate has been bypassed and that is worth saying loudly. */}
      {bridge.blockedReason ? (
        <div className="px-4 pt-3 sm:px-6">
          <div
            role="alert"
            className="rounded-md border border-violation/50 bg-violation/10 px-4 py-2.5 text-xs sm:text-sm text-violation"
          >
            <strong>Proctoring did not start.</strong> This session is not signed
            in ({bridge.blockedReason}). Nothing is being monitored or recorded —
            return to the site and sign in to run the demo.
          </div>
        </div>
      ) : null}

      {/* ---- Soft full-screen advisory ----
           Advisory only: it never reports a violation and never stops the
           extension's loop. Dismissible, because a visitor who chose windowed
           mode should not be nagged for the rest of the demo. */}
      {fullscreenWarning && !isFullscreen ? (
        <div className="px-4 pt-3 sm:px-6">
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs sm:text-sm text-amber-200"
          >
            <span>
              <strong>Full-screen exited.</strong> In a real exam this is recorded as an
              incident. Proctoring is still running — this demo will not stop.
            </span>
            <button
              type="button"
              onClick={() => setFullscreenWarning(false)}
              className="shrink-0 rounded border border-amber-400/40 px-2 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- Focus-loss blur overlay ----
           Covers the paper, not the chrome: the timer and the evidence panel
           stay readable so the candidate can see the session is still running.
           Dismissal is a deliberate click — see `focusLost`. */}
      {focusLost ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-6 backdrop-blur-md">
          <div className="max-w-md rounded-card border border-amber-500/40 bg-surface-raised p-6 text-center shadow-2xl">
            <p className="text-3xl" aria-hidden="true">👁️</p>
            <h2 className="mt-3 text-lg font-semibold text-amber-200">
              Exam Paused — Please return focus to the exam window
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              You switched away from the exam. In a real assessment this is recorded
              as an incident, and the proctor sees a capture of your screen at that
              moment — not your face.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              This clears on its own once you are back in fullscreen, or resume now.
            </p>
            <button
              type="button"
              onClick={() => setFocusLost(false)}
              className="mt-5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              Resume Exam
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- Main 70 / 30 Workspace ---- */}
      <div className="grid min-h-0 flex-1 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">

        {/* ================= LEFT: 5-Question Exam ================= */}
        <div className="min-h-0 overflow-y-auto pr-1">
          {submitted ? (
            <div className="grid h-full place-items-center rounded-card border border-slate-800 bg-surface-raised/60 p-8 text-center">
              <div>
                <h2 className="text-2xl font-semibold text-verified">Paper Submitted</h2>
                <p className="tnum mt-3 font-mono text-4xl font-bold text-slate-100">
                  {score} / {QUESTIONS.length}
                </p>
                {/* ⚠ THE SCORE IS THE ONLY VERDICT THIS SCREEN GIVES.
                    It used to also print "N incidents were detected… review the
                    evidence cards", which is the same in-exam disclosure the
                    evidence panel was stripped of — and it would now be a lie
                    besides, since there are no cards to review. Whether anything
                    was flagged is a question the dashboard answers, after the
                    frames have been reviewed and with the reasoning attached. */}
                <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-400">
                  Your paper has been submitted. Proctoring evidence from this
                  sitting is reviewed separately — open your integrity record to
                  see whether anything was flagged.
                </p>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  {/* ⚠ THE SITTING IS TORN DOWN FIRST, THEN WE NAVIGATE.
                      `handleExit` stops the extension, releases the camera and
                      leaves fullscreen. Navigating straight to the dashboard
                      without it would leave a webcam running behind a page that
                      no longer has anything mounted to stop it — the same defect
                      the stop/start guards in useExtensionBridge exist for. */}
                  <button
                    type="button"
                    onClick={async () => {
                      await stopGuestQuiz();
                      await exitFullscreenMode();
                      navigate('/student/dashboard');
                    }}
                    className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                  >
                    See if you were flagged
                  </button>
                  <button
                    type="button"
                    onClick={handleExit}
                    className="rounded-lg border border-slate-700 bg-surface-raised px-6 py-2 text-sm font-medium text-slate-200 hover:border-slate-500"
                  >
                    Back to site
                  </button>
                </div>

                <p className="mt-4 max-w-md text-xs leading-relaxed text-slate-600">
                  A review can take a few seconds to appear. If nothing is
                  listed, nothing was flagged.
                </p>
              </div>
            </div>
          ) : (
            <ol className="flex flex-col gap-4">
              {QUESTIONS.map((q, index) => (
                <li key={q.id} className="rounded-card border border-slate-800 bg-surface-raised/50 p-5 shadow-sm">
                  <fieldset>
                    <legend className="text-sm font-medium text-slate-100">
                      <span className="tnum mr-2 font-mono text-cyan-400">
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
                            className={`flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-2.5 text-sm transition ${
                              checked
                                ? 'border-cyan-500/50 bg-cyan-950/30 text-slate-100 ring-1 ring-cyan-500/30'
                                : 'border-slate-800 text-slate-300 hover:border-slate-600 hover:bg-surface-raised/80'
                            }`}
                          >
                            <input
                              type="radio"
                              id={id}
                              name={q.id}
                              value={optionIndex}
                              checked={checked}
                              onChange={() => setAnswers((a) => ({ ...a, [q.id]: optionIndex }))}
                              className="mt-0.5 accent-cyan-400"
                            />
                            <span>{option}</span>
                          </label>
                        );
                      })}
                    </div>

                    {q.cue ? (
                      <div className="mt-4 rounded border-l-2 border-cyan-400/60 bg-cyan-950/20 p-3 text-xs leading-relaxed text-slate-300">
                        <span className="font-semibold text-cyan-400">Interactive Test Cue: </span>
                        {q.cue}
                      </div>
                    ) : null}
                  </fieldset>
                </li>
              ))}

              <li className="flex items-center justify-between gap-4 pt-2">
                <button
                  type="button"
                  onClick={() => setSubmitted(true)}
                  className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  Submit Paper
                </button>
                <span className="tnum font-mono text-xs text-slate-500">
                  {answeredCount} / {QUESTIONS.length} Answered
                </span>
              </li>
            </ol>
          )}
        </div>

        {/* ================= RIGHT: Local Live Diagnostic Panel ================= */}
        <aside className="flex min-h-0 flex-col gap-4">
          <section aria-label="AI Observer Live Telemetry" className="glass rounded-card p-4 shadow-md">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
              <h3 className="text-xs font-semibold tracking-wider text-cyan-400 uppercase">
                Live Diagnostic Panel
              </h3>
              <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                <span className="h-1.5 w-1.5 rounded-full bg-verified animate-ping" />
                Local Relay
              </span>
            </div>

            <dl className="space-y-1">
              <HudRow
                label="Proctoring Extension"
                value={bridge.extensionDetected ? 'AI Observer Active' : 'Not Connected'}
                tone={bridge.extensionDetected ? 'text-verified font-semibold' : 'text-amber-400'}
              />
              <HudRow
                label="Candidate"
                value={candidateEmail ?? 'Signed in'}
                tone="text-cyan-300"
              />
              <HudRow
                label="Full-Screen Status"
                value={isFullscreen ? 'Active' : 'Windowed'}
                tone={isFullscreen ? 'text-verified' : 'text-slate-400'}
              />
              <HudRow
                label="Backend Uploads"
                value={bridge.guestSessionId ? 'Scoped to your account' : 'Disabled (Local Holding Only)'}
                tone="text-slate-400"
              />
              {/* ⚠ "LIVE STATUS" AND "TOTAL FLAGGED" WERE REMOVED HERE, AND THE
                  REASON IS NOT COSMETIC.
                  They were the last two readouts on this page that told the
                  candidate what the detector had concluded — one instantaneous
                  ("INCIDENT ACTIVE"), one cumulative ("3"). Between them they
                  gave a live, labelled signal a candidate could optimise
                  against: move, watch the row, learn the threshold. Everything
                  that remains above describes the SETUP (is the extension
                  attached, is the camera fullscreen, who is signed in), which is
                  information the candidate needs and cannot game. */}
              <HudRow
                label="Observation"
                value="Active"
                tone="text-verified font-semibold"
              />
            </dl>

            {/* ---- Vision pipeline health ----
                ⚠ ONLY RENDERED ON AN EXPLICIT OFFLINE VERDICT. `visionStatus`
                is null while the engine is still loading, and a fault banner
                during normal startup teaches people to ignore the banner.
                When it does appear it must be impossible to miss: a dead
                pipeline previously looked identical to a clean session, because
                "no violations reported" and "nothing is watching" render the
                same way. */}
            {visionOffline ? (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-violation/50 bg-violation/10 p-3"
              >
                <p className="text-xs font-bold uppercase tracking-wide text-violation">
                  Vision Pipeline Offline (CSP/WASM Error)
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  Face and gaze detection are not running. Focus and fullscreen
                  checks are unaffected.
                  {bridge.visionReason ? ` (${bridge.visionReason})` : null}
                </p>
              </div>
            ) : null}
          </section>

          {/* Proctoring status only — no snapshots, no verdicts. See the header
              of EvidencePanel.jsx for why this panel is deliberately blind. */}
          <div className="min-h-0 flex-1 rounded-card border border-slate-800 bg-surface-raised/40 p-4 shadow-inner">
            <EvidencePanel
              monitoring={!bridge.blockedReason && bridge.extensionDetected === true}
              reviewUnavailable={reviewUnavailable}
            />
          </div>
        </aside>

      </div>
    </div>
  );
}

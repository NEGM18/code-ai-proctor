import { useCallback, useEffect, useId, useRef, useState, useMemo } from 'react';
import { useExtensionBridge } from '../../hooks/useExtensionBridge.js';
import { usePaintLoop } from '../../hooks/usePaintLoop.js';
import { useProctorDemo, DEMO_STATUS } from '../../hooks/useProctorDemo.js';
import CameraStage from '../ProctorDemo/CameraStage.jsx';
import DemoFallback from '../ProctorDemo/DemoFallback.jsx';
import EvidencePanel from './EvidencePanel.jsx';

/**
 * The four-step integrity challenge.
 *
 * ⚠ STEP 4 MERGES TWO VIOLATION TYPES ON PURPOSE. "Step out of frame" and
 * "have someone lean in" are opposite actions that both answer the same
 * question — is exactly one person present? — so `MULTIPLE_FACES` and
 * `NO_FACE_DETECTED` share a step and either one advances it. Splitting them
 * would strand a tester who happens to have nobody else in the room.
 *
 * ⚠ `NO_FACE_DETECTED` IS ALSO THE STEP THAT PROVES THE SAFEGUARD HAS LIMITS.
 * It is on the never-vetoable list: covering the lens destroys the landmarks,
 * so if closed eyes could suppress it, covering the camera would become a way
 * to silence the detector built to catch covering the camera. Step 4 firing
 * while the eyes are unreadable is the system working, not a leak.
 */
const PROMPTS = [
  {
    title: 'Step 1: Baseline Calibration',
    instruction: 'Look directly at the screen to start the exam.',
    detail: 'The engine learns YOUR neutral head pose and resting eye geometry. Every later verdict is measured as deviation from this, never against an absolute angle — which is why a camera mounted off to one side does not make you look guilty.',
    triggerType: null, // auto-advances once the baseline window elapses
    icon: '🎯',
  },
  {
    title: 'Step 2: Gaze & Attention',
    instruction: 'Try looking away or at a second screen.',
    detail: 'Head pose and iris position are tracked separately. Gaze is only read while your head is inside its calibrated band — an eye direction measured off a turned head is not a claim about where you are looking, so it is reported as unknown instead.',
    triggerType: ['AI_CHEATING_POSE', 'HEAD_POSE_GLANCE', 'GAZE_OFF_SCREEN', 'SIDE_GAZE_PEEKING'],
    icon: '👀',
  },
  {
    title: 'Step 3: 2nd-Layer Phone Detection',
    instruction: 'Pick up a smartphone or hold a secondary device.',
    detail: 'This is the extension\'s YOLO object detector — a second, independent layer that sees objects rather than faces. It latches on the first qualifying frame and captures the evidence on that frame, because a snapshot taken a second later photographs an empty desk.',
    triggerType: ['PHONE_DETECTED', 'SECONDARY_DEVICE'],
    extensionOnly: true,
    icon: '📱',
  },
  {
    title: 'Step 4: Multi-Person / Face Absence',
    instruction: 'Step out of frame or have someone else lean in.',
    detail: 'Either action answers the same question: is exactly one person present? Both are reported even when your eyes cannot be read at all — blink immunity deliberately does not extend here.',
    triggerType: ['MULTIPLE_FACES', 'NO_FACE_DETECTED'],
    icon: '👥',
  },
];

const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

export default function SandboxQuiz({ onClose }) {
  const paintLoop = usePaintLoop();
  const demo = useProctorDemo({ paintLoop });
  const bridge = useExtensionBridge();

  const [quizStarted, setQuizStarted] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [timerStartedAt, setTimerStartedAt] = useState(null);

  const dialogRef = useRef(null);
  const titleId = useId();

  // Handle focus trap and Esc
  const handleClose = useCallback(() => { 
    bridge.stopGuestQuiz();
    onClose(); 
  }, [onClose, bridge]);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement;
    node.querySelector(FOCUSABLE)?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
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

  // `idle` used to exist here solely to feed the always-false half of the Start
  // button's disabled expression. With that clause gone it has no reader, and
  // keeping it would leave a variable whose only purpose was a bug.
  const busy = demo.status === DEMO_STATUS.REQUESTING_CAMERA || demo.status === DEMO_STATUS.LOADING_MODEL;

  const handleStartQuiz = async () => {
    await demo.start();
    if (bridge.extensionDetected) {
      // Awaited: startGuestQuiz now resolves an anonymous Supabase session
      // before handing the extension a token. Firing it un-awaited would let
      // the first violations arrive before the extension knows where it is
      // allowed to write them.
      await bridge.startGuestQuiz();
    }
    setQuizStarted(true);
    setTimerStartedAt(Date.now());
  };

  const allViolations = useMemo(() => {
    const combined = [
      ...demo.violations.map(v => ({ ...v, source: 'browser', wallTime: v.tMs })),
      ...bridge.extensionViolations
    ];
    combined.sort((a, b) => (b.wallTime ?? 0) - (a.wallTime ?? 0));
    return combined;
  }, [demo.violations, bridge.extensionViolations]);

  // Handle auto-advancing steps
  useEffect(() => {
    if (!quizStarted || currentStepIndex >= PROMPTS.length) return;
    const step = PROMPTS[currentStepIndex];

    if (!step.triggerType) {
      // Step 1: Baseline (5 seconds)
      const elapsed = Date.now() - timerStartedAt;
      const delay = Math.max(0, 5000 - elapsed);
      const timer = setTimeout(() => {
        setCurrentStepIndex(i => i + 1);
        setTimerStartedAt(Date.now());
      }, delay);
      return () => clearTimeout(timer);
    } else {
      // Find if we have a violation that matches this step occurring AFTER the step started
      const matches = allViolations.filter(v => 
        step.triggerType.includes(v.type) && 
        (v.wallTime ?? 0) >= timerStartedAt
      );

      if (matches.length > 0) {
        const timer = setTimeout(() => {
          setCurrentStepIndex(i => i + 1);
          setTimerStartedAt(Date.now());
        }, 1500); // Wait a tiny bit so they can see the capture
        return () => clearTimeout(timer);
      }
    }
  }, [quizStarted, currentStepIndex, allViolations, timerStartedAt]);

  const handleSkip = () => {
    setCurrentStepIndex(i => i + 1);
    setTimerStartedAt(Date.now());
  };

  const currentStep = PROMPTS[currentStepIndex];
  const isCompleted = currentStepIndex >= PROMPTS.length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-base/85 p-4 backdrop-blur-sm sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass my-auto w-full max-w-6xl rounded-card p-4 shadow-2xl sm:p-6"
      >
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-100">
              Sandbox Quiz
            </h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
              Experience the dual-layer detection pipeline from the student's perspective.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
            >
              Close
            </button>
          </div>
        </header>

        {bridge.extensionDetected === null ? (
           <div className="mb-4 rounded-md border border-slate-700 bg-surface px-4 py-2 text-sm text-slate-300">
             Probing for extension...
           </div>
        ) : bridge.extensionDetected ? (
          <div className="mb-4 rounded-md border border-verified/30 bg-verified/10 px-4 py-2 text-sm text-verified">
            Extension Connected ✓ (2-Layer Phone Detector Active)
          </div>
        ) : (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-glance/30 bg-glance/10 px-4 py-2 text-sm text-glance">
            <span>
              Install the Safe Test extension for phone detection. Browser-only
              mode is active — steps 1, 2 and 4 still run.
            </span>
            {/* Store root, not a listing ID: the add-on is not published yet and
                a fabricated listing URL is a dead link that looks live. Replace
                with the full listing path once it exists. */}
            <a
              href="https://microsoftedge.microsoft.com/addons"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline hover:text-glance-dim"
            >
              Microsoft Edge Add-ons
            </a>
          </div>
        )}

        {!quizStarted ? (
          <div className="grid flex-1 place-items-center rounded-card border border-slate-800 bg-surface-raised/60 p-8 text-center min-h-[400px]">
            <h3 className="text-xl font-semibold text-slate-100 mb-2">Ready to test the engine?</h3>
            <p className="text-sm leading-relaxed text-slate-300 mb-6 max-w-md mx-auto">
              This guided sandbox will walk you through a series of actions that trigger both the browser's head pose estimation and the extension's YOLO object detection model.
            </p>
            <button
              type="button"
              onClick={handleStartQuiz}
              // Was `busy || idle && demo.status !== DEMO_STATUS.IDLE`. That
              // second clause expands to `idle && !idle` — constantly false, so
              // it contributed nothing and merely looked like a guard.
              disabled={busy}
              className="beam rounded-lg bg-verified px-6 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-verified disabled:opacity-50"
            >
              Start Sandbox Quiz
            </button>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] h-[600px]">
            <div className="flex flex-col gap-4">
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

              {demo.status === DEMO_STATUS.ERROR ? (
                <DemoFallback errorCode={demo.errorCode} onRetry={demo.restart} />
              ) : null}

              <div className="mt-auto flex-1 rounded-card border border-slate-700 bg-surface-raised p-5 flex flex-col justify-center relative">
                {isCompleted ? (
                   <div className="text-center">
                     <h4 className="text-lg font-medium text-verified mb-2">Sandbox Complete</h4>
                     <p className="text-sm text-slate-300">You've successfully triggered the detection engines.</p>
                   </div>
                ) : (
                  <>
                    <div className="flex items-start gap-4">
                      <div className="text-4xl">{currentStep.icon}</div>
                      <div>
                        <h4 className="text-sm font-semibold text-slate-100">{currentStep.title}</h4>
                        <p className="mt-1 text-base font-medium text-slate-200">{currentStep.instruction}</p>
                        <p className="mt-2 text-xs text-slate-400">{currentStep.detail}</p>
                      </div>
                    </div>
                    {currentStep.extensionOnly && !bridge.extensionDetected && (
                      <p className="mt-4 text-xs text-glance font-medium">
                        (Extension required for this step — skip to proceed)
                      </p>
                    )}
                    <button
                      onClick={handleSkip}
                      className="absolute bottom-4 right-4 text-xs font-medium text-slate-400 hover:text-slate-200 transition"
                    >
                      Skip →
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="bg-surface-raised rounded-card p-4 border border-slate-700 overflow-hidden">
               <EvidencePanel violations={allViolations} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

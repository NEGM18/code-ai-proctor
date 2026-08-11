// =============================================================================
// DemoGate — the sign-in wall in front of /demo-quiz.
//
// ⚠ THIS IS THE COURTESY, NOT THE CONTROL. Everything real is enforced by
// `session_is_verified_human()` in RLS: without a verified session the evidence
// bucket, the violations table and the proctor-session rows all refuse, whether
// or not this component is on screen. What this adds is that the refusal
// happens BEFORE a camera is opened and an ONNX pipeline is built, instead of
// as a wall of 403s behind an already-running proctoring session.
//
// ⚠ IT MUST NEVER RENDER ITS CHILD OPTIMISTICALLY. `DemoQuizPage` starts the
// vision stack in a mount effect — rendering it "while we check" would open the
// webcam of someone who is about to be refused. `loading` therefore gets its
// own branch; it is not folded into the verified case.
//
// The states below map 1:1 onto SESSION_STATE (lib/auth/session.js), because
// "sign in", "you are on a guest session" and "enter the code we emailed" need
// three different sentences. Collapsing them into "please sign in" is what
// makes a stuck visitor retry the thing that already worked.
// =============================================================================

import { useCallback, useState } from 'react';

import { useAuth } from '../../lib/auth/useAuth.js';
import { SESSION_STATE } from '../../lib/auth/session.js';
import { navigate } from '../../lib/route.js';
import AuthModal from './AuthModal.jsx';

const GATE_COPY = {
  [SESSION_STATE.SIGNED_OUT]: {
    title: 'Sign in to run the live demo',
    body:
      'The demo opens your camera and runs the same proctoring pipeline a real exam does, so it runs against a real account — not an anonymous guest session. Use Google, or an email address and password.',
    cta: 'Sign in or create an account',
  },
  [SESSION_STATE.ANONYMOUS]: {
    title: 'Guest sessions have been retired',
    body:
      'This browser is holding an anonymous guest session from an earlier visit. Guest access to the demo has been removed — sign in with Google, or with an email address and password, to continue.',
    cta: 'Sign in',
  },
  [SESSION_STATE.AWAITING_EMAIL_CODE]: {
    title: 'One step left — check your email',
    body:
      'Your password was accepted, but the demo needs the mailbox confirmed too. Enter the code we emailed you and the demo opens immediately.',
    cta: 'Enter my code',
  },
};

export default function DemoGate({ children }) {
  const { loading, verified, sessionStatus, configured } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);

  const closeModal = useCallback(() => setModalOpen(false), []);
  // Close on verification rather than leaving the modal up: the page behind it
  // re-renders into the demo on the same state change, and a modal sitting over
  // a live proctored exam is its own bug.
  const onVerified = useCallback(() => setModalOpen(false), []);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-base p-6 text-slate-400">
        <p className="flex items-center gap-2 text-sm">
          <span className="h-2 w-2 animate-ping rounded-full bg-cyan-400" />
          Checking your session…
        </p>
      </div>
    );
  }

  if (verified) return children;

  const copy = GATE_COPY[sessionStatus] ?? GATE_COPY[SESSION_STATE.SIGNED_OUT];

  return (
    <div className="grid min-h-screen place-items-center bg-base p-6">
      <div className="glass w-full max-w-lg rounded-card p-8 text-center">
        <img
          src="/brand/logo-transparent.png"
          alt="Procminds"
          className="mx-auto h-8 w-auto drop-shadow-[0_0_10px_rgba(0,210,255,0.4)]"
        />

        <h1 className="mt-6 text-xl font-semibold text-slate-100">{copy.title}</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-400">{copy.body}</p>

        {/* ⚠ NOT A DEAD BUTTON WHEN UNCONFIGURED. With a placeholder anon key
            there is no sign-in to offer, and a button that opens a modal saying
            "auth is unavailable" is a worse answer than saying so here. */}
        {configured ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="mt-7 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-2.5 text-sm font-semibold text-[var(--color-base)] shadow-[0_0_20px_rgba(6,182,212,0.35)] transition hover:brightness-110"
          >
            {copy.cta}
          </button>
        ) : (
          <p className="mt-7 rounded-md border border-glance/40 bg-glance-dim/20 p-3 text-xs leading-relaxed text-glance">
            Accounts are not connected in this deployment — the Supabase key is
            still a placeholder. The live demo requires a signed-in account, so
            it is unavailable here until that is configured.
          </p>
        )}

        <p className="mt-6 text-xs text-slate-500">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="hover:text-slate-300 hover:underline"
          >
            Back to the site
          </button>
        </p>

        <p className="mt-6 border-t border-slate-800 pt-4 text-[11px] leading-relaxed text-slate-600">
          The demo processes video on your own machine. Evidence snapshots are
          scoped to your account and deleted when you leave the demo.
        </p>
      </div>

      {modalOpen ? (
        <AuthModal mode="signin" onClose={closeModal} onVerified={onVerified} />
      ) : null}
    </div>
  );
}

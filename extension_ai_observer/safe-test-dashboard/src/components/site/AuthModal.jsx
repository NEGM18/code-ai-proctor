// =============================================================================
// AuthModal — Google OAuth, or standard Email + Password authentication.
//
// 1. Sign In (SIGNIN_FORM): Email + Password only. Direct sign-in, zero OTP emails.
// 2. Sign Up (SIGNUP_FORM -> VERIFY_OTP):
//    Step 1: Collect Role, Full Name, Email, Password (min 6 chars). On submit,
//            calls signUp() and IMMEDIATELY transitions to STEP.CODE (VERIFY_OTP).
//    Step 2: Renders focused 6-digit OTP code input field with "Verify & Complete Sign-Up"
//            button and 30-second resend countdown timer.
// 3. Google OAuth: One-click Google sign-in at the top.
// =============================================================================

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useAuth } from '../../lib/auth/useAuth.js';
import { ROLE, ROLE_VALUES, ROLE_LABELS } from '../../lib/auth/roles.js';
import { EMAIL_CODE_LENGTH } from '../../lib/auth/authService.js';
import { SESSION_STATE } from '../../lib/auth/session.js';

const REASON_COPY = {
  SUPABASE_UNCONFIGURED:
    'Accounts are not connected in this deployment yet — the backend key is still a placeholder. The live demo needs a signed-in account, so it is unavailable until that is set.',
  INVALID_ROLE: 'Choose one of the three account types.',
  MISSING_CREDENTIALS: 'An email address and a password are both required.',
  WEAK_PASSWORD: 'Password must be at least 6 characters long.',
  ORGANIZATION_NAME_REQUIRED: 'Organisation accounts need the organisation’s name.',
  INVALID_CODE_FORMAT: `Enter the ${EMAIL_CODE_LENGTH}-digit code from the email.`,
  CODE_SEND_FAILED:
    'We could not send the verification code. Use “Send it again” below.',
};

const INPUT = 'w-full rounded-md border border-slate-700 bg-surface/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-verified focus:outline-none';

export const STEP = Object.freeze({ CREDENTIALS: 'credentials', CODE: 'code' });

const RESEND_COOLDOWN_SECONDS = 30;

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="h-4 w-4">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function AuthModal({ mode: initialMode = 'signin', initialRole = ROLE.STUDENT, onClose, onVerified }) {
  const {
    configured,
    signIn,
    signUp,
    signInWithGoogle,
    sendEmailCode,
    verifyEmailCode,
    signOut,
    sessionStatus,
    pendingEmail,
    verified,
  } = useAuth();

  const [mode, setMode] = useState(initialMode);
  const [role, setRole] = useState(initialRole);
  const [step, setStep] = useState(
    sessionStatus === SESSION_STATE.AWAITING_EMAIL_CODE ? STEP.CODE : STEP.CREDENTIALS,
  );
  const [email, setEmail] = useState(pendingEmail ?? '');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState(null);
  const [cooldown, setCooldown] = useState(0);

  const dialogRef = useRef(null);
  const titleId = useId();

  const handleClose = useCallback(() => { onClose(); }, [onClose]);

  const handleAbandon = useCallback(async () => {
    if (step === STEP.CODE && !verified) await signOut();
    handleClose();
  }, [step, verified, signOut, handleClose]);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return undefined;
    const previouslyFocused = document.activeElement;
    node.querySelector('input,button,select')?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        void handleAbandon();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [handleAbandon]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    if (verified) onVerified?.();
  }, [verified, onVerified]);

  const requestCode = useCallback(async (address) => {
    const sent = await sendEmailCode({ email: address });
    if (sent.ok) {
      setNotice(`We emailed a ${EMAIL_CODE_LENGTH}-digit code to ${address}.`);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return true;
    }
    setResult({ ok: false, reason: 'CODE_SEND_FAILED', error: sent.error });
    return false;
  }, [sendEmailCode]);

  const onSubmitCredentials = async (event) => {
    event.preventDefault();
    setPending(true);
    setResult(null);
    setNotice(null);

    if (mode === 'signin') {
      const outcome = await signIn({ email, password });
      setPending(false);
      setResult(outcome);
      return;
    }

    // Sign Up flow (SIGNUP_FORM)
    const outcome = await signUp({ email, password, role, fullName, organizationName });
    if (!outcome.ok) {
      setPending(false);
      setResult(outcome);
      return;
    }

    // ALWAYS transition to STEP.CODE (VERIFY_OTP) on sign-up so the code input field is rendered
    setNotice(`We sent a ${EMAIL_CODE_LENGTH}-digit confirmation code to ${email}.`);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    setPending(false);
    setStep(STEP.CODE);
  };

  const onSubmitCode = async (event) => {
    event.preventDefault();
    setPending(true);
    setResult(null);
    setNotice(null);
    const outcome = await verifyEmailCode({ email, token: code, type: 'signup' });
    setPending(false);
    setResult(outcome);
  };

  const onGoogle = async () => {
    setPending(true);
    setResult(null);
    setNotice('Redirecting to Google…');
    const outcome = await signInWithGoogle();
    if (!outcome.ok) {
      setPending(false);
      setNotice(null);
      setResult(outcome);
    }
  };

  const failureCopy = result && !result.ok
    ? (REASON_COPY[result.reason] ?? result.error?.message ?? 'That did not work.')
    : null;

  const atCodeStep = step === STEP.CODE;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-base/85 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass w-full max-w-md rounded-card p-6"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-100">
              {atCodeStep
                ? 'Confirm your email'
                : mode === 'signin' ? 'Sign in' : 'Create an account'}
            </h2>
            {!atCodeStep ? (
              <div className="mt-2 flex gap-4 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => { setMode('signin'); setResult(null); setNotice(null); }}
                  className={`pb-1 border-b-2 transition ${
                    mode === 'signin'
                      ? 'border-verified text-verified font-semibold'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('signup'); setResult(null); setNotice(null); }}
                  className={`pb-1 border-b-2 transition ${
                    mode === 'signup'
                      ? 'border-verified text-verified font-semibold'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Sign Up
                </button>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={handleAbandon}
            className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
          >
            Close
          </button>
        </header>

        {!configured ? (
          <p className="mt-4 rounded-md border border-glance/40 bg-glance-dim/20 p-3 text-xs leading-relaxed text-glance">
            {REASON_COPY.SUPABASE_UNCONFIGURED}
          </p>
        ) : null}

        {atCodeStep ? (
          <form onSubmit={onSubmitCode} className="mt-5 space-y-4" data-testid="otp-verify-form">
            <p className="text-xs leading-relaxed text-slate-400">
              To finish creating your account, enter the{' '}
              {EMAIL_CODE_LENGTH}-digit code we sent to{' '}
              <span className="font-medium text-slate-200">{email}</span>.
            </p>

            <p className="flex flex-col gap-1.5">
              <label htmlFor="auth-code" className="text-xs font-medium text-slate-300">
                Verification code
              </label>
              <input
                id="auth-code"
                data-testid="otp-input"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={`${INPUT} tnum text-center font-mono text-lg tracking-[0.4em]`}
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={8}
                placeholder="000000"
                required
              />
            </p>

            <button
              type="submit"
              data-testid="verify-otp-button"
              disabled={pending}
              className="w-full rounded-md bg-verified px-4 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 disabled:opacity-50"
            >
              {pending ? 'Checking…' : 'Verify & Complete Sign-Up'}
            </button>

            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                disabled={pending || cooldown > 0}
                onClick={() => { setResult(null); void requestCode(email); }}
                className="text-verified hover:underline disabled:opacity-50 disabled:no-underline"
              >
                {cooldown > 0 ? `Send it again in ${cooldown}s` : 'Send it again'}
              </button>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  setStep(STEP.CREDENTIALS);
                  setCode('');
                  setPassword('');
                  setResult(null);
                  setNotice(null);
                }}
                className="text-slate-500 hover:text-slate-300"
              >
                Use a different account
              </button>
            </div>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={onGoogle}
              disabled={pending}
              className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-md border border-slate-700 bg-surface/70 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:border-slate-500 disabled:opacity-50"
            >
              <GoogleMark />
              Continue with Google
            </button>

            <p className="mt-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-slate-600">
              <span className="h-px flex-1 bg-slate-800" />
              or continue with email
              <span className="h-px flex-1 bg-slate-800" />
            </p>

            <form onSubmit={onSubmitCredentials} className="mt-4 space-y-4" data-testid="credentials-form">
              {mode === 'signup' ? (
                <fieldset>
                  <legend className="mb-2 text-xs font-medium text-slate-300">Account type</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {ROLE_VALUES.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={role === value}
                        onClick={() => setRole(value)}
                        className={`rounded-md border px-2 py-2 text-xs transition ${
                          role === value
                            ? 'border-verified bg-verified/10 text-verified'
                            : 'border-slate-700 text-slate-400 hover:border-slate-500'
                        }`}
                      >
                        {ROLE_LABELS[value]}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              {mode === 'signup' ? (
                <p className="flex flex-col gap-1.5">
                  <label htmlFor="auth-name" className="text-xs font-medium text-slate-300">
                    Full name
                  </label>
                  <input
                    id="auth-name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className={INPUT}
                    autoComplete="name"
                  />
                </p>
              ) : null}

              {mode === 'signup' && role === ROLE.ORGANIZATION ? (
                <p className="flex flex-col gap-1.5">
                  <label htmlFor="auth-org" className="text-xs font-medium text-slate-300">
                    Organisation name
                  </label>
                  <input
                    id="auth-org"
                    value={organizationName}
                    onChange={(e) => setOrganizationName(e.target.value)}
                    className={INPUT}
                    autoComplete="organization"
                    required
                  />
                </p>
              ) : null}

              <p className="flex flex-col gap-1.5">
                <label htmlFor="auth-email" className="text-xs font-medium text-slate-300">
                  Email
                </label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={INPUT}
                  autoComplete="email"
                  required
                />
              </p>

              <p className="flex flex-col gap-1.5">
                <label htmlFor="auth-password" className="text-xs font-medium text-slate-300">
                  Password
                </label>
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={INPUT}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  minLength={6}
                  required
                />
              </p>

              <button
                type="submit"
                disabled={pending}
                className="w-full rounded-md bg-verified px-4 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 disabled:opacity-50"
              >
                {pending ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>
          </>
        )}

        <p aria-live="polite" className="mt-3 min-h-4 text-xs leading-relaxed">
          {failureCopy ? <span className="text-violation">{failureCopy}</span> : null}
          {!failureCopy && notice ? <span className="text-slate-400">{notice}</span> : null}
          {verified ? <span className="text-verified">Signed in — the demo is open.</span> : null}
        </p>

        {atCodeStep ? null : (
          <p className="mt-4 border-t border-slate-800 pt-3 text-xs text-slate-500">
            {mode === 'signin' ? 'No account yet?' : 'Already have an account?'}{' '}
            <button
              type="button"
              onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setResult(null); setNotice(null); }}
              className="text-verified hover:underline"
            >
              {mode === 'signin' ? 'Create one' : 'Sign in'}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

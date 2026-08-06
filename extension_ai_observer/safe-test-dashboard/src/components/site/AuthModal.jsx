// =============================================================================
// AuthModal — sign in / create account, across the three roles.
//
// ⚠ IT REPORTS THE UNCONFIGURED CASE INSTEAD OF FAILING VAGUELY. The anon key in
// this deployment is still a placeholder, so `isSupabaseConfigured` is false and
// every auth call returns `{ok: false, reason: 'SUPABASE_UNCONFIGURED'}` without
// touching the network. A form that spins and then says "something went wrong"
// would be indistinguishable from a real outage; this says which of the two it
// is, because the fix is completely different.
//
// ⚠ `reason` IS READ OFF THE RETURNED SHAPE, NEVER INFERRED. `authService`
// returns a discriminated result rather than throwing, so the copy below is
// keyed on `result.reason` — never on a truthiness check or a caught error,
// which is how "invalid password" and "server unreachable" end up sharing a
// message.
// =============================================================================

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useAuth } from '../../lib/auth/useAuth.js';
import { ROLE, ROLE_VALUES, ROLE_LABELS } from '../../lib/auth/roles.js';

const REASON_COPY = {
  SUPABASE_UNCONFIGURED:
    'Accounts are not connected in this deployment yet — the backend key is still a placeholder. The live demo does not need an account and works fully without one.',
  INVALID_ROLE: 'Choose one of the three account types.',
  MISSING_CREDENTIALS: 'An email address and a password are both required.',
  ORGANIZATION_NAME_REQUIRED: 'Organisation accounts need the organisation’s name.',
};

const INPUT = 'w-full rounded-md border border-slate-700 bg-surface/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-verified focus:outline-none';

/**
 * @param {object} props
 * @param {'signin'|'signup'} props.mode
 * @param {string} [props.initialRole]
 * @param {() => void} props.onClose
 */
export default function AuthModal({ mode: initialMode, initialRole = ROLE.STUDENT, onClose }) {
  const { configured, signIn, signUp } = useAuth();

  const [mode, setMode] = useState(initialMode);
  const [role, setRole] = useState(initialRole);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);

  const dialogRef = useRef(null);
  const titleId = useId();

  const handleClose = useCallback(() => { onClose(); }, [onClose]);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return undefined;
    const previouslyFocused = document.activeElement;
    node.querySelector('input,button,select')?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [handleClose]);

  const onSubmit = async (event) => {
    event.preventDefault();
    setPending(true);
    setResult(null);
    const outcome = mode === 'signin'
      ? await signIn({ email, password })
      : await signUp({ email, password, role, fullName, organizationName });
    setPending(false);
    setResult(outcome);
  };

  // The server's own message beats ours when there is one; SUPABASE_ERROR is
  // deliberately absent from REASON_COPY for that reason.
  const failureCopy = result && !result.ok
    ? (REASON_COPY[result.reason] ?? result.error?.message ?? 'That did not work.')
    : null;

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
          <h2 id={titleId} className="text-lg font-semibold text-slate-100">
            {mode === 'signin' ? 'Sign in' : 'Create your account'}
          </h2>
          <button
            type="button"
            onClick={handleClose}
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

        <form onSubmit={onSubmit} className="mt-5 space-y-4">
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

        <p aria-live="polite" className="mt-3 min-h-4 text-xs leading-relaxed">
          {failureCopy ? <span className="text-violation">{failureCopy}</span> : null}
          {result?.ok ? (
            <span className="text-verified">
              {mode === 'signin'
                ? 'Signed in.'
                : 'Account created. Check your inbox if confirmation is required.'}
            </span>
          ) : null}
        </p>

        <p className="mt-4 border-t border-slate-800 pt-3 text-xs text-slate-500">
          {mode === 'signin' ? 'No account yet?' : 'Already have an account?'}{' '}
          <button
            type="button"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setResult(null); }}
            className="text-verified hover:underline"
          >
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// ClassroomHub — the classes a student has joined, and the join-by-code modal.
//
// ⚠ EVERY STATUS ON A CARD IS THE HOLDER'S OWN RECORD IN THAT CLASS. There is
// deliberately no "peer flags recorded" state, even though one was asked for:
// reading another student's violations is refused by RLS by design
// (`violations_own_rw` scopes to auth.uid()), and the roles migration sets out
// at length why no cross-student read exists. A card claiming to know about
// peers would either be fabricating or would require reopening that boundary.
// See fetchClassrooms() in lib/dashboard/studentData.js.
//
// ⚠ QUICK-LAUNCH IS ABSENT, NOT DISABLED, WHEN NO EXAM IS OPEN. A greyed button
// invites clicking and says nothing about why it won't work; one line saying no
// exam is scheduled answers the question the student actually has.
// =============================================================================

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  CLASS_INTEGRITY_COPY,
  DATA_REASON,
  joinClassroom,
} from '../../lib/dashboard/studentData.js';
import { navigate } from '../../lib/route.js';
import { verdict } from './verdict.js';

const JOIN_MESSAGE = {
  [DATA_REASON.UNKNOWN_CODE]: 'No class uses that code. Check it with your instructor.',
  [DATA_REASON.ALREADY_ENROLLED]: 'You are already in this class.',
  [DATA_REASON.NOT_PROVISIONED]:
    'Classrooms are not set up on this deployment yet, so there is nothing to join.',
  [DATA_REASON.SUPABASE_UNCONFIGURED]:
    'Accounts are not connected in this deployment, so classes cannot be joined.',
  [DATA_REASON.QUERY_FAILED]: 'We could not reach the server. Try again in a moment.',
};

/**
 * @param {object} props
 * @param {{ ok: boolean, reason: string | null, classrooms: Array<Record<string, any>> }} props.result
 * @param {() => void} props.onJoined
 */
export default function ClassroomHub({ result, onJoined }) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <section aria-labelledby="classrooms-heading">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id="classrooms-heading"
            className="font-heading text-xl font-semibold tracking-tight text-slate-100"
          >
            Your classes
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Classes you have joined with an instructor&rsquo;s code.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-[var(--color-base)] shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all duration-300 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
        >
          Enter class code
        </button>
      </header>

      <div className="mt-6">
        {result.reason === DATA_REASON.NOT_PROVISIONED ? (
          <Notice>
            Classrooms are not provisioned on this deployment. The tables ship in{' '}
            <code className="font-mono text-[11px] text-slate-400">
              supabase/migrations/20260812120000_classrooms_and_enrollments.sql
            </code>{' '}
            and have not been applied to this project yet — so this is &ldquo;not set up&rdquo;,
            not &ldquo;you have joined nothing&rdquo;.
          </Notice>
        ) : !result.ok ? (
          <Notice>We could not load your classes. Reload the page to try again.</Notice>
        ) : result.classrooms.length === 0 ? (
          <Notice>
            You have not joined a class yet. Ask your instructor for their class code, then use
            &ldquo;Enter class code&rdquo; above.
          </Notice>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {result.classrooms.map((classroom) => (
              <ClassroomCard key={classroom.id} classroom={classroom} />
            ))}
          </ul>
        )}
      </div>

      {modalOpen ? (
        <JoinModal
          onClose={() => setModalOpen(false)}
          onJoined={() => {
            setModalOpen(false);
            onJoined();
          }}
        />
      ) : null}
    </section>
  );
}

function Notice({ children }) {
  return (
    <p className="glass rounded-card px-5 py-6 text-sm leading-relaxed text-slate-400">{children}</p>
  );
}

function ClassroomCard({ classroom }) {
  const status = CLASS_INTEGRITY_COPY[classroom.integrity];
  const tone = verdict(status.token);
  const examOpen = Boolean(classroom.active_exam_code);

  return (
    <li className="glass flex flex-col rounded-card p-5 transition-all duration-300 hover:border-cyan-500/35">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-heading truncate text-base font-semibold text-slate-100">
            {classroom.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {classroom.teacher_name || 'Instructor not named'}
            {classroom.subject ? ` · ${classroom.subject}` : ''}
          </p>
        </div>
        <span className="tnum shrink-0 rounded border border-slate-700/70 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-slate-500">
          {classroom.join_code}
        </span>
      </div>

      <p
        className={`mt-4 inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tone.border} ${tone.bg} ${tone.text}`}
      >
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.fill}`} />
        {status.label}
      </p>

      <p className="mt-3 text-[11px] text-slate-600">
        {classroom.sittings === 0
          ? 'No proctored sittings in this class yet.'
          : `${classroom.sittings} sitting${classroom.sittings === 1 ? '' : 's'}, ${classroom.flaggedSittings} with flags.`}
      </p>

      <div className="mt-5 border-t border-slate-800/70 pt-4">
        {examOpen ? (
          <button
            type="button"
            onClick={() => navigate('/demo-quiz')}
            className="w-full rounded-md border border-cyan-500/35 bg-cyan-500/5 px-3 py-2 text-xs font-semibold text-cyan-300 transition-all duration-300 hover:border-cyan-400/60 hover:bg-cyan-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
          >
            Start proctored exam · {classroom.active_exam_code}
          </button>
        ) : (
          <p className="text-[11px] text-slate-600">No exam scheduled right now.</p>
        )}
      </div>
    </li>
  );
}

/**
 * The join-by-code dialog.
 *
 * Focus handling mirrors AuthModal: focus the input on open, Escape closes, and
 * focus returns to whatever opened it. Codes are uppercased as you type because
 * the RPC compares case-insensitively — showing the normalised form is honest
 * about what will actually be submitted.
 */
function JoinModal({ onClose, onJoined }) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(null);

  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    inputRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    const node = dialogRef.current;
    node?.addEventListener('keydown', onKeyDown);

    return () => {
      node?.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  const submit = useCallback(
    async (event) => {
      event.preventDefault();
      if (pending) return;

      setPending(true);
      setMessage(null);
      const result = await joinClassroom(code);
      setPending(false);

      if (result.ok && !result.reason) {
        onJoined();
        return;
      }
      // Already-enrolled is a success for the roster but a failure for the
      // student's intent, so the list refreshes underneath while the modal
      // stays up to explain what happened.
      if (result.reason === DATA_REASON.ALREADY_ENROLLED) onJoined();

      setMessage(JOIN_MESSAGE[result.reason] ?? JOIN_MESSAGE[DATA_REASON.QUERY_FAILED]);
    },
    [code, pending, onJoined],
  );

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-base/80 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass w-full max-w-sm rounded-card p-6"
      >
        <h2 id={titleId} className="font-heading text-lg font-semibold text-slate-100">
          Join a class
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Enter the code your instructor gave you. Joining adds the class to this dashboard; it
          does not start an exam.
        </p>

        <form onSubmit={submit} className="mt-5">
          <label htmlFor="class-code" className="text-xs font-medium text-slate-400">
            Class code
          </label>
          <input
            ref={inputRef}
            id="class-code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            placeholder="e.g. PHYS201-A"
            className="tnum mt-1.5 w-full rounded-md border border-slate-700 bg-surface/70 px-3 py-2.5 font-mono text-sm tracking-[0.15em] text-slate-100 placeholder:tracking-normal placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
          />

          {message ? (
            <p role="status" className="mt-3 text-xs leading-relaxed text-glance">
              {message}
            </p>
          ) : null}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-2 text-sm text-slate-400 transition-colors hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || code.trim().length === 0}
              className="rounded-md bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-[var(--color-base)] transition-all duration-300 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
            >
              {pending ? 'Joining…' : 'Join class'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

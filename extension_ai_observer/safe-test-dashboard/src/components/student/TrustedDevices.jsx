// =============================================================================
// TrustedDevices — "Signed-in devices" in the dashboard's Profile tab.
//
// Lists the browsers that completed an emailed code and are therefore allowed
// to sign in with a password alone, and lets the owner sign any of them out.
//
// ⚠ "SIGN OUT" HERE IS A REAL LOGOUT, NOT JUST A FORGET. revoke_trusted_device()
// deletes that device's rows from auth.sessions as well as its trust record, so
// the other browser loses its live session rather than merely needing a code
// next time. That distinction is the whole point of the feature for someone who
// left themselves signed in on a shared machine — the copy says "Sign out", and
// it has to keep being true.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';

import { listTrustedDevices, revokeTrustedDevice } from '../../lib/auth/deviceTrust.js';

export default function TrustedDevices({ userId }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const rows = await listTrustedDevices();
    setDevices(rows);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await listTrustedDevices();
      if (!cancelled) {
        setDevices(rows);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const onRevoke = async (device) => {
    setBusyId(device.id);
    setError(null);

    const ok = await revokeTrustedDevice(device.id, {
      isCurrent: device.is_current,
      userId,
    });

    setBusyId(null);
    if (!ok) {
      setError('That device could not be signed out. Please try again.');
      return;
    }

    // Revoking THIS browser ends its own session, so there is nothing left to
    // re-read — the auth listener drops the user to signed-out on its own, and
    // re-listing here would only race that.
    if (!device.is_current) await refresh();
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-surface-raised/40 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="block text-xs font-medium text-slate-300">Signed-in devices</span>
        {devices.length > 0 ? (
          <span className="text-[11px] text-slate-500">{devices.length} active</span>
        ) : null}
      </div>

      <p className="mt-1 text-[11px] text-slate-500">
        These browsers can sign in with your password alone, without an emailed code. Signing one
        out ends its session immediately and asks for a code next time.
      </p>

      {loading ? (
        <p className="mt-4 text-xs text-slate-500">Loading devices…</p>
      ) : devices.length === 0 ? (
        <p className="mt-4 text-xs text-slate-500">
          No remembered devices yet. The browser you sign in from next will appear here.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-surface/60 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-slate-200">
                  {device.label || 'Unknown device'}
                  {device.is_current ? (
                    <span className="ml-2 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                      This device
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {device.last_used_at
                    ? `Last used ${formatWhen(device.last_used_at)}`
                    : `Added ${formatWhen(device.created_at)}`}
                </p>
              </div>

              <button
                type="button"
                onClick={() => void onRevoke(device)}
                disabled={busyId === device.id}
                className="shrink-0 rounded-lg border border-slate-700 bg-surface/80 px-3 py-1.5 text-xs text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-50"
              >
                {busyId === device.id
                  ? 'Signing out…'
                  : device.is_current
                    ? 'Sign out here'
                    : 'Sign out'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}

/**
 * Relative time, falling back to a date past a week.
 *
 * ⚠ Reads a PostgREST `timestamptz` string. An unparseable value renders as
 * "recently" rather than "Invalid Date" — the timestamp is decoration beside the
 * device label, and a broken one must not make the row look corrupted.
 */
function formatWhen(value) {
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return 'recently';

  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
  return then.toLocaleDateString();
}

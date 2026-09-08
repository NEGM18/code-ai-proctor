// =============================================================================
// AvatarMenu — the circular account button in the nav, and the popover it opens.
//
// Replaces the previous arrangement of a static avatar circle sitting next to a
// separate "Sign out" text button. Two reasons that pairing had to go, beyond
// the visual noise: the avatar was decoration that did nothing (a circle that
// looks like a control and isn't reads as broken), and sign-out — a
// session-ending action — sat one stray click away from the primary CTA with
// nothing between them.
//
// Brand system per THEME.md §3: everything here is CHROME. The verdict tokens
// (--color-verified and friends) are deliberately not used, because none of
// these pixels assert anything about what a camera saw.
// =============================================================================

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useAuth } from '../../lib/auth/useAuth.js';
import { displayNameFrom, initialsFrom } from '../../lib/profileIdentity.js';
import { navigate } from '../../lib/route.js';

const MENU_ITEM =
  'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-slate-300 transition-colors duration-150 hover:bg-cyan-500/10 hover:text-slate-100 focus-visible:bg-cyan-500/10 focus-visible:text-slate-100 focus-visible:outline-none';

export default function AvatarMenu() {
  const { user, profile, signOut, avatarUrl } = useAuth();
  const [open, setOpen] = useState(false);
  // Broken/blocked avatar URLs are common (Google rotates them, and a strict
  // referrer policy can 403 one). Falling back to initials on `error` keeps the
  // circle full rather than leaving a torn-image glyph in a 36px box.
  // ⚠ The URL that failed, NOT a boolean. A signed URL expires, and the next
  // resolve produces a different one — a boolean latch would suppress that new,
  // working URL forever. Comparing identity resets itself with no effect.
  const [failedUrl, setFailedUrl] = useState(null);

  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const name = displayNameFrom(profile, user);
  const initials = initialsFrom(
    profile?.full_name ?? user?.user_metadata?.full_name ?? user?.user_metadata?.name,
    user?.email,
  );
  // Resolved in AuthContext rather than here: an uploaded picture lives in a
  // private bucket and needs a signed URL, which is async, and doing that per
  // consumer would let the nav and the dashboard disagree about the photo.
  const showImage = Boolean(avatarUrl) && failedUrl !== avatarUrl;

  const close = useCallback(() => setOpen(false), []);

  // ---- dismissal ---------------------------------------------------------
  //
  // ⚠ `pointerdown`, NOT `click`, and on the CAPTURE phase. A `click` listener
  // fires after the target's own handler, so clicking a link behind the menu
  // would navigate *and* leave the menu mounted mid-transition. Capture-phase
  // pointerdown closes first, which is also what makes the dropdown feel
  // instant rather than lagging the press by a frame.
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) close();
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      // Focus must come back to the trigger, or a keyboard user who dismisses
      // the menu is dropped at the top of the document.
      buttonRef.current?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Move focus into the menu on open so the whole thing is reachable without a
  // mouse; the roving arrow keys below then work from a known starting point.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, [open]);

  const onMenuKeyDown = useCallback((event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    // Wraps, so ArrowUp from the first item lands on the last.
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
  }, []);

  // ---- actions -----------------------------------------------------------
  const openDashboard = useCallback(() => {
    close();
    navigate('/student/dashboard');
    window.scrollTo(0, 0);
  }, [close]);

  const handleSignOut = useCallback(async () => {
    close();
    await signOut();
    // Home, not a reload. `signOut()` clears the session and the AuthProvider's
    // listener re-renders every consumer, so a full page load would only cost
    // the visitor the app they already have in memory.
    navigate('/');
  }, [close, signOut]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${name}`}
        className={`grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border bg-surface-raised font-heading text-xs font-bold tracking-wide text-cyan-300 transition-all duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
          open
            ? 'border-cyan-400/70 shadow-[0_0_18px_rgba(0,210,255,0.45)]'
            : 'border-cyan-400/30 hover:border-cyan-400/60 hover:shadow-[0_0_14px_rgba(0,210,255,0.3)]'
        }`}
      >
        {showImage ? (
          <img
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(avatarUrl)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span aria-hidden="true">{initials}</span>
        )}
      </button>

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-[calc(100%+0.6rem)] z-50 w-60 overflow-hidden rounded-xl border border-cyan-500/15 bg-surface/95 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl"
        >
          {/* Identity header. Not a menu item — it is the answer to "whose
              account is this?", which is the first thing a shared-machine user
              needs and the reason the avatar is worth clicking at all. */}
          <div className="border-b border-slate-800/80 px-3 py-3">
            <p className="truncate font-heading text-sm font-semibold text-slate-100">{name}</p>
            {user?.email ? (
              <p className="mt-0.5 truncate text-xs text-slate-500">{user.email}</p>
            ) : null}
          </div>

          <div className="py-1">
            <button type="button" role="menuitem" onClick={openDashboard} className={MENU_ITEM}>
              <ChartIcon />
              Profile &amp; analytics
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleSignOut()}
              className={`${MENU_ITEM} hover:bg-slate-700/20`}
            >
              <ExitIcon />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* Inline SVGs rather than lucide-react imports: two 16px glyphs do not justify
   pulling icon components into the nav's bundle, and these inherit currentColor
   so they follow the hover states above for free. */

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0 opacity-70">
      <path
        d="M4 20V10m6 10V4m6 16v-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0 opacity-70">
      <path
        d="M15 17v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v2M10 12h10m0 0-3-3m3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// =============================================================================
// Nav — logo left, links centre, account avatar or sign-in right.
//
// Brand system per THEME.md: the mark and the gradient CTA are chrome. The
// verdict tokens (--color-verified and friends) are NOT used here — see
// THEME.md §3 before reaching for one.
//
// The signed-in branch is one component: `AvatarMenu` owns the circle, the
// popover, and sign-out. It used to be an inert avatar div plus a separate
// "Sign out" text button rendered side by side here — see that file's header
// for why that pairing was replaced rather than restyled.
// =============================================================================

import { useAuth } from '../../lib/auth/useAuth.js';
import AvatarMenu from './AvatarMenu.jsx';

const LINKS = [
  { href: '#capabilities', label: 'What it detects' },
  { href: '#why', label: 'Why instructors choose it' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#contact', label: 'Contact' },
];

/**
 * @param {object} props
 * @param {() => void} props.onTryDemo
 * @param {() => void} props.onSignIn
 */
export default function Nav({ onTryDemo, onSignIn }) {
  const { user, verified } = useAuth();
  const isSignedIn = Boolean(user || verified);

  return (
    <header className="sticky top-0 z-40 border-b border-cyan-500/10 bg-base/80 backdrop-blur-md">
      <nav
        aria-label="Primary"
        className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6"
      >
        <a href="#top" className="flex shrink-0 items-center gap-2">
          <img
            src="/brand/logo-transparent.png"
            alt="Procminds"
            className="h-7 w-auto drop-shadow-[0_0_10px_rgba(0,210,255,0.4)]"
          />
          <span className="font-heading text-sm font-semibold tracking-tight text-slate-100">
            Procminds
          </span>
        </a>

        <ul className="mx-auto hidden items-center gap-7 lg:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="text-sm text-slate-400 transition-colors duration-300 hover:text-cyan-300"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex shrink-0 items-center gap-3 lg:ml-0">
          {isSignedIn ? (
            <AvatarMenu />
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              className="hidden rounded-md px-3 py-1.5 text-sm text-slate-400 transition-colors duration-300 hover:text-slate-100 sm:block"
            >
              Sign in
            </button>
          )}

          <a
            href="#contact"
            className="hidden rounded-md border border-cyan-500/25 px-3 py-1.5 text-sm text-slate-200 transition-all duration-300 hover:border-cyan-400/50 hover:shadow-[0_0_20px_rgba(6,182,212,0.15)] sm:block"
          >
            Talk to Sales
          </a>
          <button
            type="button"
            onClick={onTryDemo}
            className="rounded-md bg-gradient-to-r from-cyan-500 to-blue-600 px-3.5 py-1.5 text-sm font-semibold text-[var(--color-base)] shadow-[0_0_20px_rgba(6,182,212,0.35)] transition-all duration-300 hover:brightness-110 hover:shadow-[0_0_30px_rgba(6,182,212,0.55)]"
          >
            Try Live Demo
          </button>
        </div>
      </nav>
    </header>
  );
}

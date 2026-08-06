// =============================================================================
// LegalPage — the one component every legal route renders, parameterised by
// slug. Content lives in src/content/legalContent.js; this file is layout only.
//
// Deliberately its own minimal shell rather than reusing the landing page's
// <Nav>/<Footer>. Those carry section anchors (#capabilities, #pricing,
// #contact) that only exist on "/" — rendering them here would produce links
// that silently do nothing on first click (navigate home, then need a second
// scroll nobody triggers). A legal page needs exactly one piece of navigation:
// a way back to "/". It gets that, plus the same logo and dark theme, and
// nothing that promises functionality it doesn't have here.
// =============================================================================

import { Link } from '../../lib/Link.jsx';
import { LEGAL_PAGES } from '../../content/legalContent.js';

/**
 * @param {{slug: string}} props
 */
export default function LegalPage({ slug }) {
  const page = LEGAL_PAGES[slug];

  // Should be unreachable — App.jsx only renders LegalPage for a known slug —
  // but a route table and a content table are two places that can drift out
  // of sync, so this stays a real fallback rather than a silent crash.
  if (!page) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
        <p className="text-slate-400">
          That page doesn’t exist.{' '}
          <Link to="/" className="text-cyan-400 underline underline-offset-2">
            Back to home
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <header className="border-b border-cyan-500/10 bg-base/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <img
              src="/brand/logo-transparent.png"
              alt="Procminds"
              className="h-6 w-auto drop-shadow-[0_0_10px_rgba(0,210,255,0.4)]"
            />
            <span className="font-heading text-sm font-semibold tracking-tight text-slate-100">
              Procminds
            </span>
          </Link>
          <Link
            to="/"
            className="text-sm text-slate-400 transition-colors duration-300 hover:text-cyan-300"
          >
            ← Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        {/* ⚠ Not decorative. This banner is load-bearing — see legalContent.js's
            file header for why the content below has bracketed placeholders
            instead of invented specifics. Do not remove it while any
            [placeholder] remains in the copy it is attached to. */}
        <p className="mb-8 inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-950/30 px-3 py-1 text-xs text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
          Draft — pending legal review. Not yet reviewed by counsel.
        </p>

        <h1 className="font-heading text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
          {page.title}
        </h1>
        <p className="mt-3 text-base text-slate-400">{page.tagline}</p>

        <div className="mt-12 space-y-10">
          {page.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="font-heading text-lg font-semibold text-slate-100">
                {section.heading}
              </h2>
              <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-400">
                {section.body.map((paragraph) => (
                  <p key={paragraph.slice(0, 40)}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-16 border-t border-slate-800/70 pt-8">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-cyan-400 transition-colors duration-300 hover:text-cyan-300"
          >
            ← Back to home
          </Link>
        </div>
      </main>
    </div>
  );
}

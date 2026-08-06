// =============================================================================
// Footer — four columns, per the confirmit-eg.com benchmark: identity + mission,
// social, product links, legal + company info, then the copyright rule.
//
// This footer is only ever rendered on the landing route ("/", see App.jsx) —
// PRODUCT_LINKS' section anchors (#how, #capabilities, …) only exist there.
// LEGAL_LINKS route to real pages instead (src/components/legal/LegalPage.jsx)
// via the in-app <Link>, so they work regardless of which page you're on —
// not that this footer currently renders anywhere else.
// =============================================================================

import { Link } from '../../lib/Link.jsx';

const PRODUCT_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#capabilities', label: 'Capabilities' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#contact', label: 'Contact' },
];

const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/accessibility', label: 'Accessibility statement' },
  { href: '/data-retention', label: 'Data retention' },
];

const SOCIAL_LINKS = [
  { href: 'https://github.com/', label: 'GitHub' },
  { href: '#contact', label: 'Email' },
];

function Column({ title, children }) {
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-widest text-slate-300 uppercase">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

// href starting with "/" is an in-app route (legal pages); everything else
// (#anchor, https://…) is a plain same-page anchor or external link and
// should not go through the client-side router.
function LinkList({ links }) {
  return (
    <ul className="space-y-2">
      {links.map((link) =>
        link.href.startsWith('/') ? (
          <li key={link.label}>
            <Link
              to={link.href}
              className="text-sm text-slate-500 transition-colors duration-300 hover:text-cyan-300"
            >
              {link.label}
            </Link>
          </li>
        ) : (
          <li key={link.label}>
            <a
              href={link.href}
              className="text-sm text-slate-500 transition-colors duration-300 hover:text-slate-200"
            >
              {link.label}
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

export default function Footer() {
  return (
    <footer className="border-t border-slate-800/80 bg-surface/30">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-4">
        <div className="lg:col-span-1">
          <p className="flex items-center gap-2">
            <img
              src="/brand/logo-transparent.png"
              alt="Procminds"
              className="h-7 w-auto"
            />
            <span className="font-heading text-sm font-semibold text-slate-100">
              Procminds
            </span>
          </p>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-500">
            Exam proctoring that reports what it measured, and says so plainly
            when it measured nothing.
          </p>
        </div>

        <Column title="Social">
          <LinkList links={SOCIAL_LINKS} />
        </Column>

        <Column title="Product">
          <LinkList links={PRODUCT_LINKS} />
        </Column>

        <Column title="Legal">
          <LinkList links={LEGAL_LINKS} />
          <address className="mt-5 text-xs leading-relaxed text-slate-600 not-italic">
            procminds.com
            <br />
            Built on an open, testable vision pipeline.
          </address>
        </Column>
      </div>

      <div className="border-t border-slate-800/80">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-slate-600 sm:px-6">
          <p>© {new Date().getFullYear()} Procminds. All rights reserved.</p>
          <p>No video is transmitted from your device by this site.</p>
        </div>
      </div>
    </footer>
  );
}

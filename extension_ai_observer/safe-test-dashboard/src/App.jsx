// =============================================================================
// App — the landing page, assembled from site/ components.
//
// Section order is the sales argument, in the order a Department Head forms it:
//   Hero           → what this is, and what it costs to find out (nothing)
//   Marquee        → the commitments, at a glance
//   BentoGrid      → §1 what it detects
//   WhyInstructors → §2 the three objections
//   Institutional  → §3 the faculty-wide / compliance case
//   Pricing        → flat, per role
//   ContactForm    → where every secondary CTA lands
//
// ⚠ ONE PRIMARY CTA. "Try Live Demo" is the only primary action on the page and
// every secondary path goes to #contact. The Mock Exam entry points were removed
// from Nav and Hero per the sales brief, so its state and modal are gone from
// here too rather than left as wiring nothing can reach.
// `components/MCQQuiz/MCQQuizModal.jsx` is still on disk and still works — it
// simply has no link from the landing page any more.
//
// ⚠ ROUTING. `usePathname()` from lib/route.js branches between the landing
// composition (path "/") and a legal page (one of LEGAL_SLUGS). This is the
// only branch point in the whole app — see lib/route.js and lib/Link.jsx for
// why there's no router library. `public/_redirects` is the other half of
// this working at all for a direct link or a refresh; see that file before
// assuming a broken route is a bug in this component.
//
// State managed here:
//   - demoOpen  → controls ProctorDemoModal visibility
//   - authModal → null | { mode: 'signin'|'signup', role?: string }
// =============================================================================

import { useCallback, useState } from 'react';

import { usePathname, navigate } from './lib/route.js';
import { LEGAL_SLUGS } from './content/legalContent.js';
import LegalPage from './components/legal/LegalPage.jsx';
import DemoQuizPage from './components/MCQQuiz/DemoQuizPage.jsx';
import Nav from './components/site/Nav.jsx';
import Hero from './components/site/Hero.jsx';
import Marquee from './components/site/Marquee.jsx';
import BentoGrid from './components/site/BentoGrid.jsx';
import WhyInstructors from './components/site/WhyInstructors.jsx';
import InstitutionalValue from './components/site/InstitutionalValue.jsx';
import Pricing from './components/site/Pricing.jsx';
import ContactForm from './components/site/ContactForm.jsx';
import AuthModal from './components/site/AuthModal.jsx';
import Footer from './components/site/Footer.jsx';

export default function App() {
  const pathname = usePathname();
  const [authModal, setAuthModal] = useState(null);

  // ---- live demo navigation ----
  const openDemo = useCallback(() => {
    navigate('/demo-quiz');
  }, []);

  // ---- auth modal helpers ----
  const openSignIn = useCallback(() => setAuthModal({ mode: 'signin' }), []);
  const closeAuth = useCallback(() => setAuthModal(null), []);

  // Pricing "onChoose" opens sign-up with the chosen tier's role pre-selected.
  const onPricingChoose = useCallback((role) => setAuthModal({ mode: 'signup', role }), []);

  // Check demo-quiz route first
  if (pathname === '/demo-quiz' || pathname === '/demo') {
    return <DemoQuizPage />;
  }

  // Strip the leading slash once: "/privacy" -> "privacy", matching the keys in LEGAL_SLUGS.
  const legalSlug = pathname.replace(/^\//, '');
  if (LEGAL_SLUGS.includes(legalSlug)) {
    return <LegalPage slug={legalSlug} />;
  }

  return (
    <>
      <Nav onTryDemo={openDemo} onSignIn={openSignIn} />
      <main>
        <Hero onTryDemo={openDemo} />
        <Marquee />
        <BentoGrid />
        <WhyInstructors />
        <InstitutionalValue />
        <Pricing onChoose={onPricingChoose} />
        <ContactForm />
      </main>
      <Footer />

      {/* ---- auth modal ---- */}
      {authModal ? (
        <AuthModal
          mode={authModal.mode}
          initialRole={authModal.role}
          onClose={closeAuth}
        />
      ) : null}
    </>
  );
}


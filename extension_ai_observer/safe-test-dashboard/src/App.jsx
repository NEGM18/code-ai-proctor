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
import DemoGate from './components/site/DemoGate.jsx';
import Footer from './components/site/Footer.jsx';
import { useAuth } from './lib/auth/useAuth.js';

export default function App() {
  const pathname = usePathname();
  const { verified } = useAuth();
  const [authModal, setAuthModal] = useState(null);

  // ---- live demo navigation ----
  //
  // ⚠ THE CTA STILL NAVIGATES WHEN SIGNED OUT — it does not silently become a
  // sign-in button. `DemoGate` owns the wall, so sending an unverified visitor
  // to /demo-quiz shows them what they are signing in FOR, and leaves them on
  // the url Google will return them to. Opening the modal here instead is only
  // a shortcut for the common case, and it must never be the only path: a
  // direct link, a bookmark and a refresh all arrive at the route without
  // passing through this callback.
  const openDemo = useCallback(() => {
    if (!verified) {
      setAuthModal({ mode: 'signin', intent: 'demo' });
      return;
    }
    navigate('/demo-quiz');
  }, [verified]);

  // Sign-in that STARTED as "take me to the demo" finishes there. Without this
  // the visitor completes the code step, the modal closes, and they are back on
  // the landing page having to find the button again — which reads as the
  // sign-in having failed.
  const onAuthVerified = useCallback((intent) => {
    setAuthModal(null);
    if (intent === 'demo') navigate('/demo-quiz');
  }, []);

  // ---- auth modal helpers ----
  const openSignIn = useCallback(() => setAuthModal({ mode: 'signin' }), []);
  const closeAuth = useCallback(() => setAuthModal(null), []);

  // Pricing "onChoose" opens sign-up with the chosen tier's role pre-selected.
  const onPricingChoose = useCallback((role) => setAuthModal({ mode: 'signup', role }), []);

  // Check demo-quiz route first.
  //
  // ⚠ THE GATE WRAPS IT — IT IS NOT A REDIRECT, AND THAT IS DELIBERATE.
  // Bouncing an unverified visitor to "/" would lose the fact that they were
  // trying to reach the demo, and Google's OAuth round trip returns them to
  // THIS url; a redirect here would fight that landing. DemoGate renders the
  // wall in place and swaps in the demo the instant the session is verified,
  // so the post-Google return lands straight in the exam.
  if (pathname === '/demo-quiz' || pathname === '/demo') {
    return (
      <DemoGate>
        <DemoQuizPage />
      </DemoGate>
    );
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
          onVerified={() => onAuthVerified(authModal.intent)}
        />
      ) : null}
    </>
  );
}


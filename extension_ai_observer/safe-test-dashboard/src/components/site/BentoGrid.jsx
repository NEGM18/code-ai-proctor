// =============================================================================
// BentoGrid — SECTION 1: "What it detects", in an instructor's language.
//
// This section used to lead with 478 landmarks, a 0.20 EAR threshold and a
// 500 ms staleness bound, imported from the vision modules so the copy tracked
// the code. That property was worth having and is now gone on purpose: the
// buyer is a Department Head, not a computer-vision engineer, and a number they
// cannot evaluate is not evidence to them — it is noise that makes the page
// feel like documentation. The new copy cites no figures at all, so there is
// nothing here that can silently drift out of date when the engine is retuned.
//
// ⚠ EVERY CLAIM BELOW IS STILL ONE THE ENGINE CAN BACK. Selling to a
// non-technical buyer lowers the *detail*, never the *accuracy*. Two wordings
// are deliberate and should not be "tightened" back up:
//
//   1. "A second person in frame" — NOT "identity verification". There is no
//      face recognition anywhere in this product: it cannot confirm the person
//      sitting the exam is the enrolled student. It detects an extra face, and
//      it detects a photo or looped video held to the lens. Claiming identity
//      matching would be selling a capability that does not exist.
//   2. "No video is uploaded" — NOT "nothing is uploaded". A single evidence
//      snapshot is sent when a violation is actually reported. That distinction
//      is the whole privacy story; blurring it would make the strongest true
//      claim on this page into a false one.
// =============================================================================

const CAPABILITIES = [
  {
    icon: '📱',
    title: 'Phone & secondary device detection',
    body: 'A phone lifted into frame is flagged on the first frame it appears in — not after it has been there for three seconds — and the evidence snapshot is taken at that moment, not once the desk is clear again.',
    note: 'Tuned to ignore notebooks, sticky notes and picture frames.',
  },
  {
    icon: '👀',
    title: 'Sustained off-screen gaze',
    body: 'Flags a candidate whose attention is parked off-screen — down at notes, or across at a second monitor — and holds its fire on the quick, ordinary glances that every honest candidate makes.',
    note: 'A brief look away is recorded, not escalated.',
  },
  {
    icon: '👤',
    title: 'Second person & spoofing attempts',
    body: 'Alerts when another face enters the frame. A photo or looped clip held up to the camera is caught by an on-screen challenge that a still image cannot answer, and covering the lens is reported rather than silently ignored.',
    note: 'Detects an extra person and a faked feed — it does not perform identity matching.',
  },
  {
    icon: '🔒',
    title: 'Zero-video privacy',
    body: 'Analysis runs entirely in the candidate’s own browser. No video stream is uploaded, stored, or sent to us — only a still evidence snapshot, and only when a violation is actually reported.',
    note: 'The model and its runtime are served from your origin, never a third-party CDN.',
  },
];

function Card({ icon, title, body, note }) {
  return (
    <article className="glass rounded-card p-6 transition-all duration-300 hover:border-cyan-500/40 hover:shadow-[0_10px_40px_-10px_rgba(0,210,255,0.25)]">
      <span
        aria-hidden="true"
        className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-500/25 bg-cyan-950/40 text-xl shadow-[0_0_15px_rgba(6,182,212,0.15)]"
      >
        {icon}
      </span>
      <h3 className="font-heading mt-4 text-lg font-semibold text-slate-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
      <p className="mt-4 border-t border-slate-800/70 pt-3 text-xs leading-relaxed text-slate-500">
        {note}
      </p>
    </article>
  );
}

export default function BentoGrid() {
  return (
    <section id="capabilities" className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6">
      <header className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold tracking-widest text-cyan-400 uppercase">
          What it detects
        </p>
        <h2 className="font-heading mt-3 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
          The four things that actually compromise an exam
        </h2>
        <p className="mt-4 text-slate-400">
          Not a list of everything the camera can see — a list of what is worth
          interrupting a candidate over.
        </p>
      </header>

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CAPABILITIES.map((capability) => (
          <Card key={capability.title} {...capability} />
        ))}
      </div>
    </section>
  );
}

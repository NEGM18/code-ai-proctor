// =============================================================================
// legalContent — copy for the four legal pages, kept as data rather than JSX
// so `LegalPage.jsx` has exactly one render path and adding a fifth page later
// is a data entry, not a new component.
//
// ⚠ THIS IS A DRAFT, AND THE PAGES SAY SO. Every bracketed [placeholder] below
// is a fact only the business can supply — legal entity name, registered
// address, governing-law jurisdiction, a real support-response SLA — and none
// of it is invented here. That is the same discipline this codebase already
// applies to FERPA/GDPR wording on the landing page (InstitutionalValue.jsx):
// state the true architecture, and mark what requires counsel or corporate
// detail as exactly that, rather than filling the gap with something that
// merely reads as plausible. Publishing a Terms of Service that quietly
// invents a jurisdiction is a worse failure than an unfinished page, because
// nothing about the page would look unfinished.
//
// Every architectural claim below (zero-video transmission, evidence snapshot
// only on a reported violation, no color-alone status, prefers-reduced-motion)
// is something this codebase actually does — see CLAUDE.md §4 and THEME.md.
// None of it is aspirational copy.
// =============================================================================

export const LEGAL_PAGES = {
  privacy: {
    title: 'Privacy Policy',
    tagline: 'What we process, where it runs, and what we never see.',
    sections: [
      {
        heading: 'The short version',
        body: [
          'Video from your camera is analysed on your own device and is never uploaded, streamed, or stored by us in the ordinary course of a session. The only thing that can leave the device is a single still image, and only at the moment a violation is actually reported — never a continuous recording.',
        ],
      },
      {
        heading: 'Where analysis happens',
        body: [
          'The detection models and the WebAssembly runtime that executes them are downloaded once from our own servers — never a third-party CDN — and then run entirely inside your browser for the rest of the session. Frame-by-frame analysis of head position, gaze, and objects in view happens on your device; we do not receive a video stream to analyse on our end.',
        ],
      },
      {
        heading: 'What we do collect',
        body: [
          'When the on-device analysis reports a violation (for example, a phone detected in frame, or a sustained period of looking away), the session sends us: a single timestamped snapshot image captured at that moment, a description of what was detected, and the exam/session identifier it belongs to.',
          'We also collect ordinary account and session metadata: your email address if you create an account, exam start/end times, and the role your institution has assigned you (student, instructor, or administrator).',
          'We do not collect continuous video or audio at any point. A session with zero reported violations sends us zero evidence images.',
        ],
      },
      {
        heading: 'Consent and the pre-exam check',
        body: [
          'Before any analysis begins, the product shows you a camera preview and a lighting check so you can see exactly what the camera sees before agreeing to proceed. Camera access is requested through your browser’s own permission prompt, which you can revoke at any time from your browser settings — doing so ends the session.',
        ],
      },
      {
        heading: 'Retention',
        body: [
          'Evidence snapshots are retained according to the retention period your institution has configured (see our Data Retention & Deletion Policy). We do not retain video, because we never receive it.',
        ],
      },
      {
        heading: 'Your rights',
        body: [
          'You may request a copy of the evidence associated with your sessions, and you may request deletion of your account and associated evidence, subject to your institution’s academic-integrity record-keeping obligations for exams already in progress or under review.',
        ],
      },
      {
        heading: 'Contact',
        body: [
          'Questions about this policy, or a request under it, can be sent to hello@procminds.com.',
        ],
      },
      {
        heading: 'Controller details',
        body: [
          '[Company legal entity name], [registered address], is the data controller for account data processed under this policy. Institutional customers act as the data controller for their students’ exam data under a separate data processing agreement; [Company legal entity name] acts as processor in that relationship.',
        ],
      },
    ],
  },

  terms: {
    title: 'Terms of Service',
    tagline: 'The agreement between Procminds and the institutions we serve.',
    sections: [
      {
        heading: 'Who this agreement is between',
        body: [
          'These terms govern the use of Procminds by an educational institution — a university, school, or testing center (“the Institution”) — and by the instructors, invigilators, and students the Institution authorises to use the service (“Authorised Users”) in connection with the Institution’s assessments.',
        ],
      },
      {
        heading: 'Authorised use',
        body: [
          'The service may be used only to proctor assessments that the Institution has authorised, and only for the duration of those assessments. Using the service to monitor a person outside of an authorised, time-bounded exam session — or for any purpose other than academic-integrity proctoring — is outside the scope of this agreement.',
        ],
      },
      {
        heading: 'What the service provides',
        body: [
          'Procminds performs on-device analysis and surfaces telemetry and evidence — detected events, timestamps, and evidence snapshots — for a human invigilator or academic-integrity reviewer to evaluate. The service reports what it measured; it does not issue findings of academic misconduct, and it does not automatically fail, flag as guilty, or take disciplinary action against any student. That determination is, and remains, a decision made by the Institution and its staff.',
        ],
      },
      {
        heading: 'Availability',
        body: [
          'We aim to keep the service available during scheduled exam windows and will use commercially reasonable efforts to notify the Institution in advance of planned maintenance. As with any browser-based software, availability also depends on factors outside our control, including the Authorised User’s own device, browser, and network connection. [A specific uptime commitment / SLA, if any, is defined in the Institution’s order form or a separate SLA document, not asserted here as a general figure.]',
        ],
      },
      {
        heading: 'Liability',
        body: [
          'The service is provided on an “as is” basis. To the fullest extent permitted by law, Procminds’ liability arising from this agreement is limited to [amount/formula — e.g. fees paid in the preceding 12 months], and Procminds is not liable for indirect, incidental, or consequential damages. Nothing in this section limits liability that cannot be limited under applicable law.',
        ],
      },
      {
        heading: 'Evidence is not a verdict',
        body: [
          'Because the system explicitly withholds a reading it could not take rather than guessing, an absence of a reported violation is evidence of nothing having been detected — not proof that nothing occurred. Institutions should treat every report, positive or absent, as one input into a human decision, not as an automated verdict.',
        ],
      },
      {
        heading: 'Termination',
        body: [
          'Either party may terminate this agreement as set out in the Institution’s order form. On termination, we will stop processing new sessions and will handle existing evidence in line with the retention period then in effect, or an earlier deletion request from the Institution.',
        ],
      },
      {
        heading: 'Governing law',
        body: [
          'This agreement is governed by the laws of [jurisdiction], without regard to its conflict-of-laws principles. [Dispute resolution / venue clause to be finalised with counsel.]',
        ],
      },
    ],
  },

  accessibility: {
    title: 'Accessibility Statement',
    tagline: 'What we commit to, and what we have actually verified.',
    sections: [
      {
        heading: 'Our commitment',
        body: [
          'We are committed to making Procminds usable by people with disabilities, and we target conformance with the Web Content Accessibility Guidelines (WCAG) 2.1 at Level AA across this site and the product itself. This is a statement of the standard we build to and are actively working toward across the whole surface of the product — it is not a claim of certified, independently audited conformance.',
        ],
      },
      {
        heading: 'What this site does today',
        body: [
          'Interactive elements are reachable and operable by keyboard alone, with visible focus states. Decorative visuals — background glow, grid patterns, the floating logo mark — are marked so screen readers skip them and only announce actual content.',
          'This site respects your operating system’s reduced-motion preference: with “reduce motion” enabled, ambient animation and transitions are disabled sitewide, not just on request.',
          'No status in the product is communicated by colour alone. The core proctoring interface renders an unreadable measurement as a diagonal hatch pattern or a text dash — a distinct shape and label, not merely a different colour — specifically because colour-only status indicators are unreliable for colour-blind users and for anyone relying on a screen reader.',
        ],
      },
      {
        heading: 'Known limitations',
        body: [
          'We do not yet have a completed VPAT (Voluntary Product Accessibility Template) or a third-party accessibility audit. One is available on request from institutional customers evaluating procurement, and we will note any known gaps against WCAG 2.1 AA honestly at that point rather than asserting a pass we have not verified.',
        ],
      },
      {
        heading: 'Feedback',
        body: [
          'If you encounter an accessibility barrier anywhere on this site or in the product, tell us — hello@procminds.com — and include the page or feature involved. We treat accessibility reports as defects, not feature requests.',
        ],
      },
    ],
  },

  'data-retention': {
    title: 'Data Retention & Deletion Policy',
    tagline: 'What is kept, for how long, and how it is removed.',
    sections: [
      {
        heading: 'Raw video: never stored',
        body: [
          'Video from the camera is processed in memory, on-device, for the duration of a session and is never transmitted to us or written to persistent storage — by us or, in normal operation, by the browser extension itself. When a session ends (the exam finishes, the tab closes, or the candidate revokes camera permission), the in-memory frame buffer is discarded along with it. There is no local recording to purge, because none is made.',
        ],
      },
      {
        heading: 'Evidence snapshots: retained on a configurable schedule',
        body: [
          'The one artifact that is stored is the evidence snapshot captured at the moment a violation is reported — a single still image, not a clip. Institutions choose a retention period for these snapshots: 30, 60, or 90 days are the standard options, after which they are automatically and permanently deleted. Longer or custom retention windows can be arranged for institutions with specific record-keeping obligations.',
        ],
      },
      {
        heading: 'Session and incident metadata',
        body: [
          'Timestamps, the type of event detected, and which exam session it belongs to are retained alongside the evidence for the same configured period, so a reviewer can make sense of the image without it being retained separately or for longer.',
        ],
      },
      {
        heading: 'Deletion on request',
        body: [
          'A candidate or an institution administrator may request deletion of a candidate’s stored evidence and account data ahead of the standard retention schedule. We process such requests promptly, subject to any evidence that is part of an active, unresolved academic-integrity review at the Institution — which the Institution, not us, is responsible for identifying and flagging as under review.',
        ],
      },
      {
        heading: 'Backups',
        body: [
          'Deleted data may persist briefly in encrypted backups until the normal backup rotation cycle overwrites it. It is not accessible or restorable for ordinary use once a deletion has been processed.',
        ],
      },
      {
        heading: 'Contact',
        body: [
          'To request deletion or ask about a specific retention period, contact hello@procminds.com.',
        ],
      },
    ],
  },
};

export const LEGAL_SLUGS = Object.keys(LEGAL_PAGES);

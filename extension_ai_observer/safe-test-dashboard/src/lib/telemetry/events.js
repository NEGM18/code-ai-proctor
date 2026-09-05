// =============================================================================
// src/lib/telemetry/events.js
//
// The event vocabulary, frozen. Nothing in this codebase types an event name as
// a bare string at a call site.
//
// ⚠ WHY A CATALOGUE RATHER THAN INLINE STRINGS. PostHog creates an event
// definition the first time it sees a name and never deletes it, so a typo is
// permanent: `proctor_sitting_started` and `proctor_sitting_startd` become two
// series that each hold half the truth, and nothing raises an error at any
// point. Importing a constant turns the typo into a build failure instead.
//
// NAMING CONVENTION — `<domain>_<subject>_<past-tense verb>`, snake_case:
//   domain   which surface the event belongs to (proctor, review, edge, ui)
//   subject  the thing it happened to
//   verb     PAST TENSE. An event records something that has already happened;
//            a present-tense name reads like a command and invites emitting it
//            before the fact, which is how a "started" event ends up counting
//            attempts rather than starts.
//
// ⚠ EVENT NAMES ARE FOREVER. Renaming one silently splits every historical chart
// that referenced it. Add a new name and deprecate the old one in a comment;
// never edit a string in place.
// =============================================================================

export const EVENTS = Object.freeze({
  // --- Sitting lifecycle ----------------------------------------------------
  /** A sitting began. Carries sitting_mode, never the candidate's identity. */
  SESSION_STARTED: 'proctor_sitting_started',
  SESSION_STOPPED: 'proctor_sitting_stopped',
  /** The on-time handshake graded. Carries the verdict, not the nonce. */
  HANDSHAKE_GRADED: 'proctor_handshake_graded',
  /** Pre-exam advisories. Neither may ever block — CLAUDE.md §5. */
  LIGHTING_ADVISED: 'proctor_lighting_advised',
  FRAMING_ADVISED: 'proctor_framing_advised',

  // --- Detector pipeline ----------------------------------------------------
  /**
   * A violation was REPORTED by the extension.
   *
   * ⚠ THIS IS A PIPELINE MEASUREMENT, NOT A FINDING ABOUT A PERSON. It exists to
   * answer "is the detector firing at a plausible rate", and it must never be
   * joined back to an identified person profile in order to judge one.
   */
  VIOLATION_REPORTED: 'proctor_violation_reported',
  /** A violation the suppression stack withheld. The counterweight to the above. */
  VIOLATION_SUPPRESSED: 'proctor_violation_suppressed',
  /** Vision engine readiness — model load, tier, provider. */
  ENGINE_READY: 'proctor_engine_ready',

  // --- Gemini review + budget ----------------------------------------------
  /** One analyze-snapshot round trip settled. */
  AI_REVIEW_SETTLED: 'review_snapshot_settled',
  /** MAX_SNAPSHOTS_PER_SITTING or MAX_REVIEWS_PER_DAY refused a call. */
  BUDGET_CAP_EXCEEDED: 'review_budget_cap_exceeded',
  /** A >= STOP_CONFIDENCE CHEATING verdict closed the sitting early. */
  EARLY_STOP_TRIGGERED: 'review_early_stop_triggered',

  // --- Edge / crypto observability ------------------------------------------
  /** Any supabase.functions.invoke round trip. */
  EDGE_RPC_SETTLED: 'edge_rpc_settled',
  /** unseal-snapshot specifically — decryption outcome, kid, never payload. */
  UNSEAL_SETTLED: 'edge_unseal_settled',

  // --- Diagnostics ----------------------------------------------------------
  /** Structured lifecycle logging. Level rides as a property. */
  LOG: 'procminds_log',
  /** captureProctorError's companion for handled (non-thrown) failures. */
  PIPELINE_ERROR: 'proctor_pipeline_error',

  // --- Product surfaces -----------------------------------------------------
  FLAG_DISPUTED: 'ui_flag_disputed',
  EVIDENCE_VIEWED: 'ui_evidence_viewed',
});

/** Structured log levels, ordered least to most severe. */
export const LOG_LEVEL = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
});

/**
 * The two values `sitting_mode` may take.
 *
 * ⚠ THIS MIRRORS `monitor.js`'s `sittingMode`, WHICH IS EXAM POLICY DECLARED BY
 * THE PAGE — never `guestSessionMode`, which is a hardware profile inferred from
 * the hostname. CLAUDE.md §5 forbids conflating them: a real exam served from a
 * pages.dev host is still a real exam, and reading the hardware flag here would
 * label it a demo in every chart anyone ever builds from this data.
 */
export const SITTING_MODE = Object.freeze({
  DEMO: 'DEMO',
  CLASSROOM: 'CLASSROOM',
});

/** Which half of the product emitted an event. Registered as a super property. */
export const APP_SOURCE = Object.freeze({
  WEB: 'procminds_web',
  EXTENSION: 'procminds_extension',
  EDGE: 'procminds_edge',
});

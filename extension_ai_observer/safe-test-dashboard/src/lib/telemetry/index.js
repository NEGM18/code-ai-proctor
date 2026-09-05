// =============================================================================
// src/lib/telemetry/index.js — barrel export for this module's public surface.
//
// ⚠ APP CODE IMPORTS FROM HERE, NEVER FROM `posthog-js` DIRECTLY. That is what
// guarantees every outgoing property has passed `redactProperties`. A component
// that reaches for the SDK itself bypasses the scrubber, the event catalogue and
// the survey guard in a single line, and nothing would flag it.
// =============================================================================

import { capture as _capture, log as _log, flag as _flag } from './posthog.js';
import { captureProctorError as _captureProctorError } from './errors.js';

export { TelemetryProvider } from './TelemetryProvider.jsx';

export {
  initTelemetry,
  isTelemetryConfigured,
  setSittingMode,
  setSittingActivePredicate,
  identify,
  resetIdentity,
  capture,
  log,
  flag,
  onFlagsReady,
  maybeShowSurvey,
} from './posthog.js';

export {
  captureProctorError,
  installGlobalErrorHandlers,
  reportPipelineFailure,
  PIPELINE_STEP,
} from './errors.js';

export {
  trackAiReview,
  trackEdgeRpc,
  trackUnseal,
  wrapReviewFlaggedSnapshot,
  AGREEMENT,
} from './pipeline.js';

export {
  FLAGS,
  useFlag,
  getFlag,
  assertNotSafetyCritical,
  requestPostSittingSurvey,
  requestDisputeSurvey,
} from './flags.js';

export { EVENTS, LOG_LEVEL, SITTING_MODE, APP_SOURCE } from './events.js';

export { redactProperties, scrubText, hashId } from './redact.js';

/**
 * Convenience accessor for components.
 *
 * ⚠ NOT A CONTEXT CONSUMER, AND IT NEEDS NO PROVIDER ABOVE IT. The telemetry
 * client is a module singleton (posthog-js is itself one), so routing it through
 * React context would add a re-render dependency for no isolation benefit, and
 * would make `capture()` unavailable to non-component code — which is most of
 * the call sites that matter. `<TelemetryProvider>` exists to run effects (init,
 * identity sync, pageviews), not to supply a value.
 *
 * @returns {{capture: Function, log: Function, flag: Function, captureProctorError: Function}}
 */
export function useTelemetry() {
  return {
    capture: _capture,
    log: _log,
    flag: _flag,
    captureProctorError: _captureProctorError,
  };
}

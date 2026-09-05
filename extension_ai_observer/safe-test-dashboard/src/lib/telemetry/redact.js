// =============================================================================
// src/lib/telemetry/redact.js
//
// The zero-plaintext spine. Every property that leaves this app for PostHog
// passes through `redactProperties()`, and every free-text string passes
// through `scrubText()`.
//
// ⚠ THIS FILE IS THE ONE THAT MATTERS. Everything else in src/lib/telemetry/ is
// plumbing; this is the part whose failure is a privacy breach rather than a
// missing metric. A bug here does not surface as an error — it surfaces as a
// webcam frame sitting in a vendor's database, discovered months later by
// somebody who was not looking for it.
//
// ⚠ IT IS DEFENCE IN DEPTH, NOT A LICENCE. Call sites must still refuse to pass
// a frame. A scrubber that call sites rely on is one regex away from being the
// only thing between a candidate's face and a third party, and it will
// eventually meet a shape nobody anticipated. Pass the LENGTH of a thing, never
// the thing.
//
// ⚠ WHY A DENYLIST OF KEYS *AND* A VALUE SNIFFER, RATHER THAN EITHER ALONE.
// Key names are reliable for the properties this codebase authors
// (`imageB64`, `observation`) and useless for a property some future caller
// spreads in from an API response. Value sniffing is the reverse: it catches
// `{ x: '<a 200KB base64 run>' }` whatever the key is called, and it cannot see
// that `email` is sensitive because an email looks like ordinary text. Neither
// covers the other's blind spot, so both run.
// =============================================================================

/**
 * Property KEY names that must never be transmitted, matched case-insensitively
 * against the whole key.
 *
 * ⚠ BE GENEROUS. A false positive costs one dropped property on a dashboard
 * nobody is currently reading. A false negative is a privacy incident. When in
 * doubt about whether something belongs here, it belongs here.
 *
 * ⚠ `observation` AND `cheat_reason` ARE ON THIS LIST AND THAT IS NOT AN
 * OVERSIGHT. They hold Gemini's one-sentence description of a webcam frame —
 * "the candidate is holding a phone near their face". That is a natural-language
 * rendering of biometric content, and it is the single most likely thing for a
 * well-meaning implementation to send, because it reads as a harmless string.
 * `analyze-snapshot/index.ts` returns it as `observation` and again as
 * `explanation`; both are matched.
 */
export const SENSITIVE_KEY_PATTERN = Object.freeze(
  new RegExp(
    '^(?:'
    // --- raw or derived biometric content -----------------------------------
    + 'image|imageb64|imagebase64|image_base64|img|frame|frameb64|snapshot'
    + '|snapshotb64|snapshot_b64|snapshoturl|dataurl|data_url|objecturl'
    + '|canvas|pixels|imagedata|bitmap|thumbnail|thumb|photo|avatar|avatarurl'
    + '|landmarks|keypoints|facelandmarks|descriptor|embedding|iris|ear'
    // --- Gemini's prose description of a frame ------------------------------
    + '|observation|explanation|cheat_reason|cheatreason|reasoning|narrative'
    // --- envelope internals and key material --------------------------------
    + '|ciphertext|plaintext|envelope|ek|iv|sha256|digest|signature|sig'
    + '|privatekey|private_key|signingkey|signing_key|publickey|public_key'
    + '|keymaterial|key_material|secret|password|passphrase|pin'
    // --- credentials ---------------------------------------------------------
    + '|apikey|api_key|anonkey|anon_key|servicerolekey|service_role_key'
    + '|accesstoken|access_token|refreshtoken|refresh_token|idtoken|id_token'
    + '|token|jwt|bearer|authorization|auth|credential|cookie|session_token'
    // --- direct identifiers --------------------------------------------------
    + '|email|emailaddress|email_address|mail|fullname|full_name|displayname'
    + '|firstname|lastname|phone|phonenumber|address|dob|studentname'
    + '|student_name|organizationname|organization_name'
    + ')$',
    'i',
  ),
);

/**
 * How long a base64-ish run has to be before the value sniffer calls it a blob.
 *
 * ⚠ 64 IS CHOSEN AGAINST THE REAL IDENTIFIERS IN THIS CODEBASE, not picked for
 * roundness. The things that must survive are all shorter: a UUID is 36
 * characters, `analyze-snapshot`'s `requestId` is 8, a Supabase publishable key
 * is ~44, a `kid` is 16 hex. The things that must not are all far longer: a
 * JPEG data URL is tens of thousands of characters, a PMSEAL1 envelope likewise.
 * The gap is three orders of magnitude wide, so the exact cut-off inside it is
 * not load-bearing — which is the property to preserve if this is ever retuned.
 *
 * ⚠ THE ~44-CHARACTER SUPABASE KEY IS DELIBERATELY BELOW THE LINE. It is caught
 * by SENSITIVE_KEY_PATTERN (`anonKey`, `apiKey`) rather than by length, because
 * lowering this threshold to reach it would start eating legitimate ids. Key
 * names catch the named cases; length catches the unnamed ones.
 */
const MIN_BLOB_RUN = 64;

const DATA_URL = /^\s*data:/i;
const BLOB_URL = /^\s*blob:/i;
const BASE64_RUN = new RegExp('[A-Za-z0-9+/_-]{' + MIN_BLOB_RUN + ',}={0,2}');
const HEX_RUN = /[0-9a-f]{128,}/i;
/** Three base64url segments joined by dots — a JWT, whatever the key is called. */
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
/** `PMSEAL1` as raw text, and as the base64 prefix its magic bytes produce. */
const PMSEAL_RAW = /PMSEAL1/;
const PMSEAL_B64 = /UE1TRUFMMQ/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /\b[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/g;

/**
 * Does this string look like encoded content rather than a label?
 *
 * ⚠ ORDERED CHEAPEST-FIRST, and the PMSEAL tests come before the generic base64
 * one on purpose: an envelope IS a long base64 run, so the generic test would
 * catch it anyway — but the specific test NAMES what was caught, which is the
 * difference between a useful redaction log and a mystery.
 *
 * @param {unknown} value
 * @returns {string|null} A short reason when it is a blob, else null.
 */
export function looksLikeEncodedBlob(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (DATA_URL.test(value)) return 'data-url';
  if (BLOB_URL.test(value)) return 'blob-url';
  if (PMSEAL_RAW.test(value) || PMSEAL_B64.test(value)) return 'pmseal-envelope';
  if (JWT_SHAPE.test(value)) return 'jwt';
  if (value.length >= MIN_BLOB_RUN && BASE64_RUN.test(value)) return 'base64-run';
  if (HEX_RUN.test(value)) return 'hex-run';
  return null;
}

/**
 * Strip identifiers and encoded content out of free text.
 *
 * ⚠ USED ON ERROR MESSAGES AND STACK FRAMES, WHICH ARE UNTRUSTED. A DOMException
 * from getUserMedia, a PostgREST error body, and a fetch() TypeError naming a
 * signed URL all arrive here. `String(error)` on any of them can carry a token
 * in a query string, or an entire data: URL that some engine helpfully embedded
 * in the message.
 *
 * ⚠ EMAILS ARE REPLACED, NOT HASHED. See hashId's note — a hash of a
 * low-cardinality value is not anonymisation.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function scrubText(value, maxLength = 500) {
  let str = value;
  if (typeof str !== 'string') {
    if (str === null || str === undefined) return '';
    str = String(str);
  }

  let out = str
    .replace(EMAIL, '[email]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(JWT_SHAPE, '[jwt]');

  // Collapse anything that survived and still looks like payload. Done as a
  // global replace rather than by returning a bare marker, so the surrounding
  // words — which are the diagnostic value of a message — are preserved.
  out = out
    .replace(/data:[a-z0-9.+-]*\/?[a-z0-9.+-]*;base64,[A-Za-z0-9+/=]*/gi, '[data-url]')
    .replace(/blob:[^\s"')]+/gi, '[blob-url]')
    .replace(new RegExp('[A-Za-z0-9+/_-]{' + MIN_BLOB_RUN + ',}={0,2}', 'g'), '[blob]');

  return out.length > maxLength ? out.slice(0, maxLength) + '…[truncated]' : out;
}

/**
 * Constructors whose CONTENT is never telemetry but whose SHAPE sometimes is.
 *
 * ⚠ MATCHED BY CONSTRUCTOR NAME, NOT `instanceof`, and that is deliberate. This
 * module must be importable under vitest's default `environment: 'node'`, where
 * `Blob` exists but `HTMLCanvasElement` and `MediaStream` do not. An `instanceof`
 * against an undefined global is a ReferenceError, and a telemetry module that
 * throws at import time takes the app down with it — the failure mode
 * `src/lib/supabase.js` documents at length and refuses.
 */
function typeTagFor(value) {
  if (ArrayBuffer.isView(value)) {
    const viewCtor = (value.constructor && value.constructor.name) || 'TypedArray';
    return '[redacted:' + viewCtor + '(' + (value.length ?? value.byteLength) + ')]';
  }
  if (value instanceof ArrayBuffer) return '[redacted:ArrayBuffer(' + value.byteLength + ')]';

  const ctor = value && value.constructor && value.constructor.name;
  if (!ctor) return null;

  const OPAQUE = [
    'Blob', 'File', 'FileList', 'ImageData', 'ImageBitmap', 'OffscreenCanvas',
    'HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement', 'MediaStream',
    'MediaStreamTrack', 'CanvasRenderingContext2D', 'CryptoKey', 'FormData',
    'VideoFrame',
  ];
  if (OPAQUE.indexOf(ctor) !== -1) {
    const size = typeof value.size === 'number' ? '(' + value.size + ')' : '';
    return '[redacted:' + ctor + size + ']';
  }
  return null;
}

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

/**
 * Recursively scrub one value.
 *
 * ⚠ THREE GUARDS, EACH FOR A DIFFERENT WAY THIS CAN GO WRONG:
 *   depth  — a deep object would recurse until the stack blows. Telemetry must
 *            not be able to crash the page it is observing.
 *   seen   — a CYCLIC object (a React fiber, a DOM node, an error holding its
 *            own context) would hang forever. `monitor.js` state objects are
 *            exactly this shape.
 *   arrays — a landmark array is 478 points. The first 50 is already more than
 *            telemetry needs, and it caps the payload.
 *
 * ⚠ ACCESSOR PROPERTIES ARE SKIPPED, NOT READ. Reading a getter runs arbitrary
 * code inside the telemetry path — it can throw, it can be slow, and it can
 * synthesise a value that was never stored. That last one is the interesting
 * case: a getter (or a Proxy trap) is how a value could otherwise be handed to
 * telemetry without ever appearing as a plain property a reviewer would notice.
 * The shape is recorded instead. This is why the walk uses
 * getOwnPropertyDescriptors rather than Object.entries.
 *
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @param {{count: number}} dropped
 */
function redactValue(value, depth, seen, dropped) {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value) + 'n';
  if (t === 'function') return '[redacted:function]';
  if (t === 'symbol') return '[redacted:symbol]';

  if (t === 'string') {
    const why = looksLikeEncodedBlob(value);
    if (why) {
      dropped.count += 1;
      return '[redacted:' + why + '(' + value.length + ')]';
    }
    return scrubText(value);
  }

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    // Errors get proper handling in errors.js; this is the path where one has
    // been hung on a property as context. Keep the identity, drop the rest.
    return {
      name: scrubText(value.name, 80),
      message: scrubText(value.message, 300),
    };
  }

  const tag = typeTagFor(value);
  if (tag) {
    dropped.count += 1;
    return tag;
  }

  if (depth >= MAX_DEPTH) return '[redacted:max-depth]';

  if (seen.has(value)) return '[redacted:circular]';
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map(function mapItem(v) {
        return redactValue(v, depth + 1, seen, dropped);
      });
      if (value.length > MAX_ARRAY) out.push('[…' + (value.length - MAX_ARRAY) + ' more]');
      return out;
    }

    if (value instanceof Map) return '[redacted:Map(' + value.size + ')]';
    if (value instanceof Set) return '[redacted:Set(' + value.size + ')]';

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out = {};
    for (const key of Object.keys(descriptors)) {
      const d = descriptors[key];
      // An accessor is never invoked — see the header note.
      if (typeof d.get === 'function') {
        out[key] = '[redacted:getter]';
        continue;
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        dropped.count += 1;
        const v = d.value;
        // The LENGTH of a dropped blob is genuinely useful telemetry — it is how
        // you tell "the frame was empty" from "the frame was 2 MB" without ever
        // holding the frame. Emit that and nothing else.
        let len = null;
        if (typeof v === 'string') len = v.length;
        else if (v && typeof v.length === 'number') len = v.length;
        else if (v && typeof v.byteLength === 'number') len = v.byteLength;
        out[key + '_redacted'] = len === null ? true : '[redacted(' + len + ')]';
        continue;
      }
      out[key] = redactValue(d.value, depth + 1, seen, dropped);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * The top-level entry point. Returns a NEW plain object safe to hand to PostHog.
 *
 * ⚠ THE DROP IS ITSELF REPORTED. `$redacted_count` rides on every event that lost
 * something. A scrubber that silently eats properties is indistinguishable from
 * a call site that never sent them, and the difference matters: the first is the
 * safety net working, the second is a metric nobody wired up. Without this you
 * cannot tell them apart from the dashboard.
 *
 * @param {Record<string, unknown>|null|undefined} props
 * @returns {Record<string, unknown>}
 */
export function redactProperties(props) {
  if (!props || typeof props !== 'object') return {};
  const dropped = { count: 0 };
  const out = redactValue(props, 0, new WeakSet(), dropped);
  const safe = (out && typeof out === 'object' && !Array.isArray(out)) ? out : {};
  if (dropped.count > 0) safe.$redacted_count = dropped.count;
  return safe;
}

/**
 * A short, stable, non-reversible correlator.
 *
 * FNV-1a with the same offset basis (0x811c9dc5) and prime (16777619) that
 * `monitor.js:4946` uses for its frame signature — one definition of "cheap
 * stable hash" in this codebase, the same rule `ear_veto.js` follows for
 * `eyeAspectRatio`.
 *
 * ⚠ THIS IS CORRELATION, NOT ANONYMITY, AND THE DISTINCTION IS THE WHOLE POINT.
 * A 32-bit hash of a low-cardinality input is trivially inverted by anyone who
 * can enumerate the input space — and an email address IS low-cardinality
 * against a known student roster. So this must never be used on an email, a
 * name, or anything else drawn from a guessable set. The rule for those is that
 * they are DROPPED (see SENSITIVE_KEY_PATTERN), not hashed. Hashing them would
 * produce something that looks anonymised in a code review and is not.
 *
 * Use it for high-entropy internal ids — a sitting id, a session id — where the
 * goal is "join these events together", not "hide who this is".
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function hashId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return 'h:' + (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Bumped whenever the rules above change.
 *
 * ⚠ THE EXTENSION CARRIES A SEPARATE COPY OF THESE RULES and cannot import this
 * file — a content script has no bundler and `extension/` has no build step.
 * `extension/background/telemetry_transport.js` mirrors them and pins this
 * number, so a change here that is not mirrored there fails that suite loudly
 * rather than leaving the two halves silently divergent.
 */
export const REDACT_CONTRACT_VERSION = 1;

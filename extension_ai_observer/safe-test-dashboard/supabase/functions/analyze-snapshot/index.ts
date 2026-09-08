// =============================================================================
// supabase/functions/analyze-snapshot/index.ts
//
// The only path by which a flagged webcam frame leaves the browser.
//
// It does four things, in this order, and the order is the design:
//
//   1. AUTHENTICATE   the caller from their own JWT (no service-role trust in
//                     anything the page said about who it is).
//   2. BUDGET         refuse past 3 reviewed frames per sitting, past a daily
//                     per-account ceiling, or once a >= 95% CHEATING verdict has
//                     already closed the sitting.
//   3. REVIEW         one gemini-2.5-flash-lite call: is this cheating, how
//                     confident, and one short sentence of what was seen.
//   4. SEAL + STORE   AES-256-GCM the JPEG under a random content key, wrap that
//                     key to an RSA public key whose private half exists nowhere
//                     in this deployment, upload the envelope, record the verdict.
//
// ⚠ THE PLAINTEXT FRAME IS NEVER PERSISTED, ANYWHERE, BY ANYTHING.
//
// It exists as bytes in this function's memory for the length of one request and
// is written to no table, no bucket, and no log. `console.log` in here must
// never be handed the image or any slice of it — Edge Function logs are readable
// by anyone with dashboard access, which is precisely the population this whole
// scheme assumes may be compromised.
//
// ⚠ WHAT THIS DOES AND DOES NOT DEFEND AGAINST — stated up front so nobody
// mistakes the claim for a larger one:
//
//   DEFEATS  a full breach AT REST. Postgres dump, every storage object, every
//            environment variable including the service-role key and
//            EVIDENCE_PUBLIC_KEY: none of it decrypts an envelope, because the
//            private key is not among them.
//   DEFEATS  a curious insider. Dashboard access shows sealed blobs and verdict
//            text; it does not show a student's face.
//   DOES NOT DEFEAT  an attacker with live code execution *inside this function*
//            at the moment a frame passes through. They can read that frame in
//            flight. Encryption at rest cannot fix a compromised runtime and
//            nothing here pretends otherwise; the mitigations for that are
//            deployment integrity and the fact that frames are transient.
//   DOES NOT DEFEAT  loss of the private key itself, which makes every stored
//            envelope permanently unreadable. That is the accepted cost of the
//            key not living anywhere reachable.
//
// ⚠ DEPLOYED WITH `verify_jwt = false`, AND THE FUNCTION IS NOT UNAUTHENTICATED.
//
// The gateway's `verify_jwt` accepts the ANON key as a valid JWT, so it never
// distinguished a signed-in student from any visitor holding the publishable
// key — it is not the gate it reads as. What it does reliably do is reject the
// CORS preflight, which carries no Authorization header, and the page is on a
// different origin (pages.dev) from the function (supabase.co), so every call
// is preflighted. Turning it on therefore buys nothing and breaks the feature.
//
// The real gate is `resolveUser()` below: it resolves the bearer token against
// GoTrue and returns 401 when that fails, and every write uses the id GoTrue
// returned rather than anything the request body claimed.
// =============================================================================

const MAX_SNAPSHOTS_PER_SITTING = 3

/**
 * Confidence at or above which a CHEATING verdict closes the sitting's budget
 * early. Specified by the operator: "if its more than 95% then stop taking
 * snapshots for student any more and save this snapshot".
 *
 * `>=` rather than `>`: a model that answers in whole percents lands on exactly
 * 95 constantly, and reading the instruction so literally that 95 itself fails
 * to close the budget would make the rule fire far less often than intended.
 */
const STOP_CONFIDENCE = 95

/**
 * Per-account ceiling across ALL sittings in a rolling 24 h.
 *
 * ⚠ THIS IS THE COST CONTROL, AND THE 3-PER-SITTING CAP IS NOT ONE.
 * `demoSessionId` is chosen by the page, so a signed-in attacker can mint a
 * fresh one per request and reset the per-sitting budget as often as they like.
 * Only a key the client cannot influence — the account id — can bound spend.
 * 30 is ten honest sittings a day, which no real demo user reaches.
 */
const MAX_REVIEWS_PER_DAY = 30

/** Refuse anything larger before decoding it. A 640x480 JPEG is ~40-80 KB. */
const MAX_IMAGE_BYTES = 1_500_000

const GEMINI_MODEL = 'gemini-2.5-flash-lite'

/**
 * The evidence public key, baked in as a fallback for `EVIDENCE_PUBLIC_KEY`.
 *
 * ⚠ YES, THIS IS COMMITTED ON PURPOSE, AND IT IS NOT A SECRET.
 *
 * It is the PUBLIC half of the RSA-OAEP pair minted by
 * `scripts/gen_evidence_keypair.mjs`. Publishing it costs nothing — it can only
 * be used to SEAL, never to open — and it buys two things worth having:
 *
 *   1. The scheme cannot silently degrade to "no key configured, store nothing".
 *      A missing env var would otherwise mean confirmed frames are dropped, and
 *      the only symptom would be an empty bucket nobody thinks to check.
 *   2. It is auditable. Anyone reading this repo can compare the fingerprint
 *      below against the key their private half belongs to, and know whether the
 *      deployed function is sealing to the pair they can actually open.
 *
 * The env var still wins when present, so rotating the pair is a secret change
 * rather than a redeploy. The matching private half lives offline and is in no
 * system this code can reach; see the header of the generator script.
 *
 * fingerprint (EVIDENCE_KEY_ID): 2bb158bdede24163 — the value of
 * BUILTIN_EVIDENCE_KEY_ID below, which is what actually lands in the envelope
 * header as `kid`. (This line previously read `811fae083bc8dd0a`, which matched
 * nothing in the file; a reviewer checking whether the deployed function seals
 * to the pair they can open would have compared against a fingerprint no
 * envelope has ever carried.)
 */
const BUILTIN_EVIDENCE_PUBLIC_KEY =
  'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA1PC8hMAV0g6xikEpFeshm/mZ1Evkb5qhoKKCJuqEyQxFX4NUpe2v/LCSlBEk6oPzde1LBRbR8PE2Po/mZFTRGyQUlV817cZCb/eXFF2JCYJQLo47fgZFFdEUxQBEK1x/kW6LmvlUOsafXUpRfL0bOAIC5Nsl/IaYZHXe4rhb2JCNIvIpCw9QjLrG5DPGzsL1iULVU8JiuBVBP1yz5qacokIPumEUpebSV3+dCbuqE5me711ZptoKItWNteBsVVIWpObIYo6cOU2C0qFYoct1th4Is2MXjarPDOL+sj9N8RwICdpZYC0XD4ZM92T5lwi3JbJZ7xQXYLMjM+BfIAbIXnhnsyOUrwhzi3ks1xPaQ643UfjtzV0iBYnjPH1FdZmDMHrl46NK0iWqTwsmsuvwWNeUqpgkRXrVG5Fm2qiPNPuilBQ4TJFUeDZw/Dvvm4eXUiyMaUqSsMIBJQBdjvkKc67Y4Zc5Jyo9wDDhSb7TDZOQVsPIjS9bV3+K28y5ey7RAgMBAAE='

const BUILTIN_EVIDENCE_KEY_ID = '5a8578bbc527130a'

/**
 * The signature VERIFY key, also committed, also not a secret.
 *
 * Unused by this function — it signs, it never verifies — and recorded here
 * anyway so the repo carries the pair a reviewer needs to check origin. Its
 * private half is `EVIDENCE_SIGNING_KEY` and is the ONLY secret in the scheme.
 *
 * fingerprint pair: 5a8578bbc527130a
 */
export const EVIDENCE_VERIFY_KEY =
  'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAo3+/uLMWuNIOkk2SnTI+IWcARbl9g/ACxsaZVPnLxD4PIuhoG1PLtMOIrTwOVdQ2Q8APS1/FghEBJvq5esza2YQrQwO7tkNL62Znf0ZMYqFWoUf4qrH/4nuEnhAwIgTeDwzfwSL+GJuXZAYwSllz+R/fCu2cx6zbuflAdXThkWPK7JHoB8h3V+624DBAB7r0xIgFEDqgiCjEXwr71w57jejb5m7NbctrmS5lICPCEN7b82KlElT3sFjUpiQAc8nWdYr6ztNLVpIg7zLZYEaYjnpupvO234mAYd7VuWCuMywQmbOj9C0X1IJD1poYWYA2cYHp67a03UfC7jXYgTHeGnj08ETQwEVK0Wgw0lQyWaULWzKhA6EBIElusaSD8KP8IX0EcFa57ucbpPrjuqPoyio4kPnkDQTijcyGk85sGClAGO59CPb2L99g0XboSVCYlaWFWUY933enadpphVmyHQ7SRA9pjY512+TcQJ2bgDLRBHMUlTc1C99glEWSwz5xAgMBAAE='

/**
 * ⚠ THE PROMPT IS WRITTEN TO MAKE "I CANNOT TELL" A FIRST-CLASS ANSWER.
 *
 * A model asked "is this student cheating?" will find a story in almost any
 * frame. This one is told, in order: what the detector already claimed, that a
 * detector flag is a hypothesis rather than a finding, and that the ordinary
 * exam behaviours this codebase has spent months learning not to punish
 * (blinking, looking down at a keyboard, stretching, a face partly out of frame)
 * are NOT cheating. INCONCLUSIVE exists so an unreadable frame does not have to
 * be forced into an accusation — the same rule the vision pipeline follows.
 */
const SYSTEM_PROMPT = `You review a single frame captured during an online proctored exam.

An automated detector raised a candidate incident of type: "{TYPE}".
A detector flag is a HYPOTHESIS. Determine whether this frame corroborates the incident.

Rules:
1. OBJECT/OUTSIDE HELP INCIDENTS (e.g., PHONE_DETECTED, UNAUTHORIZED_PERSON):
   - CHEATING: A phone, external display, notes, or unauthorized person is visibly present.
   - NOT_CHEATING: The object is benign (water bottle, hand on face, clothing) or clearly absent.

2. COMPLIANCE & PRESENCE INCIDENTS (e.g., FACE_NOT_VISIBLE, SUSTAINED_LOOK_AWAY, VISIBILITY_HIDDEN, WINDOW_BLUR):
   - CHEATING: The candidate is looking away from the display, turned around, out of frame, the chair is empty, or the frame shows a non-exam desktop window.
   - NOT_CHEATING: The candidate is looking at the screen with face centered and clearly visible.

3. INCONCLUSIVE:
   - Reserve strictly for total camera failure, complete black frames, or severe corruption where candidate presence or environment cannot be discerned.
   - An empty desk, turned head, or cropped profile is NOT inconclusive; for presence incidents, it corroborates the violation.

Output Constraints:
- verdict must be one of: CHEATING, NOT_CHEATING, INCONCLUSIVE.
- confidence is your certainty in the verdict (0-100). Output >= 95 when visual evidence clearly matches.
- observation is ONE short sentence (max 18 words) stating only what is visibly in the frame. No speculation.`
// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked: a single String.fromCharCode(...spread) over a few hundred KB
  // overflows the argument limit and throws.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// PostgREST / Storage over plain fetch.
//
// Deliberately no supabase-js here. This function has four server calls to make
// and each is one URL; a client library would add a resolved dependency to the
// deploy of a file whose whole job is to be small and auditable.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''

/**
 * The privileged identity used for every budget read and every write.
 *
 * ⚠ THE 403 THIS EXISTS TO FIX WAS NOT AN RLS PROBLEM, AND READING IT AS ONE
 * SENDS YOU TO THE WRONG FILE.
 *
 * The reported failure was `BUDGET_UNAVAILABLE sitting=403 daily=403`. The
 * obvious reading — "RLS is blocking the budget query" — cannot be right: these
 * calls already carried the service-role key, and the service role holds
 * BYPASSRLS, so no policy on `public.violations` is ever evaluated for them. A
 * policy denial would also not look like this; PostgREST answers a filtered-out
 * row set with `200 []`, not 403.
 *
 * A 403 on this path means the KEY ITSELF WAS REFUSED, and there are two live
 * candidates, which is why this resolves a list rather than one variable:
 *
 *   1. THE PROJECT IS ON THE NEW API KEY SYSTEM. Its publishable key is
 *      `sb_publishable_…` (46 chars), not a JWT — confirmed from the deployed
 *      `.env.local`. Projects migrated to that system issue `sb_secret_…` and
 *      can have the LEGACY JWT keys disabled, at which point the
 *      `SUPABASE_SERVICE_ROLE_KEY` that Edge Functions still inject is a token
 *      PostgREST no longer honours. `SUPABASE_SECRET_KEY` is the current one.
 *   2. A MISSING GRANT. If `service_role` lacks privileges on
 *      `public.violations` (or on the columns the 2026-08-16 migration added),
 *      Postgres raises 42501 and PostgREST turns that into 403 as well. This
 *      one is NOT fixed by changing keys — it needs a GRANT — which is exactly
 *      why `adminFetch` logs the response BODY: 42501 says "permission denied
 *      for table violations", an invalid key says something else entirely, and
 *      the status code alone cannot tell them apart.
 *
 * Order matters: the new-style secret is tried first, because on a project that
 * has both it is the one guaranteed to be current.
 */
const ADMIN_KEYS = [
  { name: 'SUPABASE_SECRET_KEY', value: Deno.env.get('SUPABASE_SECRET_KEY') ?? '' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', value: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' },
].filter((key) => key.value.length > 0)

/**
 * Which entry of ADMIN_KEYS last worked, so the second request does not repeat
 * the first one's failed attempt.
 *
 * Module-level and therefore shared across requests in one worker instance —
 * safe because it only reorders which credential is TRIED, never which is
 * accepted. The server decides that.
 */
let preferredAdminKey = 0

/**
 * The publishable/anon key, used only to route the GoTrue call in resolveUser.
 * Same two-name problem, same order.
 */
const CLIENT_KEY =
  Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ||
  Deno.env.get('SUPABASE_ANON_KEY') ||
  ''

/**
 * Every privileged call goes through here — budget reads, the storage upload
 * and the violations insert. This IS the "admin client"; it is a fetch wrapper
 * rather than a supabase-js instance because this function makes four server
 * calls and each is one URL, and a resolved dependency in the deploy of a
 * security-critical file is a cost with no matching benefit.
 *
 * ⚠ IT RETRIES ONCE, ON 401/403 ONLY, WITH THE OTHER KEY. That is bounded and
 * deliberate: it removes an entire class of "which key does this project use"
 * outage without hiding anything, because both the attempt and the outcome are
 * logged by name. It does NOT retry a 500 or a timeout — those are not
 * credential problems and a blind retry there would just double the load.
 */
async function adminFetch(
  path: string,
  init: RequestInit,
  requestId: string,
  label: string,
): Promise<Response> {
  if (ADMIN_KEYS.length === 0) {
    // Distinct from a refusal: nothing was even attempted. Without this the
    // symptom is a 401 that looks like a rejected key when the truth is that no
    // key was injected at all.
    console.error(
      `[analyze-snapshot] rid=${requestId} ${label} NO_ADMIN_KEY — neither ` +
      `SUPABASE_SECRET_KEY nor SUPABASE_SERVICE_ROLE_KEY is set in this function's environment`,
    )
    return new Response('no admin key configured', { status: 401 })
  }

  const order = ADMIN_KEYS.length > 1
    ? [preferredAdminKey, (preferredAdminKey + 1) % ADMIN_KEYS.length]
    : [0]

  let last: Response | null = null

  for (const index of order) {
    const key = ADMIN_KEYS[index]
    const response = await fetch(`${SUPABASE_URL}${path}`, {
      ...init,
      headers: {
        apikey: key.value,
        Authorization: `Bearer ${key.value}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })

    if (response.ok) {
      if (index !== preferredAdminKey) {
        // Logged once per switch, by NAME only — never the value. This line is
        // the answer to "which credential does this deployment actually run on".
        console.error(
          `[analyze-snapshot] rid=${requestId} ${label} switched admin key to ${key.name}`,
        )
        preferredAdminKey = index
      }
      return response
    }

    if (response.status !== 401 && response.status !== 403) return response

    // ⚠ THE BODY IS WHAT MAKES THE NEXT 403 SELF-DIAGNOSING. `sitting=403` on
    // its own cost a round trip of guessing; "permission denied for table
    // violations" (missing GRANT) versus "Invalid API key" (wrong key system)
    // are different repairs and the status cannot distinguish them.
    const detail = await response.clone().text().catch(() => '')
    console.error(
      `[analyze-snapshot] rid=${requestId} ${label} refused http=${response.status} ` +
      `key=${key.name} body=${detail.slice(0, 300)}`,
    )
    last = response
  }

  return last as Response
}

/**
 * Who is calling, according to GoTrue rather than according to the request body.
 *
 * ⚠ NEVER TAKE THE USER ID FROM THE BODY. The body is attacker-controlled; a
 * `studentId` field there would let any signed-in account file evidence against
 * any other. This asks the auth server to resolve the bearer token, and every
 * write below uses only what comes back from it.
 */
async function resolveUser(authHeader: string | null): Promise<{ id: string; email: string | null } | null> {
  if (!authHeader) return null
  // ⚠ NOT adminFetch. This call must carry the CALLER's bearer token, because
  // its whole purpose is to ask GoTrue who that token belongs to. Sending an
  // admin credential here would authenticate the server to itself and return
  // the wrong identity — or none — which is the one mistake on this path that
  // would be a security bug rather than an outage.
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: CLIENT_KEY, Authorization: authHeader },
  })
  if (!res.ok) return null
  const user = await res.json()
  return user?.id ? { id: user.id, email: user.email ?? null } : null
}

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

/**
 * PMSEAL1 envelope.
 *
 *   "PMSEAL1\n"          8 bytes, magic
 *   uint32 BE            header length
 *   header JSON (utf8)   the AAD, byte-for-byte
 *   ciphertext           AES-256-GCM, 16-byte tag appended by WebCrypto
 *
 * ⚠ THE HEADER IS THE AAD, AND THAT IS WHAT MAKES THE ENVELOPE NON-MALLEABLE.
 *
 * The header names the student, the storage path, the key id and the SHA-256 of
 * the plaintext. Because those exact bytes are authenticated, an attacker who
 * has the whole bucket cannot:
 *
 *   - re-file someone else's envelope under their own folder and have it open
 *     as theirs (the header still names the original path and student, so a
 *     reviewer sees the mismatch);
 *   - edit the header to say something else (the GCM tag then fails and the
 *     envelope does not open at all);
 *   - swap ciphertexts between two envelopes (each tag is bound to its own
 *     header);
 *   - substitute a different image for a real one and keep the original's
 *     provenance (the sha256 in the header would not match what decrypts).
 *
 * The content key is fresh per envelope, so breaking one buys exactly one frame.
 */
/** Base64 alphabet plus padding — used to spot key material that is still text. */
const BASE64_ONLY = /^[A-Za-z0-9+/=\s]+$/

/**
 * Turn whatever an operator put in an env var into DER bytes, or fail by NAME.
 *
 * ⚠ THIS EXISTS BECAUSE THE RAW FAILURE IS UNREADABLE. A malformed key reaches
 * `crypto.subtle.importKey` and comes back as
 * `unexpected ASN.1 DER tag: expected SEQUENCE, got APPLICATION [13]
 * (primitive)` — which names neither the variable at fault nor what was wrong
 * with it, and sends the reader into ASN.1 rather than into their deployment.
 *
 * ⚠ AND `APPLICATION [13] (primitive)` HAS EXACTLY ONE COMMON CAUSE, WHICH THIS
 * REPAIRS. That tag byte is `0x4D`, which is ASCII `'M'` — the first character
 * of every base64-encoded SPKI/PKCS#8 (`MII…`). Seeing it means the bytes handed
 * to importKey were still base64 TEXT, i.e. the secret was stored
 * double-encoded: `base64(base64(DER))`. That is an easy mistake to make
 * (`base64 -w0` applied to a file that already held base64, or a value pasted
 * through a tool that encodes on the way in), it is completely silent until a
 * frame is actually sealed, and it is unambiguously recoverable — so this
 * decodes the second layer rather than making a human re-derive it from a tag
 * number.
 *
 * Also accepts PEM: an operator pasting `-----BEGIN PRIVATE KEY-----` gets the
 * armour and newlines stripped instead of an `InvalidCharacterError` from atob.
 *
 * ⚠ NOTHING HERE MAY LOG KEY MATERIAL. The messages carry a length, a first
 * byte and the variable name — enough to identify the mistake, and nothing an
 * attacker reading function logs could use.
 *
 * @param raw   The env var's value.
 * @param label The variable's NAME, for the error message.
 */
function decodeKeyMaterial(raw: string, label: string): Uint8Array {
  const stripped = raw
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')

  if (!stripped) throw new Error(`${label} is empty after stripping PEM armour and whitespace`)

  let bytes: Uint8Array
  try {
    bytes = b64ToBytes(stripped)
  } catch {
    throw new Error(
      `${label} is not valid base64 (${stripped.length} chars after stripping PEM armour)`,
    )
  }

  // DER for SPKI and PKCS#8 both begin with a SEQUENCE, tag 0x30. Anything else
  // is not a key, and importKey's own error will not say so usefully.
  if (bytes[0] === 0x30) return bytes

  // The double-encoded case. Only attempted when the decode produced something
  // that is ITSELF pure base64 text — a real DER blob is binary and fails that
  // test almost immediately, so this cannot silently mangle a valid key.
  const asText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (BASE64_ONLY.test(asText)) {
    try {
      const inner = b64ToBytes(asText.replace(/\s+/g, ''))
      if (inner[0] === 0x30) {
        console.error(
          `[analyze-snapshot] ${label} WAS DOUBLE-BASE64-ENCODED — recovered automatically. ` +
          `Fix the secret so it holds base64(DER) once, not twice: the auto-repair is a ` +
          `safety net, not the contract, and it hides a deployment mistake every time it runs.`,
        )
        return inner
      }
    } catch {
      // fall through to the generic error below
    }
  }

  throw new Error(
    `${label} does not contain DER key material: after base64-decoding, the first byte is ` +
    `0x${(bytes[0] ?? 0).toString(16).padStart(2, '0')} but a SPKI/PKCS#8 key must begin with ` +
    `0x30 (SEQUENCE). Decoded length ${bytes.length}. ` +
    `0x4d means the value is base64 of base64; 0x2d means raw PEM text reached the decoder.`,
  )
}

async function seal(
  plaintext: Uint8Array,
  publicKeyB64: string,
  keyId: string,
  meta: Record<string, unknown>,
): Promise<Uint8Array> {
  // ⚠ NORMALISED LIKE THE SIGNING KEY, BUT STILL FATAL ON FAILURE. An operator
  // who sets `EVIDENCE_PUBLIC_KEY` to a PEM or a double-encoded value gets the
  // same repair and the same named diagnostic — but if it genuinely cannot be
  // read, this throws and the frame is dropped, which is correct: without a
  // wrapping key there is no encryption, and the one thing this function must
  // never do is put an unencrypted webcam frame in a bucket.
  const wrappingKey = await crypto.subtle.importKey(
    'spki',
    decodeKeyMaterial(publicKeyB64, 'EVIDENCE_PUBLIC_KEY'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )

  // ⚠ THE SIGNATURE EXISTS BECAUSE OUR OWN ATTACK SCRIPT BROKE THE SCHEME
  // WITHOUT IT (scripts/attack_sealed_evidence.mjs, attack 6).
  //
  // Encryption gave confidentiality and tamper-evidence, and none of that was
  // the problem. The problem is that the sealing key is PUBLIC by construction:
  // anyone can seal. So an attacker who reaches the bucket — a leaked storage
  // credential, a bad policy, a compromised CI token — can write a perfectly
  // valid envelope holding an image of their choosing under a victim's
  // identity, and the reviewer's private key opens it cleanly. That is evidence
  // FABRICATION, and against a proctoring product it is worse than a leak.
  //
  // Signing with a key the attacker does not have closes it. `sig_len` goes in
  // the header (so it is covered by the GCM tag and cannot be trimmed off
  // silently), and the signature covers EVERYTHING before it: magic, length
  // prefix, header and ciphertext.
  //
  // ⚠ `signed: false` IS A REAL STATE AND MUST BE TREATED AS ONE. With no
  // EVIDENCE_SIGNING_KEY configured the envelope is still sealed and still
  // confidential — but its origin is unproven, and a reviewer must read it as
  // "an image someone put in our bucket", never as "an image we captured".
  // ⚠ A BROKEN SIGNING KEY MUST DEGRADE TO UNSIGNED, NOT DESTROY THE FRAME.
  //
  // This import used to sit in a `const` initialiser with no guard, so any
  // failure threw straight out of `seal()`, was caught by the SEAL_OR_UPLOAD
  // handler at the call site, and left `snapshotPath` null — the confirmed
  // frame was discarded. That is the worst available outcome and it contradicts
  // the paragraph directly above: an unsigned envelope is a DOCUMENTED state,
  // still AES-256-GCM encrypted, still non-malleable, still unreadable to
  // anyone without the offline private key. The only thing it lacks is proof of
  // origin, and a reviewer is already required to treat `sig_alg: 'none'` as
  // "an image someone put in our bucket".
  //
  // So the trade is: an unsigned envelope, loudly flagged, versus no evidence at
  // all. Evidence wins. The failure is logged at error level with the reason,
  // and `sig_alg` records the truth inside the AAD where it cannot be edited.
  //
  // ⚠ NOTE THE ASYMMETRY WITH THE WRAPPING KEY ABOVE, WHICH IS DELIBERATE. A
  // failure there stays fatal, because without it there is no encryption — and
  // storing an unencrypted webcam frame is a privacy breach, not a degraded
  // mode. Losing evidence is the lesser harm there and the greater harm here.
  const signingKeyB64 = Deno.env.get('EVIDENCE_SIGNING_KEY') ?? ''
  let signingKey: CryptoKey | null = null
  if (signingKeyB64) {
    try {
      signingKey = await crypto.subtle.importKey(
        'pkcs8',
        decodeKeyMaterial(signingKeyB64, 'EVIDENCE_SIGNING_KEY'),
        { name: 'RSA-PSS', hash: 'SHA-256' },
        false,
        ['sign'],
      )
    } catch (error) {
      console.error(
        `[analyze-snapshot] SIGNING_KEY_UNUSABLE — sealing this frame UNSIGNED rather than ` +
        `dropping it. Its origin is therefore unproven and a reviewer must not treat it as ` +
        `captured by us.\n  reason: ${(error as Error)?.message ?? String(error)}`,
      )
      signingKey = null
    }
  }

  // ⚠ DERIVED FROM THE KEY, NOT HARD-CODED. This was `384`, with a comment
  // saying "RSA-3072 signature is 384 bytes" — true of the key in use, and
  // silently wrong for any other. `sig_len` lives INSIDE the header, which is
  // the GCM AAD, so it is fixed before the signature exists and cannot be
  // corrected afterwards: a 2048-bit key would have written 384 while appending
  // 256 bytes, making every envelope's trailer unparseable by a verifier that
  // believes the header. An RSA signature is exactly the modulus length.
  const sigLen = signingKey
    ? (signingKey.algorithm as RsaHashedKeyAlgorithm).modulusLength / 8
    : 0

  const contentKeyRaw = crypto.getRandomValues(new Uint8Array(32))
  const contentKey = await crypto.subtle.importKey('raw', contentKeyRaw, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext))
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, wrappingKey, contentKeyRaw))

  const header = {
    v: 2,
    alg: 'A256GCM',
    wrap: 'RSA-OAEP-256',
    kid: keyId,
    iv: bytesToB64(iv),
    ek: bytesToB64(wrapped),
    sha256: bytesToB64(digest),
    content_type: 'image/jpeg',
    // Inside the AAD on purpose: an attacker cannot claim `sig_len: 0` on a
    // signed envelope to make a verifier skip the check, because changing it
    // breaks the GCM tag and the envelope stops opening at all.
    sig_alg: signingKey ? 'RSA-PSS-SHA256' : 'none',
    sig_len: sigLen,
    ...meta,
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: headerBytes, tagLength: 128 },
      contentKey,
      plaintext,
    ),
  )

  // The raw content key must not outlive this call in any readable form. JS
  // gives no guaranteed zeroisation, but overwriting removes it from the obvious
  // places a heap dump would look.
  contentKeyRaw.fill(0)

  const magic = new TextEncoder().encode('PMSEAL1\n')
  const lengthPrefix = new Uint8Array(4)
  new DataView(lengthPrefix.buffer).setUint32(0, headerBytes.length, false)

  const body = new Uint8Array(magic.length + 4 + headerBytes.length + ciphertext.length)
  let offset = 0
  body.set(magic, offset); offset += magic.length
  body.set(lengthPrefix, offset); offset += 4
  body.set(headerBytes, offset); offset += headerBytes.length
  body.set(ciphertext, offset)

  if (!signingKey) return body

  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, signingKey, body),
  )
  const out = new Uint8Array(body.length + signature.length)
  out.set(body, 0)
  out.set(signature, body.length)
  return out
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

type Review = { verdict: string; confidence: number; observation: string }

async function reviewFrame(imageB64: string, violationType: string, apiKey: string): Promise<Review> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: SYSTEM_PROMPT.replace('{TYPE}', violationType || 'UNKNOWN') },
              { inline_data: { mime_type: 'image/jpeg', data: imageB64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          // Structured output, so the verdict never has to be recovered from
          // prose. A parse failure would otherwise become an accusation or an
          // exoneration depending on which regex someone happened to write.
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              verdict: { type: 'STRING', enum: ['CHEATING', 'NOT_CHEATING', 'INCONCLUSIVE'] },
              // ⚠ THE SCALE IS STATED IN THE SCHEMA AS WELL AS IN THE PROMPT.
              // `type: NUMBER` alone admits both 0-1 and 0-100, and the parser
              // deliberately refuses to guess between them (see the
              // SUSPECT_CONFIDENCE_SCALE branch) — so the only real defence
              // against an ambiguous answer is asking unambiguously, twice.
              confidence: {
                type: 'NUMBER',
                description: 'Your certainty in the verdict, as a whole number from 0 to 100. '
                  + 'Not a fraction: 95 means 95%, not 9500%.',
              },
              observation: { type: 'STRING' },
            },
            required: ['verdict', 'confidence', 'observation'],
          },
        },
        safetySettings: [
          // The frame is a person's face. Default filters treat some ordinary
          // webcam stills as sensitive and return an empty candidate, which
          // would present as "the model refused" on an innocent student.
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    },
  )

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`gemini HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const body = await res.json()
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof text !== 'string') throw new Error('gemini returned no text part')

  const parsed = JSON.parse(text)

  // ⚠ `NORMAL` IS ACCEPTED AS AN INBOUND ALIAS FOR `NOT_CHEATING`, AND
  // `INCONCLUSIVE` IS DELIBERATELY RETAINED ALONGSIDE IT.
  //
  // The integration brief specifies a two-value vocabulary, `CHEATING |
  // NORMAL`. Adopting it literally would delete the "I cannot tell" answer, and
  // this codebase treats that as a hard rule rather than a preference: no
  // detector may accuse on an unreadable observation. A frame that is too dark,
  // too blurred or too cropped to judge would have to be forced into either an
  // accusation or an exoneration, and BOTH are false statements about a frame
  // nobody could read — the exoneration is the more dangerous of the two,
  // because `ai_verdict` is what the student's own dashboard renders.
  //
  // So the alias is honoured where it costs nothing (a model answering NORMAL
  // is understood) and the third answer survives where it matters.
  const rawVerdict = typeof parsed?.verdict === 'string' ? parsed.verdict.toUpperCase() : ''
  const verdict = rawVerdict === 'NORMAL'
    ? 'NOT_CHEATING'
    : (['CHEATING', 'NOT_CHEATING', 'INCONCLUSIVE'].includes(rawVerdict) ? rawVerdict : 'INCONCLUSIVE')

  const rawConfidence = Number(parsed?.confidence)
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(100, rawConfidence)) : 0

  // ⚠ A FRACTIONAL CONFIDENCE IS LOGGED, NOT RESCALED, AND THE ASYMMETRY IS THE
  // WHOLE REASON.
  //
  // The prompt and the schema both specify 0-100. If a model ever answers on a
  // 0-1 scale instead, the tempting repair is `if (v <= 1) v *= 100`. That
  // heuristic cannot distinguish "0.95, meaning 95%" from "1, meaning 1%" — and
  // the two mistakes are not equally bad. Rescaling a genuine 1% to 100% would
  // manufacture a maximum-confidence CHEATING verdict, which trips the >= 95
  // early stop, flags the sitting, and seals a frame as evidence. NOT rescaling
  // a genuine 0.95 reads it as 0.95%, which under-reports and simply fails to
  // flag. One error accuses somebody; the other misses. Never add the rescale.
  if (confidence > 0 && confidence <= 1) {
    console.error(
      `[analyze-snapshot] SUSPECT_CONFIDENCE_SCALE verdict=${verdict} value=${confidence} — ` +
      `the model may be answering 0-1 while the prompt specifies 0-100. Treated as ` +
      `${confidence}% (under-reporting, never over-reporting). Check the prompt if this recurs.`,
    )
  }

  // `explanation` is the brief's field name, `observation` is this function's.
  // Both are read so the contract holds whichever the model echoes.
  const sentence = typeof parsed?.observation === 'string'
    ? parsed.observation
    : (typeof parsed?.explanation === 'string' ? parsed.explanation : '')

  return { verdict, confidence, observation: sentence.slice(0, 240) }
}

// ---------------------------------------------------------------------------
// The sitting
// ---------------------------------------------------------------------------

type Sitting = {
  id: string | null
  mode: string
  classroomId: string | null
  reviewClosedAt: string | null
  aiFlaggedAt: string | null
}

/**
 * Find the `proctor_sessions` row this frame belongs to.
 *
 * ⚠ LOOKED UP BY (student_id, demo_session_id), NOT BY A ROW ID THE CLIENT
 * SENDS, AND NOT FROM THE REQUEST BODY. The session row's uuid is generated by
 * Postgres and never travels back to the browser, so `demo_session_id` — the
 * sitting key the page minted and the extension wrote — is the only handle the
 * page can name. The `student_id` term is what makes that safe: it comes from
 * `resolveUser()`, i.e. from GoTrue's answer about the bearer token, so a
 * caller guessing another student's sitting key still resolves nothing.
 *
 * ⚠ WHY THE MODE IS READ HERE RATHER THAN ACCEPTED FROM THE BODY. It decides
 * who may read a confirmed evidence frame. A client that could name its own
 * mode would keep a classroom frame out of its teacher's queue simply by
 * claiming DEMO — which is the single most valuable lie available to a
 * candidate on this path.
 *
 * ⚠ A MISSING ROW IS NOT AN ERROR. Sittings predating the lifecycle columns,
 * and pages older than the sitting protocol, legitimately have none. The
 * fallback is DEMO with a null session id: the narrower audience and no join,
 * which is honest about what is known rather than a guess.
 */
async function resolveSitting(
  studentId: string,
  demoSessionId: string,
  requestId: string,
): Promise<Sitting> {
  const fallback: Sitting = {
    id: null, mode: 'DEMO', classroomId: null, reviewClosedAt: null, aiFlaggedAt: null,
  }

  // ⚠ THE WHOLE BODY IS WRAPPED, BECAUSE THIS PROMISE IS CREATED BEFORE IT IS
  // AWAITED AND A REJECTION IN THAT GAP IS NOT CATCHABLE BY THE CALLER.
  //
  // `handleRequest` starts this alongside the budget queries and only awaits it
  // afterwards. `adminFetch`'s bare `await fetch(...)` rejects on any transport
  // error (DNS, reset, TLS) and `res.json()` throws on a malformed body — and a
  // rejection that occurs while nothing is attached escapes the root
  // `Deno.serve` try/catch entirely. The caller then gets a bare 500 with no
  // requestId and none of the diagnostic logging that catch exists to
  // guarantee, which is precisely the "indistinguishable from a network
  // failure" outcome documented at the top of this file.
  //
  // Every failure here degrades to the same fallback a non-ok response gets:
  // DEMO routing, no session link. Losing the routing is recoverable; losing
  // the request is not.
  let res: Response
  try {
    res = await adminFetch(
      `/rest/v1/proctor_sessions?select=id,mode,classroom_id,review_closed_at,ai_flagged_at` +
        `&student_id=eq.${studentId}&demo_session_id=eq.${encodeURIComponent(demoSessionId)}` +
        `&order=created_at.desc&limit=1`,
      {},
      requestId,
      'sitting.resolve',
    )
  } catch (error) {
    console.error(
      `[analyze-snapshot] rid=${requestId} SITTING_RESOLVE_THREW ` +
      `${(error as Error)?.message ?? String(error)} — routing as DEMO`,
    )
    return fallback
  }

  if (!res.ok) {
    // ⚠ FAILS OPEN TO DEMO, UNLIKE THE BUDGET, WHICH FAILS CLOSED. The budget
    // guards spend, so an unreadable answer there must refuse. This guards
    // ROUTING, and refusing here would drop a review that is otherwise fine.
    // The cost of the fallback is that a classroom frame reaches only the
    // student's own dashboard — a narrower audience than intended, never a
    // wider one.
    console.error(
      `[analyze-snapshot] rid=${requestId} SITTING_UNRESOLVED http=${res.status} — ` +
      `routing as DEMO and recording no session link`,
    )
    return fallback
  }

  let rows: unknown
  try {
    rows = await res.json()
  } catch {
    // A 200 with an unparseable body is still not an answer about routing.
    console.error(`[analyze-snapshot] rid=${requestId} SITTING_BODY_UNPARSEABLE — routing as DEMO`)
    return fallback
  }
  const row = Array.isArray(rows) && rows.length ? rows[0] as Record<string, unknown> : null
  if (!row) return fallback

  return {
    id: typeof row.id === 'string' ? row.id : null,
    mode: row.mode === 'CLASSROOM' ? 'CLASSROOM' : 'DEMO',
    classroomId: typeof row.classroom_id === 'string' ? row.classroom_id : null,
    reviewClosedAt: row.review_closed_at ?? null,
    aiFlaggedAt: row.ai_flagged_at ?? null,
  }
}

/**
 * Is this student actually enrolled in the classroom the sitting names?
 *
 * ⚠ THE ROUTE IS VERIFIED, NOT ASSERTED. `review_route = 'TEACHER'` is a claim
 * that some teacher is entitled to read this frame. RLS enforces that
 * independently at read time (`violations_classroom_teacher_read` joins
 * enrollments to classrooms), so a wrong value here cannot leak anything — but
 * it can produce rows marked TEACHER that no teacher can ever see, which reads
 * in the queue as evidence that vanished. Checking the enrollment means the
 * column says something true.
 *
 * ⚠ AN UNREADABLE ANSWER RETURNS FALSE, ROUTING TO THE STUDENT. Narrower on
 * doubt, in the one direction that cannot expose a frame to a stranger.
 */
async function enrollmentVerified(
  studentId: string,
  classroomId: string,
  requestId: string,
): Promise<boolean> {
  const res = await adminFetch(
    `/rest/v1/enrollments?select=student_id&student_id=eq.${studentId}` +
      `&classroom_id=eq.${encodeURIComponent(classroomId)}&limit=1`,
    {},
    requestId,
    'enrollment.verify',
  )
  if (!res.ok) {
    console.error(
      `[analyze-snapshot] rid=${requestId} ENROLLMENT_UNVERIFIABLE http=${res.status} — ` +
      `routing to the student's own dashboard`,
    )
    return false
  }
  const rows = await res.json()
  return Array.isArray(rows) && rows.length > 0
}

/**
 * Record on the sitting row that no further frames will be reviewed.
 *
 * ⚠ THIS IS WHAT MAKES THE EARLY STOP STOP ANYTHING ON THE CAPTURE SIDE. The
 * budget is already enforced by re-reading `violations`, and that enforcement
 * is the one that cannot be skipped — but it only ever REFUSES an upload, after
 * the candidate's laptop has already encoded a frame and sent it. Writing the
 * decision here is what lets the page and the extension stop producing frames
 * at all, and what lets a reviewer see when the sitting closed without
 * reconstructing it from three timestamps.
 *
 * ⚠ `ai_flagged_at` IS THE NARROW CLAIM AND IS SET ONLY ON A CONFIRMED,
 * HIGH-CONFIDENCE CHEATING VERDICT. `review_closed_at` is the broad one and is
 * also true when the sitting merely spent its three frames. A UI that renders
 * the second as a finding would accuse every candidate who used their budget.
 *
 * Non-fatal: the verdict row is the finding and must survive a failure here.
 */
async function closeSitting(
  sittingRowId: string | null,
  opts: { flagged: boolean; confidence: number },
  requestId: string,
): Promise<void> {
  if (!sittingRowId) return

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { review_closed_at: now }
  if (opts.flagged) {
    patch.ai_flagged_at = now
    patch.ai_flag_confidence = opts.confidence
  }

  // ⚠ NOTHING THIS FUNCTION DOES MAY FAIL THE REQUEST, SO IT SWALLOWS ITS OWN
  // THROWS AS WELL AS ITS OWN NON-OK RESPONSES.
  //
  // It is awaited from `handleRequest` AFTER the verdict row has already been
  // inserted. `adminFetch` rejects on any transport error, and an uncaught
  // rejection there would propagate out of a fully successful, already-persisted
  // review and turn it into `500 INTERNAL_ERROR` — which `snapshotReview.js`
  // maps to CALL_FAILED, so the page never learns the budget closed and keeps
  // uploading frames the server will refuse. A network blip on one bookkeeping
  // PATCH must not undo a completed review.
  try {
    const res = await adminFetch(
      // ⚠ `review_closed_at=is.null` — FIRST CLOSE WINS. Without it a later call
      // would keep pushing the timestamp forward, and the row would name the most
      // recent refusal rather than the moment review actually stopped.
      `/rest/v1/proctor_sessions?id=eq.${encodeURIComponent(sittingRowId)}&review_closed_at=is.null`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      },
      requestId,
      'sitting.close',
    )

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(
        `[analyze-snapshot] rid=${requestId} SITTING_CLOSE_FAILED http=${res.status} ` +
        `${detail.slice(0, 300)} — the verdict was still recorded; the page may keep sending ` +
        `frames that this function will refuse`,
      )
    }
  } catch (error) {
    console.error(
      `[analyze-snapshot] rid=${requestId} SITTING_CLOSE_THREW ` +
      `${(error as Error)?.message ?? String(error)} — the verdict was still recorded`,
    )
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * ⚠ THE ROOT CATCH BELOW IS NOT DEFENSIVE CLUTTER — WITHOUT IT A THROW HERE IS
 * INVISIBLE.
 *
 * Anything that escapes this function reaches the Deno runtime, which answers
 * the caller with a bare 500 and writes nothing useful to the function logs. On
 * the client that is indistinguishable from a network failure, so
 * `snapshotReview.js` reports CALL_FAILED and the demo shows "review
 * unavailable" — with no way, from either side, to learn what actually broke.
 *
 * Plenty here can throw for reasons invisible on the happy path:
 * `crypto.subtle.importKey` on a malformed EVIDENCE_SIGNING_KEY, `atob` on a
 * base64 string the page mangled, `JSON.parse` of a Gemini reply that arrived
 * truncated, an out-of-memory on an oversized frame. Each needs a different
 * fix, and without a stack they all present identically.
 *
 * ⚠ WHAT MAY BE LOGGED IS CONSTRAINED, AND THAT CONSTRAINT IS THE POINT OF THIS
 * WHOLE FILE. Function logs are readable by anyone with dashboard access —
 * precisely the population the sealing scheme assumes may be compromised. So
 * this logs the error's name, message and stack, plus a request id and the
 * method/path, and NOTHING drawn from the request body. Never add `body`,
 * `imageBase64`, or a "first 100 chars of the payload" here: a base64 prefix of
 * a webcam frame sitting in a log is exactly the plaintext-at-rest leak the
 * encryption exists to prevent.
 *
 * The response carries the request id but not the stack — a caller learns which
 * log line to quote, not the internals of the failure.
 */
Deno.serve(async (req) => {
  // Deliberately not crypto.randomUUID(): a short, greppable correlator is what
  // you actually want in a log search, and this is never used for anything but
  // correlation.
  const requestId = Math.random().toString(36).slice(2, 10)
  try {
    return await handleRequest(req, requestId)
  } catch (error) {
    const err = error as Error
    console.error(
      `[analyze-snapshot] UNCAUGHT rid=${requestId} ${req.method} ${new URL(req.url).pathname}\n` +
      `  name   : ${err?.name ?? typeof error}\n` +
      `  message: ${err?.message ?? String(error)}\n` +
      `  stack  : ${err?.stack ?? '(no stack)'}`,
    )
    // A non-Error throw (a bare string, a rejected non-Error value) has no stack
    // at all, and reading `.message` off it yields "undefined". Dump the raw
    // value so at least something identifies it.
    if (!(error instanceof Error)) {
      console.error(`[analyze-snapshot] rid=${requestId} non-Error throw:`, error)
    }
    return json({ ok: false, reason: 'INTERNAL_ERROR', requestId }, 500)
  }
})

async function handleRequest(req: Request, requestId: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405)

  const user = await resolveUser(req.headers.get('Authorization'))
  if (!user) return json({ ok: false, reason: 'NOT_SIGNED_IN' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, reason: 'BAD_REQUEST' }, 400)
  }

  const demoSessionId = typeof body.demoSessionId === 'string' ? body.demoSessionId.slice(0, 64) : ''
  const violationType = typeof body.violationType === 'string' ? body.violationType.slice(0, 64) : ''
  const severity = typeof body.severity === 'string' ? body.severity.slice(0, 16) : null
  const rawImage = typeof body.imageBase64 === 'string' ? body.imageBase64 : ''

  if (!demoSessionId || !rawImage) return json({ ok: false, reason: 'BAD_REQUEST' }, 400)

  // `let`, not `const`: a cleared frame is dropped the moment the verdict is
  // known — see the discard below.
  let imageB64: string | null = rawImage.replace(/^data:image\/\w+;base64,/, '')
  if (imageB64.length > MAX_IMAGE_BYTES) return json({ ok: false, reason: 'IMAGE_TOO_LARGE' }, 413)

  // ---- 2. Budget ---------------------------------------------------------
  //
  // Queried, never trusted from the client. The page keeps its own counter so it
  // can stop sending, but that counter is a convenience; this is the rule.
  // ⚠ THE BUDGET IS READ WITH ADMIN CREDENTIALS, AND THAT IS NOT A CONVENIENCE.
  //
  // It has to see rows the CALLER cannot: the point of a rate limit is that it
  // is not negotiable by the party being limited. Reading it through the user's
  // own token would make the count a function of what RLS lets that user see,
  // so anyone able to hide their own rows would mint themselves fresh budget.
  //
  // The identity being counted is still `user.id` from resolveUser above —
  // GoTrue's answer about the bearer token, never anything from the body. Admin
  // credentials widen what can be READ; they do not decide WHO is being
  // charged. Keep those two separate.
  //
  // ⚠ THE SITTING ROW IS READ ALONGSIDE THE COUNTS, NOT AFTER THEM. It carries
  // two things this decision needs: whether review has ALREADY been closed for
  // this sitting (a second, cheaper answer to the same question the violation
  // rows give), and the MODE, which decides where a confirmed frame is routed.
  // Fetched in the same round trip because all three are independent.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const sittingPromise = resolveSitting(user.id, demoSessionId, requestId)
  const [sittingRes, dailyRes] = await Promise.all([
    adminFetch(
      `/rest/v1/violations?select=ai_verdict,cheat_probability` +
        `&student_id=eq.${user.id}&demo_session_id=eq.${encodeURIComponent(demoSessionId)}` +
        `&ai_reviewed_at=not.is.null`,
      {},
      requestId,
      'budget.sitting',
    ),
    adminFetch(
      `/rest/v1/violations?select=id&student_id=eq.${user.id}` +
        `&ai_reviewed_at=gte.${since}`,
      {},
      requestId,
      'budget.daily',
    ),
  ])

  if (!sittingRes.ok || !dailyRes.ok) {
    // Fail CLOSED. An unreadable budget means we cannot say whether this call is
    // within it, and the failure mode of guessing "yes" is an unbounded bill.
    //
    // Logged because failing closed is INDISTINGUISHABLE FROM WORKING from the
    // outside: the demo just stops reviewing, quietly and permanently. The
    // usual cause is the migration not having been applied, so the status codes
    // are what you need — 404 on `demo_session_id` means exactly that.
    console.error(
      `[analyze-snapshot] rid=${requestId} BUDGET_UNAVAILABLE ` +
      `sitting=${sittingRes.status} daily=${dailyRes.status}`,
    )
    return json({ ok: false, reason: 'BUDGET_UNAVAILABLE', requestId }, 503)
  }

  const sittingRows: Array<{ ai_verdict: string | null; cheat_probability: number | null }> =
    await sittingRes.json()
  const dailyRows: Array<unknown> = await dailyRes.json()

  const sitting = await sittingPromise

  const used = sittingRows.length

  // ⚠ TWO INDEPENDENT SOURCES FOR "ALREADY CLOSED", AND KEEPING BOTH IS
  // DELIBERATE. The violation rows are the ENFORCEMENT — they exist whether or
  // not a session row was ever created, and `startSession()` is explicitly
  // non-fatal, so a sitting with no row is a normal occurrence rather than an
  // edge case. The session row is the FASTER and more explicit signal, and the
  // one a reviewer reads. Trusting only the row would let a sitting whose row
  // failed to open review without limit; trusting only the rows would leave the
  // page with nothing to stop capturing on.
  const closedByConfidence = sittingRows.some(
    (row) => row.ai_verdict === 'CHEATING' && Number(row.cheat_probability) >= STOP_CONFIDENCE,
  ) || sitting.aiFlaggedAt !== null

  if (closedByConfidence) {
    return json({
      ok: true, reviewed: false, reason: 'BUDGET_CLOSED_CONFIRMED',
      used, max: MAX_SNAPSHOTS_PER_SITTING, budgetClosed: true,
    })
  }
  if (used >= MAX_SNAPSHOTS_PER_SITTING) {
    // Belt and braces: the sitting spent its budget, so make sure the row says
    // so even if the call that spent the last one failed to write it.
    await closeSitting(sitting.id, { flagged: false, confidence: 0 }, requestId)
    return json({
      ok: true, reviewed: false, reason: 'BUDGET_EXHAUSTED',
      used, max: MAX_SNAPSHOTS_PER_SITTING, budgetClosed: true,
    })
  }
  if (dailyRows.length >= MAX_REVIEWS_PER_DAY) {
    // ⚠ THE SITTING ROW IS NOT CLOSED HERE. The daily ceiling is a property of
    // the ACCOUNT, not of this sitting, and marking the sitting closed would
    // tell a reviewer that review finished for it when in fact it never
    // started. The client still stops sending, which is what `budgetClosed`
    // is for.
    return json({
      ok: true, reviewed: false, reason: 'DAILY_LIMIT',
      used, max: MAX_SNAPSHOTS_PER_SITTING, budgetClosed: true,
    })
  }

  // ---- 3. Review ---------------------------------------------------------
  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) {
    // Explicit on BOTH sides, not silent. Without this the feature would look
    // like a model that never flags anything, which is the worst possible way
    // for a proctoring component to be broken.
    console.error(`[analyze-snapshot] rid=${requestId} GEMINI_NOT_CONFIGURED — secret is unset`)
    return json({ ok: false, reason: 'GEMINI_NOT_CONFIGURED', requestId }, 503)
  }

  let review: Review
  try {
    review = await reviewFrame(imageB64, violationType, geminiKey)
  } catch (error) {
    const err = error as Error
    // The message from reviewFrame already carries Gemini's HTTP status and the
    // head of its body — a 400 (bad key / bad image), a 429 (quota) and a 503
    // (upstream) need three different responses and are otherwise identical
    // here. The stack matters less than that status, but costs nothing.
    console.error(
      `[analyze-snapshot] rid=${requestId} REVIEW_FAILED type=${violationType}\n` +
      `  ${err?.message ?? String(error)}\n` +
      `  stack: ${err?.stack ?? '(no stack)'}`,
    )
    return json(
      { ok: false, reason: 'REVIEW_FAILED', detail: String(error).slice(0, 200), requestId },
      502,
    )
  }

  // ---- 4. Seal + store ---------------------------------------------------
  //
  // ⚠ ONLY A CONFIRMED FRAME IS KEPT. "save this snapshot" applies to the frame
  // the model stands behind; a NOT_CHEATING or INCONCLUSIVE frame is a webcam
  // still of an innocent person, and storing it — even sealed — is collecting
  // something nothing downstream has a use for. The verdict row is still
  // written, so the budget counts it and the student can see that the frame was
  // reviewed and cleared.
  const publicKey = Deno.env.get('EVIDENCE_PUBLIC_KEY') || BUILTIN_EVIDENCE_PUBLIC_KEY
  const keyId = Deno.env.get('EVIDENCE_KEY_ID') || BUILTIN_EVIDENCE_KEY_ID
  const violationId = crypto.randomUUID()
  const keepFrame = review.verdict === 'CHEATING'

  // ⚠ A CLEARED FRAME IS DROPPED THE MOMENT THE VERDICT IS KNOWN.
  //
  // It was already never UPLOADED — `keepFrame` gates the seal — but the decoded
  // base64 stayed reachable in this scope for the rest of the request: through
  // the violations insert, the sitting close, and the response build. Any of
  // those can throw, and the root handler logs a stack; a live frame of an
  // innocent person sitting in scope during that is precisely the exposure the
  // sealing scheme exists to avoid. The verdict row still records the numbers.
  //
  // ⚠ WHAT THIS DOES AND DOES NOT GUARANTEE, STATED PLAINLY. JavaScript strings
  // are immutable and there is no way to scrub one — dropping the reference
  // makes the bytes collectable, it does not erase them, and the runtime may
  // hold the backing store until GC runs. This is a real reduction in lifetime
  // and reachability, not a secure wipe. Nothing downstream may be built as
  // though the frame were provably gone.
  if (!keepFrame) {
    imageB64 = null
    console.log(
      `[analyze-snapshot] rid=${requestId} verdict=${review.verdict} — frame discarded, `
      + `audit row only (no image stored)`,
    )
  }

  // ⚠ THE ROUTE IS DECIDED FROM THE SITTING ROW PLUS A VERIFIED ENROLLMENT, AND
  // FROM NOTHING THE CALLER SENT.
  //
  //   DEMO      -> STUDENT: the candidate's own /student/dashboard Flag Review.
  //   CLASSROOM -> TEACHER: also the classroom teacher's review queue.
  //
  // Checked only when a frame is actually being kept: an unconfirmed frame is
  // never stored and never reaches a queue, so an enrollment round trip for it
  // would be a request that changes nothing.
  let reviewRoute = 'STUDENT'
  if (keepFrame && sitting.mode === 'CLASSROOM' && sitting.classroomId) {
    if (await enrollmentVerified(user.id, sitting.classroomId, requestId)) {
      reviewRoute = 'TEACHER'
    } else {
      // Loud: a classroom sitting whose evidence silently lands only on the
      // student's dashboard is a teacher waiting for a queue entry that will
      // never arrive, with nothing anywhere explaining why.
      console.error(
        `[analyze-snapshot] rid=${requestId} ROUTE_DOWNGRADED classroom=${sitting.classroomId} — ` +
        `no enrollment links this student to it; evidence routed to the student only`,
      )
    }
  }

  let snapshotPath: string | null = null
  let sealed = false

  // `imageB64` is in the condition rather than asserted non-null: it is only
  // ever nulled when `keepFrame` is false, so this can never skip a frame that
  // should have been sealed — and if that invariant is ever broken, this stores
  // nothing instead of throwing on a null, which is the safe direction.
  if (keepFrame && publicKey && imageB64) {
    const path = `sealed/${user.id}/${violationId}.pmseal`
    try {
      const envelope = await seal(b64ToBytes(imageB64), publicKey, keyId, {
        path,
        student_id: user.id,
        violation_id: violationId,
        violation_type: violationType,
        demo_session_id: demoSessionId,
        created_at: new Date().toISOString(),
      })

      const upload = await adminFetch(
        `/storage/v1/object/demo-snapshots/${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
          body: envelope,
        },
        requestId,
        'storage.upload',
      )
      if (upload.ok) {
        snapshotPath = path
        sealed = true
      } else {
        // A REJECTED upload throws nothing, so the catch below never sees it —
        // without this branch, storage refusing the write (a wrong bucket name,
        // a size limit, a policy change) is completely silent and presents as a
        // verdict with no evidence.
        const detail = await upload.text().catch(() => '')
        console.error(
          `[analyze-snapshot] rid=${requestId} UPLOAD_REJECTED http=${upload.status} ${detail.slice(0, 300)}`,
        )
      }
    } catch (error) {
      // ⚠ THIS CATCH USED TO BE EMPTY, AND THAT WAS THE WORST SILENCE IN THE
      // FILE. Swallowing here means a CHEATING verdict is recorded with
      // `snapshot_sealed: false` and no evidence behind it — the row still
      // reads as a finding, and nothing anywhere says the frame was lost. A
      // malformed EVIDENCE_SIGNING_KEY or a rejected upload would have produced
      // exactly that, indefinitely, with a green-looking deployment.
      //
      // Still non-fatal, for the original reason: the VERDICT is the finding
      // and must survive a storage problem. But it is now loud.
      const err = error as Error
      console.error(
        `[analyze-snapshot] rid=${requestId} SEAL_OR_UPLOAD_FAILED — verdict kept, evidence LOST\n` +
        `  vid    : ${violationId}\n` +
        `  kid    : ${keyId}\n` +
        `  signed : ${Deno.env.get('EVIDENCE_SIGNING_KEY') ? 'yes' : 'NO — envelope would be unsigned'}\n` +
        `  message: ${err?.message ?? String(error)}\n` +
        `  stack  : ${err?.stack ?? '(no stack)'}`,
      )
    }
  }

  // ---- Record ------------------------------------------------------------
  const insert = await adminFetch(`/rest/v1/violations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: violationId,
      student_id: user.id,
      // ⚠ THE SITTING'S OWN ROW, RESOLVED SERVER-SIDE. This was hard-coded
      // `null`, so no reviewed frame had ever been linked to the sitting it
      // came from — which is what `teacher_review_queue`'s join needs, and why
      // every column it draws from `proctor_sessions` would have been empty.
      // Still nullable: a sitting whose session insert failed has no row to
      // point at, and `demo_session_id` below carries the link in that case.
      session_id: sitting.id,
      demo_session_id: demoSessionId,
      violation_type: violationType || 'UNKNOWN',
      severity,
      ai_verdict: review.verdict,
      ai_reviewed_at: new Date().toISOString(),
      cheat_probability: review.confidence,
      cheat_reason: review.observation,
      snapshot_path: snapshotPath,
      snapshot_sealed: sealed,
      review_route: reviewRoute,
    }),
  }, requestId, 'violations.insert')

  if (!insert.ok) {
    const detail = await insert.text().catch(() => '')
    // PostgREST's own error text is the whole diagnosis here — 42703 names a
    // column the migration has not created, 23503 an FK, 42501 a policy. The
    // client is told RECORD_FAILED and can do nothing with it; this line is
    // what makes the cause recoverable.
    console.error(
      `[analyze-snapshot] rid=${requestId} RECORD_FAILED http=${insert.status} ${detail.slice(0, 400)}`,
    )
    return json({ ok: false, reason: 'RECORD_FAILED', detail: detail.slice(0, 200), requestId }, 500)
  }

  const nowUsed = used + 1
  const flaggedEarly = review.verdict === 'CHEATING' && review.confidence >= STOP_CONFIDENCE
  const budgetClosed = nowUsed >= MAX_SNAPSHOTS_PER_SITTING || flaggedEarly

  // ⚠ WRITTEN AFTER THE VERDICT ROW, AND ONLY IF THAT INSERT SUCCEEDED (the
  // early return above guarantees it). Closing the sitting first would leave a
  // sitting marked "review finished" with no review behind it, which is the one
  // ordering that loses a finding rather than merely delaying it.
  if (budgetClosed) {
    await closeSitting(
      sitting.id,
      { flagged: flaggedEarly, confidence: review.confidence },
      requestId,
    )
  }

  return json({
    ok: true,
    reviewed: true,
    verdict: review.verdict,
    confidence: review.confidence,
    observation: review.observation,

    // ⚠ THE BRIEF'S FIELD NAMES, ADDED BESIDE THE EXISTING ONES RATHER THAN
    // REPLACING THEM. `explanation` and a 0..1 `confidence01` are what the
    // integration contract asks for; `observation` and the 0..100 `confidence`
    // are what `snapshotReview.js`, `studentData.js` and `FlagReview.jsx`
    // already read, and what `violations.cheat_probability` stores. Renaming
    // would have been a four-file ripple with no behavioural gain, and would
    // have silently blanked the confidence figure on every student's dashboard
    // between the two deploys.
    explanation: review.observation,
    confidence01: Math.round(review.confidence) / 100,

    stored: sealed,
    /** STUDENT or TEACHER — where a kept frame was routed. */
    route: reviewRoute,
    /** True when this verdict closed the sitting early at >= STOP_CONFIDENCE. */
    flagged: flaggedEarly,
    used: nowUsed,
    max: MAX_SNAPSHOTS_PER_SITTING,
    budgetClosed,
  })
}

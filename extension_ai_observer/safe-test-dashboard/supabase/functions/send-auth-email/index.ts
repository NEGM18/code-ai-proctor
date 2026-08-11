// =============================================================================
// send-auth-email — Supabase Auth "Send Email" hook, delivered via Resend.
//
// GoTrue calls this instead of sending mail itself. Every auth email in the
// project — the 6-digit sign-in code above all — is rendered by ./template.ts
// and handed to Resend's API from here.
//
//   GoTrue --(signed webhook)--> this function --(REST)--> Resend --> inbox
//
// ⚠ WHY A HOOK RATHER THAN JUST POINTING SUPABASE'S SMTP AT RESEND.
// SMTP + the Dashboard template would also deliver "from Resend", and it is a
// perfectly good fallback (documented in README §2d). What it cannot do is keep
// the template in version control, under review, and under test. The one defect
// that matters here — the code not reaching the inbox, or reaching it unstyled
// and unreadable — is invisible until a real user cannot sign in. ./template.ts
// is a pure module precisely so that failure is caught by `npm test`.
//
// ⚠ THIS FUNCTION IS A MAIL SENDER EXPOSED ON THE PUBLIC INTERNET. That is the
// whole threat model. Unverified requests must never be able to make it send
// anything: the recipient, the code and the wording all come from the request
// body, so an unauthenticated caller would have a branded-email cannon pointed
// at any address they liked, billed to our Resend account and spending our
// domain's sending reputation. Signature verification below is not hygiene, it
// is the control — and it fails CLOSED in every branch, including the branch
// where the secret is missing.
// =============================================================================

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0'
import { renderAuthEmail } from './template.ts'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/**
 * The Send Email hook's error contract: a non-2xx status plus this shape.
 * GoTrue surfaces `message` to the client, which is why these strings stay
 * generic — the caller of `signInWithOtp()` is an anonymous visitor, and
 * "SMTP credential rejected" is not something to tell them.
 */
function hookError(httpCode: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: httpCode, message } }), {
    status: httpCode,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return hookError(405, 'Method not allowed')

  const hookSecret = Deno.env.get('SEND_EMAIL_HOOK_SECRET')
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  // Must be a verified Resend sender. `onboarding@resend.dev` works without a
  // domain but ONLY delivers to the Resend account owner's own address — which
  // looks exactly like "the hook is broken" for every other recipient.
  const from = Deno.env.get('AUTH_EMAIL_FROM')
  const replyTo = Deno.env.get('AUTH_EMAIL_REPLY_TO')

  // ⚠ A MISSING SECRET IS A HARD STOP, NEVER A SKIPPED CHECK.
  //
  // The tempting shape is `if (hookSecret) { verify() }` — it keeps local
  // development frictionless. It also means that the single most likely
  // production misconfiguration (forgetting to set one env var) silently
  // converts this endpoint into an open relay, with no error anywhere and mail
  // still flowing correctly for real users. Refusing to run is loud, immediate,
  // and cannot be mistaken for working.
  if (!hookSecret || !resendApiKey || !from) {
    console.error(
      '[send-auth-email] refusing to run — missing env: ' +
      [
        !hookSecret ? 'SEND_EMAIL_HOOK_SECRET' : null,
        !resendApiKey ? 'RESEND_API_KEY' : null,
        !from ? 'AUTH_EMAIL_FROM' : null,
      ].filter(Boolean).join(', '),
    )
    return hookError(500, 'Email service is not configured')
  }

  const payload = await req.text()

  let event: {
    user?: { email?: string }
    email_data?: { token?: string, email_action_type?: string }
  }

  try {
    // The Dashboard shows the secret as `v1,whsec_<base64>`; the library wants
    // the base64 part alone. Pasting the whole string is the common mistake and
    // presents as every request failing verification, so it is stripped here
    // rather than in a README instruction nobody re-reads.
    const webhook = new Webhook(hookSecret.replace(/^v1,whsec_/, ''))
    // Throws on a bad signature, a missing header, or a timestamp outside the
    // replay window. All three are the same answer: do not send anything.
    event = webhook.verify(payload, Object.fromEntries(req.headers)) as typeof event
  } catch (error) {
    console.error('[send-auth-email] signature verification failed:', error)
    return hookError(401, 'Invalid signature')
  }

  const to = event.user?.email
  const token = event.email_data?.token

  // Verified but unusable. Distinguished from a bad signature because the two
  // mean completely different things: this one is a GoTrue payload change or a
  // bug on our side, not an intruder.
  if (!to || !token) {
    console.error('[send-auth-email] verified payload missing recipient or token')
    return hookError(400, 'Malformed email request')
  }

  const { subject, html, text } = renderAuthEmail({
    actionType: event.email_data?.email_action_type,
    token,
    email: to,
  })

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })

  if (!response.ok) {
    // ⚠ REPORT THE FAILURE UPWARD — DO NOT RETURN 200 ON AN UNSENT EMAIL.
    // Returning success here would leave the visitor staring at "we emailed you
    // a code" with nothing ever arriving, and no error anywhere in the system.
    // A failed hook makes GoTrue fail the sign-in request, so the UI shows a
    // real error and the AuthModal's "Send it again" is there to retry.
    //
    // The upstream body is logged, never returned: Resend's messages name the
    // sending domain and quota state, which is our operational detail and not
    // the visitor's business.
    const detail = await response.text().catch(() => '')
    console.error(`[send-auth-email] Resend HTTP ${response.status}: ${detail.slice(0, 500)}`)
    return hookError(502, 'Could not send the verification email')
  }

  // The recipient is NOT logged. These logs are retained by the platform, and an
  // auth-email log is a list of who uses the product and when; the message id is
  // enough to trace a delivery in Resend's own dashboard.
  const sent = await response.json().catch(() => ({}))
  console.log(`[send-auth-email] sent ${event.email_data?.email_action_type ?? 'unknown'} id=${sent?.id ?? 'n/a'}`)

  // A bare 200 with an empty object is the hook's success contract.
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
})

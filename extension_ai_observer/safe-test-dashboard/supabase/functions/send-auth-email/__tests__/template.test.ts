// =============================================================================
// template.test.ts — the code has to be IN the email.
//
// This suite exists because the failure it guards against is invisible: a
// template that renders without throwing but drops the token still sends a
// perfectly well-formed message, Resend still returns 200, the hook still logs
// success, and the only symptom is a real person unable to sign in. Nothing
// upstream of the recipient can detect it.
//
// `template.ts` is deliberately Deno-free so these run under the normal vitest
// pass — see its header.
// =============================================================================

import { describe, expect, it } from 'vitest'

import {
  BRAND,
  CODE_EXPIRY_MINUTES,
  EMAIL_ACTION,
  escapeHtml,
  renderAuthEmail,
} from '../template.ts'

const CODE = '482913'
const RECIPIENT = 'someone@example.com'

describe('the code reaches the message', () => {
  it('puts the code in the HTML body', () => {
    const { html } = renderAuthEmail({ actionType: EMAIL_ACTION.MAGIC_LINK, token: CODE })
    expect(html).toContain(CODE)
  })

  it('puts the code in the plain-text alternative', () => {
    const { text } = renderAuthEmail({ actionType: EMAIL_ACTION.MAGIC_LINK, token: CODE })
    expect(text).toContain(CODE)
  })

  // ⚠ A MISSING text/plain PART IS A DELIVERABILITY BUG, NOT A COSMETIC ONE.
  // HTML-only mail scores worse with spam filters, and a code that lands in
  // spam is indistinguishable — to the user — from a code never sent.
  it('always produces a non-empty text part', () => {
    const { text } = renderAuthEmail({ token: CODE })
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('puts the code in the preheader, so it shows in the inbox preview', () => {
    const { html } = renderAuthEmail({ token: CODE })
    const preheader = html.slice(html.indexOf('<body'), html.indexOf('<table'))
    expect(preheader).toContain(CODE)
  })

  // The code is retyped and copy-pasted by humans and scraped by password
  // managers. It must be one contiguous text run — never an image, never split
  // across per-character cells.
  it('renders the code as one contiguous text run', () => {
    const { html } = renderAuthEmail({ token: CODE })
    expect(html).toMatch(new RegExp(`>${CODE}<`))
    expect(html).not.toContain('<img')
  })
})

describe('per-action copy', () => {
  it('uses sign-in wording for the magic-link/OTP action', () => {
    const { subject } = renderAuthEmail({ actionType: EMAIL_ACTION.MAGIC_LINK, token: CODE })
    expect(subject).toBe('Your Procminds sign-in code')
  })

  // ⚠ RECOVERY MUST NOT READ LIKE A ROUTINE SIGN-IN. This is the message a
  // recipient has to be able to recognise as something they did NOT do.
  it('gives password recovery its own subject and body', () => {
    const { subject, html } = renderAuthEmail({ actionType: EMAIL_ACTION.RECOVERY, token: CODE })
    expect(subject).toBe('Reset your Procminds password')
    expect(html).toContain('did not ask for this')
  })

  it('treats both halves of an email change identically', () => {
    const current = renderAuthEmail({ actionType: EMAIL_ACTION.EMAIL_CHANGE_CURRENT, token: CODE })
    const next = renderAuthEmail({ actionType: EMAIL_ACTION.EMAIL_CHANGE_NEW, token: CODE })
    expect(current.subject).toBe(next.subject)
  })

  // ⚠ THE FALLBACK IS WHAT KEEPS A GoTrue UPGRADE FROM BREAKING SIGN-IN.
  // A throw here would make the hook return an error, and GoTrue treats a
  // failed Send Email hook as a failed auth request.
  it.each([
    ['an unknown action', 'some_future_action'],
    ['no action at all', undefined],
  ])('falls back to neutral copy for %s, still carrying the code', (_label, actionType) => {
    const { subject, html, text } = renderAuthEmail({ actionType, token: CODE })
    expect(subject).toBe('Your Procminds verification code')
    expect(html).toContain(CODE)
    expect(text).toContain(CODE)
  })
})

describe('escaping', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;')
  })

  it('renders null and undefined as an empty string, not "null"', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  // ⚠ HTML INJECTION INTO AN AUTH EMAIL IS A PHISHING PRIMITIVE — it renders in
  // the recipient's client behind our branding and our From: address. GoTrue
  // controls these fields today; the escaping must not depend on that staying
  // true.
  it('neutralises markup smuggled through the recipient address', () => {
    const { html } = renderAuthEmail({
      token: CODE,
      email: '<img src=x onerror=alert(1)>@example.com',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('neutralises markup smuggled through the token', () => {
    const { html } = renderAuthEmail({ token: '<b>000000</b>' })
    expect(html).not.toContain('<b>000000</b>')
    expect(html).toContain('&lt;b&gt;000000&lt;/b&gt;')
  })
})

describe('no login link', () => {
  // ⚠ DELIBERATE, AND PINNED SO IT STAYS DELIBERATE. The app consumes the code
  // through verifyOtp() and nothing else, so a one-click link would be a second
  // auth path the sign-in wall was never built around — and a proctoring vendor
  // emailing "click here to sign in" trains the exact reflex that makes
  // credential phishing work. Adding a link means designing it into the client
  // flow, not editing the template.
  it('contains no anchor tags', () => {
    const { html } = renderAuthEmail({ actionType: EMAIL_ACTION.MAGIC_LINK, token: CODE, email: RECIPIENT })
    expect(html).not.toMatch(/<a\s/i)
  })

  it('contains no http(s) URL in either part', () => {
    const { html, text } = renderAuthEmail({ token: CODE, email: RECIPIENT })
    expect(html).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/https?:\/\//)
  })
})

describe('recipient echo and expiry', () => {
  it('names the recipient when known, so a misdirected code is obvious', () => {
    const { html, text } = renderAuthEmail({ token: CODE, email: RECIPIENT })
    expect(html).toContain(RECIPIENT)
    expect(text).toContain(RECIPIENT)
  })

  it('omits the "Sent to" line entirely rather than printing an empty one', () => {
    const { html, text } = renderAuthEmail({ token: CODE })
    expect(html).not.toContain('Sent to ')
    expect(text).not.toContain('Sent to ')
  })

  it('states the expiry, defaulting to the configured otp_expiry', () => {
    const { html } = renderAuthEmail({ token: CODE })
    expect(CODE_EXPIRY_MINUTES).toBe(60)
    expect(html).toContain(`expires in ${CODE_EXPIRY_MINUTES} minutes`)
  })

  it('honours an explicit expiry override', () => {
    const { html } = renderAuthEmail({ token: CODE, expiryMinutes: 15 })
    expect(html).toContain('expires in 15 minutes')
  })
})

describe('email-client compatibility', () => {
  // Each of these is a client that silently degrades rather than erroring, so
  // none of them would be caught by "does it render in my browser".
  it('uses table layout, not flex/grid — Outlook renders through Word', () => {
    const { html } = renderAuthEmail({ token: CODE })
    expect(html).toContain('<table')
    expect(html).not.toContain('display:flex')
    expect(html).not.toContain('display:grid')
  })

  it('carries no <style> block — Gmail strips <head> on clipped mail', () => {
    const { html } = renderAuthEmail({ token: CODE })
    expect(html).not.toMatch(/<style[\s>]/i)
  })

  it('loads no remote asset — blocked images are the default', () => {
    const { html } = renderAuthEmail({ token: CODE })
    expect(html).not.toMatch(/<img|@font-face|url\(/i)
  })

  it('declares a colour scheme so dark-mode clients do not invert the panel', () => {
    const { html } = renderAuthEmail({ token: CODE })
    expect(html).toContain('name="color-scheme"')
    expect(html).toContain(BRAND.base)
  })
})

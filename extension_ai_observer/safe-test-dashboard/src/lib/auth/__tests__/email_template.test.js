// =============================================================================
// email_template.test.js — the Supabase email template's contract.
//
// The template is rendered by Supabase (GoTrue), not by us, so there is no
// render function to unit-test. What CAN be tested is the file itself, and it
// is worth testing because its failure mode is completely silent: drop
// `{{ .Token }}` and Supabase still renders the template, still sends the mail,
// still reports success, and the only symptom is a real person stuck on the
// code step with nothing to type. Nothing upstream of the recipient notices.
//
// ⚠ THIS FILE PINS THE REPO'S COPY, WHICH IS NOT THE ONE PRODUCTION SENDS.
// The hosted project renders whatever is pasted into Dashboard ->
// Authentication -> Email Templates. A green run here means "the source of
// truth is correct", never "production is correct" — see README §2d. Re-paste
// after every change to this template.
// =============================================================================

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Resolved from this file rather than from process.cwd(): vitest can be invoked
// from the repo root or from safe-test-dashboard/, and a cwd-relative path
// silently reads nothing (or the wrong file) depending on which.
const TEMPLATE_PATH = fileURLToPath(
  new URL('../../../../supabase/templates/magic_link.html', import.meta.url),
)
const source = readFileSync(TEMPLATE_PATH, 'utf8')

/**
 * What GoTrue actually sends.
 *
 * ⚠ THE ASSERTIONS BELOW MUST RUN AGAINST THE RENDERED OUTPUT, NOT THE SOURCE.
 * Go's text/template strips `{{/* … *␘/}}` comments, and the template's header
 * comment necessarily *names* the things this suite forbids — it explains why
 * there is no `{{ .ConfirmationURL }}` and no `<style>` block. Testing the raw
 * file therefore fails on its own documentation, and the obvious "fix" is to
 * delete the explanation, which is exactly backwards: the comment is why the
 * rule survives the next edit.
 */
const template = source.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '')

describe('the code is actually in the template', () => {
  // ⚠ THE ONE ASSERTION THAT MATTERS. Everything else here is styling.
  it('interpolates GoTrue\'s {{ .Token }}', () => {
    expect(template).toMatch(/\{\{\s*\.Token\s*\}\}/)
  })

  it('shows the code in the visible body, not only in the hidden preheader', () => {
    // The preheader is the first hidden <div>; the body follows the first
    // <table>. Both should carry it, but the body one is non-negotiable.
    const body = template.slice(template.indexOf('<table'))
    expect(body).toMatch(/\{\{\s*\.Token\s*\}\}/)
  })

  it('also puts the code in the preheader, for the inbox preview line', () => {
    const preheader = template.slice(template.indexOf('<body'), template.indexOf('<table'))
    expect(preheader).toMatch(/\{\{\s*\.Token\s*\}\}/)
  })

  it('names the recipient, so a misdirected code is obvious', () => {
    expect(template).toMatch(/\{\{\s*\.Email\s*\}\}/)
  })
})

describe('no login link', () => {
  // ⚠ DELIBERATE, AND PINNED SO IT STAYS DELIBERATE. The app consumes the code
  // through verifyOtp() and nothing else, so a one-click link would be a second
  // auth path that DemoGate, the AuthModal step machine and
  // session_is_verified_human() were never built around — and a proctoring
  // vendor mailing "click here to sign in" trains the exact reflex that makes
  // credential phishing work. Adding a link means designing it into the client
  // flow first, not editing the template.
  it('does not use {{ .ConfirmationURL }}', () => {
    expect(template).not.toMatch(/\{\{\s*\.ConfirmationURL\s*\}\}/)
  })

  it('contains no anchor tags', () => {
    expect(template).not.toMatch(/<a\s/i)
  })

  it('contains no http(s) URL', () => {
    // Nothing in this template legitimately needs one — no assets, no links —
    // so the assertion can be absolute rather than allow-listed.
    expect(template).not.toMatch(/https?:\/\//)
  })
})

describe('email-client compatibility', () => {
  // Each of these degrades silently in a real client rather than erroring, so
  // none would be caught by "it looks fine in my browser".
  it('uses table layout, not flex/grid — Outlook renders through Word', () => {
    expect(template).toContain('<table')
    expect(template).not.toContain('display:flex')
    expect(template).not.toContain('display:grid')
  })

  it('carries no <style> block — Gmail strips <head> on clipped mail', () => {
    expect(template).not.toMatch(/<style[\s>]/i)
  })

  it('loads no remote asset — blocked images are the default', () => {
    expect(template).not.toMatch(/<img|@font-face|url\(/i)
  })

  it('declares a colour scheme so dark-mode clients do not invert the panel', () => {
    expect(template).toContain('name="color-scheme"')
  })

  // The code gets retyped by humans and scraped by password managers and iOS
  // autofill. It must stay one contiguous text run — never an image, never
  // split across per-character table cells.
  it('renders the code as a single contiguous text run', () => {
    expect(template).toMatch(/>\{\{\s*\.Token\s*\}\}</)
  })

  it('uses a monospace stack for the code, so 0/O and 1/l stay distinguishable', () => {
    const bodyStart = template.indexOf('<table')
    const codeIndex = template.indexOf('{{ .Token }}', bodyStart)
    const preceding = template.slice(Math.max(0, codeIndex - 400), codeIndex)
    expect(preceding).toMatch(/monospace/)
  })
})

describe('the header comment stays a comment', () => {
  // The stripping above is only sound if the header really is a Go comment.
  // Written as an HTML comment instead, it would ship to every recipient —
  // and it discusses the auth design, the phishing reasoning and the file
  // layout. Belongs in the repo, not in a stranger's inbox.
  it('uses {{/* … */}}, so it never reaches the recipient', () => {
    expect(source.trimStart().startsWith('{{/*')).toBe(true)
    expect(template).not.toContain('magic_link.html —')
  })

  it('emits nothing before the doctype', () => {
    expect(template.trimStart().startsWith('<!doctype html>')).toBe(true)
  })
})

describe('config agreement', () => {
  // The template states an expiry in prose; `auth.email.otp_expiry` is 3600s.
  // A template promising 10 minutes against an hour-long token is the kind of
  // mismatch nobody notices until a user reports a code "expired" when it had
  // not, or trusts a stale one that had.
  it('states the same expiry the config sets (60 minutes)', () => {
    expect(template).toContain('60 minutes')
  })
})

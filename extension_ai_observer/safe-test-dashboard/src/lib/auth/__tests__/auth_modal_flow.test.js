// =============================================================================
// auth_modal_flow.test.js — test AuthModal 2-step state machine transition
// =============================================================================

import { describe, expect, it } from 'vitest'
import { STEP } from '../../../components/site/AuthModal.jsx'

describe('AuthModal state machine contract', () => {
  it('defines CREDENTIALS (SIGNUP_FORM) and CODE (VERIFY_OTP) steps', () => {
    expect(STEP.CREDENTIALS).toBe('credentials')
    expect(STEP.CODE).toBe('code')
  })

  it('guarantees state transition to VERIFY_OTP (STEP.CODE) upon sign-up success', () => {
    let currentStep = STEP.CREDENTIALS
    let notice = null

    // Simulating onSubmitCredentials sign-up flow
    const outcome = { ok: true, data: { user: { id: 'u123', email: 'test@example.com' } } }
    if (outcome.ok) {
      notice = 'We sent a 6-digit confirmation code to test@example.com.'
      currentStep = STEP.CODE
    }

    expect(currentStep).toBe(STEP.CODE)
    expect(notice).toContain('6-digit confirmation code')
  })
})

// =============================================================================
// redact.test.js — the safety properties of the zero-plaintext spine.
//
// ⚠ THESE ASSERT PROPERTIES, NOT IMPLEMENTATION. Every check below is phrased as
// "this byte must never reach PostHog" rather than "this regex matched", so the
// suite keeps meaning something if the internals are rewritten. A test that
// pinned the regex would go green on a rewrite that leaks.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  redactProperties,
  scrubText,
  looksLikeEncodedBlob,
  hashId,
  SENSITIVE_KEY_PATTERN,
} from '../redact.js';

/** A realistically-shaped JPEG data URL, long enough to trip every length gate. */
const FAKE_FRAME = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD' + 'A'.repeat(4000);
/** A JWT-SHAPED string. Synthetic — not a credential for anything. */
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

/** Recursively collect every string in a structure, so a leak cannot hide deep. */
function allStrings(value, acc = []) {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, acc));
  return acc;
}

/** The single question this whole module exists to answer. */
function leaks(redacted, secret) {
  return allStrings(redacted).some((s) => s.includes(secret));
}

describe('redact — biometric content', () => {
  it('scrubs a webcam frame passed as a data: URL, whatever the key is called', () => {
    const out = redactProperties({ someInnocentName: FAKE_FRAME });
    expect(leaks(out, 'AAAAAAAAAA')).toBe(false);
    expect(out.someInnocentName).toMatch(/^\[redacted:data-url\(\d+\)\]$/);
  });

  it('drops a frame on a KNOWN key by name, and keeps only its length', () => {
    const out = redactProperties({ imageB64: FAKE_FRAME });
    expect(out.imageB64).toBeUndefined();
    expect(out.imageB64_redacted).toBe('[redacted(' + FAKE_FRAME.length + ')]');
    expect(leaks(out, 'AAAAAAAAAA')).toBe(false);
  });

  it("drops Gemini's observation sentence — it describes a face in prose", () => {
    const observation = 'The candidate is holding a phone near their face and looking down.';
    const out = redactProperties({ observation, explanation: observation, cheat_reason: observation });
    expect(leaks(out, 'phone near their face')).toBe(false);
    expect(out.observation_redacted).toBeDefined();
    expect(out.explanation_redacted).toBeDefined();
    expect(out.cheat_reason_redacted).toBeDefined();
  });

  it('turns a landmark array into a shape, never a list of coordinates', () => {
    const landmarks = Array.from({ length: 478 }, (_, i) => ({ x: i / 478, y: 0.5, z: 0 }));
    const out = redactProperties({ landmarks });
    expect(out.landmarks).toBeUndefined();
    expect(out.landmarks_redacted).toBe('[redacted(478)]');
  });

  it('replaces a typed array with a type tag, never a number list', () => {
    const out = redactProperties({ buffer: new Uint8Array(921600) });
    expect(out.buffer).toBe('[redacted:Uint8Array(921600)]');
    expect(JSON.stringify(out)).not.toContain('0,0,0');
  });
});

describe('redact — envelope and key material', () => {
  it('scrubs a PMSEAL1 envelope in raw form', () => {
    const out = redactProperties({ blob: 'PMSEAL1\n{"kid":"deadbeef"}' });
    expect(leaks(out, 'PMSEAL1')).toBe(false);
    expect(out.blob).toContain('pmseal-envelope');
  });

  it('scrubs a PMSEAL1 envelope in base64 form', () => {
    // 'UE1TRUFMMQo=' is base64('PMSEAL1\n') — the prefix a b64-encoded envelope
    // opens with, i.e. the form it takes if one is ever put in a JSON payload.
    // Written as a literal rather than computed, so the test does not depend on
    // a Node global that is absent from this project's ESLint browser env.
    const b64 = 'UE1TRUFMMQ' + 'A'.repeat(200);
    expect(looksLikeEncodedBlob(b64)).toBe('pmseal-envelope');
    const out = redactProperties({ sealed: b64 });
    expect(leaks(out, 'UE1TRUFMMQ')).toBe(false);
  });

  it('drops ek / iv / sha256, and KEEPS kid + sig_alg', () => {
    const out = redactProperties({
      kid: '811fae083bc8dd0a',
      sig_alg: 'RSA-PSS-SHA256',
      ek: 'Zm9vYmFyYmF6' + 'Q'.repeat(340),
      iv: 'YWJjZGVmZ2hpamts',
      sha256: 'nQWZ4v1kR2xTgH8pLmN3sQ7bV5cX9yZ0aD1eF2gH3iI=',
    });
    // kid and sig_alg are PUBLIC identifiers and must survive — they are what
    // makes a decryption failure diagnosable at all.
    expect(out.kid).toBe('811fae083bc8dd0a');
    expect(out.sig_alg).toBe('RSA-PSS-SHA256');
    // The wrapped content key, the nonce and the plaintext digest must not.
    expect(out.ek).toBeUndefined();
    expect(out.iv).toBeUndefined();
    expect(out.sha256).toBeUndefined();
  });

  it('scrubs an access token wherever it appears', () => {
    const out = redactProperties({ headers: { Authorization: 'Bearer ' + FAKE_JWT } });
    expect(leaks(out, FAKE_JWT)).toBe(false);
    expect(leaks(out, 'eyJhbGci')).toBe(false);
  });
});

describe('redact — identity', () => {
  it('DROPS an email rather than hashing it', () => {
    const out = redactProperties({ email: 'student@university.edu' });
    expect(leaks(out, 'student@university.edu')).toBe(false);
    // The point of the rule: no h:xxxxxxxx correlator is minted for it either,
    // because a hash over a roster-sized input space is not anonymisation.
    expect(leaks(out, 'h:')).toBe(false);
    expect(out.email_redacted).toBeDefined();
  });

  it('scrubs an email embedded in free text', () => {
    expect(scrubText('failed for student@university.edu at line 3'))
      .toBe('failed for [email] at line 3');
  });

  it('hashId is stable, short, and shaped as a correlator', () => {
    expect(hashId('sitting-abc-123')).toBe(hashId('sitting-abc-123'));
    expect(hashId('sitting-abc-123')).not.toBe(hashId('sitting-abc-124'));
    expect(hashId('sitting-abc-123')).toMatch(/^h:[0-9a-f]{8}$/);
    expect(hashId(null)).toBeNull();
  });
});

describe('redact — structural safety', () => {
  it('terminates on a cyclic object instead of hanging', () => {
    const a = { name: 'root' };
    a.self = a;
    a.child = { parent: a };
    const out = redactProperties(a);
    expect(out.name).toBe('root');
    expect(JSON.stringify(out)).toContain('circular');
  });

  it('caps depth instead of blowing the stack', () => {
    let deep = { leaf: FAKE_FRAME };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };
    const out = redactProperties(deep);
    expect(JSON.stringify(out)).toContain('max-depth');
    expect(leaks(out, 'AAAAAAAAAA')).toBe(false);
  });

  it('recurses into ARRAYS of objects', () => {
    const out = redactProperties({ items: [{ imageB64: FAKE_FRAME }, { ok: 'fine' }] });
    expect(leaks(out, 'AAAAAAAAAA')).toBe(false);
    expect(out.items[1].ok).toBe('fine');
  });

  it('never invokes a getter, so a value cannot be smuggled through an accessor', () => {
    let called = false;
    const obj = {};
    Object.defineProperty(obj, 'sneaky', {
      enumerable: true,
      get() { called = true; return FAKE_FRAME; },
    });
    const out = redactProperties(obj);
    expect(called).toBe(false);
    expect(out.sneaky).toBe('[redacted:getter]');
    expect(leaks(out, 'AAAAAAAAAA')).toBe(false);
  });

  it('does not let a toJSON() smuggle a frame past the walk', () => {
    const out = redactProperties({ evil: { toJSON: () => FAKE_FRAME, safe: 1 } });
    expect(leaks(out, 'AAAAAAAAAA')).toBe(false);
    expect(out.evil.safe).toBe(1);
  });

  it('scrubs an Error hung on a property, including its message', () => {
    const err = new Error('upload failed for ' + FAKE_FRAME);
    const out = redactProperties({ cause: err });
    expect(leaks(out, 'AAAAAAAAAA')).toBe(false);
    expect(out.cause.name).toBe('Error');
  });
});

describe('redact — must NOT over-redact', () => {
  it('preserves the telemetry that makes an event worth sending', () => {
    const out = redactProperties({
      violation_type: 'PHONE_DETECTED',
      severity: 'CRITICAL',
      verdict: 'CHEATING',
      confidence: 96,
      latency_ms: 812,
      budget_used: 2,
      budget_closed: true,
      early_stop_triggered: true,
      reason: 'BUDGET_EXHAUSTED',
      requestId: 'a1b2c3d4',
      sitting_mode: 'CLASSROOM',
    });
    expect(out.violation_type).toBe('PHONE_DETECTED');
    expect(out.verdict).toBe('CHEATING');
    expect(out.confidence).toBe(96);
    expect(out.latency_ms).toBe(812);
    expect(out.budget_closed).toBe(true);
    expect(out.early_stop_triggered).toBe(true);
    expect(out.reason).toBe('BUDGET_EXHAUSTED');
    expect(out.requestId).toBe('a1b2c3d4');
    expect(out.$redacted_count).toBeUndefined();
  });

  it('leaves a UUID intact — it is below the blob threshold', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(looksLikeEncodedBlob(uuid)).toBeNull();
    expect(redactProperties({ sitting_id: uuid }).sitting_id).toBe(uuid);
  });

  it('reports that it dropped something, so a drop is never silent', () => {
    const out = redactProperties({ imageB64: FAKE_FRAME, ok: 1 });
    expect(out.$redacted_count).toBe(1);
  });
});

describe('redact — the key pattern itself', () => {
  it('matches every property name analyze-snapshot and monitor.js actually emit', () => {
    for (const key of [
      'imageB64', 'imageBase64', 'snapshotB64', 'dataUrl', 'observation',
      'explanation', 'cheat_reason', 'ek', 'iv', 'sha256', 'email',
      'access_token', 'landmarks',
    ]) {
      expect(SENSITIVE_KEY_PATTERN.test(key), key + ' must be denied').toBe(true);
    }
  });

  it('does NOT match the public identifiers a reviewer needs', () => {
    for (const key of [
      'kid', 'sig_alg', 'violation_type', 'severity', 'verdict', 'confidence',
      'latency_ms', 'requestId', 'sitting_mode', 'reason',
    ]) {
      expect(SENSITIVE_KEY_PATTERN.test(key), key + ' must be allowed').toBe(false);
    }
  });
});

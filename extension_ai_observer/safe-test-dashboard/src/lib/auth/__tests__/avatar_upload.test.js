// =============================================================================
// avatar_upload.test.js
//
// Pins the profile-picture upload path. Every assertion here corresponds to a
// defect that actually shipped, so read the comment before relaxing one.
//
// ⚠ THE FIRST TEST IN "regression" IS THE WHOLE REASON THIS FILE EXISTS. The
// original implementation uploaded to the `demo-snapshots` bucket at
// `avatars/<uid>/profile.<ext>`. That bucket's RLS requires the first folder to
// be literally `demo`, so every upload was rejected before a byte was stored —
// and the UI reported it as a generic "Supabase error", which read like the
// server was unreachable. Nothing in the client asserted which bucket it wrote
// to, so the mistake was invisible to the suite.
//
// This is the first file here to mock `../../supabase.js`. That module exports a
// configured singleton, so a factory mock is the only way to observe the calls
// without a live project.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const UID = '3f9c1a2e-7b41-4c8d-9e02-5a6f1c3db7d4'
const OTHER_UID = '8d2b4f16-0c93-4a75-b1e8-2f7a9c4e5d31'

/**
 * Records every storage call so the tests can assert on the BUCKET as well as
 * the arguments — the bucket is the thing that was wrong, and a mock capturing
 * only paths would have passed against the broken code.
 */
const calls = { upload: [], list: [], remove: [], sign: [] }

/** Per-test overrides for what the fake storage returns. */
let uploadResult
let listResult
let signResult

vi.mock('../../supabase.js', () => ({
  isSupabaseConfigured: true,
  SUPABASE_UNCONFIGURED_REASON: 'SUPABASE_UNCONFIGURED',
  AVATARS_BUCKET: 'avatars',
  DEMO_SNAPSHOTS_BUCKET: 'demo-snapshots',
  supabase: {
    storage: {
      from(bucket) {
        return {
          upload(path, file, options) {
            calls.upload.push({ bucket, path, file, options })
            return Promise.resolve(uploadResult)
          },
          list(prefix) {
            calls.list.push({ bucket, prefix })
            return Promise.resolve(listResult)
          },
          remove(paths) {
            calls.remove.push({ bucket, paths })
            return Promise.resolve({ data: [], error: null })
          },
          createSignedUrl(path, expiresIn) {
            calls.sign.push({ bucket, path, expiresIn })
            return Promise.resolve(signResult)
          },
        }
      },
    },
  },
}))

const { createAvatarSignedUrl, removeProfilePicture, uploadProfilePicture } = await import(
  '../authService.js'
)

/** Only `type` and `size` are read; `name` is present precisely to prove it is ignored. */
function fakeFile({ type = 'image/png', size = 1024, name = 'photo.png' } = {}) {
  return { type, size, name }
}

beforeEach(() => {
  calls.upload = []
  calls.list = []
  calls.remove = []
  calls.sign = []
  uploadResult = { data: { path: 'ok' }, error: null }
  listResult = { data: [], error: null }
  signResult = { data: { signedUrl: 'https://example.test/signed' }, error: null }
})

// ---------------------------------------------------------------------------

describe('uploadProfilePicture — regression', () => {
  it('writes to the avatars bucket, NEVER to demo-snapshots', async () => {
    await uploadProfilePicture(UID, fakeFile())

    expect(calls.upload).toHaveLength(1)
    expect(calls.upload[0].bucket).toBe('avatars')
    // The exact shape of the original bug: a `demo-snapshots` write whose first
    // folder is `avatars`, which that bucket's RLS rejects unconditionally.
    expect(calls.upload.some((c) => c.bucket === 'demo-snapshots')).toBe(false)
    expect(calls.upload[0].path.startsWith('avatars/')).toBe(false)
  })

  it('scopes the path to the caller uid, because RLS compares exactly that folder', async () => {
    const result = await uploadProfilePicture(UID, fakeFile())

    expect(result.ok).toBe(true)
    expect(result.path).toBe(`${UID}/avatar.png`)
    // foldername(name)[1] — what the policy reads.
    expect(result.path.split('/')[0]).toBe(UID)
    expect(result.path).not.toContain(OTHER_UID)
  })
})

describe('uploadProfilePicture — the extension comes from the MIME type', () => {
  // Deriving it from `file.name.split('.').pop()` (the original approach) lets an
  // attacker-controlled string decide the storage path.
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ])('%s is stored as .%s', async (type, ext) => {
    const result = await uploadProfilePicture(UID, fakeFile({ type }))
    expect(result.path).toBe(`${UID}/avatar.${ext}`)
  })

  it('ignores the filename entirely, including a traversal attempt', async () => {
    const result = await uploadProfilePicture(
      UID,
      fakeFile({ type: 'image/png', name: '../../../etc/passwd.php' }),
    )

    expect(result.ok).toBe(true)
    expect(result.path).toBe(`${UID}/avatar.png`)
    expect(result.path).not.toContain('..')
    expect(result.path).not.toContain('php')
  })

  it('declares the content type, so the bucket can enforce its allowlist', async () => {
    await uploadProfilePicture(UID, fakeFile({ type: 'image/webp' }))
    expect(calls.upload[0].options.contentType).toBe('image/webp')
    // Same-format replacement must overwrite rather than 409.
    expect(calls.upload[0].options.upsert).toBe(true)
  })
})

describe('uploadProfilePicture — rejections happen before any bytes move', () => {
  it.each([['image/svg+xml'], ['application/pdf'], ['text/html'], ['']])(
    'refuses %s without calling upload',
    async (type) => {
      const result = await uploadProfilePicture(UID, fakeFile({ type }))

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('UNSUPPORTED_TYPE')
      expect(result.path).toBeNull()
      expect(calls.upload).toHaveLength(0)
    },
  )

  it('refuses a file over 5 MiB without calling upload', async () => {
    const result = await uploadProfilePicture(UID, fakeFile({ size: 5 * 1024 * 1024 + 1 }))

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('TOO_LARGE')
    expect(calls.upload).toHaveLength(0)
  })

  it('accepts a file exactly at the limit', async () => {
    const result = await uploadProfilePicture(UID, fakeFile({ size: 5 * 1024 * 1024 }))
    expect(result.ok).toBe(true)
  })

  it('refuses a missing uid or file', async () => {
    expect((await uploadProfilePicture(null, fakeFile())).reason).toBe('MISSING_INPUT')
    expect((await uploadProfilePicture(UID, null)).reason).toBe('MISSING_INPUT')
    expect(calls.upload).toHaveLength(0)
  })
})

describe('uploadProfilePicture — a storage failure is reported, never papered over', () => {
  // The original code fell through to storing the base64 preview in the JWT's
  // user_metadata, which inflated every later request header by megabytes.
  it('returns UPLOAD_FAILED and no path when storage rejects the write', async () => {
    uploadResult = { data: null, error: { message: 'new row violates row-level security policy' } }

    const result = await uploadProfilePicture(UID, fakeFile())

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('UPLOAD_FAILED')
    expect(result.path).toBeNull()
    // The underlying error is preserved for logging rather than swallowed.
    expect(result.error).toBeTruthy()
  })

  it('does not sweep old files when the upload failed', async () => {
    uploadResult = { data: null, error: { message: 'boom' } }
    listResult = { data: [{ name: 'avatar.jpg' }], error: null }

    await uploadProfilePicture(UID, fakeFile())

    expect(calls.remove).toHaveLength(0)
  })
})

describe('uploadProfilePicture — stale format variants', () => {
  it('removes a previous avatar stored under a different extension', async () => {
    listResult = { data: [{ name: 'avatar.jpg' }, { name: 'avatar.png' }], error: null }

    const result = await uploadProfilePicture(UID, fakeFile({ type: 'image/png' }))

    expect(result.path).toBe(`${UID}/avatar.png`)
    expect(calls.remove).toHaveLength(1)
    expect(calls.remove[0].bucket).toBe('avatars')
    expect(calls.remove[0].paths).toEqual([`${UID}/avatar.jpg`])
    // ⚠ The file just written must survive its own cleanup.
    expect(calls.remove[0].paths).not.toContain(`${UID}/avatar.png`)
  })

  it('removes nothing when the folder holds only the new file', async () => {
    listResult = { data: [{ name: 'avatar.png' }], error: null }

    await uploadProfilePicture(UID, fakeFile({ type: 'image/png' }))

    expect(calls.remove).toHaveLength(0)
  })
})

describe('removeProfilePicture', () => {
  it('lists and removes only within the caller own folder', async () => {
    listResult = { data: [{ name: 'avatar.png' }, { name: 'avatar.webp' }], error: null }

    const result = await removeProfilePicture(UID)

    expect(result.ok).toBe(true)
    expect(calls.list[0]).toEqual({ bucket: 'avatars', prefix: UID })
    expect(calls.remove[0].paths).toEqual([`${UID}/avatar.png`, `${UID}/avatar.webp`])
    expect(calls.remove[0].paths.every((p) => p.startsWith(`${UID}/`))).toBe(true)
  })

  it('reports ok on a storage failure, since a stray orphan must not fail a save', async () => {
    listResult = Promise.reject(new Error('network'))
    await expect(removeProfilePicture(UID)).resolves.toEqual({ ok: true })
  })

  it('is a no-op without a uid', async () => {
    await removeProfilePicture(null)
    expect(calls.list).toHaveLength(0)
    expect(calls.remove).toHaveLength(0)
  })
})

describe('createAvatarSignedUrl', () => {
  it('signs against the avatars bucket with a finite TTL', async () => {
    const url = await createAvatarSignedUrl(`${UID}/avatar.png`)

    expect(url).toBe('https://example.test/signed')
    expect(calls.sign[0].bucket).toBe('avatars')
    expect(calls.sign[0].path).toBe(`${UID}/avatar.png`)
    // ⚠ Must stay short. A long-lived signed URL persisted anywhere becomes a
    // bearer token with a year of life; the column stores the PATH for this reason.
    expect(calls.sign[0].expiresIn).toBeGreaterThan(0)
    expect(calls.sign[0].expiresIn).toBeLessThanOrEqual(60 * 60 * 24)
  })

  it('returns null for an absent path without calling storage', async () => {
    expect(await createAvatarSignedUrl(null)).toBeNull()
    expect(await createAvatarSignedUrl(undefined)).toBeNull()
    expect(await createAvatarSignedUrl('')).toBeNull()
    expect(calls.sign).toHaveLength(0)
  })

  it('returns null when signing fails, so the caller falls back to initials', async () => {
    signResult = { data: null, error: { message: 'object not found' } }
    expect(await createAvatarSignedUrl(`${UID}/avatar.png`)).toBeNull()
  })
})

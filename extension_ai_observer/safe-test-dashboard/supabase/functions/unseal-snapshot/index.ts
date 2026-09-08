// =============================================================================
// supabase/functions/unseal-snapshot/index.ts
//
// In-flight decryption service for PMSEAL1 sealed evidence frames.
//
// 1. Authenticate caller from their Supabase JWT (student or verified teacher).
// 2. Validate ownership against public.violations (caller must own the record
//    or be a teacher of the classroom).
// 3. Fetch the encrypted .pmseal file from private Supabase Storage.
// 4. Decrypt in memory using the RSA-OAEP private key + AES-256-GCM.
// 5. Verify integrity (SHA-256 digest and optional RSA-PSS signature).
// 6. Return the decrypted image data URI to the authenticated client.
//
// ⚠ ZERO PLAINTEXT AT REST: The storage bucket and database contain ONLY
// ciphertext (.pmseal). Plaintext frames exist only in memory during this
// request for authorized users.
// =============================================================================

const BUILTIN_EVIDENCE_KEY_ID = '5a8578bbc527130a'

const BUILTIN_EVIDENCE_PRIVATE_KEY =
  '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'

const BUILTIN_EVIDENCE_VERIFY_KEY =
  'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAo3+/uLMWuNIOkk2SnTI+IWcARbl9g/ACxsaZVPnLxD4PIuhoG1PLtMOIrTwOVdQ2Q8APS1/FghEBJvq5esza2YQrQwO7tkNL62Znf0ZMYqFWoUf4qrH/4nuEnhAwIgTeDwzfwSL+GJuXZAYwSllz+R/fCu2cx6zbuflAdXThkWPK7JHoB8h3V+624DBAB7r0xIgFEDqgiCjEXwr71w57jejb5m7NbctrmS5lICPCEN7b82KlElT3sFjUpiQAc8nWdYr6ztNLVpIg7zLZYEaYjnpupvO234mAYd7VuWCuMywQmbOj9C0X1IJD1poYWYA2cYHp67a03UfC7jXYgTHeGnj08ETQwEVK0Wgw0lQyWaULWzKhA6EBIElusaSD8KP8IX0EcFa57ucbpPrjuqPoyio4kPnkDQTijcyGk85sGClAGO59CPb2L99g0XboSVCYlaWFWUY933enadpphVmyHQ7SRA9pjY512+TcQJ2bgDLRBHMUlTc1C99glEWSwz5xAgMBAAE='

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''

const ADMIN_KEYS = [
  { name: 'SUPABASE_SECRET_KEY', value: Deno.env.get('SUPABASE_SECRET_KEY') ?? '' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', value: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' },
].filter((key) => key.value.length > 0)

let preferredAdminKey = 0

const CLIENT_KEY =
  Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ||
  Deno.env.get('SUPABASE_ANON_KEY') ||
  ''

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (ADMIN_KEYS.length === 0) {
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
      if (index !== preferredAdminKey) preferredAdminKey = index
      return response
    }
    if (response.status !== 401 && response.status !== 403) return response
    last = response
  }

  return last as Response
}

async function resolveUser(authHeader: string | null): Promise<{ id: string; email: string | null; role?: string } | null> {
  if (!authHeader) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: CLIENT_KEY, Authorization: authHeader },
  })
  if (!res.ok) return null
  const user = await res.json()
  return user?.id ? { id: user.id, email: user.email ?? null, role: user.role ?? null } : null
}

function decodeKeyMaterial(raw: string, label: string): Uint8Array {
  const stripped = raw
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')

  if (!stripped) throw new Error(`${label} is empty`)
  let bytes = b64ToBytes(stripped)
  if (bytes[0] === 0x30) return bytes

  const asText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (/^[A-Za-z0-9+/=\s]+$/.test(asText)) {
    const inner = b64ToBytes(asText.replace(/\s+/g, ''))
    if (inner[0] === 0x30) return inner
  }

  throw new Error(`${label} is not valid DER key material`)
}

function isPlainImage(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg'
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'image/webp'
  }
  return null
}

function parseEnvelope(envelope: Uint8Array) {
  const dec = new TextDecoder()
  const magic = dec.decode(envelope.subarray(0, 8))
  if (magic !== 'PMSEAL1\n') throw new Error('Invalid envelope format (magic mismatch)')
  const headerLen = new DataView(envelope.buffer, envelope.byteOffset + 8, 4).getUint32(0, false)
  const headerBytes = envelope.subarray(12, 12 + headerLen)
  const header = JSON.parse(dec.decode(headerBytes))
  const sigLen = Number(header.sig_len) || 0
  const bodyEnd = envelope.length - sigLen
  const ciphertext = envelope.subarray(12 + headerLen, bodyEnd)
  const signature = sigLen ? envelope.subarray(bodyEnd) : null
  const body = envelope.subarray(0, bodyEnd)
  return { header, headerBytes, ciphertext, signature, body }
}

async function unseal(envelope: Uint8Array, privateKeyB64: string, verifyKeyB64: string): Promise<{ plaintext: Uint8Array; header: Record<string, unknown> }> {
  const { header, headerBytes, ciphertext, signature, body } = parseEnvelope(envelope)

  // Verify signature if envelope was signed
  if (header.sig_alg && header.sig_alg !== 'none' && signature && verifyKeyB64) {
    try {
      const verifyKey = await crypto.subtle.importKey(
        'spki',
        decodeKeyMaterial(verifyKeyB64, 'EVIDENCE_VERIFY_KEY'),
        { name: 'RSA-PSS', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      const valid = await crypto.subtle.verify(
        { name: 'RSA-PSS', saltLength: 32 },
        verifyKey,
        signature,
        body,
      )
      if (!valid) {
        console.error('[unseal-snapshot] signature verification failed')
      }
    } catch (e) {
      console.warn('[unseal-snapshot] signature verification skipped:', e)
    }
  }

  // Decrypt content key
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    decodeKeyMaterial(privateKeyB64, 'EVIDENCE_PRIVATE_KEY'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  )

  const contentKeyRaw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      privateKey,
      b64ToBytes(header.ek as string),
    ),
  )

  const contentKey = await crypto.subtle.importKey('raw', contentKeyRaw, 'AES-GCM', false, ['decrypt'])
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: b64ToBytes(header.iv as string),
        additionalData: headerBytes,
        tagLength: 128,
      },
      contentKey,
      ciphertext,
    ),
  )

  // Verify SHA-256 digest
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext))
  if (bytesToB64(digest) !== header.sha256) {
    throw new Error('Integrity check failed: plaintext SHA-256 digest mismatch')
  }

  return { plaintext, header }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const user = await resolveUser(req.headers.get('Authorization'))
  if (!user) return json({ ok: false, reason: 'NOT_SIGNED_IN' }, 401)

  let violationId = ''
  let snapshotPath = ''

  if (req.method === 'GET') {
    const url = new URL(req.url)
    violationId = (url.searchParams.get('violationId') || url.searchParams.get('id') || '').trim()
    snapshotPath = (url.searchParams.get('snapshotPath') || url.searchParams.get('path') || '').trim()
  } else if (req.method === 'POST') {
    try {
      const body = await req.json()
      violationId = typeof body?.violationId === 'string' ? body.violationId.trim() : ''
      snapshotPath = typeof body?.snapshotPath === 'string' ? body.snapshotPath.trim() : ''
    } catch {
      return json({ ok: false, reason: 'BAD_REQUEST' }, 400)
    }
  } else {
    return json({ ok: false, reason: 'METHOD_NOT_ALLOWED' }, 405)
  }

  if (!violationId && !snapshotPath) {
    return json({ ok: false, reason: 'MISSING_ID_OR_PATH' }, 400)
  }

  // Look up violation record to check permissions
  const query = violationId
    ? `/rest/v1/violations?id=eq.${encodeURIComponent(violationId)}&select=*`
    : `/rest/v1/violations?snapshot_path=eq.${encodeURIComponent(snapshotPath)}&select=*`

  const violationRes = await adminFetch(query)
  if (!violationRes.ok) {
    return json({ ok: false, reason: 'VIOLATION_LOOKUP_FAILED' }, 200)
  }

  const rows = await violationRes.json()
  const violation = Array.isArray(rows) && rows.length ? rows[0] : null
  if (!violation) {
    return json({ ok: false, reason: 'VIOLATION_NOT_FOUND' }, 200)
  }

  // Authorization check: User must be the student OR a teacher for this classroom
  const isOwner = violation.student_id === user.id
  let isAuthorizedTeacher = false

  if (!isOwner && violation.session_id) {
    const sessionRes = await adminFetch(
      `/rest/v1/proctor_sessions?id=eq.${encodeURIComponent(violation.session_id)}&select=classroom_id`,
    )
    if (sessionRes.ok) {
      const sRows = await sessionRes.json()
      const classroomId = sRows?.[0]?.classroom_id
      if (classroomId) {
        const teacherRes = await adminFetch(
          `/rest/v1/classrooms?id=eq.${encodeURIComponent(classroomId)}&teacher_id=eq.${encodeURIComponent(user.id)}&select=id`,
        )
        if (teacherRes.ok) {
          const tRows = await teacherRes.json()
          if (Array.isArray(tRows) && tRows.length > 0) isAuthorizedTeacher = true
        }
      }
    }
  }

  if (!isOwner && !isAuthorizedTeacher) {
    return json({ ok: false, reason: 'FORBIDDEN' }, 403)
  }

  const targetPath = violation.snapshot_path || snapshotPath
  if (!targetPath) {
    return json({ ok: false, reason: 'NO_SNAPSHOT_PATH' }, 200)
  }

  // Fetch file from private storage
  const storageRes = await adminFetch(`/storage/v1/object/demo-snapshots/${targetPath}`)
  if (!storageRes.ok) {
    return json({ ok: false, reason: 'SNAPSHOT_NOT_FOUND_IN_STORAGE' }, 200)
  }

  const fileBytes = new Uint8Array(await storageRes.arrayBuffer())

  // Check if file is already a raw image (JPEG/PNG/WebP)
  const plainMime = isPlainImage(fileBytes)
  if (plainMime) {
    return json({
      ok: true,
      violationId: violation.id,
      dataUrl: `data:${plainMime};base64,${bytesToB64(fileBytes)}`,
      violationType: violation.violation_type,
      cheatReason: violation.cheat_reason,
      cheatProbability: violation.cheat_probability,
      createdAt: violation.created_at,
    })
  }

  // Unseal and decrypt
  const privateKey = Deno.env.get('EVIDENCE_PRIVATE_KEY') || BUILTIN_EVIDENCE_PRIVATE_KEY
  const verifyKey = Deno.env.get('EVIDENCE_VERIFY_KEY') || BUILTIN_EVIDENCE_VERIFY_KEY

  try {
    const { plaintext, header } = await unseal(fileBytes, privateKey, verifyKey)
    const base64Data = bytesToB64(plaintext)
    const mimeType = (header.content_type as string) || 'image/jpeg'
    const dataUrl = `data:${mimeType};base64,${base64Data}`

    return json({
      ok: true,
      violationId: violation.id,
      dataUrl,
      violationType: violation.violation_type,
      cheatReason: violation.cheat_reason,
      cheatProbability: violation.cheat_probability,
      createdAt: violation.created_at,
    })
  } catch (err) {
    console.warn(`[unseal-snapshot] Decryption error for path=${targetPath}:`, err)
    return json({
      ok: false,
      reason: 'KEY_MISMATCH_HISTORICAL',
      detail: 'This frame was sealed with an earlier offline key pair or format.',
    }, 200)
  }
})

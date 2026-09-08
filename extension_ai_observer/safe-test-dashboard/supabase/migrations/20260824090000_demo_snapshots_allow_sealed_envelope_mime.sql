-- =============================================================================
-- 20260824090000_demo_snapshots_allow_sealed_envelope_mime.sql
--
-- Every CONFIRMED cheating frame was being reviewed and then thrown away:
--
--   [analyze-snapshot] UPLOAD_REJECTED http=400
--   {"statusCode":"415","error":"invalid_mime_type",
--    "message":"mime type application/octet-stream is not supported"}
--
-- The bucket was created (20260804120100) allowing only image types, on the
-- reasonable assumption that a snapshot bucket holds snapshots. It no longer
-- does. Since 2026-08-16 the only thing written to it is a PMSEAL1 envelope:
-- magic + length prefix + header JSON + AES-256-GCM ciphertext + an RSA-PSS
-- signature. That is `application/octet-stream`, and Storage refused it.
--
-- ⚠ THE ENVELOPE IS DECLARED AS WHAT IT IS, NOT RELABELLED `image/jpeg`.
--
-- Claiming `image/jpeg` would also have satisfied the constraint, needs no
-- migration, and is the wrong repair for three reasons:
--
--   1. It is false. The bytes are not a JPEG and no decoder will open them.
--   2. The plaintext content type is exactly the fact the seal exists to hide.
--      Writing it into unencrypted object metadata leaks, in the clear, the one
--      attribute the envelope is designed not to reveal.
--   3. It is a trap for the eventual offline decryption tool, which identifies
--      envelopes by the PMSEAL1 magic. An object whose declared type
--      contradicts its contents will be handled, sooner or later, by something
--      that trusts the label.
--
-- The image types are RETAINED rather than replaced. They cost nothing, and the
-- bucket's history includes plaintext snapshot uploads from before the sealing
-- scheme; narrowing to octet-stream alone would be a second, unrelated change
-- smuggled into a hotfix.
--
-- ⚠ THERE IS NO `evidence-sealed` BUCKET, AND NONE IS CREATED HERE. The brief
-- names one; the project has only `avatars` and `demo-snapshots`, and sealed
-- evidence lives in the latter under `sealed/{uid}/{violation_id}.pmseal`.
-- Creating a second bucket would split the evidence corpus across two places
-- with two policy sets, for no gain — the existing one already has RLS denying
-- every client and is reachable only by the service role.
-- =============================================================================

update storage.buckets
   set allowed_mime_types = array[
         'application/octet-stream',   -- PMSEAL1 sealed evidence (the only writer today)
         'image/jpeg',
         'image/png',
         'image/webp'
       ]
 where id = 'demo-snapshots';

-- ⚠ ASSERTED, NOT ASSUMED. The failure this fixes is silent from the outside:
-- the verdict row is still written, so the pipeline looks healthy while the
-- evidence behind every finding is discarded. A missing bucket row here would
-- make the UPDATE a no-op and restore exactly that condition.
do $$
declare types text[];
begin
  select allowed_mime_types into types from storage.buckets where id = 'demo-snapshots';
  if types is null then
    raise exception 'demo-snapshots bucket not found - sealed evidence has nowhere to go';
  end if;
  if not ('application/octet-stream' = any(types)) then
    raise exception 'demo-snapshots still rejects application/octet-stream - sealed evidence cannot be stored';
  end if;
end $$;

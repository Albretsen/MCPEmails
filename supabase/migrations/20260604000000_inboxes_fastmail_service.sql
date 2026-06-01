-- ============================================================
-- MCPEmails — Treat Fastmail app-password inboxes as branded IMAP
-- 20260604000000_inboxes_fastmail_service
-- ============================================================
--
-- Fastmail app-password inboxes were stored as provider = 'fastmail', but the
-- edge function operates every 'fastmail' inbox over JMAP Basic auth. An app
-- password scoped to IMAP/SMTP (the only scope we validate and the host config
-- we persist) is rejected by the JMAP endpoint with 401, surfacing as a false
-- "reconnect your inbox" error even though IMAP/SMTP access is healthy.
--
-- The branded-IMAP model (icloud/yahoo/zoho/yandex) already solves this: store
-- provider = 'imap' with the brand in `service`. The per-row imap_/smtp_ columns
-- carry everything the edge function needs, so all operations route over the
-- transport the credential actually grants. Fastmail app-password is the same
-- shape — make it a branded IMAP service.
--
-- provider = 'fastmail' is hereafter reserved for the OAuth/JMAP connection.
-- ============================================================

-- 1. Permit 'fastmail' as a branded IMAP service.
ALTER TABLE public.inboxes
  DROP CONSTRAINT inboxes_service_check;

ALTER TABLE public.inboxes
  ADD CONSTRAINT inboxes_service_check
    CHECK (service IS NULL OR service IN ('icloud', 'yahoo', 'zoho', 'yandex', 'generic', 'fastmail'));

COMMENT ON COLUMN public.inboxes.service IS
  'Branded IMAP service for UX/host-preset selection when provider = ''imap'': '
  '''icloud'' | ''yahoo'' | ''zoho'' | ''yandex'' | ''generic'' | ''fastmail''. '
  'NULL for OAuth providers (gmail/outlook, and Fastmail-over-OAuth).';

-- 2. Migrate existing Fastmail app-password rows (provider = 'fastmail' with
--    IMAP host config and no OAuth token) to the branded-IMAP shape so the edge
--    function routes them over IMAP/SMTP instead of JMAP.
UPDATE public.inboxes
SET provider = 'imap',
    service = 'fastmail',
    updated_at = now()
WHERE provider = 'fastmail'
  AND imap_host IS NOT NULL
  AND oauth_access_token IS NULL;

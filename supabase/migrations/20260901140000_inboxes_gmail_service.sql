-- ============================================================
-- MCPEmails — Permit 'gmail' as a branded IMAP service
-- 20260901140000_inboxes_gmail_service
-- ============================================================
--
-- Gmail can now be connected with a Google app password over IMAP/SMTP, which
-- is stored the same way every other branded app-password mailbox is:
-- provider = 'imap' with the brand in `service`. Without this the connect
-- route's upsert fails the CHECK constraint and every Gmail app-password
-- connection dies at persistence with a 500.
--
-- Why the app-password path exists at all: an unverified Google OAuth app has
-- a 100-user LIFETIME cap on consent grants that cannot be reset, and lifting
-- it requires Google's restricted-scope review with its paid annual CASA
-- assessment. An app password involves no scopes, no consent screen and no
-- review, so it has no cap.
--
-- This is additive only. provider = 'gmail' still means the OAuth/Gmail-API
-- connection and every existing OAuth inbox is left exactly as it is: no row
-- is rewritten here, unlike the Fastmail migration, because both Gmail paths
-- are real and supported at the same time.
-- ============================================================

ALTER TABLE public.inboxes
  DROP CONSTRAINT inboxes_service_check;

ALTER TABLE public.inboxes
  ADD CONSTRAINT inboxes_service_check
    CHECK (service IS NULL OR service IN ('icloud', 'yahoo', 'zoho', 'yandex', 'generic', 'fastmail', 'gmail'));

COMMENT ON COLUMN public.inboxes.service IS
  'Branded IMAP service for UX/host-preset selection when provider = ''imap'': '
  '''gmail'' | ''icloud'' | ''yahoo'' | ''zoho'' | ''yandex'' | ''generic'' | ''fastmail''. '
  'NULL for OAuth providers (gmail/outlook, and Fastmail-over-OAuth). '
  'service = ''gmail'' is a Google app password over IMAP/SMTP; provider = ''gmail'' '
  'is the OAuth/Gmail-API connection. They coexist.';

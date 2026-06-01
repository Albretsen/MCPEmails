-- inboxes.imap_username
--
-- Separate IMAP/SMTP login username, distinct from the mailbox email address.
--
-- Most providers (Gmail, Outlook, iCloud, Fastmail, Yahoo, ...) authenticate
-- with the full email address as the SASL username, so this stays NULL for
-- them. But independent mail hosts (e.g. domeneshop.no) issue a separate login
-- username — there the email is `you@example.com` while the IMAP/SMTP username
-- is something like `youexampleno1`. Without this column the connect form has
-- no way to express that and authentication fails.
--
-- Readers MUST fall back to email_address when this is NULL:
--   COALESCE(imap_username, email_address)
-- so all existing rows keep working unchanged.

ALTER TABLE public.inboxes
  ADD COLUMN imap_username text;

COMMENT ON COLUMN public.inboxes.imap_username IS
  'Optional IMAP/SMTP SASL login username for generic IMAP inboxes. '
  'NULL means authenticate with email_address (the common case).';

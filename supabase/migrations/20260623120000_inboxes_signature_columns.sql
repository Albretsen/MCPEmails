-- ============================================================
-- MCPEmails — Per-inbox email signatures
-- 20260623120000_inboxes_signature_columns
-- ============================================================
--
-- Adds per-inbox signature storage so the edge function can append a
-- signature server-side on every send/reply/forward/draft/scheduled message.
-- No mail backend (Gmail messages.send, Graph sendMail, JMAP Email/send, SMTP)
-- appends the signature itself — the signature normally seen is added by the
-- client UI, so programmatic sends are currently unsigned. These columns close
-- that gap.
--
-- Unlike oauth_*/imap_password (AES-256-GCM bytea), signatures are NOT secret,
-- so they are stored as plaintext text columns.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded CHECK constraint so this file
-- is safe to re-run.
-- ============================================================

ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS signature_html        text,
  ADD COLUMN IF NOT EXISTS signature_text        text,
  ADD COLUMN IF NOT EXISTS signature_enabled     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS signature_reply_mode  text NOT NULL DEFAULT 'first_only',
  ADD COLUMN IF NOT EXISTS signature_source      text,
  ADD COLUMN IF NOT EXISTS signature_updated_at  timestamptz;

-- signature_reply_mode: how the signature behaves on replies/forwards.
--   'always'      — sign every reply/forward
--   'first_only'  — only when the body has no existing quote/signature marker
--   'never'       — never sign replies/forwards
-- Guarded so the migration is re-runnable (DO block skips if already present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inboxes_signature_reply_mode_check'
  ) THEN
    ALTER TABLE public.inboxes
      ADD CONSTRAINT inboxes_signature_reply_mode_check
        CHECK (signature_reply_mode IN ('always', 'first_only', 'never'));
  END IF;
END $$;

-- signature_source: where the stored signature came from.
--   'manual'       — set via dashboard / MCP tool by the user
--   'gmail_import' — auto-imported from Gmail sendAs settings
--   NULL           — no signature configured yet
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inboxes_signature_source_check'
  ) THEN
    ALTER TABLE public.inboxes
      ADD CONSTRAINT inboxes_signature_source_check
        CHECK (signature_source IS NULL OR signature_source IN ('manual', 'gmail_import'));
  END IF;
END $$;

COMMENT ON COLUMN public.inboxes.signature_html IS
  'Optional HTML signature appended server-side on send. Plaintext (not secret).';
COMMENT ON COLUMN public.inboxes.signature_text IS
  'Optional plain-text signature appended server-side on send. Plaintext (not secret).';
COMMENT ON COLUMN public.inboxes.signature_enabled IS
  'When false, no signature is appended for this inbox.';
COMMENT ON COLUMN public.inboxes.signature_reply_mode IS
  'Signature behaviour on replies/forwards: ''always'' | ''first_only'' | ''never''.';
COMMENT ON COLUMN public.inboxes.signature_source IS
  'Origin of the stored signature: ''manual'' | ''gmail_import'' | NULL.';
COMMENT ON COLUMN public.inboxes.signature_updated_at IS
  'When the signature was last set/imported.';

-- ============================================================
-- MCPEmails — Encrypt scheduled_sends.payload at rest
-- 20260623000000_scheduled_sends_payload_encrypted
-- ============================================================
--
-- Security fix: scheduled_sends.payload previously stored full send_email
-- arguments (recipients, body, attachment bytes) as PLAINTEXT jsonb.
--
-- New rows now store an AES-256-GCM ciphertext wrapper in `payload`:
--     { "v": 1, "data": "<base64url ciphertext>" }
-- and set payload_encrypted = true.  The mcp-server Edge Function decrypts
-- these on dispatch/list using the shared ENCRYPTION_KEY (same key used for
-- IMAP passwords / OAuth tokens).
--
-- Backward compatible: existing rows keep payload_encrypted = false and are
-- read as plaintext by the dual-mode payload resolver, so pending legacy
-- sends still dispatch unchanged.  Idempotent (IF NOT EXISTS).
-- ============================================================

ALTER TABLE public.scheduled_sends
  ADD COLUMN IF NOT EXISTS payload_encrypted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.scheduled_sends.payload_encrypted IS
  'When true, payload is an AES-256-GCM wrapper { v, data } that the dispatcher '
  'decrypts with ENCRYPTION_KEY. When false (legacy), payload is plaintext jsonb.';

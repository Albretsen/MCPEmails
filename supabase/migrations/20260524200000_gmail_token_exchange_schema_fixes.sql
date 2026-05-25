-- Migration: gmail_token_exchange_schema_fixes
--
-- Two fixes required to make the Gmail (and future Outlook / Fastmail) token
-- exchange callback route work correctly:
--
-- 1. Change OAuth token columns from bytea → text
--    encryptToken() in lib/crypto.ts returns a base64url-encoded string
--    (AES-256-GCM: IV || ciphertext || auth-tag, encoded as base64url).
--    Storing that string in a bytea column via PostgREST causes a round-trip
--    encoding problem: PostgREST expects standard base64 for bytea writes and
--    encodes the stored bytes as standard base64 on reads, so the base64url
--    string written by the app would come back mangled. Changing to text means
--    the ciphertext string is stored and returned verbatim with no re-encoding.
--    Security is unchanged — the column still holds opaque AES-256-GCM
--    ciphertext; the only difference is the transport encoding.
--
-- 2. Add UNIQUE constraint on (workspace_id, email_address)
--    The callback route uses a Supabase upsert with
--      onConflict: 'workspace_id, email_address'
--    which compiles to:
--      INSERT ... ON CONFLICT (workspace_id, email_address) DO UPDATE SET ...
--    PostgreSQL requires a matching unique constraint or unique index for this
--    conflict target to resolve. Without it the upsert throws a
--    "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification" error and the inbox row is never written.
--    The constraint also correctly handles reconnection: if a user re-authorises
--    the same email address (e.g. after a token error), the upsert updates the
--    existing row (resetting status, clearing last_error, writing new tokens)
--    without changing the inbox UUID, so activity_log foreign keys stay intact.

-- ── 1. Token columns: bytea → text ──────────────────────────────────────────

ALTER TABLE public.inboxes
  ALTER COLUMN oauth_access_token  TYPE text USING encode(oauth_access_token, 'escape'),
  ALTER COLUMN oauth_refresh_token TYPE text USING encode(oauth_refresh_token, 'escape'),
  ALTER COLUMN imap_password        TYPE text USING encode(imap_password, 'escape');

-- ── 2. Unique constraint for upsert conflict target ──────────────────────────

ALTER TABLE public.inboxes
  ADD CONSTRAINT inboxes_workspace_id_email_address_key
  UNIQUE (workspace_id, email_address);

-- Partial index for fast "active inbox" lookups (excludes soft-deleted rows).
-- This is a separate structure from the constraint above; the constraint is
-- what the upsert's ON CONFLICT clause resolves against.
CREATE INDEX IF NOT EXISTS idx_inboxes_active_email
  ON public.inboxes (workspace_id, email_address)
  WHERE deleted_at IS NULL;

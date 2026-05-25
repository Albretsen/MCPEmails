-- oauth_csrf_tokens: single-use CSRF tokens for the /authorize consent form.
-- Service-role only; no user-facing access.
CREATE TABLE IF NOT EXISTS public.oauth_csrf_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_csrf_tokens_user_idx ON public.oauth_csrf_tokens (user_id);
ALTER TABLE public.oauth_csrf_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "oauth_csrf_deny_all" ON public.oauth_csrf_tokens FOR ALL USING (false);

-- oauth_state_nonces: stores the OAuth state param server-side so the
-- Server Action can validate and consume it (single-use, 10-min TTL).
CREATE TABLE IF NOT EXISTS public.oauth_state_nonces (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  text        NOT NULL,
  state_hash  text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE (session_id, state_hash)
);
ALTER TABLE public.oauth_state_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "oauth_state_deny_all" ON public.oauth_state_nonces FOR ALL USING (false);

-- 2.2: Refresh token table for RFC 6749 refresh_token grant.
-- Service-role only: RLS denies all user-facing access.
CREATE TABLE IF NOT EXISTS public.oauth_refresh_tokens (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_hash  text        NOT NULL UNIQUE,
  client_id     text        NOT NULL,
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id)  ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id)         ON DELETE CASCADE,
  client_name   text        NOT NULL,
  scopes        text[]      NOT NULL DEFAULT '{}',
  inbox_ids     uuid[],
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_refresh_hash_idx
  ON public.oauth_refresh_tokens (refresh_hash);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_workspace_client_idx
  ON public.oauth_refresh_tokens (workspace_id, client_id);

ALTER TABLE public.oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;

-- Deny all direct user access; only service-role reads/writes this table.
CREATE POLICY "oauth_refresh_tokens_deny_user_access"
  ON public.oauth_refresh_tokens
  FOR ALL
  USING (false);

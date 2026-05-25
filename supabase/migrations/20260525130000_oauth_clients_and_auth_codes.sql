-- ============================================================
-- oauth_clients — registered MCP/OAuth client applications
-- ============================================================
-- These are platform-registered clients (first-party and third-party).
-- Rows are inserted by the platform operator via migration or admin tooling;
-- regular users never write to this table.
--
-- RLS: public SELECT (any authenticated or anon user can look up a client by
-- client_id to render the /authorize page). Only service_role may insert/update.
-- ============================================================

CREATE TABLE public.oauth_clients (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text        NOT NULL UNIQUE,
  client_name     text        NOT NULL,
  client_byline   text        NOT NULL DEFAULT '',
  redirect_uris   text[]      NOT NULL DEFAULT '{}',
  scopes_allowed  text[]      NOT NULL DEFAULT '{}',
  logo_url        text,
  is_first_party  boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;

-- Anyone (including unauthenticated visitors) can read client metadata
-- so the /authorize page can look up the client name and scopes.
CREATE POLICY "oauth_clients_public_read"
  ON public.oauth_clients
  FOR SELECT
  USING (true);

-- ============================================================
-- oauth_consents — per-user approval decisions per client
-- ============================================================
-- Tracks which scopes and inboxes a user has previously approved for a
-- given client. Used to skip re-showing the consent screen for returning
-- clients that request the same or fewer scopes.
-- ============================================================

CREATE TABLE public.oauth_consents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  scopes      text[]      NOT NULL DEFAULT '{}',
  inbox_ids   uuid[],
  granted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);

ALTER TABLE public.oauth_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "oauth_consents_owner_all"
  ON public.oauth_consents
  FOR ALL
  USING (auth.uid() = user_id);

-- ============================================================
-- oauth_auth_codes — short-lived authorization codes (10-min TTL)
-- ============================================================
-- Stores PKCE authorization codes. Only hashes are stored; the plaintext
-- code is delivered to the client via redirect and never persisted.
-- Codes are hard-deleted immediately after exchange (single-use).
-- ============================================================

CREATE TABLE public.oauth_auth_codes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash       text        NOT NULL UNIQUE,
  client_id       text        NOT NULL,
  workspace_id    uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES auth.users(id)        ON DELETE CASCADE,
  client_name     text        NOT NULL,
  redirect_uri    text        NOT NULL,
  code_challenge  text        NOT NULL,
  scopes          text[]      NOT NULL DEFAULT '{}',
  inbox_ids       uuid[],
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.oauth_auth_codes ENABLE ROW LEVEL SECURITY;

-- Auth codes are exchanged server-to-server only (POST /api/oauth/token).
-- The token endpoint uses the service role client and never exposes codes
-- to the browser, so no user-facing RLS policy is needed.
CREATE POLICY "oauth_auth_codes_deny_user_access"
  ON public.oauth_auth_codes
  FOR ALL
  USING (false);

-- ============================================================
-- Seed: well-known first-party OAuth clients
-- ============================================================

INSERT INTO public.oauth_clients
  (client_id, client_name, client_byline, redirect_uris, scopes_allowed, is_first_party)
VALUES
  (
    'claude-desktop',
    'Claude Desktop',
    'by Anthropic',
    ARRAY['claude://oauth/callback', 'http://localhost:10101/oauth/callback'],
    ARRAY['read:email','search:email','send:email','manage:drafts','manage:folders'],
    true
  ),
  (
    'cursor-v1',
    'Cursor',
    'by Anysphere',
    ARRAY['cursor://mcp/callback', 'http://127.0.0.1:65010/callback'],
    ARRAY['read:email','search:email','send:email'],
    true
  ),
  (
    'n8n-self-hosted',
    'n8n workflow',
    'self-hosted',
    ARRAY['http://localhost:5678/oauth/callback', 'http://127.0.0.1:5678/oauth/callback'],
    ARRAY['read:email','search:email','send:email'],
    false
  )
ON CONFLICT (client_id) DO NOTHING;

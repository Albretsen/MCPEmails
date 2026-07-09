-- ============================================================
-- MCPEmails, Self-host schema
-- ============================================================
-- A consolidated, dependency-free schema for running the MCP server
-- against a plain PostgreSQL + PostgREST stack, no Supabase Auth,
-- Storage, Realtime, Vault, pg_cron, or Stripe required.
--
-- It contains ONLY what the mcp-server edge function reads or writes:
--   • workspaces        (tenancy container; one is seeded for you)
--   • users             (key/inbox owner; one operator is seeded)
--   • inboxes           (connected mailboxes; encrypted credentials)
--   • api_keys          (hashed, scoped MCP keys)
--   • activity_log      (append-only tool-call log)
--   • scheduled_sends   (future-delivery queue)
--   • rate_limit_buckets + rate_limit_check()
--
-- The server authenticates with API keys and talks to the database as
-- the service_role (bypassing RLS), so the user-facing RLS policies and
-- billing/OAuth-client machinery from the hosted product are intentionally
-- omitted. This file is applied automatically on first container start
-- (docker-entrypoint-initdb.d).
-- ============================================================

-- ── PostgREST roles ─────────────────────────────────────────────────────────
-- PostgREST connects as `authenticator` and SET ROLEs to the role named in the
-- request JWT's `role` claim. The MCP server presents a service_role JWT, so it
-- runs as service_role (BYPASSRLS). anon is the fallback role for tokenless
-- requests (the server never makes those, but PostgREST requires the role).
--
-- The authenticator password is injected from AUTHENTICATOR_PASSWORD by
-- 01-roles.sh so it is never hard-coded here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

-- ── updated_at trigger helper (no extension dependency) ──────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- TABLE: users  (standalone, no auth.users dependency)
-- ============================================================
CREATE TABLE public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: workspaces
-- ============================================================
CREATE TABLE public.workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  owner_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  plan          text NOT NULL DEFAULT 'free',
  grandfathered boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspaces_owner_id ON public.workspaces (owner_id);
CREATE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: inboxes  (connected mailboxes; AES-256-GCM creds at rest)
-- ============================================================
CREATE TABLE public.inboxes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider                text NOT NULL,                    -- 'gmail' | 'outlook' | 'imap' | 'fastmail'
  service                 text,                             -- branded IMAP: icloud|yahoo|zoho|yandex|generic|fastmail
  email_address           text NOT NULL,
  display_name            text,
  -- OAuth providers (Gmail, Outlook). Unused by the IMAP/SMTP self-host path.
  oauth_access_token      bytea,
  oauth_refresh_token     bytea,
  oauth_token_expires_at  timestamptz,
  oauth_scope             text,
  -- IMAP/SMTP providers
  imap_host               text,
  imap_port               integer,
  imap_tls                boolean NOT NULL DEFAULT true,
  imap_username           text,                             -- COALESCE(imap_username, email_address)
  smtp_host               text,
  smtp_port               integer,
  smtp_tls                boolean NOT NULL DEFAULT true,
  imap_password           bytea,
  -- Per-inbox signature (plaintext; not secret)
  signature_html          text,
  signature_text          text,
  signature_enabled       boolean NOT NULL DEFAULT true,
  signature_reply_mode    text NOT NULL DEFAULT 'first_only'
                            CHECK (signature_reply_mode IN ('always', 'first_only', 'never')),
  signature_source        text CHECK (signature_source IS NULL OR signature_source IN ('manual', 'gmail_import')),
  signature_updated_at    timestamptz,
  -- Connection state
  status                  text NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'error' | 'revoked'
  last_sync_at            timestamptz,
  last_error              text,
  deleted_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inboxes_service_check
    CHECK (service IS NULL OR service IN ('icloud', 'yahoo', 'zoho', 'yandex', 'generic', 'fastmail'))
);
CREATE INDEX idx_inboxes_workspace_id_status   ON public.inboxes (workspace_id, status);
CREATE INDEX idx_inboxes_workspace_id_provider ON public.inboxes (workspace_id, provider);
-- Full (non-partial) unique index so `provision-inbox` can upsert by this pair
-- via ON CONFLICT. Single-tenant self-host never keeps duplicate soft-deleted
-- rows for one address, reconnecting the same address updates the row in place
-- (clearing deleted_at). The hosted product uses a partial index instead to
-- allow many soft-deleted rows per address.
CREATE UNIQUE INDEX idx_inboxes_workspace_email
  ON public.inboxes (workspace_id, email_address);
CREATE TRIGGER inboxes_updated_at
  BEFORE UPDATE ON public.inboxes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: api_keys  (SHA-256 hash only; scoped; inbox-restricted)
-- ============================================================
CREATE TABLE public.api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  key_prefix    text NOT NULL,        -- first 8 chars, for display
  key_hash      text NOT NULL UNIQUE, -- SHA-256 hex of the full key
  scopes        text[] NOT NULL DEFAULT '{}',
  inbox_ids     uuid[],               -- null = all inboxes; array = restrict
  expires_at    timestamptz,
  last_used_at  timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_workspace_id_active ON public.api_keys (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_api_keys_key_prefix          ON public.api_keys (key_prefix);
CREATE TRIGGER api_keys_updated_at
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: activity_log  (append-only tool-call log)
-- Non-partitioned here, the hosted product range-partitions by month for
-- retention; a single self-host instance does not need that machinery.
-- ============================================================
CREATE TABLE public.activity_log (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  api_key_id    uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  inbox_id      uuid REFERENCES public.inboxes(id) ON DELETE SET NULL,
  tool_name     text NOT NULL,
  status        text NOT NULL,        -- 'success' | 'error' | 'rate_limited'
  error_code    text,
  duration_ms   integer,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX idx_activity_log_workspace_created ON public.activity_log (workspace_id, created_at DESC);
CREATE INDEX idx_activity_log_api_key_created   ON public.activity_log (api_key_id, created_at DESC);
CREATE INDEX idx_activity_log_tool_created      ON public.activity_log (tool_name, created_at);

-- ============================================================
-- TABLE: scheduled_sends  (future-delivery queue)
-- ============================================================
CREATE TABLE public.scheduled_sends (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id          uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  payload           jsonb NOT NULL,
  payload_encrypted boolean NOT NULL DEFAULT false,
  send_at           timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'sent', 'error', 'cancelled')),
  sent_at           timestamptz,
  error_detail      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_sends_pending_idx   ON public.scheduled_sends (send_at ASC) WHERE status = 'pending';
CREATE INDEX scheduled_sends_workspace_idx ON public.scheduled_sends (workspace_id, send_at ASC) WHERE status IN ('pending', 'sending');
CREATE INDEX scheduled_sends_inbox_idx     ON public.scheduled_sends (inbox_id, created_at DESC);
CREATE TRIGGER scheduled_sends_updated_at
  BEFORE UPDATE ON public.scheduled_sends
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Rate limiting: rate_limit_buckets + rate_limit_check()
-- ============================================================
CREATE TABLE public.rate_limit_buckets (
  key          text        PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.rate_limit_check(
  p_key        text,
  p_max_count  integer,
  p_window_ms  bigint
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_now    timestamptz := now();
  v_cutoff timestamptz := v_now - (p_window_ms || ' milliseconds')::interval;
  v_count  integer;
BEGIN
  INSERT INTO public.rate_limit_buckets (key, window_start, count)
  VALUES (p_key, v_now, 1)
  ON CONFLICT (key) DO UPDATE
    SET window_start = CASE
          WHEN rate_limit_buckets.window_start <= v_cutoff THEN v_now
          ELSE rate_limit_buckets.window_start
        END,
        count = CASE
          WHEN rate_limit_buckets.window_start <= v_cutoff THEN 1
          ELSE rate_limit_buckets.count + 1
        END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_count;
END;
$$;

-- ============================================================
-- Grants, service_role bypasses RLS and owns the data plane.
-- ============================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;

-- ============================================================
-- Seed: one operator user + one workspace (fixed UUIDs).
-- Single-tenant self-host: every inbox and API key you provision
-- belongs to this workspace. plan='pro' + grandfathered keeps the
-- per-workspace fair-use ceiling high for a solo operator.
-- ============================================================
INSERT INTO public.users (id, email, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'operator@localhost', 'Self-host operator');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, grandfathered)
VALUES ('00000000-0000-0000-0000-000000000001', 'self-hosted', 'Self-hosted', '00000000-0000-0000-0000-000000000001', 'pro', true);

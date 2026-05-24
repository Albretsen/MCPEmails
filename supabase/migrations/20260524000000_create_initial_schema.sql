-- ============================================================
-- MCPEmails — Initial Schema Migration
-- 20260524000000_create_initial_schema
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- ============================================================
-- TABLE: users
-- Mirrors auth.users; populated by on_auth_user_created trigger
-- ============================================================
CREATE TABLE public.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text NOT NULL UNIQUE,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Trigger: keep updated_at current
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- Trigger: auto-create public.users row on auth sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'display_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- TABLE: workspaces
-- Top-level tenancy container
-- ============================================================
CREATE TABLE public.workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  owner_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  plan          text NOT NULL DEFAULT 'free',  -- 'free' | 'pro' | 'enterprise'
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workspaces_owner_id ON public.workspaces (owner_id);

CREATE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ============================================================
-- TABLE: workspace_members
-- Maps users to workspaces with a role
-- ============================================================
CREATE TABLE public.workspace_members (
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'owner',  -- 'owner' | 'member' | 'viewer'
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_user_id ON public.workspace_members (user_id);

-- ============================================================
-- TABLE: inboxes
-- Connected email accounts with encrypted credentials
-- ============================================================
CREATE TABLE public.inboxes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider                text NOT NULL,           -- 'gmail' | 'outlook' | 'fastmail' | 'imap'
  email_address           text NOT NULL,
  display_name            text,
  -- OAuth providers (Gmail, Outlook)
  oauth_access_token      bytea,                   -- AES-256-GCM encrypted
  oauth_refresh_token     bytea,                   -- AES-256-GCM encrypted
  oauth_token_expires_at  timestamptz,
  oauth_scope             text,
  -- IMAP/SMTP providers (Fastmail, generic)
  imap_host               text,
  imap_port               integer,
  imap_tls                boolean NOT NULL DEFAULT true,
  smtp_host               text,
  smtp_port               integer,
  smtp_tls                boolean NOT NULL DEFAULT true,
  imap_password           bytea,                   -- AES-256-GCM encrypted
  -- Connection state
  status                  text NOT NULL DEFAULT 'pending',
                                                   -- 'pending' | 'active' | 'error' | 'revoked'
  last_sync_at            timestamptz,
  last_error              text,
  -- Soft delete
  deleted_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inboxes_workspace_id_status
  ON public.inboxes (workspace_id, status);
CREATE INDEX idx_inboxes_workspace_id_provider
  ON public.inboxes (workspace_id, provider);
CREATE INDEX idx_inboxes_token_expires_active
  ON public.inboxes (oauth_token_expires_at)
  WHERE status = 'active' AND provider IN ('gmail', 'outlook');
CREATE UNIQUE INDEX idx_inboxes_workspace_email_active
  ON public.inboxes (workspace_id, email_address)
  WHERE deleted_at IS NULL;

CREATE TRIGGER inboxes_updated_at
  BEFORE UPDATE ON public.inboxes
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ============================================================
-- TABLE: api_keys
-- MCP API keys issued to users (bcrypt hash only, no plaintext)
-- ============================================================
CREATE TABLE public.api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  key_prefix    text NOT NULL,      -- first 8 chars of the key, displayed in UI
  key_hash      text NOT NULL UNIQUE,  -- bcrypt hash of the full key
  scopes        text[] NOT NULL DEFAULT '{}',
                                    -- e.g. ARRAY['read:email', 'send:email']
  inbox_ids     uuid[],             -- null = all inboxes; array = specific inboxes
  expires_at    timestamptz,        -- null = never
  last_used_at  timestamptz,
  -- Soft delete (revocation)
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_workspace_id_active
  ON public.api_keys (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_api_keys_key_prefix
  ON public.api_keys (key_prefix);

CREATE TRIGGER api_keys_updated_at
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ============================================================
-- TABLE: oauth_states
-- Short-lived nonces for OAuth 2.0 authorization code flow
-- ============================================================
CREATE TABLE public.oauth_states (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  state         text NOT NULL UNIQUE,  -- cryptographically random 32-byte base64url
  redirect_uri  text NOT NULL,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_states_expires_at ON public.oauth_states (expires_at);

-- ============================================================
-- TABLE: activity_log
-- Append-only MCP tool call log; range-partitioned by created_at
-- ============================================================
CREATE TABLE public.activity_log (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  api_key_id    uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  inbox_id      uuid REFERENCES public.inboxes(id) ON DELETE SET NULL,
  tool_name     text NOT NULL,
  status        text NOT NULL,  -- 'success' | 'error' | 'rate_limited'
  error_code    text,
  duration_ms   integer,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Initial monthly partitions
CREATE TABLE public.activity_log_2026_05
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE public.activity_log_2026_06
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE public.activity_log_2026_07
  PARTITION OF public.activity_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Indexes on partitioned table (inherited by each partition)
CREATE INDEX idx_activity_log_workspace_created
  ON public.activity_log (workspace_id, created_at DESC);
CREATE INDEX idx_activity_log_api_key_created
  ON public.activity_log (api_key_id, created_at DESC);
CREATE INDEX idx_activity_log_tool_created
  ON public.activity_log (tool_name, created_at);

-- ============================================================
-- TABLE: auth_logs
-- Append-only security event log
-- ============================================================
CREATE TABLE public.auth_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  event_type    text NOT NULL,
                -- 'login_success' | 'login_failure' | 'logout'
                -- | 'key_created' | 'key_revoked' | 'scope_changed'
                -- | 'token_refreshed' | 'token_revoked'
  provider      text,  -- 'email' | 'google' | 'microsoft'
  ip_address    inet,
  user_agent    text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_logs_user_id_created
  ON public.auth_logs (user_id, created_at DESC);
CREATE INDEX idx_auth_logs_workspace_event_created
  ON public.auth_logs (workspace_id, event_type, created_at DESC);

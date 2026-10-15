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
--   • the tables behind send approvals, bulk plans/runs, automations,
--     idempotency keys, the usage meter and client capabilities, plus the
--     RPCs the server calls (workspace_action_allowance() and friends)
--
-- Tables the server only touches on hosted paths (billing emails, funnel
-- events, OAuth refresh tokens) are here too, so those lookups return an
-- empty result instead of a PostgREST "relation does not exist" error.
--
-- The server authenticates with API keys and talks to the database as
-- the service_role (bypassing RLS), so the user-facing RLS policies and
-- billing/OAuth-client machinery from the hosted product are intentionally
-- omitted. This file is applied automatically on first container start
-- (docker-entrypoint-initdb.d).
--
-- KEEP IT RE-RUNNABLE. `make migrate` pipes this whole file into an existing
-- database to upgrade it, so every statement must be a no-op the second time:
-- CREATE ... IF NOT EXISTS, CREATE OR REPLACE, ADD COLUMN IF NOT EXISTS,
-- ON CONFLICT DO NOTHING. A column added to a table that already exists goes
-- in an ALTER TABLE ... ADD COLUMN IF NOT EXISTS block below its CREATE TABLE,
-- never into the CREATE TABLE itself (an existing install skips that).
--
-- KEEP IT IN SYNC. When a migration in supabase/migrations adds a column,
-- table or RPC that mcp-server reads, add it here in the same PR.
-- supabase/functions/mcp-server/self-host-schema.test.ts fails CI when a
-- table, RPC or selected column the server names is missing from this file.
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
CREATE TABLE IF NOT EXISTS public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: workspaces
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  owner_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  plan          text NOT NULL DEFAULT 'free',
  grandfathered boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Columns the server reads or writes that postdate the first self-host release.
-- free_action_cap_exempt feeds workspace_action_allowance(); the analytics and
-- onboarding markers are written once, on the first tool call.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS deleted_at                         timestamptz,
  ADD COLUMN IF NOT EXISTS free_action_cap_exempt             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS draft_editor_enabled               boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS draft_editor_hidden                boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS card_diagnostics                   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS analytics_first_tool_name          text,
  ADD COLUMN IF NOT EXISTS analytics_first_tool_provider      text,
  ADD COLUMN IF NOT EXISTS analytics_first_tool_client        text,
  ADD COLUMN IF NOT EXISTS analytics_first_tool_path          text,
  ADD COLUMN IF NOT EXISTS analytics_first_tool_used_at       timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_stage                   text NOT NULL DEFAULT 'started',
  ADD COLUMN IF NOT EXISTS onboarding_client                  text,
  ADD COLUMN IF NOT EXISTS onboarding_technical_activated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_value_activated_at      timestamptz;
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id ON public.workspaces (owner_id);
CREATE OR REPLACE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: inboxes  (connected mailboxes; AES-256-GCM creds at rest)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inboxes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider                text NOT NULL,                    -- 'gmail' | 'outlook' | 'imap' | 'fastmail'
  service                 text,                             -- branded IMAP: icloud|yahoo|zoho|yandex|generic|fastmail
  email_address           text NOT NULL,
  display_name            text,
  -- OAuth providers (Gmail, Outlook). Unused by the IMAP/SMTP self-host path.
  oauth_access_token      text,
  oauth_refresh_token     text,
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
  imap_password           text,                             -- AES-256-GCM, base64url
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
-- The encrypted credentials are base64url TEXT, as in the hosted schema since
-- migration 20260524200000. They were bytea here, so PostgREST returned them
-- hex-encoded ("\x7678...") and every IMAP/SMTP call failed with "Failed to
-- decode base64". The CLI always wrote the base64url string, so converting the
-- bytes back to text recovers it exactly.
DO $$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['oauth_access_token', 'oauth_refresh_token', 'imap_password'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'inboxes'
        AND column_name = c AND data_type = 'bytea'
    ) THEN
      EXECUTE format('ALTER TABLE public.inboxes ALTER COLUMN %I TYPE text USING encode(%I, ''escape'')', c, c);
    END IF;
  END LOOP;
END
$$;
-- Columns the server reads or writes that postdate the first self-host release.
-- Every inbox lookup selects the security and review columns, so without them
-- each tool that resolves an inbox fails with "No inbox matches" (issue #82).
ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS imap_security          text NOT NULL DEFAULT 'tls'
    CONSTRAINT inboxes_imap_security_check CHECK (imap_security IN ('tls', 'starttls')),
  ADD COLUMN IF NOT EXISTS smtp_security          text NOT NULL DEFAULT 'tls'
    CONSTRAINT inboxes_smtp_security_check CHECK (smtp_security IN ('tls', 'starttls')),
  ADD COLUMN IF NOT EXISTS send_approval_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS send_review_mode       text NOT NULL DEFAULT 'off'
    CONSTRAINT inboxes_send_review_mode_check CHECK (send_review_mode IN ('off', 'inline', 'dashboard')),
  ADD COLUMN IF NOT EXISTS bulk_review_mode       text NOT NULL DEFAULT 'off'
    CONSTRAINT inboxes_bulk_review_mode_check CHECK (bulk_review_mode IN ('off', 'plan')),
  ADD COLUMN IF NOT EXISTS draft_editor_hidden    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signature_embed_images boolean NOT NULL DEFAULT false;  -- send signature images inline (cid:) instead of as https URLs
CREATE INDEX IF NOT EXISTS idx_inboxes_workspace_id_status   ON public.inboxes (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_inboxes_workspace_id_provider ON public.inboxes (workspace_id, provider);
-- Full (non-partial) unique index so `provision-inbox` can upsert by this pair
-- via ON CONFLICT. Single-tenant self-host never keeps duplicate soft-deleted
-- rows for one address, reconnecting the same address updates the row in place
-- (clearing deleted_at). The hosted product uses a partial index instead to
-- allow many soft-deleted rows per address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inboxes_workspace_email
  ON public.inboxes (workspace_id, email_address);
CREATE OR REPLACE TRIGGER inboxes_updated_at
  BEFORE UPDATE ON public.inboxes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: api_keys  (SHA-256 hash only; scoped; inbox-restricted)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.api_keys (
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
-- Columns the server reads or writes that postdate the first self-host release.
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS card_build_notified text,  -- card build last announced on tools/list
  ADD COLUMN IF NOT EXISTS kind                text
    CONSTRAINT api_keys_kind_check CHECK (kind IS NULL OR kind = 'web_client');
CREATE INDEX IF NOT EXISTS idx_api_keys_workspace_id_active ON public.api_keys (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix          ON public.api_keys (key_prefix);
CREATE OR REPLACE TRIGGER api_keys_updated_at
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- TABLE: activity_log  (append-only tool-call log)
-- Non-partitioned here, the hosted product range-partitions by month for
-- retention; a single self-host instance does not need that machinery.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.activity_log (
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
ALTER TABLE public.activity_log
  ADD COLUMN IF NOT EXISTS error_details jsonb;
CREATE INDEX IF NOT EXISTS idx_activity_log_workspace_created ON public.activity_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_api_key_created   ON public.activity_log (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_tool_created      ON public.activity_log (tool_name, created_at);

-- ============================================================
-- TABLE: scheduled_sends  (future-delivery queue)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.scheduled_sends (
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
CREATE INDEX IF NOT EXISTS scheduled_sends_pending_idx   ON public.scheduled_sends (send_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_sends_workspace_idx ON public.scheduled_sends (workspace_id, send_at ASC) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS scheduled_sends_inbox_idx     ON public.scheduled_sends (inbox_id, created_at DESC);
CREATE OR REPLACE TRIGGER scheduled_sends_updated_at
  BEFORE UPDATE ON public.scheduled_sends
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Rate limiting: rate_limit_buckets + rate_limit_check()
-- ============================================================
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
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
-- The rest of the data plane, copied from the hosted schema (pg_dump of
-- public, 2026-10-15) with RLS policies, grants to anon/authenticated and
-- auth.users foreign keys removed (they point at public.users here).
--
--   usage meter      action_usage, action_usage_reservations,
--                    usage_limit_events, workspace_usage_exemptions,
--                    user_usage_entitlements, user_billing
--   send review      send_approvals, outbound_idempotency
--   drafts           draft_lineage, draft_card_activity
--   bulk operations  bulk_plans, bulk_runs
--   automations      triage_rules, triage_runs, triage_run_items,
--                    triage_seen_messages
--   clients          mcp_client_capabilities, workspace_members
--   hosted-only      billing_email_sends, product_funnel_events,
--                    oauth_refresh_tokens, system_events
-- ============================================================

CREATE TABLE IF NOT EXISTS public.action_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    tool_name text NOT NULL,
    billable boolean NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    meter_version integer DEFAULT 1 NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_usage_billable_quantity_check CHECK (((billable AND (quantity > 0)) OR ((NOT billable) AND (quantity = 0)))),
    CONSTRAINT action_usage_meter_version_check CHECK ((meter_version > 0)),
    CONSTRAINT action_usage_quantity_check CHECK ((quantity >= 0)),
    CONSTRAINT action_usage_pkey PRIMARY KEY (id),
    CONSTRAINT action_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS action_usage_billable_workspace_occurred_idx ON public.action_usage (workspace_id, occurred_at DESC) WHERE billable;
CREATE INDEX IF NOT EXISTS action_usage_workspace_meter_occurred_idx ON public.action_usage (workspace_id, meter_version, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.action_usage_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    tool_name text NOT NULL,
    meter_version integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_usage_reservations_meter_version_check CHECK ((meter_version > 0)),
    CONSTRAINT action_usage_reservations_pkey PRIMARY KEY (id),
    CONSTRAINT action_usage_reservations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS action_usage_reservations_workspace_expiry_idx ON public.action_usage_reservations (workspace_id, expires_at);

CREATE TABLE IF NOT EXISTS public.usage_limit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    effective_plan text NOT NULL,
    used_actions integer NOT NULL,
    cap integer NOT NULL,
    meter_version integer DEFAULT 1 NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_limit_events_cap_check CHECK ((cap > 0)),
    CONSTRAINT usage_limit_events_meter_version_check CHECK ((meter_version > 0)),
    CONSTRAINT usage_limit_events_used_actions_check CHECK ((used_actions >= 0)),
    CONSTRAINT usage_limit_events_pkey PRIMARY KEY (id),
    CONSTRAINT usage_limit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS usage_limit_events_occurred_idx ON public.usage_limit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_limit_events_workspace_occurred_idx ON public.usage_limit_events (workspace_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.user_billing (
    user_id uuid NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    subscription_status text,
    plan text DEFAULT 'free'::text NOT NULL,
    current_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    current_period_start timestamp with time zone,
    CONSTRAINT user_billing_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_billing_stripe_customer_id_key UNIQUE (stripe_customer_id),
    CONSTRAINT user_billing_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_billing_stripe_customer_id ON public.user_billing (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.user_usage_entitlements (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    granted_by uuid,
    reason text NOT NULL,
    source text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    unlimited_inboxes boolean DEFAULT false NOT NULL,
    CONSTRAINT user_usage_entitlements_kind_check CHECK ((kind = ANY (ARRAY['standard'::text, 'comped_scale'::text]))),
    CONSTRAINT user_usage_entitlements_source_check CHECK ((source = ANY (ARRAY['migration'::text, 'support'::text, 'promotion'::text]))),
    CONSTRAINT user_usage_entitlements_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_usage_entitlements_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT user_usage_entitlements_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS public.workspace_usage_exemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    reason text NOT NULL,
    ticket_id text NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    revoke_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_usage_exemptions_expiry_after_grant CHECK (((expires_at IS NULL) OR (expires_at > granted_at))),
    CONSTRAINT workspace_usage_exemptions_reason_check CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 500))),
    CONSTRAINT workspace_usage_exemptions_revoke_reason_check CHECK (((revoke_reason IS NULL) OR ((char_length(revoke_reason) >= 1) AND (char_length(revoke_reason) <= 500)))),
    CONSTRAINT workspace_usage_exemptions_ticket_id_check CHECK (((char_length(ticket_id) >= 1) AND (char_length(ticket_id) <= 200))),
    CONSTRAINT workspace_usage_exemptions_pkey PRIMARY KEY (id),
    CONSTRAINT workspace_usage_exemptions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT workspace_usage_exemptions_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT workspace_usage_exemptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_usage_exemptions_active_idx ON public.workspace_usage_exemptions (workspace_id, expires_at) WHERE (revoked_at IS NULL);

CREATE TABLE IF NOT EXISTS public.workspace_members (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text]))),
    CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id),
    CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON public.workspace_members (user_id);

CREATE TABLE IF NOT EXISTS public.product_funnel_events (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    workspace_id uuid NOT NULL,
    stage text NOT NULL,
    outcome text NOT NULL,
    category text NOT NULL,
    error_category text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    phase text,
    connection_type text,
    auth_reason text,
    CONSTRAINT product_funnel_events_category_check CHECK ((category = ANY (ARRAY['gmail'::text, 'outlook'::text, 'fastmail'::text, 'icloud'::text, 'yahoo'::text, 'zoho'::text, 'yandex'::text, 'generic_imap'::text, 'api_key'::text, 'oauth'::text, 'claude'::text, 'chatgpt'::text, 'cursor'::text, 'vscode'::text, 'cline'::text, 'windsurf'::text, 'gemini'::text, 'zed'::text, 'jetbrains'::text, 'raycast'::text, 'warp'::text, 'curl'::text, 'unknown'::text, 'personal_month'::text, 'personal_year'::text, 'solo_month'::text, 'solo_year'::text, 'pro_month'::text, 'pro_year'::text, 'free'::text, 'personal'::text, 'solo'::text, 'pro'::text, 'pricing_page'::text, 'dashboard_billing'::text]))),
    CONSTRAINT product_funnel_events_connection_type_check CHECK (((connection_type IS NULL) OR (connection_type = ANY (ARRAY['first_connect'::text, 'reconnect'::text])))),
    CONSTRAINT product_funnel_events_error_category_check CHECK (((error_category IS NULL) OR (error_category = ANY (ARRAY['auth_failed'::text, 'validation_failed'::text, 'provider_denied'::text, 'token_exchange_failed'::text, 'plan_limit'::text, 'conflict'::text, 'persistence_failed'::text, 'unknown'::text, 'consent_required'::text, 'price_not_configured'::text, 'subscription_exists'::text, 'stripe_error'::text, 'no_customer'::text])))),
    CONSTRAINT product_funnel_events_outcome_check CHECK ((outcome = ANY (ARRAY['started'::text, 'success'::text, 'failure'::text]))),
    CONSTRAINT product_funnel_events_phase_check CHECK (((phase IS NULL) OR (phase = ANY (ARRAY['tcp'::text, 'tls'::text, 'greeting'::text, 'authentication'::text, 'smtp_tcp'::text, 'smtp_tls'::text, 'smtp_greeting'::text, 'smtp_authentication'::text, 'authorization'::text, 'token_exchange'::text, 'persistence'::text, 'complete'::text])))),
    CONSTRAINT product_funnel_events_stage_check CHECK ((stage = ANY (ARRAY['onboarding_started'::text, 'client_selected'::text, 'provider_selected'::text, 'inbox_connection'::text, 'connection_verified'::text, 'credential_created'::text, 'technical_activation'::text, 'value_activation'::text, 'first_tool_call'::text, 'paywall_reached'::text, 'pricing_viewed'::text, 'checkout_started'::text, 'checkout_completed'::text, 'billing_portal_opened'::text, 'plan_upgraded'::text, 'plan_downgraded'::text, 'multi_inbox_prompt'::text]))),
    CONSTRAINT product_funnel_events_terminal_error_check CHECK ((((outcome = ANY (ARRAY['started'::text, 'success'::text])) AND (error_category IS NULL)) OR (outcome = 'failure'::text))),
    CONSTRAINT product_funnel_events_pkey PRIMARY KEY (id),
    CONSTRAINT product_funnel_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS product_funnel_events_auth_reason_idx ON public.product_funnel_events (auth_reason, occurred_at DESC) WHERE (auth_reason IS NOT NULL);
CREATE INDEX IF NOT EXISTS product_funnel_events_billing_idx ON public.product_funnel_events (stage, occurred_at DESC) WHERE (stage = ANY (ARRAY['paywall_reached'::text, 'pricing_viewed'::text, 'checkout_started'::text, 'checkout_completed'::text, 'billing_portal_opened'::text, 'plan_upgraded'::text, 'plan_downgraded'::text]));
CREATE INDEX IF NOT EXISTS product_funnel_events_stage_outcome_occurred_idx ON public.product_funnel_events (stage, outcome, occurred_at DESC);
CREATE INDEX IF NOT EXISTS product_funnel_events_workspace_stage_occurred_idx ON public.product_funnel_events (workspace_id, stage, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.billing_email_sends (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    stripe_customer_id text,
    user_id uuid,
    recipient text NOT NULL,
    template text NOT NULL,
    scope_key text NOT NULL,
    send_after timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    claimed_at timestamp with time zone,
    attempts smallint DEFAULT 0 NOT NULL,
    last_error text,
    resend_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid,
    period_start timestamp with time zone,
    category text GENERATED ALWAYS AS (
CASE
    WHEN (template ~~ 'winback\_%'::text) THEN 'marketing'::text
    WHEN (template = ANY (ARRAY['usage_warning_80'::text, 'usage_limit_reached'::text, 'automation_paused_limit'::text])) THEN 'transactional'::text
    ELSE 'transactional'::text
END) STORED,
    CONSTRAINT billing_email_sends_keyed CHECK (((stripe_customer_id IS NOT NULL) OR (workspace_id IS NOT NULL))),
    CONSTRAINT billing_email_sends_single_outcome CHECK (((sent_at IS NULL) OR (cancelled_at IS NULL))),
    CONSTRAINT billing_email_sends_template_check CHECK ((template = ANY (ARRAY['dunning_1'::text, 'dunning_3'::text, 'dunning_7'::text, 'dunning_14'::text, 'card_expiry_30'::text, 'card_expiry_7'::text, 'cancel_ask'::text, 'winback_14'::text, 'winback_30'::text, 'usage_warning_80'::text, 'usage_limit_reached'::text, 'automation_paused_limit'::text]))),
    CONSTRAINT billing_email_sends_pkey PRIMARY KEY (id),
    CONSTRAINT billing_email_sends_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT billing_email_sends_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS billing_email_sends_due ON public.billing_email_sends (send_after) WHERE ((sent_at IS NULL) AND (cancelled_at IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS billing_email_sends_identity ON public.billing_email_sends (stripe_customer_id, template, scope_key);
CREATE INDEX IF NOT EXISTS billing_email_sends_open_scope ON public.billing_email_sends (stripe_customer_id, scope_key) WHERE ((sent_at IS NULL) AND (cancelled_at IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS billing_email_sends_workspace_template_period_idx ON public.billing_email_sends (workspace_id, template, period_start) WHERE (workspace_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.system_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT system_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT system_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))),
    CONSTRAINT system_events_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS system_events_event_type_created_at_idx ON public.system_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.mcp_client_capabilities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    client_name text DEFAULT 'unknown'::text NOT NULL,
    client_version text DEFAULT 'unknown'::text NOT NULL,
    protocol_version text DEFAULT 'unknown'::text NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    supports_ui boolean DEFAULT false NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_client_capabilities_pkey PRIMARY KEY (id),
    CONSTRAINT mcp_client_capabilities_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE,
    CONSTRAINT mcp_client_capabilities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_client_capabilities_identity_key ON public.mcp_client_capabilities (api_key_id, client_name, client_version, protocol_version);
CREATE INDEX IF NOT EXISTS mcp_client_capabilities_workspace_last_seen_idx ON public.mcp_client_capabilities (workspace_id, last_seen DESC);

CREATE TABLE IF NOT EXISTS public.oauth_refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    refresh_hash text NOT NULL,
    client_id text NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_name text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    inbox_ids uuid[],
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    api_key_id uuid,
    resource text,
    CONSTRAINT oauth_refresh_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_refresh_tokens_refresh_hash_key UNIQUE (refresh_hash),
    CONSTRAINT oauth_refresh_tokens_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE,
    CONSTRAINT oauth_refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT oauth_refresh_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_api_key_id_idx ON public.oauth_refresh_tokens (api_key_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_at_idx ON public.oauth_refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_refresh_hash_idx ON public.oauth_refresh_tokens (refresh_hash);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_workspace_client_idx ON public.oauth_refresh_tokens (workspace_id, client_id);

CREATE TABLE IF NOT EXISTS public.send_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    inbox_id uuid NOT NULL,
    api_key_id uuid,
    operation text NOT NULL,
    payload jsonb NOT NULL,
    payload_encrypted boolean DEFAULT true NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    send_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by uuid,
    decision_note text,
    decided_via text,
    decided_by_api_key_id uuid,
    expires_at timestamp with time zone,
    CONSTRAINT send_approvals_decided_via_check CHECK (((decided_via IS NULL) OR (decided_via = ANY (ARRAY['dashboard'::text, 'review_page'::text, 'mcp_app'::text])))),
    CONSTRAINT send_approvals_operation_check CHECK ((operation = ANY (ARRAY['email_send'::text, 'email_reply'::text, 'email_forward'::text, 'draft_send'::text, 'schedule_create'::text]))),
    CONSTRAINT send_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT send_approvals_pkey PRIMARY KEY (id),
    CONSTRAINT send_approvals_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL,
    CONSTRAINT send_approvals_decided_by_api_key_id_fkey FOREIGN KEY (decided_by_api_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL,
    CONSTRAINT send_approvals_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT send_approvals_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES public.inboxes(id) ON DELETE CASCADE,
    CONSTRAINT send_approvals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS send_approvals_pending_expiry_idx ON public.send_approvals (expires_at) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS send_approvals_workspace_pending_idx ON public.send_approvals (workspace_id, created_at DESC) WHERE (status = 'pending'::text);

CREATE TABLE IF NOT EXISTS public.outbound_idempotency (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    api_key_id uuid NOT NULL,
    operation text NOT NULL,
    key_digest text NOT NULL,
    request_digest text NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approval_id uuid,
    result_snapshot jsonb,
    CONSTRAINT outbound_idempotency_operation_check CHECK ((operation = ANY (ARRAY['email_send'::text, 'email_reply'::text, 'email_forward'::text, 'draft_send'::text, 'schedule_create'::text, 'email_move'::text, 'email_copy'::text, 'email_move_batch'::text, 'email_copy_batch'::text, 'email_delete'::text, 'email_delete_batch'::text, 'email_flag'::text, 'email_archive'::text, 'email_search_and_move'::text, 'email_search_and_delete'::text, 'draft_create'::text, 'draft_reply'::text, 'draft_update'::text, 'draft_delete'::text]))),
    CONSTRAINT outbound_idempotency_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'pending_approval'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT outbound_idempotency_api_key_id_operation_key_digest_key UNIQUE (api_key_id, operation, key_digest),
    CONSTRAINT outbound_idempotency_pkey PRIMARY KEY (id),
    CONSTRAINT outbound_idempotency_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE,
    CONSTRAINT outbound_idempotency_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.send_approvals(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS outbound_idempotency_approval_id_idx ON public.outbound_idempotency (approval_id) WHERE (approval_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS outbound_idempotency_expires_at_idx ON public.outbound_idempotency (expires_at);

CREATE TABLE IF NOT EXISTS public.draft_lineage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    inbox_id uuid NOT NULL,
    line_id uuid NOT NULL,
    draft_id text NOT NULL,
    revision integer NOT NULL,
    written_by text NOT NULL,
    written_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    closed_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT draft_lineage_closed_reason_check CHECK (((closed_reason IS NULL) OR (closed_reason = ANY (ARRAY['sent'::text, 'sent_kept'::text, 'deleted'::text])))),
    CONSTRAINT draft_lineage_closed_together CHECK (((closed_at IS NULL) = (closed_reason IS NULL))),
    CONSTRAINT draft_lineage_draft_id_check CHECK (((char_length(draft_id) >= 1) AND (char_length(draft_id) <= 1024))),
    CONSTRAINT draft_lineage_revision_check CHECK ((revision >= 1)),
    CONSTRAINT draft_lineage_written_by_check CHECK ((written_by = ANY (ARRAY['agent'::text, 'user'::text]))),
    CONSTRAINT draft_lineage_inbox_draft_key UNIQUE (inbox_id, draft_id),
    CONSTRAINT draft_lineage_line_revision_key UNIQUE (inbox_id, line_id, revision),
    CONSTRAINT draft_lineage_pkey PRIMARY KEY (id),
    CONSTRAINT draft_lineage_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES public.inboxes(id) ON DELETE CASCADE,
    CONSTRAINT draft_lineage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS draft_lineage_workspace_idx ON public.draft_lineage (workspace_id);

-- Draft card activity (hosted migration 20261015220000). Saves and sends made
-- through the draft editor, for the next draft result on the same API key. No
-- mail content.
CREATE TABLE IF NOT EXISTS public.draft_card_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    inbox_id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    draft_id text NOT NULL,
    line_id uuid,
    action text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    revision integer,
    fields text[] DEFAULT '{}'::text[] NOT NULL,
    to_count smallint,
    cc_count smallint,
    bcc_count smallint,
    reported_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT draft_card_activity_action_check CHECK ((action = ANY (ARRAY['saved'::text, 'sent'::text]))),
    CONSTRAINT draft_card_activity_draft_id_check CHECK (((char_length(draft_id) >= 1) AND (char_length(draft_id) <= 1024))),
    CONSTRAINT draft_card_activity_fields_check CHECK ((fields <@ ARRAY['to'::text, 'cc'::text, 'bcc'::text, 'subject'::text, 'body'::text])),
    CONSTRAINT draft_card_activity_revision_check CHECK (((revision IS NULL) OR (revision >= 0))),
    CONSTRAINT draft_card_activity_to_count_check CHECK (((to_count IS NULL) OR (to_count >= 0))),
    CONSTRAINT draft_card_activity_cc_count_check CHECK (((cc_count IS NULL) OR (cc_count >= 0))),
    CONSTRAINT draft_card_activity_bcc_count_check CHECK (((bcc_count IS NULL) OR (bcc_count >= 0))),
    CONSTRAINT draft_card_activity_pkey PRIMARY KEY (id),
    CONSTRAINT draft_card_activity_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES public.inboxes(id) ON DELETE CASCADE,
    CONSTRAINT draft_card_activity_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE,
    CONSTRAINT draft_card_activity_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS draft_card_activity_unreported_idx ON public.draft_card_activity (api_key_id, inbox_id, occurred_at) WHERE reported_at IS NULL;
CREATE INDEX IF NOT EXISTS draft_card_activity_occurred_idx ON public.draft_card_activity (occurred_at);
CREATE INDEX IF NOT EXISTS draft_card_activity_workspace_idx ON public.draft_card_activity (workspace_id);

-- Mail relay registry (hosted migration 20261015180000). Read and written only
-- when the server has a relay configured (SMTP_RELAY_URL), which a self-hosted
-- install normally does not; created so the calls are valid if one is added.
CREATE TABLE IF NOT EXISTS public.mail_relay_hosts (
  host text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('imap', 'smtp')),
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  reason text,
  learned_by text CHECK (learned_by IS NULL OR learned_by IN ('web', 'edge')),
  first_learned_at timestamptz NOT NULL DEFAULT now(),
  last_learned_at timestamptz NOT NULL DEFAULT now(),
  times_learned integer NOT NULL DEFAULT 1,
  PRIMARY KEY (host, protocol),
  CONSTRAINT mail_relay_hosts_host_shape CHECK (host ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$')
);

CREATE TABLE IF NOT EXISTS public.mail_relay_stats (
  hour timestamptz NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('web', 'edge')),
  protocol text NOT NULL CHECK (protocol IN ('imap', 'smtp')),
  host text NOT NULL,
  route text NOT NULL CHECK (route IN ('listed', 'learned', 'fallback')),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'relay_down', 'host_refused')),
  count integer NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  last_detail text,
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hour, runtime, protocol, host, route, outcome)
);

CREATE TABLE IF NOT EXISTS public.mail_relay_candidates (
  host text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('imap', 'smtp')),
  rescues integer NOT NULL DEFAULT 1,
  first_rescue_at timestamptz NOT NULL DEFAULT now(),
  last_rescue_at timestamptz NOT NULL DEFAULT now(),
  last_reason text,
  last_runtime text CHECK (last_runtime IS NULL OR last_runtime IN ('web', 'edge')),
  direct_successes integer NOT NULL DEFAULT 0,
  refused boolean NOT NULL DEFAULT false,
  PRIMARY KEY (host, protocol)
);

CREATE TABLE IF NOT EXISTS public.bulk_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    inbox_id uuid NOT NULL,
    api_key_id uuid,
    operation text NOT NULL,
    action text NOT NULL,
    scope jsonb NOT NULL,
    scope_encrypted boolean DEFAULT true NOT NULL,
    match_count integer NOT NULL,
    scope_kind text NOT NULL,
    permanent boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    cancelled_at timestamp with time zone,
    cancelled_by_api_key_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    executed_at timestamp with time zone,
    executed_by_api_key_id uuid,
    affected_count integer,
    error_code text,
    CONSTRAINT bulk_plans_action_check CHECK ((action = ANY (ARRAY['delete_batch'::text, 'search_and_delete'::text, 'move_batch'::text, 'search_and_move'::text]))),
    CONSTRAINT bulk_plans_affected_count_check CHECK (((affected_count IS NULL) OR (affected_count >= 0))),
    CONSTRAINT bulk_plans_match_count_check CHECK ((match_count >= 0)),
    CONSTRAINT bulk_plans_operation_check CHECK ((operation = ANY (ARRAY['email_delete'::text, 'email_organize'::text]))),
    CONSTRAINT bulk_plans_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['explicit_ids'::text, 'search'::text]))),
    CONSTRAINT bulk_plans_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'executing'::text, 'executed'::text, 'cancelled'::text, 'expired'::text, 'failed'::text]))),
    CONSTRAINT bulk_plans_pkey PRIMARY KEY (id),
    CONSTRAINT bulk_plans_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL,
    CONSTRAINT bulk_plans_cancelled_by_api_key_id_fkey FOREIGN KEY (cancelled_by_api_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL,
    CONSTRAINT bulk_plans_executed_by_api_key_id_fkey FOREIGN KEY (executed_by_api_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL,
    CONSTRAINT bulk_plans_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES public.inboxes(id) ON DELETE CASCADE,
    CONSTRAINT bulk_plans_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bulk_plans_pending_expiry_idx ON public.bulk_plans (expires_at) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS bulk_plans_workspace_created_idx ON public.bulk_plans (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.bulk_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    api_key_id uuid,
    inbox_id uuid NOT NULL,
    operation text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    total integer NOT NULL,
    processed integer DEFAULT 0 NOT NULL,
    succeeded integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    cancel_requested_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bulk_runs_counts_valid CHECK (((processed = (succeeded + failed)) AND (processed <= total))),
    CONSTRAINT bulk_runs_failed_check CHECK ((failed >= 0)),
    CONSTRAINT bulk_runs_operation_check CHECK ((operation = ANY (ARRAY['move_batch'::text, 'flag'::text, 'search_and_move'::text]))),
    CONSTRAINT bulk_runs_processed_check CHECK ((processed >= 0)),
    CONSTRAINT bulk_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'cancelling'::text, 'completed'::text, 'completed_with_errors'::text, 'cancelled_partial'::text, 'failed'::text]))),
    CONSTRAINT bulk_runs_succeeded_check CHECK ((succeeded >= 0)),
    CONSTRAINT bulk_runs_total_check CHECK ((total >= 0)),
    CONSTRAINT bulk_runs_pkey PRIMARY KEY (id),
    CONSTRAINT bulk_runs_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL,
    CONSTRAINT bulk_runs_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES public.inboxes(id) ON DELETE CASCADE,
    CONSTRAINT bulk_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bulk_runs_running_inbox_idx ON public.bulk_runs (inbox_id, created_at DESC) WHERE (status = ANY (ARRAY['running'::text, 'cancelling'::text]));
CREATE INDEX IF NOT EXISTS bulk_runs_workspace_created_idx ON public.bulk_runs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.triage_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    inbox_id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    created_by uuid,
    name text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    filter jsonb NOT NULL,
    action jsonb NOT NULL,
    interval_minutes integer NOT NULL,
    max_messages_per_run integer DEFAULT 25 NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    running_since timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    disabled_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    paused_reason text,
    paused_until timestamp with time zone,
    CONSTRAINT triage_rules_interval_minutes_check CHECK ((interval_minutes = ANY (ARRAY[15, 30, 60, 180, 360, 720, 1440]))),
    CONSTRAINT triage_rules_interval_required_check CHECK ((interval_minutes IS NOT NULL)),
    CONSTRAINT triage_rules_max_messages_check CHECK (((max_messages_per_run >= 1) AND (max_messages_per_run <= 200))),
    CONSTRAINT triage_rules_name_length_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
    CONSTRAINT triage_rules_pkey PRIMARY KEY (id),
    CONSTRAINT triage_rules_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE,
    CONSTRAINT triage_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT triage_rules_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES public.inboxes(id) ON DELETE CASCADE,
    CONSTRAINT triage_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS triage_rules_due_idx ON public.triage_rules (next_run_at) WHERE (enabled AND (deleted_at IS NULL) AND (running_since IS NULL));
CREATE INDEX IF NOT EXISTS triage_rules_workspace_idx ON public.triage_rules (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.triage_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    status text NOT NULL,
    trigger text DEFAULT 'schedule'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    duration_ms integer,
    matched integer DEFAULT 0 NOT NULL,
    processed integer DEFAULT 0 NOT NULL,
    succeeded integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    error_code text,
    error_detail text,
    CONSTRAINT triage_runs_completed_at_check CHECK (((status = 'running'::text) = (completed_at IS NULL))),
    CONSTRAINT triage_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'completed_with_errors'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT triage_runs_trigger_check CHECK ((trigger = ANY (ARRAY['schedule'::text, 'manual'::text]))),
    CONSTRAINT triage_runs_pkey PRIMARY KEY (id),
    CONSTRAINT triage_runs_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.triage_rules(id) ON DELETE CASCADE,
    CONSTRAINT triage_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS triage_runs_rule_idx ON public.triage_runs (rule_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.triage_run_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    message_digest text NOT NULL,
    subject_redacted text,
    sender_redacted text,
    outcome text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    undo_state jsonb,
    undone_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT triage_run_items_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'queued_for_approval'::text, 'failed'::text, 'skipped_duplicate'::text]))),
    CONSTRAINT triage_run_items_pkey PRIMARY KEY (id),
    CONSTRAINT triage_run_items_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.triage_rules(id) ON DELETE CASCADE,
    CONSTRAINT triage_run_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.triage_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS triage_run_items_run_idx ON public.triage_run_items (run_id, created_at);

CREATE TABLE IF NOT EXISTS public.triage_seen_messages (
    rule_id uuid NOT NULL,
    message_digest text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT triage_seen_messages_pkey PRIMARY KEY (rule_id, message_digest),
    CONSTRAINT triage_seen_messages_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.triage_rules(id) ON DELETE CASCADE
);


CREATE OR REPLACE TRIGGER billing_email_sends_updated_at
  BEFORE UPDATE ON public.billing_email_sends
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE OR REPLACE TRIGGER bulk_runs_updated_at
  BEFORE UPDATE ON public.bulk_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE OR REPLACE TRIGGER triage_rules_updated_at
  BEFORE UPDATE ON public.triage_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE OR REPLACE TRIGGER user_billing_updated_at
  BEFORE UPDATE ON public.user_billing
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE OR REPLACE TRIGGER user_usage_entitlements_updated_at
  BEFORE UPDATE ON public.user_usage_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- RPCs the server calls. Bodies match the hosted functions; only
-- emit_system_event differs (see its comment).
-- ============================================================

CREATE OR REPLACE FUNCTION public.workspace_action_allowance(p_workspace_id uuid) RETURNS TABLE(plan text, owner_id uuid, exempt boolean, exempt_reason text, cap integer, period_start timestamp with time zone, period_end timestamp with time zone, grace_ends_at timestamp with time zone, in_grace boolean, used integer, remaining integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- THE two product constants. apps/web/src/lib/stripe/plans.ts mirrors them
  -- as FREE_ACTION_ALLOWANCE / FREE_ACTION_GRACE_DAYS for copy only; the
  -- number a customer reads on /pricing must be the number that blocks them,
  -- and that number is this one.
  c_free_cap        constant integer  := 150;
  c_grace           constant interval := interval '7 days';
  -- Silent abuse ceilings for paid plans. NOT a pricing lever; mirrors
  -- SHADOW_ACTION_CAPS in supabase/functions/mcp-server/index.ts and
  -- maxMonthlyToolCalls in plans.ts. Never named in customer-facing copy.
  c_cap_personal    constant integer  := 25000;
  c_cap_solo        constant integer  := 100000;
  c_cap_pro         constant integer  := 500000;
  c_cap_other       constant integer  := 5000;
  c_meter_version   constant integer  := 1;

  v_plan            text;
  v_owner_id        uuid;
  v_created_at      timestamptz;
  v_early_member    boolean;
  v_exempt          boolean := false;
  v_exempt_reason   text;
  v_cap             integer;
  v_now             timestamptz := now();
  v_month_start     timestamptz;
  v_month_end       timestamptz;
  v_period_start    timestamptz;
  v_period_end      timestamptz;
  v_grace_ends_at   timestamptz;
  v_in_grace        boolean := false;
  v_used            integer := 0;
  v_remaining       integer;
  v_ub_start        timestamptz;
  v_ub_end          timestamptz;
BEGIN
  -- (a) The workspace. deleted_at is irrelevant: a soft-deleted workspace
  -- cannot make tool calls, and if it is restored its allowance must not have
  -- silently changed meanwhile.
  SELECT w.plan, w.owner_id, w.created_at, w.free_action_cap_exempt
    INTO v_plan, v_owner_id, v_created_at, v_early_member
  FROM public.workspaces w
  WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The UTC calendar month containing now(), as timestamptz at 00:00 UTC on
  -- the 1st. now() AT TIME ZONE 'UTC' is a plain timestamp in UTC wall-clock;
  -- date_trunc gives the 1st at midnight; the second AT TIME ZONE 'UTC' reads
  -- that wall-clock back as a UTC instant. This is the same month the edge
  -- function's calendarMonthUsageWindow() computes with Date.UTC.
  v_month_start := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month_end   := v_month_start + interval '1 month';

  -- (b) Exemptions, in precedence order.
  IF v_early_member THEN
    v_exempt := true;
    v_exempt_reason := 'early_member';
  ELSIF EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id
      AND e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'comped';
  ELSIF EXISTS (
    SELECT 1 FROM public.workspace_usage_exemptions x
    WHERE x.workspace_id = p_workspace_id
      AND x.revoked_at IS NULL
      AND (x.expires_at IS NULL OR x.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'exemption';
  END IF;

  IF v_exempt THEN
    -- Nothing to run out of. The month is reported so a dashboard can still
    -- say "42 actions this month" next to the exempt badge.
    v_cap := NULL;
    v_period_start := v_month_start;
    v_period_end := v_month_end;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSIF v_plan IS DISTINCT FROM 'free' THEN
    -- (c) Paid: Stripe's stored cycle when it is live, else the calendar
    -- month. Same rule as growth_inventory_rpcs and the edge function's
    -- resolveUsageBillingWindow.
    SELECT ub.current_period_start, ub.current_period_end
      INTO v_ub_start, v_ub_end
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id
    LIMIT 1;
    IF v_ub_start IS NOT NULL AND v_ub_end IS NOT NULL
       AND v_ub_start <= v_now AND v_now < v_ub_end THEN
      v_period_start := v_ub_start;
      v_period_end := v_ub_end;
    ELSE
      v_period_start := v_month_start;
      v_period_end := v_month_end;
    END IF;
    v_cap := CASE v_plan
      WHEN 'personal' THEN c_cap_personal
      WHEN 'solo'     THEN c_cap_solo
      WHEN 'pro'      THEN c_cap_pro
      ELSE c_cap_other
    END;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSE
    -- (d) Free, created after launch. The first 7 days are not counted, so
    -- the counting window opens at the LATER of the month start and the end
    -- of grace, and never after the month ends. A workspace created on the
    -- 28th is in grace until the 5th of next month: this month's window is
    -- empty (period_start = period_end, used = 0), next month's starts on
    -- the 5th.
    v_grace_ends_at := v_created_at + c_grace;
    v_in_grace := v_now < v_grace_ends_at;
    v_period_end := v_month_end;
    v_period_start := LEAST(GREATEST(v_month_start, v_grace_ends_at), v_month_end);
    v_cap := c_free_cap;
  END IF;

  -- (e) The meter. An empty window (Free, still in grace past month end)
  -- counts nothing; the half-open range would return 0 anyway, this just
  -- makes the intent visible.
  IF v_period_start < v_period_end THEN
    SELECT count(*)::integer INTO v_used
    FROM public.action_usage au
    WHERE au.workspace_id = p_workspace_id
      AND au.billable
      AND au.meter_version = c_meter_version
      AND au.occurred_at >= v_period_start
      AND au.occurred_at <  v_period_end;
  ELSE
    v_used := 0;
  END IF;

  v_remaining := CASE WHEN v_cap IS NULL THEN NULL
                      ELSE GREATEST(v_cap - v_used, 0) END;

  RETURN QUERY SELECT
    v_plan, v_owner_id, v_exempt, v_exempt_reason, v_cap,
    v_period_start, v_period_end, v_grace_ends_at, v_in_grace,
    v_used, v_remaining;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_action_usage(p_workspace_id uuid, p_tool_name text, p_meter_version integer, p_cap integer, p_period_start timestamp with time zone, p_period_end timestamp with time zone) RETURNS TABLE(reservation_id uuid, allowed boolean, used_actions integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_used integer;
  v_reservation_id uuid;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_start >= p_period_end THEN
    RAISE EXCEPTION 'invalid_usage_billing_window' USING ERRCODE = '22007';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  DELETE FROM public.action_usage_reservations
    WHERE workspace_id = p_workspace_id AND expires_at <= now();
  SELECT count(*)::integer INTO v_used FROM (
    SELECT id FROM public.action_usage
      WHERE workspace_id = p_workspace_id AND billable = true
        AND meter_version = p_meter_version
        AND occurred_at >= p_period_start AND occurred_at < p_period_end
    UNION ALL
    SELECT id FROM public.action_usage_reservations
      WHERE workspace_id = p_workspace_id AND meter_version = p_meter_version
        AND expires_at > now()
  ) AS occupied;
  IF v_used >= p_cap THEN
    RETURN QUERY SELECT NULL::uuid, false, v_used;
    RETURN;
  END IF;
  INSERT INTO public.action_usage_reservations (workspace_id, tool_name, meter_version, expires_at)
  VALUES (p_workspace_id, p_tool_name, p_meter_version, LEAST(now() + interval '15 minutes', p_period_end))
  RETURNING id INTO v_reservation_id;
  RETURN QUERY SELECT v_reservation_id, true, v_used + 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_action_usage_reservation(p_reservation_id uuid, p_succeeded boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_reservation public.action_usage_reservations%ROWTYPE;
BEGIN
  DELETE FROM public.action_usage_reservations
    WHERE id = p_reservation_id
    RETURNING * INTO v_reservation;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_succeeded THEN
    INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version)
    VALUES (v_reservation.workspace_id, v_reservation.tool_name, true, 1, v_reservation.meter_version);
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_usage_limit_event(p_workspace_id uuid, p_plan text, p_used_actions integer, p_cap integer, p_meter_version integer, p_period_start timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_funnel_rows integer;
BEGIN
  INSERT INTO public.usage_limit_events
    (workspace_id, effective_plan, used_actions, cap, meter_version)
  VALUES
    (p_workspace_id, p_plan, p_used_actions, p_cap, p_meter_version);

  -- Serialised per workspace so two concurrent rejections cannot both pass the
  -- NOT EXISTS check. Same lock key as reserve_action_usage, so a rejection and
  -- a reservation for one workspace never interleave here.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
  SELECT
    p_workspace_id,
    'paywall_reached',
    'success',
    CASE WHEN p_plan IN ('personal', 'solo', 'pro') THEN p_plan ELSE 'free' END
  WHERE NOT EXISTS (
    SELECT 1 FROM public.product_funnel_events e
    WHERE e.workspace_id = p_workspace_id
      AND e.stage = 'paywall_reached'
      AND e.occurred_at >= p_period_start
  );

  -- product_funnel_events.id is a bigint identity; never RETURNING INTO a
  -- uuid here (20260819160000 is the scar).
  GET DIAGNOSTICS v_funnel_rows = ROW_COUNT;
  RETURN v_funnel_rows > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_mail_relay_use(
  p_runtime text,
  p_protocol text,
  p_host text,
  p_route text,
  p_outcome text,
  p_ms integer,
  p_detail text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  INSERT INTO public.mail_relay_stats AS s
    (hour, runtime, protocol, host, route, outcome, count, total_ms, last_detail, last_at)
  VALUES (
    date_trunc('hour', now()), p_runtime, p_protocol, lower(p_host), p_route, p_outcome,
    1, GREATEST(COALESCE(p_ms, 0), 0), left(p_detail, 300), now()
  )
  ON CONFLICT (hour, runtime, protocol, host, route, outcome) DO UPDATE SET
    count = s.count + 1,
    total_ms = s.total_ms + GREATEST(COALESCE(p_ms, 0), 0),
    last_detail = COALESCE(left(EXCLUDED.last_detail, 300), s.last_detail),
    last_at = now();

  -- Self-trimming, about once in two hundred writes. Cheap: the table holds a
  -- handful of rows per relayed host per hour.
  IF random() < 0.005 THEN
    DELETE FROM public.mail_relay_stats WHERE last_at < now() - interval '120 days';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.learn_mail_relay_host(
  p_host text,
  p_protocol text,
  p_reason text,
  p_runtime text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  c_max_direct_successes constant integer := 5;
  c_rescues_needed constant integer := 2;
  c_min_spread constant interval := interval '5 minutes';
  c_window constant interval := interval '7 days';
  c_learned_for constant interval := interval '30 days';

  v_host text := lower(trim(p_host));
  v_known public.mail_relay_hosts%ROWTYPE;
  v_since timestamptz := now() - c_window;
  v_ok bigint;
  v_candidate public.mail_relay_candidates%ROWTYPE;
BEGIN
  SELECT * INTO v_known FROM public.mail_relay_hosts WHERE host = v_host AND protocol = p_protocol;

  -- Still relayed (manual, or learned and not expired): nothing to decide.
  IF FOUND AND (v_known.source = 'manual' OR v_known.last_learned_at > now() - c_learned_for) THEN
    RETURN true;
  END IF;

  -- Calls made while an earlier learning was in force went through the relay.
  IF FOUND THEN
    v_since := GREATEST(v_since, v_known.last_learned_at + c_learned_for);
  END IF;

  SELECT count(*)
    INTO v_ok
    FROM public.activity_log a
    JOIN public.inboxes i ON i.id = a.inbox_id
   WHERE a.created_at > v_since
     AND a.status = 'success'
     AND CASE
           WHEN p_protocol = 'smtp' THEN
             lower(i.smtp_host) = v_host
             AND a.tool_name IN ('email_send', 'email_reply', 'email_forward', 'draft_send', 'email_compose')
           ELSE
             lower(i.imap_host) = v_host
             AND a.tool_name NOT IN ('email_send', 'email_reply', 'email_forward', 'draft_send', 'email_compose')
         END;

  -- Rule 1: a host that works directly is never learned.
  IF v_ok >= c_max_direct_successes THEN
    INSERT INTO public.mail_relay_candidates AS c
      (host, protocol, rescues, last_reason, last_runtime, direct_successes, refused)
    VALUES (v_host, p_protocol, 1, left(p_reason, 300), p_runtime, v_ok, true)
    ON CONFLICT (host, protocol) DO UPDATE SET
      last_rescue_at = now(),
      last_reason = EXCLUDED.last_reason,
      last_runtime = EXCLUDED.last_runtime,
      direct_successes = EXCLUDED.direct_successes,
      refused = true;
    RETURN false;
  END IF;

  -- Rule 2: count this rescue. Evidence older than the window starts over.
  INSERT INTO public.mail_relay_candidates AS c
    (host, protocol, rescues, last_reason, last_runtime, direct_successes, refused)
  VALUES (v_host, p_protocol, 1, left(p_reason, 300), p_runtime, v_ok, false)
  ON CONFLICT (host, protocol) DO UPDATE SET
    rescues = CASE WHEN c.first_rescue_at < now() - c_window THEN 1 ELSE c.rescues + 1 END,
    first_rescue_at = CASE WHEN c.first_rescue_at < now() - c_window THEN now() ELSE c.first_rescue_at END,
    last_rescue_at = now(),
    last_reason = EXCLUDED.last_reason,
    last_runtime = EXCLUDED.last_runtime,
    direct_successes = EXCLUDED.direct_successes,
    refused = false
  RETURNING * INTO v_candidate;

  IF v_candidate.rescues < c_rescues_needed OR v_candidate.last_rescue_at - v_candidate.first_rescue_at < c_min_spread THEN
    RETURN false;
  END IF;

  INSERT INTO public.mail_relay_hosts (host, protocol, source, reason, learned_by)
  VALUES (v_host, p_protocol, 'auto', left(p_reason, 300), p_runtime)
  ON CONFLICT (host, protocol) DO UPDATE SET
    last_learned_at = now(),
    times_learned = public.mail_relay_hosts.times_learned + 1,
    reason = EXCLUDED.reason,
    learned_by = EXCLUDED.learned_by;
  DELETE FROM public.mail_relay_candidates WHERE host = v_host AND protocol = p_protocol;
  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.draft_lineage_record(p_workspace_id uuid, p_inbox_id uuid, p_draft_id text, p_written_by text, p_line_id uuid DEFAULT NULL::uuid, p_expected_revision integer DEFAULT NULL::integer, p_seed_draft_id text DEFAULT NULL::text, p_adopt boolean DEFAULT false, p_written_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(recorded_line_id uuid, recorded_revision integer, contended boolean)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_line        uuid;
  v_head_rev    integer;
  v_head_closed boolean;
  v_contended   boolean := false;
  v_next        integer;
  v_at          timestamptz := coalesce(p_written_at, now());
  v_rows        integer;
BEGIN
  IF p_workspace_id IS NULL OR p_inbox_id IS NULL OR p_draft_id IS NULL OR p_written_by IS NULL THEN
    RAISE EXCEPTION 'draft_lineage_record: workspace, inbox, draft id and writer are required'
      USING ERRCODE = '22004';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.draft_lineage:' || p_inbox_id::text, 0)
  );

  -- 1. The line the caller resolved, if it is still open.
  IF p_line_id IS NOT NULL THEN
    SELECT l.revision, l.closed_at IS NOT NULL
      INTO v_head_rev, v_head_closed
      FROM public.draft_lineage l
     WHERE l.workspace_id = p_workspace_id
       AND l.inbox_id = p_inbox_id
       AND l.line_id = p_line_id
     ORDER BY l.revision DESC
     LIMIT 1;
    IF FOUND AND NOT v_head_closed THEN
      v_line := p_line_id;
      v_contended := p_expected_revision IS DISTINCT FROM v_head_rev;
    ELSE
      v_contended := true;
    END IF;
  END IF;

  -- 2. A line somebody else started for this very id meanwhile.
  IF v_line IS NULL AND p_adopt THEN
    SELECT l.line_id, l.revision
      INTO v_line, v_head_rev
      FROM public.draft_lineage l
     WHERE l.workspace_id = p_workspace_id
       AND l.inbox_id = p_inbox_id
       AND l.draft_id = p_draft_id
       AND l.closed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.draft_lineage h
          WHERE h.inbox_id = l.inbox_id
            AND h.line_id = l.line_id
            AND h.revision > l.revision
       );
    IF v_line IS NOT NULL THEN
      v_contended := true;
    END IF;
  END IF;

  -- 3. Otherwise a new line, seeded with the older id when there is one.
  IF v_line IS NULL THEN
    v_line := gen_random_uuid();
    v_head_rev := 0;
    IF p_seed_draft_id IS NOT NULL AND p_seed_draft_id <> p_draft_id THEN
      INSERT INTO public.draft_lineage
        (workspace_id, inbox_id, line_id, draft_id, revision, written_by, written_at)
      VALUES
        (p_workspace_id, p_inbox_id, v_line, p_seed_draft_id, 1, p_written_by, v_at)
      ON CONFLICT (inbox_id, draft_id) DO UPDATE
        SET line_id = EXCLUDED.line_id,
            revision = EXCLUDED.revision,
            written_by = EXCLUDED.written_by,
            written_at = EXCLUDED.written_at,
            closed_at = NULL,
            closed_reason = NULL
        WHERE public.draft_lineage.workspace_id = EXCLUDED.workspace_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        RAISE EXCEPTION 'draft_lineage_record: draft id belongs to another workspace'
          USING ERRCODE = '42501';
      END IF;
      v_head_rev := 1;
    END IF;
  END IF;

  v_next := v_head_rev + 1;
  INSERT INTO public.draft_lineage
    (workspace_id, inbox_id, line_id, draft_id, revision, written_by, written_at)
  VALUES
    (p_workspace_id, p_inbox_id, v_line, p_draft_id, v_next, p_written_by, v_at)
  ON CONFLICT (inbox_id, draft_id) DO UPDATE
    SET line_id = EXCLUDED.line_id,
        revision = EXCLUDED.revision,
        written_by = EXCLUDED.written_by,
        written_at = EXCLUDED.written_at,
        closed_at = NULL,
        closed_reason = NULL
    WHERE public.draft_lineage.workspace_id = EXCLUDED.workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'draft_lineage_record: draft id belongs to another workspace'
      USING ERRCODE = '42501';
  END IF;

  recorded_line_id := v_line;
  recorded_revision := v_next;
  contended := v_contended;
  RETURN NEXT;
END;
$$;

-- The hosted version also POSTs the event to an alerting webhook through
-- pg_net with secrets from Vault. Neither exists here, so a self-host install
-- only records the event.
CREATE OR REPLACE FUNCTION public.emit_system_event(p_event_type text, p_payload jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  INSERT INTO public.system_events (event_type, payload, status)
  VALUES (p_event_type, COALESCE(p_payload, '{}'::jsonb), 'pending');
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
-- per-workspace fair-use ceiling high for a solo operator, and
-- free_action_cap_exempt takes it out of the monthly action meter
-- (workspace_action_allowance() reports it as exempt).
-- ============================================================
INSERT INTO public.users (id, email, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'operator@localhost', 'Self-host operator')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, grandfathered, free_action_cap_exempt)
VALUES ('00000000-0000-0000-0000-000000000001', 'self-hosted', 'Self-hosted', '00000000-0000-0000-0000-000000000001', 'pro', true, true)
ON CONFLICT (id) DO NOTHING;

-- An install seeded before free_action_cap_exempt existed gets it here.
UPDATE public.workspaces SET free_action_cap_exempt = true
WHERE id = '00000000-0000-0000-0000-000000000001' AND NOT free_action_cap_exempt;

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner')
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- PostgREST caches the schema at startup; tell it to re-read after `make migrate`.
NOTIFY pgrst, 'reload schema';

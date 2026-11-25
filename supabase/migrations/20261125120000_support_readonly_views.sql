-- ============================================================
-- MCPEmails: read-only support views for investigations
-- 20261125120000_support_readonly_views
-- ============================================================
--
-- The `support_readonly` login role and schema were created on production
-- on 2026-11-20 by hand (execute_sql, not a migration). The role can only
-- SELECT from views in that schema, and each view lists its columns so no
-- token, secret, password, hash, key value or message body is exposed.
-- The full record of that first step lives in the support tool's runbook.
--
-- This migration adds the views a support agent needs to investigate a
-- report, and records in the repo the ones it reuses:
--
--   new       app_errors      the error log (public.app_errors)
--   new       mcp_activity    the MCP tool-call log (public.activity_log)
--   widened   api_keys        adds key_prefix (never key_hash)
--   restated  support_tickets support-form tickets, unchanged
--   restated  workspaces      unchanged
--   restated  inboxes         unchanged; host, port, security, status,
--                             never imap_password, imap_username, oauth_*
--   restated  user_billing    subscriptions (Stripe state per user), unchanged
--
-- "Restated" views keep the exact column list production already has, so
-- CREATE OR REPLACE is a no-op there and builds them on a fresh database.
-- New columns are only ever appended (CREATE OR REPLACE VIEW cannot drop or
-- reorder a column).
--
-- Left out on purpose:
--   app_errors    stack, context (may hold anything, including addresses)
--   mcp_activity  ip_address, user_agent, error_details (jsonb, may hold
--                 anything)
--   api_keys      key_hash, card_build_notified, card_listed, updated_at
--   inboxes       oauth_access_token, oauth_refresh_token,
--                 oauth_token_expires_at, oauth_scope, imap_password,
--                 imap_username, imap_tls, smtp_tls, signature_*,
--                 ai_instructions*, folder_overrides, draft_editor_hidden
--   support_tickets email, subject, message, context, ip_hash
--   user_billing  inbox_keep_order, pause_history, park_on_end_*
--
-- The views run with the owner's rights (no security_invoker), owned by
-- postgres, so they read past RLS; that is why every column is listed. The
-- schema is not in the Data API's exposed schemas and must never be.
--
-- Postgres refuses to drop or retype a column a view uses. A later
-- migration that does must first `drop view support_readonly.<name>;` and
-- recreate it without the column.
--
-- Secret-column check (run as postgres; must return no rows). The same
-- checks run in supabase/tests/support_readonly_views.sql:
--
--   select table_name, column_name
--   from information_schema.columns
--   where table_schema = 'support_readonly'
--     and (column_name ~* '(token|secret|password|passw|oauth|hash|cipher|payload|lease|nonce|verifier|session|stack|body|ip_address|user_agent)'
--          or (column_name ~* 'key' and column_name not in ('api_key_id', 'key_prefix')));
--
-- Idempotent. On production the role already exists and only gains the
-- 5 s statement timeout; on a fresh database (CI, local, staging) the role
-- is created without login, so nothing can sign in as it there.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'support_readonly') then
    create role support_readonly nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls connection limit 5;
    alter role support_readonly set default_transaction_read_only = on;
    alter role support_readonly set idle_in_transaction_session_timeout = '30s';
  end if;
end
$$;

alter role support_readonly set statement_timeout = '5s';

create schema if not exists support_readonly authorization postgres;

-- Error log. `message` is the error's own message, not mail content.
create or replace view support_readonly.app_errors as
  select id, created_at, severity, message, resolved_at
  from public.app_errors;

-- MCP tool-call log (partitioned by month; the view reads every partition).
create or replace view support_readonly.mcp_activity as
  select id, created_at, workspace_id, user_id, api_key_id, inbox_id,
         tool_name, status, error_code, duration_ms
  from public.activity_log;

-- API keys: the PEL-495 columns, plus key_prefix (the non-secret start of
-- the key that the dashboard shows). Never key_hash.
create or replace view support_readonly.api_keys as
  select id, workspace_id, created_by, name, kind, scopes, inbox_ids,
         expires_at, last_used_at, deleted_at, created_at, key_prefix
  from public.api_keys;

create or replace view support_readonly.support_tickets as
  select id, ref, user_id, workspace_id, category, source, status, created_at
  from public.support_tickets;

create or replace view support_readonly.workspaces as
  select id, slug, display_name, owner_id, plan, created_at, updated_at,
         deleted_at, stripe_customer_id, grandfathered, sends_frozen_at,
         payment_issue_since, payment_issue_kind, pro_features_enabled,
         free_action_cap_exempt, fanout_recipient_limit, approval_window_hours,
         onboarding_stage, onboarding_completed_at, web_client_enabled
  from public.workspaces;

create or replace view support_readonly.inboxes as
  select id, workspace_id, owner_user_id, provider, service, email_address,
         display_name, status, last_sync_at, last_error, imap_host, imap_port,
         imap_security, smtp_host, smtp_port, smtp_security,
         send_approval_required, send_review_mode, bulk_review_mode,
         visibility, parked_at, parked_reason, deleted_at, created_at,
         updated_at
  from public.inboxes;

create or replace view support_readonly.user_billing as
  select user_id, stripe_customer_id, stripe_subscription_id,
         subscription_status, plan, pending_plan, pending_plan_effective_at,
         current_period_start, current_period_end, last_decline_code,
         paused_from, pause_resumes_at, created_at, updated_at
  from public.user_billing;

-- Only support_readonly may read the schema.
revoke all on schema support_readonly from public, anon, authenticated, service_role;
revoke all on all tables in schema support_readonly from public, anon, authenticated, service_role;
grant usage on schema support_readonly to support_readonly;
grant select on support_readonly.app_errors, support_readonly.mcp_activity,
  support_readonly.api_keys, support_readonly.support_tickets,
  support_readonly.workspaces, support_readonly.inboxes,
  support_readonly.user_billing
  to support_readonly;

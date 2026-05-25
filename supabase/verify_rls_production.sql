-- =============================================================================
-- RLS Production Verification Script
-- Run this in the Supabase SQL Editor on the production project after applying
-- all migrations. Every row must show rls_enabled = true before going live.
-- =============================================================================

-- 1. Check RLS enabled status for every table in the public schema
SELECT
  t.tablename,
  c.relrowsecurity AS rls_enabled,
  CASE WHEN c.relrowsecurity THEN '✓ PROTECTED' ELSE '✗ UNPROTECTED — FIX BEFORE LAUNCH' END AS status
FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE t.schemaname = 'public'
ORDER BY t.tablename;

-- Expected output (all must show rls_enabled = true):
--   api_keys          | true  | ✓ PROTECTED
--   audit_log         | true  | ✓ PROTECTED
--   inboxes           | true  | ✓ PROTECTED
--   oauth_clients     | true  | ✓ PROTECTED
--   oauth_codes       | true  | ✓ PROTECTED
--   usage_logs        | true  | ✓ PROTECTED
--   workspace_members | true  | ✓ PROTECTED
--   workspaces        | true  | ✓ PROTECTED


-- 2. List all active RLS policies per table
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd AS command,
  qual AS using_expression,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;


-- 3. Verify no table is accessible without authentication (smoke test)
-- This should return 0 rows — the anon role must not be able to SELECT anything
-- from tables that require auth. Run as the anon key (set role in a transaction):
BEGIN;
  SET LOCAL role = anon;
  SELECT COUNT(*) AS anon_workspaces FROM workspaces;   -- must be 0
  SELECT COUNT(*) AS anon_inboxes    FROM inboxes;       -- must be 0
  SELECT COUNT(*) AS anon_api_keys   FROM api_keys;      -- must be 0
  SELECT COUNT(*) AS anon_usage_logs FROM usage_logs;    -- must be 0
ROLLBACK;


-- 4. Confirm all migrations were applied
SELECT version, name, statements IS NOT NULL AS has_sql
FROM supabase_migrations.schema_migrations
ORDER BY version;

-- Expected (8 migrations):
--   20260524124026 | create_initial_schema
--   20260524125108 | row_level_security_policies
--   20260524130059 | configure_auth_user_provisioning
--   20260524200729 | gmail_token_exchange_schema_fixes
--   20260525023201 | workspaces_soft_delete
--   20260525024724 | add_get_current_user_sessions_function
--   20260525025636 | oauth_clients_and_auth_codes
--   20260525041554 | add_stripe_to_workspaces


-- 5. Verify required extensions are enabled
SELECT name, default_version, installed_version,
  CASE WHEN installed_version IS NOT NULL THEN '✓ installed' ELSE '✗ MISSING' END AS status
FROM pg_available_extensions
WHERE name IN ('pgsodium', 'moddatetime', 'pg_cron', 'pgcrypto', 'uuid-ossp')
ORDER BY name;

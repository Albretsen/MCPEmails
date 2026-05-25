-- ============================================================
-- RLS Test 01: All public tables have Row-Level Security enabled
-- ============================================================
-- Verifies that every table in the public schema has RLS switched on.
-- This is the minimum safety gate — if a table is missing RLS, any
-- authenticated or anonymous request can read every row in it.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(15);

-- ----------------------------------------------------------------
-- Assertion helper: checks relrowsecurity flag in pg_class
-- ----------------------------------------------------------------

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'users'
    AND    c.relkind = 'r'
  ),
  'users table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'workspaces'
    AND    c.relkind = 'r'
  ),
  'workspaces table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'workspace_members'
    AND    c.relkind = 'r'
  ),
  'workspace_members table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'inboxes'
    AND    c.relkind = 'r'
  ),
  'inboxes table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'api_keys'
    AND    c.relkind = 'r'
  ),
  'api_keys table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'oauth_states'
    AND    c.relkind = 'r'
  ),
  'oauth_states table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'activity_log'
    AND    c.relkind IN ('r', 'p')  -- 'p' = partitioned table
  ),
  'activity_log parent table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'activity_log_2026_05'
    AND    c.relkind = 'r'
  ),
  'activity_log_2026_05 partition has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'activity_log_2026_06'
    AND    c.relkind = 'r'
  ),
  'activity_log_2026_06 partition has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'activity_log_2026_07'
    AND    c.relkind = 'r'
  ),
  'activity_log_2026_07 partition has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'auth_logs'
    AND    c.relkind = 'r'
  ),
  'auth_logs table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'oauth_clients'
    AND    c.relkind = 'r'
  ),
  'oauth_clients table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'oauth_consents'
    AND    c.relkind = 'r'
  ),
  'oauth_consents table has RLS enabled'
);

SELECT ok(
  (
    SELECT c.relrowsecurity
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relname = 'oauth_auth_codes'
    AND    c.relkind = 'r'
  ),
  'oauth_auth_codes table has RLS enabled'
);

-- ----------------------------------------------------------------
-- Bonus: fail loudly if ANY public table is missing RLS
-- (catches newly added tables that don't have the check above yet)
-- ----------------------------------------------------------------
SELECT is(
  (
    SELECT count(*)::int
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
    AND    c.relkind IN ('r', 'p')   -- 'r' = regular table, 'p' = partitioned table
    AND    c.relrowsecurity = false
    AND    c.relname NOT LIKE 'pg_%' -- exclude system catalog copies
  ),
  0,
  'No public tables are missing RLS (catch-all, includes partitioned tables)'
);

SELECT * FROM finish();
ROLLBACK;

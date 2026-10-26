-- ============================================================
-- Dispatcher URLs come from Vault, never from hardcoded hosts
-- ============================================================
-- Covers migration 20261026175000_dispatch_urls_from_vault.sql:
--   - no function in public carries the production web or Edge Function host
--   - _app_base_url() / _functions_base_url(): NULL without the secret,
--     trailing slash stripped, not callable from a browser session
--   - a dispatcher with dispatch_secret but no base URL skips (no request)
--   - with the base URL set, the request goes to that host
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(12);

-- ------------------------------------------------------------
-- 1. No hardcoded production hosts
-- ------------------------------------------------------------
SELECT is(
  (SELECT array_agg(p.proname::text ORDER BY p.proname)
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosrc LIKE '%mcpemails.com/api%'),
  NULL::text[],
  'no function in public posts to a hardcoded mcpemails.com/api URL');

SELECT is(
  (SELECT array_agg(p.proname::text ORDER BY p.proname)
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosrc LIKE '%.supabase.co/functions%'),
  NULL::text[],
  'no function in public posts to a hardcoded *.supabase.co/functions URL');

-- ------------------------------------------------------------
-- 2. Helpers
-- ------------------------------------------------------------
DELETE FROM vault.secrets WHERE name IN ('app_base_url', 'functions_base_url', 'dispatch_secret');

SELECT is(public._app_base_url(), NULL, '_app_base_url() is NULL without the secret');
SELECT is(public._functions_base_url(), NULL, '_functions_base_url() is NULL without the secret');

SELECT vault.create_secret('https://app.vault-test.invalid/', 'app_base_url');
SELECT vault.create_secret('https://fn.vault-test.invalid/functions/v1', 'functions_base_url');

SELECT is(public._app_base_url(), 'https://app.vault-test.invalid',
  '_app_base_url() reads the secret and strips the trailing slash');
SELECT is(public._functions_base_url(), 'https://fn.vault-test.invalid/functions/v1',
  '_functions_base_url() reads the secret');

SELECT ok(
  NOT has_function_privilege('anon', 'public._app_base_url()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._app_base_url()', 'EXECUTE'),
  '_app_base_url() is not callable by anon or authenticated');
SELECT ok(
  NOT has_function_privilege('anon', 'public._functions_base_url()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._functions_base_url()', 'EXECUTE'),
  '_functions_base_url() is not callable by anon or authenticated');

-- ------------------------------------------------------------
-- 3. Dispatchers skip without a base URL, use it when set
-- ------------------------------------------------------------
DELETE FROM vault.secrets WHERE name IN ('app_base_url', 'functions_base_url');
SELECT vault.create_secret('vault-test-dispatch-secret', 'dispatch_secret');
CREATE TEMP TABLE vault_test_queue AS SELECT count(*) AS n FROM net.http_request_queue;

-- Sweep mode and the Outlook refresh have no "nothing due" early return, so
-- only the base URL decides whether they post.
SELECT lives_ok(
  $$SELECT public.dispatch_billing_lifecycle('sweep'); SELECT public.invoke_outlook_token_refresh()$$,
  'secret set, base URLs missing: skipped, not raised');
SELECT is(
  (SELECT count(*) FROM net.http_request_queue),
  (SELECT n FROM vault_test_queue),
  'and no HTTP request');

SELECT vault.create_secret('https://app.vault-test.invalid', 'app_base_url');
SELECT vault.create_secret('https://fn.vault-test.invalid/functions/v1', 'functions_base_url');
SELECT public.dispatch_billing_lifecycle('sweep');
SELECT public.invoke_outlook_token_refresh();

SELECT is(
  (SELECT count(*) FROM net.http_request_queue
    WHERE url = 'https://app.vault-test.invalid/api/internal/billing-lifecycle/dispatch?mode=sweep'),
  1::bigint,
  'dispatch_billing_lifecycle posts to app_base_url');
SELECT is(
  (SELECT count(*) FROM net.http_request_queue
    WHERE url = 'https://fn.vault-test.invalid/functions/v1/outlook-token-refresh'),
  1::bigint,
  'invoke_outlook_token_refresh posts to functions_base_url');

SELECT * FROM finish();
ROLLBACK;

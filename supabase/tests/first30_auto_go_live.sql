-- ============================================================
-- First 30 days: retention_switches and first30_dry_run_log
-- ============================================================
-- Covers 20261025040000_first30_auto_go_live.sql.
--
--   - both tables have RLS on, no policies, no anon/authenticated access
--   - the first30 switch is seeded in dry run, undecided, 2026-10-28 09:00 UTC
--   - the conditional decision update changes the row once only
--   - the check constraints refuse unknown modes and decisions
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

SELECT has_table('public', 'retention_switches', 'retention_switches exists');
SELECT has_table('public', 'first30_dry_run_log', 'first30_dry_run_log exists');

SELECT ok(
  (SELECT bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('retention_switches', 'first30_dry_run_log')),
  'both tables have RLS enabled');

SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('retention_switches', 'first30_dry_run_log')),
  0,
  'no policies: only the service role reaches them');

SELECT ok(NOT has_table_privilege('anon', 'public.retention_switches', 'SELECT'), 'anon cannot read the switch');
SELECT ok(NOT has_table_privilege('authenticated', 'public.retention_switches', 'UPDATE'), 'authenticated cannot flip the switch');
SELECT ok(NOT has_table_privilege('authenticated', 'public.first30_dry_run_log', 'SELECT'), 'authenticated cannot read the log');
SELECT ok(has_table_privilege('service_role', 'public.first30_dry_run_log', 'DELETE'), 'service_role can prune the log');

SELECT results_eq(
  $$SELECT mode, decision, auto_go_live_at FROM public.retention_switches WHERE key = 'first30'$$,
  $$VALUES ('dry_run'::text, NULL::text, '2026-10-28T09:00:00Z'::timestamptz)$$,
  'first30 is seeded in dry run, undecided, deciding 2026-10-28 09:00 UTC');

-- The conditional decision: the second identical update changes nothing.
WITH first AS (
  UPDATE public.retention_switches
     SET mode = 'live', decision = 'went_live', decided_at = now()
   WHERE key = 'first30' AND decision IS NULL AND mode = 'dry_run'
  RETURNING key
)
SELECT is((SELECT count(*)::int FROM first), 1, 'the first decision wins');

WITH second AS (
  UPDATE public.retention_switches
     SET mode = 'dry_run', decision = 'held', decided_at = now()
   WHERE key = 'first30' AND decision IS NULL AND mode = 'dry_run'
  RETURNING key
)
SELECT is((SELECT count(*)::int FROM second), 0, 'a second decision changes nothing');

SELECT throws_ok(
  $$UPDATE public.retention_switches SET mode = 'send' WHERE key = 'first30'$$,
  '23514', NULL, 'mode must be dry_run or live');

SELECT throws_ok(
  $$UPDATE public.retention_switches SET decision = 'maybe' WHERE key = 'first30'$$,
  '23514', NULL, 'decision must be went_live, held or null');

SELECT throws_ok(
  $$INSERT INTO public.first30_dry_run_log (run_id, decision) VALUES (gen_random_uuid(), 'sent')$$,
  '23514', NULL, 'the log refuses unknown decisions');

SELECT * FROM finish();
ROLLBACK;

-- ============================================================
-- activity_log retention per plan (migration 20261020153742)
-- ============================================================
-- Pins: each plan's window, the comped grant counting as Business, the
-- 90-day storage floor the job ships with, the 90-day audit floor for
-- mailbox-changing calls even when the storage floor is lowered to 30, the
-- clamp at 30, the preview agreeing with the purge, and no API role access.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(17);

-- The months these rows land in may predate the partitions a fresh database
-- has, so create any that are missing (rolled back with everything else).
DO $$
DECLARE
  m date;
BEGIN
  FOR m IN SELECT DISTINCT date_trunc('month', now() - make_interval(days => d))::date
           FROM unnest(ARRAY[10, 45, 100]) AS d
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'activity_log_' || to_char(m, 'YYYY_MM')
    ) THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.activity_log FOR VALUES FROM (%L) TO (%L)',
        'activity_log_' || to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
    END IF;
  END LOOP;
END
$$;

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('9e000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'retention-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('9e000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'retention-comped@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'rt-ws-free', 'Free', '9e000000-0000-0000-0000-000000000001', 'free'),
  ('ae000000-0000-0000-0000-000000000002', 'rt-ws-personal', 'Personal', '9e000000-0000-0000-0000-000000000001', 'personal'),
  ('ae000000-0000-0000-0000-000000000003', 'rt-ws-solo', 'Pro', '9e000000-0000-0000-0000-000000000001', 'solo'),
  ('ae000000-0000-0000-0000-000000000004', 'rt-ws-pro', 'Business', '9e000000-0000-0000-0000-000000000001', 'pro'),
  ('ae000000-0000-0000-0000-000000000005', 'rt-ws-comped', 'Comped', '9e000000-0000-0000-0000-000000000002', 'free');

INSERT INTO public.user_usage_entitlements (user_id, kind, reason, source)
VALUES ('9e000000-0000-0000-0000-000000000002', 'comped_scale', 'pgTAP fixture', 'support');

-- Every workspace: a read and a send at 10, 45 and 100 days.
INSERT INTO public.activity_log (workspace_id, tool_name, status, created_at)
SELECT w, t, 'success', now() - make_interval(days => d)
FROM unnest(ARRAY[
  'ae000000-0000-0000-0000-000000000001', 'ae000000-0000-0000-0000-000000000002',
  'ae000000-0000-0000-0000-000000000003', 'ae000000-0000-0000-0000-000000000004',
  'ae000000-0000-0000-0000-000000000005']::uuid[]) AS w,
  unnest(ARRAY['email_search', 'email_send']) AS t,
  unnest(ARRAY[10, 45, 100]) AS d;

CREATE TEMP VIEW fixture_rows AS
  SELECT workspace_id, tool_name, (now()::date - created_at::date) AS age
  FROM public.activity_log
  WHERE workspace_id::text LIKE 'ae000000-0000-0000-0000-00000000000%';

SELECT is((SELECT count(*)::int FROM fixture_rows), 30, 'fixture: 5 workspaces x 2 tools x 3 ages');

SELECT is(
  (SELECT days FROM public.activity_log_retention_workspace_windows()
   WHERE workspace_id = 'ae000000-0000-0000-0000-000000000005'),
  730, 'a comped workspace resolves to the Business window');

-- Default storage floor 90: only rows past 90 days on Free and Personal go.
CREATE TEMP TABLE preview_total AS
  SELECT sum(rows_to_delete)::int AS n FROM public.activity_log_retention_preview();

SELECT is(public.purge_activity_log_batch(10000), (SELECT n FROM preview_total),
  'the purge deletes exactly what the preview counted');

SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000001' AND age > 90), 0,
  'floor 90: Free rows past 90 days are deleted');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000001' AND age = 45), 2,
  'floor 90: Free rows at 45 days are kept');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000002' AND age > 90), 0,
  'floor 90: Personal rows past 90 days are deleted');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000002'), 4,
  'floor 90: Personal keeps everything inside 90 days');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000003'), 6,
  'Pro keeps 100-day rows');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000004'), 6,
  'Business keeps 100-day rows');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000005'), 6,
  'a comped Free workspace keeps 100-day rows');

-- Storage floor lowered to 30: Free read-only rows past 30 days go, Free
-- mailbox-changing rows stay to 90 (audit floor), Personal is untouched.
SELECT public.purge_activity_log_batch(10000, 30);

SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000001' AND tool_name = 'email_search' AND age = 45), 0,
  'floor 30: a Free read past 30 days is deleted');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000001' AND tool_name = 'email_send' AND age = 45), 1,
  'floor 30: a Free send at 45 days is kept by the audit floor');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000001' AND age = 10), 2,
  'floor 30: Free rows inside 30 days are kept');
SELECT is((SELECT count(*)::int FROM fixture_rows WHERE workspace_id = 'ae000000-0000-0000-0000-000000000002'), 4,
  'floor 30: Personal still keeps 90 days');

SELECT is(public.purge_activity_log_batch(10000, 0), 0,
  'a floor below 30 is clamped to 30, so nothing more goes');

SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_activity_log_batch(integer, integer)', 'execute'),
  'authenticated cannot run the purge');
SELECT ok(NOT has_function_privilege('anon', 'public.activity_log_retention_preview(integer)', 'execute'),
  'anon cannot read the preview');

SELECT * FROM finish();
ROLLBACK;

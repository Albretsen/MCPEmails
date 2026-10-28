-- ============================================================
-- Growth daily activity rollup (migration 20261028120000)
-- ============================================================
-- Pins: per-day counts, session starts that look back across midnight, the
-- window correction for a window that opens mid-session, value successes
-- excluding inbox_list, a partial refresh matching a full rebuild, the
-- engagement bands reading the rollup, and no API role access.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(12);

DO $$
DECLARE
  m date;
BEGIN
  FOR m IN SELECT DISTINCT date_trunc('month', now() - make_interval(days => d))::date
           FROM unnest(ARRAY[0, 5]) AS d
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
  ('9f000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rollup-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('af000000-0000-0000-0000-000000000001', 'rollup-ws', 'Rollup', '9f000000-0000-0000-0000-000000000001', 'free');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host)
VALUES ('af000000-0000-0000-0000-0000000000a1', 'af000000-0000-0000-0000-000000000001',
        'imap', 'rollup@rls-test.invalid', 'active', 'imap.rls-test.invalid');

-- D is three days ago (UTC). A success at 23:50 the day before, then on D a
-- success 20 minutes later (same session), a new session at 02:00 and an
-- error; on D+1 one inbox_list success, which is not a value call.
CREATE TEMP TABLE d AS SELECT ((now() AT TIME ZONE 'utc')::date - 3) AS day;

INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status, created_at)
SELECT 'af000000-0000-0000-0000-000000000001', v.inbox_id, v.tool_name, v.status,
       ((SELECT day FROM d)::timestamp + v.at) AT TIME ZONE 'utc'
FROM (VALUES
  ('af000000-0000-0000-0000-0000000000a1'::uuid, 'email_search', 'success', interval '-10 minutes'),
  ('af000000-0000-0000-0000-0000000000a1'::uuid, 'email_search', 'success', interval '10 minutes'),
  ('af000000-0000-0000-0000-0000000000a1'::uuid, 'email_read',   'success', interval '2 hours'),
  ('af000000-0000-0000-0000-0000000000a1'::uuid, 'email_read',   'error',   interval '3 hours'),
  ('af000000-0000-0000-0000-0000000000a1'::uuid, 'inbox_list',   'success', interval '34 hours')
) AS v(inbox_id, tool_name, status, at);

SELECT ok(public.growth_activity_rollup_refresh(NULL) >= 3, 'a full rebuild writes the fixture days');

CREATE TEMP TABLE r AS
  SELECT g.* FROM public.growth_activity_daily g, d
  WHERE g.workspace_id = 'af000000-0000-0000-0000-000000000001'
    AND g.day BETWEEN d.day - 1 AND d.day + 1;

SELECT is(
  (SELECT row(calls, successes, errors, value_successes)::text FROM r, d WHERE r.day = d.day),
  '(3,2,1,2)', 'day D: three calls, two successes, one error, two value successes');

SELECT is((SELECT session_starts FROM r, d WHERE r.day = d.day), 1,
  'day D: the 00:10 success continues the 23:50 session, only 02:00 starts one');

SELECT is((SELECT first_success_starts FROM r, d WHERE r.day = d.day), false,
  'day D: its first success did not start a session');

SELECT is((SELECT first_success_starts FROM r, d WHERE r.day = d.day - 1), true,
  'day D-1: its only success started a session');

SELECT is((SELECT value_successes FROM r, d WHERE r.day = d.day + 1), 0,
  'day D+1: inbox_list is not a value success');

SELECT is(
  (SELECT public.growth_window_sessions(
            array_agg(r.session_starts ORDER BY r.day), array_agg(r.first_success_starts ORDER BY r.day))
   FROM r, d WHERE r.day >= d.day AND r.successes > 0),
  3, 'a window opening on D counts its first success as a session: 00:10, 02:00 and D+1');

SELECT is(
  (SELECT sum(calls)::int FROM public.growth_tool_daily t, d
   WHERE t.day = d.day AND t.tool_name = 'email_read' AND t.status = 'error'),
  1, 'the tool rollup carries the error by tool and status');

-- A partial refresh from D must write exactly what the full rebuild did.
CREATE TEMP TABLE full_rows AS SELECT * FROM public.growth_activity_daily;
SELECT public.growth_activity_rollup_refresh((SELECT day FROM d));

SELECT is(
  (SELECT count(*)::int FROM (
    (SELECT * FROM full_rows EXCEPT ALL SELECT * FROM public.growth_activity_daily)
    UNION ALL
    (SELECT * FROM public.growth_activity_daily EXCEPT ALL SELECT * FROM full_rows)) x),
  0, 'a partial refresh from D matches the full rebuild');

SELECT ok(
  (SELECT workspaces FROM public.growth_engagement_bands(7) WHERE metric = 'sessions' AND band = '2–3') >= 1,
  'engagement bands read the rollup: the fixture workspace has 3 sessions this week');

SELECT ok(NOT has_table_privilege('anon', 'public.growth_activity_daily', 'select')
      AND NOT has_table_privilege('authenticated', 'public.growth_activity_daily', 'select'),
  'API roles cannot read the rollup');

SELECT ok(NOT has_function_privilege('authenticated', 'public.growth_activity_rollup_refresh(date)', 'execute'),
  'API roles cannot run the refresh');

SELECT * FROM finish();
ROLLBACK;

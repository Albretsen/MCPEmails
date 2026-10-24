-- ============================================================
-- Activation rescue instrumentation (20261024150000_activation_rescue_stages.sql)
-- ============================================================
-- Proves:
--   1. product_funnel_events accepts the four new stages in the shape the web
--      app writes them (outcome success, provider or client category,
--      auth_reason and phase on connect_fix_shown), keeps an older stage, and
--      still refuses an undeclared one.
--   2. activation_segments() files each workspace in exactly one segment,
--      puts a workspace with no events at all in no_attempt, leaves out
--      internal and deleted workspaces, and its segments sum to the total.
--   3. Only the service role may call it.
--
-- Counts are compared against a baseline taken first, so seed data in the
-- test database cannot move the result.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(19);

CREATE TEMP TABLE seg_before AS SELECT * FROM public.activation_segments(30);

-- Eight owners; the on_auth_user_created path creates each workspace.
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
SELECT
  ('a9000000-0000-0000-0000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'owner' || n || '@activation-test.invalid',
  'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'
FROM generate_series(1, 8) AS n;

-- Owner 7 is one of ours; owner 8 deleted theirs.
INSERT INTO public.internal_accounts (email) VALUES ('owner7@activation-test.invalid');
UPDATE public.workspaces SET deleted_at = now()
  WHERE owner_id = 'a9000000-0000-0000-0000-000000000008';

CREATE TEMP TABLE ws AS
  SELECT right(owner_id::text, 1)::int AS n, id FROM public.workspaces
  WHERE owner_id::text LIKE 'a9000000-0000-0000-0000-00000000000%';

-- 1: called. Also connected and once failed: called still wins.
INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category, error_category)
SELECT id, s, o, 'gmail', e FROM ws,
  (VALUES ('inbox_connection', 'failure', 'auth_failed'),
          ('inbox_connection', 'success', NULL),
          ('first_tool_call', 'success', NULL)) AS v(s, o, e)
WHERE n = 1;
-- 2: connected_idle, after a failure.
INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category, error_category)
SELECT id, s, o, 'yahoo', e FROM ws,
  (VALUES ('inbox_connection', 'failure', 'auth_failed'),
          ('inbox_connection', 'success', NULL)) AS v(s, o, e)
WHERE n = 2;
-- 3: failed.
INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category, error_category)
SELECT id, s, o, 'icloud', e FROM ws,
  (VALUES ('provider_selected', 'success', NULL),
          ('inbox_connection', 'started', NULL),
          ('inbox_connection', 'failure', 'auth_failed')) AS v(s, o, e)
WHERE n = 3;
-- 4: started_no_result.
INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
SELECT id, 'inbox_connection', 'started', 'generic_imap' FROM ws WHERE n = 4;
-- 5: picked_provider.
INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
SELECT id, 'provider_selected', 'success', 'gmail' FROM ws WHERE n = 5;
-- 6: no events at all. 7 (internal) and 8 (deleted): no events, excluded.

-- 1. The four stages, as the web app writes them.
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category, auth_reason, phase)
    SELECT id, 'connect_fix_shown', 'success', 'gmail', 'account_password_used', 'authentication'
    FROM ws WHERE n = 3$$,
  '[funnel] connect_fix_shown with provider, auth_reason and phase'
);
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'connect_fix_link_clicked', 'success', 'gmail' FROM ws WHERE n = 3$$,
  '[funnel] connect_fix_link_clicked'
);
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'first_call_prompt_copied', 'success', 'claude' FROM ws WHERE n = 2$$,
  '[funnel] first_call_prompt_copied'
);
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'waiting_state_shown', 'success', 'chatgpt' FROM ws WHERE n = 2$$,
  '[funnel] waiting_state_shown'
);
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'paywall_clicked', 'success', 'free' FROM ws WHERE n = 2$$,
  '[funnel] an existing stage is kept'
);
SELECT throws_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'connect_fix_dismissed', 'success', 'gmail' FROM ws WHERE n = 2$$,
  '23514',
  NULL,
  '[funnel] an undeclared stage is still refused'
);

-- 2. Segments, as the change from the baseline.
CREATE TEMP TABLE seg_after AS SELECT * FROM public.activation_segments(30);

SELECT is((SELECT count(*)::int FROM seg_after), 6, '[segments] all six segments are returned');
SELECT is(
  (SELECT array_agg(segment ORDER BY segment_index) FROM seg_after),
  ARRAY['called', 'connected_idle', 'failed', 'started_no_result', 'picked_provider', 'no_attempt'],
  '[segments] in funnel order'
);

SELECT is(
  (SELECT a.workspaces - b.workspaces FROM seg_after a JOIN seg_before b USING (segment)
    WHERE segment = s),
  1,
  '[segments] one new workspace in ' || s
)
FROM unnest(ARRAY['called', 'connected_idle', 'failed', 'started_no_result', 'picked_provider', 'no_attempt']) AS s;

SELECT is(
  (SELECT max(total_workspaces) - (SELECT max(total_workspaces) FROM seg_before) FROM seg_after),
  6,
  '[segments] internal and deleted workspaces are not in the total'
);
SELECT is(
  (SELECT sum(workspaces)::int FROM seg_after),
  (SELECT max(total_workspaces) FROM seg_after),
  '[segments] the segments sum to the total'
);
SELECT is(
  (SELECT count(DISTINCT total_workspaces)::int FROM seg_after),
  1,
  '[segments] one total on every row'
);

-- 3. Service role only.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.activation_segments(int)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.activation_segments(int)', 'EXECUTE'),
  '[segments] anon and authenticated cannot call it'
);
SELECT ok(
  has_function_privilege('service_role', 'public.activation_segments(int)', 'EXECUTE'),
  '[segments] the service role can'
);

SELECT * FROM finish();
ROLLBACK;

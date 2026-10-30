-- ============================================================
-- experiment_stats with workspace subjects
-- (20261030200000_experiment_stats_workspace_subjects.sql)
-- ============================================================
-- Proves:
--   1. A subject that is a workspace uuid without dashes, with no
--      experiment_subjects row, counts as signed up even though the workspace
--      is older than the assignment, and its retention clock starts at the
--      assignment.
--   2. A cookie subject linked through experiment_subjects still needs a
--      workspace created after the assignment to count as signed up.
--   3. A subject that matches nothing is assigned and nothing else.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(8);

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e5710000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ws-subject@experiment-stats.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('e5710000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cookie-subject@experiment-stats.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');

CREATE TEMP TABLE t_ws ON COMMIT DROP AS
SELECT
  (SELECT id FROM public.workspaces WHERE owner_id = 'e5710000-0000-0000-0000-000000000001') AS ws_a,
  (SELECT id FROM public.workspaces WHERE owner_id = 'e5710000-0000-0000-0000-000000000002') AS ws_b;

-- Both workspaces are 30 days old; the assignments are 10 days old.
UPDATE public.workspaces SET created_at = now() - interval '30 days'
WHERE id IN ((SELECT ws_a FROM t_ws), (SELECT ws_b FROM t_ws));

INSERT INTO public.experiments (key, name, variants, status, retention_goal, retention_window_days)
VALUES ('xp_ws_test', 'Workspace subject test',
        '[{"id":"control","label":"Control","weight":50},{"id":"b","label":"B","weight":50}]',
        'running', 'any_tool_call', 7);

INSERT INTO public.experiment_assignments (experiment_key, subject_id, variant_id, first_assigned_at) VALUES
  ('xp_ws_test', replace((SELECT ws_a FROM t_ws)::text, '-', ''), 'control', now() - interval '10 days'),
  ('xp_ws_test', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'b', now() - interval '10 days'),
  ('xp_ws_test', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'b', now() - interval '10 days');

-- The cookie subject links to the old workspace b.
INSERT INTO public.experiment_subjects (subject_id, workspace_id, linked_at)
VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', (SELECT ws_b FROM t_ws), now() - interval '10 days');

-- Workspace a comes back three days after its assignment.
INSERT INTO public.activity_log (workspace_id, tool_name, status, created_at)
VALUES ((SELECT ws_a FROM t_ws), 'email_read', 'success', now() - interval '7 days');

SET LOCAL ROLE service_role;

CREATE TEMP TABLE t_stats ON COMMIT DROP AS
SELECT * FROM public.experiment_stats('xp_ws_test');

SELECT is((SELECT assigned FROM t_stats WHERE variant_id = 'control'), 1, '[workspace] assigned');
SELECT is((SELECT signed_up FROM t_stats WHERE variant_id = 'control'), 1,
  '[workspace] an older workspace counts as signed up');
SELECT is((SELECT retention_eligible FROM t_stats WHERE variant_id = 'control'), 1,
  '[workspace] eligible once the window has passed since assignment');
SELECT is((SELECT retained FROM t_stats WHERE variant_id = 'control'), 1,
  '[workspace] a call after day one counts as retained');

SELECT is((SELECT assigned FROM t_stats WHERE variant_id = 'b'), 2, '[cookie] both subjects are assigned');
SELECT is((SELECT signed_up FROM t_stats WHERE variant_id = 'b'), 0,
  '[cookie] a workspace older than the assignment is not a sign-up, and an unmatched subject is nothing');
SELECT is((SELECT converted FROM t_stats WHERE variant_id = 'b'), 0, '[cookie] nothing converted');
SELECT is((SELECT retention_eligible FROM t_stats WHERE variant_id = 'b'), 0, '[cookie] nothing eligible');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;

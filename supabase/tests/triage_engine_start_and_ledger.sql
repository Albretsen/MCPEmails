-- ============================================================
-- When a rule starts, and how long it remembers
-- ============================================================
-- Covers migration 20261031210000_triage_engine_start_and_ledger:
--   - a new rule has no past mail and no start until first turned on
--   - the start is stamped by the database, whatever an insert claims
--   - turning a rule back on keeps its first start
--   - changing what a rule matches clears the "caught up" mark
--   - the ledger job leaves live rules alone at any age, and removes a deleted
--     rule's rows only after the grace period
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e2000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'engine-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('e2a00000-0000-0000-0000-00000000000a', 'engine-a', 'Engine A', 'e2000000-0000-0000-0000-000000000001', 'solo');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host)
VALUES ('e2b00000-0000-0000-0000-00000000000b', 'e2a00000-0000-0000-0000-00000000000a',
        'imap', 'one@engine-test.invalid', 'active', 'imap.engine-test.invalid', 'smtp.engine-test.invalid');

INSERT INTO public.api_keys (id, workspace_id, name, key_hash, key_prefix, scopes)
VALUES ('e2c00000-0000-0000-0000-00000000000c', 'e2a00000-0000-0000-0000-00000000000a',
        'engine key', 'engine-test-hash', 'mcpe_en', ARRAY['read:email']);

-- A client claiming a start and a caught-up mark on insert gets neither.
INSERT INTO public.triage_rules (id, workspace_id, inbox_id, api_key_id, name, filter, action, interval_minutes, active_from, scan_drained_at)
VALUES ('e2d00000-0000-0000-0000-000000000001', 'e2a00000-0000-0000-0000-00000000000a',
        'e2b00000-0000-0000-0000-00000000000b', 'e2c00000-0000-0000-0000-00000000000c',
        'new rule', '{"from":"a@engine-test.invalid"}'::jsonb, '{"type":"mark_read"}'::jsonb, 60,
        '2020-01-01', '2020-01-01');

SELECT is((SELECT include_past_mail FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000001'),
          false, 'a new rule does not include past mail');
SELECT is((SELECT active_from FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000001'),
          NULL, 'a rule created off has not started, whatever the insert said');
SELECT is((SELECT scan_drained_at FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000001'),
          NULL, 'nor is it caught up');

UPDATE public.triage_rules SET enabled = true WHERE id = 'e2d00000-0000-0000-0000-000000000001';
SELECT is((SELECT active_from FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000001'),
          now(), 'first turned on: the start is now');

UPDATE public.triage_rules SET active_from = '2026-01-01' WHERE id = 'e2d00000-0000-0000-0000-000000000001';
UPDATE public.triage_rules SET enabled = false WHERE id = 'e2d00000-0000-0000-0000-000000000001';
UPDATE public.triage_rules SET enabled = true WHERE id = 'e2d00000-0000-0000-0000-000000000001';
SELECT is((SELECT active_from FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000001'),
          '2026-01-01'::timestamptz, 'turned off and on again: still the first start');

UPDATE public.triage_rules SET scan_drained_at = now() WHERE id = 'e2d00000-0000-0000-0000-000000000001';
UPDATE public.triage_rules SET name = 'renamed' WHERE id = 'e2d00000-0000-0000-0000-000000000001';
SELECT isnt((SELECT scan_drained_at FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000001'),
            NULL, 'a rename leaves the mark');
UPDATE public.triage_rules SET filter = '{"from":"b@engine-test.invalid"}'::jsonb WHERE id = 'e2d00000-0000-0000-0000-000000000001';
SELECT is((SELECT scan_drained_at FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000001'),
          NULL, 'a new filter clears it');

-- A rule from before the option (include past mail, a floor, no start) that has
-- the option turned off starts from that moment.
INSERT INTO public.triage_rules (id, workspace_id, inbox_id, api_key_id, name, filter, action, interval_minutes, include_past_mail, deep_scan_floor)
VALUES ('e2d00000-0000-0000-0000-000000000002', 'e2a00000-0000-0000-0000-00000000000a',
        'e2b00000-0000-0000-0000-00000000000b', 'e2c00000-0000-0000-0000-00000000000c',
        'old rule', '{"from":"a@engine-test.invalid"}'::jsonb, '{"type":"mark_read"}'::jsonb, 60, true, '2026-01-01');
UPDATE public.triage_rules SET enabled = true WHERE id = 'e2d00000-0000-0000-0000-000000000002';
UPDATE public.triage_rules SET active_from = NULL WHERE id = 'e2d00000-0000-0000-0000-000000000002';
UPDATE public.triage_rules SET include_past_mail = false WHERE id = 'e2d00000-0000-0000-0000-000000000002';
SELECT is((SELECT active_from FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000002'),
          now(), 'turning past mail off on a running rule starts it now');
UPDATE public.triage_rules SET include_past_mail = true WHERE id = 'e2d00000-0000-0000-0000-000000000002';
SELECT is((SELECT deep_scan_floor FROM public.triage_rules WHERE id = 'e2d00000-0000-0000-0000-000000000002'),
          NULL, 'asking for past mail asks for all of it');

-- The ledger job, as scheduled.
INSERT INTO public.triage_seen_messages (rule_id, message_digest, first_seen_at) VALUES
  ('e2d00000-0000-0000-0000-000000000001', 'live-old', now() - interval '3 years'),
  ('e2d00000-0000-0000-0000-000000000002', 'deleted-recently', now() - interval '3 years');
INSERT INTO public.triage_rules (id, workspace_id, inbox_id, api_key_id, name, filter, action, interval_minutes, deleted_at)
VALUES ('e2d00000-0000-0000-0000-000000000003', 'e2a00000-0000-0000-0000-00000000000a',
        'e2b00000-0000-0000-0000-00000000000b', 'e2c00000-0000-0000-0000-00000000000c',
        'long deleted', '{"from":"a@engine-test.invalid"}'::jsonb, '{"type":"mark_read"}'::jsonb, 60, now() - interval '31 days');
INSERT INTO public.triage_seen_messages (rule_id, message_digest, first_seen_at)
VALUES ('e2d00000-0000-0000-0000-000000000003', 'deleted-long-ago', now());
UPDATE public.triage_rules SET deleted_at = now() - interval '29 days' WHERE id = 'e2d00000-0000-0000-0000-000000000002';

DO $run$
DECLARE v_command text;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'triage-seen-retention';
  EXECUTE v_command;
END;
$run$;

SELECT is((SELECT count(*)::int FROM public.triage_seen_messages WHERE message_digest = 'live-old'),
          1, 'a live rule keeps a three-year-old row');
SELECT is((SELECT count(*)::int FROM public.triage_seen_messages WHERE message_digest = 'deleted-recently'),
          1, 'a rule inside the grace period keeps its rows');
SELECT is((SELECT count(*)::int FROM public.triage_seen_messages WHERE message_digest = 'deleted-long-ago'),
          0, 'past the grace period they go');

INSERT INTO public.triage_runs (id, rule_id, workspace_id, status)
VALUES ('e2e00000-0000-0000-0000-00000000000e', 'e2d00000-0000-0000-0000-000000000001', 'e2a00000-0000-0000-0000-00000000000a', 'running');
SELECT lives_ok(
  $$INSERT INTO public.triage_run_items (run_id, rule_id, message_digest, outcome)
    VALUES ('e2e00000-0000-0000-0000-00000000000e', 'e2d00000-0000-0000-0000-000000000001', 'loop', 'skipped_loop')$$,
  'skipped_loop is a run item outcome'
);
SELECT throws_ok(
  $$UPDATE public.triage_run_items SET outcome = 'nonsense' WHERE message_digest = 'loop'$$,
  '23514'
);

SELECT * FROM finish();
ROLLBACK;

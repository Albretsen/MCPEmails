-- No-approval rules: who can write them, and what they let through.
BEGIN;
SELECT plan(45);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'na-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('e0000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'na-member@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('e0000000-0000-4000-8000-000000000002', 'na-a', 'NA', 'e0000000-0000-4000-8000-000000000001', 'solo');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000006', 'member')
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member';
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'owner')
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner';

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host)
VALUES ('e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000002', 'imap',
        'n@na-test.invalid', 'active', 'imap.na-test.invalid');

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES ('e0000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000002',
        'e0000000-0000-4000-8000-000000000001', 'Key', 'mcpe_test', 'na-hash', '{send:email}');

INSERT INTO public.triage_rules (id, workspace_id, inbox_id, api_key_id, name, filter, action, interval_minutes)
VALUES ('e0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000002',
        'e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000005', 'Invoices',
        '{"subject":"x"}'::jsonb, '{"type":"forward","to":["a@na-test.invalid"]}'::jsonb, 60);

CREATE FUNCTION pg_temp.queue() RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.send_approvals (workspace_id, inbox_id, api_key_id, operation, summary, payload, status, expires_at, triage_rule_id, triage_rule_name)
  VALUES ('e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000005', 'email_forward', '{}'::jsonb, '{}'::jsonb, 'pending',
          now() + interval '7 days', 'e0000000-0000-4000-8000-000000000004', 'Invoices')
  RETURNING id;
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, service_role;

CREATE FUNCTION pg_temp.as_user(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
END;
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, service_role;

CREATE TABLE pg_temp.ids (name text PRIMARY KEY, id uuid);
GRANT ALL ON pg_temp.ids TO authenticated, service_role;

-- ── Nobody but a signed-in owner or admin can write ─────────────────────────
SELECT is(has_table_privilege('service_role', 'public.no_approval_rules', 'INSERT'), false, 'the service role, and so the mcp-server, can not insert a rule');
SELECT is(has_table_privilege('service_role', 'public.no_approval_rules', 'UPDATE'), false, 'nor update one');
SELECT is(has_table_privilege('service_role', 'public.no_approval_rule_automations', 'INSERT'), false, 'nor confirm an automation');
SELECT is(has_table_privilege('service_role', 'public.no_approval_workspace_state', 'UPDATE'), false, 'nor resume after pause-all');
SELECT is(has_table_privilege('authenticated', 'public.no_approval_rules', 'INSERT'), false, 'a browser session can not insert directly');
SELECT is(has_table_privilege('authenticated', 'public.no_approval_rules', 'UPDATE'), false, 'nor update directly');
SELECT is(has_table_privilege('authenticated', 'public.no_approval_usage', 'SELECT'), false, 'usage is not for browsers');
SELECT is(has_function_privilege('service_role', 'public.no_approval_rule_save(uuid, uuid, text, text[], text, uuid[], uuid[], integer, text, boolean, boolean)', 'EXECUTE'), false, 'the service role can not call the save function');
SELECT is(has_function_privilege('service_role', 'public.no_approval_rule_confirm(uuid, uuid, uuid)', 'EXECUTE'), false, 'nor the confirm function');
SELECT is(has_function_privilege('service_role', 'public.no_approval_pause_all(uuid, boolean)', 'EXECUTE'), false, 'nor the pause function');
SELECT is(has_function_privilege('anon', 'public.no_approval_rule_save(uuid, uuid, text, text[], text, uuid[], uuid[], integer, text, boolean, boolean)', 'EXECUTE'), false, 'anon can not call it');
SELECT is(has_function_privilege('authenticated', 'public.no_approval_auto_decide(uuid, integer, text[], text, timestamptz)', 'EXECUTE'), false, 'a browser can not decide a forward');

SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$INSERT INTO public.no_approval_rules (workspace_id, name, recipients) VALUES ('e0000000-0000-4000-8000-000000000002', 'x', '{a@na-test.invalid}')$$,
  '42501', NULL, 'an insert as the service role is refused');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('e0000000-0000-4000-8000-000000000006');
SELECT throws_ok(
  $$SELECT public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'x', '{a@na-test.invalid}', 'all_automations', '{}', NULL, 25, 'UTC', true, true)$$,
  '42501', 'no_approval_forbidden', 'a member is refused');
SELECT throws_ok(
  $$SELECT public.no_approval_pause_all('e0000000-0000-4000-8000-000000000002', false)$$,
  '42501', 'no_approval_forbidden', 'a member can not resume');

-- ── An owner can, and only exact addresses ──────────────────────────────────
SELECT pg_temp.as_user('e0000000-0000-4000-8000-000000000001');
SELECT throws_ok(
  $$SELECT public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'x', '{*@na-test.invalid}', 'all_automations', '{}', NULL, 25, 'UTC', true, true)$$,
  '22023', 'no_approval_invalid_recipients', 'no wildcard');
SELECT throws_ok(
  $$SELECT public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'x', '{na-test.invalid}', 'all_automations', '{}', NULL, 25, 'UTC', true, true)$$,
  '22023', 'no_approval_invalid_recipients', 'no bare domain');
SELECT throws_ok(
  $$SELECT public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'x', '{a@na-test.invalid}', 'all_automations', '{}', NULL, 101, 'UTC', true, true)$$,
  '22023', 'no_approval_invalid_limit', 'the limit has a ceiling');
INSERT INTO pg_temp.ids VALUES ('all', public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'Books', '{a@na-test.invalid}', 'all_automations', '{}', NULL, 2, 'UTC', false, true));
RESET ROLE;

SELECT is(
  (SELECT payload->>'user_id' FROM public.system_events WHERE event_type = 'no_approval_rule.created' ORDER BY created_at DESC LIMIT 1),
  'e0000000-0000-4000-8000-000000000001', 'who is logged');
SELECT ok(
  (SELECT NOT (payload::text LIKE '%na-test.invalid%') FROM public.system_events WHERE event_type = 'no_approval_rule.created' ORDER BY created_at DESC LIMIT 1),
  'no address in system_events');

-- ── It decides, once, through the ordinary marker ───────────────────────────
INSERT INTO pg_temp.ids VALUES ('a1', pg_temp.queue());
SELECT is(
  (public.no_approval_auto_decide((SELECT id FROM pg_temp.ids WHERE name = 'a1'), 1, '{a@na-test.invalid}', 'verified', now() + interval '1 minute')->>'decided'),
  'true', 'a covered forward is decided');
SELECT results_eq(
  $$SELECT status, decided_via, decided_by, no_approval_rule_name FROM public.send_approvals WHERE id = (SELECT id FROM pg_temp.ids WHERE name = 'a1')$$,
  $$VALUES ('approved'::text, 'no_approval_rule'::text, NULL::uuid, 'Books'::text)$$,
  'as a rule, not a person');
SELECT is(
  (SELECT count(*)::int FROM public.scheduled_sends WHERE payload->>'approval_id' = (SELECT id::text FROM pg_temp.ids WHERE name = 'a1')),
  1, 'with the same marker a person''s approval writes');
SELECT is(
  (public.no_approval_auto_decide((SELECT id FROM pg_temp.ids WHERE name = 'a1'), 1, '{a@na-test.invalid}', 'verified', now() + interval '1 minute')->>'decided'),
  'false', 'and only once');

-- A second address nobody trusted: it waits, and says why.
UPDATE public.triage_rules SET action = '{"type":"forward","to":["a@na-test.invalid","b@na-test.invalid"]}'::jsonb
 WHERE id = 'e0000000-0000-4000-8000-000000000004';
INSERT INTO pg_temp.ids VALUES ('a2', pg_temp.queue());
SELECT is(
  (public.no_approval_auto_decide((SELECT id FROM pg_temp.ids WHERE name = 'a2'), 1, '{a@na-test.invalid,b@na-test.invalid}', 'verified', now() + interval '1 minute')->>'reason'),
  'address_not_covered', 'every address has to be covered');

-- A key's edit of `to`: the row's addresses are no longer the rule's.
UPDATE public.triage_rules SET action = '{"type":"forward","to":["c@na-test.invalid"]}'::jsonb
 WHERE id = 'e0000000-0000-4000-8000-000000000004';
SELECT is(
  (public.no_approval_recheck((SELECT id FROM pg_temp.ids WHERE name = 'a1'), '{a@na-test.invalid}')->>'covered'),
  'false', 'an edit of to fails the check at dispatch');
UPDATE public.triage_rules SET action = '{"type":"forward","to":["a@na-test.invalid"]}'::jsonb
 WHERE id = 'e0000000-0000-4000-8000-000000000004';

-- The sender.
INSERT INTO pg_temp.ids VALUES ('a3', pg_temp.queue());
SELECT is(
  (public.no_approval_auto_decide((SELECT id FROM pg_temp.ids WHERE name = 'a3'), 1, '{a@na-test.invalid}', 'failed', now() + interval '1 minute')->>'reason'),
  'sender_failed', 'a failed sender waits whatever the setting');

-- Old mail.
SELECT is(
  (public.no_approval_auto_decide((SELECT id FROM pg_temp.ids WHERE name = 'a3'), 1, '{a@na-test.invalid}', 'verified', now() - interval '1 day')->>'reason'),
  'past_mail', 'mail from before the rule was on waits');

-- The limit is 2: a1 used one, this uses the other, the next waits.
SELECT is(
  (public.no_approval_auto_decide((SELECT id FROM pg_temp.ids WHERE name = 'a3'), 1, '{a@na-test.invalid}', 'verified', now() + interval '1 minute')->>'decided'),
  'true', 'under the limit it goes');
INSERT INTO pg_temp.ids VALUES ('a4', pg_temp.queue());
SELECT is(
  (public.no_approval_auto_decide((SELECT id FROM pg_temp.ids WHERE name = 'a4'), 1, '{a@na-test.invalid}', 'verified', now() + interval '1 minute')->>'reason'),
  'daily_limit', 'over the limit it waits');
SELECT is(
  (SELECT status FROM public.send_approvals WHERE id = (SELECT id FROM pg_temp.ids WHERE name = 'a4')),
  'pending', 'and is not dropped');

-- Back to waiting gives the count back.
SELECT is(
  public.no_approval_return_to_waiting((SELECT id FROM pg_temp.ids WHERE name = 'a3'),
    (SELECT s.id FROM public.scheduled_sends s WHERE s.payload->>'approval_id' = (SELECT id::text FROM pg_temp.ids WHERE name = 'a3')), 'fanout_hold'),
  true, 'a row can go back to waiting');
SELECT is(
  (SELECT used FROM public.no_approval_usage WHERE no_approval_rule_id = (SELECT id FROM pg_temp.ids WHERE name = 'all')),
  1, 'and the day''s count comes back');

-- Chosen automations void on any change and come back on a person's confirm.
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('e0000000-0000-4000-8000-000000000001');
SELECT public.no_approval_rule_delete('e0000000-0000-4000-8000-000000000002', (SELECT id FROM pg_temp.ids WHERE name = 'all'));
INSERT INTO pg_temp.ids VALUES ('chosen', public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'Chosen', '{a@na-test.invalid}', 'chosen_automations', '{e0000000-0000-4000-8000-000000000004}', NULL, 25, 'UTC', true, true));
RESET ROLE;
UPDATE public.triage_rules SET filter = '{"subject":"y"}'::jsonb WHERE id = 'e0000000-0000-4000-8000-000000000004';
SELECT is(
  (public.no_approval_evaluate('e0000000-0000-4000-8000-000000000004', '{a@na-test.invalid}')->>'reason'),
  'coverage_voided', 'a filter edit voids chosen coverage');
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('e0000000-0000-4000-8000-000000000001');
SELECT public.no_approval_rule_confirm('e0000000-0000-4000-8000-000000000002', (SELECT id FROM pg_temp.ids WHERE name = 'chosen'), 'e0000000-0000-4000-8000-000000000004');
RESET ROLE;
SELECT is(
  (public.no_approval_evaluate('e0000000-0000-4000-8000-000000000004', '{a@na-test.invalid}')->>'covered'),
  'true', 'and a person confirming brings it back');

-- Why a forward waits while rules are paused or off: only when one would cover it.
CREATE FUNCTION pg_temp.wait_reason(p_to text[], p_verdict text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT public.no_approval_evaluate('e0000000-0000-4000-8000-000000000004', p_to, p_verdict)->>'reason';
$$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('e0000000-0000-4000-8000-000000000001');
SELECT public.no_approval_pause_all('e0000000-0000-4000-8000-000000000002', true);
RESET ROLE;
SELECT is(pg_temp.wait_reason('{a@na-test.invalid}'), 'paused_all', 'paused: a covered forward says so');
SELECT is(
  (public.no_approval_evaluate('e0000000-0000-4000-8000-000000000004', '{a@na-test.invalid}')->>'covered'),
  'false', 'and it is not covered');
SELECT is(pg_temp.wait_reason('{a@na-test.invalid}', 'failed'), 'sender_failed', 'a failed sender still says so while paused');
SELECT is(pg_temp.wait_reason('{b@na-test.invalid}'), 'recipients_changed', 'paused says nothing about an address the rule does not send to');
UPDATE public.triage_rules SET action = '{"type":"forward","to":["a@na-test.invalid","nobody@na-test.invalid"]}'::jsonb
 WHERE id = 'e0000000-0000-4000-8000-000000000004';
SELECT is(pg_temp.wait_reason('{nobody@na-test.invalid}'), NULL, 'paused gives no reason to an address nobody trusted');
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('e0000000-0000-4000-8000-000000000001');
SELECT public.no_approval_pause_all('e0000000-0000-4000-8000-000000000002', false);
SELECT public.no_approval_rule_delete('e0000000-0000-4000-8000-000000000002', (SELECT id FROM pg_temp.ids WHERE name = 'chosen'));
INSERT INTO pg_temp.ids VALUES ('off', public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'Off', '{a@na-test.invalid}', 'all_automations', '{}', NULL, 25, 'UTC', false, false));
RESET ROLE;
SELECT is(pg_temp.wait_reason('{a@na-test.invalid}'), 'coverage_off', 'a rule switched off says so');
SELECT is(pg_temp.wait_reason('{nobody@na-test.invalid}'), NULL, 'and says nothing about another address');
SELECT is(pg_temp.wait_reason('{a@na-test.invalid}', 'failed'), 'sender_failed', 'a failed sender comes before a rule switched off');
SELECT is(pg_temp.wait_reason('{nobody@na-test.invalid}', 'failed'), NULL, 'no rule would cover it, so nothing is said');
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('e0000000-0000-4000-8000-000000000001');
SELECT public.no_approval_rule_delete('e0000000-0000-4000-8000-000000000002', (SELECT id FROM pg_temp.ids WHERE name = 'off'));
INSERT INTO pg_temp.ids VALUES ('full', public.no_approval_rule_save('e0000000-0000-4000-8000-000000000002', NULL, 'Full', '{a@na-test.invalid}', 'all_automations', '{}', NULL, 1, 'UTC', false, true));
RESET ROLE;
INSERT INTO public.no_approval_usage (no_approval_rule_id, day, used)
SELECT id, (now() AT TIME ZONE 'UTC')::date, 1 FROM pg_temp.ids WHERE name = 'full';
SELECT is(
  public.no_approval_evaluate('e0000000-0000-4000-8000-000000000004', '{a@na-test.invalid}', 'failed', NULL, true)->>'reason',
  'sender_failed', 'a failed sender over the daily limit says so, not only that it is over');

SELECT * FROM finish();
ROLLBACK;

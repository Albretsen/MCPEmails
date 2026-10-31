-- Rule forwards waiting for approval: who gets a notice, and how many.
BEGIN;
SELECT plan(24);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('f0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'notice-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('f0000000-0000-4000-8000-000000000002', 'notices-a', 'Notices', 'f0000000-0000-4000-8000-000000000001', 'solo');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host)
VALUES ('f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000002', 'imap',
        'n@notices-test.invalid', 'active', 'imap.notices-test.invalid');

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES ('f0000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000002',
        'f0000000-0000-4000-8000-000000000001', 'Key', 'mcpe_test', 'notices-hash', '{send:email}');

INSERT INTO public.triage_rules (id, workspace_id, inbox_id, api_key_id, name, filter, action, interval_minutes)
VALUES ('f0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000002',
        'f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005', 'Invoices',
        '{"subject":"x"}'::jsonb, '{"type":"forward","to":["a@notices-test.invalid"]}'::jsonb, 60);

CREATE FUNCTION pg_temp.queue(p_created interval, p_ttl interval) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.send_approvals (workspace_id, inbox_id, api_key_id, operation, summary, payload, status, created_at, expires_at, triage_rule_id, triage_rule_name)
  VALUES ('f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005', 'email_forward', '{}'::jsonb, '{}'::jsonb, 'pending',
          now() + p_created, now() + p_created + p_ttl, 'f0000000-0000-4000-8000-000000000004', 'Invoices');
$$;
CREATE FUNCTION pg_temp.notices(p_kind text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.forward_approval_notices WHERE triage_rule_id = 'f0000000-0000-4000-8000-000000000004' AND kind = p_kind;
$$;

-- A burst is one notice.
SELECT pg_temp.queue('-5 minutes', '7 days') FROM generate_series(1, 5);
SELECT is(public.enqueue_forward_approval_notices(), 1, 'a burst of five makes one notice');
SELECT is(pg_temp.notices('queued'), 1::bigint, 'one queued notice');
SELECT is(public.enqueue_forward_approval_notices(), 0, 'a second run adds nothing');

-- A later run within the hour waits; it is not lost.
SELECT pg_temp.queue('-1 minute', '7 days');
SELECT is(public.enqueue_forward_approval_notices(), 0, 'a later run inside the hour waits');
UPDATE public.forward_approval_notices SET created_at = now() - interval '61 minutes' WHERE kind = 'queued';
SELECT is(public.enqueue_forward_approval_notices(), 1, 'and goes out after the hour');
SELECT is(pg_temp.notices('queued'), 2::bigint, 'two queued notices in all');

-- A run still holding its lease is not split.
SELECT pg_temp.queue('-1 minute', '7 days');
UPDATE public.forward_approval_notices SET created_at = now() - interval '61 minutes' WHERE kind = 'queued';
UPDATE public.triage_rules SET running_since = now() WHERE id = 'f0000000-0000-4000-8000-000000000004';
SELECT is(public.enqueue_forward_approval_notices(), 0, 'no notice while the rule is mid-run');
UPDATE public.triage_rules SET running_since = NULL WHERE id = 'f0000000-0000-4000-8000-000000000004';
SELECT is(public.enqueue_forward_approval_notices(), 1, 'notice once the run ended');

-- Reminder: reads each row's own expires_at, once per window.
SELECT is(pg_temp.notices('reminder'), 0::bigint, 'no reminder a week out');
UPDATE public.send_approvals SET created_at = created_at - interval '6 days 1 hour', expires_at = expires_at - interval '6 days 1 hour'
 WHERE triage_rule_id = 'f0000000-0000-4000-8000-000000000004';
SELECT is(public.enqueue_forward_approval_notices(), 1, 'one reminder inside 24 hours');
SELECT is(public.enqueue_forward_approval_notices(), 0, 'and only once across runs');

-- A short-lived forward already had its deadline in the first email.
UPDATE public.send_approvals SET status = 'rejected' WHERE triage_rule_id = 'f0000000-0000-4000-8000-000000000004';
SELECT pg_temp.queue('-1 hour', '24 hours');
UPDATE public.send_approvals SET queued_notice_at = now() WHERE status = 'pending' AND triage_rule_id = 'f0000000-0000-4000-8000-000000000004';
SELECT is(public.enqueue_forward_approval_notices(), 0, 'no reminder for a 24-hour forward');

-- Claiming is exclusive.
SELECT is((SELECT count(*) FROM public.claim_forward_approval_notices(100)), 4::bigint, 'the claim takes what is due');
SELECT is((SELECT count(*) FROM public.claim_forward_approval_notices(100)), 0::bigint, 'and a second claim gets nothing');

-- Failed forwards: one notice per rule per hour, for approved and unattended alike.
INSERT INTO public.send_approvals (id, workspace_id, inbox_id, api_key_id, operation, summary, payload, status, expires_at, triage_rule_id, triage_rule_name, decided_at, decided_via)
VALUES
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005', 'email_forward', '{}'::jsonb, '{}'::jsonb, 'approved', now() + interval '7 days', 'f0000000-0000-4000-8000-000000000004', 'Invoices', now(), 'dashboard'),
  ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005', 'email_forward', '{}'::jsonb, '{}'::jsonb, 'approved', now() + interval '7 days', 'f0000000-0000-4000-8000-000000000004', 'Invoices', now(), 'no_approval_rule'),
  ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005', 'email_forward', '{}'::jsonb, '{}'::jsonb, 'approved', now() + interval '7 days', 'f0000000-0000-4000-8000-000000000004', 'Invoices', now(), 'dashboard'),
  ('f1000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005', 'email_forward', '{}'::jsonb, '{}'::jsonb, 'approved', now() + interval '7 days', 'f0000000-0000-4000-8000-000000000004', 'Invoices', now(), 'dashboard');
CREATE FUNCTION pg_temp.marker(p_id text, p_status text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at, status)
  VALUES ('f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003',
          jsonb_build_object('approval_id', p_id), false, now(), p_status);
$$;
SELECT pg_temp.marker('f1000000-0000-4000-8000-000000000001', 'error');
SELECT pg_temp.marker('f1000000-0000-4000-8000-000000000002', 'error');
SELECT pg_temp.marker('f1000000-0000-4000-8000-000000000003', 'sent');

SELECT is(public.enqueue_forward_approval_notices(), 1, 'two failures make one notice');
SELECT is(pg_temp.notices('failed'), 1::bigint, 'one failed notice');
SELECT is((SELECT count(*) FROM public.send_approvals WHERE failed_notice_id IS NOT NULL), 2::bigint, 'it counts approved and unattended, not the one that was sent');
SELECT is(public.enqueue_forward_approval_notices(), 0, 'a second run adds nothing');

SELECT pg_temp.marker('f1000000-0000-4000-8000-000000000004', 'error');
SELECT is(public.enqueue_forward_approval_notices(), 0, 'a failure inside the hour waits');
SELECT is((SELECT failed_notice_at FROM public.send_approvals WHERE id = 'f1000000-0000-4000-8000-000000000004'), NULL::timestamptz, 'and stays unclaimed');
UPDATE public.forward_approval_notices SET created_at = now() - interval '61 minutes' WHERE kind = 'failed';
SELECT is(public.enqueue_forward_approval_notices(), 1, 'and gets its own notice after the hour');
SELECT is(pg_temp.notices('failed'), 2::bigint, 'two failed notices in all');

-- The opt-outs are two categories.
UPDATE public.users SET unsubscribed_categories = ARRAY['approval_receipts'] WHERE id = 'f0000000-0000-4000-8000-000000000001';
SELECT is((SELECT unsubscribed_categories FROM public.users WHERE id = 'f0000000-0000-4000-8000-000000000001'), ARRAY['approval_receipts'], 'the receipts opt-out can be stored');
SELECT throws_ok(
  $$UPDATE public.users SET unsubscribed_categories = ARRAY['nonsense'] WHERE id = 'f0000000-0000-4000-8000-000000000001'$$,
  '23514', NULL, 'an unknown category is still refused');

SELECT * FROM finish();
ROLLBACK;

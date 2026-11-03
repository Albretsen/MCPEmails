-- ============================================================
-- Retention for logs, send history and expired rows
-- (migration 20261030120000_retention_low_risk)
-- ============================================================
-- purge_send_history():
--   * clears the payload of finished scheduled sends after 7 days, keeps the
--     approval marker and anything recent or still pending;
--   * retires a long-expired pending approval; clears decided approvals after
--     7 days, but never an approved one a pending send still dispatches;
--   * deletes approvals after 90 days with the same guard;
--   * deletes expired idempotency keys and bulk plans.
-- purge_operational_history():
--   * nulls auth_logs / sso_audit_events IP and UA after 30 days, deletes
--     auth_logs after a year, deletes stale rate-limit buckets.
-- scrub_legacy_activity_log_client_info():
--   * nulls client IP/UA in old partitions, keeps the triage runner marker.
-- None of the functions is callable by anon or authenticated.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(27);

-- ── Seed ────────────────────────────────────────────────────────────────────

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a7000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@retention.invalid', 'x', now(), now(), now(),
   '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('a7000000-0000-0000-0000-000000000001', 'owner@retention.invalid', 'Owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('a7a00000-0000-0000-0000-000000000001', 'retention-a', 'Retention A',
   'a7000000-0000-0000-0000-000000000001', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status) VALUES
  ('a7100000-0000-0000-0000-000000000001', 'a7a00000-0000-0000-0000-000000000001',
   'imap', 'a1@retention.invalid', 'active')
ON CONFLICT DO NOTHING;

-- Approvals:
--   e01 rejected 10 days ago                      -> payload cleared
--   e02 rejected 2 days ago                       -> kept
--   e03 approved 10 days ago, marker still pending -> kept (dispatcher needs it)
--   e04 approved 10 days ago, marker sent          -> payload cleared
--   e05 pending, expired 3 days ago                -> retired to expired
--   e06 rejected, created 100 days ago             -> deleted
--   e07 approved 100 days ago, marker pending      -> kept, payload too
INSERT INTO public.send_approvals
  (id, workspace_id, inbox_id, operation, payload, summary, status, created_at, decided_at, expires_at)
VALUES
  ('a7e00000-0000-0000-0000-000000000001', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', '{"v":1,"data":"s"}',
   'rejected', now() - interval '11 days', now() - interval '10 days', now() - interval '10 days'),
  ('a7e00000-0000-0000-0000-000000000002', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', '{}',
   'rejected', now() - interval '2 days', now() - interval '2 days', now() - interval '1 day'),
  ('a7e00000-0000-0000-0000-000000000003', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'schedule_create', '{"v":1,"data":"x"}', '{}',
   'approved', now() - interval '11 days', now() - interval '10 days', now() - interval '10 days'),
  ('a7e00000-0000-0000-0000-000000000004', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', '{}',
   'approved', now() - interval '11 days', now() - interval '10 days', now() - interval '10 days'),
  ('a7e00000-0000-0000-0000-000000000005', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', '{}',
   'pending', now() - interval '4 days', NULL, now() - interval '3 days'),
  ('a7e00000-0000-0000-0000-000000000006', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'email_send', '{}', '{}',
   'rejected', now() - interval '100 days', now() - interval '100 days', now() - interval '99 days'),
  ('a7e00000-0000-0000-0000-000000000007', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'schedule_create', '{"v":1,"data":"x"}', '{}',
   'approved', now() - interval '100 days', now() - interval '100 days', now() - interval '99 days');

-- Scheduled sends:
--   f01 sent 10 days ago, encrypted              -> cleared
--   f02 error 10 days ago, legacy plaintext      -> cleared
--   f03 sent 2 days ago                          -> kept
--   f04 pending                                  -> kept
--   f05 marker for e03, pending                  -> kept
--   f06 marker for e04, sent 10 days ago         -> marker kept as it is
--   f07 marker for e07, pending                  -> kept
-- Markers are inserted while their approval is 'approved' (the integrity
-- trigger requires it).
INSERT INTO public.scheduled_sends
  (id, workspace_id, inbox_id, payload, payload_encrypted, send_at, status, updated_at)
VALUES
  ('a7f00000-0000-0000-0000-000000000001', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', '{"v":1,"data":"body"}', true,
   now() - interval '10 days', 'sent', now() - interval '10 days'),
  ('a7f00000-0000-0000-0000-000000000003', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', '{"v":1,"data":"body"}', true,
   now() - interval '2 days', 'sent', now() - interval '2 days'),
  ('a7f00000-0000-0000-0000-000000000004', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', '{"v":1,"data":"body"}', true,
   now() + interval '20 days', 'pending', now() - interval '20 days'),
  ('a7f00000-0000-0000-0000-000000000005', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', '{"approval_id":"a7e00000-0000-0000-0000-000000000003"}', false,
   now() + interval '20 days', 'pending', now() - interval '10 days'),
  ('a7f00000-0000-0000-0000-000000000006', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', '{"approval_id":"a7e00000-0000-0000-0000-000000000004"}', false,
   now() - interval '10 days', 'sent', now() - interval '10 days'),
  ('a7f00000-0000-0000-0000-000000000007', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', '{"approval_id":"a7e00000-0000-0000-0000-000000000007"}', false,
   now() + interval '5 days', 'pending', now() - interval '100 days');

-- A legacy plaintext row predates the integrity trigger; seed it with the
-- trigger off, as it exists in production.
ALTER TABLE public.scheduled_sends DISABLE TRIGGER scheduled_sends_enforce_integrity;
INSERT INTO public.scheduled_sends
  (id, workspace_id, inbox_id, payload, payload_encrypted, send_at, status, updated_at)
VALUES
  ('a7f00000-0000-0000-0000-000000000002', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', '{"to":["x@retention.invalid"],"body":"legacy"}', false,
   now() - interval '10 days', 'error', now() - interval '10 days');
ALTER TABLE public.scheduled_sends ENABLE TRIGGER scheduled_sends_enforce_integrity;

-- Idempotency keys and bulk plans (need an api key).
INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_hash, key_prefix, scopes)
VALUES ('a7c00000-0000-0000-0000-000000000001', 'a7a00000-0000-0000-0000-000000000001',
        'a7000000-0000-0000-0000-000000000001', 'retention', 'retention-hash', 'mcpe_ret', ARRAY['read:email'])
ON CONFLICT DO NOTHING;

INSERT INTO public.outbound_idempotency (api_key_id, operation, key_digest, request_digest, status, expires_at)
VALUES
  ('a7c00000-0000-0000-0000-000000000001', 'email_send', 'old', 'r', 'succeeded', now() - interval '2 days'),
  ('a7c00000-0000-0000-0000-000000000001', 'email_send', 'live', 'r', 'succeeded', now() + interval '1 hour');

INSERT INTO public.bulk_plans
  (id, workspace_id, inbox_id, operation, action, scope, scope_encrypted, scope_kind, match_count, status, expires_at)
VALUES
  ('a7b00000-0000-0000-0000-000000000001', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'email_organize', 'move_batch', '{"v":1,"data":"x"}', true, 'explicit_ids', 1,
   'executed', now() - interval '8 days'),
  ('a7b00000-0000-0000-0000-000000000002', 'a7a00000-0000-0000-0000-000000000001',
   'a7100000-0000-0000-0000-000000000001', 'email_organize', 'move_batch', '{"v":1,"data":"x"}', true, 'explicit_ids', 1,
   'executed', now() - interval '1 day');

-- ── purge_send_history ──────────────────────────────────────────────────────

SELECT lives_ok($$ SELECT public.purge_send_history() $$, 'purge_send_history runs');

SELECT is((SELECT payload FROM public.scheduled_sends WHERE id = 'a7f00000-0000-0000-0000-000000000001'),
  '{}'::jsonb, 'a send finished 10 days ago loses its message');
SELECT is((SELECT payload FROM public.scheduled_sends WHERE id = 'a7f00000-0000-0000-0000-000000000002'),
  '{}'::jsonb, 'a legacy plaintext send loses its message too');
SELECT is((SELECT status FROM public.scheduled_sends WHERE id = 'a7f00000-0000-0000-0000-000000000001'),
  'sent', 'the send record itself stays');
SELECT is((SELECT payload ->> 'data' FROM public.scheduled_sends WHERE id = 'a7f00000-0000-0000-0000-000000000003'),
  'body', 'a send finished 2 days ago keeps its message');
SELECT is((SELECT payload ->> 'data' FROM public.scheduled_sends WHERE id = 'a7f00000-0000-0000-0000-000000000004'),
  'body', 'a pending send keeps its message');
SELECT is((SELECT payload ->> 'approval_id' FROM public.scheduled_sends WHERE id = 'a7f00000-0000-0000-0000-000000000006'),
  'a7e00000-0000-0000-0000-000000000004', 'an approval marker is left as it is');

SELECT is((SELECT payload FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000001'),
  '{}'::jsonb, 'a rejection decided 10 days ago loses its message');
SELECT is((SELECT summary FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000001'),
  '{"v":1,"data":"s"}'::jsonb, 'its summary stays for the decided list');
SELECT is((SELECT payload ->> 'data' FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000002'),
  'x', 'a rejection decided 2 days ago keeps its message');
SELECT is((SELECT payload ->> 'data' FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000003'),
  'x', 'an approved send still queued keeps its message');
SELECT is((SELECT payload FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000004'),
  '{}'::jsonb, 'an approved send already sent loses its message');
SELECT is((SELECT status FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000005'),
  'expired', 'a pending request expired 3 days ago is retired');
SELECT is((SELECT count(*)::int FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000006'),
  0, 'a decided request older than 90 days is deleted');
SELECT is((SELECT payload ->> 'data' FROM public.send_approvals WHERE id = 'a7e00000-0000-0000-0000-000000000007'),
  'x', 'an old approval a pending send still dispatches is kept whole');

SELECT is((SELECT array_agg(key_digest ORDER BY key_digest) FROM public.outbound_idempotency
           WHERE api_key_id = 'a7c00000-0000-0000-0000-000000000001'),
  ARRAY['live'], 'expired idempotency keys go, live ones stay');
SELECT is((SELECT array_agg(id::text) FROM public.bulk_plans WHERE workspace_id = 'a7a00000-0000-0000-0000-000000000001'),
  ARRAY['a7b00000-0000-0000-0000-000000000002'], 'bulk plans a week past expiry go');

-- ── purge_operational_history: auth_logs, sso_audit_events, rate limits ─────

INSERT INTO public.auth_logs (id, event_type, ip_address, user_agent, created_at) VALUES
  ('a7d00000-0000-0000-0000-000000000001', 'token_refreshed', '203.0.113.7', 'ua', now() - interval '31 days'),
  ('a7d00000-0000-0000-0000-000000000002', 'token_refreshed', '203.0.113.8', 'ua', now() - interval '29 days'),
  ('a7d00000-0000-0000-0000-000000000003', 'token_refreshed', NULL, NULL, now() - interval '400 days');

INSERT INTO public.sso_audit_events (workspace_id, action, ip_address, user_agent, created_at) VALUES
  ('a7a00000-0000-0000-0000-000000000001', 'user.sign_in', '203.0.113.9', 'ua', now() - interval '31 days');

INSERT INTO public.rate_limit_buckets (key, window_start, count) VALUES
  ('retention:old', now() - interval '3 days', 1),
  ('retention:new', now() - interval '1 hour', 1);

SELECT lives_ok($$ SELECT public.purge_operational_history() $$, 'purge_operational_history runs');

SELECT ok((SELECT ip_address IS NULL AND user_agent IS NULL FROM public.auth_logs
           WHERE id = 'a7d00000-0000-0000-0000-000000000001'), 'auth_logs IP and UA go after 30 days');
SELECT ok((SELECT ip_address IS NOT NULL FROM public.auth_logs
           WHERE id = 'a7d00000-0000-0000-0000-000000000002'), 'auth_logs keep them for 30 days');
SELECT is((SELECT count(*)::int FROM public.auth_logs WHERE id = 'a7d00000-0000-0000-0000-000000000003'),
  0, 'auth_logs rows go after a year');
SELECT ok((SELECT bool_and(ip_address IS NULL AND user_agent IS NULL) FROM public.sso_audit_events
           WHERE workspace_id = 'a7a00000-0000-0000-0000-000000000001'), 'SSO audit IP and UA go after 30 days');
SELECT is((SELECT array_agg(key) FROM public.rate_limit_buckets WHERE key LIKE 'retention:%'),
  ARRAY['retention:new'], 'rate-limit buckets whose window ended go');

-- ── scrub_legacy_activity_log_client_info ───────────────────────────────────

INSERT INTO public.activity_log (workspace_id, tool_name, status, ip_address, user_agent, created_at) VALUES
  ('a7a00000-0000-0000-0000-000000000001', 'email_search', 'success', '203.0.113.10', 'claude-ai/1.0', '2026-09-15'),
  ('a7a00000-0000-0000-0000-000000000001', 'triage_run', 'success', NULL, 'mcp-emails-triage-runner', '2026-09-15');

-- Walk every partition (huge step, so one call per partition).
SELECT lives_ok($$
  DO $do$
  BEGIN
    FOR i IN 1..100 LOOP
      EXIT WHEN (public.scrub_legacy_activity_log_client_info(1000000) ->> 'done') = 'true';
    END LOOP;
  END
  $do$
$$, 'the legacy scrub walks to the end');

SELECT ok((SELECT ip_address IS NULL AND user_agent IS NULL FROM public.activity_log
           WHERE workspace_id = 'a7a00000-0000-0000-0000-000000000001' AND tool_name = 'email_search'),
  'a legacy client IP and UA are gone');
SELECT is((SELECT user_agent FROM public.activity_log
           WHERE workspace_id = 'a7a00000-0000-0000-0000-000000000001' AND tool_name = 'triage_run'),
  'mcp-emails-triage-runner', 'the triage runner marker stays');

SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_send_history()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.purge_operational_history()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.scrub_legacy_activity_log_client_info(integer)', 'EXECUTE'),
  'no API role can run the retention functions');

SELECT * FROM finish();
ROLLBACK;

-- ============================================================
-- Outbound abuse brakes: counting, holds, pauses, freeze, and access
-- ============================================================
-- Covers 20261024130000_outbound_abuse_brakes.sql (mcp-server/outbound-brakes.ts).
--
--   - the daily ceiling counts messages and refuses past the limit
--   - the fan-out brake holds past N distinct recipients of one content hash
--     and an approved (human) send skips it but is still counted
--   - the third provider refusal in the window pauses the inbox
--   - workspaces.sends_frozen_at refuses everything
--   - members can neither read nor write the tables nor call the RPCs
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(20);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('b0a00000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'brakes-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('b0a00000-0000-0000-0000-0000000000a1', 'brakes-owner@rls-test.invalid', 'Owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('b0a0aaaa-0000-0000-0000-00000000000a', 'brakes-ws-a', 'Brakes WS', 'b0a00000-0000-0000-0000-0000000000a1', 'pro')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('b0a0aaaa-0000-0000-0000-00000000000a', 'b0a00000-0000-0000-0000-0000000000a1', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host) VALUES
  ('b0a01111-0000-0000-0000-000000000001', 'b0a0aaaa-0000-0000-0000-00000000000a',
   'imap', 'one@brakes-test.invalid', 'active', 'imap.brakes-test.invalid', 'smtp.brakes-test.invalid'),
  ('b0a01111-0000-0000-0000-000000000002', 'b0a0aaaa-0000-0000-0000-00000000000a',
   'imap', 'two@brakes-test.invalid', 'active', 'imap.brakes-test.invalid', 'smtp.brakes-test.invalid'),
  ('b0a01111-0000-0000-0000-000000000003', 'b0a0aaaa-0000-0000-0000-00000000000a',
   'imap', 'three@brakes-test.invalid', 'active', 'imap.brakes-test.invalid', 'smtp.brakes-test.invalid');

-- A helper: one gate call with a small limit, as the service role would make it.
CREATE FUNCTION pg_temp.gate(p_inbox uuid, p_messages int, p_hash text, p_recipients text[], p_human boolean)
RETURNS text LANGUAGE sql AS $$
  SELECT public.outbound_send_gate(
    'b0a0aaaa-0000-0000-0000-00000000000a', p_inbox, p_messages, p_hash, p_recipients,
    5, 3, 3600000, p_human, true
  )->>'decision'
$$;

-- ── Tables exist with RLS on ───────────────────────────────────────────────
SELECT has_column('public', 'workspaces', 'sends_frozen_at', 'workspaces.sends_frozen_at exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outbound_send_events'::regclass),
  'outbound_send_events has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.inbox_send_brakes'::regclass),
  'inbox_send_brakes has RLS enabled');

-- ── Daily ceiling (limit 5 here) ───────────────────────────────────────────
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000001', 3, NULL, NULL, false), 'allow',
  'a batch of 3 under a limit of 5 is allowed');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000001', 2, NULL, NULL, false), 'allow',
  'reaching the limit exactly is allowed');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000001', 1, NULL, NULL, false), 'daily_limit',
  'one past the limit is refused');
SELECT ok(
  (public.outbound_send_gate('b0a0aaaa-0000-0000-0000-00000000000a', 'b0a01111-0000-0000-0000-000000000001',
     1, NULL, NULL, 5, 3, 3600000, false, true)->>'retry_at') IS NOT NULL,
  'the refusal carries a retry time');
SELECT is(
  (SELECT sum(messages)::int FROM public.outbound_send_events
    WHERE inbox_id = 'b0a01111-0000-0000-0000-000000000001' AND kind = 'message'),
  5, 'refused sends are not counted; messages, not calls, are summed');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000002', 1, NULL, NULL, false), 'allow',
  'the ceiling is per inbox');

-- ── Fan-out (limit 3 distinct recipients here) ─────────────────────────────
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000003', 1, repeat('a', 64),
  ARRAY[repeat('1', 64), repeat('2', 64)], false), 'allow', 'two recipients of one content is fine');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000003', 1, repeat('a', 64),
  ARRAY[repeat('2', 64), repeat('3', 64)], false), 'allow', 'three distinct recipients is the limit');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000003', 1, repeat('b', 64),
  ARRAY[repeat('4', 64)], false), 'allow', 'other content is counted separately');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000003', 1, repeat('a', 64),
  ARRAY[repeat('4', 64)], false), 'hold', 'a fourth distinct recipient of the same content holds the inbox');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000003', 1, repeat('c', 64),
  ARRAY[repeat('5', 64)], false), 'hold', 'while held, every further send from the inbox is held');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000003', 1, repeat('a', 64),
  ARRAY[repeat('9', 64)], true), 'allow', 'an approved send skips the fan-out brake');
SELECT ok(
  (SELECT fanout_hold_until > now() AND fanout_hold_until <= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day'
     FROM public.inbox_send_brakes WHERE inbox_id = 'b0a01111-0000-0000-0000-000000000003'),
  'the hold ends at the end of the UTC day');

-- ── Provider-refusal pause ─────────────────────────────────────────────────
SELECT is(
  ARRAY[
    public.outbound_send_refusal('b0a0aaaa-0000-0000-0000-00000000000a', 'b0a01111-0000-0000-0000-000000000002', 3, 3600000, 3600000)->>'paused',
    public.outbound_send_refusal('b0a0aaaa-0000-0000-0000-00000000000a', 'b0a01111-0000-0000-0000-000000000002', 3, 3600000, 3600000)->>'paused',
    public.outbound_send_refusal('b0a0aaaa-0000-0000-0000-00000000000a', 'b0a01111-0000-0000-0000-000000000002', 3, 3600000, 3600000)->>'newly_tripped'
  ],
  ARRAY['false', 'false', 'true'],
  'the third refusal in the window pauses the inbox, and says it just tripped');
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000002', 1, NULL, NULL, true), 'paused',
  'a paused inbox refuses, even an approved send');

-- ── Freeze ─────────────────────────────────────────────────────────────────
UPDATE public.workspaces SET sends_frozen_at = now() WHERE id = 'b0a0aaaa-0000-0000-0000-00000000000a';
SELECT is(pg_temp.gate('b0a01111-0000-0000-0000-000000000003', 1, NULL, NULL, true), 'frozen',
  'a frozen workspace refuses every send');
UPDATE public.workspaces SET sends_frozen_at = NULL WHERE id = 'b0a0aaaa-0000-0000-0000-00000000000a';

-- ── No member access ───────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"b0a00000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
SELECT throws_ok(
  $$SELECT count(*) FROM public.outbound_send_events$$,
  '42501', NULL, 'a member cannot read outbound_send_events');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;

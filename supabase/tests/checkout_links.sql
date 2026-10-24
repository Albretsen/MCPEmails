-- ============================================================
-- Chat checkout links (20261024180000_chat_checkout_links.sql)
-- ============================================================
-- Proves:
--   1. anon and authenticated (even the workspace owner) cannot read
--      checkout_links or execute any of its RPCs; the table is service role
--      only, like product_funnel_events.
--   2. checkout_link_issue inserts the proposed row the first time and, on a
--      second call inside the window, returns the SAME live row (reused) and
--      inserts nothing, so a refusal retry loop cannot mint rows.
--   3. checkout_link_open marks first_opened_at once and reports first_open
--      only on the first open; later opens count but keep the first stamp.
--   4. An expired link is neither redeemed by checkout_link_open nor handed
--      back by checkout_link_issue (a fresh row is minted instead).
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(22);

-- ── Seed (postgres) ──────────────────────────────────────────────────────────
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('c4e10000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'link-owner@checkout-links.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');

CREATE TEMP TABLE t_ids ON COMMIT DROP AS
SELECT (SELECT id FROM public.workspaces WHERE owner_id = 'c4e10000-0000-0000-0000-000000000001') AS ws;
GRANT SELECT ON t_ids TO anon, authenticated, service_role;

SELECT isnt((SELECT ws FROM t_ids), NULL, 'the signup trigger provisions a workspace');
SELECT is((SELECT chat_checkout_link_enabled FROM public.workspaces WHERE id = (SELECT ws FROM t_ids)), false,
  'the internal rollout gate defaults to off');

-- ── 1. anon and authenticated are shut out ──────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.checkout_links$$, '42501', NULL, '[anon] cannot select checkout_links');
SELECT throws_ok(
  $$SELECT * FROM public.checkout_link_issue(gen_random_uuid(), sha256('x'::bytea), (SELECT ws FROM t_ids),
      'c4e10000-0000-0000-0000-000000000001', 'unknown', 'email_compose', 'on', 30)$$,
  '42501', NULL, '[anon] cannot execute checkout_link_issue');
SELECT throws_ok($$SELECT * FROM public.checkout_link_open(sha256('x'::bytea))$$,
  '42501', NULL, '[anon] cannot execute checkout_link_open');
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"c4e10000-0000-0000-0000-000000000001","role":"authenticated"}';
SELECT throws_ok($$SELECT * FROM public.checkout_links$$, '42501', NULL,
  '[authenticated] even the owner cannot select checkout_links');
SELECT throws_ok(
  $$SELECT * FROM public.checkout_link_issue(gen_random_uuid(), sha256('x'::bytea), (SELECT ws FROM t_ids),
      'c4e10000-0000-0000-0000-000000000001', 'unknown', 'email_compose', 'on', 30)$$,
  '42501', NULL, '[authenticated] cannot execute checkout_link_issue');
SELECT throws_ok($$SELECT * FROM public.checkout_link_open(sha256('x'::bytea))$$,
  '42501', NULL, '[authenticated] cannot execute checkout_link_open');
SELECT throws_ok($$SELECT public.checkout_link_attach_session(gen_random_uuid(), 'cs_test', now())$$,
  '42501', NULL, '[authenticated] cannot execute checkout_link_attach_session');
SELECT throws_ok($$SELECT public.checkout_link_complete(gen_random_uuid())$$,
  '42501', NULL, '[authenticated] cannot execute checkout_link_complete');
RESET ROLE;

-- ── 2. Issue, then issue again: the same live row ───────────────────────────
SET LOCAL ROLE service_role;

CREATE TEMP TABLE t_first ON COMMIT DROP AS
SELECT * FROM public.checkout_link_issue(
  'c4e1aaaa-0000-4000-8000-000000000001', sha256('token-one'::bytea), (SELECT ws FROM t_ids),
  'c4e10000-0000-0000-0000-000000000001', 'claude_ai', 'email_compose', 'on', 30);

SELECT is((SELECT id FROM t_first), 'c4e1aaaa-0000-4000-8000-000000000001'::uuid, '[issue] first call inserts the proposed id');
SELECT is((SELECT reused FROM t_first), false, '[issue] first call is not a reuse');
SELECT ok((SELECT expires_at FROM t_first) BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes',
  '[issue] the link lives 30 minutes');

CREATE TEMP TABLE t_second ON COMMIT DROP AS
SELECT * FROM public.checkout_link_issue(
  'c4e1aaaa-0000-4000-8000-000000000002', sha256('token-two'::bytea), (SELECT ws FROM t_ids),
  'c4e10000-0000-0000-0000-000000000001', 'claude_ai', 'email_compose', 'on', 30);

SELECT is((SELECT id FROM t_second), 'c4e1aaaa-0000-4000-8000-000000000001'::uuid, '[issue] second call returns the live row');
SELECT is((SELECT reused FROM t_second), true, '[issue] second call is a reuse');
SELECT is((SELECT count(*)::int FROM public.checkout_links WHERE workspace_id = (SELECT ws FROM t_ids)), 1,
  '[issue] and inserts nothing');

-- ── 3. Open marks first_opened_at once ──────────────────────────────────────
SELECT is((SELECT first_open FROM public.checkout_link_open(sha256('token-one'::bytea))), true,
  '[open] the first open reports first_open');
CREATE TEMP TABLE t_stamp ON COMMIT DROP AS
SELECT first_opened_at FROM public.checkout_links WHERE id = 'c4e1aaaa-0000-4000-8000-000000000001';
SELECT is((SELECT first_open FROM public.checkout_link_open(sha256('token-one'::bytea))), false,
  '[open] a second open does not');
SELECT is(
  (SELECT open_count FROM public.checkout_links WHERE id = 'c4e1aaaa-0000-4000-8000-000000000001'), 2,
  '[open] both opens are counted');
SELECT is(
  (SELECT first_opened_at FROM public.checkout_links WHERE id = 'c4e1aaaa-0000-4000-8000-000000000001'),
  (SELECT first_opened_at FROM t_stamp),
  '[open] first_opened_at keeps its first value');

-- ── 4. An expired link is dead both ways ────────────────────────────────────
UPDATE public.checkout_links SET expires_at = now() - interval '1 minute'
WHERE id = 'c4e1aaaa-0000-4000-8000-000000000001';

SELECT is((SELECT count(*)::int FROM public.checkout_link_open(sha256('token-one'::bytea))), 0,
  '[expired] checkout_link_open returns nothing');
SELECT is(
  (SELECT id FROM public.checkout_link_issue(
    'c4e1aaaa-0000-4000-8000-000000000003', sha256('token-three'::bytea), (SELECT ws FROM t_ids),
    'c4e10000-0000-0000-0000-000000000001', 'claude_ai', 'email_compose', 'on', 30)),
  'c4e1aaaa-0000-4000-8000-000000000003'::uuid,
  '[expired] checkout_link_issue does not hand back the expired row; it mints a fresh one');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;

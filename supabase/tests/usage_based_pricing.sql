-- ============================================================
-- Usage-based pricing migration integration tests
-- ============================================================
-- Exercises the database part of the launch matrix: atomic cap reservations,
-- protected owner entitlements across workspaces, webhook-plan replay safety,
-- new-workspace inheritance, and entitlement read isolation.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(16);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('91000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'usage-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('92000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'usage-other@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

-- Auth provisioning creates a default workspace; use explicit fixtures so the
-- plan/action tests have stable IDs and do not depend on generated slugs.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'usage-free', 'Usage Free', '91000000-0000-0000-0000-000000000001', 'free'),
  ('a2000000-0000-0000-0000-000000000020', 'usage-agent', 'Usage Agent', '91000000-0000-0000-0000-000000000001', 'solo'),
  ('a3000000-0000-0000-0000-000000000030', 'usage-scale', 'Usage Scale', '91000000-0000-0000-0000-000000000001', 'pro'),
  ('a7000000-0000-0000-0000-000000000070', 'usage-cycle', 'Usage Billing Cycle', '91000000-0000-0000-0000-000000000001', 'pro'),
  ('a4000000-0000-0000-0000-000000000040', 'usage-comped-a', 'Usage Comped A', '92000000-0000-0000-0000-000000000002', 'free'),
  ('a5000000-0000-0000-0000-000000000050', 'usage-comped-b', 'Usage Comped B', '92000000-0000-0000-0000-000000000002', 'solo');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('a1000000-0000-0000-0000-000000000010', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('a2000000-0000-0000-0000-000000000020', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('a3000000-0000-0000-0000-000000000030', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('a7000000-0000-0000-0000-000000000070', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('a4000000-0000-0000-0000-000000000040', '92000000-0000-0000-0000-000000000002', 'owner'),
  ('a5000000-0000-0000-0000-000000000050', '92000000-0000-0000-0000-000000000002', 'owner');

-- Free-cap reservation: its third in-flight action is refused, proving the
-- reservation itself is included in the atomic occupancy count.
SELECT is((SELECT allowed FROM public.reserve_action_usage('a1000000-0000-0000-0000-000000000010'::uuid, 'email_read', 1, 2, now() - interval '1 day', now() + interval '1 day')), true,
  'Free workspace: first action is reserved');
SELECT is((SELECT used_actions FROM public.reserve_action_usage('a1000000-0000-0000-0000-000000000010'::uuid, 'email_read', 1, 2, now() - interval '1 day', now() + interval '1 day')), 2,
  'Free workspace: second reservation reports its occupied slot');
SELECT is((SELECT allowed FROM public.reserve_action_usage('a1000000-0000-0000-0000-000000000010'::uuid, 'email_read', 1, 2, now() - interval '1 day', now() + interval '1 day')), false,
  'Free workspace: cap blocks a new billable action');

-- Agent and Scale exercise their independent workspace ledgers. The edge
-- function supplies their production allowances (50,000 and 300,000); this
-- keeps the DB test fast while proving no workspace shares another's meter.
SELECT is((SELECT allowed FROM public.reserve_action_usage('a2000000-0000-0000-0000-000000000020'::uuid, 'email_read', 1, 1, now() - interval '1 day', now() + interval '1 day')), true,
  'Agent workspace: independent action reservation is allowed');
SELECT is((SELECT allowed FROM public.reserve_action_usage('a3000000-0000-0000-0000-000000000030'::uuid, 'email_read', 1, 1, now() - interval '1 day', now() + interval '1 day')), true,
  'Scale workspace: independent action reservation is allowed');
SELECT is((SELECT count(*) FROM public.action_usage WHERE workspace_id = 'a2000000-0000-0000-0000-000000000020'), 0::bigint,
  'an in-flight Agent action is not billed before successful finalization');

SELECT is(public.finalize_action_usage_reservation(
  (SELECT reservation_id FROM public.reserve_action_usage('a3000000-0000-0000-0000-000000000030'::uuid, 'email_send', 1, 2, now() - interval '1 day', now() + interval '1 day')), false), true,
  'failed Scale action releases its reservation');
SELECT is((SELECT count(*) FROM public.action_usage WHERE workspace_id = 'a3000000-0000-0000-0000-000000000030'), 0::bigint,
  'failed Scale action produces no billable ledger entry');

-- A completed action before the explicitly supplied billing-cycle start must
-- not consume an action in the current cycle.
INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version, occurred_at)
VALUES ('a7000000-0000-0000-0000-000000000070', 'email_read', true, 1, 1, now() - interval '2 days');
SELECT is((SELECT allowed FROM public.reserve_action_usage('a7000000-0000-0000-0000-000000000070'::uuid, 'email_read', 1, 1, now() - interval '1 day', now() + interval '1 day')), true,
  'a prior billing-cycle action does not consume the current cycle allowance');

INSERT INTO public.user_usage_entitlements (user_id, kind, reason, source)
VALUES ('92000000-0000-0000-0000-000000000002', 'comped_scale', 'pricing migration test', 'migration');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}';

SELECT is((SELECT plan || ':' || comped_scale FROM public.effective_workspace_plan('a4000000-0000-0000-0000-000000000040')),
  'pro:true', 'comped owner resolves to Scale from a Free Stripe projection');
SELECT is((SELECT plan || ':' || comped_scale FROM public.effective_workspace_plan('a5000000-0000-0000-0000-000000000050')),
  'pro:true', 'comped owner resolves to Scale in every owned workspace');
SELECT is((SELECT count(*) FROM public.user_usage_entitlements), 1::bigint,
  'a user can read only their own entitlement');

RESET ROLE;
-- Simulate Stripe cancellation/downgrade and replay: only the normal plan
-- projection changes; entitlement resolution must remain protected.
UPDATE public.workspaces SET plan = 'free' WHERE id IN (
  'a4000000-0000-0000-0000-000000000040', 'a5000000-0000-0000-0000-000000000050'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}';
SELECT is((SELECT plan || ':' || comped_scale FROM public.effective_workspace_plan('a4000000-0000-0000-0000-000000000040')),
  'pro:true', 'Stripe webhook replay cannot downgrade a comped owner');
RESET ROLE;

-- The trigger makes a future workspace inherit the Scale projection even
-- before any webhook has a chance to project a subscription plan.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('a6000000-0000-0000-0000-000000000060', 'usage-comped-new', 'Usage Comped New',
        '92000000-0000-0000-0000-000000000002', 'free');
SELECT is((SELECT plan FROM public.workspaces WHERE id = 'a6000000-0000-0000-0000-000000000060'), 'pro',
  'new workspace owned by a comped user inherits Scale projection');

-- Expiry returns the user to the Stripe/workspace plan rather than making the
-- entitlement permanent accidentally.
UPDATE public.user_usage_entitlements
SET expires_at = now() - interval '1 second'
WHERE user_id = '92000000-0000-0000-0000-000000000002';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}';
SELECT is((SELECT plan || ':' || comped_scale FROM public.effective_workspace_plan('a4000000-0000-0000-0000-000000000040')),
  'free:false', 'expired entitlement returns the owner to their normal plan');
RESET ROLE;

SELECT throws_ok(
  $$INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version)
    VALUES ('a1000000-0000-0000-0000-000000000010', 'inbox_list', false, 1, 1)$$,
  '23514', NULL,
  'non-billable calls cannot be stored as actions'
);

SELECT * FROM finish();
ROLLBACK;

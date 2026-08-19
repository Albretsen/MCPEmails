-- ============================================================
-- Usage-based pricing migration integration tests
-- ============================================================
-- Exercises the database part of the launch matrix: atomic ceiling
-- reservations, protected owner entitlements across workspaces, webhook-plan
-- replay safety, new-workspace inheritance, entitlement read isolation, and the
-- 2026-08-19 permanent inbox grandfather.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(23);

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
  ('a2000000-0000-0000-0000-000000000020', 'usage-pro', 'Usage Pro', '91000000-0000-0000-0000-000000000001', 'solo'),
  ('a3000000-0000-0000-0000-000000000030', 'usage-team', 'Usage Team', '91000000-0000-0000-0000-000000000001', 'pro'),
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

-- Pro (`solo`) and Team (`pro`) exercise their independent workspace ledgers.
-- The edge function supplies their production ceilings (100,000 and 500,000);
-- this keeps the DB test fast while proving no workspace shares another's
-- meter.
SELECT is((SELECT allowed FROM public.reserve_action_usage('a2000000-0000-0000-0000-000000000020'::uuid, 'email_read', 1, 1, now() - interval '1 day', now() + interval '1 day')), true,
  'Pro workspace: independent action reservation is allowed');
SELECT is((SELECT allowed FROM public.reserve_action_usage('a3000000-0000-0000-0000-000000000030'::uuid, 'email_read', 1, 1, now() - interval '1 day', now() + interval '1 day')), true,
  'Team workspace: independent action reservation is allowed');
SELECT is((SELECT count(*) FROM public.action_usage WHERE workspace_id = 'a2000000-0000-0000-0000-000000000020'), 0::bigint,
  'an in-flight Pro action is not billed before successful finalization');

SELECT is(public.finalize_action_usage_reservation(
  (SELECT reservation_id FROM public.reserve_action_usage('a3000000-0000-0000-0000-000000000030'::uuid, 'email_send', 1, 2, now() - interval '1 day', now() + interval '1 day')), false), true,
  'failed Team action releases its reservation');
SELECT is((SELECT count(*) FROM public.action_usage WHERE workspace_id = 'a3000000-0000-0000-0000-000000000030'), 0::bigint,
  'failed Team action produces no billable ledger entry');

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
  'pro:true', 'comped owner resolves to Team from a Free Stripe projection');
SELECT is((SELECT plan || ':' || comped_scale FROM public.effective_workspace_plan('a5000000-0000-0000-0000-000000000050')),
  'pro:true', 'comped owner resolves to Team in every owned workspace');
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

-- The trigger makes a future workspace inherit the Team projection even
-- before any webhook has a chance to project a subscription plan.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('a6000000-0000-0000-0000-000000000060', 'usage-comped-new', 'Usage Comped New',
        '92000000-0000-0000-0000-000000000002', 'free');
SELECT is((SELECT plan FROM public.workspaces WHERE id = 'a6000000-0000-0000-0000-000000000060'), 'pro',
  'new workspace owned by a comped user inherits Team projection');

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

-- ============================================================
-- 2026-08-19 repricing: the permanent inbox grandfather.
-- ============================================================
-- A pre-repricing user with a plain `standard` entitlement, which is what the
-- backfill wrote for the 169 accounts that had no comped grant.
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('93000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'usage-grandfathered@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

-- Slugs deliberately do not echo the local-part of the email: auth provisioning
-- creates a default workspace whose slug IS the local-part, and an explicit
-- fixture reusing it collides on workspaces_slug_key.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('b1000000-0000-0000-0000-000000000010', 'usage-gf-original', 'Usage Grandfathered',
        '93000000-0000-0000-0000-000000000003', 'free');
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('b1000000-0000-0000-0000-000000000010', '93000000-0000-0000-0000-000000000003', 'owner');

INSERT INTO public.user_usage_entitlements (user_id, kind, reason, source, unlimited_inboxes)
VALUES ('93000000-0000-0000-0000-000000000003', 'standard',
        'Pre-repricing account: unlimited inboxes grandfathered permanently (2026-08-19 inbox-based pricing)',
        'migration', true);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"93000000-0000-0000-0000-000000000003","role":"authenticated"}';

SELECT is((SELECT unlimited_inboxes FROM public.effective_workspace_plan('b1000000-0000-0000-0000-000000000010')), true,
  'a grandfathered owner resolves to unlimited inboxes');
SELECT is((SELECT plan || ':' || comped_scale FROM public.effective_workspace_plan('b1000000-0000-0000-0000-000000000010')), 'free:false',
  'the inbox grandfather does not silently promote the plan or the action ceiling');
RESET ROLE;

-- The whole reason the grant is keyed on user_id: a workspace created AFTER
-- the repricing, by a user who pre-dates it, is still covered. No trigger and
-- no per-workspace state are involved; effective_workspace_plan joins the
-- entitlement on workspaces.owner_id.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('b2000000-0000-0000-0000-000000000020', 'usage-gf-new', 'Usage Grandfathered New',
        '93000000-0000-0000-0000-000000000003', 'free');
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('b2000000-0000-0000-0000-000000000020', '93000000-0000-0000-0000-000000000003', 'owner');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"93000000-0000-0000-0000-000000000003","role":"authenticated"}';
SELECT is((SELECT unlimited_inboxes FROM public.effective_workspace_plan('b2000000-0000-0000-0000-000000000020')), true,
  'a workspace created after the repricing by a grandfathered user is still uncapped');
RESET ROLE;

-- A user with no entitlement row at all is the new-signup case, and must be
-- capped. LEFT JOIN + COALESCE, not NULL leaking through as "unknown".
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';
SELECT is((SELECT unlimited_inboxes FROM public.effective_workspace_plan('a1000000-0000-0000-0000-000000000010')), false,
  'a user with no entitlement is capped, and never reads NULL');
RESET ROLE;

-- The comped cohort keeps its Team projection AND gains the inbox grandfather;
-- the backfill used ON CONFLICT DO UPDATE for exactly this. The comped
-- entitlement here is already expired by the test above, which is also the
-- point: the inbox promise was permanent and is deliberately not expiry-gated,
-- so it outlives a comped grant that lapses.
UPDATE public.user_usage_entitlements SET unlimited_inboxes = true
WHERE user_id = '92000000-0000-0000-0000-000000000002';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"92000000-0000-0000-0000-000000000002","role":"authenticated"}';
SELECT is((SELECT plan || ':' || comped_scale || ':' || unlimited_inboxes FROM public.effective_workspace_plan('a4000000-0000-0000-0000-000000000040')),
  'free:false:true', 'an expired comped grant still keeps its permanent inbox grandfather');
RESET ROLE;

-- The audit trigger serialises with to_jsonb(NEW) and enumerates no columns, so
-- it must have picked the new field up with no change to the trigger.
SELECT is((SELECT (record ? 'unlimited_inboxes') FROM public.user_usage_entitlement_audit
           WHERE user_id = '93000000-0000-0000-0000-000000000003' AND operation = 'insert'), true,
  'the audit record carries the new entitlement column');
SELECT is((SELECT count(*) FROM public.user_usage_entitlement_audit
           WHERE user_id = '92000000-0000-0000-0000-000000000002' AND operation = 'update'), 2::bigint,
  'every entitlement update is audited, including the grandfather backfill');

SELECT throws_ok(
  $$INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version)
    VALUES ('a1000000-0000-0000-0000-000000000010', 'inbox_list', false, 1, 1)$$,
  '23514', NULL,
  'non-billable calls cannot be stored as actions'
);

SELECT * FROM finish();
ROLLBACK;

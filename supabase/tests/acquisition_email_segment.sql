-- ============================================================
-- Business-domain segment (20260929140000_acquisition_email_segment.sql)
-- ============================================================
-- Proves:
--   1. workspaces.acquisition_email_segment takes exactly the four words
--      emailSegment() can return (apps/web/src/lib/segment/consumer-domains.mjs),
--      and NULL, and nothing else. An address or a domain must never fit.
--   2. product_funnel_events accepts the new `multi_inbox_prompt` stage and
--      still refuses a stage nobody declared.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(9);

-- The real on_auth_user_created path creates the workspace.
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  'a8000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'owner@segment-test.invalid',
  'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'
);

SELECT ok(
  (SELECT acquisition_email_segment IS NULL FROM public.workspaces
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'),
  '[segment] a new workspace starts unclassified'
);

SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_email_segment = 'business'
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '[segment] business is accepted'
);
SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_email_segment = 'consumer'
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '[segment] consumer is accepted'
);
SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_email_segment = 'academic'
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '[segment] academic is accepted'
);
SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_email_segment = 'unknown'
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '[segment] unknown is accepted'
);

SELECT throws_ok(
  $$UPDATE public.workspaces SET acquisition_email_segment = 'segment-test.invalid'
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '23514',
  NULL,
  '[segment] a domain never fits in the column'
);

SELECT throws_ok(
  $$UPDATE public.workspaces SET acquisition_email_segment = 'Business'
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '23514',
  NULL,
  '[segment] the vocabulary is exact, including case'
);

SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'multi_inbox_prompt', 'started', 'free' FROM public.workspaces
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '[funnel] multi_inbox_prompt is a declared stage'
);

SELECT throws_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'second_inbox_nudge', 'started', 'free' FROM public.workspaces
     WHERE owner_id = 'a8000000-0000-0000-0000-000000000001'$$,
  '23514',
  NULL,
  '[funnel] an undeclared stage is still refused'
);

SELECT * FROM finish();
ROLLBACK;

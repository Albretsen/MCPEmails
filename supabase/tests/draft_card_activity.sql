-- ============================================================
-- Draft card activity (saves and sends made through the draft editor)
-- ============================================================
-- Covers migration 20261015220000_draft_card_activity:
--   - the column constraints that keep the table to ids and bookkeeping
--   - no column that could hold mail content
--   - the one-statement claim the edge function runs (UPDATE ... RETURNING),
--     scoped to the API key the editor call came in on
--   - service-role only: a browser session can neither read nor write it
--   - deleting the key, or the inbox, removes its rows
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('f1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cardact-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('fa000000-0000-0000-0000-00000000000a', 'cardact-a', 'Card activity A', 'f1000000-0000-0000-0000-000000000001', 'solo');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('fa000000-0000-0000-0000-00000000000a', 'f1000000-0000-0000-0000-000000000001', 'owner');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host)
VALUES
  ('f0000000-0000-0000-0000-0000000000a1', 'fa000000-0000-0000-0000-00000000000a', 'imap', 'a1@cardact-test.invalid', 'active', 'imap.cardact-test.invalid');

-- Key A: the connection whose card acted (Claude, say). Key B: another client
-- on the same workspace and inbox (ChatGPT, say).
INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES
  ('fb000000-0000-0000-0000-0000000000a1', 'fa000000-0000-0000-0000-00000000000a',
   'f1000000-0000-0000-0000-000000000001', 'Key A', 'mcpe_test', 'cardact-hash-a', '{manage:drafts}'),
  ('fb000000-0000-0000-0000-0000000000b1', 'fa000000-0000-0000-0000-00000000000a',
   'f1000000-0000-0000-0000-000000000001', 'Key B', 'mcpe_test', 'cardact-hash-b', '{manage:drafts}');

-- A save and a send on key A, as the edge function records them.
INSERT INTO public.draft_card_activity
  (workspace_id, inbox_id, api_key_id, draft_id, line_id, action, occurred_at, revision, fields, to_count, cc_count, bcc_count)
VALUES
  ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1', 'fb000000-0000-0000-0000-0000000000a1',
   'Drafts:7', 'f5000000-0000-0000-0000-000000000001', 'saved', now() - interval '2 minutes', 2, ARRAY['subject', 'to'], 2, 0, 0),
  ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1', 'fb000000-0000-0000-0000-0000000000a1',
   'Drafts:7', 'f5000000-0000-0000-0000-000000000001', 'sent', now() - interval '1 minute', 2, '{}', NULL, NULL, NULL);

-- ------------------------------------------------------------
-- 1. Constraints
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.draft_card_activity (workspace_id, inbox_id, api_key_id, draft_id, action, occurred_at)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'fb000000-0000-0000-0000-0000000000a1', 'Drafts:8', 'deleted', now())$$,
  '23514', NULL,
  'an action is saved or sent');

SELECT throws_ok(
  $$INSERT INTO public.draft_card_activity (workspace_id, inbox_id, api_key_id, draft_id, action, occurred_at, fields)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'fb000000-0000-0000-0000-0000000000a1', 'Drafts:8', 'saved', now(), ARRAY['Quarterly numbers'])$$,
  '23514', NULL,
  'fields holds field NAMES, never a value');

SELECT throws_ok(
  $$INSERT INTO public.draft_card_activity (workspace_id, inbox_id, api_key_id, draft_id, action, occurred_at)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'fb000000-0000-0000-0000-0000000000a1', repeat('x', 1025), 'saved', now())$$,
  '23514', NULL,
  'a draft id is an id, not a place to keep content');

SELECT throws_ok(
  $$INSERT INTO public.draft_card_activity (workspace_id, inbox_id, api_key_id, draft_id, action, occurred_at, to_count)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'fb000000-0000-0000-0000-0000000000a1', 'Drafts:8', 'saved', now(), -1)$$,
  '23514', NULL,
  'a count is a count');

SELECT throws_ok(
  $$INSERT INTO public.draft_card_activity (workspace_id, inbox_id, draft_id, action, occurred_at)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'Drafts:8', 'saved', now())$$,
  '23502', NULL,
  'every row names the key it came in on');

SELECT is(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'draft_card_activity'
      AND column_name ~ '(subject|sender|recipient|address|body|snippet|preview|message|hash|sha)'),
  0::bigint,
  'no column for a subject, recipient, body or a hash of one');

-- ------------------------------------------------------------
-- 2. The claim: per key, and one statement marks and returns
-- ------------------------------------------------------------
WITH claimed AS (
  UPDATE public.draft_card_activity SET reported_at = now()
   WHERE workspace_id = 'fa000000-0000-0000-0000-00000000000a'
     AND inbox_id = 'f0000000-0000-0000-0000-0000000000a1'
     AND api_key_id = 'fb000000-0000-0000-0000-0000000000b1'
     AND reported_at IS NULL
     AND occurred_at >= now() - interval '24 hours'
  RETURNING id)
SELECT is(count(*), 0::bigint, 'another key on the same inbox claims nothing') FROM claimed;

WITH claimed AS (
  UPDATE public.draft_card_activity SET reported_at = now()
   WHERE workspace_id = 'fa000000-0000-0000-0000-00000000000a'
     AND inbox_id = 'f0000000-0000-0000-0000-0000000000a1'
     AND api_key_id = 'fb000000-0000-0000-0000-0000000000a1'
     AND reported_at IS NULL
     AND occurred_at >= now() - interval '24 hours'
  RETURNING id)
SELECT is(count(*), 2::bigint, 'the key whose card acted claims both actions') FROM claimed;

WITH claimed AS (
  UPDATE public.draft_card_activity SET reported_at = now()
   WHERE workspace_id = 'fa000000-0000-0000-0000-00000000000a'
     AND inbox_id = 'f0000000-0000-0000-0000-0000000000a1'
     AND api_key_id = 'fb000000-0000-0000-0000-0000000000a1'
     AND reported_at IS NULL
  RETURNING id)
SELECT is(count(*), 0::bigint, 'a second claim returns none: each action is told once') FROM claimed;

-- ------------------------------------------------------------
-- 3. Service-role only
-- ------------------------------------------------------------
SELECT is(
  (SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.draft_card_activity'::regclass),
  true,
  'RLS is enabled');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';
SELECT throws_ok(
  $$SELECT count(*) FROM public.draft_card_activity$$,
  '42501', NULL,
  'a browser session cannot read card activity, even for its own workspace');
SELECT throws_ok(
  $$INSERT INTO public.draft_card_activity (workspace_id, inbox_id, api_key_id, draft_id, action, occurred_at)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'fb000000-0000-0000-0000-0000000000a1', 'Drafts:9', 'saved', now())$$,
  '42501', NULL,
  'or write it');
RESET ROLE;

-- ------------------------------------------------------------
-- 4. Lifetime
-- ------------------------------------------------------------
DELETE FROM public.api_keys WHERE id = 'fb000000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*) FROM public.draft_card_activity WHERE api_key_id = 'fb000000-0000-0000-0000-0000000000a1'),
  0::bigint,
  'deleting the key removes its card activity');

INSERT INTO public.draft_card_activity (workspace_id, inbox_id, api_key_id, draft_id, action, occurred_at)
VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
        'fb000000-0000-0000-0000-0000000000b1', 'Drafts:10', 'saved', now());
DELETE FROM public.inboxes WHERE id = 'f0000000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*) FROM public.draft_card_activity WHERE inbox_id = 'f0000000-0000-0000-0000-0000000000a1'),
  0::bigint,
  'deleting the inbox removes its card activity');

SELECT * FROM finish();
ROLLBACK;

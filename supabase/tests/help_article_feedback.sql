-- ============================================================
-- Help article feedback and support retention
-- ============================================================
-- Covers migration 20261029200000_help_article_feedback:
--   - service-role only: RLS on, anon and authenticated hold no privileges
--   - one vote per (article_id, voter_key)
--   - deleting the user deletes their votes (ON DELETE CASCADE)
-- and migration 20261030210000_support_retention:
--   - purge_support_history() deletes IP-keyed votes after 180 days, keeps
--     signed-in votes and recent IP votes
--   - it scrubs signed-out tickets after 730 days, keeps recent ones and
--     tickets linked to an account
--   - purge_operational_history() calls it and reports its counts
--   - neither anon nor authenticated can run it
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(24);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('f3000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feedback-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('f3000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feedback-bob@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

-- Votes:
--   v01 alice, signed in, 200 days old  -> kept (only IP votes expire)
--   v02 bob, signed in                  -> deleted with bob
--   v03 IP vote, last cast 200 days ago -> deleted
--   v04 IP vote, created 200 days ago, re-cast 10 days ago -> kept
--   v05 IP vote, 10 days old            -> kept
INSERT INTO public.help_article_feedback (id, article_id, locale, helpful, voter_key, user_id, created_at, updated_at) VALUES
  ('f3f00000-0000-0000-0000-000000000001', 'imap-password-rejected', 'en', true,
   'u:f3000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001',
   now() - interval '200 days', now() - interval '200 days'),
  ('f3f00000-0000-0000-0000-000000000002', 'imap-password-rejected', 'nb', false,
   'u:f3000000-0000-0000-0000-000000000002', 'f3000000-0000-0000-0000-000000000002', now(), now()),
  ('f3f00000-0000-0000-0000-000000000003', 'imap-password-rejected', 'en', false,
   'ip:old-hash', NULL, now() - interval '200 days', now() - interval '200 days'),
  ('f3f00000-0000-0000-0000-000000000004', 'imap-password-rejected', 'fr', true,
   'ip:recast-hash', NULL, now() - interval '200 days', now() - interval '10 days'),
  ('f3f00000-0000-0000-0000-000000000005', 'imap-password-rejected', 'es', true,
   'ip:new-hash', NULL, now() - interval '10 days', now() - interval '10 days');

-- Tickets:
--   t01 signed out, 800 days old        -> scrubbed
--   t02 signed out, 100 days old        -> kept
--   t03 alice, signed in, 800 days old  -> kept (an account is behind it)
INSERT INTO public.support_tickets (id, user_id, email, category, subject, message, context, source, ip_hash, created_at) VALUES
  ('f3d00000-0000-0000-0000-000000000001', NULL, 'old-visitor@rls-test.invalid', 'other',
   'Old question', 'Hello from long ago.', '{"provider":"imap"}', 'form_signed_out', 'hash-1', now() - interval '800 days'),
  ('f3d00000-0000-0000-0000-000000000002', NULL, 'new-visitor@rls-test.invalid', 'other',
   'New question', 'Hello.', '{}', 'form_signed_out', 'hash-2', now() - interval '100 days'),
  ('f3d00000-0000-0000-0000-000000000003', 'f3000000-0000-0000-0000-000000000001', 'feedback-alice@rls-test.invalid', 'connect',
   'Cannot connect', 'It says the password is wrong.', '{}', 'form_signed_in', 'hash-3', now() - interval '800 days');

-- ------------------------------------------------------------
-- 1. Service-role only
-- ------------------------------------------------------------
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.help_article_feedback'::regclass),
  'RLS is enabled');

SELECT is(
  (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'help_article_feedback'),
  0,
  'no policies: only the service role reads or writes votes');

SELECT ok(
  NOT has_table_privilege('anon', 'public.help_article_feedback', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
  'anon holds no privilege on the table');

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.help_article_feedback', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
  'authenticated holds no privilege on the table');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"f3000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT throws_ok(
  $$SELECT count(*) FROM public.help_article_feedback$$,
  '42501', NULL,
  'a signed-in user cannot read votes, not even their own');

SELECT throws_ok(
  $$INSERT INTO public.help_article_feedback (article_id, locale, helpful, voter_key, user_id)
    VALUES ('imap-password-rejected', 'en', true, 'u:f3000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001')$$,
  '42501', NULL,
  'a signed-in user cannot write a vote directly');

SELECT throws_ok(
  $$SELECT public.purge_support_history()$$,
  '42501', NULL,
  'a signed-in user cannot run the support purge');

RESET ROLE;
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$SELECT count(*) FROM public.help_article_feedback$$,
  '42501', NULL,
  'anon cannot read votes');

SELECT throws_ok(
  $$INSERT INTO public.help_article_feedback (article_id, locale, helpful, voter_key)
    VALUES ('imap-password-rejected', 'en', true, 'ip:anon-hash')$$,
  '42501', NULL,
  'anon cannot write a vote directly');

RESET ROLE;

SELECT ok(
  NOT has_function_privilege('anon', 'public.purge_support_history()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.purge_support_history()', 'EXECUTE'),
  'purge_support_history is not executable by anon or authenticated');

-- ------------------------------------------------------------
-- 2. One vote per voter per article
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.help_article_feedback (article_id, locale, helpful, voter_key)
    VALUES ('imap-password-rejected', 'en', true, 'ip:new-hash')$$,
  '23505', NULL,
  'a second vote by the same voter on the same article conflicts');

SELECT lives_ok(
  $$INSERT INTO public.help_article_feedback (article_id, locale, helpful, voter_key)
    VALUES ('another-article', 'en', true, 'ip:new-hash')$$,
  'the same voter can vote on another article');

INSERT INTO public.help_article_feedback (article_id, locale, helpful, voter_key, updated_at)
VALUES ('imap-password-rejected', 'de', false, 'ip:new-hash', now())
ON CONFLICT (article_id, voter_key) DO UPDATE
  SET helpful = excluded.helpful, locale = excluded.locale, updated_at = excluded.updated_at;

SELECT is(
  (SELECT format('%s/%s/%s', count(*), bool_and(NOT helpful), max(locale))
     FROM public.help_article_feedback
    WHERE article_id = 'imap-password-rejected' AND voter_key = 'ip:new-hash'),
  '1/t/de',
  'voting again (the route''s upsert) replaces the answer instead of adding a row');

-- ------------------------------------------------------------
-- 3. Deleting the user deletes their votes
-- ------------------------------------------------------------
DELETE FROM auth.users WHERE id = 'f3000000-0000-0000-0000-000000000002';

SELECT is(
  (SELECT count(*)::int FROM public.help_article_feedback WHERE id = 'f3f00000-0000-0000-0000-000000000002'),
  0,
  'deleting the user deletes their vote');

SELECT is(
  (SELECT count(*)::int FROM public.help_article_feedback WHERE id = 'f3f00000-0000-0000-0000-000000000001'),
  1,
  'other users'' votes are kept');

-- ------------------------------------------------------------
-- 4. purge_support_history, through purge_operational_history
-- ------------------------------------------------------------
CREATE TEMP TABLE purge_result AS SELECT public.purge_operational_history() AS r;

SELECT is(
  (SELECT count(*)::int FROM public.help_article_feedback WHERE id = 'f3f00000-0000-0000-0000-000000000003'),
  0,
  'an IP vote last cast over 180 days ago is deleted');

SELECT is(
  (SELECT count(*)::int FROM public.help_article_feedback
    WHERE id IN ('f3f00000-0000-0000-0000-000000000004', 'f3f00000-0000-0000-0000-000000000005')),
  2,
  'IP votes cast in the last 180 days are kept, by last vote not first');

SELECT is(
  (SELECT count(*)::int FROM public.help_article_feedback WHERE id = 'f3f00000-0000-0000-0000-000000000001'),
  1,
  'an old signed-in vote is kept');

SELECT is(
  (SELECT format('%s|%s|%s|%s|%s|%s', email, subject, message, context::text, coalesce(ip_hash, 'null'), category)
     FROM public.support_tickets WHERE id = 'f3d00000-0000-0000-0000-000000000001'),
  'deleted@invalid|[deleted]|[deleted]|{}|null|other',
  'a signed-out ticket over 730 days old is scrubbed like a deleted account''s, category kept');

SELECT is(
  (SELECT email FROM public.support_tickets WHERE id = 'f3d00000-0000-0000-0000-000000000002'),
  'new-visitor@rls-test.invalid',
  'a recent signed-out ticket is kept');

SELECT is(
  (SELECT email || '|' || ip_hash FROM public.support_tickets WHERE id = 'f3d00000-0000-0000-0000-000000000003'),
  'feedback-alice@rls-test.invalid|hash-3',
  'an old ticket with an account behind it is kept');

SELECT ok(
  (SELECT (r->>'help_article_feedback_ip_votes_deleted')::int >= 1
      AND (r->>'support_tickets_no_account_scrubbed')::int >= 1
      AND r ? 'auth_logs_scrubbed'
      AND r ? 'scheduled_sends_cleared'
     FROM purge_result),
  'purge_operational_history reports the support counts next to its own');

SELECT is(
  (SELECT public.purge_support_history()),
  '{"help_article_feedback_ip_votes_deleted": 0, "support_tickets_no_account_scrubbed": 0}'::jsonb,
  'a second run finds nothing left to do');

SELECT throws_ok(
  $$INSERT INTO public.help_article_feedback (article_id, locale, helpful, voter_key)
    VALUES ('Not An Id', 'en', true, 'ip:x-hash')$$,
  '23514', NULL,
  'article ids are slugs, so the table holds a bounded vocabulary');

SELECT * FROM finish();

ROLLBACK;

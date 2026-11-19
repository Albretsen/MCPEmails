-- ============================================================
-- Attachment upload slots: service role only
-- ============================================================
-- Covers migration 20261119120000_attachment_uploads:
--   - the table has RLS on and no policies, and anon/authenticated hold no
--     table privileges, so a browser session reads and writes nothing;
--   - a workspace member cannot see their own workspace's slots either;
--   - the bucket is private with the 10 MB limit;
--   - the purge function is not callable from a browser session and removes
--     only rows expired more than a day ago.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(10);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a7000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'upload-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('a7a00000-0000-0000-0000-00000000000a', 'upload-a', 'Upload A', 'a7000000-0000-0000-0000-000000000001', 'free');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('a7a00000-0000-0000-0000-00000000000a', 'a7000000-0000-0000-0000-000000000001', 'owner');

INSERT INTO public.attachment_uploads (id, workspace_id, filename, mime_type, storage_path, expires_at)
VALUES
  ('a7b00000-0000-0000-0000-000000000001', 'a7a00000-0000-0000-0000-00000000000a', 'live.pdf', 'application/pdf',
   'a7a00000-0000-0000-0000-00000000000a/a7b00000-0000-0000-0000-000000000001', now() + interval '1 hour'),
  ('a7b00000-0000-0000-0000-000000000002', 'a7a00000-0000-0000-0000-00000000000a', 'old.pdf', 'application/pdf',
   'a7a00000-0000-0000-0000-00000000000a/a7b00000-0000-0000-0000-000000000002', now() - interval '2 days');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.attachment_uploads'::regclass),
  'RLS is on'
);
SELECT is(
  (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'attachment_uploads'),
  0,
  'no policies: service role only'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.attachment_uploads', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.attachment_uploads', 'SELECT'),
  'anon and authenticated cannot select'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.attachment_uploads', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.attachment_uploads', 'INSERT'),
  'anon and authenticated cannot insert'
);
SELECT is(
  (SELECT public FROM storage.buckets WHERE id = 'attachment-uploads'),
  false,
  'the bucket is private'
);
SELECT is(
  (SELECT file_size_limit::bigint FROM storage.buckets WHERE id = 'attachment-uploads'),
  10485760::bigint,
  'the bucket holds at most 10 MB per object'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.purge_attachment_upload_rows()', 'EXECUTE'),
  'a browser session cannot run the purge'
);

-- The owner of the workspace, signed in, still sees nothing.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a7000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT throws_ok(
  'SELECT count(*) FROM public.attachment_uploads',
  '42501',
  NULL,
  'a member reading the table is refused'
);
RESET ROLE;

SELECT is(public.purge_attachment_upload_rows(), 1, 'the purge removes the row expired two days ago');
SELECT is(
  (SELECT array_agg(filename) FROM public.attachment_uploads WHERE workspace_id = 'a7a00000-0000-0000-0000-00000000000a'),
  ARRAY['live.pdf'],
  'and keeps the live one'
);

SELECT * FROM finish();
ROLLBACK;

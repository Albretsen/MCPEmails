-- ============================================================
-- api_keys: no side door for a browser session (verifier, u03)
-- ============================================================
-- 20261016160300 took every write privilege on api_keys away from anon and
-- authenticated. These checks guard the ways around a table grant:
--   - a function a browser session may EXECUTE that writes api_keys (a
--     SECURITY DEFINER one would bypass the revoked grant entirely);
--   - a privilege held through PUBLIC or a role anon/authenticated belong to;
--   - every column, not only the ones the original abuses used.
-- ============================================================

BEGIN;

SELECT plan(5);

-- 1. No function in public that writes api_keys is executable by a browser
--    role. revoke_dormant_oauth_grants() is the only such function and it is
--    service-role only.
SELECT is_empty(
  $$
    SELECT p.oid::regprocedure::text
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
      AND  p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?api_keys\M'
      AND  (has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE'))
  $$,
  'no function that writes api_keys is executable by anon or authenticated'
);

-- 2. No write privilege on ANY column for either browser role, through any
--    route (direct grant, PUBLIC, or role membership).
SELECT is_empty(
  $$
    SELECT r.rolname || ':' || a.attname || ':' || priv
    FROM   pg_attribute a
    CROSS  JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    CROSS  JOIN (VALUES ('INSERT'), ('UPDATE')) AS p(priv)
    WHERE  a.attrelid = 'public.api_keys'::regclass
      AND  a.attnum > 0 AND NOT a.attisdropped
      AND  has_column_privilege(r.rolname, 'public.api_keys', a.attname, priv)
  $$,
  'neither browser role can INSERT or UPDATE any api_keys column'
);

-- 3. The columns the server writes on its own (last_used_at, the card-listing
--    mark) are not writable from a session either: not even the owner,
--    on their OWN key.
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  'a0399999-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'u03-verify@rls-test.invalid', 'x', now(),
  now(), now(), '{"provider":"email"}', '{}'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('a0399999-0000-0000-0000-0000000000a1', 'u03-verify-ws', 'u03 verify',
        'a0399999-0000-0000-0000-000000000001', 'pro')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('a0399999-0000-0000-0000-0000000000a1', 'a0399999-0000-0000-0000-000000000001', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES ('a0399999-0000-0000-0000-0000000000b1', 'a0399999-0000-0000-0000-0000000000a1',
        'a0399999-0000-0000-0000-000000000001', 'Verify key', 'mcpe_vfy', 'u03-verify-hash',
        ARRAY['read:email']);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a0399999-0000-0000-0000-000000000001","role":"authenticated"}', true);

SELECT throws_ok(
  $$UPDATE public.api_keys SET last_used_at = now() WHERE id = 'a0399999-0000-0000-0000-0000000000b1'$$,
  '42501', NULL,
  'a session cannot touch last_used_at even on its own key');

SELECT throws_ok(
  $$DELETE FROM public.api_keys WHERE id = 'a0399999-0000-0000-0000-0000000000b1'$$,
  '42501', NULL,
  'a session cannot hard-delete its own key');

-- 4. Reading its own workspace's keys still works for the same session.
SELECT is(
  (SELECT count(*)::int FROM public.api_keys WHERE workspace_id = 'a0399999-0000-0000-0000-0000000000a1'),
  1,
  'the owner session still lists its workspace keys');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;

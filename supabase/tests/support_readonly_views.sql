-- ============================================================
-- support_readonly views expose no secrets (20261125120000)
-- ============================================================
-- Proves:
--   - no support_readonly column is named like a token, secret, password,
--     hash, cipher, payload, lease, nonce, verifier, session, stack, body,
--     IP address or user agent;
--   - no column is named like a key except api_key_id and key_prefix;
--   - anon, authenticated and PUBLIC have no usage on the schema;
--   - the support_readonly role can select the views but no public table;
--   - the role's statement timeout is 5 s.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(9);

SELECT is_empty(
  $$ SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'support_readonly'
        AND column_name ~* '(token|secret|password|passw|oauth|hash|cipher|payload|lease|nonce|verifier|session|stack|body|ip_address|user_agent)' $$,
  'no support_readonly column is named like a secret, token, hash or body'
);

SELECT is_empty(
  $$ SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'support_readonly'
        AND column_name ~* 'key'
        AND column_name NOT IN ('api_key_id', 'key_prefix') $$,
  'no support_readonly column is named like a key value'
);

SELECT ok(
  (SELECT count(*) FROM information_schema.views WHERE table_schema = 'support_readonly') >= 7,
  'the support_readonly views exist'
);

SELECT ok(
  NOT has_schema_privilege('anon', 'support_readonly', 'usage'),
  'anon has no usage on support_readonly'
);
SELECT ok(
  NOT has_schema_privilege('authenticated', 'support_readonly', 'usage'),
  'authenticated has no usage on support_readonly'
);
SELECT ok(
  NOT has_schema_privilege('public', 'support_readonly', 'usage'),
  'PUBLIC has no usage on support_readonly'
);

SELECT is_empty(
  $$ SELECT c.relname FROM pg_class c
      WHERE c.relnamespace = 'support_readonly'::regnamespace AND c.relkind = 'v'
        AND NOT has_table_privilege('support_readonly', c.oid, 'select') $$,
  'support_readonly can select every view in its schema'
);

SELECT is_empty(
  $$ SELECT c.relname FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege('support_readonly', c.oid, 'select') $$,
  'support_readonly cannot select any public relation'
);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_roles
           WHERE rolname = 'support_readonly'
             AND 'statement_timeout=5s' = ANY (rolconfig)),
  'support_readonly has a 5 s statement timeout'
);

SELECT * FROM finish();
ROLLBACK;

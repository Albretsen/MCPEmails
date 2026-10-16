-- ============================================================
-- API roles hold no TRUNCATE / REFERENCES / TRIGGER (20261016160700)
-- ============================================================
-- Proves:
--   - no public table, view, materialized view or foreign table grants
--     TRUNCATE, REFERENCES or TRIGGER to anon or authenticated (directly or
--     through PUBLIC);
--   - a table created after the migration by postgres (the migration role)
--     does not regain them, while it still gets the ordinary default grants;
--   - service_role still holds TRUNCATE (and REFERENCES, TRIGGER) on every
--     public table;
--   - on PG17+, the same holds for MAINTAIN (skipped on older servers, where
--     the privilege does not exist);
--   - the data privileges other migrations manage are untouched (spot checks).
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(17);

-- ------------------------------------------------------------
-- 1. Catalog sweep over every existing public relation
-- ------------------------------------------------------------
CREATE TEMP VIEW _api_role_extra_privs AS
SELECT c.oid::regclass::text AS rel, r.role, p.priv
FROM pg_class c
CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND has_table_privilege(r.role, c.oid, p.priv);

SELECT is_empty(
  $$ SELECT rel, role, priv FROM _api_role_extra_privs WHERE priv = 'TRUNCATE' $$,
  'no public relation grants TRUNCATE to anon or authenticated'
);
SELECT is_empty(
  $$ SELECT rel, role, priv FROM _api_role_extra_privs WHERE priv = 'REFERENCES' $$,
  'no public relation grants REFERENCES to anon or authenticated'
);
SELECT is_empty(
  $$ SELECT rel, role, priv FROM _api_role_extra_privs WHERE priv = 'TRIGGER' $$,
  'no public relation grants TRIGGER to anon or authenticated'
);

SELECT ok(
  (SELECT count(*) FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')) > 50,
  'the sweep covers the real schema (sanity: >50 public tables)'
);

-- MAINTAIN only exists on PG17+. The probe query is passed as text so it is
-- never parsed on older servers; there the assertion is skipped.
SELECT CASE WHEN current_setting('server_version_num')::int >= 170000 THEN
  is_empty(
    $q$ SELECT c.oid::regclass::text, r.role FROM pg_class c
         CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(r.role, c.oid, 'MAINTAIN') $q$,
    'no public relation grants MAINTAIN to anon or authenticated')
ELSE skip('MAINTAIN does not exist before PG17', 1) END;

SELECT CASE WHEN current_setting('server_version_num')::int >= 170000 THEN
  is_empty(
    $q$ SELECT c.oid::regclass::text FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind IN ('r', 'p')
          AND NOT has_table_privilege('service_role', c.oid, 'MAINTAIN') $q$,
    'service_role still holds MAINTAIN on every public table')
ELSE skip('MAINTAIN does not exist before PG17', 1) END;

-- ------------------------------------------------------------
-- 2. service_role keeps its privileges everywhere
-- ------------------------------------------------------------
SELECT is_empty(
  $$ SELECT c.oid::regclass::text FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT has_table_privilege('service_role', c.oid, 'TRUNCATE') $$,
  'service_role still holds TRUNCATE on every public table'
);
SELECT is_empty(
  $$ SELECT c.oid::regclass::text FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p')
        AND NOT (has_table_privilege('service_role', c.oid, 'REFERENCES')
             AND has_table_privilege('service_role', c.oid, 'TRIGGER')) $$,
  'service_role still holds REFERENCES and TRIGGER on every public table'
);

-- ------------------------------------------------------------
-- 3. Data privileges managed elsewhere are untouched (spot checks)
-- ------------------------------------------------------------
SELECT ok(has_table_privilege('authenticated', 'public.workspaces', 'SELECT'),
  'authenticated still SELECTs workspaces');
SELECT ok(has_table_privilege('authenticated', 'public.api_keys', 'SELECT'),
  'authenticated still SELECTs api_keys');

-- ------------------------------------------------------------
-- 4. A table created now by the migration role does not regain them
-- ------------------------------------------------------------
SELECT is(current_user::text, 'postgres', 'tests run as the migration role');

CREATE TABLE public._u_no_truncate_probe (id int PRIMARY KEY);

SELECT ok(NOT has_table_privilege('anon', 'public._u_no_truncate_probe', 'TRUNCATE')
      AND NOT has_table_privilege('authenticated', 'public._u_no_truncate_probe', 'TRUNCATE'),
  'new table: no TRUNCATE for anon/authenticated');
SELECT ok(NOT has_table_privilege('anon', 'public._u_no_truncate_probe', 'REFERENCES')
      AND NOT has_table_privilege('authenticated', 'public._u_no_truncate_probe', 'REFERENCES'),
  'new table: no REFERENCES for anon/authenticated');
SELECT ok(NOT has_table_privilege('anon', 'public._u_no_truncate_probe', 'TRIGGER')
      AND NOT has_table_privilege('authenticated', 'public._u_no_truncate_probe', 'TRIGGER'),
  'new table: no TRIGGER for anon/authenticated');
SELECT CASE WHEN current_setting('server_version_num')::int >= 170000 THEN
  is_empty(
    $q$ SELECT r.role FROM (VALUES ('anon'), ('authenticated')) AS r(role)
        WHERE has_table_privilege(r.role, 'public._u_no_truncate_probe', 'MAINTAIN') $q$,
    'new table: no MAINTAIN for anon/authenticated')
ELSE skip('MAINTAIN does not exist before PG17', 1) END;
SELECT ok(has_table_privilege('service_role', 'public._u_no_truncate_probe', 'TRUNCATE'),
  'new table: service_role still gets TRUNCATE by default');
SELECT ok(has_table_privilege('authenticated', 'public._u_no_truncate_probe', 'SELECT'),
  'new table: the ordinary SELECT default grant is unchanged');

SELECT * FROM finish();
ROLLBACK;

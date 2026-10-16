-- ============================================================
-- API roles hold no TRUNCATE, REFERENCES or TRIGGER on public tables
-- ============================================================
-- Supabase's default privileges grant anon and authenticated every table
-- privilege on new public tables, including three that no browser session
-- needs:
--   - TRUNCATE empties a table and is NOT subject to row level security;
--   - REFERENCES lets a role create a foreign key pointing at the table;
--   - TRIGGER lets a role create triggers on the table.
-- None of them is reachable through PostgREST today, but any future
-- user-callable SQL path (a SECURITY INVOKER function running dynamic SQL, a
-- new extension, a direct-connection role) would turn TRUNCATE into a
-- one-statement wipe of every tenant's data. Nothing in apps/ or
-- supabase/functions/ uses these privileges through a user-scoped client.
--
-- SELECT / INSERT / UPDATE / DELETE are deliberately left alone: other
-- migrations grant and revoke those per table. service_role is untouched.
--
-- Idempotent: REVOKE of a privilege that is not held is a no-op, and so is
-- ALTER DEFAULT PRIVILEGES ... REVOKE.
-- ============================================================

-- 1. Existing tables, views, materialized views and foreign tables.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated, PUBLIC;

-- 2. Future tables created by postgres (the role every migration runs as,
--    locally through the CLI and in production by hand).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;

-- 3. Future tables created by supabase_admin (platform-managed objects). The
--    platform also holds a default-privilege entry for this role in public,
--    but postgres is not a member of supabase_admin on hosted projects, so
--    this only runs where the executing role may act for it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
     AND pg_has_role(current_user, 'supabase_admin', 'USAGE') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public '
         || 'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated';
  ELSE
    RAISE NOTICE 'skipping supabase_admin default privileges: % cannot act for supabase_admin', current_user;
  END IF;
END
$$;

-- 4. PG17's MAINTAIN privilege (VACUUM FULL, CLUSTER, REINDEX, REFRESH
--    MATERIALIZED VIEW, LOCK TABLE: heavy locks, a denial-of-service lever).
--    MAINTAIN is a syntax error before PG17 (config.toml still says
--    major_version = 15), so it is guarded by server version. service_role is
--    untouched here too.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated, PUBLIC';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
         || 'REVOKE MAINTAIN ON TABLES FROM anon, authenticated';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
       AND pg_has_role(current_user, 'supabase_admin', 'USAGE') THEN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public '
           || 'REVOKE MAINTAIN ON TABLES FROM anon, authenticated';
    END IF;
  ELSE
    RAISE NOTICE 'skipping MAINTAIN revoke: server version % predates PG17', current_setting('server_version');
  END IF;
END
$$;

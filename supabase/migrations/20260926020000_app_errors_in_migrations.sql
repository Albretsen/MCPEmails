-- =============================================================================
-- public.app_errors, finally declared in a migration.
--
-- The table has existed in production since before 2026-06-03 (harden_grants
-- already revokes on it, behind a to_regclass guard), but no migration ever
-- created it. Found 2026-09-26 when CI started type-checking the app against
-- types generated from the migrations alone: src/lib/errors/capture.ts writes
-- here, and on any database built from this repo (a self-host, `supabase start`,
-- the CI job) the table did not exist, so every captured error was dropped.
--
-- Copied from production's live definition on 2026-09-26. Every statement is
-- idempotent, so on production this migration changes nothing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.app_errors (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  severity    text        NOT NULL DEFAULT 'medium',
  message     text        NOT NULL,
  stack       text,
  context     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  CONSTRAINT app_errors_pkey PRIMARY KEY (id),
  CONSTRAINT app_errors_severity_check CHECK (severity = ANY (ARRAY['low', 'medium', 'high', 'critical']))
);

CREATE INDEX IF NOT EXISTS app_errors_unresolved_idx
  ON public.app_errors (created_at DESC)
  WHERE resolved_at IS NULL;

-- Written and read by service_role only: RLS on with zero policies, and no
-- table privileges for anon/authenticated (same as harden_grants LOW-2).
ALTER TABLE public.app_errors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_errors FROM anon, authenticated;

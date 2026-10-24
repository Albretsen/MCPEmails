-- ===========================================================================
-- First 30 days: the dry-run-to-live switch and the dry-run evidence log.
-- 20261025040000_first30_auto_go_live
--
-- The dispatcher from 20261024170000_first_30_days.sql runs in dry run. On
-- the first run at or after auto_go_live_at it reads the evidence logged here,
-- checks the written criteria (apps/web/src/lib/retention/first-30-days-go-live.ts)
-- and either switches itself live or holds in dry run and alerts. It decides
-- once: the decision is written with `WHERE decision IS NULL`, so two
-- overlapping runs cannot both decide, and a decided row is never decided
-- again automatically.
--
--   1. retention_switches: one row per switch. mode is what the dispatcher
--      runs in when no env override is set. Seeded 'first30' in dry run, with
--      the automatic decision at 2026-10-28 09:00 UTC.
--   2. first30_dry_run_log: one row per candidate decision in a dry run, one
--      'run_summary' row per dry run (empty runs too) and one 'mailbox_probe'
--      row per daily probe of the internal draft mailbox. No email addresses
--      and no message text. The dispatcher deletes rows older than 60 days.
--
-- Both are server-owned: RLS on, no policies, no grants to anon or
-- authenticated. mcp-server never reads either, so the self-host schema does
-- not carry them.
--
-- Retry after a 'held' decision (also shown on /admin/growth/first-30-days):
--   UPDATE public.retention_switches
--      SET decision = NULL, decided_at = NULL, decision_detail = NULL,
--          auto_go_live_at = '2026-11-01T09:00:00Z', updated_at = now()
--    WHERE key = 'first30';
--
-- Forward-only, every step safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.retention_switches (
  key              text PRIMARY KEY,
  mode             text NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'live')),
  auto_go_live_at  timestamptz,
  decided_at       timestamptz,
  decision         text CHECK (decision IS NULL OR decision IN ('went_live', 'held')),
  decision_detail  jsonb,
  -- Claimed (set) BEFORE each daily mailbox probe, so the probe runs at most
  -- once per UTC day even when the log insert fails.
  last_probe_at    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.retention_switches ADD COLUMN IF NOT EXISTS last_probe_at timestamptz;

ALTER TABLE public.retention_switches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.retention_switches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.retention_switches TO service_role;

COMMENT ON TABLE public.retention_switches IS
  'Runtime mode of the retention dispatchers. Env FIRST30_DRY_RUN overrides '
  'mode when set. The automatic decision is written once (WHERE decision IS NULL).';

INSERT INTO public.retention_switches (key, mode, auto_go_live_at)
VALUES ('first30', 'dry_run', '2026-10-28T09:00:00Z')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.first30_dry_run_log (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at                  timestamptz NOT NULL DEFAULT now(),
  run_id                  uuid NOT NULL,
  workspace_id            uuid,
  template                text,
  decision                text NOT NULL CHECK (decision IN (
                            'would_draft', 'would_send', 'would_holdout',
                            'wait', 'done', 'stop',
                            'run_summary', 'mailbox_probe')),
  reason                  text,
  recipient_matches_owner boolean,
  owner_internal          boolean,
  subscription_active     boolean,
  first_paid_at           timestamptz,
  error                   text,
  detail                  jsonb
);

CREATE INDEX IF NOT EXISTS first30_dry_run_log_run_at_idx
  ON public.first30_dry_run_log (run_at);
CREATE INDEX IF NOT EXISTS first30_dry_run_log_decision_run_at_idx
  ON public.first30_dry_run_log (decision, run_at);

ALTER TABLE public.first30_dry_run_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.first30_dry_run_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.first30_dry_run_log TO service_role;

COMMENT ON TABLE public.first30_dry_run_log IS
  'First-30-days dry-run evidence: per-candidate decisions, one run_summary per '
  'run, daily mailbox_probe rows. No email addresses. Rows older than 60 days '
  'are deleted by the dispatcher.';

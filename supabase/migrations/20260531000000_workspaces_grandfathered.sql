-- Grandfathering: tag every workspace that existed under the launch-era
-- "unlimited usage" pricing so that, when paid-plan usage caps are introduced
-- later (by giving the usage-limit fields finite values in src/lib/stripe/plans.ts),
-- these workspaces keep unlimited usage regardless of their plan's new caps.
--
-- New workspaces created after this migration default to `false`, i.e. they
-- are subject to whatever caps exist when they sign up.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS grandfathered boolean NOT NULL DEFAULT false;

-- Backfill: every workspace that exists at migration time is a launch-era
-- account and keeps the current unlimited terms.
UPDATE public.workspaces SET grandfathered = true;

COMMENT ON COLUMN public.workspaces.grandfathered IS
  'True for launch-era workspaces that retain unlimited usage when future paid-plan caps are introduced. New signups default false. Resolved in code via resolvePlanLimits().';

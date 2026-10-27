-- ===========================================================================
-- The day each milestone rung was first seen reached.
-- 20261027170000_growth_milestone_unlocks
--
-- /admin/growth dates a rung from its own series, then from the hand-kept
-- record in apps/web/src/lib/analytics/growth-milestone-record.ts. Rungs read
-- from a snapshot (Stripe MRR, paying customers, lifecycle counts) have neither,
-- so every new one sat under "Reached, day unknown" until someone reran the
-- queries by hand. This table is the third source: the board writes a rung's
-- id and the current UTC day the first time it sees the rung reached and
-- undated. The board refreshes every few minutes, so the day is the crossing
-- day or, at worst, a little after it, never before.
--
-- Service role only: no policy, so anon and authenticated read nothing.
-- Forward-only, re-runnable. Apply with `db query --linked -f` and
-- `migration repair` (never db push).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.growth_milestone_unlocks (
  id          text PRIMARY KEY,
  day         date NOT NULL,
  note        text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.growth_milestone_unlocks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.growth_milestone_unlocks FROM anon, authenticated;

COMMENT ON TABLE public.growth_milestone_unlocks IS
  'First day /admin/growth saw each undated milestone rung reached. Written by the board, read by the board.';

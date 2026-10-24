-- ============================================================================
-- Inbox parking: inboxes above a lower plan's inbox cap are parked, not lost.
-- 20261024173000_inbox_parking
-- ============================================================================
--
-- WHY. The inbox cap is enforced only at connect time
-- (apps/web/src/lib/plans/check-inbox-limit.ts). When a plan drops (a pause,
-- a downgrade at period end, later maybe a cancel to Free) nothing revalidates
-- the inboxes already connected, so a workspace keeps every mailbox reachable
-- on a plan that includes fewer. Parking is the mechanism the pause and
-- downgrade work calls at the moment the plan actually drops
-- (Documents/plans/pause-downgrade-20261024.md, section 2.4).
--
-- WHAT PARKED MEANS. Credentials kept, nothing deleted, not reachable by any
-- MCP tool, not polled by automations, shown greyed on the Inboxes page, and
-- unparked automatically on upgrade or resume (apps/web/src/lib/billing/
-- parking.ts). This file adds the columns only. Nothing here parks a row, and
-- every existing row gets parked_at = NULL, which is today's behaviour.
--
-- WHAT.
--   1. inboxes.parked_at (timestamptz, NULL = active) and inboxes.parked_reason
--      (text, 'plan_limit' is the only reason). The CHECK keeps the pair
--      consistent: both NULL, or both set with a known reason.
--   2. authenticated may SELECT the two columns (the dashboard's inbox list
--      reads them through the user client). Column grants do not extend to new
--      columns (20261016160200), and supabase/tests/inboxes_user_access.sql
--      fails on any column that is neither granted nor secret. There is still
--      NO user write grant on inboxes: only service-role server code can park
--      or unpark, so a member cannot unpark an inbox their plan does not cover.
--   3. triage_rules.paused_reason gains 'inbox_parked'. The column had no CHECK
--      until now; one is added listing both reasons, so a typo in a writer
--      fails loudly instead of creating a pause nothing ever lifts. A rule
--      paused for parking carries paused_until = 'infinity': the dispatcher's
--      existing predicate (paused_until IS NULL OR paused_until <= now()) then
--      never claims it, with no change to dispatch_triage_rules() or the edge
--      dispatcher. Unparking clears both columns.
--
-- NO NEW INDEX. Every query that adds `parked_at is null` already filters on
-- workspace_id (idx_inboxes_workspace_id_status) or on the primary key, and a
-- workspace holds tens of inboxes at most, so a partial index would only add
-- write cost.
--
-- DEPLOY ORDER. Apply this before the mcp-server / client-api deploy and before
-- the web push that filter on parked_at: PostgREST rejects a filter on an
-- unknown column.
--
-- Idempotent: IF NOT EXISTS, constraints added only once, GRANT re-runnable.
-- ============================================================================

-- 1. Columns ------------------------------------------------------------------

ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS parked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS parked_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.inboxes'::regclass
       AND conname = 'inboxes_parked_reason_check'
  ) THEN
    ALTER TABLE public.inboxes
      ADD CONSTRAINT inboxes_parked_reason_check
      CHECK (
        (parked_at IS NULL AND parked_reason IS NULL)
        OR (parked_at IS NOT NULL AND parked_reason IS NOT NULL AND parked_reason IN ('plan_limit'))
      );
  END IF;
END $$;

COMMENT ON COLUMN public.inboxes.parked_at IS
  'When the inbox was parked because the workspace plan includes fewer inboxes. '
  'NULL = active. A parked inbox keeps its credentials but no MCP tool, '
  'automation or new scheduled send can use it. Written only by service-role '
  'code (apps/web/src/lib/billing/parking.ts). 20261024173000.';

COMMENT ON COLUMN public.inboxes.parked_reason IS
  'Why the inbox is parked. ''plan_limit'' is the only reason. NULL exactly '
  'when parked_at is NULL (inboxes_parked_reason_check).';

-- 2. Reads for members, no writes ---------------------------------------------

GRANT SELECT (parked_at, parked_reason) ON public.inboxes TO authenticated;

-- 3. triage_rules.paused_reason -----------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.triage_rules'::regclass
       AND conname = 'triage_rules_paused_reason_check'
  ) THEN
    ALTER TABLE public.triage_rules
      ADD CONSTRAINT triage_rules_paused_reason_check
      CHECK (paused_reason IS NULL OR paused_reason IN ('plan_limit', 'inbox_parked'));
  END IF;
END $$;

COMMENT ON COLUMN public.triage_rules.paused_reason IS
  'Why the rule is paused. ''plan_limit'': the workspace used its Free action '
  'allowance; lifts by itself at paused_until. ''inbox_parked'': the rule''s '
  'inbox is parked (inboxes.parked_at); paused_until is ''infinity'' and the '
  'pause lifts only when the inbox is unparked. Distinct from disabled_reason, '
  'which is terminal. 20260912200000, 20261024173000.';

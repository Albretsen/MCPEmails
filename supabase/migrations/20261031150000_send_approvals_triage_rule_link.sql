-- ============================================================
-- MCPEmails - link a held rule forward to the rule that queued it
-- 20261031150000_send_approvals_triage_rule_link
-- ============================================================
--
-- A forward queued by an automation left no trace of its rule on the approval.
-- The only link was triage_run_items.detail->>'approval_id', pointing the other
-- way, and those items cascade away with the rule. The queue could not name the
-- rule, count what waits for it, or tell a rule forward from an AI send.
--
--   triage_rule_id    Set null when the rule row is removed, so the approval
--                     stays readable and decidable.
--   triage_rule_name  The name when queued (or at this backfill). A hard delete
--                     nulls the id, so this is what still names the rule
--                     afterwards, and what still marks the row as a rule forward.
--
-- Neither column grants anything. The gate lives in queueSendApproval and the
-- decide paths, and neither reads these. RLS is row-level
-- (send_approvals_select_members), so they get the same read access as the row.
-- Changing them does not bump `revision` (see send_approvals_bump_revision): a
-- rule being deleted must not invalidate what a reviewer has on screen.

ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS triage_rule_id uuid
    REFERENCES public.triage_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS triage_rule_name text;

-- Serves "pending for this rule", and the ON DELETE SET NULL lookup, which would
-- otherwise scan the table on every rule removal.
CREATE INDEX IF NOT EXISTS send_approvals_triage_rule_idx
  ON public.send_approvals (triage_rule_id, status, created_at DESC)
  WHERE triage_rule_id IS NOT NULL;

COMMENT ON COLUMN public.send_approvals.triage_rule_id IS
  'The automation rule that queued this forward. NULL for AI sends, and after the rule row is removed.';
COMMENT ON COLUMN public.send_approvals.triage_rule_name IS
  'Rule name when queued. Survives rule deletion; non-NULL also marks the row as a rule forward.';

-- Every status, not only pending: the decided list shows the same kind, and an
-- expired rule forward needs its rule. Rows whose rule row was already removed
-- have no run item left and stay unlinked. Re-running changes nothing.
UPDATE public.send_approvals AS a
SET    triage_rule_id   = r.id,
       triage_rule_name = r.name
FROM   public.triage_run_items AS i
JOIN   public.triage_rules AS r ON r.id = i.rule_id
WHERE  i.outcome = 'queued_for_approval'
  AND  i.detail ->> 'approval_id' = a.id::text
  AND  a.operation = 'email_forward'
  AND  a.triage_rule_id IS NULL;

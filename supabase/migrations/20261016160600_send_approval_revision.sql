-- Bind a human approval to the version of the send the human reviewed.
--
-- THE HOLE (security review 2026-10-16, F-04-02). `approval_update` lets an
-- MCP key rewrite the subject and body of a PENDING approval at any time, and
-- the two approve paths (the /approvals/<id> review page and the dashboard
-- panel) claimed whatever row was current. A reviewer could read a harmless
-- body, the agent could swap it, and the reviewer's click then approved the
-- swapped content.
--
-- THE FIX. `revision` is a counter of what a reviewer is shown. The review
-- page and the dashboard dialog submit the revision they rendered, and
-- `decideApproval` (apps/web/src/lib/approvals/decide.ts) claims with
-- `.eq('revision', <submitted>)`, so an approve of an older version matches no
-- row and the reviewer is told to look again.
--
-- The counter is bumped HERE, by a trigger, and not by the code that writes the
-- row: every write that changes what a reviewer sees (the encrypted payload,
-- the summary, the delivery time) bumps it, whichever code path made the write
-- and whether or not that path remembered to. A decision (status, decided_*)
-- does not bump it.
--
-- Idempotent: safe to run more than once.

ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE public.send_approvals DROP CONSTRAINT IF EXISTS send_approvals_revision_check;
ALTER TABLE public.send_approvals ADD CONSTRAINT send_approvals_revision_check
  CHECK (revision >= 1);

CREATE OR REPLACE FUNCTION public.send_approvals_bump_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.send_at IS DISTINCT FROM OLD.send_at
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.inbox_id IS DISTINCT FROM OLD.inbox_id THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    -- A writer cannot move the counter by hand (backwards would let an old
    -- rendered revision match again).
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger function is not callable over PostgREST, but it needs no EXECUTE
-- grant for anyone either.
REVOKE ALL ON FUNCTION public.send_approvals_bump_revision() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.send_approvals_bump_revision() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.send_approvals_bump_revision() FROM authenticated;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS send_approvals_bump_revision ON public.send_approvals;
CREATE TRIGGER send_approvals_bump_revision
  BEFORE UPDATE ON public.send_approvals
  FOR EACH ROW
  EXECUTE FUNCTION public.send_approvals_bump_revision();

COMMENT ON COLUMN public.send_approvals.revision IS
  'Version of what a reviewer is shown. Bumped by trigger on every payload/summary/send_at change. Approving requires the revision the reviewer rendered.';

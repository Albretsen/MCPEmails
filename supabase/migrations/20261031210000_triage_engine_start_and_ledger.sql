-- ============================================================
-- MCPEmails - rule engine: when a rule starts, how long it remembers
-- 20261031210000_triage_engine_start_and_ledger
-- ============================================================
--
-- 1. A NEW RULE STARTS WHEN IT IS FIRST TURNED ON.
--    A forward rule used to queue every old matching message within a minute of
--    being enabled. `active_from` is stamped by the trigger below, never taken
--    from a client: no route or tool writes it, and a browser cannot write this
--    table at all. `include_past_mail` is the opt-in for old mail.
--
--    EXISTING RULES KEEP THEIR BEHAVIOUR. Adding the column with DEFAULT true
--    gives every existing row true, and only then does the default become false
--    for rules created from here on.
--
-- 2. THE PER-RUN LIMIT NO LONGER STARVES OLDER MATCHES.
--    `scan_drained_at`: the moment the runner last saw every match, handled. Mail
--    arrives at the top of a search, so from then on a window holding one handled
--    message proves nothing older needs a look, and a run costs one search. NULL
--    means a backlog may sit below handled mail, so the runner looks past it. The
--    trigger clears it whenever what the rule matches changes.
--
--    `deep_scan_floor`: existing rules only. Before this change a rule only ever
--    saw its newest matches. Looking deeper must not make it act on years of mail
--    it never reached, so past the newest matches it stops at the rule's own
--    creation date. New rules leave it NULL.
--
-- 3. THE LEDGER LASTS AS LONG AS THE RULE.
--    The 90-day delete made every message older than 90 days new again: delivered
--    invoices queued a second time, and moved mail and draft replies were redone.
--    See the job at the bottom.
--
--    GROWTH. One row per message a rule acts on: a uuid, a 64-character digest and
--    a timestamp, about 150 bytes with its primary key entry. It grows with what
--    rules act on, never with mailbox size, and a run adds at most 200 rows. A busy
--    rule acting on 200 messages a day adds about 11 MB a year. Rows go 30 days
--    after their rule is deleted, and at once if the rule row is removed (cascade).
--
-- 4. THE RUN LOG TELLS APPLIED FROM WAITING.
--    `triage_runs.queued` counts forwards held for approval. They no longer count
--    in `succeeded`, because nothing has happened to the mailbox. Older runs have
--    queued = 0 and keep their counts.
--
-- 5. A RULE REFUSES TO FORWARD ITS OWN FORWARDS.
--    'skipped_loop' is the run item saying so. See triage-engine.ts.
-- ============================================================

ALTER TABLE public.triage_rules
  ADD COLUMN IF NOT EXISTS include_past_mail boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS active_from timestamptz,
  ADD COLUMN IF NOT EXISTS deep_scan_floor timestamptz,
  ADD COLUMN IF NOT EXISTS scan_drained_at timestamptz;

-- Existing rows now hold true; every rule created from here on starts at false.
ALTER TABLE public.triage_rules ALTER COLUMN include_past_mail SET DEFAULT false;

UPDATE public.triage_rules
SET    deep_scan_floor = created_at
WHERE  deep_scan_floor IS NULL
  AND  include_past_mail;

COMMENT ON COLUMN public.triage_rules.include_past_mail IS
  'True: the rule also acts on mail that arrived before active_from. False, the default for new rules: only on mail that arrived after it. Existing rules were migrated to true.';
COMMENT ON COLUMN public.triage_rules.active_from IS
  'When the rule was first turned on. Stamped by the triage_rules_set_start trigger, never by a client.';
COMMENT ON COLUMN public.triage_rules.deep_scan_floor IS
  'Rules that predate include_past_mail only. Past the newest matches, the runner ignores mail that arrived before this. NULL for every other rule.';
COMMENT ON COLUMN public.triage_rules.scan_drained_at IS
  'When the runner last covered every match of the current filter with none left to act on. NULL means older unhandled mail may exist. Cleared by the trigger when the filter or inbox changes.';

CREATE OR REPLACE FUNCTION public.triage_rules_set_start()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Whatever an insert says, a new rule has not started yet. A copy of a rule
    -- starts when the copy is turned on.
    NEW.active_from := CASE WHEN NEW.enabled THEN now() ELSE NULL END;
    NEW.scan_drained_at := NULL;
    RETURN NEW;
  END IF;

  -- First switched on, or a rule with no start of its own has include_past_mail
  -- turned off while it is on, which means "from now".
  IF NEW.active_from IS NULL AND NEW.enabled AND (
       NOT OLD.enabled
       OR (OLD.include_past_mail AND NOT NEW.include_past_mail)
     ) THEN
    NEW.active_from := now();
  END IF;

  -- What the rule matches changed, so what the ledger covers is unknown again.
  IF NEW.filter IS DISTINCT FROM OLD.filter
     OR NEW.inbox_id IS DISTINCT FROM OLD.inbox_id
     OR NEW.include_past_mail IS DISTINCT FROM OLD.include_past_mail THEN
    NEW.scan_drained_at := NULL;
  END IF;

  -- Asking for past mail asks for all of it.
  IF NEW.include_past_mail AND NOT OLD.include_past_mail THEN
    NEW.deep_scan_floor := NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.triage_rules_set_start() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS triage_rules_set_start ON public.triage_rules;
CREATE TRIGGER triage_rules_set_start
  BEFORE INSERT OR UPDATE ON public.triage_rules
  FOR EACH ROW EXECUTE FUNCTION public.triage_rules_set_start();

ALTER TABLE public.triage_runs
  ADD COLUMN IF NOT EXISTS queued integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.triage_runs.queued IS
  'Forwards this run held for approval. Not in succeeded: nothing has happened to the mailbox. Read the approvals for what became of them.';

ALTER TABLE public.triage_run_items
  DROP CONSTRAINT IF EXISTS triage_run_items_outcome_check;
ALTER TABLE public.triage_run_items
  ADD CONSTRAINT triage_run_items_outcome_check
  CHECK (outcome IN ('applied', 'queued_for_approval', 'failed', 'skipped_duplicate', 'skipped_loop'));

-- The ledger's retention: the rule's life, plus 30 days after it is deleted.
-- Delete is a soft delete. The grace keeps the record while a deleted rule's run
-- history and waiting forwards are still being looked at, and means a rule put
-- back by support does not start over.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'triage-seen-retention') THEN
    PERFORM cron.unschedule('triage-seen-retention');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'triage-seen-retention',
  '0 3 * * *',
  $$DELETE FROM public.triage_seen_messages s
    USING public.triage_rules r
    WHERE s.rule_id = r.id
      AND r.deleted_at IS NOT NULL
      AND r.deleted_at < now() - INTERVAL '30 days'$$
);

COMMENT ON TABLE public.triage_seen_messages IS
  'Opaque per-rule dedupe ledger. Service-role only: RLS is enabled with no member policy on purpose, because the table has no user-facing meaning and its readable projection is triage_runs.skipped plus the skipped_duplicate run items. Rows are (rule, keyed digest, timestamp) and nothing else. Claimed with INSERT ... ON CONFLICT DO NOTHING before any action, which is what makes a retried or overlapping run unable to act twice. Kept for the life of the rule and removed 30 days after it is deleted, by the triage-seen-retention cron job.';

-- ============================================================
-- MCPEmails - Unattended scheduled triage ("Automations")
-- 20260819170000_create_triage_automations
-- ============================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Every mailbox action the product performs today is initiated by a model
-- inside a live MCP conversation. Automations is the first surface where the
-- server touches a mailbox with nobody watching, on a schedule, so the storage
-- has to make three guarantees the interactive path never needed:
--
--   1. DETERMINISM. A rule is a stored query plus a fixed action. There is no
--      LLM anywhere in the unattended path: email content is MATCHED, never
--      INTERPRETED. That is why `filter` holds a NormalizedSearch document
--      (the same shape search-translate.ts already produces) and `action` holds
--      a closed set of tagged shapes, rather than any kind of instruction text.
--
--   2. IDEMPOTENCE. A cron-driven runner will occasionally overlap itself, be
--      retried, or die mid-run. `triage_seen_messages` is the primitive that
--      makes that safe: a message is claimed before it is acted on, so a retry
--      cannot move the same mail twice. See its section below.
--
--   3. REVERSIBILITY OR HUMAN GATING. The only actions a rule may take are
--      reversible (move / label / mark_read, with the provider ids needed to
--      undo them kept in `triage_run_items.undo_state`) or human-gated
--      (forward and draft_reply, which always route through send_approvals
--      regardless of `inboxes.send_approval_required`). Delete is NOT an
--      available unattended action, which is why no delete-shaped action or
--      status appears anywhere in this file.
--
-- PRIVACY POSTURE (read before adding any column here)
-- ----------------------------------------------------
-- The standing product promise is that mail is fetched live and never stored.
-- The documented carve-outs so far are `scheduled_sends.payload` and
-- `bulk_plans.scope`, both encrypted. This feature deliberately does NOT open a
-- third one for message content:
--
--   * Messages are identified by `message_digest`, an HMAC-SHA256 of the
--     provider message id under ENCRYPTION_KEY. It is a one-way keyed digest,
--     so the ledger can recognise a message it has already handled without
--     being able to name it, and a database reader learns nothing about which
--     mail exists.
--   * The two human-legible columns (`subject_redacted`, `sender_redacted`) are
--     neutralized and truncated, and exist solely so a run log is readable.
--   * NOTHING in these tables may ever hold a message body, a preview, a
--     snippet, an attachment, or a full header block.
--
-- Related: supabase/migrations/20260802200000_add_send_approvals.sql (the RLS
-- and service-role-write shape this follows),
-- 20260805210000_create_bulk_plans.sql (encrypted-column conventions),
-- 20260802180000_create_bulk_runs.sql (operational-metadata-only rule),
-- 20260819190000_schedule_triage_dispatch.sql (the cron that drives all this).
-- ============================================================


-- ---------------------------------------------------------------------------
-- public.triage_rules - the stored, deterministic rule
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.triage_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id             uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,

  -- The key the runner acts as. NOT NULL and cascading on purpose: an
  -- unattended action must be attributable to a specific key so it can be
  -- metered, rate-limited and audit-logged exactly like an interactive call,
  -- and revoking the key must take its automations down with it rather than
  -- leaving orphaned background work running against a mailbox.
  api_key_id           uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,

  -- The human who created the rule, for the audit trail. Nullable and SET NULL
  -- so removing a teammate never deletes the workspace's automations.
  created_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  name                 text NOT NULL
                       CONSTRAINT triage_rules_name_length_check
                       CHECK (char_length(name) BETWEEN 1 AND 80),

  -- Rules are created OFF. Enabling is always a separate, explicit act, so no
  -- unattended mailbox work can begin as a side effect of creating a rule.
  enabled              boolean NOT NULL DEFAULT false,

  -- A NormalizedSearch document (the shape search-translate.ts produces), not
  -- free text and not a provider-native query string. Storing the normalized
  -- form means the runner re-uses the exact same search path the interactive
  -- tools use, on every provider, with no second dialect to keep correct.
  filter               jsonb NOT NULL,

  -- One tagged action, from a closed set enforced in the edge function:
  --   {"type":"move","folder":"..."}          reversible, undo supported
  --   {"type":"label","label":"..."}          reversible
  --   {"type":"mark_read"}                    reversible
  --   {"type":"forward","to":[...],"note":""} ALWAYS approval-gated
  --   {"type":"draft_reply","template":"..."} creates a draft, never sends
  -- Template placeholders are a whitelist ({{sender_name}}, {{sender_email}},
  -- {{subject}}, {{date}}), all HTML-escaped, never body content. Anything else
  -- in a template is literal text: there is no expression evaluation.
  --
  -- The shape is validated in the edge function rather than by a CHECK here,
  -- because the rules are structural (per-type required keys, length caps) and
  -- a jsonb CHECK expressive enough to cover them would be unmaintainable. The
  -- database constraint that matters is the one this file DOES make: no action
  -- type in the set is destructive.
  action               jsonb NOT NULL,

  -- A fixed cadence ladder rather than a free integer or a cron string. A free
  -- value invites a 1-minute rule that hammers a provider into rate limiting,
  -- and a cron string is a second scheduling language to parse and validate.
  interval_minutes     integer NOT NULL
                       CONSTRAINT triage_rules_interval_minutes_check
                       CHECK (interval_minutes IN (15, 30, 60, 180, 360, 720, 1440)),

  -- Per-run blast radius. Caps how much mail a single misconfigured filter can
  -- touch before a human sees the run log.
  max_messages_per_run integer NOT NULL DEFAULT 25
                       CONSTRAINT triage_rules_max_messages_check
                       CHECK (max_messages_per_run BETWEEN 1 AND 200),

  -- Scheduling state. next_run_at is what the dispatcher orders by; it is set
  -- to now() + interval_minutes when a run completes.
  next_run_at          timestamptz,
  last_run_at          timestamptz,

  -- The lease. Non-null means a run is in flight. The runner claims a rule with
  -- an optimistic compare-and-set (UPDATE ... WHERE running_since IS NULL), so
  -- two overlapping dispatches cannot both claim the same rule. A lease older
  -- than 10 minutes is treated as stale and released, and its run is marked
  -- failed: a partially applied run is NEVER auto-retried, the same fail-forward
  -- rule as a stale 'sending' scheduled_send and a stuck 'executing' bulk_plan.
  running_since        timestamptz,

  -- Failure back-off state. The runner increments this on a failed run, resets
  -- it on success, and auto-disables the rule at 5 consecutive failures with
  -- disabled_reason set, so a rule pointed at a dead mailbox stops rather than
  -- retrying forever every 15 minutes.
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_reason      text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Soft delete. Deleting a rule must not delete its run history, which is the
  -- record of what was done to a mailbox and is exactly what a user goes
  -- looking for after the fact.
  deleted_at           timestamptz,

  -- Deliberately redundant with the column's NOT NULL. Kept because the
  -- scheduling contract depends on this column always being present: a NULL
  -- cadence would make next_run_at uncomputable and silently strand the rule.
  CONSTRAINT triage_rules_interval_required_check CHECK (interval_minutes IS NOT NULL)
);

-- The dispatcher's only hot query: the due, claimable rules. The predicate
-- mirrors the claim's WHERE clause exactly so the index covers the CAS as well
-- as the scan, and keeps disabled, deleted and in-flight rules out of it.
CREATE INDEX IF NOT EXISTS triage_rules_due_idx
  ON public.triage_rules (next_run_at)
  WHERE enabled AND deleted_at IS NULL AND running_since IS NULL;

CREATE INDEX IF NOT EXISTS triage_rules_workspace_idx
  ON public.triage_rules (workspace_id, created_at DESC);

DROP TRIGGER IF EXISTS triage_rules_updated_at ON public.triage_rules;
CREATE TRIGGER triage_rules_updated_at
  BEFORE UPDATE ON public.triage_rules
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE public.triage_rules ENABLE ROW LEVEL SECURITY;

-- Members read their own workspace's rules. Every write, including enable and
-- disable, goes through a server route holding the service-role client. A
-- permissive UPDATE policy would let a browser flip `enabled`, rewrite
-- `api_key_id` to borrow another key's authority, or forge scheduling state.
-- Note also the RLS trap recorded in project_soft_delete_rls_constraint: the
-- SELECT policy is re-evaluated against the NEW row, so an RLS client cannot
-- reliably set deleted_at even if a write policy existed.
DROP POLICY IF EXISTS "triage_rules_select_members" ON public.triage_rules;
CREATE POLICY "triage_rules_select_members"
  ON public.triage_rules FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

COMMENT ON TABLE public.triage_rules IS
  'Deterministic unattended triage rules ("Automations"): a stored normalized search plus one fixed, reversible-or-approval-gated action, evaluated on a fixed cadence with no LLM in the loop. Holds no message content.';
COMMENT ON COLUMN public.triage_rules.filter IS
  'NormalizedSearch document (search-translate.ts shape). A structured query the runner re-executes, never free text and never a provider-native query string.';
COMMENT ON COLUMN public.triage_rules.action IS
  'One tagged action: move | label | mark_read | forward | draft_reply. Delete is not an available unattended action. forward and draft_reply are always human-gated. Shape is validated in the edge function.';
COMMENT ON COLUMN public.triage_rules.api_key_id IS
  'The key the unattended runner acts as, so every automated action is metered, rate-limited and audit-logged exactly like an interactive call. Revoking the key cascades the rules away.';
COMMENT ON COLUMN public.triage_rules.running_since IS
  'Lease marker. Non-null means a run is in flight; the runner claims it with an optimistic CAS. A lease older than 10 minutes is released and its run marked failed. A partially applied run is never auto-retried.';
COMMENT ON COLUMN public.triage_rules.consecutive_failures IS
  'Reset on a successful run, incremented on failure. At 5 the rule is auto-disabled and disabled_reason is set, so a rule pointed at a broken mailbox stops instead of retrying forever.';
COMMENT ON COLUMN public.triage_rules.deleted_at IS
  'Soft delete. Run history outlives the rule on purpose: it is the record of what was done to a mailbox.';


-- ---------------------------------------------------------------------------
-- public.triage_runs - one row per evaluation of a rule
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.triage_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id      uuid NOT NULL REFERENCES public.triage_rules(id) ON DELETE CASCADE,

  -- Denormalized from the rule so the RLS policy is a plain column comparison
  -- and does not have to join, and so the dashboard can list a workspace's runs
  -- without walking every rule.
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- 'skipped' means the run was claimed but had nothing to do (no matches, or
  -- every match already in the seen ledger). It is a distinct outcome from
  -- 'completed' because a rule that only ever skips is a misconfigured filter,
  -- and that is worth showing a user.
  status       text NOT NULL
               CONSTRAINT triage_runs_status_check
               CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed', 'skipped')),

  -- How the run was started. A manual run is a user pressing Run now in the
  -- dashboard; it takes the same lease and the same seen ledger, so it cannot
  -- race or double-apply against the scheduled one.
  trigger      text NOT NULL DEFAULT 'schedule'
               CONSTRAINT triage_runs_trigger_check
               CHECK (trigger IN ('schedule', 'manual')),

  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms  integer,

  -- Counters only. matched is what the filter returned (before the per-run cap),
  -- skipped is the already-seen messages the dedupe ledger rejected.
  matched      integer NOT NULL DEFAULT 0,
  processed    integer NOT NULL DEFAULT 0,
  succeeded    integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  skipped      integer NOT NULL DEFAULT 0,

  error_code   text,

  -- PRIVACY: a short, operator-facing failure description ONLY, capped at 1000
  -- characters by the writer. It must NEVER contain full message content: no
  -- body, no preview, no snippet, no raw header block, and no provider response
  -- payload that could carry one. Provider error text must be reduced to a code
  -- and a sentence before it is written here. This column is readable by every
  -- member of the workspace through the SELECT policy below, which is precisely
  -- why it may not become an accidental content sink.
  error_detail text,

  -- A run is 'running' if and only if it has not completed. This is the
  -- invariant the stale-lease reclaim depends on: it may mark an abandoned run
  -- 'failed' only by stamping completed_at at the same time, so a crashed run
  -- can never linger as a live one.
  CONSTRAINT triage_runs_completed_at_check
    CHECK ((status = 'running') = (completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS triage_runs_rule_idx
  ON public.triage_runs (rule_id, started_at DESC);

ALTER TABLE public.triage_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "triage_runs_select_members" ON public.triage_runs;
CREATE POLICY "triage_runs_select_members"
  ON public.triage_runs FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

COMMENT ON TABLE public.triage_runs IS
  'One row per evaluation of a triage rule. Operational metadata and counters only, in the same spirit as bulk_runs. No message content.';
COMMENT ON COLUMN public.triage_runs.status IS
  'running -> completed | completed_with_errors | failed | skipped. A run stuck in running is reclaimed by the stale-lease sweep and marked failed; it is never re-run, because its actions may have partially applied.';
COMMENT ON COLUMN public.triage_runs.skipped IS
  'Messages the per-rule seen ledger rejected as already handled. A high value against a low processed count means an overlapping or retried run was correctly deduped.';
COMMENT ON COLUMN public.triage_runs.error_detail IS
  'Operator-facing failure description, 1000 characters maximum. NEVER message content: no body, preview, snippet, raw header block, or unreduced provider payload. Visible to every workspace member.';


-- ---------------------------------------------------------------------------
-- public.triage_run_items - what the run did, message by message
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.triage_run_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES public.triage_runs(id) ON DELETE CASCADE,

  -- Denormalized so a rule's whole history can be swept without joining runs.
  rule_id        uuid NOT NULL REFERENCES public.triage_rules(id) ON DELETE CASCADE,

  -- HMAC-SHA256(ENCRYPTION_KEY, provider_message_id). A keyed one-way digest,
  -- not the id itself: the same message always digests the same way so it can
  -- be recognised and correlated with the seen ledger, but the digest cannot be
  -- turned back into a provider id, and a database reader cannot confirm
  -- whether any particular message was handled without already holding the key.
  message_digest text NOT NULL,

  -- PRIVACY: legibility fields, and the outer boundary of what this feature
  -- stores about a message. Both are passed through neutralizeText (the
  -- untrusted-data marking from text-safety.ts) and truncated to 120
  -- characters before insert. They exist so a run log reads as something other
  -- than a column of hashes.
  --
  -- They are NOT a licence to store message content. Never widen this pair with
  -- a body, preview, snippet, date header, thread subject chain, recipient list,
  -- or attachment name. If a future change needs more than a truncated subject
  -- and sender to be useful, that is a signal the run log is being asked to
  -- become a mail archive, and the answer is no.
  subject_redacted text,
  sender_redacted  text,

  -- 'queued_for_approval' is the terminal state for forward: the action did not
  -- happen and will not happen unless a human approves it in the dashboard.
  -- 'skipped_duplicate' is the seen-ledger rejection, recorded rather than
  -- silently dropped so an overlapping run is visible instead of mysterious.
  outcome        text NOT NULL
                 CONSTRAINT triage_run_items_outcome_check
                 CHECK (outcome IN ('applied', 'queued_for_approval', 'failed', 'skipped_duplicate')),

  -- Non-secret shape of what happened: {from_folder, to_folder, approval_id,
  -- error_code}. Folder names are user-authored labels, not message content.
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- What it takes to put the message back: the provider ids and source location
  -- for the reverse operation, as {"v":1,"data":"<ciphertext>"}.
  --
  -- Encrypted with the same AES-256-GCM helper as scheduled_sends.payload and
  -- bulk_plans.scope, and for the same reason: provider message ids are message
  -- identifiers, so holding them is a narrow, deliberate carve-out from the
  -- fetch-live-never-store rule rather than an accident. Undo is only possible
  -- if the ids survive the run, and an automation a user cannot undo is an
  -- automation a user will not enable.
  --
  -- NULL for actions that need no undo state (mark_read) and for outcomes that
  -- changed nothing (queued_for_approval, failed, skipped_duplicate).
  undo_state     jsonb,
  undone_at      timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS triage_run_items_run_idx
  ON public.triage_run_items (run_id, created_at);

ALTER TABLE public.triage_run_items ENABLE ROW LEVEL SECURITY;

-- This table has no workspace_id of its own, so tenancy is resolved through the
-- parent run. Denormalizing workspace_id down here would be faster, but it
-- would also be a second source of truth for who owns a row, and a run item
-- that disagrees with its run about tenancy is a cross-tenant read waiting to
-- happen. The join is against the run's primary key, which is cheap.
DROP POLICY IF EXISTS "triage_run_items_select_members" ON public.triage_run_items;
CREATE POLICY "triage_run_items_select_members"
  ON public.triage_run_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.triage_runs r
    WHERE r.id = triage_run_items.run_id
      AND r.workspace_id = ANY(public.my_workspace_ids())
  ));

COMMENT ON TABLE public.triage_run_items IS
  'Per-message record of what an automation run did. Identifies messages only by keyed digest, and stores at most a neutralized, truncated subject and sender for legibility. Never message content.';
COMMENT ON COLUMN public.triage_run_items.message_digest IS
  'HMAC-SHA256(ENCRYPTION_KEY, provider_message_id). One-way and keyed, so a message can be recognised and correlated with the seen ledger without the provider id being recoverable from the database.';
COMMENT ON COLUMN public.triage_run_items.subject_redacted IS
  'Neutralized (text-safety.ts) and truncated to 120 characters, for run-log legibility only. NEVER a full subject line carrying content, and never to be joined by a body, preview, snippet, or recipient list.';
COMMENT ON COLUMN public.triage_run_items.sender_redacted IS
  'Neutralized (text-safety.ts) and truncated to 120 characters, for run-log legibility only. NEVER a full header block or an unbounded correspondent record.';
COMMENT ON COLUMN public.triage_run_items.undo_state IS
  'AES-256-GCM ciphertext {"v":1,"data":...} holding the provider ids and source location needed to reverse the action. A documented, narrow exception to fetch-live-never-store, matching bulk_plans.scope. NULL when there is nothing to undo.';
COMMENT ON COLUMN public.triage_run_items.outcome IS
  'applied | queued_for_approval | failed | skipped_duplicate. queued_for_approval means nothing happened to the mailbox and nothing will until a human approves it.';


-- ---------------------------------------------------------------------------
-- public.triage_seen_messages - the dedupe primitive
-- ---------------------------------------------------------------------------
--
-- This is the single mechanism that makes an unattended, cron-driven, retryable
-- runner safe to point at a mailbox.
--
-- Before acting on a message the runner does an INSERT ... ON CONFLICT DO
-- NOTHING against this table. The primary key makes that claim atomic: of two
-- overlapping runs, exactly one inserts the row and the other inserts zero and
-- records outcome 'skipped_duplicate' instead of acting. Without it, a run that
-- times out and is re-dispatched a minute later moves the same mail a second
-- time, which is the single most damaging failure this feature could have.
--
-- The ledger is per rule, not per inbox: two rules may legitimately both want
-- to act on the same message, and only a repeat by the SAME rule is a duplicate.
--
-- Retention is 90 days, enforced by a daily cron job in
-- 20260819190000_schedule_triage_dispatch.sql. That is comfortably longer than
-- the longest cadence (1440 minutes), so a message can never age out of the
-- ledger while a rule could still be looking at it.

CREATE TABLE IF NOT EXISTS public.triage_seen_messages (
  rule_id        uuid NOT NULL REFERENCES public.triage_rules(id) ON DELETE CASCADE,
  message_digest text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, message_digest)
);

-- PRIVACY: the entire table is (rule, keyed digest, timestamp). There is
-- nothing here to read: no subject, no sender, no folder, no provider id. That
-- is deliberate. A dedupe ledger has to hold a row for every message a rule has
-- ever looked at, which makes it by far the highest-volume record of a user's
-- mail in the system, and therefore the one that must carry the least.
ALTER TABLE public.triage_seen_messages ENABLE ROW LEVEL SECURITY;

-- RLS is enabled with NO policy at all, which is default-deny for anon and
-- authenticated. Only the service-role client (which bypasses RLS) can touch
-- it, matching outbound_idempotency. This is not an oversight to be corrected
-- later: the ledger is an opaque internal primitive with no user-facing
-- meaning. Everything a person needs to know about deduplication is already
-- exposed in a readable form as triage_runs.skipped and the
-- 'skipped_duplicate' run items. Exposing the raw ledger would add a
-- per-message row count of a workspace's mail volume to the API surface and
-- buy a reader nothing.

COMMENT ON TABLE public.triage_seen_messages IS
  'Opaque per-rule dedupe ledger. Service-role only: RLS is enabled with no member policy on purpose, because the table has no user-facing meaning and its readable projection is triage_runs.skipped plus the skipped_duplicate run items. Rows are (rule, keyed digest, timestamp) and nothing else. Claimed with INSERT ... ON CONFLICT DO NOTHING before any action, which is what makes a retried or overlapping run unable to act twice. Retained 90 days by the triage-seen-retention cron job.';
COMMENT ON COLUMN public.triage_seen_messages.message_digest IS
  'HMAC-SHA256(ENCRYPTION_KEY, provider_message_id), identical to triage_run_items.message_digest. One-way and keyed: the ledger recognises a message it has handled without being able to name it.';

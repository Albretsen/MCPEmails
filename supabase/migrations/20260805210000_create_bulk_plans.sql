-- MCP Apps: bulk operation preview ("plan instead of execute").
--
-- Destructive bulk mailbox operations (email_delete delete_batch /
-- search_and_delete, email_organize move_batch / search_and_move) currently run
-- the instant an agent asks for them, with no confirmation of any kind. This
-- migration adds the storage for a review step: the server resolves the exact
-- message ids, freezes them as a short-lived plan, and returns a card the user
-- clicks Execute on.
--
-- Related: docs/mcp-apps/contract.md §3 (plan payload) and §6 (security model),
-- supabase/functions/mcp-server/mcp-app-bulk.ts (the handlers),
-- supabase/migrations/20260802200000_add_send_approvals.sql (the shape this
-- follows), 20260805200000_mcp_app_approval_review.sql (Phase 2).

-- ---------------------------------------------------------------------------
-- inboxes.bulk_review_mode — the opt-in
-- ---------------------------------------------------------------------------

-- WHETHER a bulk operation is previewed instead of executed. Defaults to 'off'
-- for every existing and new inbox, so nothing changes for anyone until a
-- workspace turns it on deliberately.
--
--   'off'  — today's behaviour exactly: the tool executes immediately
--   'plan' — the tool returns a frozen plan and executes nothing
--
-- This is deliberately an explicit setting rather than a capability sniff.
-- Phase 0 established that the server cannot tell whether a client can render
-- MCP Apps (the official reference host sends `capabilities: {}` with no
-- `extensions` key and renders cards fine), so any inference would either
-- degrade conforming hosts or silently break the non-UI integrations that
-- depend on these tools executing immediately. The same reasoning produced
-- `inboxes.send_review_mode`, and this column mirrors it on purpose.
--
-- NOTE the difference from the send gate: `send_approval_required` (a boolean)
-- decides WHETHER that gate fires and `send_review_mode` decides WHERE the
-- review happens. A bulk plan has only one review surface — the card — so one
-- column carries both meanings here.
ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS bulk_review_mode text NOT NULL DEFAULT 'off';

ALTER TABLE public.inboxes DROP CONSTRAINT IF EXISTS inboxes_bulk_review_mode_check;
ALTER TABLE public.inboxes ADD CONSTRAINT inboxes_bulk_review_mode_check
  CHECK (bulk_review_mode IN ('off', 'plan'));

COMMENT ON COLUMN public.inboxes.bulk_review_mode IS
  'Whether destructive bulk operations on this inbox are previewed as a plan before running: off | plan. Defaults to off, which is the pre-existing execute-immediately behaviour.';

-- ---------------------------------------------------------------------------
-- bulk_plans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bulk_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  -- The key that asked for the operation. Kept for the audit trail; the key
  -- that later executes the plan is recorded separately, because they can
  -- differ (two keys in one workspace) and the distinction matters when
  -- reconstructing who deleted what.
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,

  operation text NOT NULL CHECK (operation IN ('email_delete', 'email_organize')),
  action text NOT NULL CHECK (action IN (
    'delete_batch', 'search_and_delete', 'move_batch', 'search_and_move'
  )),

  -- ── The frozen scope ─────────────────────────────────────────────────────
  --
  -- The RESOLVED message ids, plus the resolved provider-native destination,
  -- the permanent flag and the human-readable description. Never a query to
  -- re-run: re-running a search at execute time could match messages that
  -- arrived in the intervening minutes, which is precisely the surprise this
  -- feature exists to prevent. The caller supplies only `plan_id` at execute
  -- time and therefore cannot widen, narrow, or restate the selection.
  --
  -- ── Why this is encrypted, and why it is a documented exception ──────────
  --
  -- The product's standing promise is that mail is fetched live and never
  -- stored (see the wording shipped across all locales, and the carve-out
  -- already documented for scheduled_sends). Provider message ids are message
  -- identifiers, and `bulk_runs` explicitly refuses to hold them. Freezing a
  -- selection is impossible without them, so this table is a second, narrower
  -- carve-out: encrypted at rest with the same AES-256-GCM helper the approval
  -- payloads use, capped at a 15-minute TTL, and deleted-on-cascade with the
  -- inbox.
  --
  -- What is deliberately NOT in here: message subjects, senders, dates,
  -- previews, bodies or any other header. The card's `sample` rows are built
  -- in memory at plan time from the search result the server already had, are
  -- returned once in that tool result, and are never persisted. Storing them
  -- would widen the carve-out from "identifiers" to "content" for no
  -- functional gain, since nothing ever re-reads a plan's sample.
  scope jsonb NOT NULL,
  scope_encrypted boolean NOT NULL DEFAULT true,

  -- ── Plaintext, non-content metadata ──────────────────────────────────────
  -- Everything below is operational, in the same spirit as bulk_runs: counters,
  -- shape and timing. None of it reveals who the user corresponds with.

  -- Contract §3: the EXACT number of messages the server will act on, not an
  -- estimate. It is the length of the frozen id list by construction.
  match_count integer NOT NULL CHECK (match_count >= 0),
  scope_kind text NOT NULL CHECK (scope_kind IN ('explicit_ids', 'search')),
  permanent boolean NOT NULL DEFAULT false,

  -- 'cancelled' is a first-class terminal state rather than "let the TTL lapse".
  -- Lapsing is fail-safe but leaves no record that a human read a destructive
  -- preview and said no, and that is exactly the event worth auditing.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'executed', 'cancelled', 'expired', 'failed')),

  cancelled_at timestamptz,
  cancelled_by_api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- 15 minutes from creation (contract §3). Short on purpose: the plan is a
  -- frozen snapshot of a mailbox, and the longer it lives the less it describes
  -- the mailbox as it is now.
  expires_at timestamptz NOT NULL,

  executed_at timestamptz,
  executed_by_api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  -- Messages the provider actually acted on. May be lower than match_count when
  -- some ids failed (already moved, already deleted, permissions).
  affected_count integer CHECK (affected_count IS NULL OR affected_count >= 0),
  error_code text
);

-- ── Single-use enforcement ─────────────────────────────────────────────────
--
-- The claim in `runBulkExecute` is an UPDATE ... WHERE id = $1 AND
-- workspace_id = $2 AND status = 'pending', which is atomic in Postgres: of two
-- concurrent double-clicks exactly one updates a row and the other updates
-- none and reports "already executed". This partial index keeps that claim (and
-- the lapsed-plan sweep) off the executed history.
--
-- A plan that is claimed and then crashes mid-execution stays in 'executing'
-- forever, and that is the intended fail-safe: some of the messages may already
-- have been deleted, so re-running it could act twice. Same reasoning as the
-- stale-'sending' rule in the scheduled-send dispatcher.
CREATE INDEX IF NOT EXISTS bulk_plans_pending_expiry_idx
  ON public.bulk_plans (expires_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS bulk_plans_workspace_created_idx
  ON public.bulk_plans (workspace_id, created_at DESC);

ALTER TABLE public.bulk_plans ENABLE ROW LEVEL SECURITY;

-- Read-only to workspace members, matching send_approvals. Every write comes
-- from the edge function's service-role client: RLS re-evaluates the SELECT
-- policy against the NEW row, so a status write from an RLS client would be
-- rejected (see project_soft_delete_rls_constraint for the same trap).
DROP POLICY IF EXISTS "bulk_plans_select_members" ON public.bulk_plans;
CREATE POLICY "bulk_plans_select_members" ON public.bulk_plans FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = bulk_plans.workspace_id
      AND wm.user_id = auth.uid()
  ));

COMMENT ON TABLE public.bulk_plans IS
  'Short-lived (15 min), single-use, encrypted snapshots of a resolved bulk mailbox operation awaiting an explicit Execute. Holds resolved message identifiers - a deliberate, documented exception to the fetch-live-never-store rule - and no message content whatsoever.';
COMMENT ON COLUMN public.bulk_plans.scope IS
  'AES-256-GCM ciphertext of the frozen scope: resolved message ids, resolved destination id, permanent flag, description. Never a re-runnable query.';
COMMENT ON COLUMN public.bulk_plans.scope_encrypted IS
  'Mirrors the scheduled_sends/send_approvals payload_encrypted convention. Always true for rows written by the current code; the flag exists so a reader never has to guess.';
COMMENT ON COLUMN public.bulk_plans.match_count IS
  'Exact number of messages the plan will act on (contract.md §3). Never an estimate - ids are resolved before the plan is created.';
COMMENT ON COLUMN public.bulk_plans.status IS
  'pending -> executing -> executed | failed, or pending -> cancelled | expired. A row stuck in executing is never retried: the operation may have partially applied.';
COMMENT ON COLUMN public.bulk_plans.cancelled_by_api_key_id IS
  'API key that declined the preview via bulk_cancel. Recorded so a refused destructive operation leaves an audit trail, which letting the TTL lapse would not.';

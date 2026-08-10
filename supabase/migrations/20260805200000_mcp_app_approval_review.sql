-- MCP Apps: review-card support for the outbound approval gate.
--
-- Adds decision provenance and a TTL to send_approvals, and a per-inbox
-- selector for WHERE a pending send is reviewed. Purely additive: every column
-- is nullable or carries a default that reproduces today's behaviour exactly.
--
-- Related: docs/mcp-apps/contract.md (§6 is the security model),
-- supabase/migrations/20260802200000_add_send_approvals.sql (base table).

-- ---------------------------------------------------------------------------
-- send_approvals
-- ---------------------------------------------------------------------------

-- Where the human decision was made. NULL until the row is decided.
--   'dashboard'   — the approvals panel in the dashboard
--   'review_page' — the focused /approvals/<id> page opened from a review card
--   'mcp_app'     — decided inline in the MCP review card (reject only; see below)
--
-- SECURITY: 'mcp_app' can only ever accompany status = 'rejected'. Approving is
-- unreachable over the MCP channel by construction — `approval_decide` refuses
-- decision:"approve" unconditionally at the tool layer, because the server
-- cannot distinguish an app-originated tools/call from a model-originated one
-- (docs/mcp-apps/contract.md §6). A CHECK is deliberately NOT used to encode
-- that invariant: it belongs in the code path that is the actual boundary, and
-- a constraint here would imply the database is enforcing something it cannot
-- (nothing stops a service-role writer from setting both columns).
ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS decided_via text;

ALTER TABLE public.send_approvals DROP CONSTRAINT IF EXISTS send_approvals_decided_via_check;
ALTER TABLE public.send_approvals ADD CONSTRAINT send_approvals_decided_via_check
  CHECK (decided_via IS NULL OR decided_via IN ('dashboard', 'review_page', 'mcp_app'));

-- The API key that rejected the send, when the decision arrived over MCP.
-- `decided_by` (a user id) stays NULL in that case: no human session exists on
-- that path, and claiming one would falsify the audit trail.
ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS decided_by_api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL;

-- Pending approvals expire 24h after they are queued. An expired request is
-- never dispatchable: the decide paths refuse it, the MCP tools refuse it and
-- retire the row, and the scheduled-send dispatcher re-checks it before
-- re-running the original operation.
ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Existing rows predate the TTL, and the backfill must not retroactively kill
-- a request someone is still intending to approve. So a row that is STILL
-- PENDING gets a full window measured from now; anything already decided gets
-- the nominal window from its creation, which only ever affects display.
UPDATE public.send_approvals
  SET expires_at = now() + interval '24 hours'
  WHERE expires_at IS NULL AND status = 'pending';

UPDATE public.send_approvals
  SET expires_at = created_at + interval '24 hours'
  WHERE expires_at IS NULL;

-- Supports the "which pending rows have lapsed" sweep without scanning decided
-- history. Partial, matching send_approvals_workspace_pending_idx.
CREATE INDEX IF NOT EXISTS send_approvals_pending_expiry_idx
  ON public.send_approvals (expires_at) WHERE status = 'pending';

-- RLS is already enabled on this table with a member-SELECT policy scoped by
-- workspace_id; the new columns are covered by it automatically. No new policy
-- is added: every write to send_approvals is made by the service-role client
-- (the edge function and the web service client), because the SELECT policy is
-- re-evaluated against the NEW row and would reject an RLS-client status write.

COMMENT ON COLUMN public.send_approvals.decided_via IS
  'Surface the decision was made on: dashboard | review_page | mcp_app. mcp_app implies a rejection - approve is unreachable over MCP by design.';
COMMENT ON COLUMN public.send_approvals.decided_by_api_key_id IS
  'API key that rejected the send over MCP. NULL for browser decisions, which set decided_by instead.';
COMMENT ON COLUMN public.send_approvals.expires_at IS
  'Deadline for deciding a pending request (24h from creation). An expired request can never be dispatched.';

-- ---------------------------------------------------------------------------
-- inboxes
-- ---------------------------------------------------------------------------

-- WHERE a gated send is reviewed. This does NOT decide WHETHER the gate fires:
-- `send_approval_required` remains the single source of truth for that, and
-- `queueSendApproval` still keys off it alone.
--
--   'off'       — no review surface preference (the value every inbox without
--                 the gate carries; ignored while send_approval_required=false)
--   'dashboard' — the tool result points at the dashboard queue (today's behaviour)
--   'inline'    — the tool result additionally invites review in the MCP card
--
-- The two columns are related but not derived, so they can drift: an inbox with
-- send_approval_required=false and send_review_mode='inline' has no gate at all,
-- and one with send_approval_required=true and 'off' is gated with dashboard
-- wording. Both are harmless because the gate is read from the boolean only.
-- See the migration notes in the Phase 2 report for the argument that the
-- boolean should eventually become `send_review_mode <> 'off'`.
ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS send_review_mode text NOT NULL DEFAULT 'off';

ALTER TABLE public.inboxes DROP CONSTRAINT IF EXISTS inboxes_send_review_mode_check;
ALTER TABLE public.inboxes ADD CONSTRAINT inboxes_send_review_mode_check
  CHECK (send_review_mode IN ('off', 'inline', 'dashboard'));

-- Behaviour-preserving backfill: every inbox that already opted into the gate
-- keeps being reviewed exactly where it is reviewed today.
UPDATE public.inboxes
  SET send_review_mode = 'dashboard'
  WHERE send_approval_required = true AND send_review_mode = 'off';

COMMENT ON COLUMN public.inboxes.send_review_mode IS
  'Where a gated send is reviewed: off | inline | dashboard. Does not gate anything - send_approval_required is the source of truth for whether the gate fires.';

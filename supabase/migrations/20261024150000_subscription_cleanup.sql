-- ============================================================================
-- Subscription cleanup (2026-10-24): storage for subscriptions_scan and
-- subscriptions_cleanup, plus the internal rollout flag.
-- ============================================================================
--
-- `subscriptions_scan` reads List-Unsubscribe headers, groups the mail by
-- sender and freezes the result as a short-lived plan. `subscriptions_cleanup`
-- runs the method ladder for the senders the user picked (one-click POST,
-- a draft for a mailto address, or a link handed back to the user) and writes
-- one ledger row per sender, so a replay never sends a second request. A cron
-- job (20261024150100) checks 72 hours later whether the sender stopped.
--
-- Related: supabase/functions/mcp-server/subscription-cleanup.ts (handlers),
-- list-unsubscribe.ts and subscription-scan.ts (Phase 1),
-- 20260805210000_create_bulk_plans.sql (the plan shape this follows),
-- 20261023200000_send_review_mode_chat.sql (the seeding this copies).
--
-- Idempotent: IF NOT EXISTS everywhere, policies dropped before create.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- workspaces.subscription_cleanup_enabled: OUR rollout gate.
--
-- Internal only at launch. mcp-server hides both tools from tools/list and
-- refuses them (isError) in a workspace without it. Its own column, like
-- chat_send_confirm_enabled, so widening this rollout moves nothing else.
-- DEFAULT FALSE: the pre-feature behaviour.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS subscription_cleanup_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.subscription_cleanup_enabled IS
  'Rollout gate for the subscriptions_scan / subscriptions_cleanup MCP tools. Internal only at launch.';

-- Seed: our own workspaces, identified by OWNER through
-- growth_is_internal_email, exactly as 20261023200000 seeds
-- chat_send_confirm_enabled. Idempotent.
UPDATE public.workspaces w
SET subscription_cleanup_enabled = true
FROM public.users u
WHERE u.id = w.owner_id
  AND w.deleted_at IS NULL
  AND w.subscription_cleanup_enabled IS DISTINCT FROM true
  AND public.growth_is_internal_email(u.email);

-- ---------------------------------------------------------------------------
-- subscription_plans: one scan, frozen for 15 minutes.
--
-- `senders` is AES-256-GCM ciphertext (the same helper bulk_plans uses) of the
-- server-held sender list: display names, addresses, the raw unsubscribe URL
-- or mailto and the message ids the backlog step archives. The URL path is
-- where the unsubscribe token lives and the ids are message identifiers, so
-- neither is ever stored in plain text. The caller sends back only plan_id and
-- sender keys; nothing it sends can add a URL or a message id.
--
-- `progress` is ciphertext too: the per-sender results (a needs_user result
-- carries its raw link) and the ids the backlog step has not moved yet, so
-- `continue: true` resumes without re-running the unsubscribe part.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id             uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  -- The key that ran the scan.
  api_key_id           uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  senders              jsonb NOT NULL,
  senders_encrypted    boolean NOT NULL DEFAULT true,
  sender_count         integer NOT NULL CHECK (sender_count >= 0),
  -- Counts only (by method, unsafe): no names, no addresses.
  summary              jsonb NOT NULL DEFAULT '{}'::jsonb,
  window_days          integer NOT NULL CHECK (window_days BETWEEN 1 AND 365),
  scanned              integer NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  truncated            boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  -- Single use for the unsubscribe part: the claim is
  -- UPDATE ... WHERE id = $1 AND workspace_id = $2 AND used_at IS NULL.
  used_at              timestamptz,
  used_by_api_key_id   uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  progress             jsonb,
  backlog_action       text CHECK (backlog_action IS NULL OR backlog_action IN ('archive', 'keep')),
  backlog_moved        integer NOT NULL DEFAULT 0 CHECK (backlog_moved >= 0),
  backlog_remaining    integer NOT NULL DEFAULT 0 CHECK (backlog_remaining >= 0),
  -- Short lease so two "Continue archiving" clicks do not move in parallel.
  backlog_leased_until timestamptz
);

CREATE INDEX IF NOT EXISTS subscription_plans_workspace_created_idx
  ON public.subscription_plans (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_plans_created_idx
  ON public.subscription_plans (created_at);

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

-- No user writes. REVOKE ALL also removes TRUNCATE, REFERENCES and TRIGGER.
REVOKE ALL ON TABLE public.subscription_plans FROM anon, authenticated;

-- Members read the bookkeeping columns of their workspaces' plans, never the
-- ciphertext.
GRANT SELECT (id, workspace_id, inbox_id, api_key_id, sender_count, summary, window_days,
              scanned, truncated, created_at, expires_at, used_at, backlog_action,
              backlog_moved, backlog_remaining)
  ON public.subscription_plans TO authenticated;

DROP POLICY IF EXISTS "subscription_plans_select_members" ON public.subscription_plans;
CREATE POLICY "subscription_plans_select_members"
  ON public.subscription_plans FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

GRANT ALL ON TABLE public.subscription_plans TO service_role;

COMMENT ON TABLE public.subscription_plans IS
  'Short-lived (15 min), single-use snapshots of a subscriptions_scan. senders and progress are AES-256-GCM ciphertext (unsubscribe URLs and message ids). Written only by mcp-server with the service role.';

-- ---------------------------------------------------------------------------
-- unsubscribe_requests: one row per (inbox, sender, target), the ledger.
--
-- idempotency_key = HMAC(inbox, sender key, url or mailto), so the same
-- sender asked twice (a double click, a replayed call, a second scan) finds
-- its row instead of sending a second POST. No URL is stored: url_host is the
-- host alone (redactUnsubscribeUrl), and error is a fixed code.
--
-- check_after is requested_at + 72 h for `requested` and `draft_ready`; the
-- follow-up job sets checked_at and moves the status to stopped or
-- still_sending.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unsubscribe_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id         uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  plan_id          uuid REFERENCES public.subscription_plans(id) ON DELETE SET NULL,
  api_key_id       uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  sender_key       text NOT NULL CHECK (length(sender_key) BETWEEN 1 AND 600),
  sender_domain    text CHECK (sender_domain IS NULL OR length(sender_domain) <= 255),
  display_name     text CHECK (display_name IS NULL OR length(display_name) <= 200),
  -- What the follow-up searches for. The sender's address, not the user's.
  from_address     text CHECK (from_address IS NULL OR length(from_address) <= 320),
  method           text NOT NULL CHECK (method IN ('one_click', 'mailto', 'link', 'none')),
  status           text NOT NULL CHECK (status IN (
                     'pending', 'requested', 'failed', 'draft_ready', 'needs_user',
                     'filtered', 'skipped_unsafe', 'stopped', 'still_sending'
                   )),
  http_status      integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  error            text CHECK (error IS NULL OR length(error) <= 64),
  url_host         text CHECK (url_host IS NULL OR length(url_host) <= 255),
  -- Provider draft id for a mailto unsubscribe (never sent by us).
  draft_id         text CHECK (draft_id IS NULL OR length(draft_id) <= 1024),
  idempotency_key  text NOT NULL,
  requested_at     timestamptz,
  check_after      timestamptz,
  checked_at       timestamptz,
  check_leased_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unsubscribe_requests_idempotency_key_key UNIQUE (idempotency_key)
);

-- The follow-up scan: due rows not yet checked.
CREATE INDEX IF NOT EXISTS unsubscribe_requests_follow_up_idx
  ON public.unsubscribe_requests (check_after)
  WHERE checked_at IS NULL AND check_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS unsubscribe_requests_workspace_created_idx
  ON public.unsubscribe_requests (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS unsubscribe_requests_inbox_idx
  ON public.unsubscribe_requests (inbox_id);
CREATE INDEX IF NOT EXISTS unsubscribe_requests_plan_idx
  ON public.unsubscribe_requests (plan_id) WHERE plan_id IS NOT NULL;

ALTER TABLE public.unsubscribe_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.unsubscribe_requests FROM anon, authenticated;

GRANT SELECT (id, workspace_id, inbox_id, plan_id, api_key_id, sender_key, sender_domain,
              display_name, from_address, method, status, http_status, error, url_host,
              draft_id, requested_at, check_after, checked_at, created_at, updated_at)
  ON public.unsubscribe_requests TO authenticated;

DROP POLICY IF EXISTS "unsubscribe_requests_select_members" ON public.unsubscribe_requests;
CREATE POLICY "unsubscribe_requests_select_members"
  ON public.unsubscribe_requests FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

GRANT ALL ON TABLE public.unsubscribe_requests TO service_role;

COMMENT ON TABLE public.unsubscribe_requests IS
  'One row per unsubscribe attempt per (inbox, sender, target), keyed by an HMAC idempotency key so a replay never sends a second request. Holds the URL host only, never the URL. Written only by mcp-server with the service role.';

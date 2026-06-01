-- ============================================================
-- MCPEmails — Scheduled sends table + dispatcher cron entry
-- 20260603000001_create_scheduled_sends
-- ============================================================
--
-- Phase 7 foundation: a queue of emails to be sent at a future
-- time.  Rows are inserted by the `schedule_send` MCP tool (Task 18)
-- and consumed by the `scheduled-send-dispatcher` route on the
-- mcp-server Edge Function.
--
-- Design notes:
--   • `payload` stores the full send_email arguments as JSONB so
--     the dispatcher can reconstruct a SendEmailParams without
--     storing recipients in separate columns.
--   • Status lifecycle: pending → (sending) → sent | error | cancelled.
--     `sending` is a transient lock state set by the dispatcher before
--     attempting the send, preventing double-dispatch in concurrent
--     cron runs.
--   • Soft cancellation: status='cancelled' rows are never sent.
--     Hard-DELETE is not used; old rows are retained for audit.
--   • All writes from authenticated clients go through RLS-gated
--     INSERT/UPDATE policies; the dispatcher uses service_role
--     (bypassing RLS) to update status after send.
--   • Idempotent: uses IF NOT EXISTS and policy existence guards.
--
-- ── Dispatcher setup (human action required) ─────────────────
--   The pg_cron job below calls dispatch_scheduled_sends(), which
--   uses net.http_post to invoke the mcp-server /dispatch route.
--   Before this cron job will fire successfully you must:
--
--   1. Set the mcp-server base URL in DB config:
--        ALTER DATABASE postgres
--          SET "app.mcp_server_url" =
--            'https://<project-ref>.supabase.co/functions/v1/mcp-server';
--
--   2. Generate a random dispatch secret and set it in two places:
--        ALTER DATABASE postgres
--          SET "app.dispatch_secret" = '<random-hex-64>';
--      And add DISPATCH_SECRET=<same-value> to the mcp-server Edge
--      Function secrets in the Supabase dashboard.
--
--   These settings persist across restarts. Until they are configured
--   the cron job will fail silently (net.http_post returns an error
--   code that pg_cron logs but does not re-raise).
-- ============================================================

-- ── Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.scheduled_sends (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id     uuid        NOT NULL REFERENCES public.inboxes(id)    ON DELETE CASCADE,

  -- Full send_email arguments: to, cc, bcc, subject, body, html_body,
  -- attachments, reply_to.  Validated by the schedule_send tool before insert.
  payload      jsonb       NOT NULL,

  -- When to send.  The dispatcher picks rows with send_at <= now().
  send_at      timestamptz NOT NULL,

  -- Lifecycle: pending → sending (transient lock) → sent | error | cancelled.
  -- CHECK keeps the column self-documenting and prevents typos.
  status       text        NOT NULL DEFAULT 'pending'
    CONSTRAINT scheduled_sends_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'error', 'cancelled')),

  -- Populated on successful dispatch.
  sent_at      timestamptz,

  -- Populated on error.
  error_detail text,

  -- Standard audit columns.
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────

-- Primary dispatcher scan: due, pending rows ordered by send_at.
CREATE INDEX IF NOT EXISTS scheduled_sends_pending_idx
  ON public.scheduled_sends (send_at ASC)
  WHERE status = 'pending';

-- Workspace-scoped list (used by list_scheduled, Task 18).
CREATE INDEX IF NOT EXISTS scheduled_sends_workspace_idx
  ON public.scheduled_sends (workspace_id, send_at ASC)
  WHERE status IN ('pending', 'sending');

-- Per-inbox audit scan.
CREATE INDEX IF NOT EXISTS scheduled_sends_inbox_idx
  ON public.scheduled_sends (inbox_id, created_at DESC);

COMMENT ON TABLE public.scheduled_sends IS
  'Queue of emails scheduled for future delivery. '
  'Consumed by the mcp-server /dispatch route, called by pg_cron every minute.';
COMMENT ON COLUMN public.scheduled_sends.payload IS
  'Full send_email arguments (to, cc, bcc, subject, body, html_body, '
  'attachments, reply_to) stored as JSONB.';
COMMENT ON COLUMN public.scheduled_sends.status IS
  'Lifecycle: pending → sending (dispatcher lock) → sent | error | cancelled.';
COMMENT ON COLUMN public.scheduled_sends.error_detail IS
  'Provider or network error message captured on failure. Max 1 000 chars.';

-- ── Row-Level Security ────────────────────────────────────────────────────
--
-- SELECT: authenticated workspace members see their own scheduled sends.
-- INSERT: authenticated workspace members may schedule sends.
-- UPDATE (cancel only): members may set status='cancelled' on pending rows.
-- DELETE: not permitted — retain rows for audit.
-- All other writes (status→sending/sent/error, sent_at, error_detail)
-- come from the service_role dispatcher, which bypasses RLS.

ALTER TABLE public.scheduled_sends ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- SELECT policy
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'scheduled_sends'
      AND policyname = 'scheduled_sends_select_members'
  ) THEN
    CREATE POLICY "scheduled_sends_select_members"
      ON public.scheduled_sends FOR SELECT
      TO authenticated
      USING (workspace_id = ANY(public.my_workspace_ids()));
  END IF;

  -- INSERT policy: members may insert into their own workspaces
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'scheduled_sends'
      AND policyname = 'scheduled_sends_insert_members'
  ) THEN
    CREATE POLICY "scheduled_sends_insert_members"
      ON public.scheduled_sends FOR INSERT
      TO authenticated
      WITH CHECK (workspace_id = ANY(public.my_workspace_ids()));
  END IF;

  -- UPDATE policy: members may cancel their own pending scheduled sends
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'scheduled_sends'
      AND policyname = 'scheduled_sends_cancel_members'
  ) THEN
    CREATE POLICY "scheduled_sends_cancel_members"
      ON public.scheduled_sends FOR UPDATE
      TO authenticated
      USING (
        workspace_id = ANY(public.my_workspace_ids())
        AND status IN ('pending', 'sending')
      )
      WITH CHECK (status = 'cancelled');
  END IF;
END
$$;

-- ── pg_cron dispatcher job ────────────────────────────────────────────────
--
-- Runs every minute. Calls dispatch_scheduled_sends() which posts to the
-- mcp-server /dispatch route. The route validates X-Dispatch-Secret and
-- processes at most 50 pending rows per invocation.
--
-- Pre-requisites (see top-of-file comment):
--   app.mcp_server_url  and  app.dispatch_secret  must be set in the DB.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Helper function called by pg_cron ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dispatch_scheduled_sends()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    text;
  v_secret text;
BEGIN
  -- Read runtime config; fall back to empty string so the HTTP call
  -- fails with 401 rather than raising an exception that stops pg_cron.
  BEGIN
    v_url    := current_setting('app.mcp_server_url', true);
    v_secret := current_setting('app.dispatch_secret', true);
  EXCEPTION WHEN OTHERS THEN
    v_url    := '';
    v_secret := '';
  END;

  IF v_url IS NULL OR v_url = '' THEN
    RAISE WARNING 'dispatch_scheduled_sends: app.mcp_server_url is not set — skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', coalesce(v_secret, '')
               ),
    body    := '{}'::jsonb
  );
END;
$$;

COMMENT ON FUNCTION public.dispatch_scheduled_sends() IS
  'Called by pg_cron every minute. Posts to the mcp-server /dispatch route '
  'so the Edge Function can pick up and send pending scheduled_sends rows. '
  'Requires app.mcp_server_url and app.dispatch_secret to be set in the DB.';

-- Schedule: every minute.
-- cron.schedule is idempotent — re-running replaces the existing job.
SELECT cron.schedule(
  'dispatch-scheduled-sends',     -- job name
  '* * * * *',                    -- every minute
  'SELECT public.dispatch_scheduled_sends()'
);

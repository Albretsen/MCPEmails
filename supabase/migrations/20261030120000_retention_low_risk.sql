-- ============================================================
-- MCPEmails - retention for logs, send history and expired rows
-- 20261030120000_retention_low_risk
-- ============================================================
--
-- Nothing here changes what a customer sees. Every row it clears or deletes
-- is either past its own expiry, or a stored copy of something the product no
-- longer reads.
--
-- ── 1. purge_send_history() ───────────────────────────────────────────────
-- Also in self-host/db/00-schema.sql, word for word (no pg_cron there; run it
-- from your own scheduler).
--
--   scheduled_sends   payload (the encrypted message) replaced by '{}' when
--                     the row is sent, error or cancelled and was last
--                     touched more than 7 days ago. The row stays as the
--                     send record. Nothing reads a terminal row's payload:
--                     schedule_list, the morning brief and the dispatcher
--                     select pending/sending only, and the sent receipt is
--                     built at send time. Legacy plaintext rows
--                     (payload_encrypted = false) are cleared the same way;
--                     only the approval marker {"approval_id": ...}, which
--                     holds no message content, is left as it is.
--   send_approvals    a request still 'pending' a day after it expired is
--                     retired to 'expired', exactly as loadPendingApproval()
--                     retires one when it is next read. payload replaced by
--                     '{}' 7 days after the decision; for an approved request
--                     only once no pending/sending scheduled_sends row can
--                     still dispatch it (the dispatcher reads the approval's
--                     payload, and send_at may be weeks out). Rows older than
--                     90 days are deleted with the same guard. The dashboard
--                     lists the last 20 decided requests and reads summary,
--                     never payload.
--   outbound_idempotency  rows a day past expires_at. Every lookup filters
--                     expires_at > now(), so an expired row is already dead;
--                     it was only deleted when the same key came back.
--   bulk_plans        rows 7 days past expires_at, every status. Undo
--                     (mcp-app-undo.ts) already deletes its own rows at the
--                     same age; bulk_execute refuses an expired plan anyway.
--                     bulk_runs is not touched (the site feed sums it).
--
-- ── 2. purge_operational_history() gains ──────────────────────────────────
--   auth_logs         ip_address and user_agent set NULL after 30 days, rows
--                     deleted after a year. Nothing in the app reads the
--                     table. Two indexes keep the daily pass off a full scan.
--   sso_audit_events  ip_address and user_agent set NULL after 30 days (the
--                     SSO audit UI never selected them).
--   rate_limit_buckets  rows whose window started over 2 days ago. The
--                     longest window any caller passes to rate_limit_check()
--                     is a day (send-as.ts), so the window ended over a day
--                     ago, and a missing row behaves exactly like an expired
--                     one (a fresh window). Keys hold raw IPs.
--   and calls purge_send_history(). Same cron job as before
--   ('operational-history-retention', 04:50 UTC).
--
-- ── 3. Legacy activity_log client IP / User-Agent ─────────────────────────
-- Since 2026-10-20 mcp-server writes both as NULL (the triage runner keeps its
-- fixed 'mcp-emails-triage-runner' marker, which names no person). Older rows
-- still carry client values for up to 730 days. A self-unscheduling job walks
-- each monthly partition up to 2026-10 once, 10,000 heap blocks per run, by
-- ctid range (a TID range scan reads only those blocks), every 5 minutes. The
-- table has no created_at-only index, so a date-window walk would rescan a
-- whole partition per step. Progress is kept in maintenance_cursors. When the
-- last partition is done the job unschedules itself.
-- ============================================================

-- ── 1. purge_send_history ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_send_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_batch    constant integer := 1000;
  v_n        integer;
  v_sends    integer := 0;
  v_retired  integer := 0;
  v_cleared  integer := 0;
  v_deleted  integer := 0;
  v_idem     integer := 0;
  v_plans    integer := 0;
BEGIN
  -- scheduled_sends: message body of finished sends.
  LOOP
    UPDATE public.scheduled_sends
    SET    payload = '{}'::jsonb,
           payload_encrypted = true
    WHERE  id IN (
      SELECT s.id
      FROM   public.scheduled_sends s
      WHERE  s.status IN ('sent', 'error', 'cancelled')
        AND  s.updated_at < now() - interval '7 days'
        AND  s.payload <> '{}'::jsonb
        AND  NOT (s.payload_encrypted = false
                  AND jsonb_typeof(s.payload) = 'object'
                  AND s.payload ? 'approval_id')
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_sends := v_sends + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  -- send_approvals: retire requests that expired while nobody looked.
  UPDATE public.send_approvals
  SET    status = 'expired',
         decided_at = coalesce(expires_at, created_at + interval '24 hours')
  WHERE  status = 'pending'
    AND  coalesce(expires_at, created_at + interval '24 hours') < now() - interval '1 day';
  GET DIAGNOSTICS v_retired = ROW_COUNT;

  -- send_approvals: message body 7 days after the decision.
  LOOP
    UPDATE public.send_approvals
    SET    payload = '{}'::jsonb
    WHERE  id IN (
      SELECT a.id
      FROM   public.send_approvals a
      WHERE  a.status IN ('approved', 'rejected', 'cancelled', 'expired')
        AND  coalesce(a.decided_at, a.created_at) < now() - interval '7 days'
        AND  a.payload <> '{}'::jsonb
        AND  NOT EXISTS (
               SELECT 1 FROM public.scheduled_sends s
               WHERE  s.status IN ('pending', 'sending')
                 AND  (s.id = a.dispatch_scheduled_send_id
                       OR (s.payload_encrypted = false
                           AND jsonb_typeof(s.payload) = 'object'
                           AND s.payload ->> 'approval_id' = a.id::text))
             )
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_cleared := v_cleared + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  -- send_approvals: the record itself after 90 days.
  LOOP
    DELETE FROM public.send_approvals
    WHERE  id IN (
      SELECT a.id
      FROM   public.send_approvals a
      WHERE  a.status <> 'pending'
        AND  a.created_at < now() - interval '90 days'
        AND  NOT EXISTS (
               SELECT 1 FROM public.scheduled_sends s
               WHERE  s.status IN ('pending', 'sending')
                 AND  (s.id = a.dispatch_scheduled_send_id
                       OR (s.payload_encrypted = false
                           AND jsonb_typeof(s.payload) = 'object'
                           AND s.payload ->> 'approval_id' = a.id::text))
             )
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  LOOP
    DELETE FROM public.outbound_idempotency
    WHERE  id IN (
      SELECT id FROM public.outbound_idempotency
      WHERE  expires_at < now() - interval '1 day'
      LIMIT  c_batch * 5
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_idem := v_idem + v_n;
    EXIT WHEN v_n < c_batch * 5;
  END LOOP;

  LOOP
    DELETE FROM public.bulk_plans
    WHERE  id IN (
      SELECT id FROM public.bulk_plans
      WHERE  expires_at < now() - interval '7 days'
      LIMIT  c_batch * 5
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_plans := v_plans + v_n;
    EXIT WHEN v_n < c_batch * 5;
  END LOOP;

  RETURN jsonb_build_object(
    'scheduled_sends_cleared', v_sends,
    'send_approvals_retired', v_retired,
    'send_approvals_cleared', v_cleared,
    'send_approvals_deleted', v_deleted,
    'outbound_idempotency', v_idem,
    'bulk_plans', v_plans
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_send_history() FROM PUBLIC, anon, authenticated;

-- ── 2. auth_logs indexes + purge_operational_history ──────────────────────

-- Rows still holding an IP or user agent: about 30 days of rows at any time.
CREATE INDEX IF NOT EXISTS auth_logs_client_info_created_idx
  ON public.auth_logs (created_at)
  WHERE ip_address IS NOT NULL OR user_agent IS NOT NULL;
-- The one-year delete.
CREATE INDEX IF NOT EXISTS auth_logs_created_idx
  ON public.auth_logs (created_at);

-- Body of 20261020165137 kept as it was; the new steps follow it.
CREATE OR REPLACE FUNCTION public.purge_operational_history()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  c_batch   constant integer := 5000;
  v_n       integer;
  v_items   integer := 0;
  v_runs    integer := 0;
  v_tokens  integer := 0;
  v_monitor integer := 0;
  v_auth_scrubbed integer := 0;
  v_auth_deleted  integer := 0;
  v_sso     integer := 0;
  v_buckets integer := 0;
  v_first_monitor_run uuid;
  v_send_history jsonb;
BEGIN
  LOOP
    DELETE FROM public.triage_run_items
    WHERE id IN (
      SELECT i.id
      FROM public.triage_run_items i
      JOIN public.triage_runs r ON r.id = i.run_id
      WHERE r.started_at < now() - INTERVAL '90 days'
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_items := v_items + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  LOOP
    DELETE FROM public.triage_runs
    WHERE id IN (
      SELECT id FROM public.triage_runs
      WHERE started_at < now() - INTERVAL '90 days'
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_runs := v_runs + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  LOOP
    DELETE FROM public.oauth_refresh_tokens
    WHERE id IN (
      SELECT id FROM public.oauth_refresh_tokens
      WHERE revoked_at IS NOT NULL
        AND revoked_at < now() - INTERVAL '30 days'
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_tokens := v_tokens + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  SELECT id INTO v_first_monitor_run
  FROM public.synthetic_monitor_runs
  WHERE mode = 'read'
  ORDER BY started_at ASC
  LIMIT 1;

  LOOP
    DELETE FROM public.synthetic_monitor_runs
    WHERE id IN (
      SELECT r.id FROM public.synthetic_monitor_runs r
      WHERE r.started_at < now() - INTERVAL '35 days'
        AND r.id IS DISTINCT FROM v_first_monitor_run
        AND NOT EXISTS (
          SELECT 1 FROM public.synthetic_monitor_incidents x WHERE x.last_run_id = r.id
        )
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_monitor := v_monitor + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  -- auth_logs: client IP and user agent after 30 days, the row after a year.
  LOOP
    UPDATE public.auth_logs
    SET    ip_address = NULL, user_agent = NULL
    WHERE  id IN (
      SELECT id FROM public.auth_logs
      WHERE  (ip_address IS NOT NULL OR user_agent IS NOT NULL)
        AND  created_at < now() - INTERVAL '30 days'
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_auth_scrubbed := v_auth_scrubbed + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  LOOP
    DELETE FROM public.auth_logs
    WHERE  id IN (
      SELECT id FROM public.auth_logs
      WHERE  created_at < now() - INTERVAL '1 year'
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_auth_deleted := v_auth_deleted + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  -- sso_audit_events: a small table; one statement.
  UPDATE public.sso_audit_events
  SET    ip_address = NULL, user_agent = NULL
  WHERE  (ip_address IS NOT NULL OR user_agent IS NOT NULL)
    AND  created_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_sso = ROW_COUNT;

  -- rate_limit_buckets: windows that ended over a day ago. If a caller ever
  -- passes a window longer than a day, raise this to (that window + 1 day).
  LOOP
    DELETE FROM public.rate_limit_buckets
    WHERE  key IN (
      SELECT key FROM public.rate_limit_buckets
      WHERE  window_start < now() - INTERVAL '2 days'
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_buckets := v_buckets + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  v_send_history := public.purge_send_history();

  RETURN jsonb_build_object(
    'triage_run_items', v_items,
    'triage_runs', v_runs,
    'oauth_refresh_tokens', v_tokens,
    'synthetic_monitor_runs', v_monitor,
    'auth_logs_scrubbed', v_auth_scrubbed,
    'auth_logs_deleted', v_auth_deleted,
    'sso_audit_events_scrubbed', v_sso,
    'rate_limit_buckets', v_buckets
  ) || v_send_history;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_operational_history() FROM PUBLIC, anon, authenticated;

-- The cron job 'operational-history-retention' (20261020165137) already
-- calls purge_operational_history() daily at 04:50 UTC; nothing to schedule.

-- ── 3. Legacy activity_log client info ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.maintenance_cursors (
  job        text PRIMARY KEY,
  -- The partition being walked, and the next heap block to read in it.
  relname    text NOT NULL,
  next_block bigint NOT NULL DEFAULT 0,
  done_at    timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.maintenance_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maintenance_cursors FROM anon, authenticated;

COMMENT ON TABLE public.maintenance_cursors IS
  'Progress of one-off maintenance walks (no personal data). Internal; no policies, so only the owner and service role see it.';

-- '' sorts before every partition name, so the first run starts at the oldest.
INSERT INTO public.maintenance_cursors (job, relname, next_block)
VALUES ('activity_log_legacy_client_info', '', 0)
ON CONFLICT (job) DO NOTHING;

CREATE OR REPLACE FUNCTION public.scrub_legacy_activity_log_client_info(
  p_blocks integer DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  -- The last partition that can hold a client value: writes stopped 2026-10-20.
  c_last_partition constant text := 'activity_log_2026_10';
  c_job constant text := 'activity_log_legacy_client_info';
  v_cur     public.maintenance_cursors%ROWTYPE;
  v_part    text;
  v_from    bigint;
  v_blocks  bigint;
  v_n       bigint := 0;
BEGIN
  SELECT * INTO v_cur FROM public.maintenance_cursors WHERE job = c_job FOR UPDATE;
  IF NOT FOUND OR v_cur.done_at IS NOT NULL THEN
    BEGIN
      PERFORM cron.unschedule('activity-log-legacy-client-info-scrub');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('done', true);
  END IF;

  v_part := nullif(v_cur.relname, '');
  v_from := v_cur.next_block;

  -- Move to the next partition when there is none yet or this one is walked.
  IF v_part IS NOT NULL THEN
    v_blocks := pg_relation_size(format('public.%I', v_part)::regclass)
                / current_setting('block_size')::bigint;
  END IF;
  IF v_part IS NULL OR v_from >= v_blocks THEN
    SELECT c.relname INTO v_part
    FROM   pg_inherits i
    JOIN   pg_class c ON c.oid = i.inhrelid
    JOIN   pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE  i.inhparent = 'public.activity_log'::regclass
      AND  c.relname > coalesce(nullif(v_cur.relname, ''), '')
      AND  c.relname ~ '^activity_log_[0-9]{4}_[0-9]{2}$'
      AND  c.relname <= c_last_partition
    ORDER  BY c.relname
    LIMIT  1;

    IF v_part IS NULL THEN
      UPDATE public.maintenance_cursors
      SET    done_at = now(), updated_at = now()
      WHERE  job = c_job;
      BEGIN
        PERFORM cron.unschedule('activity-log-legacy-client-info-scrub');
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      RETURN jsonb_build_object('done', true);
    END IF;
    v_from := 0;
    v_blocks := pg_relation_size(format('public.%I', v_part)::regclass)
                / current_setting('block_size')::bigint;
  END IF;

  IF v_blocks > 0 THEN
    EXECUTE format(
      'UPDATE public.%I SET ip_address = NULL, user_agent = NULL
        WHERE ctid >= %L::tid AND ctid < %L::tid
          AND (ip_address IS NOT NULL
               OR (user_agent IS NOT NULL AND user_agent <> %L))',
      v_part,
      format('(%s,0)', v_from),
      format('(%s,0)', v_from + p_blocks),
      'mcp-emails-triage-runner'
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;

  UPDATE public.maintenance_cursors
  SET    relname = v_part,
         next_block = v_from + p_blocks,
         updated_at = now()
  WHERE  job = c_job;

  RETURN jsonb_build_object('partition', v_part, 'from_block', v_from, 'rows', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_legacy_activity_log_client_info(integer) FROM PUBLIC, anon, authenticated;

-- Every 5 minutes until done; the function unschedules the job itself.
-- Updated rows that land in a block not yet walked fail the WHERE (both
-- columns are NULL by then), so a partition is never processed twice.
SELECT cron.schedule(
  'activity-log-legacy-client-info-scrub',
  '*/5 * * * *',
  $$SELECT public.scrub_legacy_activity_log_client_info()$$
);

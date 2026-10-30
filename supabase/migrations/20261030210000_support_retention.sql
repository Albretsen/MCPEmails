-- ============================================================
-- MCPEmails - retention for help feedback votes and signed-out tickets
-- 20261030210000_support_retention
-- ============================================================
--
-- ── 1. purge_support_history() ────────────────────────────────────────────
--   help_article_feedback  votes keyed by a hashed IP (voter_key 'ip:...')
--                     are deleted 180 days after the vote was last cast.
--                     Signed-in votes ('u:...') go with the user (ON DELETE
--                     CASCADE) and are not touched here.
--   support_tickets   tickets with no account behind them (user_id IS NULL)
--                     are scrubbed 730 days after they were filed, the same
--                     way purge_deleted_accounts() (20261030130000) scrubs a
--                     deleted user's tickets: email 'deleted@invalid',
--                     subject and message '[deleted]', context '{}', ip_hash
--                     NULL. The row stays, so refs and counts by category
--                     keep working. user_id is also NULL once the account
--                     behind a signed-in ticket is deleted; those rows were
--                     scrubbed at deletion and are skipped (already scrubbed).
--
-- ── 2. purge_operational_history() calls it ───────────────────────────────
-- Same daily cron job as before ('operational-history-retention', 04:50 UTC,
-- 20261020165137); nothing new is scheduled. The body is the one from
-- 20261030120000 with one extra call; its result gains two keys.
--
-- Not in self-host/db/00-schema.sql: neither table exists there (both are
-- written only by the web app).
--
-- Forward-only, re-runnable. Apply with the normal migration workflow (never
-- `db push` on production).
-- ============================================================

-- ── 1. purge_support_history ──────────────────────────────────────────────

-- The 180-day delete: only IP-keyed votes, by last vote.
CREATE INDEX IF NOT EXISTS help_article_feedback_ip_votes_updated_idx
  ON public.help_article_feedback (updated_at)
  WHERE voter_key LIKE 'ip:%';

-- The 730-day scrub: signed-out tickets not yet scrubbed.
CREATE INDEX IF NOT EXISTS support_tickets_no_account_created_idx
  ON public.support_tickets (created_at)
  WHERE user_id IS NULL AND email <> 'deleted@invalid';

CREATE OR REPLACE FUNCTION public.purge_support_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_batch    constant integer := 1000;
  v_n        integer;
  v_votes    integer := 0;
  v_tickets  integer := 0;
BEGIN
  LOOP
    DELETE FROM public.help_article_feedback
    WHERE  id IN (
      SELECT f.id
      FROM   public.help_article_feedback f
      WHERE  f.voter_key LIKE 'ip:%'
        AND  f.updated_at < now() - interval '180 days'
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_votes := v_votes + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  LOOP
    UPDATE public.support_tickets
    SET    email = 'deleted@invalid',
           subject = '[deleted]',
           message = '[deleted]',
           context = '{}'::jsonb,
           ip_hash = NULL
    WHERE  id IN (
      SELECT t.id
      FROM   public.support_tickets t
      WHERE  t.user_id IS NULL
        AND  t.email <> 'deleted@invalid'
        AND  t.created_at < now() - interval '730 days'
      LIMIT  c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_tickets := v_tickets + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  RETURN jsonb_build_object(
    'help_article_feedback_ip_votes_deleted', v_votes,
    'support_tickets_no_account_scrubbed', v_tickets
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_support_history() FROM PUBLIC, anon, authenticated;

-- ── 2. purge_operational_history ──────────────────────────────────────────

-- Body of 20261030120000 kept as it was; only the purge_support_history()
-- call and its keys are new.
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
  v_support_history jsonb;
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
  v_support_history := public.purge_support_history();

  RETURN jsonb_build_object(
    'triage_run_items', v_items,
    'triage_runs', v_runs,
    'oauth_refresh_tokens', v_tokens,
    'synthetic_monitor_runs', v_monitor,
    'auth_logs_scrubbed', v_auth_scrubbed,
    'auth_logs_deleted', v_auth_deleted,
    'sso_audit_events_scrubbed', v_sso,
    'rate_limit_buckets', v_buckets
  ) || v_send_history || v_support_history;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_operational_history() FROM PUBLIC, anon, authenticated;

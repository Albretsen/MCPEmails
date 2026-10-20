-- activity_log retention per plan.
--
-- Replaces the flat pg_cron job `activity-log-retention`, which deleted every
-- activity_log row older than 90 days on every plan. The product sells a
-- per-plan history window (apps/web/src/lib/stripe/plans.ts,
-- analyticsRetentionDays), and Pro and Business now sell two years, so the
-- flat 90-day delete would have destroyed exactly the history they pay for.
-- Plan windows:
--
--   free      30 days
--   personal  90 days
--   solo      730 days  (sold as "Pro")
--   pro       730 days  (sold as "Business"; legacy Team rows carry this slug)
--   anything else, or a workspace that cannot be resolved: 730 days
--
-- The plan is resolved the way effective_workspace_plan() resolves it (an
-- active comped_scale grant counts as 'pro'), inlined here because that
-- function is gated on my_workspace_ids() and returns nothing to pg_cron.
-- The 2026-08-19 inbox grandfather and the Pro inbox-cap exemption change
-- inbox limits only, never the plan, so they do not affect the window.
--
-- STORAGE FLOOR (p_min_days, default 90). No row is deleted before
-- p_min_days, whatever its plan window. The admin growth board, the kiosk and
-- the experiment read-outs all assume 90 days of activity for EVERY workspace
-- (see components/admin/kiosk/windows.ts); deleting Free rows at 30 days
-- would make their 31-90 day stretch look like a collapse. So the job ships
-- at 90, which deletes nothing that the old job kept, and Free rows past 30
-- days are hidden from the customer by the dashboard window rather than
-- deleted. Lowering the floor to 30 is one cron change:
--   SELECT cron.schedule('activity-log-retention', '0 2 * * *',
--     'CALL public.purge_activity_log_by_plan(p_min_days => 30)');
-- It is clamped to 30, the smallest window any plan sells.
--
-- AUDIT FLOOR. The dashboard's Security audit log reads these same rows. A
-- mailbox-changing call (send, delete, move, forward, automation edits, ...)
-- is security evidence, so it is never deleted before 90 days on any plan,
-- even if the storage floor is lowered. Only calls on the read-only list
-- below may go sooner. A tool name not on that list is treated as
-- mailbox-changing, so a new tool is kept rather than lost. Security events
-- proper (auth_logs, OAuth grants) live in other tables and are not touched.
--
-- Deletes run in short batches (10k rows, one COMMIT each) from a procedure,
-- so no single statement holds locks or produces a large IO burst.
--
-- Re-runnable: CREATE OR REPLACE throughout, and cron.schedule replaces a job
-- of the same name.

-- ---------------------------------------------------------------------------
-- 1. Window per plan slug, in days. Keep in sync with plans.ts.
--    The two helpers below touch no tables and carry no SET clause, so the
--    planner can inline them into the per-row filter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_log_retention_window_days(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free' THEN 30
    WHEN 'personal' THEN 90
    WHEN 'solo' THEN 730
    WHEN 'pro' THEN 730
    ELSE 730
  END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Read-only tool calls. Everything else gets the 90-day audit floor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_log_tool_is_read_only(p_tool text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_tool = ANY (ARRAY[
    'automation_get', 'automation_list', 'automation_preview',
    'automation_read', 'automation_runs', 'contact_search', 'draft_list',
    'draft_read', 'email_attachment', 'email_extract', 'email_folders',
    'email_list', 'email_original', 'email_read', 'email_read_batch',
    'email_search', 'folder_list', 'inbox_list', 'list_emails',
    'message_search', 'schedule_list', 'search_emails', 'signature_get'
  ]);
$$;

-- ---------------------------------------------------------------------------
-- 3. Effective plan and window for every workspace.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_log_retention_workspace_windows()
RETURNS TABLE (workspace_id uuid, plan text, days integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    w.id,
    r.plan,
    public.activity_log_retention_window_days(r.plan)
  FROM public.workspaces w
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now())
        THEN 'pro'
      ELSE w.plan
    END AS plan
  ) r;
$$;

-- ---------------------------------------------------------------------------
-- 4. One batch: delete up to p_limit rows past their window. Returns the
--    number deleted. A row's age limit is
--      read-only call:   max(plan window, storage floor)
--      any other call:   max(plan window, storage floor, 90)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_activity_log_batch(
  p_limit integer DEFAULT 10000,
  p_min_days integer DEFAULT 90
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_floor integer := GREATEST(COALESCE(p_min_days, 90), 30);
  v_deleted integer;
BEGIN
  WITH win AS (
    SELECT * FROM public.activity_log_retention_workspace_windows()
  ),
  victims AS (
    SELECT a.id, a.created_at
    FROM public.activity_log a
    LEFT JOIN win ON win.workspace_id = a.workspace_id
    -- The floor as a plain bound lets the planner skip recent partitions.
    WHERE a.created_at < now() - make_interval(days => v_floor)
      AND a.created_at < now() - make_interval(days =>
        CASE
          WHEN public.activity_log_tool_is_read_only(a.tool_name)
            THEN GREATEST(COALESCE(win.days, 730), v_floor)
          ELSE GREATEST(COALESCE(win.days, 730), v_floor, 90)
        END)
    LIMIT GREATEST(COALESCE(p_limit, 10000), 1)
  )
  DELETE FROM public.activity_log a
  USING victims v
  WHERE a.id = v.id AND a.created_at = v.created_at;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The job: batches with a COMMIT between each. A procedure, not a
--    function, so each batch is its own transaction. It must not be
--    SECURITY DEFINER or carry SET clauses, or COMMIT is refused; it runs as
--    the cron owner and calls the definer function above.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.purge_activity_log_by_plan(
  p_batch integer DEFAULT 10000,
  p_max_batches integer DEFAULT 500,
  p_min_days integer DEFAULT 90
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer;
  v_total bigint := 0;
  v_batches integer := 0;
BEGIN
  LOOP
    v_n := public.purge_activity_log_batch(p_batch, p_min_days);
    v_total := v_total + v_n;
    v_batches := v_batches + 1;
    COMMIT;
    EXIT WHEN v_n < p_batch OR v_batches >= p_max_batches;
    PERFORM pg_sleep(0.2);
  END LOOP;
  RAISE LOG 'purge_activity_log_by_plan: deleted % rows in % batches', v_total, v_batches;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Read-only preview: what the purge would delete right now, per plan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_log_retention_preview(p_min_days integer DEFAULT 90)
RETURNS TABLE (
  plan text,
  window_days integer,
  rows_total bigint,
  rows_to_delete bigint,
  rows_kept_by_audit_floor bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH f AS (
    SELECT GREATEST(COALESCE(p_min_days, 90), 30) AS floor_days
  ),
  win AS (
    SELECT * FROM public.activity_log_retention_workspace_windows()
  ),
  r AS (
    SELECT
      COALESCE(win.plan, '(unresolved)') AS plan,
      COALESCE(win.days, 730) AS days,
      a.created_at,
      public.activity_log_tool_is_read_only(a.tool_name) AS read_only
    FROM public.activity_log a
    LEFT JOIN win ON win.workspace_id = a.workspace_id
  )
  SELECT
    r.plan,
    r.days,
    count(*),
    count(*) FILTER (WHERE r.created_at < now() - make_interval(days =>
      CASE WHEN r.read_only THEN GREATEST(r.days, f.floor_days)
           ELSE GREATEST(r.days, f.floor_days, 90) END)),
    count(*) FILTER (WHERE NOT r.read_only
      AND r.created_at < now() - make_interval(days => GREATEST(r.days, f.floor_days))
      AND r.created_at >= now() - make_interval(days => GREATEST(r.days, f.floor_days, 90)))
  FROM r CROSS JOIN f
  GROUP BY r.plan, r.days
  ORDER BY r.plan;
$$;

-- None of these are for API roles.
REVOKE ALL ON FUNCTION public.activity_log_retention_workspace_windows() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_activity_log_batch(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON PROCEDURE public.purge_activity_log_by_plan(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activity_log_retention_preview(integer) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Replace the flat 90-day job. Same name and time (02:00 UTC daily).
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'activity-log-retention',
  '0 2 * * *',
  'CALL public.purge_activity_log_by_plan()'
);

-- -----------------------------------------------------------------------------
-- Fix growth_error_breakdown: roll legacy per-action tool names up to the
-- consolidated tool a client actually calls.
--
-- activity_log records the *resolved* legacy action name on every row that
-- reaches a handler (e.g. an email_compose/send call logs as "email_send"),
-- but a call whose `action` argument never resolves (missing or invalid)
-- fails before resolution and logs under the raw consolidated name instead
-- (e.g. "email_compose"). That's the right behavior for the log itself, but
-- it means growth_error_breakdown's per-tool_name grouping put those two
-- populations in different buckets: every success for a consolidated tool
-- lands under its legacy child name, while its unresolved-action failures
-- are the *only* rows ever logged under the consolidated name itself. A
-- tool_name grouped strictly on activity_log.tool_name therefore always
-- shows 100% failure for any consolidated tool that ever had an
-- unresolved-action call, regardless of how well it's actually performing
-- (e.g. "email_compose: 30/30 failed" while the same key sent 462 emails
-- successfully through it, logged as "email_send").
--
-- growth_public_tool_name() maps every legacy dispatch name back to the
-- consolidated tool name a caller actually invokes (see CONSOLIDATED_SPECS
-- in supabase/functions/mcp-server/index.ts, the source of truth this
-- mirrors); names with no consolidated parent (inbox_list, contact_search)
-- pass through unchanged. growth_error_breakdown then computes both the
-- failure counts and the call-volume denominator on that rolled-up name, so
-- the failure rate reflects the tool surface a client sees.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.growth_public_tool_name(p_tool_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_tool_name
    WHEN 'email_list' THEN 'email_read'
    WHEN 'email_read' THEN 'email_read'
    WHEN 'email_read_batch' THEN 'email_read'
    WHEN 'email_search' THEN 'email_read'
    WHEN 'email_attachment' THEN 'email_read'
    WHEN 'email_extract' THEN 'email_read'
    WHEN 'email_original' THEN 'email_read'
    WHEN 'email_move' THEN 'email_organize'
    WHEN 'email_move_batch' THEN 'email_organize'
    WHEN 'email_copy' THEN 'email_organize'
    WHEN 'email_copy_batch' THEN 'email_organize'
    WHEN 'email_flag' THEN 'email_organize'
    WHEN 'email_archive' THEN 'email_organize'
    WHEN 'email_search_and_move' THEN 'email_organize'
    WHEN 'email_delete' THEN 'email_delete'
    WHEN 'email_delete_batch' THEN 'email_delete'
    WHEN 'email_search_and_delete' THEN 'email_delete'
    WHEN 'email_send' THEN 'email_compose'
    WHEN 'email_reply' THEN 'email_compose'
    WHEN 'email_forward' THEN 'email_compose'
    WHEN 'folder_list' THEN 'folder'
    WHEN 'folder_create' THEN 'folder'
    WHEN 'folder_rename' THEN 'folder'
    WHEN 'folder_delete' THEN 'folder'
    WHEN 'draft_list' THEN 'draft'
    WHEN 'draft_create' THEN 'draft'
    WHEN 'draft_reply' THEN 'draft'
    WHEN 'draft_update' THEN 'draft'
    WHEN 'draft_send' THEN 'draft'
    WHEN 'draft_delete' THEN 'draft'
    WHEN 'schedule_create' THEN 'schedule'
    WHEN 'schedule_list' THEN 'schedule'
    WHEN 'schedule_cancel' THEN 'schedule'
    WHEN 'signature_get' THEN 'signature'
    WHEN 'signature_set' THEN 'signature'
    ELSE p_tool_name
  END;
$$;

REVOKE ALL ON FUNCTION public.growth_public_tool_name(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_public_tool_name(text) TO service_role;

CREATE OR REPLACE FUNCTION public.growth_error_breakdown(p_days int)
RETURNS TABLE (
  tool_name text,
  error_code text,
  failures int,
  calls int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  windowed AS (
    SELECT public.growth_public_tool_name(a.tool_name) AS tool_name, a.status, a.error_code
    FROM public.activity_log a, bounds b
    WHERE a.created_at >= b.window_start
  ),
  tool_totals AS (
    SELECT w.tool_name AS tool_name, count(*) AS calls
    FROM windowed w
    GROUP BY w.tool_name
  ),
  failures AS (
    SELECT w.tool_name AS tool_name, w.error_code AS error_code, count(*) AS failures
    FROM windowed w
    WHERE w.status <> 'success'
    GROUP BY w.tool_name, w.error_code
  )
  SELECT
    f.tool_name,
    f.error_code,
    f.failures::int,
    t.calls::int
  FROM failures f
  JOIN tool_totals t ON t.tool_name = f.tool_name
  ORDER BY f.failures DESC, f.tool_name, f.error_code
  LIMIT 20;
$$;

REVOKE ALL ON FUNCTION public.growth_error_breakdown(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_error_breakdown(int) TO service_role;

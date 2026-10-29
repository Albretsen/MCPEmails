-- ===========================================================================
-- Draft card band, measured per draft instead of per event.
-- 20261027200000_draft_card_stats_linked
--
-- The first read-out (20261027120000_draft_events) compared every send in a
-- window against the drafts made in it. Three things made that misleading on
-- release day:
--
--   * Sends of older drafts counted against new ones, so Claude Code read 100%
--     "sent per draft" on 11 new drafts and 9 sends of drafts made days before.
--   * One workspace could be a whole family: a Codex workspace made 726 of the
--     750 "other" drafts in three hours, another made 92 of its 97 sends.
--   * The client names `claude-ai` and `Claude` fell through to "other".
--
-- THE SEND RATE NOW FOLLOWS EACH DRAFT. draft_lineage opens one line per new
-- draft (draft-lineage.ts) and closes it as sent or deleted, so a line opened
-- in the window that closed as sent within 24 hours is a draft that was sent.
-- Only lines at least 24 hours old count, so a draft from this morning is not
-- read as unsent. Lines opened by the send itself (an untracked older draft,
-- closeDraftLine's adopt) open and close at the same instant and are left out.
-- draft_lineage has no key, so a line takes the family its workspace drafted
-- with most in that window (draft_events). Lines start 2026-10-13; a window
-- reaching further back counts only the drafts that have one.
--
-- NO WORKSPACE OUTWEIGHS 20 DRAFTS (50 tool calls). A workspace with more is
-- scaled down to that weight, keeping its own rates, so the rates read as
-- "what a typical workspace does" rather than "what the busiest one does".
-- The raw counts stay alongside for the Drafts column.
--
-- Forward-only, re-runnable, one transaction. Apply with
-- `npx supabase db query --linked -f` and `migration repair` (never db push).
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.growth_client_family(p_client_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN p_client_name ILIKE 'Anthropic/%' THEN 'claude'
    -- Older Claude desktop and claude.ai builds.
    WHEN p_client_name ILIKE 'claude-ai%' OR p_client_name = 'Claude' THEN 'claude'
    WHEN p_client_name ILIKE 'claude-code%' THEN 'claude_code'
    WHEN p_client_name = 'openai-mcp' THEN 'chatgpt'
    ELSE 'other'
  END;
$fn$;

-- The return type changes, so the old one goes first.
DROP FUNCTION IF EXISTS public.growth_draft_card_stats(integer, timestamptz, text[], text[]);

CREATE FUNCTION public.growth_draft_card_stats(
  p_days             integer,
  p_release_at       timestamptz DEFAULT NULL,
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  period          text,
  family          text,
  -- Raw event counts, as before.
  drafted         bigint,
  drafted_card    bigint,
  saved           bigint,
  sent_card       bigint,
  sent_agent      bigint,
  deleted_card    bigint,
  deleted_agent   bigint,
  hidden          bigint,
  workspaces      bigint,
  card_workspaces bigint,
  calls           bigint,
  errors          bigint,
  -- Per draft (draft_lineage lines opened in the window), each workspace
  -- weighted to at most 20 lines. `lines` is the raw count.
  lines           bigint,
  w_lines         numeric,
  w_touched       numeric,
  w_deleted       numeric,
  mature_lines    bigint,
  w_mature        numeric,
  w_sent_day      numeric,
  -- Tool calls, each workspace weighted to at most 50.
  w_calls         numeric,
  w_errors        numeric,
  eligible_card   bigint,
  returned_card   bigint,
  eligible_plain  bigint,
  returned_plain  bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT 'before'::text AS period,
           COALESCE(p_release_at, now()) - make_interval(days => GREATEST(LEAST(p_days, 90), 1)) AS t0,
           COALESCE(p_release_at, now()) AS t1
    UNION ALL
    SELECT 'after', GREATEST(p_release_at, now() - interval '90 days'), now()
    WHERE p_release_at IS NOT NULL AND p_release_at < now()
  ),
  customer AS (
    SELECT w.id
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    WHERE NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  key_family AS (
    SELECT DISTINCT ON (c.api_key_id)
           c.api_key_id, public.growth_client_family(c.client_name) AS family
    FROM public.mcp_client_capabilities c
    ORDER BY c.api_key_id, c.last_seen DESC
  ),
  ev AS (
    SELECT b.period, COALESCE(kf.family, 'other') AS family, e.*
    FROM bounds b
    JOIN public.draft_events e ON e.occurred_at >= b.t0 AND e.occurred_at < b.t1
    JOIN customer c ON c.id = e.workspace_id
    LEFT JOIN key_family kf ON kf.api_key_id = e.api_key_id
  ),
  counts AS (
    SELECT
      period, family,
      count(*) FILTER (WHERE event = 'drafted') AS drafted,
      count(*) FILTER (WHERE event = 'drafted' AND card_offered) AS drafted_card,
      count(*) FILTER (WHERE event = 'saved') AS saved,
      count(*) FILTER (WHERE event = 'sent' AND via_card) AS sent_card,
      count(*) FILTER (WHERE event = 'sent' AND NOT via_card) AS sent_agent,
      count(*) FILTER (WHERE event = 'deleted' AND via_card) AS deleted_card,
      count(*) FILTER (WHERE event = 'deleted' AND NOT via_card) AS deleted_agent,
      count(*) FILTER (WHERE event = 'hidden') AS hidden,
      count(DISTINCT workspace_id) FILTER (WHERE event = 'drafted') AS workspaces,
      count(DISTINCT workspace_id) FILTER (WHERE via_card) AS card_workspaces
    FROM ev
    GROUP BY period, family
  ),
  -- The family each workspace drafted with most in the window.
  ws_family AS (
    SELECT DISTINCT ON (period, workspace_id) period, workspace_id, family
    FROM ev
    WHERE event = 'drafted'
    GROUP BY period, workspace_id, family
    ORDER BY period, workspace_id, count(*) DESC, family
  ),
  line_first AS (
    SELECT DISTINCT ON (l.line_id) l.line_id, l.workspace_id, l.written_at, l.written_by
    FROM public.draft_lineage l
    JOIN customer c ON c.id = l.workspace_id
    WHERE l.written_at >= (SELECT min(t0) FROM bounds)
    ORDER BY l.line_id, l.revision
  ),
  line_end AS (
    SELECT l.line_id, max(l.closed_at) AS closed_at, max(l.closed_reason) AS closed_reason
    FROM public.draft_lineage l
    WHERE l.line_id IN (SELECT line_id FROM line_first)
    GROUP BY l.line_id
  ),
  card_touched AS (
    SELECT DISTINCT e.line_id
    FROM public.draft_events e
    WHERE e.via_card AND e.line_id IS NOT NULL
  ),
  lines AS (
    SELECT b.period, COALESCE(wf.family, 'other') AS family, f.workspace_id,
           (f.written_at <= now() - interval '24 hours') AS mature,
           (le.closed_reason LIKE 'sent%' AND le.closed_at <= f.written_at + interval '24 hours') AS sent_day,
           (le.closed_reason = 'deleted') AS deleted,
           (ct.line_id IS NOT NULL) AS touched
    FROM line_first f
    JOIN line_end le USING (line_id)
    JOIN bounds b ON f.written_at >= b.t0 AND f.written_at < b.t1
    LEFT JOIN ws_family wf ON wf.period = b.period AND wf.workspace_id = f.workspace_id
    LEFT JOIN card_touched ct ON ct.line_id = f.line_id
    WHERE f.written_by = 'agent'
      AND f.written_at IS DISTINCT FROM le.closed_at
  ),
  lines_ws AS (
    SELECT period, family, workspace_id,
           count(*) AS n,
           count(*) FILTER (WHERE touched) AS touched,
           count(*) FILTER (WHERE deleted) AS deleted,
           count(*) FILTER (WHERE mature) AS mature,
           count(*) FILTER (WHERE mature AND sent_day) AS sent_day
    FROM lines
    GROUP BY 1, 2, 3
  ),
  lines_agg AS (
    SELECT period, family,
           sum(n) AS lines,
           sum(n * LEAST(1, 20.0 / n)) AS w_lines,
           sum(touched * LEAST(1, 20.0 / n)) AS w_touched,
           sum(deleted * LEAST(1, 20.0 / n)) AS w_deleted,
           sum(mature) AS mature_lines,
           sum(mature * LEAST(1, 20.0 / NULLIF(mature, 0))) AS w_mature,
           sum(sent_day * LEAST(1, 20.0 / NULLIF(mature, 0))) AS w_sent_day
    FROM lines_ws
    GROUP BY 1, 2
  ),
  calls_ws AS (
    SELECT b.period, COALESCE(kf.family, 'other') AS family, a.workspace_id,
           count(*) AS calls,
           count(*) FILTER (WHERE a.status = 'error') AS errors
    FROM bounds b
    JOIN public.activity_log a ON a.created_at >= b.t0 AND a.created_at < b.t1
    JOIN customer c ON c.id = a.workspace_id
    LEFT JOIN key_family kf ON kf.api_key_id = a.api_key_id
    WHERE a.tool_name LIKE 'draft%'
    GROUP BY 1, 2, 3
  ),
  calls AS (
    SELECT period, family,
           sum(calls) AS calls,
           sum(errors) AS errors,
           sum(calls * LEAST(1, 50.0 / calls)) AS w_calls,
           sum(errors * LEAST(1, 50.0 / calls)) AS w_errors
    FROM calls_ws
    GROUP BY 1, 2
  ),
  ws AS (
    SELECT period, family, workspace_id,
           min(occurred_at) FILTER (WHERE event = 'drafted') AS first_draft,
           bool_or(via_card) AS used_card
    FROM ev
    GROUP BY period, family, workspace_id
  ),
  returned AS (
    SELECT ws.period, ws.family,
           count(*) FILTER (WHERE ws.used_card) AS eligible_card,
           count(*) FILTER (WHERE ws.used_card AND r.back) AS returned_card,
           count(*) FILTER (WHERE NOT ws.used_card) AS eligible_plain,
           count(*) FILTER (WHERE NOT ws.used_card AND r.back) AS returned_plain
    FROM ws
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM public.activity_log a
        WHERE a.workspace_id = ws.workspace_id
          AND a.created_at >= ws.first_draft + interval '7 days'
          AND a.created_at < ws.first_draft + interval '14 days'
      ) AS back
    ) r
    WHERE ws.first_draft IS NOT NULL AND ws.first_draft <= now() - interval '14 days'
    GROUP BY 1, 2
  )
  SELECT
    k.period, k.family,
    COALESCE(n.drafted, 0), COALESCE(n.drafted_card, 0),
    COALESCE(n.saved, 0), COALESCE(n.sent_card, 0), COALESCE(n.sent_agent, 0),
    COALESCE(n.deleted_card, 0), COALESCE(n.deleted_agent, 0), COALESCE(n.hidden, 0),
    COALESCE(n.workspaces, 0), COALESCE(n.card_workspaces, 0),
    COALESCE(cl.calls, 0), COALESCE(cl.errors, 0),
    COALESCE(li.lines, 0)::bigint, round(COALESCE(li.w_lines, 0), 2), round(COALESCE(li.w_touched, 0), 2),
    round(COALESCE(li.w_deleted, 0), 2), COALESCE(li.mature_lines, 0)::bigint,
    round(COALESCE(li.w_mature, 0), 2), round(COALESCE(li.w_sent_day, 0), 2),
    round(COALESCE(cl.w_calls, 0), 2), round(COALESCE(cl.w_errors, 0), 2),
    COALESCE(r.eligible_card, 0), COALESCE(r.returned_card, 0),
    COALESCE(r.eligible_plain, 0), COALESCE(r.returned_plain, 0)
  FROM (
    SELECT period, family FROM counts
    UNION SELECT period, family FROM calls
    UNION SELECT period, family FROM lines_agg
  ) k
  LEFT JOIN counts n USING (period, family)
  LEFT JOIN calls cl USING (period, family)
  LEFT JOIN lines_agg li USING (period, family)
  LEFT JOIN returned r USING (period, family)
  ORDER BY k.period, k.family;
$$;

REVOKE ALL ON FUNCTION public.growth_draft_card_stats(integer, timestamptz, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_draft_card_stats(integer, timestamptz, text[], text[]) TO service_role;

COMMIT;

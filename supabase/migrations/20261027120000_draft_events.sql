-- ===========================================================================
-- Draft events: what happens to drafts, and whether it happened in the draft
-- editor card, kept long enough to judge the card's release.
-- 20261027120000_draft_events
--
-- Written by the `mcp-server` edge function only
-- (supabase/functions/mcp-server/draft-events.ts, which lists every event and
-- where it is recorded). Read by the growth board's "Draft card" band through
-- the three growth_draft_card_* functions below.
--
-- WHY A NEW TABLE. draft_card_activity deletes rows after 7 days, activity_log
-- logs a card Send under the same name as a model's send and is purged by
-- plan, and draft_lineage keeps who wrote last, not who sent. None of them can
-- say "of the drafts Claude made in November, how many were sent from the
-- card" a month later.
--
-- WHAT IS STORED, AND WHAT IS NOT. Ids (workspace, inbox, key, lineage line),
-- the event name, two booleans and a time. No subject, address, body, draft id
-- or hash of one, and no column that could hold one.
--
-- KEY AND INBOX DELETES KEEP THE ROW (SET NULL): the board counts history, and
-- a revoked key must not erase what it did. Workspace deletes cascade.
--
-- BACKFILL. Once, from activity_log (source = 'backfill'), so the board has a
-- before-release baseline from the first day. activity_log names operations
-- (draft_create, draft_reply, draft_send, draft_delete, draft_editor_save,
-- draft_editor_hide) but cannot tell a card Send from a model's, so backfilled
-- sends and deletes are via_card = false and card_offered is NULL. Before the
-- release only internal workspaces had the card, and the board excludes them.
--
-- TENANCY. Service-role only: RLS on, no policies, no grants to anon or
-- authenticated. The growth functions are SECURITY DEFINER, service_role only.
--
-- Forward-only, re-runnable. NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with
-- `npx supabase db query --linked -f` and `migration repair` (never db push),
-- BEFORE deploying mcp-server (the function fails soft either way).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.draft_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id      uuid REFERENCES public.inboxes(id) ON DELETE SET NULL,
  api_key_id    uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  line_id       uuid,
  event         text NOT NULL CHECK (event IN ('drafted', 'saved', 'sent', 'deleted', 'hidden')),
  via_card      boolean NOT NULL DEFAULT false,
  card_offered  boolean,
  source        text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'backfill'))
);

CREATE INDEX IF NOT EXISTS draft_events_occurred_idx ON public.draft_events (occurred_at);
CREATE INDEX IF NOT EXISTS draft_events_workspace_idx ON public.draft_events (workspace_id, occurred_at);

COMMENT ON TABLE public.draft_events IS
  'Draft created / saved in the card / sent / deleted / card hidden, with via_card and card_offered flags, for the growth board draft card band. Ids only, no mail content. Written by mcp-server (draft-events.ts). Service-role only.';

ALTER TABLE public.draft_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.draft_events FROM anon, authenticated;

-- One-time backfill. Guarded so a re-run adds nothing.
DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.draft_events WHERE source = 'backfill') THEN
    INSERT INTO public.draft_events
      (occurred_at, workspace_id, inbox_id, api_key_id, event, via_card, source)
    SELECT
      a.created_at,
      a.workspace_id,
      i.id,
      k.id,
      CASE a.tool_name
        WHEN 'draft_create' THEN 'drafted'
        WHEN 'draft_reply' THEN 'drafted'
        WHEN 'draft_send' THEN 'sent'
        WHEN 'draft_delete' THEN 'deleted'
        WHEN 'draft_editor_save' THEN 'saved'
        WHEN 'draft_editor_hide' THEN 'hidden'
      END,
      a.tool_name IN ('draft_editor_save', 'draft_editor_hide'),
      'backfill'
    FROM public.activity_log a
    JOIN public.workspaces w ON w.id = a.workspace_id
    LEFT JOIN public.inboxes i ON i.id = a.inbox_id
    LEFT JOIN public.api_keys k ON k.id = a.api_key_id
    WHERE a.status = 'success'
      AND a.tool_name IN ('draft_create', 'draft_reply', 'draft_send', 'draft_delete', 'draft_editor_save', 'draft_editor_hide');
  END IF;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- The client family a key last connected with, from mcp_client_capabilities.
--   claude       claude.ai, Claude desktop and mobile (client_name Anthropic/*)
--   claude_code  Claude Code (draws the card in the desktop Code tab only)
--   chatgpt      ChatGPT (openai-mcp; Codex is 'other')
--   other        everything else, and keys that never sent initialize
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_client_family(p_client_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN p_client_name ILIKE 'Anthropic/%' THEN 'claude'
    WHEN p_client_name ILIKE 'claude-code%' THEN 'claude_code'
    WHEN p_client_name = 'openai-mcp' THEN 'chatgpt'
    ELSE 'other'
  END;
$fn$;

-- ---------------------------------------------------------------------------
-- growth_draft_card_stats: one row per (period, family).
--
--   period 'before'  [release - p_days, release), or the last p_days when no
--                    release time is given.
--   period 'after'   [release, now), at most the last 90 days. Absent when no
--                    release time is given.
--
-- Draft counts come from draft_events. calls / errors are the draft tools'
-- activity_log rows (draft_* plus draft_editor_*), so they only reach back as
-- far as activity_log does. The return pair: of the workspaces whose first
-- draft in the period was 14+ days ago, how many made any call 7 to 14 days
-- after it, split by whether they used the card in the period.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_draft_card_stats(
  p_days             integer,
  p_release_at       timestamptz DEFAULT NULL,
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  period          text,
  family          text,
  drafted         bigint,
  drafted_card    bigint,
  card_lines      bigint,
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
      count(DISTINCT line_id) FILTER (WHERE via_card AND line_id IS NOT NULL) AS card_lines,
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
  calls AS (
    SELECT b.period, COALESCE(kf.family, 'other') AS family,
           count(*) AS calls,
           count(*) FILTER (WHERE a.status = 'error') AS errors
    FROM bounds b
    JOIN public.activity_log a ON a.created_at >= b.t0 AND a.created_at < b.t1
    JOIN customer c ON c.id = a.workspace_id
    LEFT JOIN key_family kf ON kf.api_key_id = a.api_key_id
    WHERE a.tool_name LIKE 'draft%'
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
    COALESCE(n.drafted, 0), COALESCE(n.drafted_card, 0), COALESCE(n.card_lines, 0),
    COALESCE(n.saved, 0), COALESCE(n.sent_card, 0), COALESCE(n.sent_agent, 0),
    COALESCE(n.deleted_card, 0), COALESCE(n.deleted_agent, 0), COALESCE(n.hidden, 0),
    COALESCE(n.workspaces, 0), COALESCE(n.card_workspaces, 0),
    COALESCE(cl.calls, 0), COALESCE(cl.errors, 0),
    COALESCE(r.eligible_card, 0), COALESCE(r.returned_card, 0),
    COALESCE(r.eligible_plain, 0), COALESCE(r.returned_plain, 0)
  FROM (
    SELECT period, family FROM counts
    UNION SELECT period, family FROM calls
  ) k
  LEFT JOIN counts n USING (period, family)
  LEFT JOIN calls cl USING (period, family)
  LEFT JOIN returned r USING (period, family)
  ORDER BY k.period, k.family;
$$;

-- ---------------------------------------------------------------------------
-- growth_draft_card_daily: customer drafts and what became of them, per UTC day.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_draft_card_daily(
  p_days             integer,
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  day        date,
  drafted    bigint,
  saved      bigint,
  sent_card  bigint,
  sent_agent bigint,
  hidden     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH customer AS (
    SELECT w.id
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    WHERE NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  ev AS (
    SELECT (e.occurred_at AT TIME ZONE 'utc')::date AS day, e.event, e.via_card
    FROM public.draft_events e
    JOIN customer c ON c.id = e.workspace_id
    WHERE e.occurred_at >= (now() AT TIME ZONE 'utc')::date - (GREATEST(LEAST(p_days, 90), 1) - 1)
  )
  SELECT
    d::date,
    count(ev.*) FILTER (WHERE ev.event = 'drafted'),
    count(ev.*) FILTER (WHERE ev.event = 'saved'),
    count(ev.*) FILTER (WHERE ev.event = 'sent' AND ev.via_card),
    count(ev.*) FILTER (WHERE ev.event = 'sent' AND NOT ev.via_card),
    count(ev.*) FILTER (WHERE ev.event = 'hidden')
  FROM generate_series(
         (now() AT TIME ZONE 'utc')::date - (GREATEST(LEAST(p_days, 90), 1) - 1),
         (now() AT TIME ZONE 'utc')::date,
         interval '1 day'
       ) AS d
  LEFT JOIN ev ON ev.day = d::date
  GROUP BY d
  ORDER BY d;
$$;

-- ---------------------------------------------------------------------------
-- growth_draft_card_reach: who can get the card today, and who turned it off.
-- Levels, not a window.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_draft_card_reach(
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  workspaces         bigint,
  enabled            bigint,
  hidden_workspaces  bigint,
  hidden_inboxes     bigint,
  enabled_inboxes    bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH customer AS (
    SELECT w.id, w.draft_editor_enabled, w.draft_editor_hidden
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE c.draft_editor_enabled),
    count(*) FILTER (WHERE c.draft_editor_enabled AND c.draft_editor_hidden),
    (SELECT count(*) FROM public.inboxes i JOIN customer c2 ON c2.id = i.workspace_id
      WHERE c2.draft_editor_enabled AND i.draft_editor_hidden),
    (SELECT count(*) FROM public.inboxes i JOIN customer c2 ON c2.id = i.workspace_id
      WHERE c2.draft_editor_enabled)
  FROM customer c;
$$;

REVOKE ALL ON FUNCTION public.growth_client_family(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_client_family(text) TO service_role;
REVOKE ALL ON FUNCTION public.growth_draft_card_stats(integer, timestamptz, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_draft_card_stats(integer, timestamptz, text[], text[]) TO service_role;
REVOKE ALL ON FUNCTION public.growth_draft_card_daily(integer, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_draft_card_daily(integer, text[], text[]) TO service_role;
REVOKE ALL ON FUNCTION public.growth_draft_card_reach(text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_draft_card_reach(text[], text[]) TO service_role;

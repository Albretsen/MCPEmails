-- ===========================================================================
-- OpenAI plugin measurement ("Any Mailbox" in the ChatGPT and Codex
-- directory, live 2026-11-17 UTC).
-- 20261116120000_openai_plugin_measurement
--
-- 1. public.openai_client_family(client_name, key_name): 'chatgpt', 'codex'
--    or NULL. The SQL twin of openAiClientFamily in
--    supabase/functions/mcp-server/client-label.ts; keep the two in step.
--    `codex-mcp-client` is also what ChatGPT connectors send, so the key name
--    settles it: an OAuth key not registered as Codex is ChatGPT.
--
-- 2. public.growth_client_family(client_name) now covers every OpenAI name
--    seen in production. Before, only an exact `openai-mcp` was 'chatgpt';
--    `openai-mcp (ChatGPT)` and the Codex names fell through to 'other'.
--    Codex now has its own family, 'codex', so it no longer sits in the
--    'other' baseline of the draft card read-out. With no key name to go on,
--    `codex-mcp-client` reads as 'codex' here.
--
-- 3. Backfill workspaces.analytics_first_tool_client. Until 2026-11-16 the
--    label came from the User-Agent only, and ChatGPT's (`openai-mcp/...`)
--    matched nothing, so most ChatGPT workspaces read 'unknown'. A workspace
--    that made a first tool call and reads 'unknown' or NULL takes the label
--    of its earliest recorded `initialize` (mcp_client_capabilities), when
--    that names a known client. Workspaces with no first tool call keep NULL:
--    growth_client_mix() relies on that. onboarding_client is not touched.
--
-- 4. public.openai_api_keys(): every key an OpenAI client has used, with its
--    family. public.openai_plugin_daily(p_days, p_end_day): one row per
--    Europe/Oslo day for the plugin read-out (scripts/openai-plugin-report.mjs).
--    public.openai_plugin_window(p_from, p_to): distinct active workspaces and
--    OpenAI-active workspaces over a window, the figure a sum of daily rows
--    cannot give. All three are service role only.
--
--    activity_log is about a million rows a month and a cold 30-day scan
--    takes about 7 s, against PostgREST's 8 s statement_timeout. The report
--    therefore asks for the days in 7-day chunks (p_end_day), and the window
--    function is meant for a week at a time.
--
-- Forward-only and re-runnable: CREATE OR REPLACE, and the backfill only
-- touches rows still 'unknown' or NULL. Apply with
-- `npx supabase db query --linked -f` and `migration repair` (never db push).
-- mcp-server calls none of these, so self-host/db/00-schema.sql is unchanged.
-- ===========================================================================

BEGIN;

-- 1. ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.openai_client_family(p_client_name text, p_key_name text DEFAULT NULL)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN lower(btrim(coalesce(p_client_name, ''))) LIKE 'openai-mcp%'
      THEN CASE WHEN lower(p_client_name) LIKE '%codex%' THEN 'codex' ELSE 'chatgpt' END
    WHEN lower(btrim(coalesce(p_client_name, ''))) LIKE 'codex-mcp-client%'
      THEN CASE
        WHEN btrim(coalesce(p_key_name, '')) ~* '^OAuth: codex( \(\d+\))?$' THEN 'codex'
        WHEN btrim(coalesce(p_key_name, '')) ~* '^OAuth: ' THEN 'chatgpt'
        ELSE 'codex'
      END
    WHEN lower(btrim(coalesce(p_client_name, ''))) LIKE 'codex%' THEN 'codex'
    WHEN btrim(coalesce(p_key_name, '')) ~* '^OAuth: codex( \(\d+\))?$' THEN 'codex'
    WHEN btrim(coalesce(p_key_name, '')) ~* '^OAuth: (chatgpt(\.com)?|openai)( \(\d+\))?$' THEN 'chatgpt'
    ELSE NULL
  END;
$fn$;

COMMENT ON FUNCTION public.openai_client_family(text, text) IS
  'chatgpt, codex or NULL for an MCP initialize client_name and api_keys.name. SQL twin of openAiClientFamily in supabase/functions/mcp-server/client-label.ts.';

-- 2. ------------------------------------------------------------------------
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
    ELSE coalesce(public.openai_client_family(p_client_name, NULL), 'other')
  END;
$fn$;

-- 3. ------------------------------------------------------------------------
-- The label for a handshake name that is not OpenAI's: the same needle list
-- as clientLabel in client-label.ts, applied to the name.
WITH earliest AS (
  SELECT DISTINCT ON (c.workspace_id)
         c.workspace_id, c.client_name, k.name AS key_name
  FROM public.mcp_client_capabilities c
  LEFT JOIN public.api_keys k ON k.id = c.api_key_id
  WHERE c.client_name <> 'unknown'
  ORDER BY c.workspace_id, c.first_seen, c.id
),
labelled AS (
  SELECT e.workspace_id,
         coalesce(
           public.openai_client_family(e.client_name, e.key_name),
           CASE
             WHEN e.client_name ILIKE '%claude%' THEN 'claude'
             WHEN e.client_name ILIKE '%chatgpt%' THEN 'chatgpt'
             WHEN e.client_name ILIKE '%cursor%' THEN 'cursor'
             WHEN e.client_name ILIKE '%vscode%' THEN 'vscode'
             WHEN e.client_name ILIKE '%cline%' THEN 'cline'
             WHEN e.client_name ILIKE '%windsurf%' THEN 'windsurf'
             WHEN e.client_name ILIKE '%gemini%' THEN 'gemini'
             WHEN e.client_name ILIKE '%zed%' THEN 'zed'
             WHEN e.client_name ILIKE '%jetbrains%' THEN 'jetbrains'
             WHEN e.client_name ILIKE '%raycast%' THEN 'raycast'
             WHEN e.client_name ILIKE '%warp%' THEN 'warp'
           END
         ) AS label
  FROM earliest e
)
UPDATE public.workspaces w
SET analytics_first_tool_client = l.label
FROM labelled l
WHERE l.workspace_id = w.id
  AND l.label IS NOT NULL
  AND w.analytics_first_tool_used_at IS NOT NULL
  AND coalesce(w.analytics_first_tool_client, 'unknown') = 'unknown';

-- 4. ------------------------------------------------------------------------
-- Every key an OpenAI client has used: by its OAuth name, or else by the
-- latest OpenAI initialize it recorded.
CREATE OR REPLACE FUNCTION public.openai_api_keys()
RETURNS TABLE (api_key_id uuid, workspace_id uuid, family text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.api_key_id, f.workspace_id, f.family
  FROM (
    SELECT k.id AS api_key_id, k.workspace_id,
           coalesce(
             public.openai_client_family(NULL, k.name),
             (SELECT public.openai_client_family(c.client_name, k.name)
              FROM public.mcp_client_capabilities c
              WHERE c.api_key_id = k.id
                AND public.openai_client_family(c.client_name, k.name) IS NOT NULL
              ORDER BY c.last_seen DESC
              LIMIT 1)
           ) AS family
    FROM public.api_keys k
  ) f
  WHERE f.family IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.openai_api_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.openai_api_keys() TO service_role;

CREATE OR REPLACE FUNCTION public.openai_plugin_daily(p_days integer DEFAULT 30, p_end_day date DEFAULT NULL)
RETURNS TABLE (
  day                    date,
  signups                integer,
  chatgpt_signups        integer,
  installs               integer,
  install_workspaces     integer,
  inbox_within_24h       integer,
  first_call_within_24h  integer,
  paid_now               integer,
  active_workspaces      integer,
  openai_active          integer,
  chatgpt_active         integer,
  codex_active           integer,
  openai_calls           integer,
  openai_errors          integer,
  openai_error_rate      numeric,
  openai_free_cap_hits   integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Days p_end_day - p_days + 1 .. p_end_day (default: today), Oslo time.
  WITH bounds AS (
    SELECT d0 AS first_day,
           d1 AS last_day,
           (d0::timestamp AT TIME ZONE 'Europe/Oslo') AS since,
           ((d1 + 1)::timestamp AT TIME ZONE 'Europe/Oslo') AS until
    FROM (
      SELECT e.d1 - (greatest(1, least(coalesce(p_days, 30), 366)) - 1) AS d0, e.d1
      FROM (SELECT coalesce(p_end_day, (now() AT TIME ZONE 'Europe/Oslo')::date) AS d1) e
    ) x
  ),
  days AS (
    SELECT gs::date AS day
    FROM bounds b,
         generate_series(b.first_day, b.last_day, interval '1 day') gs
  ),
  openai_keys AS (
    SELECT * FROM public.openai_api_keys()
  ),
  openai_ws AS (
    SELECT DISTINCT workspace_id FROM openai_keys
  ),
  external_ws AS (
    SELECT w.id, w.created_at, w.acquisition_source, w.plan,
           w.analytics_first_tool_used_at, w.onboarding_inbox_connected_at,
           w.owner_id
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    CROSS JOIN bounds b
    WHERE w.created_at >= b.since AND w.created_at < b.until
      AND NOT public.growth_is_internal_email(u.email)
  ),
  signup_rows AS (
    SELECT (u.created_at AT TIME ZONE 'Europe/Oslo')::date AS day, count(*)::int AS n
    FROM public.users u CROSS JOIN bounds b
    WHERE u.created_at >= b.since AND u.created_at < b.until AND NOT public.growth_is_internal_email(u.email)
    GROUP BY 1
  ),
  cohort AS (
    SELECT (w.created_at AT TIME ZONE 'Europe/Oslo')::date AS day,
           count(*)::int AS chatgpt_signups,
           count(*) FILTER (WHERE coalesce(
             w.onboarding_inbox_connected_at,
             (SELECT min(i.created_at) FROM public.inboxes i WHERE i.workspace_id = w.id)
           ) < w.created_at + interval '24 hours')::int AS inbox_within_24h,
           count(*) FILTER (WHERE w.analytics_first_tool_used_at < w.created_at + interval '24 hours')::int AS first_call_within_24h,
           -- Paid now: a paid plan on the workspace, or an active or trialing
           -- paid subscription on its owner.
           count(*) FILTER (WHERE w.plan <> 'free' OR EXISTS (
             SELECT 1 FROM public.user_billing ub
             WHERE ub.user_id = w.owner_id
               AND ub.plan <> 'free'
               AND ub.subscription_status IN ('active', 'trialing')
           ))::int AS paid_now
    FROM external_ws w
    WHERE w.acquisition_source IN ('chatgpt', 'chatgpt_directory', 'connector_chatgpt')
    GROUP BY 1
  ),
  installs AS (
    SELECT (k.created_at AT TIME ZONE 'Europe/Oslo')::date AS day,
           count(*)::int AS installs,
           count(DISTINCT k.workspace_id)::int AS install_workspaces
    FROM public.api_keys k CROSS JOIN bounds b
    WHERE k.created_at >= b.since AND k.created_at < b.until
      AND public.openai_client_family(NULL, k.name) IS NOT NULL
    GROUP BY 1
  ),
  calls AS (
    SELECT (a.created_at AT TIME ZONE 'Europe/Oslo')::date AS day,
           count(DISTINCT a.workspace_id)::int AS active_workspaces,
           count(DISTINCT a.workspace_id) FILTER (WHERE ok.family IS NOT NULL)::int AS openai_active,
           count(DISTINCT a.workspace_id) FILTER (WHERE ok.family = 'chatgpt')::int AS chatgpt_active,
           count(DISTINCT a.workspace_id) FILTER (WHERE ok.family = 'codex')::int AS codex_active,
           count(*) FILTER (WHERE ok.family IS NOT NULL)::int AS openai_calls,
           count(*) FILTER (WHERE ok.family IS NOT NULL AND a.status <> 'success')::int AS openai_errors
    FROM public.activity_log a
    CROSS JOIN bounds b
    LEFT JOIN openai_keys ok ON ok.api_key_id = a.api_key_id
    WHERE a.created_at >= b.since AND a.created_at < b.until
    GROUP BY 1
  ),
  cap_hits AS (
    SELECT (l.occurred_at AT TIME ZONE 'Europe/Oslo')::date AS day,
           count(DISTINCT l.workspace_id)::int AS n
    FROM public.usage_limit_events l
    JOIN openai_ws o ON o.workspace_id = l.workspace_id
    CROSS JOIN bounds b
    WHERE l.occurred_at >= b.since AND l.occurred_at < b.until
      AND l.limit_kind = 'actions'
      AND l.effective_plan = 'free'
    GROUP BY 1
  )
  SELECT d.day,
         coalesce(s.n, 0),
         coalesce(c.chatgpt_signups, 0),
         coalesce(i.installs, 0),
         coalesce(i.install_workspaces, 0),
         coalesce(c.inbox_within_24h, 0),
         coalesce(c.first_call_within_24h, 0),
         coalesce(c.paid_now, 0),
         coalesce(a.active_workspaces, 0),
         coalesce(a.openai_active, 0),
         coalesce(a.chatgpt_active, 0),
         coalesce(a.codex_active, 0),
         coalesce(a.openai_calls, 0),
         coalesce(a.openai_errors, 0),
         CASE WHEN coalesce(a.openai_calls, 0) = 0 THEN NULL
              ELSE round(a.openai_errors::numeric / a.openai_calls, 4) END,
         coalesce(h.n, 0)
  FROM days d
  LEFT JOIN signup_rows s ON s.day = d.day
  LEFT JOIN cohort c ON c.day = d.day
  LEFT JOIN installs i ON i.day = d.day
  LEFT JOIN calls a ON a.day = d.day
  LEFT JOIN cap_hits h ON h.day = d.day
  ORDER BY d.day;
$$;

COMMENT ON FUNCTION public.openai_plugin_daily(integer, date) IS
  'OpenAI plugin read-out, one row per Europe/Oslo day (internal accounts excluded from signups). chatgpt_signups: new workspaces with acquisition_source chatgpt, chatgpt_directory or connector_chatgpt; inbox/first call within 24h and paid_now are of those. installs: new OAuth keys named for ChatGPT or Codex. openai_*: activity_log rows on keys an OpenAI client used. openai_free_cap_hits: those workspaces refused by the Free action cap (usage_limit_events). Service role only.';

REVOKE ALL ON FUNCTION public.openai_plugin_daily(integer, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.openai_plugin_daily(integer, date) TO service_role;

-- Distinct workspaces over a window (a week at a time; see the header).
CREATE OR REPLACE FUNCTION public.openai_plugin_window(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  active_workspaces integer,
  openai_active     integer,
  chatgpt_active    integer,
  codex_active      integer,
  openai_calls      integer,
  openai_errors     integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(DISTINCT a.workspace_id)::int,
         count(DISTINCT a.workspace_id) FILTER (WHERE ok.family IS NOT NULL)::int,
         count(DISTINCT a.workspace_id) FILTER (WHERE ok.family = 'chatgpt')::int,
         count(DISTINCT a.workspace_id) FILTER (WHERE ok.family = 'codex')::int,
         count(*) FILTER (WHERE ok.family IS NOT NULL)::int,
         count(*) FILTER (WHERE ok.family IS NOT NULL AND a.status <> 'success')::int
  FROM public.activity_log a
  LEFT JOIN public.openai_api_keys() ok ON ok.api_key_id = a.api_key_id
  WHERE a.created_at >= p_from
    AND a.created_at < p_to;
$$;

REVOKE ALL ON FUNCTION public.openai_plugin_window(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.openai_plugin_window(timestamptz, timestamptz) TO service_role;

COMMIT;

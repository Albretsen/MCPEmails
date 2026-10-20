-- AI-answer scoreboard. Read-only (SELECT only). See docs/AI-ANSWER-PANEL.md.
--
--   npx supabase db query --linked -f docs/sql/ai-answer-scoreboard.sql
--
-- Three queries, (a) (b) (c). Each one is a complete statement and runs on its
-- own. Running the whole file prints ONLY the last result, (c). To read (a) or
-- (b), copy that query (with its comment block) into a scratch file and pass
-- that file with -f. Always use -f, not an inline string: the CLI handles
-- leading "--" comment lines badly when the SQL is passed inline.
--
-- Shared rules for (a) and (b):
--   Cohort       public.users minus growth_is_internal_email(email).
--   Attribution  the user's FIRST owned workspace (earliest created_at, then
--                id). Its acquisition_* columns describe how the user arrived.
--   Activation   analytics_first_inbox_connected_at / analytics_first_tool_used_at
--                on that workspace.
--   Paying       user_billing.plan in ('personal','solo','pro') and
--                subscription_status in ('active','past_due','trialing'). This
--                is plan state NOW, not at signup: a week's payer count can
--                move up or down as those users buy or cancel later.
--   Weeks        Monday-start (date_trunc('week')), the last 12 weeks
--                including the current, partial one.
--
-- acquisition_source today only has three AI buckets: chatgpt, claude and
-- perplexity. gemini and copilot are listed so they show up if the classifier
-- ever learns them; they return no rows until then.


-- (a) Weekly signups, inbox connected, tool used and current payers per AI
-- source. One row per week and source; weeks with no signups from a source
-- are left out.
WITH fw AS (
  SELECT DISTINCT ON (w.owner_id) w.*
  FROM public.workspaces w
  ORDER BY w.owner_id, w.created_at, w.id
),
c AS (
  SELECT
    u.created_at,
    fw.acquisition_source AS src,
    fw.analytics_first_inbox_connected_at AS inbox_at,
    fw.analytics_first_tool_used_at AS tool_at,
    coalesce(b.plan IN ('personal', 'solo', 'pro')
             AND b.subscription_status IN ('active', 'past_due', 'trialing'), false) AS paying
  FROM public.users u
  JOIN fw ON fw.owner_id = u.id
  LEFT JOIN public.user_billing b ON b.user_id = u.id
  WHERE NOT public.growth_is_internal_email(u.email)
    AND u.created_at >= date_trunc('week', now()) - interval '11 weeks'
    AND fw.acquisition_source IN ('chatgpt', 'claude', 'perplexity', 'gemini', 'copilot')
)
SELECT
  date_trunc('week', created_at)::date AS week,
  src AS source,
  count(*) AS signups,
  count(inbox_at) AS inbox_connected,
  count(tool_at) AS tool_used,
  count(*) FILTER (WHERE paying) AS payers_now
FROM c
GROUP BY 1, 2
ORDER BY 2, 1;


-- (b) ChatGPT-source signups by landing-page bucket per week. The bucket comes
-- from acquisition_landing_path on the first owned workspace:
--   connect  /connect/*        provider setup pages (Yahoo, iCloud, IMAP, ...)
--   home     /
--   blog     /blog and /blog/*
--   docs     /docs and /docs/*
--   other    any other path, or no path stored
-- /connect/* is the bucket answer citations feed most directly; watch it.
WITH fw AS (
  SELECT DISTINCT ON (w.owner_id) w.*
  FROM public.workspaces w
  ORDER BY w.owner_id, w.created_at, w.id
),
c AS (
  SELECT
    u.created_at,
    fw.acquisition_landing_path AS lpath
  FROM public.users u
  JOIN fw ON fw.owner_id = u.id
  WHERE NOT public.growth_is_internal_email(u.email)
    AND u.created_at >= date_trunc('week', now()) - interval '11 weeks'
    AND fw.acquisition_source = 'chatgpt'
)
SELECT
  date_trunc('week', created_at)::date AS week,
  count(*) AS chatgpt_signups,
  count(*) FILTER (WHERE lpath LIKE '/connect/%') AS connect,
  count(*) FILTER (WHERE lpath = '/') AS home,
  count(*) FILTER (WHERE lpath = '/blog' OR lpath LIKE '/blog/%') AS blog,
  count(*) FILTER (WHERE lpath = '/docs' OR lpath LIKE '/docs/%') AS docs,
  count(*) FILTER (WHERE lpath IS NULL
                      OR NOT (lpath LIKE '/connect/%' OR lpath = '/'
                              OR lpath = '/blog' OR lpath LIKE '/blog/%'
                              OR lpath = '/docs' OR lpath LIKE '/docs/%')) AS other
FROM c
GROUP BY 1
ORDER BY 1;


-- (c) ChatGPT as a client, per week, external workspaces only (owner is not
-- internal). This counts every workspace, whatever its acquisition_source:
-- most ChatGPT installs come from users who found us on Google or directly.
--   first_chatgpt_oauth  workspaces whose FIRST api_keys row named
--                        'OAuth: ChatGPT' or 'OAuth: chatgpt.com' (optionally
--                        with a ' (n)' suffix) was created that week.
--   of_which_chatgpt_src the same, limited to workspaces whose
--                        acquisition_source is chatgpt.
--   first_openai_mcp     workspaces whose first mcp_client_capabilities row
--                        with client_name 'openai-mcp' was first seen that week.
WITH ext AS (
  SELECT w.id, w.acquisition_source AS src
  FROM public.workspaces w
  JOIN public.users u ON u.id = w.owner_id
  WHERE NOT public.growth_is_internal_email(u.email)
),
k AS (
  SELECT a.workspace_id, min(a.created_at) AS t
  FROM public.api_keys a
  JOIN ext ON ext.id = a.workspace_id
  WHERE a.name ~* '^OAuth: (chatgpt|chatgpt\.com)( \(\d+\))?$'
  GROUP BY 1
),
m AS (
  SELECT mc.workspace_id, min(mc.first_seen) AS t
  FROM public.mcp_client_capabilities mc
  JOIN ext ON ext.id = mc.workspace_id
  WHERE mc.client_name = 'openai-mcp'
  GROUP BY 1
),
weeks AS (
  SELECT generate_series(date_trunc('week', now()) - interval '11 weeks',
                         date_trunc('week', now()),
                         interval '1 week')::date AS week
)
SELECT
  weeks.week,
  (SELECT count(*) FROM k
    WHERE date_trunc('week', k.t)::date = weeks.week) AS first_chatgpt_oauth,
  (SELECT count(*) FROM k JOIN ext ON ext.id = k.workspace_id
    WHERE date_trunc('week', k.t)::date = weeks.week
      AND ext.src = 'chatgpt') AS of_which_chatgpt_src,
  (SELECT count(*) FROM m
    WHERE date_trunc('week', m.t)::date = weeks.week) AS first_openai_mcp
FROM weeks
ORDER BY 1;

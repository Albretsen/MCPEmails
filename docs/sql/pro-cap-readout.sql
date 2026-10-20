-- Pro inbox cap read-out and kill rule. Read-only.
--
--   npx supabase db query --linked -f docs/sql/pro-cap-readout.sql
--
-- THE RULE (decided 2026-10-19): track the first 20 capped buyers. If more
-- than 40% of them neither buy Business nor stay on Pro within 14 days of
-- hitting the cap, flip the kill switch (runbook in the PR, and below).
--
-- Unit: a Pro WORKSPACE that hit the 10-inbox cap after the cutover. A hit is
-- a usage_limit_events row with limit_kind = 'inboxes' and effective_plan =
-- 'solo' (written when the connect modal shows the Business offer, and when a
-- connect route refuses at the cap). Exempt workspaces never hit the cap, so
-- they never enter the cohort.
--
-- Each workspace is classified at the end of its 14-day window (or now, if the
-- window is still open, as 'pending'). Outcomes are checked in this order, and
-- the first that matches wins:
--
--   bought_business  a Business checkout or in-place upgrade completed for the
--                    owner inside the window, or the owner is on Business now.
--   other_workspace  inside the window, the same owner created another
--                    workspace, or a NEW account appeared whose connected
--                    mailbox shares a business domain with the capped
--                    workspace's mailboxes (consumer domains never match).
--   stayed_pro       the owner is still on Pro (any entitled status).
--   walked           no paid plan, and no MCP activity on any of the owner's
--                    workspaces in the 7 days before the window closed.
--   other            anything else, for example moved to Personal, or on Free
--                    and still active. Counted against the rule.
--
-- Plan state (stayed_pro, walked) is read as it is NOW, because nothing stores
-- a subscription's history. Run this as soon as the 20th window closes, and
-- read 'stayed_pro' for a workspace whose window closed long ago with that in
-- mind.
--
-- The cutover instant defaults to when the pro_inbox_cap switch last changed.
-- If the switch was flipped again since, replace it with the real cutover.
WITH params AS (
  SELECT
    (SELECT updated_at FROM public.pricing_switches WHERE key = 'pro_inbox_cap') AS cutover,
    interval '14 days' AS window_len,
    interval '7 days'  AS idle_len,
    20                 AS rule_n,
    0.40               AS rule_threshold
),
hits AS (
  SELECT l.workspace_id,
         min(l.occurred_at)  AS first_hit,
         max(l.used_actions) AS inboxes_at_hit,
         count(*)            AS hit_rows
    FROM public.usage_limit_events l, params p
   WHERE l.limit_kind = 'inboxes'
     AND l.effective_plan = 'solo'
     AND l.occurred_at >= p.cutover
   GROUP BY l.workspace_id
),
cohort AS (
  SELECT h.*,
         w.owner_id,
         w.created_at AS workspace_created_at,
         h.first_hit + p.window_len AS window_end,
         least(now(), h.first_hit + p.window_len) AS judged_at,
         (h.first_hit + p.window_len <= now()) AS matured,
         row_number() OVER (ORDER BY h.first_hit) AS capped_rank
    FROM hits h
    JOIN public.workspaces w ON w.id = h.workspace_id
    JOIN auth.users u ON u.id = w.owner_id
    CROSS JOIN params p
   WHERE NOT public.growth_is_internal_email(u.email)
),
owner_ws AS (
  SELECT c.workspace_id AS capped_id, w.id AS ws_id
    FROM cohort c
    JOIN public.workspaces w ON w.owner_id = c.owner_id
),
bought AS (
  SELECT c.workspace_id
    FROM cohort c
   WHERE EXISTS (
           SELECT 1
             FROM owner_ws o
             JOIN public.product_funnel_events e ON e.workspace_id = o.ws_id
            WHERE o.capped_id = c.workspace_id
              AND e.stage IN ('checkout_completed', 'plan_upgraded')
              AND e.outcome = 'success'
              AND e.category IN ('pro_month', 'pro_year')
              AND e.occurred_at >= c.first_hit
              AND e.occurred_at <  c.window_end
         )
      OR EXISTS (
           SELECT 1 FROM public.user_billing b
            WHERE b.user_id = c.owner_id
              AND b.plan = 'pro'
              AND coalesce(b.subscription_status, 'active') IN ('active', 'trialing', 'past_due', 'unpaid')
         )
),
-- Business mailbox domains of the capped workspace. Consumer domains are left
-- out, or every Gmail user would "match" every other.
capped_domains AS (
  SELECT DISTINCT c.workspace_id, lower(split_part(i.email_address, '@', 2)) AS domain
    FROM cohort c
    JOIN public.inboxes i ON i.workspace_id = c.workspace_id
   WHERE lower(split_part(i.email_address, '@', 2)) NOT IN (
           'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
           'msn.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'ymail.com',
           'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de',
           'gmx.net', 'web.de', 'mail.com', 'fastmail.com', 'zoho.com', 'yandex.com',
           'qq.com', '163.com', 'hey.com', 't-online.de', 'orange.fr', 'free.fr',
           'libero.it', 'online.no'
         )
),
other_ws AS (
  SELECT c.workspace_id
    FROM cohort c
   WHERE EXISTS (           -- same owner, new workspace
           SELECT 1 FROM public.workspaces w2
            WHERE w2.owner_id = c.owner_id
              AND w2.id <> c.workspace_id
              AND w2.created_at >= c.first_hit
              AND w2.created_at <  c.window_end
         )
      OR EXISTS (           -- new owner, matching business domain
           SELECT 1
             FROM capped_domains d
             JOIN public.inboxes i2
               ON lower(split_part(i2.email_address, '@', 2)) = d.domain
             JOIN public.workspaces w2 ON w2.id = i2.workspace_id
             JOIN auth.users u2 ON u2.id = w2.owner_id
            WHERE d.workspace_id = c.workspace_id
              AND w2.owner_id <> c.owner_id
              AND u2.created_at >= c.first_hit
              AND u2.created_at <  c.window_end
         )
),
state AS (
  SELECT c.workspace_id,
         b.plan AS owner_plan,
         coalesce(b.plan, 'free') <> 'free'
           AND coalesce(b.subscription_status, 'active') IN ('active', 'trialing', 'past_due', 'unpaid')
           AS owner_paid,
         EXISTS (
           SELECT 1
             FROM owner_ws o
             JOIN public.action_usage a ON a.workspace_id = o.ws_id
             CROSS JOIN params p
            WHERE o.capped_id = c.workspace_id
              AND a.occurred_at >= c.judged_at - p.idle_len
              AND a.occurred_at <  c.judged_at
         ) AS active_last_7d
    FROM cohort c
    LEFT JOIN public.user_billing b ON b.user_id = c.owner_id
),
classified AS (
  SELECT c.capped_rank,
         c.workspace_id,
         c.first_hit,
         c.inboxes_at_hit,
         c.hit_rows,
         c.matured,
         s.owner_plan,
         s.active_last_7d,
         CASE
           WHEN NOT c.matured                                         THEN 'pending'
           WHEN c.workspace_id IN (SELECT workspace_id FROM bought)   THEN 'bought_business'
           WHEN c.workspace_id IN (SELECT workspace_id FROM other_ws) THEN 'other_workspace'
           WHEN s.owner_plan = 'solo' AND s.owner_paid                THEN 'stayed_pro'
           WHEN NOT s.owner_paid AND NOT s.active_last_7d             THEN 'walked'
           ELSE 'other'
         END AS outcome
    FROM cohort c
    JOIN state s ON s.workspace_id = c.workspace_id
)
-- One row per capped workspace, in the order they hit the cap...
SELECT capped_rank::text   AS rank,
       workspace_id::text  AS workspace_id,
       first_hit,
       inboxes_at_hit,
       outcome,
       owner_plan,
       active_last_7d,
       NULL::numeric       AS share
  FROM classified
UNION ALL
-- ...then the summary over the first 20 matured ones (the kill rule's
-- sample). `share` on the 'walked' row is the walk-away share; on the
-- 'neither_business_nor_pro' row it is the number the rule compares with 0.40.
SELECT 'summary', o.outcome, NULL, NULL,
       o.outcome,
       NULL, NULL,
       round(o.n::numeric / nullif(t.n, 0), 3)
  FROM (
    SELECT outcome, count(*) AS n
      FROM (SELECT * FROM classified WHERE matured ORDER BY capped_rank LIMIT (SELECT rule_n FROM params)) f
     GROUP BY outcome
    UNION ALL
    SELECT 'neither_business_nor_pro', count(*) FILTER (WHERE outcome NOT IN ('bought_business', 'stayed_pro'))
      FROM (SELECT * FROM classified WHERE matured ORDER BY capped_rank LIMIT (SELECT rule_n FROM params)) f
  ) o,
  (SELECT count(*) AS n
     FROM (SELECT 1 FROM classified WHERE matured ORDER BY capped_rank LIMIT (SELECT rule_n FROM params)) f) t
UNION ALL
SELECT 'summary', 'verdict', NULL, NULL,
       CASE
         WHEN t.n < p.rule_n THEN 'wait: ' || t.n || ' of ' || p.rule_n || ' windows closed'
         WHEN t.neither::numeric / t.n > p.rule_threshold THEN 'FLIP THE KILL SWITCH'
         ELSE 'keep the cap'
       END,
       NULL, NULL,
       round(t.neither::numeric / nullif(t.n, 0), 3)
  FROM params p,
       (SELECT count(*) AS n,
               count(*) FILTER (WHERE outcome NOT IN ('bought_business', 'stayed_pro')) AS neither
          FROM (SELECT * FROM classified WHERE matured ORDER BY capped_rank LIMIT (SELECT rule_n FROM params)) f) t;

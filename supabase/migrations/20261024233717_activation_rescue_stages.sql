-- ---------------------------------------------------------------------------
-- Activation rescue, part 1: instrumentation.
--
-- 1. Four new stages on product_funnel_events, written by the dashboard
--    through POST /api/analytics/activation-event
--    (apps/web/src/lib/analytics/activation-events.ts):
--      connect_fix_shown         the per-provider fix panel after a failed
--                                connect. category = provider; auth_reason
--                                and phase copied from the failure.
--      connect_fix_link_clicked  a link in that panel was opened.
--                                category = provider.
--      first_call_prompt_copied  a suggested first prompt was copied.
--                                category = client.
--      waiting_state_shown       "waiting for your first call" was shown,
--                                at most once per workspace per day.
--                                category = client.
--    Every row is outcome 'success' with error_category NULL, so the outcome,
--    terminal_error and error_category CHECKs pass unchanged. Providers and
--    clients are values the category CHECK already allows, and phase is only
--    ever one of the values the phase CHECK allows (safeDiagnosticPhase).
--
-- 2. public.activation_segments(days): one definition of "where are the
--    workspaces that never made a tool call", so every read-out of this work
--    uses the same buckets.
--
-- self-host/db/00-schema.sql is not touched: product_funnel_events is a
-- hosted-only table there and nothing in mcp-server writes these stages.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. stage vocabulary
--
-- ADDITIVE, NOT VERBATIM (same pattern as 20261024225000_dunning_measurement):
-- other branches add stages of their own, and restating a fixed list would
-- drop them. Reads the live definition, keeps every stage in it, and appends
-- the four activation stages that are missing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  def text;
  stages text[];
  wanted text[] := ARRAY['connect_fix_shown', 'connect_fix_link_clicked',
                         'first_call_prompt_copied', 'waiting_state_shown'];
  missing text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conname = 'product_funnel_events_stage_check'
    AND c.conrelid = 'public.product_funnel_events'::regclass;

  IF def IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT s ORDER BY s) INTO stages
  FROM (
    SELECT m[1] AS s FROM regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') AS m
    UNION
    SELECT trim(both '"' from x) FROM regexp_matches(def, '''\{([^}]*)\}''', 'g') AS a,
      unnest(string_to_array(a[1], ',')) AS x
  ) found
  WHERE s ~ '^[a-z0-9_]+$';

  IF stages IS NULL OR array_length(stages, 1) IS NULL THEN
    RAISE EXCEPTION 'product_funnel_events_stage_check has no readable stage list: %', def;
  END IF;

  SELECT array_agg(w) INTO missing FROM unnest(wanted) AS w WHERE NOT (w = ANY (stages));
  IF missing IS NULL THEN
    RETURN;
  END IF;

  stages := stages || missing;

  ALTER TABLE public.product_funnel_events
    DROP CONSTRAINT product_funnel_events_stage_check;
  EXECUTE format(
    'ALTER TABLE public.product_funnel_events ADD CONSTRAINT product_funnel_events_stage_check CHECK (stage IN (%s))',
    (SELECT string_agg(quote_literal(s), ', ' ORDER BY s) FROM unnest(stages) AS s)
  );
END
$$;


-- ---------------------------------------------------------------------------
-- 2. activation_segments(days)
--
-- Cohort: workspaces created in the last `days` days, not deleted, owner not
-- internal (growth_is_internal_email: public.internal_accounts matched on the
-- lowercased address, plus-tag-insensitive, and our own domains). A workspace
-- whose owner has no users row stays in, as in growth_activation_funnel.
--
-- Each workspace lands in exactly one segment, first match wins:
--   1 called             a first_tool_call or technical_activation row, or
--                        workspaces.analytics_first_tool_used_at set
--   2 connected_idle     an inbox_connection success, or a live inbox
--   3 failed             an inbox_connection failure (and, by order, no success)
--   4 started_no_result  an inbox_connection 'started' row and nothing after it
--   5 picked_provider    only a provider_selected row
--   6 no_attempt         none of the above, including no funnel rows at all
--
-- bool_or over a LEFT JOIN with no matching rows is NULL, not false, so every
-- flag is coalesced: a workspace with zero events must reach no_attempt, not
-- fall out of the CASE. All six segments are returned, zero or not, and they
-- sum to total_workspaces.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activation_segments(days int DEFAULT 30)
RETURNS TABLE (
  segment_index    int,
  segment          text,
  workspaces       int,
  total_workspaces int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH cohort AS (
    SELECT w.id, w.analytics_first_tool_used_at
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND w.created_at >= now() - make_interval(days => greatest(coalesce(activation_segments.days, 30), 1))
      AND NOT coalesce(public.growth_is_internal_email(u.email), false)
  ),
  flags AS (
    SELECT
      c.id,
      (c.analytics_first_tool_used_at IS NOT NULL
        OR coalesce(bool_or(e.stage IN ('first_tool_call', 'technical_activation')), false)) AS called,
      (coalesce(bool_or(e.stage = 'inbox_connection' AND e.outcome = 'success'), false)
        OR EXISTS (
          SELECT 1 FROM public.inboxes i
          WHERE i.workspace_id = c.id AND i.deleted_at IS NULL
        )) AS connected,
      coalesce(bool_or(e.stage = 'inbox_connection' AND e.outcome = 'failure'), false) AS failed,
      coalesce(bool_or(e.stage = 'inbox_connection' AND e.outcome = 'started'), false) AS started,
      coalesce(bool_or(e.stage = 'provider_selected'), false) AS picked
    FROM cohort c
    LEFT JOIN public.product_funnel_events e ON e.workspace_id = c.id
    GROUP BY c.id, c.analytics_first_tool_used_at
  ),
  classified AS (
    SELECT CASE
      WHEN f.called    THEN 1
      WHEN f.connected THEN 2
      WHEN f.failed    THEN 3
      WHEN f.started   THEN 4
      WHEN f.picked    THEN 5
      ELSE 6
    END AS segment_index
    FROM flags f
  ),
  counts AS (
    SELECT cl.segment_index, count(*)::int AS workspaces
    FROM classified cl
    GROUP BY cl.segment_index
  )
  SELECT
    s.segment_index,
    s.segment,
    coalesce(ct.workspaces, 0) AS workspaces,
    (SELECT count(*)::int FROM cohort) AS total_workspaces
  FROM (VALUES
    (1, 'called'),
    (2, 'connected_idle'),
    (3, 'failed'),
    (4, 'started_no_result'),
    (5, 'picked_provider'),
    (6, 'no_attempt')
  ) AS s(segment_index, segment)
  LEFT JOIN counts ct ON ct.segment_index = s.segment_index
  ORDER BY s.segment_index;
$$;

REVOKE ALL ON FUNCTION public.activation_segments(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activation_segments(int) TO service_role;

COMMENT ON FUNCTION public.activation_segments(int) IS
  'Activation segments over live, non-internal workspaces created in the last N days: '
  'called, connected_idle, failed, started_no_result, picked_provider, no_attempt. '
  'One segment per workspace, first match wins; the six sum to total_workspaces. '
  'Service role only.';

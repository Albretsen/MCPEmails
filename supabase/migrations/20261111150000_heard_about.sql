-- ============================================================================
-- "How did you hear about MCPEmails?" Self-reported attribution, asked once per
-- workspace on the dashboard Overview after the first inbox connects.
--
-- WHY. 42% of paying workspaces arrive with acquisition_source 'direct', and
-- the business homepage visitors among them often pay within minutes. They
-- heard of us somewhere no referrer reaches (an AI answer, a colleague, a
-- directory). The only way to learn where is to ask.
--
--   1. workspaces.heard_about        the option id, or NULL (dismissed / never
--                                    answered). CHECK on the option ids.
--      workspaces.heard_about_other  free text for 'other', at most 200 chars.
--      workspaces.heard_about_at     when it was answered OR dismissed. Set
--                                    once: the card is shown only while this
--                                    is NULL, and POST /api/onboarding/heard-about
--                                    writes only while it is NULL.
--      Server-owned like every workspaces column
--      (20261016160100_workspaces_server_owned_writes): no grant to anon or
--      authenticated; the route writes with the service role after a
--      membership check.
--   2. product_funnel_events stages heard_about_answered, heard_about_dismissed
--      (category surface_overview, already in the vocabulary). Append-only.
--   3. growth_heard_about(internal emails, internal domains): the /admin/growth
--      table. answer x workspaces x paid (paid = billing_funnel_by_workspace
--      .paid_at), internal owners excluded with growth_is_internal_email like
--      the other growth RPCs. Service role only.
--
-- Not read by mcp-server, so self-host/db/00-schema.sql is unchanged.
-- Forward-only and re-runnable.
-- ============================================================================

-- 1. Columns ------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS heard_about text,
  ADD COLUMN IF NOT EXISTS heard_about_other text,
  ADD COLUMN IF NOT EXISTS heard_about_at timestamptz;

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_heard_about_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_heard_about_check
  CHECK (heard_about IS NULL OR heard_about IN (
    'chatgpt', 'claude', 'gemini', 'google_search', 'colleague',
    'directory', 'video', 'forum', 'other'
  ));

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_heard_about_other_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_heard_about_other_check
  CHECK (heard_about_other IS NULL OR (heard_about = 'other' AND char_length(heard_about_other) <= 200));

-- An answer always carries its timestamp.
ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_heard_about_at_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_heard_about_at_check
  CHECK (heard_about IS NULL OR heard_about_at IS NOT NULL);

COMMENT ON COLUMN public.workspaces.heard_about IS
  'Self-reported "how did you hear about MCPEmails" option id. NULL with heard_about_at set = dismissed.';
COMMENT ON COLUMN public.workspaces.heard_about_other IS
  'Free text for heard_about = ''other'', at most 200 characters.';
COMMENT ON COLUMN public.workspaces.heard_about_at IS
  'When the heard-about question was answered or dismissed. Set once; the dashboard stops asking.';

-- Server-owned, stated per column so this file does not depend on how the
-- table-level revoke treats columns added after it.
REVOKE INSERT (heard_about, heard_about_other, heard_about_at),
       UPDATE (heard_about, heard_about_other, heard_about_at),
       REFERENCES (heard_about, heard_about_other, heard_about_at)
  ON TABLE public.workspaces FROM anon, authenticated;

-- 2. Funnel vocabulary ------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.mcpe_extend_in_check(
  p_table regclass,
  p_constraint text,
  p_column text,
  p_values text[]
) RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  def      text;
  existing text[];
  merged   text[];
  nullable boolean;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conname = p_constraint AND c.conrelid = p_table;

  IF def IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT s ORDER BY s) INTO existing
  FROM (
    SELECT m[1] AS s FROM regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') AS m
    UNION
    SELECT trim(both '"' from x) FROM regexp_matches(def, '''\{([^}]*)\}''', 'g') AS a,
      unnest(string_to_array(a[1], ',')) AS x
  ) found
  WHERE s ~ '^[a-z0-9_]+$';

  IF existing IS NULL OR array_length(existing, 1) IS NULL THEN
    RAISE EXCEPTION '% has no readable value list: %', p_constraint, def;
  END IF;

  IF p_values <@ existing THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT v ORDER BY v) INTO merged
  FROM unnest(existing || p_values) AS v;

  nullable := def ILIKE '%' || p_column || ' IS NULL%';

  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', p_table, p_constraint);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s%I IN (%s))',
    p_table,
    p_constraint,
    CASE WHEN nullable THEN format('%I IS NULL OR ', p_column) ELSE '' END,
    p_column,
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(merged) AS v)
  );
END
$fn$;

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_stage_check', 'stage',
  ARRAY['heard_about_answered', 'heard_about_dismissed']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);

-- 3. The /admin/growth table ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_heard_about(
  p_internal_emails text[] DEFAULT '{}'::text[],
  p_internal_domains text[] DEFAULT '{}'::text[]
)
RETURNS TABLE (answer text, workspaces integer, paid integer)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE(w.heard_about, 'dismissed') AS answer,
    count(*)::int AS workspaces,
    count(*) FILTER (WHERE b.paid_at IS NOT NULL)::int AS paid
  FROM public.workspaces w
  JOIN public.users u ON u.id = w.owner_id
  LEFT JOIN public.billing_funnel_by_workspace b ON b.workspace_id = w.id
  WHERE w.deleted_at IS NULL
    AND w.heard_about_at IS NOT NULL
    AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  GROUP BY 1
  ORDER BY 2 DESC, 1;
$$;

COMMENT ON FUNCTION public.growth_heard_about(text[], text[]) IS
  '/admin/growth: self-reported "heard about" answers (dismissed included) with workspaces and paid (billing_funnel_by_workspace.paid_at). Internal owners excluded.';

REVOKE ALL ON FUNCTION public.growth_heard_about(text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_heard_about(text[], text[]) TO service_role;

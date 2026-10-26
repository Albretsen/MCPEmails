-- ============================================================================
-- Onboarding WP-F: add to AI, first prompt, live wait, It works (plan
-- Documents/plans/onboarding-research-20261026.md A6, A8, A9, A10).
--
--   1. workspaces.onboarding_welcome_shown_at + claim_onboarding_welcome():
--      the A10 line. mcp-server appends one short "what to ask next" line to
--      the first successful real-inbox tool result of a workspace. The claim
--      is a conditional UPDATE, so of two concurrent first calls only one says
--      it. A reset (onboarding_reset_at newer than the stamp) re-arms it.
--      v1: internal accounts only (owner through growth_is_internal_email).
--   2. onboarding_morning_brief_optins: "Email me this tomorrow at 8" (A9).
--      One row per workspace; the dispatcher sends one service email when
--      send_at has passed and marks the row. Service role only.
--   3. dispatch_onboarding_morning_brief() + cron every 15 minutes, built
--      from Vault like every other dispatcher (20261026175000).
--   4. product_funnel_events vocabulary, append-only (same helper as
--      20261026203517).
--        stages     onboarding_handshake_seen      category = client
--                   onboarding_help_shown          category = help_*
--                   onboarding_prompt_copied       category = prompt_*
--                   onboarding_open_client_clicked category = client
--                   onboarding_link_emailed        category = link_*
--                   morning_brief_opt_in           category = client
--                   morning_brief_sent             category = unknown
--        categories help_no_handshake, help_no_call, help_reconnect,
--                   prompt_reply_radar, prompt_draft_replies,
--                   prompt_morning_brief, link_add_to_ai, link_help_steps
--
-- self-host/db/00-schema.sql gains the column and a claim function that
-- always answers false (self-host has no internal accounts). Forward-only and
-- re-runnable.
-- ============================================================================

-- 1. The A10 welcome line --------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS onboarding_welcome_shown_at timestamptz;

COMMENT ON COLUMN public.workspaces.onboarding_welcome_shown_at IS
  'When mcp-server appended the one-time "what to ask next" line to the first real-inbox tool result (plan A10). Re-armed by a newer onboarding_reset_at.';

CREATE OR REPLACE FUNCTION public.claim_onboarding_welcome(p_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed uuid;
BEGIN
  UPDATE public.workspaces w
     SET onboarding_welcome_shown_at = now()
    FROM public.users u
   WHERE w.id = p_workspace_id
     AND u.id = w.owner_id
     AND w.deleted_at IS NULL
     -- No onboarding_value_activated_at check here: markFirstProductUse sets
     -- it in parallel, after the response. mcp-server only calls this when
     -- the markers it read before the call said the value marker was NULL.
     AND (
       w.onboarding_welcome_shown_at IS NULL
       OR (w.onboarding_reset_at IS NOT NULL AND w.onboarding_welcome_shown_at < w.onboarding_reset_at)
     )
     AND public.growth_is_internal_email(u.email)
  RETURNING w.id INTO v_claimed;
  RETURN v_claimed IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.claim_onboarding_welcome(uuid) IS
  'mcp-server: claim the one-time first-result welcome line for a workspace. True only for the call that stamped it. v1: internal owners only.';

REVOKE ALL ON FUNCTION public.claim_onboarding_welcome(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_onboarding_welcome(uuid) TO service_role;

-- 2. Morning brief opt-in -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_morning_brief_optins (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  time_zone text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  client text,
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'claimed', 'sent', 'failed', 'skipped')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.onboarding_morning_brief_optins IS
  'Onboarding A9 "Email me this tomorrow at 8": one service email with the morning brief prompt at 08:00 in the user''s time zone the next day. Written by POST /api/onboarding/assist, sent by /api/internal/onboarding-morning-brief/dispatch.';

CREATE INDEX IF NOT EXISTS onboarding_morning_brief_optins_due_idx
  ON public.onboarding_morning_brief_optins (send_at)
  WHERE status = 'scheduled';

ALTER TABLE public.onboarding_morning_brief_optins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.onboarding_morning_brief_optins FROM anon, authenticated;
GRANT ALL ON public.onboarding_morning_brief_optins TO service_role;

-- 3. Dispatcher ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_onboarding_morning_brief()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/onboarding-morning-brief/dispatch';
  v_secret text;
BEGIN
  -- Nothing due, no request.
  IF NOT EXISTS (
    SELECT 1 FROM public.onboarding_morning_brief_optins
     WHERE status = 'scheduled' AND send_at <= now()
  ) THEN
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret
      INTO v_secret
      FROM vault.decrypted_secrets
     WHERE name = 'dispatch_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'dispatch_onboarding_morning_brief: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_onboarding_morning_brief: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  -- Empty body: the route selects its own work.
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.dispatch_onboarding_morning_brief() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_onboarding_morning_brief() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-onboarding-morning-brief') THEN
    PERFORM cron.unschedule('dispatch-onboarding-morning-brief');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-onboarding-morning-brief',
  '*/15 * * * *',
  $$SELECT public.dispatch_onboarding_morning_brief()$$
);

-- 4. Funnel vocabulary ---------------------------------------------------------
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
  ARRAY['onboarding_handshake_seen', 'onboarding_help_shown', 'onboarding_prompt_copied',
        'onboarding_open_client_clicked', 'onboarding_link_emailed',
        'morning_brief_opt_in', 'morning_brief_sent']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_category_check', 'category',
  ARRAY['help_no_handshake', 'help_no_call', 'help_reconnect',
        'prompt_reply_radar', 'prompt_draft_replies', 'prompt_morning_brief',
        'link_add_to_ai', 'link_help_steps']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);

-- ============================================================================
-- Onboarding skeleton (WP-C, plan Documents/plans/onboarding-research-20261026.md
-- sections 3 and 8).
--
--   1. workspaces.onboarding_completed_at: the new /onboarding flow was
--      finished ("It works" reached, or the user said they are done). While it
--      is NULL a workspace in the `new` flow sees a "Finish setup" link on the
--      dashboard.
--   2. workspaces.onboarding_reset_at: the last time an internal account
--      pressed Settings > "Reset onboarding". The status API only counts
--      handshakes, credentials, inboxes and failed calls AFTER this moment, so
--      the flow can be run again without deleting anything.
--   3. workspaces_onboarding_client_check gains 'claude_code' (the client chip
--      offers Claude Code as its own choice).
--   4. product_funnel_events vocabulary, append-only:
--        stages     onboarding_step_viewed  category = step id (step_*)
--                   client_changed          category = client
--                   onboarding_reset        category = 'unknown'
--                   onboarding_completed    category = client
--        categories step_inbox, step_add_to_ai, step_first_prompt, step_wait,
--                   step_it_works, claude_code
--   5. Two experiments, seeded DRAFT: onb_flow (control | new) and
--      onb_convert (off | on). Unit: the workspace (uuid without dashes).
--      v1 serves the new flow to internal accounts only, in code
--      (apps/web/src/lib/onboarding/variant.ts); internal accounts are never
--      enrolled. Starting the test for everyone takes BOTH the admin panel
--      (status -> running) and ONBOARDING_EXPERIMENT_PUBLIC=1 on Vercel.
--
-- mcp-server reads none of the new columns, so self-host/db/00-schema.sql is
-- unchanged. Forward-only and re-runnable.
-- ============================================================================

-- 1 + 2. Columns -------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_reset_at timestamptz;

COMMENT ON COLUMN public.workspaces.onboarding_completed_at IS
  'When the /onboarding flow was finished. NULL = not finished (or reset). Written by POST /api/onboarding {action: completed}.';
COMMENT ON COLUMN public.workspaces.onboarding_reset_at IS
  'Last Settings > Reset onboarding (internal accounts only). Status signals older than this are ignored by /api/onboarding/status.';

-- 3. onboarding_client gains claude_code --------------------------------------
-- Restated in full: no other migration has touched this list since
-- 20260805010000, and it is a NULL-or-list CHECK the generic block below
-- cannot rewrite.
ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_onboarding_client_check;
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_onboarding_client_check CHECK (
  onboarding_client IS NULL OR onboarding_client IN (
    'claude', 'chatgpt', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini',
    'zed', 'jetbrains', 'raycast', 'warp', 'curl', 'unknown', 'claude_code'
  )
);

-- 4. Funnel vocabulary, append-only (same block as 20261025010000) ------------
DO $funnel$
DECLARE
  target   record;
  v_def    text;
  v_values text[];
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('product_funnel_events_stage_check', 'stage', ARRAY[
        'onboarding_step_viewed', 'client_changed', 'onboarding_reset', 'onboarding_completed'
      ]),
      ('product_funnel_events_category_check', 'category', ARRAY[
        'step_inbox', 'step_add_to_ai', 'step_first_prompt', 'step_wait', 'step_it_works',
        'claude_code'
      ])
    ) AS t(conname, col, additions)
  LOOP
    SELECT pg_get_constraintdef(c.oid)
      INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.product_funnel_events'::regclass
       AND c.conname = target.conname
       AND c.contype = 'c';

    IF v_def IS NULL THEN
      RAISE NOTICE '% does not exist, onboarding values not added.', target.conname;
      CONTINUE;
    END IF;

    IF v_def !~ ('^CHECK \(\(' || target.col || ' = ANY \(') THEN
      RAISE EXCEPTION '% is not a plain list, not rewritten: %', target.conname, v_def;
    END IF;

    SELECT array_agg(u.v ORDER BY t.n, u.k)
      INTO v_values
      FROM regexp_matches(v_def, '''((?:[^'']|'''')*)''(::text\[\])?', 'g') WITH ORDINALITY AS t(m, n)
      CROSS JOIN LATERAL unnest(
             CASE WHEN t.m[2] IS NULL
                  THEN ARRAY[replace(t.m[1], '''''', '''')]
                  ELSE replace(t.m[1], '''''', '''')::text[]
             END
           ) WITH ORDINALITY AS u(v, k);

    IF v_values IS NULL OR cardinality(v_values) = 0 THEN
      RAISE EXCEPTION '% has no readable values: %', target.conname, v_def;
    END IF;

    IF target.additions <@ v_values THEN
      CONTINUE;
    END IF;

    SELECT v_values || coalesce(array_agg(a.v ORDER BY a.n), ARRAY[]::text[])
      INTO v_values
      FROM unnest(target.additions) WITH ORDINALITY AS a(v, n)
     WHERE a.v <> ALL (v_values);

    EXECUTE format('ALTER TABLE public.product_funnel_events DROP CONSTRAINT %I', target.conname);
    EXECUTE format(
      'ALTER TABLE public.product_funnel_events ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[%s]))',
      target.conname,
      target.col,
      (SELECT string_agg(quote_literal(x.v) || '::text', ', ' ORDER BY x.n)
         FROM unnest(v_values) WITH ORDINALITY AS x(v, n))
    );
  END LOOP;
END;
$funnel$;

-- 5. Experiments, seeded draft ------------------------------------------------
INSERT INTO public.experiments (key, name, description, status, variants, retention_goal, retention_window_days)
VALUES (
  'onb_flow',
  'Onboarding flow: today vs /onboarding (Flow A)',
  'Unit is the workspace (uuid without dashes), assigned when the workspace is created (web signup and /authorize). control = today''s dashboard first run; new = the /onboarding flow. 2x2 with onb_convert. v1: internal accounts get new in code and are never enrolled; enrolment needs status running AND ONBOARDING_EXPERIMENT_PUBLIC=1.',
  'draft',
  '[{"id":"control","label":"Today''s first run","weight":50},{"id":"new","label":"/onboarding flow","weight":50}]'::jsonb,
  'value_activation',
  7
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.experiments (key, name, description, status, variants, retention_goal, retention_window_days)
VALUES (
  'onb_convert',
  'Onboarding conversion moments (Flow B)',
  'Unit is the workspace (uuid without dashes), assigned with onb_flow. off = no conversion moments; on = B1 second inbox, B2 plan summary, B3 meter and cap note. v1: internal accounts get on in code and are never enrolled; enrolment needs status running AND ONBOARDING_EXPERIMENT_PUBLIC=1.',
  'draft',
  '[{"id":"off","label":"No conversion moments","weight":50},{"id":"on","label":"Conversion moments","weight":50}]'::jsonb,
  'any_tool_call',
  30
)
ON CONFLICT (key) DO NOTHING;

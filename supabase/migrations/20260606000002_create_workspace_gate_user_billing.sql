-- ============================================================
-- MCPEmails — Gate create_workspace() on the USER's entitlement
-- 20260606000002_create_workspace_gate_user_billing
--
-- WHY
--   create_workspace() previously gated on whether the caller OWNED a workspace
--   on plan IN ('pro','enterprise'). With the subscription now tied to the user
--   (see 20260606000000_user_level_billing.sql), the gate must check the user's
--   single entitlement in `public.user_billing`, not a per-workspace plan.
--
--   Per Documents/pricing-strategy.md, "multiple workspaces" is a **Team**-only
--   feature (internal id `pro`). Solo does NOT unlock additional workspaces.
--   So the gate requires the user's entitlement to be 'pro'.
--
--   The new workspace inherits the caller's entitled plan, so all workspaces a
--   user owns share one plan — consistent with the webhook's propagation.
--
-- Error code (SQLSTATE) caught and mapped in the route handler:
--   P0001  workspace_create_requires_pro → 403
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_workspace(p_name text)
RETURNS TABLE (
  id           uuid,
  slug         text,
  display_name text,
  plan         text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_plan         text;
  v_display_name text;
  v_base_slug    text;
  v_slug         text;
  v_suffix       integer := 0;
  v_workspace_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;

  -- Gate: the caller's USER-LEVEL entitlement must be a multi-workspace plan.
  -- 'pro' (Team) is the only tier that unlocks additional workspaces.
  -- (Read from user_billing — the single source of truth — not workspaces.plan.)
  SELECT ub.plan INTO v_plan
  FROM   public.user_billing ub
  WHERE  ub.user_id = v_uid
  AND    ub.plan = 'pro'
  LIMIT  1;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'workspace_create_requires_pro' USING ERRCODE = 'P0001';
  END IF;

  -- Display name: trimmed input, fall back to a generic label.
  v_display_name := NULLIF(BTRIM(COALESCE(p_name, '')), '');
  IF v_display_name IS NULL THEN
    v_display_name := 'Workspace';
  END IF;

  -- Slug: lowercase, non-alphanumerics collapsed to single hyphens, trimmed.
  v_base_slug := LOWER(
    REGEXP_REPLACE(
      REGEXP_REPLACE(v_display_name, '[^a-zA-Z0-9]+', '-', 'g'),
      '^-+|-+$', '', 'g'
    )
  );
  IF v_base_slug = '' THEN
    v_base_slug := 'workspace';
  END IF;
  v_slug := v_base_slug;

  -- Ensure slug uniqueness with a numeric suffix if needed.
  WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE workspaces.slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug   := v_base_slug || '-' || v_suffix;
  END LOOP;

  -- Atomic write 1: create the workspace owned by the caller (inherits plan).
  INSERT INTO public.workspaces (owner_id, slug, display_name, plan)
  VALUES (v_uid, v_slug, v_display_name, v_plan)
  RETURNING workspaces.id INTO v_workspace_id;

  -- Atomic write 2: add the caller as the owner member.
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, v_uid, 'owner');

  RETURN QUERY
    SELECT v_workspace_id, v_slug, v_display_name, v_plan;
END;
$$;

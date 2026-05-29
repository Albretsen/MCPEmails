-- ============================================================
-- MCPEmails — Multi-workspace creation
-- 20260530000000_create_workspace_rpc
--
-- Adds create_workspace(p_name) — an atomic SECURITY DEFINER RPC
-- that lets a Pro/Enterprise owner spin up additional workspaces.
--
-- Gating (enforced in-DB, not just in the API route):
--   The caller must already OWN at least one non-deleted workspace
--   on the 'pro' or 'enterprise' plan. Owning a Free/Solo workspace,
--   or merely being an invited member of a Pro workspace, does NOT
--   unlock creation — only owning a Pro workspace does.
--
-- The new workspace INHERITS the caller's best owned qualifying plan
-- (enterprise outranks pro), mirroring the product decision that a
-- Pro subscription covers all of that owner's workspaces.
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

  -- Gate: caller must own a non-deleted Pro/Enterprise workspace.
  -- Pick the best qualifying plan to inherit (enterprise > pro).
  SELECT w.plan INTO v_plan
  FROM   public.workspaces w
  WHERE  w.owner_id = v_uid
  AND    w.deleted_at IS NULL
  AND    w.plan IN ('pro', 'enterprise')
  ORDER  BY CASE w.plan WHEN 'enterprise' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END DESC
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

  -- Atomic write 1: create the workspace owned by the caller.
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

-- Single permission-aware read path for workspace capabilities. This lets an
-- invited member receive the owner's comped Scale capabilities without giving
-- the member direct access to the entitlement record or its support reason.
CREATE OR REPLACE FUNCTION public.effective_workspace_plan(p_workspace_id uuid)
RETURNS TABLE(plan text, comped_scale boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    CASE WHEN e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > now()) THEN 'pro'
      ELSE w.plan
    END AS plan,
    (e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now())) AS comped_scale
  FROM public.workspaces w
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE w.id = p_workspace_id
    AND w.id = ANY(public.my_workspace_ids());
$$;

REVOKE ALL ON FUNCTION public.effective_workspace_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_workspace_plan(uuid) TO authenticated;

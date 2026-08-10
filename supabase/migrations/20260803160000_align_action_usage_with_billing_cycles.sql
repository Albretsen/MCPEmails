-- Action limits must use the same billing-cycle boundaries as Stripe, rather
-- than a UTC calendar month. Free workspaces use a calendar-month cycle until
-- they acquire a Stripe subscription; paid workspaces use Stripe's exact
-- current period start/end timestamps stored on their owner billing row.

ALTER TABLE public.user_billing
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz;

COMMENT ON COLUMN public.user_billing.current_period_start IS
  'Stripe subscription current billing period start. Together with current_period_end this defines the action allowance window.';

CREATE OR REPLACE FUNCTION public.reserve_action_usage(
  p_workspace_id uuid,
  p_tool_name text,
  p_meter_version integer,
  p_cap integer,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS TABLE(reservation_id uuid, allowed boolean, used_actions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_used integer;
  v_reservation_id uuid;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_start >= p_period_end THEN
    RAISE EXCEPTION 'invalid_usage_billing_window' USING ERRCODE = '22007';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  DELETE FROM public.action_usage_reservations
    WHERE workspace_id = p_workspace_id AND expires_at <= now();
  SELECT count(*)::integer INTO v_used FROM (
    SELECT id FROM public.action_usage
      WHERE workspace_id = p_workspace_id AND billable = true
        AND meter_version = p_meter_version
        AND occurred_at >= p_period_start AND occurred_at < p_period_end
    UNION ALL
    SELECT id FROM public.action_usage_reservations
      WHERE workspace_id = p_workspace_id AND meter_version = p_meter_version
        AND expires_at > now()
  ) AS occupied;
  IF v_used >= p_cap THEN
    RETURN QUERY SELECT NULL::uuid, false, v_used;
    RETURN;
  END IF;
  INSERT INTO public.action_usage_reservations (workspace_id, tool_name, meter_version, expires_at)
  VALUES (p_workspace_id, p_tool_name, p_meter_version, LEAST(now() + interval '15 minutes', p_period_end))
  RETURNING id INTO v_reservation_id;
  RETURN QUERY SELECT v_reservation_id, true, v_used + 1;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_action_usage(uuid, text, integer, integer, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_action_usage(uuid, text, integer, integer, timestamptz, timestamptz) TO service_role;

-- The previous four-argument RPC is intentionally removed so all callers must
-- supply a verified, explicit billing window.
REVOKE ALL ON FUNCTION public.reserve_action_usage(uuid, text, integer, integer) FROM PUBLIC;
DROP FUNCTION public.reserve_action_usage(uuid, text, integer, integer);

-- Comped owners receive Scale access in every workspace, including the
-- workspace-creation gate (not just via the BEFORE INSERT projection trigger).
CREATE OR REPLACE FUNCTION public.create_workspace(p_name text)
RETURNS TABLE (id uuid, slug text, display_name text, plan text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_plan text;
  v_display_name text;
  v_base_slug text;
  v_slug text;
  v_suffix integer := 0;
  v_workspace_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.user_usage_entitlements e
      WHERE e.user_id = v_uid AND e.kind = 'comped_scale'
        AND (e.expires_at IS NULL OR e.expires_at > now())
    ) THEN 'pro'
    ELSE ub.plan
  END INTO v_plan
  FROM public.user_billing ub
  WHERE ub.user_id = v_uid
  LIMIT 1;

  IF v_plan IS DISTINCT FROM 'pro' THEN
    RAISE EXCEPTION 'workspace_create_requires_pro' USING ERRCODE = 'P0001';
  END IF;

  v_display_name := NULLIF(BTRIM(COALESCE(p_name, '')), '');
  IF v_display_name IS NULL THEN v_display_name := 'Workspace'; END IF;
  v_base_slug := LOWER(REGEXP_REPLACE(REGEXP_REPLACE(v_display_name, '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'));
  IF v_base_slug = '' THEN v_base_slug := 'workspace'; END IF;
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE workspaces.slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  END LOOP;
  INSERT INTO public.workspaces (owner_id, slug, display_name, plan)
  VALUES (v_uid, v_slug, v_display_name, v_plan)
  RETURNING workspaces.id INTO v_workspace_id;
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, v_uid, 'owner');
  RETURN QUERY SELECT v_workspace_id, v_slug, v_display_name, v_plan;
END;
$$;

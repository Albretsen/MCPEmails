-- Prevent concurrent billable MCP calls from overshooting a workspace cap.
-- A short-lived reservation is created before dispatch and is converted to a
-- successful action only after the tool succeeds. Failed calls release it.

CREATE TABLE public.action_usage_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  tool_name      text NOT NULL,
  meter_version  integer NOT NULL CHECK (meter_version > 0),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX action_usage_reservations_workspace_expiry_idx
  ON public.action_usage_reservations (workspace_id, expires_at);

ALTER TABLE public.action_usage_reservations ENABLE ROW LEVEL SECURITY;

-- Service-role RPC only. Reservations never expose customer content or API
-- parameters, and expire automatically if an edge invocation is interrupted.
CREATE OR REPLACE FUNCTION public.reserve_action_usage(
  p_workspace_id uuid,
  p_tool_name text,
  p_meter_version integer,
  p_cap integer
)
RETURNS TABLE(reservation_id uuid, allowed boolean, used_actions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_used integer;
  v_reservation_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  DELETE FROM public.action_usage_reservations
    WHERE workspace_id = p_workspace_id AND expires_at <= now();
  SELECT count(*)::integer INTO v_used FROM (
    SELECT id FROM public.action_usage
      WHERE workspace_id = p_workspace_id AND billable = true
        AND meter_version = p_meter_version
        AND occurred_at >= date_trunc('month', now())
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
  VALUES (p_workspace_id, p_tool_name, p_meter_version, now() + interval '15 minutes')
  RETURNING id INTO v_reservation_id;
  RETURN QUERY SELECT v_reservation_id, true, v_used + 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_action_usage_reservation(
  p_reservation_id uuid,
  p_succeeded boolean
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_reservation public.action_usage_reservations%ROWTYPE;
BEGIN
  DELETE FROM public.action_usage_reservations
    WHERE id = p_reservation_id
    RETURNING * INTO v_reservation;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_succeeded THEN
    INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version)
    VALUES (v_reservation.workspace_id, v_reservation.tool_name, true, 1, v_reservation.meter_version);
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_action_usage(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_action_usage_reservation(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_action_usage(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_action_usage_reservation(uuid, boolean) TO service_role;

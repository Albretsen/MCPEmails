-- ===========================================================================
-- Fix record_usage_limit_event(): it declared the funnel row's id as uuid.
--
-- `product_funnel_events.id` is `bigint GENERATED ALWAYS AS IDENTITY`, not a
-- uuid (20260802000000). The RETURNING ... INTO in 20260819150000 therefore
-- raised 22P02 "invalid input syntax for type uuid", and because the whole
-- function body is one transaction, the abort rolled back the
-- usage_limit_events insert alongside it. The net effect of the version shipped
-- 15 minutes earlier was that a cap rejection recorded NOTHING at all: no
-- metering row, no funnel row. Caught by exercising the RPC against the real
-- database before wiring the edge function to it.
--
-- The replacement stops depending on the key type entirely. GET DIAGNOSTICS
-- ROW_COUNT answers the only question the caller has ("did the funnel row get
-- written this time?") and keeps working if the surrogate key ever changes.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_usage_limit_event(
  p_workspace_id  uuid,
  p_plan          text,
  p_used_actions  integer,
  p_cap           integer,
  p_meter_version integer,
  p_period_start  timestamptz
)
RETURNS TABLE (funnel_row_written boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_funnel_rows integer;
BEGIN
  INSERT INTO public.usage_limit_events
    (workspace_id, effective_plan, used_actions, cap, meter_version)
  VALUES
    (p_workspace_id, p_plan, p_used_actions, p_cap, p_meter_version);

  -- Serialised per workspace so two concurrent rejections cannot both pass the
  -- NOT EXISTS check. Same lock key as reserve_action_usage, so a rejection and
  -- a reservation for one workspace never interleave here.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
  SELECT
    p_workspace_id,
    'paywall_reached',
    'success',
    CASE WHEN p_plan IN ('solo', 'pro') THEN p_plan ELSE 'free' END
  WHERE NOT EXISTS (
    SELECT 1 FROM public.product_funnel_events e
    WHERE e.workspace_id = p_workspace_id
      AND e.stage = 'paywall_reached'
      AND e.occurred_at >= p_period_start
  );

  GET DIAGNOSTICS v_funnel_rows = ROW_COUNT;
  RETURN QUERY SELECT v_funnel_rows > 0;
END;
$$;

COMMENT ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) IS
  'Records one action-cap rejection. Always appends to usage_limit_events; appends the paywall_reached funnel row at most once per workspace per billing period.';

REVOKE ALL ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) TO service_role;

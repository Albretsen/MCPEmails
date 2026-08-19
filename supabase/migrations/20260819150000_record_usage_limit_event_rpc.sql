-- ===========================================================================
-- One RPC for recording a cap rejection, so the two records it writes can
-- finally disagree on purpose.
--
-- `usage_limit_events` is the metering-accurate record: one row per rejected
-- call, because support and capacity questions need every rejection.
--
-- `product_funnel_events.paywall_reached` is a FUNNEL row, and a funnel stage
-- is something a workspace enters, not something it does repeatedly. The edge
-- function used to insert one of each per rejection, so an agent that retried
-- a blocked call three times booked three paywall hits against one workspace
-- that reached one paywall. `cap_hit_workspaces` counts DISTINCT workspace and
-- survived that, but `paywall_hits` in billing_funnel_summary is a COUNT(*),
-- and it is the denominator for paywall -> pricing_viewed conversion. Left
-- alone it would have made the first real cap hit look like a burst of demand
-- and the conversion rate look like a floor.
--
-- So: the funnel row is written at most once per workspace per billing period.
-- The period is passed in rather than derived, for the same reason
-- 20260819130000 passes it to workspace_usage_summary: there is one definition
-- of a billing cycle (lib/usage/billing-window.ts and the edge function's
-- resolveUsageBillingWindow) and this must not become a second one.
--
-- Both inserts move into one round trip. A cap rejection is on the hot path of
-- a request that is already failing; it should not cost two.
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
  v_inserted uuid;
BEGIN
  INSERT INTO public.usage_limit_events
    (workspace_id, effective_plan, used_actions, cap, meter_version)
  VALUES
    (p_workspace_id, p_plan, p_used_actions, p_cap, p_meter_version);

  -- Serialised per workspace so two concurrent rejections cannot both pass the
  -- NOT EXISTS check. The same lock key the reservation RPC uses, so a
  -- rejection and a reservation for one workspace never interleave here.
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
  )
  RETURNING id INTO v_inserted;

  RETURN QUERY SELECT v_inserted IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) IS
  'Records one action-cap rejection. Always appends to usage_limit_events; appends the paywall_reached funnel row at most once per workspace per billing period.';

REVOKE ALL ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) TO service_role;

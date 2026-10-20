-- tools/call gate: the preflight reads AND the allowance reservation, in one
-- round trip.
--
-- Measured 2026-10-20 after mcp_tools_call_preflight (20261020100000) went
-- live: pre_ms p50 ~159 ms for unmetered calls (one round trip) but ~311 ms
-- for metered ones, which still paid a second sequential round trip for
-- reserve_action_usage. Metered calls are about 60% of traffic. The edge
-- function runs in us-east-1 and this database in eu-north-1, ~124 ms apart.
--
-- What this adds over mcp_tools_call_preflight (which stays, unchanged, so the
-- currently deployed edge function keeps working and rollback is a redeploy):
--
--   1. The reservation. When the caller names the tool it expects to meter
--      (p_reserve_tool_name) and the workspace is metered, this calls the
--      UNCHANGED public.reserve_action_usage() with the cap and window the
--      allowance terms give. The edge function stays the authority: it
--      re-derives the decision from the returned allowance row and uses the
--      reservation only when the tool, cap and window all match what it would
--      have reserved itself. Anything else (a refused gate, a validation error,
--      a different resolved tool) releases it with the unchanged
--      finalize_action_usage_reservation(id, false), BEFORE any other
--      reservation is made. A failed reservation is reported, not raised, so
--      it fails open exactly as the separate RPC call did.
--
--   2. No usage count on the hot path. workspace_action_allowance() counts
--      every action_usage row of the period, and the tools/call path never
--      reads that count: the decision uses plan, exemptions, grace, cap and
--      window only, and the reservation does its own authoritative count
--      under the workspace advisory lock. workspace_action_allowance_terms()
--      is the same function with the count removed (used and remaining are
--      NULL). workspace_action_allowance() itself, which the dashboard and
--      the automation runner read, is not touched.
--
--   3. last_used_at, throttled. Written here, last, only when it is null or
--      more than 60 s old. Its readers (the dashboard and API key list, the
--      admin directory, the dormant OAuth sweep at 90 days, card-build-notify's
--      null check) do not need sub-minute precision. The key row returned is
--      the one read BEFORE the write, so card-build-notify still sees whether
--      the key had been used before this request.
--
--   4. workspaces.card_diagnostics, so the card stamp at the end of a
--      tools/call does not read the workspace row a second time.
--
-- Service role only. VOLATILE (it writes), SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.workspace_action_allowance_terms(p_workspace_id uuid)
 RETURNS TABLE(plan text, owner_id uuid, exempt boolean, exempt_reason text, cap integer, period_start timestamp with time zone, period_end timestamp with time zone, grace_ends_at timestamp with time zone, in_grace boolean, used integer, remaining integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Sections (a) to (d) of workspace_action_allowance(), verbatim, including
  -- the constants. Section (e), the count, is the only thing removed.
  -- Keep the two in step: the parity check in
  -- supabase/tests/mcp_tools_call_gate.sql compares them column by column.
  c_free_cap        constant integer  := 150;
  c_cap_personal    constant integer  := 100000;
  c_cap_solo        constant integer  := 100000;
  c_cap_pro         constant integer  := 500000;
  c_cap_other       constant integer  := 5000;

  v_plan            text;
  v_owner_id        uuid;
  v_created_at      timestamptz;
  v_early_member    boolean;
  v_exempt          boolean := false;
  v_exempt_reason   text;
  v_cap             integer;
  v_now             timestamptz := now();
  v_month_start     timestamptz;
  v_month_end       timestamptz;
  v_period_start    timestamptz;
  v_period_end      timestamptz;
  v_grace_ends_at   timestamptz;
  v_in_grace        boolean := false;
  v_ub_start        timestamptz;
  v_ub_end          timestamptz;
BEGIN
  SELECT w.plan, w.owner_id, w.created_at, w.free_action_cap_exempt
    INTO v_plan, v_owner_id, v_created_at, v_early_member
  FROM public.workspaces w
  WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_month_start := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month_end   := v_month_start + interval '1 month';

  IF v_early_member THEN
    v_exempt := true;
    v_exempt_reason := 'early_member';
  ELSIF EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id
      AND e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'comped';
  ELSIF EXISTS (
    SELECT 1 FROM public.workspace_usage_exemptions x
    WHERE x.workspace_id = p_workspace_id
      AND x.revoked_at IS NULL
      AND (x.expires_at IS NULL OR x.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'exemption';
  END IF;

  IF v_exempt THEN
    v_cap := NULL;
    v_period_start := v_month_start;
    v_period_end := v_month_end;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSIF v_plan IS DISTINCT FROM 'free' THEN
    SELECT ub.current_period_start, ub.current_period_end
      INTO v_ub_start, v_ub_end
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id
    LIMIT 1;
    IF v_ub_start IS NOT NULL AND v_ub_end IS NOT NULL
       AND v_ub_start <= v_now AND v_now < v_ub_end THEN
      v_period_start := v_ub_start;
      v_period_end := v_ub_end;
    ELSE
      v_period_start := v_month_start;
      v_period_end := v_month_end;
    END IF;
    v_cap := CASE v_plan
      WHEN 'personal' THEN c_cap_personal
      WHEN 'solo'     THEN c_cap_solo
      WHEN 'pro'      THEN c_cap_pro
      ELSE c_cap_other
    END;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSE
    v_grace_ends_at := public.free_action_grace_ends_at(v_created_at);
    v_in_grace := v_now < v_grace_ends_at;
    v_period_end := v_month_end;
    v_period_start := LEAST(GREATEST(v_month_start, v_grace_ends_at), v_month_end);
    v_cap := c_free_cap;
  END IF;

  RETURN QUERY SELECT
    v_plan, v_owner_id, v_exempt, v_exempt_reason, v_cap,
    v_period_start, v_period_end, v_grace_ends_at, v_in_grace,
    NULL::integer, NULL::integer;
END;
$function$;

REVOKE ALL ON FUNCTION public.workspace_action_allowance_terms(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_action_allowance_terms(uuid) TO service_role;

COMMENT ON FUNCTION public.workspace_action_allowance_terms(uuid) IS
  'workspace_action_allowance() without the usage count (used and remaining are NULL): '
  'the plan, exemption, grace, cap and window a tools/call decides on. Hot path of '
  'mcp_tools_call_gate. Service role only.';

CREATE OR REPLACE FUNCTION public.mcp_tools_call_gate(
  p_key_hash text,
  p_key_window_starts timestamptz[],
  p_workspace_window_start timestamptz,
  p_include_allowance boolean,
  p_reserve_tool_name text,
  p_meter_version integer
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key           jsonb;
  v_key_id        uuid;
  v_workspace_id  uuid;
  v_last_used_at  timestamptz;
  v_workspace     jsonb;
  v_owner_id      uuid;
  v_entitlement   jsonb;
  v_terms         record;
  v_allowance     jsonb;
  v_reservation   jsonb;
  v_res           record;
  v_key_counts    jsonb;
  v_ws_count      bigint;
  v_stamped       boolean := false;
BEGIN
  -- (a) The key, with the three filters authenticateRequest applies.
  SELECT jsonb_build_object(
           'id', k.id,
           'workspace_id', k.workspace_id,
           'created_by', k.created_by,
           'name', k.name,
           'key_prefix', k.key_prefix,
           'key_hash', k.key_hash,
           'scopes', k.scopes,
           'inbox_ids', k.inbox_ids,
           'expires_at', k.expires_at,
           'last_used_at', k.last_used_at,
           'deleted_at', k.deleted_at,
           'created_at', k.created_at,
           'card_build_notified', k.card_build_notified
         ),
         k.id,
         k.workspace_id,
         k.last_used_at
    INTO v_key, v_key_id, v_workspace_id, v_last_used_at
  FROM public.api_keys k
  WHERE k.key_hash = p_key_hash
    AND k.deleted_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());

  IF v_key IS NULL THEN
    RETURN jsonb_build_object('key', NULL);
  END IF;

  -- (b) Per-key activity_log counts, one per window start, in caller order.
  SELECT COALESCE(jsonb_agg(c.n ORDER BY c.ord), '[]'::jsonb)
    INTO v_key_counts
  FROM (
    SELECT t.ord,
           (SELECT count(*) FROM public.activity_log a
             WHERE a.api_key_id = v_key_id AND a.created_at >= t.s) AS n
    FROM unnest(p_key_window_starts) WITH ORDINALITY AS t(s, ord)
  ) c;

  -- (c) The workspace row checkPlanQuota reads, the activation markers, and
  -- the card diagnostics flag.
  SELECT jsonb_build_object(
           'plan', w.plan,
           'grandfathered', w.grandfathered,
           'owner_id', w.owner_id,
           'analytics_first_tool_used_at', w.analytics_first_tool_used_at,
           'onboarding_value_activated_at', w.onboarding_value_activated_at,
           'card_diagnostics', w.card_diagnostics
         ),
         w.owner_id
    INTO v_workspace, v_owner_id
  FROM public.workspaces w
  WHERE w.id = v_workspace_id;

  IF v_workspace IS NOT NULL THEN
    -- (d) The owner's entitlement.
    SELECT jsonb_build_object('kind', e.kind, 'expires_at', e.expires_at)
      INTO v_entitlement
    FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id;

    -- (e) The workspace's trailing-minute count for the plan ceiling.
    SELECT count(*) INTO v_ws_count
    FROM public.activity_log a
    WHERE a.workspace_id = v_workspace_id
      AND a.created_at >= p_workspace_window_start;
  END IF;

  -- (f) The allowance terms, and the reservation when the call is metered.
  IF p_include_allowance THEN
    SELECT * INTO v_terms
    FROM public.workspace_action_allowance_terms(v_workspace_id)
    LIMIT 1;

    IF FOUND THEN
      v_allowance := jsonb_build_object(
        'plan', v_terms.plan,
        'owner_id', v_terms.owner_id,
        'exempt', v_terms.exempt,
        'exempt_reason', v_terms.exempt_reason,
        'cap', v_terms.cap,
        'period_start', v_terms.period_start,
        'period_end', v_terms.period_end,
        'grace_ends_at', v_terms.grace_ends_at,
        'in_grace', v_terms.in_grace,
        'used', NULL,
        'remaining', NULL
      );

      -- Same rule as allowanceDecision() in action-allowance.ts: metered
      -- unless exempt, in grace, uncapped, or an empty window.
      IF p_reserve_tool_name IS NOT NULL
         AND NOT v_terms.exempt
         AND NOT v_terms.in_grace
         AND v_terms.cap IS NOT NULL
         AND v_terms.period_start < v_terms.period_end THEN
        BEGIN
          SELECT * INTO v_res
          FROM public.reserve_action_usage(
            v_workspace_id, p_reserve_tool_name, p_meter_version, v_terms.cap,
            v_terms.period_start, v_terms.period_end
          );
          v_reservation := jsonb_build_object(
            'tool_name', p_reserve_tool_name,
            'meter_version', p_meter_version,
            'cap', v_terms.cap,
            'period_start', v_terms.period_start,
            'period_end', v_terms.period_end,
            'row', CASE WHEN v_res IS NULL THEN NULL ELSE jsonb_build_object(
              'reservation_id', v_res.reservation_id,
              'allowed', v_res.allowed,
              'used_actions', v_res.used_actions
            ) END
          );
        EXCEPTION WHEN OTHERS THEN
          -- The separate RPC call failed open on any error; so does this.
          v_reservation := jsonb_build_object(
            'tool_name', p_reserve_tool_name,
            'meter_version', p_meter_version,
            'cap', v_terms.cap,
            'period_start', v_terms.period_start,
            'period_end', v_terms.period_end,
            'error', SQLERRM,
            'error_code', SQLSTATE
          );
        END;
      END IF;
    END IF;
  END IF;

  -- (g) last_used_at, last and throttled, so the row lock is held briefly and
  -- at most once a minute per key.
  IF v_last_used_at IS NULL OR v_last_used_at < now() - interval '60 seconds' THEN
    UPDATE public.api_keys
       SET last_used_at = now()
     WHERE id = v_key_id
       AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds');
    v_stamped := FOUND;
  END IF;

  RETURN jsonb_build_object(
    'key', v_key,
    'key_counts', v_key_counts,
    'workspace', v_workspace,
    'entitlement', v_entitlement,
    'workspace_count', v_ws_count,
    'allowance', v_allowance,
    'reservation', v_reservation,
    'last_used_stamped', v_stamped
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mcp_tools_call_gate(text, timestamptz[], timestamptz, boolean, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_tools_call_gate(text, timestamptz[], timestamptz, boolean, text, integer) TO service_role;

COMMENT ON FUNCTION public.mcp_tools_call_gate(text, timestamptz[], timestamptz, boolean, text, integer) IS
  'mcp-server tools/call gate in one round trip: everything mcp_tools_call_preflight '
  'returns, plus workspaces.card_diagnostics, the allowance terms without a usage count, '
  'reserve_action_usage() when the caller names a tool and the workspace is metered, and '
  'a last_used_at stamp at most once a minute. The edge function makes every decision and '
  'releases a reservation it does not use. Service role only.';

-- Every read a tools/call makes before its handler, in one round trip.
--
-- Measured 2026-10-19/20: pre_ms p50 ~560-590 ms, 44% of total time for
-- non-IMAP calls. The mcp-server edge function runs in us-east-1 (near the US
-- mail hosts) and this database is in eu-north-1, so each PostgREST round trip
-- costs ~124 ms. Before the handler a metered call paid four of them in
-- sequence: the key lookup; then the per-key limiter counts, the workspace row
-- and the allowance row together; then the owner's entitlement (keyed by the
-- workspace row's owner_id); then the allowance reservation.
--
-- This function answers the first three in one call. It returns RAW data
-- only. Every decision (which window is saturated, the plan ceiling, the
-- grandfathered and comped rules, fail-open on a missing workspace) stays in
-- index.ts, which feeds these values into the same checkRateLimit /
-- checkPlanQuota code the per-query path uses. Window starts come from the
-- caller so the window table stays in one place (RATE_LIMIT_WINDOWS,
-- PLAN_RPM_WINDOW_MS). The reservation is NOT folded in: it must only happen
-- after both gates pass and the arguments validate.
--
-- Key filters match authenticateRequest exactly: key_hash equality,
-- deleted_at IS NULL, expires_at IS NULL OR in the future. An unknown,
-- revoked or expired key returns {"key": null} and reads nothing else.
--
-- If this function errors or is missing, the edge function falls back to the
-- per-query path, so applying this migration and deploying the function can
-- happen in either order. Read-only (STABLE). Service role only.

CREATE OR REPLACE FUNCTION public.mcp_tools_call_preflight(
  p_key_hash text,
  p_key_window_starts timestamptz[],
  p_workspace_window_start timestamptz,
  p_include_allowance boolean
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_key           jsonb;
  v_key_id        uuid;
  v_workspace_id  uuid;
  v_workspace     jsonb;
  v_owner_id      uuid;
  v_entitlement   jsonb;
  v_allowance     jsonb;
  v_key_counts    jsonb;
  v_ws_count      bigint;
BEGIN
  -- (a) The key. key_hash is UNIQUE, so at most one row.
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
         k.workspace_id
    INTO v_key, v_key_id, v_workspace_id
  FROM public.api_keys k
  WHERE k.key_hash = p_key_hash
    AND k.deleted_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());

  IF v_key IS NULL THEN
    RETURN jsonb_build_object('key', NULL);
  END IF;

  -- (b) Per-key activity_log counts, one per window start, in the caller's
  -- order. Same filter as checkRateLimit's HEAD count=exact queries.
  SELECT COALESCE(jsonb_agg(c.n ORDER BY c.ord), '[]'::jsonb)
    INTO v_key_counts
  FROM (
    SELECT t.ord,
           (SELECT count(*) FROM public.activity_log a
             WHERE a.api_key_id = v_key_id AND a.created_at >= t.s) AS n
    FROM unnest(p_key_window_starts) WITH ORDINALITY AS t(s, ord)
  ) c;

  -- (c) The workspace row checkPlanQuota reads, with the two activation
  -- markers markFirstProductUse rides on.
  SELECT jsonb_build_object(
           'plan', w.plan,
           'grandfathered', w.grandfathered,
           'owner_id', w.owner_id,
           'analytics_first_tool_used_at', w.analytics_first_tool_used_at,
           'onboarding_value_activated_at', w.onboarding_value_activated_at
         ),
         w.owner_id
    INTO v_workspace, v_owner_id
  FROM public.workspaces w
  WHERE w.id = v_workspace_id;

  IF v_workspace IS NOT NULL THEN
    -- (d) The owner's entitlement (user_id is the primary key).
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

  -- (f) The allowance row, only when the call may be metered.
  IF p_include_allowance THEN
    SELECT to_jsonb(a) INTO v_allowance
    FROM public.workspace_action_allowance(v_workspace_id) a
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'key', v_key,
    'key_counts', v_key_counts,
    'workspace', v_workspace,
    'entitlement', v_entitlement,
    'workspace_count', v_ws_count,
    'allowance', v_allowance
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mcp_tools_call_preflight(text, timestamptz[], timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_tools_call_preflight(text, timestamptz[], timestamptz, boolean) TO service_role;

COMMENT ON FUNCTION public.mcp_tools_call_preflight(text, timestamptz[], timestamptz, boolean) IS
  'mcp-server tools/call pre-handler reads in one round trip: key lookup, per-key '
  'activity_log window counts, workspace plan row, owner entitlement, workspace '
  'minute count, and optionally workspace_action_allowance(). Raw data only; the '
  'edge function makes every decision. Service role only.';

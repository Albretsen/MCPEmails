-- ===========================================================================
-- mcp_tools_call_gate returns api_keys.card_listed.
-- 20261027150000_tools_call_gate_card_listed
--
-- A tools/call authenticates through this function, not through the api_keys
-- select in mcp-server, so its key row must carry every column that select
-- does. 20261027140000 added card_listed (did the key's last tool list carry
-- the draft card); without it here a draft call would never see `false` and
-- would keep telling the model a card is on screen in a chat that has none.
--
-- The function is re-created exactly as 20261025090000_referrals.sql left it
-- (checked against the live definition on 2026-10-27), with that one field
-- added. card_build_notified is only read here, as before.
--
-- Apply after 20261027140000, before deploying mcp-server, with
-- `db query --linked -f` and `migration repair` (never db push).
-- ===========================================================================

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
           'card_build_notified', k.card_build_notified,
           'card_listed', k.card_listed
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

  -- (c) The workspace row checkPlanQuota reads, the activation markers, the
  -- card diagnostics flag, and the failed-payment markers (payment-notice.ts).
  SELECT jsonb_build_object(
           'plan', w.plan,
           'grandfathered', w.grandfathered,
           'owner_id', w.owner_id,
           'analytics_first_tool_used_at', w.analytics_first_tool_used_at,
           'onboarding_value_activated_at', w.onboarding_value_activated_at,
           'card_diagnostics', w.card_diagnostics,
           'payment_issue_since', w.payment_issue_since,
           'payment_issue_kind', w.payment_issue_kind,
           'payment_notice_shown_on', w.payment_notice_shown_on
         ),
         w.owner_id
    INTO v_workspace, v_owner_id
  FROM public.workspaces w
  WHERE w.id = v_workspace_id;

  IF v_workspace IS NOT NULL THEN
    -- (d) The owner's entitlement.
    SELECT jsonb_build_object(
             'kind', e.kind,
             'expires_at', e.expires_at,
             'referral_personal_until', e.referral_personal_until
           )
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

-- Failed-payment signals (2026-10-24).
--
-- While a renewal payment is failing (Stripe status past_due / unpaid), the
-- dashboard shows the owner a banner and the MCP server adds a short billing
-- notice to the first successful tool result of each UTC day. Service is never
-- blocked or degraded: these columns are billing STATE, not entitlement, and
-- nothing reads them to decide what a workspace may do.
--
-- All four are written only by the service role (the Stripe webhook and
-- mcp-server). public.workspaces already holds no table-level INSERT/UPDATE for
-- anon/authenticated (20261016160100_workspaces_server_owned_writes.sql), so the
-- new columns are server-owned without extra grants. user_billing has only a
-- SELECT-own policy under RLS, so the owner can read last_decline_code (the
-- banner needs it) and cannot write it.
--
-- Idempotent.

-- The issuer's decline code on the most recent failed renewal, or null.
-- 'authentication_required' means the bank wants the customer to confirm (SCA).
ALTER TABLE public.user_billing
  ADD COLUMN IF NOT EXISTS last_decline_code text;

COMMENT ON COLUMN public.user_billing.last_decline_code IS
  'Decline code of the last failed renewal invoice (webhook). Cleared when a payment succeeds or the subscription returns to active/trialing or ends.';

-- Projected onto every workspace the owner owns, the same way `plan` is.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS payment_issue_since timestamptz,
  ADD COLUMN IF NOT EXISTS payment_issue_kind text,
  ADD COLUMN IF NOT EXISTS payment_notice_shown_on date;

ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_payment_issue_kind_check;
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_payment_issue_kind_check
  CHECK (payment_issue_kind IS NULL OR payment_issue_kind IN ('declined', 'confirm'));

COMMENT ON COLUMN public.workspaces.payment_issue_since IS
  'When the owner''s renewal payment started failing (webhook). Null when billing is healthy.';
COMMENT ON COLUMN public.workspaces.payment_issue_kind IS
  '''confirm'' when the bank asks the customer to confirm the payment (authentication_required), else ''declined''.';
COMMENT ON COLUMN public.workspaces.payment_notice_shown_on IS
  'UTC day the MCP billing notice was last attached to a tool result. Claimed with a conditional update so it shows at most once a day.';

-- ---------------------------------------------------------------------------
-- mcp_tools_call_gate: also return the three workspace payment columns, so
-- the once-a-day MCP billing notice (supabase/functions/mcp-server/
-- payment-notice.ts) costs no extra read on the tools/call hot path. The body
-- is 20261020214737_mcp_tools_call_gate.sql verbatim except for section (c).
-- An edge function older than this ignores the extra keys; one newer than a
-- database without them sees undefined and shows no notice.
-- ---------------------------------------------------------------------------
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

-- ============================================================
-- MCPEmails - auto-revoke OAuth grants nobody is using any more
-- 20260909180000_auto_revoke_dormant_oauth_grants
-- ============================================================
--
-- WHY THIS EXISTS
-- ---------------
-- On 2026-09-09 a claude.ai connector was disconnected AND removed inside
-- Claude, and on our side both halves of the grant were still fully live. The
-- Vercel logs for the window settled why: no request ever reached
-- /api/oauth/revoke. We advertise a `revocation_endpoint` in
-- /.well-known/oauth-authorization-server, RFC 7009 makes calling it OPTIONAL
-- for the client, and this client did not.
--
-- That is not a bug we can fix in our own code, because we cannot make a client
-- call us. What we can do is stop treating "the client never told us" as
-- "access forever". This is that safety net, and nothing more: the revocation
-- endpoint remains the fast, precise path, and it was fixed in the same change
-- to revoke the WHOLE grant rather than one half of it.
--
-- WHY 90 DAYS
-- -----------
-- An access token here lives ONE HOUR. A connector that is still installed
-- therefore comes back to /api/oauth/token constantly, because it cannot make a
-- single tool call without a fresh token. A refresh chain that has not moved in
-- 90 days is not a quiet user; it is a connector that no longer exists.
--
-- Ninety and not thirty because the cost of the two mistakes is not symmetric,
-- and not one-eighty because the sliding refresh-token window is already 180
-- days and a safety net that fires at the same moment the token expires is not
-- a safety net.
--
-- WHY BEING WRONG IS SURVIVABLE
-- -----------------------------
-- If we revoke a grant somebody actually wanted, the failure is GRACEFUL, not
-- silent. The next call presents a revoked token, the MCP endpoint answers 401
-- with a WWW-Authenticate naming `resource_metadata`, and Claude renders that
-- as a Connect card. The user reconnects in one click. They do not see a broken
-- tool, they do not see an error, and they do not lose anything: inboxes,
-- scopes and workspace all survive, because a grant is a credential and not the
-- account behind it.
--
-- Measured against production the day this shipped, a 90-day threshold selected
-- 12 grants, ALL of them internal: six on the seed mailbox account, one on a
-- reviewer account and five on the founder's own workspace. No customer grant,
-- paying or free, was older than 60 days.
--
-- WHAT COUNTS AS "USE", AND WHY NO NEW COLUMN
-- -------------------------------------------
-- `oauth_refresh_tokens` has no last_used_at and does not need one. The token
-- endpoint ROTATES the chain: every refresh INSERTS a new row and revokes the
-- one it replaces, so the live row's `created_at` already IS the timestamp of
-- the last successful refresh. A last_used_at column on a row that is consumed
-- exactly once and immediately revoked would only ever restate `revoked_at`.
--
-- `api_keys.last_used_at` is the second signal and is genuinely different: the
-- MCP edge function stamps it on every authenticated tool call, and that row is
-- durable across the whole chain (rotation updates it in place). It is also
-- what the dashboard's "Last used" column already shows, so the sweep and the
-- UI cannot disagree about what dormant means.
--
-- Activity is therefore the LATEST of: the live refresh row's created_at, the
-- key's last_used_at, and the key's created_at. Taking the max of all three is
-- what makes a false positive require every signal to be stale at once. A chain
-- with more than one live row (a refresh that failed between insert and revoke)
-- is judged on its newest row, never its oldest.
--
-- WHAT IT REVOKES
-- ---------------
-- BOTH HALVES, exactly as PATCH /api/api-keys/[id]/revoke does for the
-- dashboard button and as /api/oauth/revoke now does for the endpoint. Killing
-- the refresh chain alone leaves the mcpe_ access token usable for up to an
-- hour; killing the key alone leaves the thing that mints replacements.
--
-- Row-at-a-time rather than one set-based UPDATE, deliberately: the volume is a
-- handful of rows a day, and the loop is what makes one auth_logs line per
-- revoked grant natural rather than an afterthought. That line is the answer to
-- "why did my connector stop working", which is the whole reason a silent
-- expiry would be unacceptable.
--
-- Related: supabase/migrations/20260902130100_schedule_billing_lifecycle.sql
-- (the pg_cron pattern), apps/web/src/lib/oauth/revocation.ts (the same
-- two-halves rule in TypeScript).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;


-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_dormant_oauth_grants(
  p_idle_days integer DEFAULT 90,
  p_dry_run   boolean DEFAULT false
)
RETURNS TABLE (
  grants_selected        integer,
  access_tokens_revoked  integer,
  refresh_tokens_revoked integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now    timestamptz := now();
  v_cutoff timestamptz;
  v_rec    record;
  v_keys   integer := 0;
  v_chain  integer := 0;
  v_hit    integer;
BEGIN
  -- A caller-supplied threshold this short would revoke live connections, and
  -- there is no legitimate reason to ask for it. Refusing loudly beats
  -- discovering it in the audit log afterwards.
  IF p_idle_days IS NULL OR p_idle_days < 30 THEN
    RAISE EXCEPTION 'revoke_dormant_oauth_grants: refusing an idle threshold of % days (minimum 30)', p_idle_days;
  END IF;

  v_cutoff := v_now - make_interval(days => p_idle_days);

  grants_selected        := 0;
  access_tokens_revoked  := 0;
  refresh_tokens_revoked := 0;

  -- ── Grants that hang off an api_keys row (everything issued since June) ──
  --
  -- Grouped by the key, so one grant is one iteration however many live rows
  -- its chain has, and judged on max(activity) across the whole group.
  FOR v_rec IN
    SELECT
      rt.api_key_id,
      max(GREATEST(
        rt.created_at,
        COALESCE(k.last_used_at, k.created_at, rt.created_at)
      ))                            AS last_activity_at,
      min(rt.workspace_id::text)    AS workspace_id,
      min(rt.user_id::text)         AS user_id,
      min(rt.client_id)             AS client_id,
      min(rt.client_name)           AS client_name,
      min(k.key_prefix)             AS key_prefix,
      count(*)::integer             AS live_chain_rows
    FROM public.oauth_refresh_tokens rt
    JOIN public.api_keys k ON k.id = rt.api_key_id
    WHERE rt.revoked_at IS NULL
    GROUP BY rt.api_key_id
    HAVING max(GREATEST(
             rt.created_at,
             COALESCE(k.last_used_at, k.created_at, rt.created_at)
           )) < v_cutoff
  LOOP
    grants_selected := grants_selected + 1;
    CONTINUE WHEN p_dry_run;

    -- Half one: the access token. Soft delete, never a hard delete: activity_log
    -- rows reference api_key_id and would lose their foreign key.
    UPDATE public.api_keys
       SET deleted_at = v_now
     WHERE id = v_rec.api_key_id
       AND deleted_at IS NULL;
    GET DIAGNOSTICS v_hit = ROW_COUNT;
    v_keys := v_keys + v_hit;

    -- Half two: every live row of the chain, not just the newest.
    UPDATE public.oauth_refresh_tokens
       SET revoked_at = v_now
     WHERE api_key_id = v_rec.api_key_id
       AND revoked_at IS NULL;
    GET DIAGNOSTICS v_hit = ROW_COUNT;
    v_chain := v_chain + v_hit;

    -- The line that answers "why did my connector stop working". Everything
    -- needed to reconstruct the decision is here: what we judged, against what
    -- threshold, and what it cost.
    INSERT INTO public.auth_logs (event_type, workspace_id, user_id, metadata)
    VALUES (
      'oauth_grant_auto_revoked',
      v_rec.workspace_id::uuid,
      v_rec.user_id::uuid,
      jsonb_build_object(
        'reason',                 'dormant_refresh_token',
        'api_key_id',             v_rec.api_key_id,
        'key_prefix',             v_rec.key_prefix,
        'client_id',              v_rec.client_id,
        'client_name',            v_rec.client_name,
        'last_activity_at',       v_rec.last_activity_at,
        'idle_days',              floor(extract(epoch FROM (v_now - v_rec.last_activity_at)) / 86400)::integer,
        'idle_threshold_days',    p_idle_days,
        'live_chain_rows',        v_rec.live_chain_rows,
        'revoked_by',             'revoke_dormant_oauth_grants'
      )
    );
  END LOOP;

  -- ── Legacy chains with no api_key_id ────────────────────────────────────
  --
  -- Issued before a connection was linked to a single api_keys row. There is no
  -- key to revoke, so the chain IS the whole grant, and its own created_at is
  -- the only activity signal that exists for it.
  FOR v_rec IN
    SELECT rt.id, rt.created_at AS last_activity_at, rt.workspace_id, rt.user_id,
           rt.client_id, rt.client_name
    FROM public.oauth_refresh_tokens rt
    WHERE rt.revoked_at IS NULL
      AND rt.api_key_id IS NULL
      AND rt.created_at < v_cutoff
  LOOP
    grants_selected := grants_selected + 1;
    CONTINUE WHEN p_dry_run;

    UPDATE public.oauth_refresh_tokens
       SET revoked_at = v_now
     WHERE id = v_rec.id
       AND revoked_at IS NULL;
    GET DIAGNOSTICS v_hit = ROW_COUNT;
    v_chain := v_chain + v_hit;

    INSERT INTO public.auth_logs (event_type, workspace_id, user_id, metadata)
    VALUES (
      'oauth_grant_auto_revoked',
      v_rec.workspace_id,
      v_rec.user_id,
      jsonb_build_object(
        'reason',              'dormant_refresh_token',
        'api_key_id',          NULL,
        'refresh_token_id',    v_rec.id,
        'client_id',           v_rec.client_id,
        'client_name',         v_rec.client_name,
        'last_activity_at',    v_rec.last_activity_at,
        'idle_days',           floor(extract(epoch FROM (v_now - v_rec.last_activity_at)) / 86400)::integer,
        'idle_threshold_days', p_idle_days,
        'revoked_by',          'revoke_dormant_oauth_grants'
      )
    );
  END LOOP;

  access_tokens_revoked  := v_keys;
  refresh_tokens_revoked := v_chain;

  IF grants_selected > 0 THEN
    RAISE LOG 'revoke_dormant_oauth_grants: % grants over % days (dry_run=%), % keys and % refresh rows revoked',
      grants_selected, p_idle_days, p_dry_run, v_keys, v_chain;
  END IF;

  RETURN NEXT;
END;
$fn$;

COMMENT ON FUNCTION public.revoke_dormant_oauth_grants(integer, boolean) IS
  'Safety net for OAuth grants a client never revoked. Revokes BOTH halves '
  '(api_keys.deleted_at and every live oauth_refresh_tokens.revoked_at bound to '
  'it) for any grant whose newest activity signal is older than p_idle_days, '
  'default 90. Activity = max(live refresh row created_at, api_keys.last_used_at, '
  'api_keys.created_at). Writes one auth_logs ''oauth_grant_auto_revoked'' row '
  'per grant. Pass p_dry_run => true to count without revoking.';

-- SECURITY DEFINER plus Supabase default grants would let an anon or logged-in
-- browser session revoke other people's connections through /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.revoke_dormant_oauth_grants(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.revoke_dormant_oauth_grants(integer, boolean) TO service_role;


-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
--
-- Daily is the right cadence for a 90-day threshold: a day of slack on three
-- months is noise, and running it more often would only mean 288 queries a day
-- to discover nothing has aged.
--
-- 03:45 UTC, in the quiet band the other daily jobs already use, and in a slot
-- none of them hold: 02:00 activity-log retention, 03:00 triage-seen retention,
-- 03:15 invite expiry, 04:00 billing-email retention.
--
-- Unschedule-then-schedule for the same reason as 20260902130100: cron.schedule
-- is only idempotent for an unchanged definition, so re-running this migration
-- after an edit stays deterministic.

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'revoke-dormant-oauth-grants') THEN
    PERFORM cron.unschedule('revoke-dormant-oauth-grants');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'revoke-dormant-oauth-grants',
  '45 3 * * *',
  $$SELECT public.revoke_dormant_oauth_grants(90)$$
);

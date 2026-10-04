-- ===========================================================================
-- Assistant allowance: a per-workspace monthly budget of assistant RUNS, with
-- tokens and cost recorded per run.
-- 20261004100300_assistant_allowance
--
-- Design: docs/VISION-web-client.md ("Pricing"). Read and written only by the
-- `client-api` edge function (supabase/functions/client-api/store.ts).
--
-- WHY A SECOND METER. The action cap (workspace_action_allowance, 20260912200000)
-- meters MCP tool calls, which cost us nothing per call. An assistant run in
-- the web client costs inference, paid by MCP Emails. So it has its own
-- counter, and unlike the action cap it applies to EVERY workspace: early
-- members, comped owners and support exemptions are exempt from the action
-- cap, not from this. Manual mail operations in the web client and the tool
-- calls an assistant run makes are charged to neither meter.
--
-- THE UNIT IS A RUN. One user message to the assistant = one run, however many
-- model rounds and tool calls it takes. Tokens and cost are recorded on the
-- run's row so the cap can be re-based on them later without a new schema.
--
-- CAPS ARE PLACEHOLDERS the owner will tune: free 20, personal 200, solo
-- (sold as Pro) 1000, pro (sold as Team) 3000 runs per period, and a hard
-- ceiling of 120,000 tokens for any single run. They live in exactly one
-- place, the constants at the top of workspace_assistant_allowance().
--
-- SHAPE. Mirrors the action meter on purpose, so there is one mental model:
--
--   action_usage                    -> assistant_usage
--   action_usage_reservations       -> assistant_usage_reservations
--   workspace_action_allowance()    -> workspace_assistant_allowance()
--   reserve_action_usage()          -> reserve_assistant_run()
--   finalize_action_usage_reservation() -> finalize_assistant_run()
--
-- WHAT THIS MIGRATION DOES, IN ORDER
-- ----------------------------------
--   1. assistant_usage: one row per finished run. No mail content, no prompt,
--      no reply: ids, a model name and four numbers.
--   2. assistant_usage_reservations: one row per run in flight.
--   3. RLS: members may SELECT their workspace's usage; nothing else is
--      reachable from a browser session. Writes are service-role only.
--   4. workspace_assistant_allowance(uuid): the one source of truth.
--   5. reserve_assistant_run(uuid, uuid) / finalize_assistant_run(...).
--   6. Grants: all three functions service-role only.
--
-- Forward-only, one transaction, re-runnable: CREATE TABLE / INDEX IF NOT
-- EXISTS, policies dropped-if-present and re-created, CREATE OR REPLACE
-- functions, idempotent REVOKE/GRANT.
-- NOT APPLIED BY THE AGENT THAT WROTE IT.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. assistant_usage
--
-- user_id is SET NULL on user deletion: the workspace's spend stays counted
-- after the person who ran it has gone. cost is in micro-USD (1e-6 USD) as a
-- bigint, so a sum over a month is exact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assistant_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  model           text NOT NULL,
  input_tokens    integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_micro_usd  bigint  NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_usage_workspace_occurred_idx
  ON public.assistant_usage (workspace_id, occurred_at DESC);

COMMENT ON TABLE public.assistant_usage IS
  'Ledger of finished web-client assistant runs: one row per run with its model, token counts and cost in micro-USD. Counted per workspace per period by workspace_assistant_allowance(). No prompt, reply, mail content, recipients or inbox ids. Written only by finalize_assistant_run() as the service role.';


-- ---------------------------------------------------------------------------
-- 2. assistant_usage_reservations
--
-- A run reserves its slot before the first model call and settles it at the
-- end. A reservation that is never settled (the isolate died) expires after
-- 15 minutes; a run's wall-time limit is 120 seconds.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assistant_usage_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_usage_reservations_workspace_expiry_idx
  ON public.assistant_usage_reservations (workspace_id, expires_at);

COMMENT ON TABLE public.assistant_usage_reservations IS
  'Assistant runs in flight. Each occupies one slot of the workspace''s allowance until finalize_assistant_run() settles it or it expires (15 minutes). Service-role only; no policies on purpose.';


-- ---------------------------------------------------------------------------
-- 3. RLS
--
-- assistant_usage: members read their own workspace's rows (a future usage
-- page). No INSERT/UPDATE/DELETE policy: with RLS on, that is a refusal for
-- every role but the service role.
-- assistant_usage_reservations: RLS on, no policies at all.
-- ---------------------------------------------------------------------------
ALTER TABLE public.assistant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_usage_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "assistant_usage_select_members" ON public.assistant_usage;
CREATE POLICY "assistant_usage_select_members"
  ON public.assistant_usage FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- Belt and braces beside RLS: a browser session has no business writing
-- either table, and anon has no business reading them.
REVOKE ALL ON public.assistant_usage FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assistant_usage FROM authenticated;
REVOKE ALL ON public.assistant_usage_reservations FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. workspace_assistant_allowance(p_workspace_id uuid)
--
-- Returns one row, or no row for an unknown workspace id. Column contract:
--
--   plan                the plan the cap was taken from (see precedence)
--   cap                 runs allowed in the period
--   period_start        start of the counting window
--   period_end          end of it; when the allowance resets
--   used                assistant_usage rows in [period_start, period_end)
--   remaining           greatest(cap - used, 0)
--   input_tokens        sum over the same rows
--   output_tokens       sum over the same rows
--   cost_micro_usd      sum over the same rows
--   max_tokens_per_run  hard ceiling for one run (input + output)
--
-- PLAN. A comped owner (user_usage_entitlements 'comped_scale') reads as
-- 'pro', exactly as effective_workspace_plan() resolves them; otherwise
-- workspaces.plan. Comped is the ONLY entitlement honoured here, and it raises
-- the cap rather than removing it: there is no exempt path.
--
-- WINDOW. Paid: Stripe's stored cycle when it is live, else the UTC calendar
-- month. Free: the UTC calendar month. Same rule as workspace_action_allowance
-- (c), minus the Free grace window, which exists to let a new account try MCP
-- tools and has no counterpart here.
--
-- `used` counts finished runs only. In-flight reservations are added by
-- reserve_assistant_run() under its lock, where they matter.
--
-- Local variables are assigned to the OUT columns once at the end; several OUT
-- names (plan, cap, period_start) are also column names on tables read here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_assistant_allowance(p_workspace_id uuid)
RETURNS TABLE (
  plan                text,
  cap                 integer,
  period_start        timestamptz,
  period_end          timestamptz,
  used                integer,
  remaining           integer,
  input_tokens        bigint,
  output_tokens       bigint,
  cost_micro_usd      bigint,
  max_tokens_per_run  integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- THE product constants. Placeholders the owner tunes; nothing else in the
  -- codebase restates them.
  c_cap_free            constant integer := 20;
  c_cap_personal        constant integer := 200;
  c_cap_solo            constant integer := 1000;
  c_cap_pro             constant integer := 3000;
  c_max_tokens_per_run  constant integer := 120000;

  v_plan          text;
  v_owner_id      uuid;
  v_now           timestamptz := now();
  v_month_start   timestamptz;
  v_month_end     timestamptz;
  v_period_start  timestamptz;
  v_period_end    timestamptz;
  v_ub_start      timestamptz;
  v_ub_end        timestamptz;
  v_cap           integer;
  v_used          integer := 0;
  v_in            bigint := 0;
  v_out           bigint := 0;
  v_cost          bigint := 0;
BEGIN
  SELECT w.plan, w.owner_id INTO v_plan, v_owner_id
  FROM public.workspaces w
  WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id
      AND e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > v_now)
  ) THEN
    v_plan := 'pro';
  END IF;

  v_month_start := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month_end   := v_month_start + interval '1 month';
  v_period_start := v_month_start;
  v_period_end   := v_month_end;

  IF v_plan IS DISTINCT FROM 'free' THEN
    SELECT ub.current_period_start, ub.current_period_end
      INTO v_ub_start, v_ub_end
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id
    LIMIT 1;
    IF v_ub_start IS NOT NULL AND v_ub_end IS NOT NULL
       AND v_ub_start <= v_now AND v_now < v_ub_end THEN
      v_period_start := v_ub_start;
      v_period_end   := v_ub_end;
    END IF;
  END IF;

  v_cap := CASE v_plan
    WHEN 'free'       THEN c_cap_free
    WHEN 'personal'   THEN c_cap_personal
    WHEN 'solo'       THEN c_cap_solo
    WHEN 'pro'        THEN c_cap_pro
    WHEN 'enterprise' THEN c_cap_pro
    ELSE c_cap_free
  END;

  SELECT count(*)::integer,
         coalesce(sum(au.input_tokens), 0)::bigint,
         coalesce(sum(au.output_tokens), 0)::bigint,
         coalesce(sum(au.cost_micro_usd), 0)::bigint
    INTO v_used, v_in, v_out, v_cost
  FROM public.assistant_usage au
  WHERE au.workspace_id = p_workspace_id
    AND au.occurred_at >= v_period_start
    AND au.occurred_at <  v_period_end;

  RETURN QUERY SELECT
    v_plan, v_cap, v_period_start, v_period_end,
    v_used, GREATEST(v_cap - v_used, 0),
    v_in, v_out, v_cost, c_max_tokens_per_run;
END;
$$;

COMMENT ON FUNCTION public.workspace_assistant_allowance(uuid) IS
  'The one source of truth for a workspace''s web-client assistant allowance: plan (comped owners read as pro), cap in runs, counting window, used, remaining, token and cost totals, and the per-run token ceiling. Applies to every workspace including those exempt from the action cap. Service-role only.';


-- ---------------------------------------------------------------------------
-- 5. reserve_assistant_run / finalize_assistant_run
--
-- reserve: serialised per workspace with an advisory lock (a different key
-- from the action meter's, so the two never wait on each other), sweeps
-- expired reservations, counts finished runs plus live reservations, and
-- either refuses or inserts a reservation. It returns the allowance columns
-- the client shows, with `used` INCLUDING the slot just taken, so the number
-- on screen goes up when a run starts.
--
-- finalize: deletes the reservation and, when the run consumed any tokens,
-- writes its usage row. A run that failed before the model was called
-- (0 input, 0 output) releases its slot and is not counted. Returns false for
-- an unknown or already-settled reservation, so a double finalize is a no-op.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_assistant_run(
  p_workspace_id uuid,
  p_user_id      uuid
)
RETURNS TABLE (
  reservation_id      uuid,
  allowed             boolean,
  plan                text,
  cap                 integer,
  period_start        timestamptz,
  period_end          timestamptz,
  used                integer,
  remaining           integer,
  max_tokens_per_run  integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowance       record;
  v_live            integer;
  v_occupied        integer;
  v_reservation_id  uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('assistant:' || p_workspace_id::text, 0));

  DELETE FROM public.assistant_usage_reservations r
  WHERE r.workspace_id = p_workspace_id AND r.expires_at <= now();

  SELECT a.plan AS a_plan, a.cap AS a_cap, a.period_start AS a_start, a.period_end AS a_end,
         a.used AS a_used, a.max_tokens_per_run AS a_max
    INTO v_allowance
  FROM public.workspace_assistant_allowance(p_workspace_id) a;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_live
  FROM public.assistant_usage_reservations r
  WHERE r.workspace_id = p_workspace_id AND r.expires_at > now();

  v_occupied := v_allowance.a_used + v_live;

  IF v_occupied >= v_allowance.a_cap THEN
    RETURN QUERY SELECT
      NULL::uuid, false, v_allowance.a_plan, v_allowance.a_cap,
      v_allowance.a_start, v_allowance.a_end,
      v_occupied, GREATEST(v_allowance.a_cap - v_occupied, 0), v_allowance.a_max;
    RETURN;
  END IF;

  INSERT INTO public.assistant_usage_reservations (workspace_id, user_id, expires_at)
  VALUES (
    p_workspace_id,
    -- A user id that no longer exists must not fail the run on the FK.
    (SELECT u.id FROM public.users u WHERE u.id = p_user_id),
    now() + interval '15 minutes'
  )
  RETURNING id INTO v_reservation_id;

  RETURN QUERY SELECT
    v_reservation_id, true, v_allowance.a_plan, v_allowance.a_cap,
    v_allowance.a_start, v_allowance.a_end,
    v_occupied + 1, GREATEST(v_allowance.a_cap - v_occupied - 1, 0), v_allowance.a_max;
END;
$$;

COMMENT ON FUNCTION public.reserve_assistant_run(uuid, uuid) IS
  'Atomically reserves one assistant run against the workspace''s allowance. Returns allowed = false with no reservation when finished runs plus live reservations have reached the cap. Service-role only.';

CREATE OR REPLACE FUNCTION public.finalize_assistant_run(
  p_reservation_id  uuid,
  p_input_tokens    integer,
  p_output_tokens   integer,
  p_cost_micro_usd  bigint,
  p_model           text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservation public.assistant_usage_reservations%ROWTYPE;
BEGIN
  DELETE FROM public.assistant_usage_reservations r
  WHERE r.id = p_reservation_id
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0) > 0 THEN
    INSERT INTO public.assistant_usage
      (workspace_id, user_id, model, input_tokens, output_tokens, cost_micro_usd)
    VALUES (
      v_reservation.workspace_id,
      v_reservation.user_id,
      coalesce(nullif(left(p_model, 200), ''), 'unknown'),
      GREATEST(coalesce(p_input_tokens, 0), 0),
      GREATEST(coalesce(p_output_tokens, 0), 0),
      GREATEST(coalesce(p_cost_micro_usd, 0), 0)
    );
  END IF;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.finalize_assistant_run(uuid, integer, integer, bigint, text) IS
  'Settles an assistant-run reservation: releases the slot and, when the run used any tokens, records its usage row. Returns false for an unknown or already-settled reservation. Service-role only.';


-- ---------------------------------------------------------------------------
-- 6. Grants
--
-- SECURITY DEFINER plus Supabase's default EXECUTE-to-PUBLIC would let a
-- browser session read any workspace's spend, or burn its allowance, by id
-- over /rest/v1/rpc. client-api reaches these holding the service role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.workspace_assistant_allowance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_assistant_allowance(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.reserve_assistant_run(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_assistant_run(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_assistant_run(uuid, integer, integer, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_assistant_run(uuid, integer, integer, bigint, text) TO service_role;

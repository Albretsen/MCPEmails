-- ============================================================
-- Referral program (2026-10-25)
--
-- WHAT. A signed-in user gets a personal code and a link (/r/<code>). A friend
-- who signs up through it and pays gets their second month free; the referrer
-- gets one month of credit when paying, or 30 days of Personal when on Free.
-- A reward is earned once the friend's first charge has cleared 14 days. All
-- selection, fraud checks and Stripe calls live in the web app
-- (apps/web/src/lib/referrals/, /api/internal/referrals/dispatch). This file
-- holds the state:
--
--   1. workspaces.referral_enabled, the internal rollout gate. Same mechanism
--      as chat_send_confirm_enabled (20261023200000): its own column, default
--      false, seeded true for our own workspaces only.
--   2. referral_codes, referrals, referral_rewards. RLS on all three. A user
--      reads only their own referral_codes row; referrals and referral_rewards
--      have no user access at all. A referrer sees their referrals only through
--      my_referral_summary(), which never returns the friend's identity.
--   3. user_usage_entitlements.referral_personal_until and
--      grant_referral_personal(), the Free referrer's Personal month.
--   4. workspace_action_allowance() and workspace_action_allowance_terms()
--      meter a Free workspace whose owner holds an active referral month as
--      Personal. effective_workspace_plan() gains a `referral_personal` column
--      so the web app can resolve Personal limits the same way.
--   5. product_funnel_events stages for the referral_* analytics events.
--   6. dispatch_referrals() and a daily pg_cron job, same shape and secret as
--      dispatch_billing_lifecycle().
--   7. Acquisition source 'referral' in the three CHECKs and handle_new_user().
--   8. mcp_tools_call_gate also returns referral_personal_until, for the
--      mcp-server per-minute ceiling.
--
-- WHY THE REFERRAL MONTH IS A COLUMN, NOT ONLY A KIND. user_usage_entitlements
-- has one row per user (user_id is the primary key), and 20260819170500 gave
-- EVERY user who existed on 2026-08-19 a 'standard' row to carry the inbox
-- grandfather. A referral month stored only as kind = 'referral_personal'
-- would either overwrite that row (losing kind, reason and source) or be
-- impossible for every early user. So the grant lives in its own column,
-- referral_personal_until, which is honored on any row except a comped one
-- (comped already gets more than Personal). A user with no row gets a new one
-- with kind = 'referral_personal', source = 'referral' and expires_at kept
-- equal to referral_personal_until. An existing 'standard' or 'comped_scale'
-- row keeps its kind, reason, source and expires_at. Write it ONLY through
-- grant_referral_personal().
--
-- RELEASE ORDER. Apply before the web code deploys. With the flag off nothing
-- writes to the new tables, and the old web code never emits 'referral'.
--
-- RE-RUNNABLE. IF NOT EXISTS, DROP IF EXISTS / ADD and CREATE OR REPLACE only,
-- so it can be applied by hand with `db query -f` and recorded with
-- `migration repair`. The one DROP FUNCTION (effective_workspace_plan, which
-- gains a column) is recreated in the same transaction.
-- ============================================================


-- ---------------------------------------------------------------------------
-- 1. workspaces.referral_enabled: OUR rollout gate for the referral program.
--
-- Internal only at launch. When false for the workspace in question: /r/ sets
-- no cookie, no Invite UI is shown, no attach happens, and the dispatcher and
-- webhook do nothing for it. DEFAULT FALSE: the pre-feature behaviour.
-- No user write grant: 20261016160100 made every workspaces column
-- server-owned, and a new column inherits that.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS referral_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.referral_enabled IS
  'Rollout gate for the referral program (invite link, attach, rewards). Internal only at launch.';

-- Seed: our own workspaces, identified by OWNER through
-- growth_is_internal_email, exactly as 20261023200000_send_review_mode_chat.sql
-- does it. Idempotent.
UPDATE public.workspaces w
SET referral_enabled = true
FROM public.users u
WHERE u.id = w.owner_id
  AND w.deleted_at IS NULL
  AND w.referral_enabled IS DISTINCT FROM true
  AND public.growth_is_internal_email(u.email);


-- ---------------------------------------------------------------------------
-- 2. The three tables.
-- ---------------------------------------------------------------------------

-- One code per user, created lazily by GET /api/referrals. The alphabet has no
-- 0 O 1 I L (CODE_ALPHABET in apps/web/src/lib/referrals/constants.ts).
CREATE TABLE IF NOT EXISTS public.referral_codes (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

COMMENT ON TABLE public.referral_codes IS
  'One referral code per user. disabled_at set = the link stops attaching new friends. Users read their own row; writes are service role only.';

-- One row per referred friend: a friend can be referred once, ever.
CREATE TABLE IF NOT EXISTS public.referrals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL REFERENCES public.referral_codes(code) ON UPDATE CASCADE ON DELETE CASCADE,
  referrer_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_user_id      uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  attached_via        text NOT NULL CHECK (attached_via IN ('cookie', 'code')),
  attached_at         timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL DEFAULT 'attached'
                        CHECK (status IN ('attached', 'charged', 'qualified', 'voided', 'held', 'capped')),
  first_invoice_id    text,
  first_charge_id     text,
  first_charge_at     timestamptz,
  qualifies_at        timestamptz,
  ip_hash             text,
  hold_reason         text,
  void_reason         text,
  qualified_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referrals_not_self CHECK (referrer_user_id <> friend_user_id)
);

-- The referrer's list (my_referral_summary, the yearly cap count) and the
-- dispatcher's "charged and due" scan.
CREATE INDEX IF NOT EXISTS referrals_referrer_attached_idx
  ON public.referrals (referrer_user_id, attached_at DESC);
CREATE INDEX IF NOT EXISTS referrals_due_idx
  ON public.referrals (qualifies_at)
  WHERE status = 'charged';
CREATE INDEX IF NOT EXISTS referrals_first_charge_idx
  ON public.referrals (first_charge_id)
  WHERE first_charge_id IS NOT NULL;

DROP TRIGGER IF EXISTS referrals_updated_at ON public.referrals;
CREATE TRIGGER referrals_updated_at
  BEFORE UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

COMMENT ON TABLE public.referrals IS
  'One row per referred friend (friend_user_id is unique). Lifecycle: attached -> charged (first paid invoice) -> qualified | voided | held | capped. Service role only; referrers read it through my_referral_summary().';

-- At most one reward and one clawback per side per referral. The unique pair
-- is also what makes a retried dispatcher run harmless.
CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id           uuid NOT NULL REFERENCES public.referrals(id) ON DELETE CASCADE,
  side                  text NOT NULL CHECK (side IN ('referrer', 'friend', 'clawback_referrer', 'clawback_friend')),
  kind                  text NOT NULL CHECK (kind IN ('stripe_credit', 'personal_month')),
  amount_cents          integer,
  -- The credit's currency: the customer's billing currency when it was issued
  -- (a clawback repeats its reward's). Only USD and EUR are priced; any other
  -- currency is held for a person and never written here.
  currency              text DEFAULT 'usd' CHECK (currency IN ('usd', 'eur')),
  stripe_customer_id    text,
  stripe_balance_txn_id text,
  entitlement_until     timestamptz,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_rewards_referral_side_key UNIQUE (referral_id, side)
);

COMMENT ON TABLE public.referral_rewards IS
  'Rewards issued (stripe_credit = negative customer balance; personal_month = grant_referral_personal) and their clawbacks. Unique per (referral_id, side). Service role only.';

-- RLS. Default Supabase grants hand every new table to anon and authenticated;
-- they are taken back here so the policies are not the only guard.
ALTER TABLE public.referral_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.referral_codes, public.referrals, public.referral_rewards FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.referral_codes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referral_codes, public.referrals, public.referral_rewards TO service_role;

DROP POLICY IF EXISTS referral_codes_select_own ON public.referral_codes;
CREATE POLICY referral_codes_select_own
  ON public.referral_codes FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
-- referrals and referral_rewards: no policy, so no user row is ever visible.


-- ---------------------------------------------------------------------------
-- my_referral_summary(): the referrer's own referrals, without the friend.
--
-- Returns no user id, email, workspace, IP hash, Stripe id or reason text.
-- 'held' is reported as 'charged': a hold is a fraud review, and telling the
-- referrer about it tells them which signal tripped. The reward columns are
-- the referrer side's reward only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_referral_summary()
RETURNS TABLE(
  id uuid,
  status text,
  attached_at timestamptz,
  qualifies_at timestamptz,
  qualified_at timestamptz,
  reward_kind text,
  reward_cents integer,
  entitlement_until timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT
    r.id,
    CASE WHEN r.status = 'held' THEN 'charged' ELSE r.status END,
    r.attached_at,
    r.qualifies_at,
    r.qualified_at,
    rw.kind,
    rw.amount_cents,
    rw.entitlement_until
  FROM public.referrals r
  LEFT JOIN public.referral_rewards rw
    ON rw.referral_id = r.id AND rw.side = 'referrer'
  WHERE r.referrer_user_id = (SELECT auth.uid())
  ORDER BY r.attached_at DESC;
$$;

REVOKE ALL ON FUNCTION public.my_referral_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_referral_summary() TO authenticated, service_role;

COMMENT ON FUNCTION public.my_referral_summary() IS
  'The caller''s referrals as referrer: status (held shown as charged), dates and the referrer-side reward. Never returns the friend''s identity.';


-- ---------------------------------------------------------------------------
-- 3. The Free referrer's Personal month.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_usage_entitlements
  ADD COLUMN IF NOT EXISTS referral_personal_until timestamptz;

COMMENT ON COLUMN public.user_usage_entitlements.referral_personal_until IS
  'Referral reward: until this instant, every Free workspace the user owns is treated as Personal (action allowance, plan limits). Ignored on a comped_scale row. Written only by grant_referral_personal().';

-- Current definitions are the inline CHECKs of 20260803020000.
ALTER TABLE public.user_usage_entitlements
  DROP CONSTRAINT IF EXISTS user_usage_entitlements_kind_check,
  DROP CONSTRAINT IF EXISTS user_usage_entitlements_source_check;
ALTER TABLE public.user_usage_entitlements
  ADD CONSTRAINT user_usage_entitlements_kind_check
    CHECK (kind IN ('standard', 'comped_scale', 'referral_personal')),
  ADD CONSTRAINT user_usage_entitlements_source_check
    CHECK (source IN ('migration', 'support', 'promotion', 'referral'));

-- Adds p_days to whatever is left of a running referral month (or starts one
-- now), and returns the new end. Returns NULL and changes nothing when the
-- user holds a comped_scale row. An existing row keeps its kind, reason,
-- source, unlimited_inboxes and (unless it is itself a referral_personal row)
-- expires_at. The dispatcher records the returned instant in
-- referral_rewards.entitlement_until.
CREATE OR REPLACE FUNCTION public.grant_referral_personal(
  p_user_id uuid,
  p_days integer DEFAULT 30,
  p_reason text DEFAULT 'Referral reward: one month of Personal'
)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN
    RAISE EXCEPTION 'grant_referral_personal: p_days must be 1..366, got %', p_days;
  END IF;

  INSERT INTO public.user_usage_entitlements AS e
    (user_id, kind, reason, source, expires_at, referral_personal_until)
  VALUES
    (p_user_id, 'referral_personal', p_reason, 'referral',
     now() + make_interval(days => p_days), now() + make_interval(days => p_days))
  ON CONFLICT (user_id) DO UPDATE
    SET referral_personal_until =
          GREATEST(COALESCE(e.referral_personal_until, now()), now()) + make_interval(days => p_days),
        expires_at = CASE
          WHEN e.kind = 'referral_personal'
            THEN GREATEST(COALESCE(e.referral_personal_until, now()), now()) + make_interval(days => p_days)
          ELSE e.expires_at
        END
    WHERE e.kind <> 'comped_scale'
  RETURNING e.referral_personal_until INTO v_until;

  RETURN v_until;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_referral_personal(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_referral_personal(uuid, integer, text) TO service_role;

COMMENT ON FUNCTION public.grant_referral_personal(uuid, integer, text) IS
  'Extends (or starts) the user''s referral Personal month by p_days and returns the new end, or NULL for a comped user. Never overwrites an existing entitlement''s kind. Service role only.';


-- ---------------------------------------------------------------------------
-- 4. Allowance: a Free workspace whose owner holds an active referral month is
--    metered as Personal.
--
-- Both bodies are copied whole and changed in ONE place each, the block marked
-- "(a2)": right after the workspace is read, v_plan becomes 'personal', so the
-- rest of the function runs the paid branch with the Personal ceiling and
-- reports plan = 'personal' (the edge function then shows no Free notices,
-- exactly as for a paying Personal workspace). Exemptions still win.
--   workspace_action_allowance()        from 20261024233000_pause_downgrade.sql
--   workspace_action_allowance_terms()  from 20261024233000_pause_downgrade.sql
-- (that migration's paused_from window is kept as it is).
-- supabase/tests/mcp_tools_call_gate.sql compares the two column by column.
-- Attributes and grants are restated from those definitions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workspace_action_allowance(p_workspace_id uuid)
 RETURNS TABLE(plan text, owner_id uuid, exempt boolean, exempt_reason text, cap integer, period_start timestamp with time zone, period_end timestamp with time zone, grace_ends_at timestamp with time zone, in_grace boolean, used integer, remaining integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- THE two product constants. apps/web/src/lib/stripe/plans.ts mirrors them
  -- as FREE_ACTION_ALLOWANCE / FREE_ACTION_GRACE_DAYS for copy only (the grace
  -- length lives in free_action_grace_ends_at()); the
  -- number a customer reads on /pricing must be the number that blocks them,
  -- and that number is this one.
  c_free_cap        constant integer  := 150;
  -- Silent abuse ceilings for paid plans. NOT a pricing lever; mirrors
  -- SHADOW_ACTION_CAPS in supabase/functions/mcp-server/index.ts and
  -- maxMonthlyToolCalls in plans.ts. Never named in customer-facing copy.
  c_cap_personal    constant integer  := 100000;
  c_cap_solo        constant integer  := 100000;
  c_cap_pro         constant integer  := 500000;
  c_cap_other       constant integer  := 5000;
  c_meter_version   constant integer  := 1;

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
  v_used            integer := 0;
  v_remaining       integer;
  v_ub_start        timestamptz;
  v_ub_end          timestamptz;
  v_paused_from     timestamptz;
BEGIN
  -- (a) The workspace. deleted_at is irrelevant: a soft-deleted workspace
  -- cannot make tool calls, and if it is restored its allowance must not have
  -- silently changed meanwhile.
  SELECT w.plan, w.owner_id, w.created_at, w.free_action_cap_exempt
    INTO v_plan, v_owner_id, v_created_at, v_early_member
  FROM public.workspaces w
  WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- (a2) Referral month (20261025090000): a Free workspace whose owner holds
  -- an active referral_personal_until is metered as Personal. A comped row is
  -- skipped here; it is exempt below anyway.
  IF v_plan = 'free' AND EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id
      AND e.kind <> 'comped_scale'
      AND e.referral_personal_until > v_now
  ) THEN
    v_plan := 'personal';
  END IF;

  -- The UTC calendar month containing now(), as timestamptz at 00:00 UTC on
  -- the 1st. now() AT TIME ZONE 'UTC' is a plain timestamp in UTC wall-clock;
  -- date_trunc gives the 1st at midnight; the second AT TIME ZONE 'UTC' reads
  -- that wall-clock back as a UTC instant. This is the same month the edge
  -- function's calendarMonthUsageWindow() computes with Date.UTC.
  v_month_start := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month_end   := v_month_start + interval '1 month';

  -- (b) Exemptions, in precedence order.
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
    -- Nothing to run out of. The month is reported so a dashboard can still
    -- say "42 actions this month" next to the exempt badge.
    v_cap := NULL;
    v_period_start := v_month_start;
    v_period_end := v_month_end;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSIF v_plan IS DISTINCT FROM 'free' THEN
    -- (c) Paid: Stripe's stored cycle when it is live, else the calendar
    -- month. Same rule as growth_inventory_rpcs and the edge function's
    -- resolveUsageBillingWindow.
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
    -- (d) Free, created after launch. The first 3 days (7 for workspaces
    -- created before 2026-10-17 16:00 UTC) are not counted, so
    -- the counting window opens at the LATER of the month start and the end
    -- of grace, and never after the month ends. A workspace created on the
    -- 28th is in grace until the 5th of next month: this month's window is
    -- empty (period_start = period_end, used = 0), next month's starts on
    -- the 5th.
    --
    -- A paused subscriber (20261024233000) is on Free from paused_from, and
    -- the window opens no earlier than that, so the paid month before the
    -- pause is not counted against the Free allowance. Only a pause that has
    -- started counts; GREATEST ignores the NULL of everyone else.
    SELECT ub.paused_from INTO v_paused_from
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id AND ub.paused_from <= v_now
    LIMIT 1;
    v_grace_ends_at := public.free_action_grace_ends_at(v_created_at);
    v_in_grace := v_now < v_grace_ends_at;
    v_period_end := v_month_end;
    v_period_start := LEAST(GREATEST(v_month_start, v_grace_ends_at, v_paused_from), v_month_end);
    v_cap := c_free_cap;
  END IF;

  -- (e) The meter. An empty window (Free, still in grace past month end)
  -- counts nothing; the half-open range would return 0 anyway, this just
  -- makes the intent visible.
  IF v_period_start < v_period_end THEN
    SELECT count(*)::integer INTO v_used
    FROM public.action_usage au
    WHERE au.workspace_id = p_workspace_id
      AND au.billable
      AND au.meter_version = c_meter_version
      AND au.occurred_at >= v_period_start
      AND au.occurred_at <  v_period_end;
  ELSE
    v_used := 0;
  END IF;

  v_remaining := CASE WHEN v_cap IS NULL THEN NULL
                      ELSE GREATEST(v_cap - v_used, 0) END;

  RETURN QUERY SELECT
    v_plan, v_owner_id, v_exempt, v_exempt_reason, v_cap,
    v_period_start, v_period_end, v_grace_ends_at, v_in_grace,
    v_used, v_remaining;
END;
$function$;

REVOKE ALL ON FUNCTION public.workspace_action_allowance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_action_allowance(uuid) TO service_role;

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
  v_paused_from     timestamptz;
BEGIN
  SELECT w.plan, w.owner_id, w.created_at, w.free_action_cap_exempt
    INTO v_plan, v_owner_id, v_created_at, v_early_member
  FROM public.workspaces w
  WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- (a2) Referral month (20261025090000): a Free workspace whose owner holds
  -- an active referral_personal_until is metered as Personal. A comped row is
  -- skipped here; it is exempt below anyway.
  IF v_plan = 'free' AND EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id
      AND e.kind <> 'comped_scale'
      AND e.referral_personal_until > v_now
  ) THEN
    v_plan := 'personal';
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
    SELECT ub.paused_from INTO v_paused_from
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id AND ub.paused_from <= v_now
    LIMIT 1;
    v_grace_ends_at := public.free_action_grace_ends_at(v_created_at);
    v_in_grace := v_now < v_grace_ends_at;
    v_period_end := v_month_end;
    v_period_start := LEAST(GREATEST(v_month_start, v_grace_ends_at, v_paused_from), v_month_end);
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

-- ---------------------------------------------------------------------------
-- effective_workspace_plan gains a fifth column, `referral_personal`.
--
-- Current definition is 20261019150000_pro_inbox_cap_and_business.sql. Body,
-- volatility, security and the RLS gate (my_workspace_ids()) are unchanged;
-- one column is added. `plan` is deliberately NOT rewritten to 'personal': the
-- Stripe-facing callers (checkout, billing UI) must keep seeing the stored
-- plan. The web app resolves Personal limits when plan = 'free' and
-- referral_personal is true. CREATE OR REPLACE cannot widen a RETURNS TABLE,
-- hence the DROP inside this transaction, as in 20261019150000.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.effective_workspace_plan(uuid);

CREATE FUNCTION public.effective_workspace_plan(p_workspace_id uuid)
RETURNS TABLE(plan text, comped_scale boolean, unlimited_inboxes boolean, pro_unlimited_inboxes boolean, referral_personal boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    CASE WHEN e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > now()) THEN 'pro'
      ELSE w.plan
    END AS plan,
    (e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now())) AS comped_scale,
    -- The inbox grandfather is deliberately NOT expiry-gated the way the comped
    -- grant is. It was promised permanently, and every backfilled row has a
    -- NULL expires_at; gating it would let a support-set expiry on some future
    -- unrelated grant quietly revoke the promise.
    COALESCE(e.unlimited_inboxes, false) AS unlimited_inboxes,
    (
      w.pro_unlimited_inboxes_exempt
      OR NOT COALESCE(
        (SELECT s.enabled FROM public.pricing_switches s WHERE s.key = 'pro_inbox_cap'),
        false
      )
    ) AS pro_unlimited_inboxes,
    -- Referral month: same predicate as (a2) in workspace_action_allowance().
    COALESCE(
      w.plan = 'free'
      AND e.kind IS DISTINCT FROM 'comped_scale'
      AND e.referral_personal_until > now(),
      false
    ) AS referral_personal
  FROM public.workspaces w
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE w.id = p_workspace_id
    AND w.id = ANY(public.my_workspace_ids());
$$;

REVOKE ALL ON FUNCTION public.effective_workspace_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_workspace_plan(uuid) TO authenticated;


-- ---------------------------------------------------------------------------
-- 5. product_funnel_events stages for the referral analytics events.
--
-- ADDITIVE, like 20261024225000_dunning_measurement and
-- 20261024233000_pause_downgrade: the helper (copied from the latter) reads
-- the live CHECK, keeps every stage already in it and appends the ten
-- referral stages, so no stage another migration added is lost whatever the
-- order. Each event is one row with the stage named after it; outcome
-- 'success', or 'failure' for referral_attach_refused and referral_voided.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.mcpe_extend_in_check(
  p_table regclass,
  p_constraint text,
  p_column text,
  p_values text[]
) RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  def      text;
  existing text[];
  merged   text[];
  nullable boolean;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conname = p_constraint AND c.conrelid = p_table;

  -- No constraint at all: nothing restricts the column, nothing to add.
  IF def IS NULL THEN
    RETURN;
  END IF;

  -- Postgres prints the list as ARRAY['a'::text, ...] (or ANY of it); an
  -- array literal '{a,b}'::text[] is read too.
  SELECT array_agg(DISTINCT s ORDER BY s) INTO existing
  FROM (
    SELECT m[1] AS s FROM regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') AS m
    UNION
    SELECT trim(both '"' from x) FROM regexp_matches(def, '''\{([^}]*)\}''', 'g') AS a,
      unnest(string_to_array(a[1], ',')) AS x
  ) found
  WHERE s ~ '^[a-z0-9_]+$';

  IF existing IS NULL OR array_length(existing, 1) IS NULL THEN
    RAISE EXCEPTION '% has no readable value list: %', p_constraint, def;
  END IF;

  IF p_values <@ existing THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT v ORDER BY v) INTO merged
  FROM unnest(existing || p_values) AS v;

  -- Keep "column IS NULL OR ..." when the original allowed NULL.
  nullable := def ILIKE '%' || p_column || ' IS NULL%';

  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', p_table, p_constraint);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s%I IN (%s))',
    p_table,
    p_constraint,
    CASE WHEN nullable THEN format('%I IS NULL OR ', p_column) ELSE '' END,
    p_column,
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(merged) AS v)
  );
END
$fn$;

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_stage_check', 'stage',
  ARRAY[
    'referral_link_viewed', 'referral_link_copied', 'referral_click',
    'referral_attached', 'referral_attach_refused', 'referral_charged',
    'referral_qualified', 'referral_voided', 'referral_held', 'referral_capped'
  ]);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);


-- ---------------------------------------------------------------------------
-- 6. The dispatcher poke, daily.
--
-- Same shape as dispatch_billing_lifecycle() (20261020153717): return before
-- touching Vault or pg_net when nothing is due, reuse the 'dispatch_secret'
-- Vault secret (DISPATCH_SECRET in Vercel), post an empty body. "Due" mirrors
-- the route's selection: status 'charged' with qualifies_at passed. Keep the
-- two in step. With the flag off the route itself does nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_referrals()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  -- Public, non-secret. The apex domain is the canonical one.
  v_url    text := 'https://mcpemails.com/api/internal/referrals/dispatch';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM public.referrals
        WHERE status = 'charged'
          AND qualifies_at <= now()
     )
  THEN
    RETURN;
  END IF;

  -- A missing or inaccessible Vault downgrades to a WARNING and a skip.
  BEGIN
    SELECT decrypted_secret
      INTO v_secret
      FROM vault.decrypted_secrets
     WHERE name = 'dispatch_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'dispatch_referrals: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget; the route selects and claims its own work.
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_referrals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_referrals() TO service_role;

COMMENT ON FUNCTION public.dispatch_referrals() IS
  'Called by pg_cron daily. Posts to the Next.js referral dispatcher when a charged referral has reached qualifies_at. Secret from Vault (name=''dispatch_secret''). Empty body: all selection lives in the route.';

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-referrals') THEN
    PERFORM cron.unschedule('dispatch-referrals');
  END IF;
END;
$guard$;

-- 10:15 UTC, clear of the 09:00 card sweep and the 04:00 retention jobs.
SELECT cron.schedule(
  'dispatch-referrals',
  '15 10 * * *',
  $$SELECT public.dispatch_referrals()$$
);


-- ---------------------------------------------------------------------------
-- 7. Acquisition source 'referral'.
--
-- A signup that started on /r/<code> is filed as 'referral'
-- (apps/web/src/lib/acquisition-context.mjs reads acq=referral on the landing
-- URL). Re-pin the three source CHECK constraints with the one new value and
-- redefine handle_new_user() with the same list. No row is changed.
--
-- WHY THE FUNCTION BELOW IS COPIED WHOLE. handle_new_user() has no ALTER, and
-- a retyped body once silently killed attribution for 168 signups. The body
-- is a verbatim copy of 20261022180000_acquisition_connector_sources.sql, the
-- newest definition as of 2026-10-25, with ONLY the v_source, v_referrer and
-- v_utm_source allowlist lines changed. apps/web/src/lib/acquisition-context.test.mjs
-- checks both. It must stay the LAST statement in this file: that test
-- compares everything from its CREATE line to the end of the file.
-- ---------------------------------------------------------------------------

-- 7a. Re-pin the source CHECKs. Every existing row holds a value from the old
--    list, a subset of the new one, so the re-adds validate.
ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_source_check,
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_referrer_check,
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_utm_source_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_source_check
    CHECK (acquisition_source IS NULL OR acquisition_source IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'gemini', 'copilot', 'connector_claude', 'connector_chatgpt', 'connector_cursor', 'connector_vscode', 'connector_other', 'referral', 'other')),
  ADD CONSTRAINT workspaces_acquisition_referrer_check
    CHECK (acquisition_referrer IS NULL OR acquisition_referrer IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'gemini', 'copilot', 'connector_claude', 'connector_chatgpt', 'connector_cursor', 'connector_vscode', 'connector_other', 'referral', 'other')),
  ADD CONSTRAINT workspaces_acquisition_utm_source_check
    CHECK (acquisition_utm_source IS NULL OR acquisition_utm_source IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'gemini', 'copilot', 'connector_claude', 'connector_chatgpt', 'connector_cursor', 'connector_vscode', 'connector_other', 'referral', 'other'));

-- 7b. The trigger keeps its own copy of the list, because a value it does not
--    recognise has to become NULL rather than fail the signup.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
  v_slug         text;
  v_base_slug    text;
  v_suffix       integer := 0;
  v_source       text := NEW.raw_user_meta_data->>'acquisition_source';
  v_landing      text := NEW.raw_user_meta_data->>'acquisition_landing';
  v_landing_path text := NEW.raw_user_meta_data->>'acquisition_landing_path';
  v_locale       text := NEW.raw_user_meta_data->>'acquisition_locale';
  v_referrer     text := NEW.raw_user_meta_data->>'acquisition_referrer';
  v_utm_source   text := NEW.raw_user_meta_data->>'acquisition_utm_source';
  v_utm_medium   text := NEW.raw_user_meta_data->>'acquisition_utm_medium';
  v_utm_campaign text := NEW.raw_user_meta_data->>'acquisition_utm_campaign';
BEGIN
  -- 1. Insert into public.users (mirrors auth.users)
  INSERT INTO public.users (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;

  -- 2. Generate a URL-safe slug from the email local part
  --    e.g. "jane.doe+work@example.com" -> "jane-doe-work"
  v_base_slug := LOWER(
    REGEXP_REPLACE(
      REGEXP_REPLACE(SPLIT_PART(NEW.email, '@', 1), '[^a-zA-Z0-9]+', '-', 'g'),
      '^-+|-+$', '', 'g'
    )
  );
  v_slug := v_base_slug;

  -- 3. Ensure slug uniqueness with a numeric suffix if needed
  WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug   := v_base_slug || '-' || v_suffix;
  END LOOP;

  -- 4. Coarse first-touch attribution. Anything outside the allowlist is
  --    discarded rather than persisted, so no raw UTM value, referrer URL or
  --    identifier can reach the table through this path.
  IF v_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'gemini', 'copilot', 'connector_claude', 'connector_chatgpt', 'connector_cursor', 'connector_vscode', 'connector_other', 'referral', 'other') THEN v_source := NULL; END IF;
  IF v_landing NOT IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other') THEN v_landing := NULL; END IF;
  IF v_landing_path !~ '^/(|other|blog(/[a-z0-9-]+)?|connect(/[a-z0-9-]+)?|docs(/[a-z0-9-]+)*|for/[a-z0-9-]+|pricing|security|self-hosting|native-connectors-vs-mcp|about|changelog|best-email-mcp-servers|email-mcp-servers-compared)$' THEN v_landing_path := NULL; END IF;
  IF v_locale NOT IN ('en', 'nb', 'es', 'fr', 'zh', 'de') THEN v_locale := NULL; END IF;
  IF v_referrer NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'gemini', 'copilot', 'connector_claude', 'connector_chatgpt', 'connector_cursor', 'connector_vscode', 'connector_other', 'referral', 'other') THEN v_referrer := NULL; END IF;
  IF v_utm_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'gemini', 'copilot', 'connector_claude', 'connector_chatgpt', 'connector_cursor', 'connector_vscode', 'connector_other', 'referral', 'other') THEN v_utm_source := NULL; END IF;
  IF v_utm_medium NOT IN ('organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'directory', 'other') THEN v_utm_medium := NULL; END IF;
  IF v_utm_campaign NOT IN ('launch', 'newsletter', 'content', 'product', 'partner', 'community', 'listing', 'other') THEN v_utm_campaign := NULL; END IF;

  -- 5. Create default workspace owned by this user
  INSERT INTO public.workspaces (
    owner_id, slug, display_name, plan,
    acquisition_source, acquisition_landing, acquisition_landing_path,
    acquisition_locale, acquisition_referrer,
    acquisition_utm_source, acquisition_utm_medium, acquisition_utm_campaign
  )
  VALUES (
    NEW.id,
    v_slug,
    COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)),
    'free',
    v_source, v_landing, v_landing_path,
    v_locale, v_referrer,
    v_utm_source, v_utm_medium, v_utm_campaign
  )
  RETURNING id INTO v_workspace_id;

  -- 6. Add the user as the owner member of the new workspace
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner');

  -- 7. Emit a system event for the internal notification pipeline.
  PERFORM public.emit_system_event('user.signup', jsonb_build_object(
    'user_id', NEW.id,
    'email', NEW.email,
    'workspace_id', v_workspace_id
  ));

  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 8. mcp_tools_call_gate returns referral_personal_until.
--
-- mcp-server's per-minute ceiling (checkPlanQuota, referral-burst.ts) lifts a
-- Free workspace in a referral month to Personal's burst. The month lives in
-- referral_personal_until, which an older 'standard' row carries without
-- changing its kind, so the gate must hand that column back with the kind
-- and expires_at. Current definition is 20261024190000_payment_issue_columns,
-- reproduced whole with ONE change: section (d) adds
-- 'referral_personal_until'. The per-query path in index.ts selects the same
-- three columns.
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

-- ============================================================================
-- Personal 3-month pass (non-renewing): storage, helper, expiry schedule,
-- funnel vocabulary.
--
-- One payment buys Personal for exactly three calendar months. Nothing renews.
-- The web app (service role) writes these rows from the Stripe webhook and
-- reads them when it projects a plan onto `workspaces.plan`. mcp-server keeps
-- reading `workspaces.plan` only, so it does not query this table and
-- self-host/db/00-schema.sql does not change.
--
--   1. public.user_passes            one row per paid pass
--   2. public.user_active_pass()     the end of the user's current pass cover
--   3. public.dispatch_pass_expiry() pg_cron poke for /api/internal/pass-expiry
--   4. product_funnel_events         pass values appended to the stage and
--                                    category CHECKs
--
-- Statuses:
--   active     the pass that covers now (starts_at <= now < ends_at)
--   scheduled  a stacked pass that starts when the active one ends (max one)
--   expired    ran to its end date
--   refunded   fully refunded; entitlement ended at the refund
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. user_passes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_passes (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product                     text        NOT NULL DEFAULT 'personal_pass_3m'
                                          CHECK (product IN ('personal_pass_3m')),
  plan                        text        NOT NULL DEFAULT 'personal'
                                          CHECK (plan IN ('personal')),
  stripe_checkout_session_id  text        NOT NULL UNIQUE,
  stripe_payment_intent_id    text        UNIQUE,
  amount_minor                integer     CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency                    text,
  starts_at                   timestamptz NOT NULL,
  ends_at                     timestamptz NOT NULL,
  status                      text        NOT NULL
                                          CHECK (status IN ('active', 'scheduled', 'expired', 'refunded')),
  reminder_queued_at          timestamptz,
  expired_at                  timestamptz,
  refunded_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_passes_window CHECK (ends_at > starts_at)
);

COMMENT ON TABLE public.user_passes IS
  'Non-renewing Personal passes (one payment, fixed end date). Written by the '
  'Stripe webhook and the pass-expiry sweep through the service role only. '
  'The owner can read their own rows.';

CREATE INDEX IF NOT EXISTS user_passes_user_status_idx
  ON public.user_passes (user_id, status);

-- The expiry sweep: live rows whose window has closed or opened.
CREATE INDEX IF NOT EXISTS user_passes_live_ends_idx
  ON public.user_passes (ends_at)
  WHERE status IN ('active', 'scheduled');

ALTER TABLE public.user_passes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_passes_owner_select ON public.user_passes;
CREATE POLICY user_passes_owner_select ON public.user_passes
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Reads only for a signed-in owner; every write goes through the service role.
REVOKE ALL ON public.user_passes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_passes TO authenticated;
GRANT ALL ON public.user_passes TO service_role;


-- ---------------------------------------------------------------------------
-- 2. user_active_pass(p_user)
--
-- One row with the end of the user's pass cover when a pass covers now, and no
-- row otherwise. A stacked (scheduled) pass starts exactly when the active one
-- ends, so the cover runs to the LATEST end among the live rows. Time decides,
-- not the status alone: an active row whose end has passed covers nothing even
-- before the sweep has marked it expired.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_active_pass(p_user uuid)
RETURNS TABLE (ends_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT max(p.ends_at) AS ends_at
    FROM public.user_passes p
   WHERE p.user_id = p_user
     AND p.status IN ('active', 'scheduled')
     AND p.ends_at > now()
  HAVING bool_or(p.starts_at <= now());
$$;

COMMENT ON FUNCTION public.user_active_pass(uuid) IS
  'End of the user''s current Personal pass cover (stacked pass included), or '
  'no row when no pass covers now. Service role only.';

REVOKE ALL ON FUNCTION public.user_active_pass(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_active_pass(uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- 3. dispatch_pass_expiry()
--
-- Mirrors dispatch_billing_lifecycle() (20261020153717): same Vault secret,
-- same fire-and-forget pg_net post, empty body, and an early return when there
-- is nothing to do, so the route is only called when a pass has ended or a
-- stacked pass has started. Independent of BILLING_LIFECYCLE_EMAILS on
-- purpose: a pass must end on its date whatever the email flag says.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_pass_expiry()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_url    text := 'https://mcpemails.com/api/internal/pass-expiry';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM public.user_passes
        WHERE (status = 'active' AND ends_at <= now())
           OR (status = 'scheduled' AND starts_at <= now())
     )
  THEN
    RETURN;
  END IF;

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
    RAISE WARNING 'dispatch_pass_expiry: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

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

COMMENT ON FUNCTION public.dispatch_pass_expiry() IS
  'Called by pg_cron every 15 minutes. Posts to /api/internal/pass-expiry only '
  'when a pass has ended or a stacked pass has started. Secret from Vault '
  '(name=''dispatch_secret''), shared with the other dispatchers.';

REVOKE ALL ON FUNCTION public.dispatch_pass_expiry() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_pass_expiry() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-pass-expiry') THEN
    PERFORM cron.unschedule('dispatch-pass-expiry');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-pass-expiry',
  '*/15 * * * *',
  $$SELECT public.dispatch_pass_expiry()$$
);


-- ---------------------------------------------------------------------------
-- 4. product_funnel_events stage and category vocabulary
--
-- Append-only. Other sessions add values to these CHECKs from migrations that
-- may land before or after this one, so no list is written out here: for each
-- constraint the block reads the values the live definition allows, adds the
-- pass values that are missing, and re-adds the constraint with the union.
-- Running it twice changes nothing. A missing constraint is left missing (a
-- pass-only list would refuse every other value).
--
-- A pass never writes `checkout_completed`, so the subscription conversion
-- read-outs keep their meaning. Categories: the pass product, the surfaces its
-- offer is shown on, and 'pass' for a renewal that bought another pass.
-- ---------------------------------------------------------------------------
DO $funnel$
DECLARE
  target   record;
  v_def    text;
  v_values text[];
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('product_funnel_events_stage_check', 'stage', ARRAY[
        'pass_offer_shown', 'pass_checkout_started', 'pass_checkout_completed',
        'pass_reminder_sent', 'pass_expired', 'pass_refunded', 'pass_renewed'
      ]),
      ('product_funnel_events_category_check', 'category', ARRAY[
        'personal_pass_3m',
        'checkout_return', 'cap_banner', 'paywall_email_3', 'pass_reminder',
        'pass'
      ])
    ) AS t(conname, col, additions)
  LOOP
    SELECT pg_get_constraintdef(c.oid)
      INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.product_funnel_events'::regclass
       AND c.conname = target.conname
       AND c.contype = 'c';

    IF v_def IS NULL THEN
      RAISE NOTICE '% does not exist, pass values not added.', target.conname;
      CONTINUE;
    END IF;

    -- Only a plain list is rewritten. Anything else (an OR, a NULL arm) would
    -- lose its meaning here, so the migration stops instead.
    IF v_def !~ ('^CHECK \(\(' || target.col || ' = ANY \(') THEN
      RAISE EXCEPTION '% is not a plain list, not rewritten: %', target.conname, v_def;
    END IF;

    -- Every quoted literal in the definition, in order. pg_get_constraintdef
    -- prints either ARRAY['a'::text, ...] or '{a,...}'::text[]; the second
    -- form is one literal that holds the whole list, so it is cast and unnested.
    SELECT array_agg(u.v ORDER BY t.n, u.k)
      INTO v_values
      FROM regexp_matches(v_def, '''((?:[^'']|'''')*)''(::text\[\])?', 'g') WITH ORDINALITY AS t(m, n)
      CROSS JOIN LATERAL unnest(
             CASE WHEN t.m[2] IS NULL
                  THEN ARRAY[replace(t.m[1], '''''', '''')]
                  ELSE replace(t.m[1], '''''', '''')::text[]
             END
           ) WITH ORDINALITY AS u(v, k);

    IF v_values IS NULL OR cardinality(v_values) = 0 THEN
      RAISE EXCEPTION '% has no readable values: %', target.conname, v_def;
    END IF;

    -- Already complete: leave the constraint untouched.
    IF target.additions <@ v_values THEN
      CONTINUE;
    END IF;

    -- Keep the existing order, append only what is missing.
    SELECT v_values || coalesce(array_agg(a.v ORDER BY a.n), ARRAY[]::text[])
      INTO v_values
      FROM unnest(target.additions) WITH ORDINALITY AS a(v, n)
     WHERE a.v <> ALL (v_values);

    -- Written as ARRAY['a'::text, ...], the same form production prints.
    EXECUTE format('ALTER TABLE public.product_funnel_events DROP CONSTRAINT %I', target.conname);
    EXECUTE format(
      'ALTER TABLE public.product_funnel_events ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[%s]))',
      target.conname,
      target.col,
      (SELECT string_agg(quote_literal(x.v) || '::text', ', ' ORDER BY x.n)
         FROM unnest(v_values) WITH ORDINALITY AS x(v, n))
    );
  END LOOP;
END;
$funnel$;

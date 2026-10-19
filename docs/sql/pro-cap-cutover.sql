-- Pro inbox cap cutover. Run ONCE on cutover day, by hand:
--
--   npx supabase db query --linked -f docs/sql/pro-cap-cutover.sql
--
-- Preconditions: migration 20261019150000_pro_inbox_cap_and_business is
-- applied, and the web deploy that reads `pro_unlimited_inboxes` is live (the
-- runbook in the PR orders this). Until this file runs, the pro_inbox_cap
-- switch is off and every Pro workspace is unlimited, exactly as today.
--
-- What it does, in one transaction:
--   1. Marks every workspace whose plan is Pro right now as exempt. "Right now"
--      includes past_due and unpaid subscriptions and ones set to cancel at
--      period end: the webhook keeps `solo` on all of those. A workspace is
--      also marked when its owner's user_billing says solo while the
--      workspace row drifted. Soft-deleted workspaces are included, so a
--      restored one keeps its promise.
--   2. Turns the pro_inbox_cap switch on. From this commit, Pro workspaces
--      without the flag are capped at 10.
--
-- Idempotent and safe to re-run: when the switch is already on, it changes
-- nothing. That guard matters, because a second backfill after the cap is live
-- would exempt every Pro customer who bought after the cutover.

DO $$
DECLARE
  v_enabled boolean;
  v_marked  integer;
BEGIN
  SELECT enabled INTO v_enabled
    FROM public.pricing_switches
   WHERE key = 'pro_inbox_cap'
   FOR UPDATE;

  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'pricing_switches has no pro_inbox_cap row: apply migration 20261019150000 first';
  END IF;

  IF v_enabled THEN
    RAISE NOTICE 'pro_inbox_cap is already on: cutover already ran, nothing changed';
    RETURN;
  END IF;

  UPDATE public.workspaces w
     SET pro_unlimited_inboxes_exempt = true
   WHERE NOT w.pro_unlimited_inboxes_exempt
     AND (
       w.plan = 'solo'
       OR EXISTS (
         SELECT 1 FROM public.user_billing b
          WHERE b.user_id = w.owner_id
            AND b.plan = 'solo'
       )
     );
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  UPDATE public.pricing_switches
     SET enabled = true,
         updated_at = now(),
         note = 'Pro 10-inbox cap on since cutover. Backfill marked '
                || v_marked || ' workspaces exempt.'
   WHERE key = 'pro_inbox_cap';

  RAISE NOTICE 'Pro cap cutover: % workspaces marked exempt, cap switched on at %',
    v_marked, now();
END;
$$;

-- Check: the switch, and how many workspaces hold the exemption by plan.
SELECT key, enabled, updated_at, note
  FROM public.pricing_switches
 WHERE key = 'pro_inbox_cap';

SELECT plan,
       count(*) FILTER (WHERE pro_unlimited_inboxes_exempt)     AS exempt,
       count(*) FILTER (WHERE NOT pro_unlimited_inboxes_exempt) AS not_exempt
  FROM public.workspaces
 WHERE deleted_at IS NULL
 GROUP BY plan
 ORDER BY plan;

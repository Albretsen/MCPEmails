-- Automations: fan the triage dispatcher out when the backlog is deep.
--
-- APPLY ONLY AFTER mcp-server is deployed with TRIAGE_DISPATCH_FANOUT and the
-- per-inbox lease check (triageStore.inboxLeaseHeld). Older mcp-server code run
-- several times a minute would open parallel IMAP sessions against one mailbox.
--
-- Why: one /triage-dispatch invocation is bounded by a 40 s wall-clock budget
-- and gets through about ten rules (3 to 5 s each). The enabled rules ask for
-- about 1,500 runs an hour; one invocation a minute delivers about 600. On
-- 2026-10-20 that showed as ~380 due rules, the oldest ~28 minutes late.
--
-- Same shape as dispatch_inbox_watch() (20261005100200): count what is due,
-- return with no request when nothing is, otherwise fire
-- least(ceil(due / 10), 4) requests. 10 is what one invocation finishes in its
-- budget, not MAX_RULES_PER_INVOCATION (20), which is only the claim cap.
--
-- Concurrency is safe by the existing lease CAS: claimRule is
-- `UPDATE triage_rules SET running_since = now WHERE id = ? AND running_since
-- IS NULL AND <due predicates>`, so of two invocations racing for one rule
-- exactly one gets a row back. Each invocation lists a window
-- MAX_RULES_PER_INVOCATION * TRIAGE_DISPATCH_FANOUT wide so they do not all
-- fight over the same twenty rules, and checks (before and after its claim)
-- that no other rule on the same inbox holds a lease, so a mailbox still sees
-- at most one scheduled run at a time.
--
-- c_max_requests must equal TRIAGE_DISPATCH_FANOUT in
-- supabase/functions/mcp-server/triage-engine.ts.
--
-- Re-runnable: CREATE OR REPLACE only.

CREATE OR REPLACE FUNCTION public.dispatch_triage_rules()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function. The
  -- /triage-dispatch route validates the X-Dispatch-Secret header.
  v_url      text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
  v_secret   text;
  v_due      integer;
  v_stale    boolean;
  v_requests integer;
  -- Rules one invocation gets through inside TRIAGE_TIME_BUDGET_MS.
  c_per_request  constant integer := 10;
  -- Keep in step with TRIAGE_DISPATCH_FANOUT in mcp-server/triage-engine.ts.
  c_max_requests constant integer := 4;
BEGIN
  -- The predicate of triageStore.listDueRules. Keep them in step.
  SELECT count(*)::integer
    INTO v_due
    FROM public.triage_rules
   WHERE enabled
     AND deleted_at IS NULL
     AND running_since IS NULL
     AND next_run_at IS NOT NULL
     AND next_run_at <= now()
     AND (paused_until IS NULL OR paused_until <= now());

  -- A stale lease (TRIAGE_STALE_LEASE_MS, 10 minutes) is work too: the same
  -- route reclaims it.
  SELECT EXISTS (
           SELECT 1 FROM public.triage_rules
            WHERE running_since IS NOT NULL
              AND running_since < now() - INTERVAL '10 minutes'
         )
    INTO v_stale;

  IF v_due = 0 AND NOT v_stale THEN
    RETURN;
  END IF;

  -- Read the dispatch secret from Vault. Wrapped in a sub-block so that a
  -- missing secret (or an inaccessible vault) downgrades to a WARNING + skip
  -- rather than raising and tripping the pg_cron run into an error.
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
    RAISE WARNING 'dispatch_triage_rules: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  v_requests := greatest(1, least(ceil(v_due::numeric / c_per_request)::integer, c_max_requests));

  -- Fire and forget. The empty body is deliberate: this route cannot be used
  -- to steer which rules run even by a caller who somehow holds the secret.
  -- All selection, leasing and budgeting happens inside handleTriageDispatch.
  FOR n IN 1..v_requests LOOP
    PERFORM net.http_post(
      url     := v_url || '/triage-dispatch',
      headers := jsonb_build_object(
                   'Content-Type',      'application/json',
                   'X-Dispatch-Secret', v_secret
                 ),
      body    := '{}'::jsonb
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_triage_rules() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_triage_rules() TO service_role;

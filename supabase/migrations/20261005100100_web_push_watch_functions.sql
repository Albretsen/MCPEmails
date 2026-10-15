-- ===========================================================================
-- Web push: which mailboxes are watched, the dispatcher's lease, and who is
-- told about a mailbox.
-- 20261005100100_web_push_watch_functions
--
-- Tables: 20261005100000. Caller: the `client-api` edge function's
-- POST /push/dispatch (supabase/functions/client-api/push/dispatch.ts), as
-- the service role. Modelled on the triage dispatcher (20260819190000 and
-- handleTriageDispatch): cron only asks "is anything due?", and everything
-- about WHICH rows run is decided here, in the database, not by the caller.
--
-- THE FUNCTIONS
-- -------------------
--   sync_inbox_watch_state()      keeps inbox_watch_state equal to the set of
--                                 mailboxes that have somebody to notify.
--   lease_inbox_watches(n, secs)  claims up to n due mailboxes for one
--                                 dispatcher, so no mailbox is ever checked by
--                                 two dispatchers at once.
--   push_recipients(inbox)        the browsers to notify about one mailbox,
--                                 with each person's settings for it.
--   record_push_results(...)      what the push services answered, per
--                                 subscription (section 4).
--
-- WHEN IS A MAILBOX WATCHED. All of:
--   - the mailbox is live and connected (deleted_at IS NULL, status 'active').
--     A mailbox that needs reconnecting is NOT watched: nothing is dialled
--     for it, and it starts again from a fresh cursor once it is reconnected;
--   - its workspace is live and has the web client switched on
--     (workspaces.web_client_enabled);
--   - at least one person who is STILL a member of that workspace has an
--     active push subscription there and has not switched this mailbox off.
-- The moment the last such subscription goes (sign-out, unsubscribe, the push
-- service reporting it dead, the member being removed), the mailbox drops out
-- and the server stops contacting its mail host.
--
-- Forward-only, re-runnable: CREATE OR REPLACE, idempotent REVOKE / GRANT.
-- NOT APPLIED BY THE AGENT THAT WROTE IT.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. sync_inbox_watch_state()
--
-- Deletes rows for mailboxes that are no longer watched and inserts rows for
-- newly watched ones. A new row has an empty cursor, so the dispatcher's first
-- look at the mailbox only RECORDS where it stands: nobody gets a burst of
-- notifications for mail that was already there.
--
-- Safe to run concurrently (several dispatchers start in the same second):
-- the INSERT is ON CONFLICT DO NOTHING and a DELETE of an already-deleted row
-- matches nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_inbox_watch_state()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH watched AS (
    SELECT i.id
      FROM public.inboxes i
      JOIN public.workspaces w
        ON w.id = i.workspace_id
       AND w.deleted_at IS NULL
       AND w.web_client_enabled
     WHERE i.deleted_at IS NULL
       AND i.status = 'active'
       AND EXISTS (
             SELECT 1
               FROM public.push_subscriptions s
               JOIN public.workspace_members m
                 ON m.workspace_id = s.workspace_id
                AND m.user_id = s.user_id
              WHERE s.workspace_id = i.workspace_id
                AND s.disabled_at IS NULL
                AND NOT EXISTS (
                      SELECT 1
                        FROM public.push_preferences p
                       WHERE p.user_id = s.user_id
                         AND p.inbox_id = i.id
                         AND p.enabled = false
                    )
           )
  ),
  removed AS (
    DELETE FROM public.inbox_watch_state s
     WHERE NOT EXISTS (SELECT 1 FROM watched x WHERE x.id = s.inbox_id)
    RETURNING 1
  )
  INSERT INTO public.inbox_watch_state (inbox_id)
  SELECT x.id FROM watched x
  ON CONFLICT (inbox_id) DO NOTHING;
$fn$;

COMMENT ON FUNCTION public.sync_inbox_watch_state() IS
  'Makes inbox_watch_state equal to the set of watched mailboxes: live, active inboxes in a web-client-enabled workspace with at least one active push subscription of a current member who has not switched that mailbox off. New rows start with an empty cursor. Called by dispatch_inbox_watch() and lease_inbox_watches().';


-- ---------------------------------------------------------------------------
-- 2. lease_inbox_watches(p_limit, p_lease_seconds)
--
-- One statement claims the rows: FOR UPDATE SKIP LOCKED makes a concurrent
-- dispatcher take the NEXT rows instead of waiting for or double-claiming
-- these (the same construction as the billing-email claim in 20260902130000).
--
-- Due = next_check_at has passed, no backoff is running, and no live lease.
-- Oldest due first, so a backlog drains in order and nothing starves.
--
-- Returns what the dispatcher needs and nothing it does not: ids, the
-- provider, the mail host name (for a per-host concurrency cap; never
-- logged), the cursor, and the inbox row's last_error so a refused-login
-- marker (client-api mail/health.ts) is honoured without dialling.
--
-- p_limit is clamped to 1..50 and the lease to 30..600 seconds, whatever the
-- caller passes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lease_inbox_watches(
  p_limit         integer DEFAULT 20,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  inbox_id         uuid,
  workspace_id     uuid,
  provider         text,
  mail_host        text,
  lease_id         uuid,
  folders          jsonb,
  last_checked_at  timestamptz,
  failure_count    integer,
  inbox_last_error text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 600));
BEGIN
  PERFORM public.sync_inbox_watch_state();

  RETURN QUERY
  WITH due AS (
    SELECT s.inbox_id
      FROM public.inbox_watch_state s
     WHERE s.next_check_at <= now()
       AND (s.backoff_until IS NULL OR s.backoff_until <= now())
       AND (s.leased_until IS NULL OR s.leased_until <= now())
     ORDER BY s.next_check_at
     LIMIT v_limit
       FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.inbox_watch_state s
       SET lease_id = gen_random_uuid(),
           leased_until = now() + v_lease
      FROM due
     WHERE s.inbox_id = due.inbox_id
    RETURNING s.inbox_id, s.lease_id, s.folders, s.last_checked_at, s.failure_count
  )
  SELECT c.inbox_id,
         i.workspace_id,
         i.provider,
         i.imap_host,
         c.lease_id,
         c.folders,
         c.last_checked_at,
         c.failure_count,
         i.last_error
    FROM claimed c
    JOIN public.inboxes i ON i.id = c.inbox_id;
END;
$fn$;

COMMENT ON FUNCTION public.lease_inbox_watches(integer, integer) IS
  'Claims up to p_limit due rows of inbox_watch_state for one dispatcher (FOR UPDATE SKIP LOCKED; a lease_id the dispatcher must present to write its result). Runs sync_inbox_watch_state() first. Service-role only.';


-- ---------------------------------------------------------------------------
-- 3. push_recipients(p_inbox_id)
--
-- The active subscriptions to notify about one mailbox, each with its
-- owner's settings for that mailbox (defaults when there is no preference
-- row). Applies the same three conditions as the watch set, so a removed
-- member, a switched-off workspace or a switched-off mailbox yields no rows
-- even if a dispatcher is already holding a lease on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.push_recipients(p_inbox_id uuid)
RETURNS TABLE (
  subscription_id uuid,
  user_id         uuid,
  endpoint        text,
  p256dh          text,
  auth            text,
  payload_mode    text,
  quiet_start     smallint,
  quiet_end       smallint,
  quiet_timezone  text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT s.id,
         s.user_id,
         s.endpoint,
         s.p256dh,
         s.auth,
         coalesce(p.payload_mode, 'rich'),
         p.quiet_start,
         p.quiet_end,
         p.quiet_timezone
    FROM public.inboxes i
    JOIN public.workspaces w
      ON w.id = i.workspace_id
     AND w.deleted_at IS NULL
     AND w.web_client_enabled
    JOIN public.push_subscriptions s
      ON s.workspace_id = i.workspace_id
     AND s.disabled_at IS NULL
    JOIN public.workspace_members m
      ON m.workspace_id = s.workspace_id
     AND m.user_id = s.user_id
    LEFT JOIN public.push_preferences p
      ON p.user_id = s.user_id
     AND p.inbox_id = i.id
   WHERE i.id = p_inbox_id
     AND i.deleted_at IS NULL
     AND i.status = 'active'
     AND coalesce(p.enabled, true)
   ORDER BY s.created_at, s.id
   LIMIT 200;
$fn$;

COMMENT ON FUNCTION public.push_recipients(uuid) IS
  'Active push subscriptions to notify about one mailbox, with each owner''s payload_mode and quiet hours for it (defaults when no preference row). Only current members of a web-client-enabled workspace, only a live active inbox, never a mailbox the person switched off. Service-role only.';


-- ── Grant hardening (same posture as 20260603202232) ──────────────────────
-- SECURITY DEFINER plus the Supabase default grants would let a browser
-- session call these through /rest/v1/rpc: push_recipients would hand out
-- other people's push endpoints and keys, and lease_inbox_watches would let
-- anyone hold every lease. Only the service role (the edge function) and the
-- function owner (pg_cron) may call them. REVOKE on an absent grant is a no-op.
REVOKE EXECUTE ON FUNCTION public.sync_inbox_watch_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lease_inbox_watches(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.push_recipients(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_inbox_watch_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.lease_inbox_watches(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.push_recipients(uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- 4. record_push_results(p_sent, p_gone, p_failed)
--
-- What the push services answered, per subscription id, in one statement:
--   sent    accepted: stamp last_success_at, clear the failure count.
--   gone    404 / 410: the subscription no longer exists. Disable it.
--   failed  a retryable failure that outlasted the retries: count it, and
--           disable the row after 10 in a row so a permanently unreachable
--           endpoint does not keep a mailbox watched forever.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_push_results(
  p_sent   uuid[],
  p_gone   uuid[],
  p_failed uuid[]
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH sent AS (
    UPDATE public.push_subscriptions s
       SET last_success_at = now(), failure_count = 0, updated_at = now()
     WHERE s.id = ANY(coalesce(p_sent, '{}'::uuid[]))
    RETURNING 1
  ),
  gone AS (
    UPDATE public.push_subscriptions s
       SET disabled_at = coalesce(s.disabled_at, now()), updated_at = now()
     WHERE s.id = ANY(coalesce(p_gone, '{}'::uuid[]))
    RETURNING 1
  )
  UPDATE public.push_subscriptions s
     SET failure_count = s.failure_count + 1,
         disabled_at = CASE WHEN s.failure_count + 1 >= 10 THEN coalesce(s.disabled_at, now()) ELSE s.disabled_at END,
         updated_at = now()
   WHERE s.id = ANY(coalesce(p_failed, '{}'::uuid[]));
$fn$;

COMMENT ON FUNCTION public.record_push_results(uuid[], uuid[], uuid[]) IS
  'Records push service outcomes per subscription id: sent (stamp last_success_at, reset failures), gone (404/410: disable), failed (count; disable after 10 consecutive). Service-role only.';

REVOKE EXECUTE ON FUNCTION public.record_push_results(uuid[], uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_push_results(uuid[], uuid[], uuid[]) TO service_role;

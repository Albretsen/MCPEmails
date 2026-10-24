-- ===========================================================================
-- Webhooks for new mail (`message.received`), Pro and Business.
-- 20261024180000_webhook_endpoints
--
-- Version 20261024180000, not ...120000: that version is already taken by
-- 20261024120000_abandoned_checkout_recovery, and two files with one version
-- break `supabase db start` and `migration repair`.
--
-- Webhooks are a second consumer of the new-mail watcher built for web push
-- (20261005100000 .. 20261005100200, supabase/functions/client-api/push/).
-- The watcher already decides "this inbox has new mail"; when it does, the
-- dispatcher also enqueues one delivery per matching endpoint and POSTs a
-- signed event to it (client-api/webhooks/).
--
-- WHAT IS STORED, AND WHAT IS NOT
-- -------------------------------
--   webhook_endpoints   where to deliver: an https URL, the signing secret
--                       (encrypted, see below), an optional inbox filter, the
--                       payload mode, and failure bookkeeping.
--   webhook_deliveries  one row per (endpoint, event): attempt count, status,
--                       the receiver's HTTP status code, an error CODE and the
--                       retry schedule. No subject, sender, body or snippet,
--                       and no column that could hold one.
--
--                       The one exception to "no message ids" in the push
--                       tables: `message_ids` holds the provider message ids
--                       of a PENDING delivery, so a retry sends the same event
--                       the first attempt did. They are opaque ids (the ones
--                       `email_read` takes), capped in size, and set to NULL
--                       the moment the delivery is delivered, failed for good
--                       or abandoned. Rows are deleted after 30 days.
--
-- THE SIGNING SECRET
-- ------------------
-- A webhook secret must be recoverable to sign each delivery (HMAC-SHA256),
-- so it cannot be hashed the way API keys are. It is stored the way inbox
-- passwords and OAuth tokens are: AES-256-GCM under ENCRYPTION_KEY, base64url
-- of IV || ciphertext || tag (apps/web/src/lib/crypto.ts encrypts it; the
-- client-api edge function decrypts it with Web Crypto). The plaintext is
-- shown once, at creation, and never again. `secret_prefix` (the first
-- characters) is kept in clear so the dashboard can tell secrets apart.
-- Browser sessions cannot read the ciphertext column at all (column grants).
--
-- WHO MAY DO WHAT
-- ---------------
--   members (any role)  SELECT their workspace's endpoints (minus the secret)
--                       and deliveries.
--   owner / admin       create, edit, re-enable and delete, through the web
--                       routes (apps/web/app/api/webhook-endpoints), which run
--                       as the service role AFTER checking the role and the
--                       plan. Browser sessions hold no write grant, the same
--                       posture as api_keys (20261016160300): the admin write
--                       policies below document the rule and stay unreachable
--                       without a grant.
--   service role        everything; the dispatcher's functions are service
--                       role only.
--
-- PLAN GATE. Only Pro (`solo`) and Business (`pro`) workspaces, and comped
-- workspaces (which resolve to Business), deliver. A workspace that moves to
-- another plan keeps its endpoints, PAUSED: its inboxes drop out of the watch
-- set, nothing is enqueued, and pending retries are abandoned. Moving back
-- resumes them. `webhooks_plan_allowed()` is the one SQL definition; it
-- mirrors `webhooksEnabled` in apps/web/src/lib/stripe/plans.ts.
--
-- WHAT THIS MIGRATION DOES, IN ORDER
--   1. webhooks_plan_allowed(workspace)
--   2. webhook_endpoints
--   3. webhook_deliveries
--   4. RLS and grants
--   5. sync_inbox_watch_state(): an enabled endpoint watches its inboxes
--   6. the dispatcher's functions: webhook_enqueue_event,
--      lease_webhook_deliveries, record_webhook_attempt
--   7. dispatch_inbox_watch(): also wakes the dispatcher for due retries
--   8. 30-day retention for deliveries
--
-- Forward-only, one transaction, re-runnable. NOT APPLIED BY THE AGENT THAT
-- WROTE IT. Apply with `npx supabase db query --linked -f` then
-- `migration repair`, never `db push`, and BEFORE deploying client-api.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. webhooks_plan_allowed(p_workspace_id)
--
-- Service-side twin of effective_workspace_plan() for this one question.
-- effective_workspace_plan() is gated on my_workspace_ids() and answers
-- nothing to the service role, so the dispatcher cannot use it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.webhooks_plan_allowed(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.workspaces w
     WHERE w.id = p_workspace_id
       AND w.deleted_at IS NULL
       AND (
             w.plan IN ('solo', 'pro')
             OR EXISTS (
                  SELECT 1
                    FROM public.user_usage_entitlements e
                   WHERE e.user_id = w.owner_id
                     AND e.kind = 'comped_scale'
                     AND (e.expires_at IS NULL OR e.expires_at > now())
                )
           )
  );
$fn$;

COMMENT ON FUNCTION public.webhooks_plan_allowed(uuid) IS
  'True when the workspace may deliver webhooks: plan solo (Pro) or pro (Business), or a comped owner. Mirrors webhooksEnabled in apps/web/src/lib/stripe/plans.ts. Service-role only.';

REVOKE EXECUTE ON FUNCTION public.webhooks_plan_allowed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhooks_plan_allowed(uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- 2. webhook_endpoints
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  url                   text NOT NULL CHECK (url LIKE 'https://%' AND char_length(url) <= 2048),
  secret_ciphertext     text NOT NULL CHECK (char_length(secret_ciphertext) BETWEEN 40 AND 400),
  secret_prefix         text NOT NULL CHECK (char_length(secret_prefix) BETWEEN 4 AND 16),
  -- NULL = every inbox of the workspace, including ones connected later.
  inbox_ids             uuid[] CHECK (inbox_ids IS NULL OR cardinality(inbox_ids) BETWEEN 1 AND 200),
  events                text[] NOT NULL DEFAULT '{message.received}'
                          CHECK (cardinality(events) >= 1 AND events <@ ARRAY['message.received']::text[]),
  payload_mode          text NOT NULL DEFAULT 'ids' CHECK (payload_mode IN ('ids', 'headers')),
  created_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  disabled_at           timestamptz,
  -- 'manual' (an admin switched it off) or 'failing' (24 hours of failed
  -- deliveries, or 50 failures in a row).
  disabled_reason       text CHECK (disabled_reason IS NULL OR disabled_reason IN ('manual', 'failing')),
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- First failure of the current run of failures; NULL after a success.
  failing_since         timestamptz,
  last_success_at       timestamptz,
  CONSTRAINT webhook_endpoints_disabled_reason_with_date CHECK (
    (disabled_at IS NULL AND disabled_reason IS NULL) OR (disabled_at IS NOT NULL AND disabled_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_workspace_idx
  ON public.webhook_endpoints (workspace_id);
CREATE INDEX IF NOT EXISTS webhook_endpoints_workspace_enabled_idx
  ON public.webhook_endpoints (workspace_id)
  WHERE disabled_at IS NULL;

COMMENT ON TABLE public.webhook_endpoints IS
  'Webhook endpoints for new-mail events (Pro and Business). url is https only; the signing secret is AES-256-GCM encrypted under ENCRYPTION_KEY and never readable from a browser session. Written only by the web routes as the service role after a role and plan check; members may read. No mail content.';
COMMENT ON COLUMN public.webhook_endpoints.secret_ciphertext IS
  'The signing secret, base64url(IV || AES-256-GCM ciphertext || tag) under ENCRYPTION_KEY (apps/web/src/lib/crypto.ts). Shown in plaintext once at creation. No grant to anon or authenticated.';


-- ---------------------------------------------------------------------------
-- 3. webhook_deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      uuid NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  -- Denormalised from the endpoint so RLS is one array check.
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_id         text NOT NULL CHECK (event_id ~ '^evt_[0-9a-f]{32}$'),
  event_type       text NOT NULL CHECK (event_type IN ('message.received', 'ping')),
  inbox_id         uuid REFERENCES public.inboxes(id) ON DELETE SET NULL,
  -- Pending deliveries only; NULL once terminal. See the header.
  message_ids      text[] CHECK (message_ids IS NULL OR (cardinality(message_ids) <= 20 AND pg_column_size(message_ids) <= 8192)),
  message_count    integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  attempt          integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
  response_code    integer CHECK (response_code IS NULL OR response_code BETWEEN 100 AND 599),
  -- 'timeout', 'connect_failed', 'tls_failed', 'url_blocked', 'redirect',
  -- 'http_status', 'paused', 'endpoint_disabled', ... A CODE, never a
  -- receiver's response body.
  error_code       text CHECK (error_code IS NULL OR char_length(error_code) <= 40),
  next_attempt_at  timestamptz,
  lease_id         uuid,
  leased_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_attempt_at  timestamptz,
  delivered_at     timestamptz,
  CONSTRAINT webhook_deliveries_ids_only_while_pending CHECK (status = 'pending' OR message_ids IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_endpoint_event_key
  ON public.webhook_deliveries (endpoint_id, event_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_created_idx
  ON public.webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON public.webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx
  ON public.webhook_deliveries (created_at);

COMMENT ON TABLE public.webhook_deliveries IS
  'One row per webhook delivery (endpoint x event): attempts, status, receiver status code, error code, retry schedule. message_ids holds opaque provider ids of a PENDING delivery only, so a retry repeats the same event; NULL once terminal. No subject, sender or body. Deleted after 30 days. Members may read; service role writes.';


-- ---------------------------------------------------------------------------
-- 4. RLS and grants
-- ---------------------------------------------------------------------------
ALTER TABLE public.webhook_endpoints  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_endpoints_select_members" ON public.webhook_endpoints;
CREATE POLICY "webhook_endpoints_select_members"
  ON public.webhook_endpoints FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- Unreachable without a grant (see the header); they state the rule a future
-- narrower grant would still be held to: owner and admin only.
DROP POLICY IF EXISTS "webhook_endpoints_write_admins" ON public.webhook_endpoints;
CREATE POLICY "webhook_endpoints_write_admins"
  ON public.webhook_endpoints FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.workspace_members m
     WHERE m.workspace_id = webhook_endpoints.workspace_id
       AND m.user_id = auth.uid()
       AND m.role IN ('owner', 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.workspace_members m
     WHERE m.workspace_id = webhook_endpoints.workspace_id
       AND m.user_id = auth.uid()
       AND m.role IN ('owner', 'admin')
  ));

DROP POLICY IF EXISTS "webhook_deliveries_select_members" ON public.webhook_deliveries;
CREATE POLICY "webhook_deliveries_select_members"
  ON public.webhook_deliveries FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

REVOKE ALL ON public.webhook_endpoints  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.webhook_deliveries FROM PUBLIC, anon, authenticated;

-- Every column but the secret.
GRANT SELECT (
  id, workspace_id, url, secret_prefix, inbox_ids, events, payload_mode, created_by,
  created_at, updated_at, disabled_at, disabled_reason, consecutive_failures,
  failing_since, last_success_at
) ON public.webhook_endpoints TO authenticated;

-- Every column but the pending message ids and the lease.
GRANT SELECT (
  id, endpoint_id, workspace_id, event_id, event_type, inbox_id, message_count, attempt,
  status, response_code, error_code, next_attempt_at, created_at, last_attempt_at, delivered_at
) ON public.webhook_deliveries TO authenticated;

GRANT ALL ON public.webhook_endpoints  TO service_role;
GRANT ALL ON public.webhook_deliveries TO service_role;


-- ---------------------------------------------------------------------------
-- 5. sync_inbox_watch_state(): webhooks watch inboxes too.
--
-- Current definition: 20261005100100. The push branch is unchanged. Added: a
-- live, active inbox is also watched when an ENABLED endpoint of its
-- workspace covers it (inbox_ids NULL or containing it) and the workspace's
-- plan allows webhooks. web_client_enabled is not required for this branch:
-- webhooks do not involve the web client. A paused (downgraded) or disabled
-- endpoint watches nothing.
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
     WHERE i.deleted_at IS NULL
       AND i.status = 'active'
       AND (
             (
               w.web_client_enabled
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
             )
             OR (
               EXISTS (
                 SELECT 1
                   FROM public.webhook_endpoints e
                  WHERE e.workspace_id = i.workspace_id
                    AND e.disabled_at IS NULL
                    AND (e.inbox_ids IS NULL OR i.id = ANY(e.inbox_ids))
               )
               AND public.webhooks_plan_allowed(i.workspace_id)
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
  'Makes inbox_watch_state equal to the set of watched mailboxes: live, active inboxes that either (a) are in a web-client-enabled workspace with an active push subscription of a current member who has not switched that mailbox off, or (b) are covered by an enabled webhook endpoint of a workspace whose plan allows webhooks. New rows start with an empty cursor. Called by dispatch_inbox_watch() and lease_inbox_watches().';


-- ---------------------------------------------------------------------------
-- 6. The dispatcher's functions
-- ---------------------------------------------------------------------------

-- webhook_has_targets: does any enabled, plan-allowed endpoint cover this
-- inbox? Asked on an arrival before the mailbox is read for message ids, so a
-- mailbox watched only for (private) push is not read for webhooks.
CREATE OR REPLACE FUNCTION public.webhook_has_targets(p_inbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.inboxes i
      JOIN public.webhook_endpoints e
        ON e.workspace_id = i.workspace_id
       AND e.disabled_at IS NULL
       AND (e.inbox_ids IS NULL OR i.id = ANY(e.inbox_ids))
     WHERE i.id = p_inbox_id
       AND i.deleted_at IS NULL
       AND i.status = 'active'
       AND 'message.received' = ANY(e.events)
  ) AND public.webhooks_plan_allowed((SELECT workspace_id FROM public.inboxes WHERE id = p_inbox_id));
$fn$;

COMMENT ON FUNCTION public.webhook_has_targets(uuid) IS
  'True when an enabled endpoint of a plan-allowed workspace covers the inbox. Service-role only.';

REVOKE EXECUTE ON FUNCTION public.webhook_has_targets(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_has_targets(uuid) TO service_role;

-- webhook_enqueue_event: one row per enabled, plan-allowed endpoint that
-- covers the inbox, created already LEASED to the caller (which makes the
-- first attempt in the same request), and returned with what that attempt
-- needs. ON CONFLICT DO NOTHING on (endpoint, event): a repeated call with
-- the same event id enqueues nothing twice.
CREATE OR REPLACE FUNCTION public.webhook_enqueue_event(
  p_inbox_id      uuid,
  p_event_id      text,
  p_message_ids   text[],
  p_message_count integer,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  delivery_id       uuid,
  lease_id          uuid,
  endpoint_id       uuid,
  workspace_id      uuid,
  url               text,
  secret_ciphertext text,
  payload_mode      text,
  created_at        timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_column
DECLARE
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 600));
  v_lease_id uuid := gen_random_uuid();
BEGIN
  RETURN QUERY
  WITH targets AS (
    SELECT e.id, e.workspace_id, e.url, e.secret_ciphertext, e.payload_mode
      FROM public.inboxes i
      JOIN public.webhook_endpoints e
        ON e.workspace_id = i.workspace_id
       AND e.disabled_at IS NULL
       AND (e.inbox_ids IS NULL OR i.id = ANY(e.inbox_ids))
     WHERE i.id = p_inbox_id
       AND i.deleted_at IS NULL
       AND i.status = 'active'
       AND 'message.received' = ANY(e.events)
       AND public.webhooks_plan_allowed(i.workspace_id)
     ORDER BY e.created_at, e.id
     LIMIT 50
  ),
  inserted AS (
    INSERT INTO public.webhook_deliveries AS d
      (endpoint_id, workspace_id, event_id, event_type, inbox_id, message_ids, message_count,
       status, next_attempt_at, lease_id, leased_until)
    SELECT t.id, t.workspace_id, p_event_id, 'message.received', p_inbox_id,
           (p_message_ids)[1:20], greatest(coalesce(p_message_count, 0), 0),
           'pending', now(), v_lease_id, now() + v_lease
      FROM targets t
    ON CONFLICT (endpoint_id, event_id) DO NOTHING
    RETURNING d.id, d.lease_id, d.endpoint_id, d.created_at
  )
  SELECT x.id, x.lease_id, t.id, t.workspace_id, t.url, t.secret_ciphertext, t.payload_mode, x.created_at
    FROM inserted x
    JOIN targets t ON t.id = x.endpoint_id;
END;
$fn$;

COMMENT ON FUNCTION public.webhook_enqueue_event(uuid, text, text[], integer, integer) IS
  'Enqueues one message.received delivery per enabled, plan-allowed endpoint covering the inbox, leased to the caller for its first attempt, and returns the endpoint URL, encrypted secret and payload mode. Idempotent per (endpoint, event id). Service-role only.';

-- lease_webhook_deliveries: due retries, FOR UPDATE SKIP LOCKED, with what a
-- retry needs. A delivery whose endpoint is disabled or whose workspace may
-- no longer deliver comes back with plan_allowed / endpoint_enabled false and
-- is abandoned by the caller.
CREATE OR REPLACE FUNCTION public.lease_webhook_deliveries(
  p_limit         integer DEFAULT 20,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  delivery_id       uuid,
  lease_id          uuid,
  endpoint_id       uuid,
  workspace_id      uuid,
  event_id          text,
  inbox_id          uuid,
  provider          text,
  message_ids       text[],
  message_count     integer,
  attempt           integer,
  created_at        timestamptz,
  url               text,
  secret_ciphertext text,
  payload_mode      text,
  endpoint_enabled  boolean,
  plan_allowed      boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 600));
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT d.id
      FROM public.webhook_deliveries d
     WHERE d.status = 'pending'
       AND d.next_attempt_at <= now()
       AND (d.leased_until IS NULL OR d.leased_until <= now())
     ORDER BY d.next_attempt_at
     LIMIT v_limit
       FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.webhook_deliveries d
       SET lease_id = gen_random_uuid(),
           leased_until = now() + v_lease
      FROM due
     WHERE d.id = due.id
    RETURNING d.id, d.lease_id, d.endpoint_id, d.workspace_id, d.event_id, d.inbox_id,
              d.message_ids, d.message_count, d.attempt, d.created_at
  )
  SELECT c.id, c.lease_id, c.endpoint_id, c.workspace_id, c.event_id, c.inbox_id,
         i.provider, c.message_ids, c.message_count, c.attempt, c.created_at,
         e.url, e.secret_ciphertext, e.payload_mode,
         e.disabled_at IS NULL,
         public.webhooks_plan_allowed(c.workspace_id)
    FROM claimed c
    JOIN public.webhook_endpoints e ON e.id = c.endpoint_id
    LEFT JOIN public.inboxes i ON i.id = c.inbox_id;
END;
$fn$;

COMMENT ON FUNCTION public.lease_webhook_deliveries(integer, integer) IS
  'Claims up to p_limit due pending webhook deliveries (FOR UPDATE SKIP LOCKED, a lease id the caller must present to record the attempt) with the endpoint URL, encrypted secret, payload mode, and whether the endpoint is enabled and the plan still allows delivery. Service-role only.';

-- record_webhook_attempt: the result of one attempt, applied atomically to
-- the delivery and its endpoint. The retry schedule and the disable
-- thresholds are the caller's (client-api/webhooks/deliver.ts) and arrive as
-- arguments, so the policy lives in one place; the counters are updated here
-- so concurrent attempts against one endpoint cannot lose an increment.
--
--   p_ok            the receiver answered 2xx
--   p_next_at       when to retry; NULL = no more attempts (status 'failed')
--   p_abandon_code  set instead of an attempt: the delivery is abandoned with
--                   this code and the endpoint's counters are not touched
--
-- Returns one row for a delivery the lease still held: whether this attempt
-- disabled the endpoint (so the caller emails the owner exactly once).
CREATE OR REPLACE FUNCTION public.record_webhook_attempt(
  p_delivery_id          uuid,
  p_lease_id             uuid,
  p_ok                   boolean,
  p_response_code        integer,
  p_error_code           text,
  p_next_at              timestamptz,
  p_max_failures         integer,
  p_max_failing_seconds  integer,
  p_abandon_code         text DEFAULT NULL
)
RETURNS TABLE (endpoint_id uuid, endpoint_disabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_column
DECLARE
  v_endpoint uuid;
  v_disabled boolean := false;
BEGIN
  IF p_abandon_code IS NOT NULL THEN
    UPDATE public.webhook_deliveries d
       SET status = 'abandoned', error_code = left(p_abandon_code, 40), message_ids = NULL,
           next_attempt_at = NULL, lease_id = NULL, leased_until = NULL
     WHERE d.id = p_delivery_id AND d.lease_id = p_lease_id AND d.status = 'pending'
    RETURNING d.endpoint_id INTO v_endpoint;
    IF v_endpoint IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT v_endpoint, false;
    RETURN;
  END IF;

  UPDATE public.webhook_deliveries d
     SET attempt = d.attempt + 1,
         last_attempt_at = now(),
         response_code = CASE WHEN p_response_code BETWEEN 100 AND 599 THEN p_response_code END,
         error_code = CASE WHEN p_ok THEN NULL ELSE left(p_error_code, 40) END,
         status = CASE WHEN p_ok THEN 'delivered' WHEN p_next_at IS NULL THEN 'failed' ELSE 'pending' END,
         delivered_at = CASE WHEN p_ok THEN now() ELSE d.delivered_at END,
         next_attempt_at = CASE WHEN p_ok THEN NULL ELSE p_next_at END,
         message_ids = CASE WHEN p_ok OR p_next_at IS NULL THEN NULL ELSE d.message_ids END,
         lease_id = NULL,
         leased_until = NULL
   WHERE d.id = p_delivery_id AND d.lease_id = p_lease_id AND d.status = 'pending'
  RETURNING d.endpoint_id INTO v_endpoint;

  IF v_endpoint IS NULL THEN RETURN; END IF;

  IF p_ok THEN
    UPDATE public.webhook_endpoints e
       SET consecutive_failures = 0, failing_since = NULL, last_success_at = now()
     WHERE e.id = v_endpoint;
  ELSE
    UPDATE public.webhook_endpoints e
       SET consecutive_failures = e.consecutive_failures + 1,
           failing_since = coalesce(e.failing_since, now()),
           disabled_at = CASE
             WHEN e.disabled_at IS NULL
              AND (e.consecutive_failures + 1 >= p_max_failures
                   OR coalesce(e.failing_since, now()) <= now() - make_interval(secs => p_max_failing_seconds))
             THEN now() ELSE e.disabled_at END,
           disabled_reason = CASE
             WHEN e.disabled_at IS NULL
              AND (e.consecutive_failures + 1 >= p_max_failures
                   OR coalesce(e.failing_since, now()) <= now() - make_interval(secs => p_max_failing_seconds))
             THEN 'failing' ELSE e.disabled_reason END
     WHERE e.id = v_endpoint
    RETURNING (e.disabled_reason = 'failing' AND e.disabled_at = now()) INTO v_disabled;

    IF v_disabled THEN
      UPDATE public.webhook_deliveries d
         SET status = 'abandoned', error_code = 'endpoint_disabled', message_ids = NULL,
             next_attempt_at = NULL, lease_id = NULL, leased_until = NULL
       WHERE d.endpoint_id = v_endpoint AND d.status = 'pending';
    END IF;
  END IF;

  RETURN QUERY SELECT v_endpoint, coalesce(v_disabled, false);
END;
$fn$;

COMMENT ON FUNCTION public.record_webhook_attempt(uuid, uuid, boolean, integer, text, timestamptz, integer, integer, text) IS
  'Records one webhook attempt (or abandons the delivery) for a delivery the lease still holds, updates the endpoint''s failure counters atomically, disables the endpoint at the caller''s thresholds and abandons its pending deliveries. Returns whether this call disabled it. Service-role only.';

REVOKE EXECUTE ON FUNCTION public.webhook_enqueue_event(uuid, text, text[], integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lease_webhook_deliveries(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_webhook_attempt(uuid, uuid, boolean, integer, text, timestamptz, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_enqueue_event(uuid, text, text[], integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.lease_webhook_deliveries(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_webhook_attempt(uuid, uuid, boolean, integer, text, timestamptz, integer, integer, text) TO service_role;


-- ---------------------------------------------------------------------------
-- 7. dispatch_inbox_watch(): retries wake the dispatcher too.
--
-- Current definition: 20261005100200. Unchanged except that a due webhook
-- retry also counts as work: with no mailbox due, one request is still made
-- when a retry is due, because retries are sent from the same pass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_inbox_watch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  -- Public, non-secret base URL of the client-api Edge Function. The
  -- /push/dispatch route validates the X-Dispatch-Secret header.
  v_url      text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/client-api';
  v_secret   text;
  v_due      integer;
  v_retries  boolean;
  v_requests integer;
  -- Keep in step with BATCH_SIZE in supabase/functions/client-api/push/dispatch.ts.
  c_batch    constant integer := 20;
  c_max_requests constant integer := 4;
BEGIN
  PERFORM public.sync_inbox_watch_state();

  SELECT count(*)::integer
    INTO v_due
    FROM public.inbox_watch_state s
   WHERE s.next_check_at <= now()
     AND (s.backoff_until IS NULL OR s.backoff_until <= now())
     AND (s.leased_until IS NULL OR s.leased_until <= now());

  SELECT EXISTS (
    SELECT 1 FROM public.webhook_deliveries d
     WHERE d.status = 'pending'
       AND d.next_attempt_at <= now()
       AND (d.leased_until IS NULL OR d.leased_until <= now())
  ) INTO v_retries;

  -- Nothing to check and nothing to retry: no HTTP request.
  IF v_due = 0 AND NOT v_retries THEN
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
    RAISE WARNING 'dispatch_inbox_watch: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  v_requests := greatest(least(ceil(v_due::numeric / c_batch)::integer, c_max_requests), 1);

  FOR n IN 1..v_requests LOOP
    PERFORM net.http_post(
      url     := v_url || '/push/dispatch',
      headers := jsonb_build_object(
                   'Content-Type',      'application/json',
                   'X-Dispatch-Secret', v_secret
                 ),
      body    := '{}'::jsonb
    );
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_inbox_watch() IS
  'Called by pg_cron every minute. Syncs the set of watched mailboxes, and when any is due (or a webhook retry is due) posts to the client-api /push/dispatch route (once per 20 due, at least once, at most 4 requests). Posts nothing when nothing is due. The dispatch secret is read from Vault (name ''dispatch_secret''). Empty body: selection, leasing and budgeting live in the database functions and the Edge Function.';

REVOKE EXECUTE ON FUNCTION public.dispatch_inbox_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_inbox_watch() TO service_role;


-- ---------------------------------------------------------------------------
-- 8. Retention: deliveries are kept 30 days, then deleted. Daily at 03:35 UTC,
-- clear of the other retention sweeps.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'webhook-deliveries-retention') THEN
    PERFORM cron.unschedule('webhook-deliveries-retention');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'webhook-deliveries-retention',
  '35 3 * * *',
  $$DELETE FROM public.webhook_deliveries WHERE created_at < now() - INTERVAL '30 days'$$
);

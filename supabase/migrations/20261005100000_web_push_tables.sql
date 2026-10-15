-- ===========================================================================
-- Web push for the web mail client: subscriptions, preferences, watch state.
-- 20261005100000_web_push_tables
--
-- Design: docs/VISION-web-client.md ("Push notifications"). Read and written
-- by the `client-api` edge function (supabase/functions/client-api/push/).
--
-- WHAT IS STORED, AND WHAT IS NOT
-- -------------------------------
-- The published promise is that mail is fetched live and never stored. These
-- three tables keep that promise. They hold:
--
--   push_subscriptions  where a browser can be reached: the push service URL
--                       the browser was given, and the two public values
--                       (p256dh, auth) needed to encrypt a message so that only
--                       that browser can read it.
--   push_preferences    per person and mailbox: on or off, how much a
--                       notification may show, optional quiet hours.
--   inbox_watch_state   per watched mailbox: a change CURSOR for its inbox
--                       folder (counters and server sequence numbers such as
--                       IMAP UIDNEXT or the Gmail historyId), when it was last
--                       checked, and the lease / backoff bookkeeping.
--
-- No subject, sender, recipient, body, snippet, message id or folder name is
-- stored in any of them, and there is no column that could hold one: the
-- cursor is a small JSON object with a size CHECK, and the only free-text
-- columns are a browser label and an error CODE, both length-capped.
--
-- WHAT THIS MIGRATION DOES, IN ORDER
-- ----------------------------------
--   1. push_subscriptions (+ indexes)
--   2. push_preferences
--   3. inbox_watch_state (+ the due index)
--   4. RLS: a person may SELECT and DELETE their own subscriptions and SELECT
--      their own preferences. Every INSERT / UPDATE goes through the edge
--      function as the service role. inbox_watch_state has no policies at all.
--
-- The functions that use these tables are in 20261005100100; the cron job
-- that starts the watcher is in 20261005100200 and is applied LAST, after the
-- edge function is deployed.
--
-- Forward-only, one transaction, re-runnable: CREATE TABLE / INDEX IF NOT
-- EXISTS, policies dropped-if-present and re-created, idempotent REVOKEs.
-- NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with the normal migration
-- workflow (never `db push`).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. push_subscriptions
--
-- One row per browser (per push endpoint). `endpoint` is unique across the
-- table: a browser profile has one subscription for this origin, and signing
-- in as someone else on it re-points the row instead of adding a second one.
--
-- workspace_id is the workspace the person was using when they turned
-- notifications on; that browser is told about new mail in THAT workspace's
-- mailboxes. Removing the person from the workspace stops delivery at once
-- (the functions in 20261005100100 join workspace_members), and deleting the
-- user or the workspace removes the row.
--
-- user_agent is a short label such as "Chrome on macOS", derived by the edge
-- function, for a future "your devices" list. Never the raw header.
--
-- failure_count / disabled_at: a push service answering 404 or 410 means the
-- subscription is gone; the row is disabled (kept 30 days for diagnosis, then
-- deleted by the retention job in 20261005100200) and never sent to again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  endpoint         text NOT NULL CHECK (endpoint LIKE 'https://%' AND char_length(endpoint) <= 2048),
  p256dh           text NOT NULL CHECK (char_length(p256dh) BETWEEN 80 AND 120),
  auth             text NOT NULL CHECK (char_length(auth) BETWEEN 16 AND 64),
  user_agent       text CHECK (user_agent IS NULL OR char_length(user_agent) <= 80),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz,
  failure_count    integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  disabled_at      timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key
  ON public.push_subscriptions (endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_workspace_active_idx
  ON public.push_subscriptions (workspace_id)
  WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

COMMENT ON TABLE public.push_subscriptions IS
  'Web Push subscriptions of the web mail client: one row per browser. endpoint is the push service URL the browser was issued; p256dh and auth are the browser''s public key and auth secret used to encrypt each message to it (RFC 8291). No mail content. Written only by the client-api edge function as the service role; a person may read and delete their own rows.';
COMMENT ON COLUMN public.push_subscriptions.disabled_at IS
  'Set when the push service answered 404/410 (the subscription no longer exists) or after repeated failures. A disabled row is never sent to and does not keep a mailbox watched.';


-- ---------------------------------------------------------------------------
-- 2. push_preferences
--
-- One row per (person, mailbox), created only when the person changes
-- something: NO ROW means the defaults (enabled, payload_mode 'rich', no
-- quiet hours).
--
-- payload_mode:
--   'rich'     the notification shows the sender's name and the subject of the
--              newest messages. They are read from the mailbox at the moment
--              of sending, encrypted to the browser, and never stored here.
--   'private'  the notification shows only a count and the mailbox name.
--
-- Quiet hours are minutes after local midnight in quiet_timezone (an IANA
-- name). start > end means the window crosses midnight. All three are set, or
-- none is.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_preferences (
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  inbox_id        uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT true,
  payload_mode    text NOT NULL DEFAULT 'rich' CHECK (payload_mode IN ('rich', 'private')),
  quiet_start     smallint CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end       smallint CHECK (quiet_end BETWEEN 0 AND 1439),
  quiet_timezone  text CHECK (quiet_timezone IS NULL OR char_length(quiet_timezone) BETWEEN 1 AND 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, inbox_id),
  CONSTRAINT push_preferences_quiet_all_or_none CHECK (
    (quiet_start IS NULL AND quiet_end IS NULL AND quiet_timezone IS NULL)
    OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_timezone IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS push_preferences_inbox_idx
  ON public.push_preferences (inbox_id);

COMMENT ON TABLE public.push_preferences IS
  'Per person and mailbox notification settings for the web mail client: enabled, payload_mode (rich = sender and subject, private = count and mailbox name only) and optional quiet hours. No row = the defaults. Written only by the client-api edge function.';


-- ---------------------------------------------------------------------------
-- 3. inbox_watch_state
--
-- One row per mailbox that currently has somebody to notify. Rows are created
-- and removed by sync_inbox_watch_state() (20261005100100): a mailbox with no
-- active subscription is not watched and has no row.
--
-- folders is the change cursor, keyed by the watched folder's role. Only
-- "inbox" to start:
--     { "inbox": { "fingerprint": "i:1700000000:4182:120:3:-:-",
--                  "total": 120, "unread": 3 } }
-- The fingerprint is the one mail/status.ts already computes for the client's
-- own change poll: IMAP UIDVALIDITY / UIDNEXT / counters / HIGHESTMODSEQ, the
-- Gmail historyId, or the Graph folder counters. Numbers and opaque ids; the
-- size CHECK keeps it from ever becoming anything else.
--
-- Lease: a dispatcher claims a row by setting lease_id and leased_until, and
-- must present the same lease_id to write the result. A row whose lease has
-- expired (the isolate died) is simply claimable again.
--
-- failure_count / backoff_until / last_error_code: consecutive failed checks,
-- when the next attempt is allowed, and a CODE ('reconnect_required',
-- 'provider_error', 'timeout', ...). Never a provider's error text.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbox_watch_state (
  inbox_id         uuid PRIMARY KEY REFERENCES public.inboxes(id) ON DELETE CASCADE,
  folders          jsonb NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(folders) = 'object' AND pg_column_size(folders) <= 2048),
  last_checked_at  timestamptz,
  last_changed_at  timestamptz,
  last_notified_at timestamptz,
  next_check_at    timestamptz NOT NULL DEFAULT now(),
  lease_id         uuid,
  leased_until     timestamptz,
  failure_count    integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  backoff_until    timestamptz,
  last_error_code  text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 40),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_watch_state_due_idx
  ON public.inbox_watch_state (next_check_at);

COMMENT ON TABLE public.inbox_watch_state IS
  'Server-side new-mail watcher for the web mail client: per watched mailbox, a change cursor for its inbox folder (counters and sequence numbers only), check timestamps, the dispatcher lease and failure backoff. No mail content. Service-role only; no policies on purpose.';


-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_preferences   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_watch_state  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push_subscriptions_select_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_select_own"
  ON public.push_subscriptions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "push_subscriptions_delete_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_delete_own"
  ON public.push_subscriptions FOR DELETE TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "push_preferences_select_own" ON public.push_preferences;
CREATE POLICY "push_preferences_select_own"
  ON public.push_preferences FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Belt and braces beside RLS. A browser session never writes a subscription
-- or a preference directly (the edge function validates the endpoint against
-- the known push services before storing it), and never sees watch state.
REVOKE ALL ON public.push_subscriptions FROM anon;
REVOKE INSERT, UPDATE, TRUNCATE ON public.push_subscriptions FROM authenticated;
REVOKE ALL ON public.push_preferences FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.push_preferences FROM authenticated;
REVOKE ALL ON public.inbox_watch_state FROM anon, authenticated;

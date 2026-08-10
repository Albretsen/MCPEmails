-- ============================================================
-- system_notify_threads
--
-- Lets the system-notify Edge Function reply into an existing email
-- thread instead of starting a brand-new email for every event. One
-- row per event_type, holding the provider-native message_id of the
-- most recently sent notification for that event_type. The Edge
-- Function replies to that message_id (deriving thread headers from
-- it) and then overwrites the row with the new message_id it gets
-- back, so the thread keeps growing instead of resetting.
--
-- Service role only, same access model as system_events.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_notify_threads (
  event_type text PRIMARY KEY,
  message_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.system_notify_threads IS
  'Tracks the most recent message_id sent per event_type so the system-notify Edge Function can reply into the same thread instead of starting a new one each time.';

ALTER TABLE public.system_notify_threads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.system_notify_threads FROM anon, authenticated;

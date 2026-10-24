-- ============================================================
-- Outbound abuse brakes (mcp-server/outbound-brakes.ts)
--
-- The risk is a customer's automation, not the customer, mass-sending through
-- their own mailbox and getting the mailbox or our relay addresses reported.
-- Four brakes, all decided in one atomic RPC per send:
--
--   1. a workspace freeze: workspaces.sends_frozen_at, set by an operator;
--      every send refuses while it is not null;
--   2. a provider-refusal pause: 3 spam or policy refusals from the provider
--      within an hour pause sends from that inbox for an hour;
--   3. a per-inbox daily ceiling: 500 messages per rolling 24 hours, counted
--      in messages, not recipients;
--   4. a fan-out brake: one normalized subject+body hash reaching more than 25
--      distinct recipients within an hour holds further sends from that inbox
--      for a human until the end of the UTC day (send_approvals, dashboard).
--
-- PRIVACY. Nothing here stores message content or an address. The content
-- and each recipient are SHA-256 hashed by the edge function before the call;
-- only the hex digests reach this table, and they expire with the rows.
--
-- ACCESS. Both tables have RLS on and no policy for members: only the
-- service-role edge function writes or reads them, through the two RPCs.
-- ============================================================

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS sends_frozen_at timestamptz;

COMMENT ON COLUMN public.workspaces.sends_frozen_at IS
  'Operator kill switch. While set, every outbound send from the workspace refuses '
  'with error_code sends_frozen (mcp-server/outbound-brakes.ts). Set and clear by hand.';

-- One row per transmitted message (kind = message, messages = how many),
-- one row per distinct recipient of a hashed content (kind = recipient), and
-- one row per counted provider refusal (kind = refusal).
CREATE TABLE IF NOT EXISTS public.outbound_send_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id       uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('message', 'recipient', 'refusal')),
  messages       integer NOT NULL DEFAULT 1 CHECK (messages >= 1),
  content_hash   text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  recipient_hash text CHECK (recipient_hash IS NULL OR recipient_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_send_events_inbox_kind_time
  ON public.outbound_send_events (inbox_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_send_events_inbox_content_time
  ON public.outbound_send_events (inbox_id, content_hash, created_at)
  WHERE kind = 'recipient';
CREATE INDEX IF NOT EXISTS idx_outbound_send_events_created_at
  ON public.outbound_send_events (created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_send_events_workspace_id
  ON public.outbound_send_events (workspace_id);

ALTER TABLE public.outbound_send_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outbound_send_events FROM PUBLIC, anon, authenticated;

-- Current brake state per inbox. A row exists only once a brake has tripped.
CREATE TABLE IF NOT EXISTS public.inbox_send_brakes (
  inbox_id            uuid PRIMARY KEY REFERENCES public.inboxes(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  fanout_hold_until   timestamptz,
  refusal_pause_until timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbox_send_brakes_workspace_id
  ON public.inbox_send_brakes (workspace_id);

ALTER TABLE public.inbox_send_brakes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inbox_send_brakes FROM PUBLIC, anon, authenticated;

-- ── outbound_send_gate ──────────────────────────────────────────────────────
-- Decide one send and, when it is allowed and p_commit is true, record it, in
-- one transaction serialised per inbox (advisory lock), so two concurrent
-- sends cannot both slip under a ceiling.
--
-- Returns jsonb { decision, retry_at?, newly_tripped? } where decision is one
-- of: allow | frozen | paused | daily_limit | hold.
--
-- p_human_approved: the send is already a human's decision (an approved send
-- being dispatched). It skips the fan-out brake, which exists to put a human
-- in the loop, and is still counted and still subject to the other three.
CREATE OR REPLACE FUNCTION public.outbound_send_gate(
  p_workspace_id     uuid,
  p_inbox_id         uuid,
  p_messages         integer,
  p_content_hash     text,
  p_recipient_hashes text[],
  p_daily_limit      integer,
  p_fanout_limit     integer,
  p_fanout_window_ms bigint,
  p_human_approved   boolean,
  p_commit           boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now        timestamptz := now();
  v_messages   integer := GREATEST(COALESCE(p_messages, 1), 1);
  v_frozen     timestamptz;
  v_brake      public.inbox_send_brakes%ROWTYPE;
  v_sent       bigint;
  v_oldest     timestamptz;
  v_distinct   bigint;
  v_hold_until timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outbound_send_gate:' || p_inbox_id::text, 0));

  SELECT sends_frozen_at INTO v_frozen FROM public.workspaces WHERE id = p_workspace_id;
  IF v_frozen IS NOT NULL THEN
    RETURN jsonb_build_object('decision', 'frozen');
  END IF;

  SELECT * INTO v_brake FROM public.inbox_send_brakes WHERE inbox_id = p_inbox_id;
  IF v_brake.refusal_pause_until IS NOT NULL AND v_brake.refusal_pause_until > v_now THEN
    RETURN jsonb_build_object('decision', 'paused', 'retry_at', v_brake.refusal_pause_until);
  END IF;

  SELECT COALESCE(sum(messages), 0), min(created_at) INTO v_sent, v_oldest
    FROM public.outbound_send_events
   WHERE inbox_id = p_inbox_id AND kind = 'message' AND created_at > v_now - interval '24 hours';
  IF v_sent + v_messages > p_daily_limit THEN
    RETURN jsonb_build_object(
      'decision', 'daily_limit',
      'retry_at', COALESCE(v_oldest, v_now) + interval '24 hours'
    );
  END IF;

  IF NOT COALESCE(p_human_approved, false) THEN
    IF v_brake.fanout_hold_until IS NOT NULL AND v_brake.fanout_hold_until > v_now THEN
      RETURN jsonb_build_object('decision', 'hold', 'retry_at', v_brake.fanout_hold_until, 'newly_tripped', false);
    END IF;

    IF p_content_hash IS NOT NULL AND COALESCE(cardinality(p_recipient_hashes), 0) > 0 THEN
      SELECT count(*) INTO v_distinct FROM (
        SELECT recipient_hash FROM public.outbound_send_events
         WHERE inbox_id = p_inbox_id
           AND kind = 'recipient'
           AND content_hash = p_content_hash
           AND created_at > v_now - (p_fanout_window_ms || ' milliseconds')::interval
        UNION
        SELECT unnest(p_recipient_hashes)
      ) AS recipients;
      IF v_distinct > p_fanout_limit THEN
        -- Held until the end of the current UTC day.
        v_hold_until := (date_trunc('day', v_now AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC';
        INSERT INTO public.inbox_send_brakes (inbox_id, workspace_id, fanout_hold_until, updated_at)
        VALUES (p_inbox_id, p_workspace_id, v_hold_until, v_now)
        ON CONFLICT (inbox_id) DO UPDATE
          SET fanout_hold_until = EXCLUDED.fanout_hold_until, updated_at = v_now;
        RETURN jsonb_build_object('decision', 'hold', 'retry_at', v_hold_until, 'newly_tripped', true);
      END IF;
    END IF;
  END IF;

  IF COALESCE(p_commit, true) THEN
    INSERT INTO public.outbound_send_events (workspace_id, inbox_id, kind, messages)
    VALUES (p_workspace_id, p_inbox_id, 'message', v_messages);
    IF p_content_hash IS NOT NULL AND COALESCE(cardinality(p_recipient_hashes), 0) > 0 THEN
      INSERT INTO public.outbound_send_events (workspace_id, inbox_id, kind, content_hash, recipient_hash)
      SELECT p_workspace_id, p_inbox_id, 'recipient', p_content_hash, r
        FROM (SELECT DISTINCT unnest(p_recipient_hashes) AS r) AS distinct_recipients
       WHERE r IS NOT NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('decision', 'allow');
END;
$$;

-- ── outbound_send_refusal ───────────────────────────────────────────────────
-- Count one provider spam/policy refusal for an inbox. The p_threshold-th
-- refusal inside p_window_ms pauses the inbox for p_pause_ms. Returns jsonb
-- { paused, newly_tripped, retry_at? }.
CREATE OR REPLACE FUNCTION public.outbound_send_refusal(
  p_workspace_id uuid,
  p_inbox_id     uuid,
  p_threshold    integer,
  p_window_ms    bigint,
  p_pause_ms     bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now    timestamptz := now();
  v_count  bigint;
  v_until  timestamptz;
  v_active timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outbound_send_gate:' || p_inbox_id::text, 0));

  INSERT INTO public.outbound_send_events (workspace_id, inbox_id, kind)
  VALUES (p_workspace_id, p_inbox_id, 'refusal');

  SELECT refusal_pause_until INTO v_active FROM public.inbox_send_brakes WHERE inbox_id = p_inbox_id;
  IF v_active IS NOT NULL AND v_active > v_now THEN
    RETURN jsonb_build_object('paused', true, 'newly_tripped', false, 'retry_at', v_active);
  END IF;

  SELECT count(*) INTO v_count FROM public.outbound_send_events
   WHERE inbox_id = p_inbox_id AND kind = 'refusal'
     AND created_at > v_now - (p_window_ms || ' milliseconds')::interval;
  IF v_count < p_threshold THEN
    RETURN jsonb_build_object('paused', false, 'newly_tripped', false);
  END IF;

  v_until := v_now + (p_pause_ms || ' milliseconds')::interval;
  INSERT INTO public.inbox_send_brakes (inbox_id, workspace_id, refusal_pause_until, updated_at)
  VALUES (p_inbox_id, p_workspace_id, v_until, v_now)
  ON CONFLICT (inbox_id) DO UPDATE
    SET refusal_pause_until = EXCLUDED.refusal_pause_until, updated_at = v_now;
  RETURN jsonb_build_object('paused', true, 'newly_tripped', true, 'retry_at', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.outbound_send_gate(uuid, uuid, integer, text, text[], integer, integer, bigint, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbound_send_refusal(uuid, uuid, integer, bigint, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_send_gate(uuid, uuid, integer, text, text[], integer, integer, bigint, boolean, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.outbound_send_refusal(uuid, uuid, integer, bigint, bigint)
  TO service_role;

-- ── Retention ───────────────────────────────────────────────────────────────
-- The longest window read is 24 hours. Keep two days, and drop brake rows
-- whose brakes both ended more than a day ago.
CREATE OR REPLACE FUNCTION public.purge_outbound_send_events()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_events bigint;
  v_brakes bigint;
BEGIN
  DELETE FROM public.outbound_send_events WHERE created_at < now() - interval '2 days';
  GET DIAGNOSTICS v_events = ROW_COUNT;
  DELETE FROM public.inbox_send_brakes
   WHERE COALESCE(fanout_hold_until, '-infinity') < now() - interval '1 day'
     AND COALESCE(refusal_pause_until, '-infinity') < now() - interval '1 day';
  GET DIAGNOSTICS v_brakes = ROW_COUNT;
  RETURN jsonb_build_object('outbound_send_events', v_events, 'inbox_send_brakes', v_brakes);
END;
$$;

REVOKE ALL ON FUNCTION public.purge_outbound_send_events() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'outbound-send-events-retention',
  '40 * * * *',
  $$SELECT public.purge_outbound_send_events()$$
);

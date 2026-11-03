-- ============================================================
-- Fan-out brake: hold only the tripping message, for one hour
--
-- Before: one normalized subject+body reaching more than 25 distinct
-- recipients within an hour held EVERY later send from the inbox until the end
-- of the UTC day, whatever its content. A customer running a small mail merge
-- had unrelated mail held for 14 hours with no visible reason.
--
-- Now:
--   * the hold applies only to sends with the content hash that tripped it
--     (inbox_send_brakes.fanout_content_hash); other mail goes out;
--   * it lasts one window (p_fanout_window_ms, an hour), not the UTC day;
--   * workspaces.fanout_recipient_limit, when set, replaces the default limit
--     for that workspace (an operator setting, set by hand);
--   * a hold answers reason = 'fanout' so the edge function can say why.
--
-- Same signature, so the edge function needs no deploy for the new behaviour.
-- Existing rows have no content hash and so hold nothing from here on.
-- ============================================================

ALTER TABLE public.inbox_send_brakes
  ADD COLUMN IF NOT EXISTS fanout_content_hash text
    CHECK (fanout_content_hash IS NULL OR fanout_content_hash ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.inbox_send_brakes.fanout_content_hash IS
  'SHA-256 of the normalized content that tripped the fan-out brake. Only sends '
  'with this hash are held while fanout_hold_until is in the future.';

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS fanout_recipient_limit integer
    CHECK (fanout_recipient_limit IS NULL OR fanout_recipient_limit > 0);

COMMENT ON COLUMN public.workspaces.fanout_recipient_limit IS
  'Operator override for the fan-out brake: distinct recipients one identical '
  'message may reach from one inbox within an hour. NULL uses the default in '
  'mcp-server/outbound-brakes.ts. Set by hand.';

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
  v_limit      integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outbound_send_gate:' || p_inbox_id::text, 0));

  SELECT sends_frozen_at, COALESCE(fanout_recipient_limit, p_fanout_limit)
    INTO v_frozen, v_limit
    FROM public.workspaces WHERE id = p_workspace_id;
  v_limit := COALESCE(v_limit, p_fanout_limit);
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
    -- Only the message that tripped the brake is held. Other mail from the
    -- inbox goes out. A row from before fanout_content_hash existed has no
    -- hash, so it holds nothing.
    IF v_brake.fanout_hold_until IS NOT NULL AND v_brake.fanout_hold_until > v_now
       AND p_content_hash IS NOT NULL AND v_brake.fanout_content_hash = p_content_hash THEN
      RETURN jsonb_build_object('decision', 'hold', 'reason', 'fanout', 'retry_at', v_brake.fanout_hold_until, 'newly_tripped', false);
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
      IF v_distinct > v_limit THEN
        -- Held for one window, the same span the count looks back over.
        v_hold_until := v_now + (p_fanout_window_ms || ' milliseconds')::interval;
        INSERT INTO public.inbox_send_brakes (inbox_id, workspace_id, fanout_hold_until, fanout_content_hash, updated_at)
        VALUES (p_inbox_id, p_workspace_id, v_hold_until, p_content_hash, v_now)
        ON CONFLICT (inbox_id) DO UPDATE
          SET fanout_hold_until = EXCLUDED.fanout_hold_until,
              fanout_content_hash = EXCLUDED.fanout_content_hash,
              updated_at = v_now;
        RETURN jsonb_build_object('decision', 'hold', 'reason', 'fanout', 'retry_at', v_hold_until, 'newly_tripped', true);
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

REVOKE ALL ON FUNCTION public.outbound_send_gate(uuid, uuid, integer, text, text[], integer, integer, bigint, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_send_gate(uuid, uuid, integer, text, text[], integer, integer, bigint, boolean, boolean)
  TO service_role;

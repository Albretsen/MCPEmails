-- ============================================================
-- Provider-refusal pause: count one message once
--
-- On 2026-11-12 an agent sent one draft three times in 26 seconds after the
-- provider refused it as spam, and the three refusals of that one message
-- paused the inbox. This adds a message key to outbound_send_refusal so a
-- repeat refusal of the same message inside the window is not counted again.
-- The five-argument version stays for the edge function deployed before this
-- one; drop it once no deployed code calls it.
-- ============================================================

-- ── outbound_send_refusal (with a message key) ─────────────────────────────
-- Same as the five-argument version, but one message refused several times
-- counts once. p_message_key is a SHA-256 hex digest of what identifies the
-- message (mcp-server/outbound-brakes.ts#refusalMessageKey): a draft id, a
-- forwarded message id plus recipients, or a subject, body and recipients.
-- A refusal whose key is already counted inside the window records nothing
-- and answers { paused, newly_tripped: false, duplicate: true }. A null key
-- counts every refusal, as before.
CREATE OR REPLACE FUNCTION public.outbound_send_refusal(
  p_workspace_id uuid,
  p_inbox_id     uuid,
  p_threshold    integer,
  p_window_ms    bigint,
  p_pause_ms     bigint,
  p_message_key  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now    timestamptz := now();
  v_window timestamptz := now() - (p_window_ms || ' milliseconds')::interval;
  v_count  bigint;
  v_until  timestamptz;
  v_active timestamptz;
  v_key    text := CASE WHEN p_message_key ~ '^[0-9a-f]{64}$' THEN p_message_key END;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outbound_send_gate:' || p_inbox_id::text, 0));

  SELECT refusal_pause_until INTO v_active FROM public.inbox_send_brakes WHERE inbox_id = p_inbox_id;

  IF v_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.outbound_send_events
     WHERE inbox_id = p_inbox_id AND kind = 'refusal' AND content_hash = v_key AND created_at > v_window
  ) THEN
    IF v_active IS NOT NULL AND v_active > v_now THEN
      RETURN jsonb_build_object('paused', true, 'newly_tripped', false, 'retry_at', v_active, 'duplicate', true);
    END IF;
    RETURN jsonb_build_object('paused', false, 'newly_tripped', false, 'duplicate', true);
  END IF;

  INSERT INTO public.outbound_send_events (workspace_id, inbox_id, kind, content_hash)
  VALUES (p_workspace_id, p_inbox_id, 'refusal', v_key);

  IF v_active IS NOT NULL AND v_active > v_now THEN
    RETURN jsonb_build_object('paused', true, 'newly_tripped', false, 'retry_at', v_active);
  END IF;

  SELECT count(*) INTO v_count FROM public.outbound_send_events
   WHERE inbox_id = p_inbox_id AND kind = 'refusal' AND created_at > v_window;
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

REVOKE ALL ON FUNCTION public.outbound_send_refusal(uuid, uuid, integer, bigint, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_send_refusal(uuid, uuid, integer, bigint, bigint, text)
  TO service_role;

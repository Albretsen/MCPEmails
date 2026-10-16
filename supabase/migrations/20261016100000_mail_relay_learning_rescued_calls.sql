-- Mail relay: rule 1 no longer counts calls the relay rescued as DIRECT
-- successes.
--
-- WHY. Rule 1 of 20261015200000 refuses to learn a host with 5 or more direct
-- successful calls in 7 days, and counted those in activity_log. A call the
-- relay fallback rescued is logged there as an ordinary success. So a host that
-- refuses our address on every connection, used by one active person, piled up
-- 5 "direct" successes within minutes of its first rescue, all of them through
-- the relay, and was refused before the second rescue 5 minutes later could
-- learn it. It would then pay a failed direct attempt on every call for good.
--
-- THE CHANGE, three parts:
--
--   1. Relayed successes are subtracted. mail_relay_stats counts every
--      connection the fallback carried (route 'fallback', outcome 'ok'). Those
--      are taken off the activity_log count for the same host, protocol and
--      window. Connections, not calls, so the subtraction can only err towards
--      learning, and rule 2 (a second rescue 5+ minutes later) still stands.
--   2. IMAP counts only tools that open IMAP. Signature, schedule, automation
--      and contact tools read our own tables and say nothing about the host.
--   3. A refused candidate keeps counting its rescues, so the board's "rescues"
--      column means what it says. Rule 2 is unchanged.
--
-- Signature and meaning of learn_mail_relay_host are unchanged.

CREATE OR REPLACE FUNCTION public.learn_mail_relay_host(
  p_host text,
  p_protocol text,
  p_reason text,
  p_runtime text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  c_max_direct_successes constant integer := 5;
  c_rescues_needed constant integer := 2;
  c_min_spread constant interval := interval '5 minutes';
  c_window constant interval := interval '7 days';
  c_learned_for constant interval := interval '30 days';
  c_send_tools constant text[] := ARRAY['email_send', 'email_reply', 'email_forward', 'draft_send', 'email_compose'];

  v_host text := lower(trim(p_host));
  v_known public.mail_relay_hosts%ROWTYPE;
  v_since timestamptz := now() - c_window;
  v_calls bigint;
  v_rescued bigint;
  v_ok bigint;
  v_candidate public.mail_relay_candidates%ROWTYPE;
BEGIN
  SELECT * INTO v_known FROM public.mail_relay_hosts WHERE host = v_host AND protocol = p_protocol;

  -- Still relayed (manual, or learned and not expired): nothing to decide.
  IF FOUND AND (v_known.source = 'manual' OR v_known.last_learned_at > now() - c_learned_for) THEN
    RETURN true;
  END IF;

  -- Calls made while an earlier learning was in force went through the relay.
  IF FOUND THEN
    v_since := GREATEST(v_since, v_known.last_learned_at + c_learned_for);
  END IF;

  SELECT count(*)
    INTO v_calls
    FROM public.activity_log a
    JOIN public.inboxes i ON i.id = a.inbox_id
   WHERE a.created_at > v_since
     AND a.status = 'success'
     AND CASE
           WHEN p_protocol = 'smtp' THEN
             lower(i.smtp_host) = v_host
             AND a.tool_name = ANY (c_send_tools)
           ELSE
             lower(i.imap_host) = v_host
             AND NOT (a.tool_name = ANY (c_send_tools))
             AND a.tool_name NOT LIKE 'signature\_%'
             AND a.tool_name NOT LIKE 'schedule\_%'
             AND a.tool_name NOT LIKE 'automation\_%'
             AND a.tool_name <> 'contact_search'
         END;

  -- Successes the relay carried are not evidence that the host works directly.
  SELECT COALESCE(sum(s.count), 0)
    INTO v_rescued
    FROM public.mail_relay_stats s
   WHERE s.host = v_host
     AND s.protocol = p_protocol
     AND s.route = 'fallback'
     AND s.outcome = 'ok'
     AND s.hour >= date_trunc('hour', v_since);

  v_ok := GREATEST(v_calls - v_rescued, 0);

  -- Rule 1: a host that works directly is never learned.
  IF v_ok >= c_max_direct_successes THEN
    INSERT INTO public.mail_relay_candidates AS c
      (host, protocol, rescues, last_reason, last_runtime, direct_successes, refused)
    VALUES (v_host, p_protocol, 1, left(p_reason, 300), p_runtime, v_ok, true)
    ON CONFLICT (host, protocol) DO UPDATE SET
      rescues = CASE WHEN c.first_rescue_at < now() - c_window THEN 1 ELSE c.rescues + 1 END,
      first_rescue_at = CASE WHEN c.first_rescue_at < now() - c_window THEN now() ELSE c.first_rescue_at END,
      last_rescue_at = now(),
      last_reason = EXCLUDED.last_reason,
      last_runtime = EXCLUDED.last_runtime,
      direct_successes = EXCLUDED.direct_successes,
      refused = true;
    RETURN false;
  END IF;

  -- Rule 2: count this rescue. Evidence older than the window starts over.
  INSERT INTO public.mail_relay_candidates AS c
    (host, protocol, rescues, last_reason, last_runtime, direct_successes, refused)
  VALUES (v_host, p_protocol, 1, left(p_reason, 300), p_runtime, v_ok, false)
  ON CONFLICT (host, protocol) DO UPDATE SET
    rescues = CASE WHEN c.first_rescue_at < now() - c_window THEN 1 ELSE c.rescues + 1 END,
    first_rescue_at = CASE WHEN c.first_rescue_at < now() - c_window THEN now() ELSE c.first_rescue_at END,
    last_rescue_at = now(),
    last_reason = EXCLUDED.last_reason,
    last_runtime = EXCLUDED.last_runtime,
    direct_successes = EXCLUDED.direct_successes,
    refused = false
  RETURNING * INTO v_candidate;

  IF v_candidate.rescues < c_rescues_needed OR v_candidate.last_rescue_at - v_candidate.first_rescue_at < c_min_spread THEN
    RETURN false;
  END IF;

  INSERT INTO public.mail_relay_hosts (host, protocol, source, reason, learned_by)
  VALUES (v_host, p_protocol, 'auto', left(p_reason, 300), p_runtime)
  ON CONFLICT (host, protocol) DO UPDATE SET
    last_learned_at = now(),
    times_learned = public.mail_relay_hosts.times_learned + 1,
    reason = EXCLUDED.reason,
    learned_by = EXCLUDED.learned_by;
  DELETE FROM public.mail_relay_candidates WHERE host = v_host AND protocol = p_protocol;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.learn_mail_relay_host(text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.learn_mail_relay_host(text, text, text, text)
  TO service_role;

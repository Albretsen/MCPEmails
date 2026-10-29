-- Mail relay: rule 1 counts automation runs as direct successes too.
--
-- WHY. Rule 1 (a host with 5 or more direct successes in 7 days is never
-- learned) counted only MCP tool calls in activity_log. Automation runs never
-- write activity_log, so a mailbox used mostly by its automations looked idle:
-- imap.rambler.ru (learned 2026-10-25) and mail.potsofjoy.co.nz (learned
-- 2026-10-26) had hundreds of direct automation runs a day and a handful of
-- tool calls, and two transient rescues learned them for 30 days.
--
-- THE CHANGE, two parts:
--
--   1. IMAP adds finished triage_runs on rules whose inbox uses the host.
--      'completed', 'completed_with_errors' and 'skipped' are only written
--      after the provider search returned (triage-engine.ts: every failure
--      before or during the search ends 'failed'), so each one is a real IMAP
--      connection that worked. 'failed' and 'running' are not counted.
--   2. The subtraction now also takes off relay connections on the 'learned'
--      route, not only 'fallback'. While a host is learned, v_since already
--      skips that window; this matters when a learned row is deleted by hand,
--      when the runs it carried would otherwise count as direct.
--
-- Not counted, and why: reminder reply checks keep only last_checked_at (no
-- per-check count), and client-api (the private web client) writes no log.
-- Both are small next to automations.
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

  -- Unattended IMAP work: automation runs that got past the provider search.
  IF p_protocol = 'imap' THEN
    SELECT v_calls + count(*)
      INTO v_calls
      FROM public.triage_runs r
      JOIN public.triage_rules t ON t.id = r.rule_id
      JOIN public.inboxes i ON i.id = t.inbox_id
     WHERE r.started_at > v_since
       AND r.status IN ('completed', 'completed_with_errors', 'skipped')
       AND lower(i.imap_host) = v_host;
  END IF;

  -- Successes the relay carried are not evidence that the host works directly.
  SELECT COALESCE(sum(s.count), 0)
    INTO v_rescued
    FROM public.mail_relay_stats s
   WHERE s.host = v_host
     AND s.protocol = p_protocol
     AND s.route IN ('fallback', 'learned')
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

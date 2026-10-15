-- Mail relay: a stricter rule for LEARNING a host.
--
-- WHY. On 2026-10-15, three hours after 20261015180000 shipped, the registry
-- learned exchange.ionos.eu. That host works directly: one inbox on it had 82
-- successful calls that week. One direct IMAP connection dropped mid-session
-- ("unexpected end of file"), the relay retry worked, and the old gate let the
-- host through because it compared successes with FAILURES, and two other
-- inboxes in the same workspace had been failing with wrong passwords since
-- 10-12 (172 failures). Bad passwords made a working host look blocked.
--
-- THE NEW RULE, both parts required:
--
--   1. Successes only. A host with 5 or more DIRECT successful calls for the
--      protocol in the last 7 days is never learned, whatever its failures. A
--      host that refuses our address refuses every inbox on it, so successes
--      are proof it is not doing that. Failures prove nothing: wrong passwords,
--      full mailboxes and client mistakes all fail. Measured: Orange and
--      Telstra submission 0, Domeneshop submission about 2 a week before it was
--      relayed, exchange.ionos.eu 82, Yahoo tens of thousands. Successes are
--      counted only since an earlier learning of the same host expired, so the
--      calls it made THROUGH the relay are never mistaken for direct ones.
--   2. Repeated evidence. One relay rescue makes a host a CANDIDATE
--      (mail_relay_candidates). It is learned only at the second rescue, at
--      least 5 minutes after the first and within 7 days. A dropped connection
--      is one moment; a host that refuses our address fails every time.
--
-- Nothing is lost for a host that is not learned: every failed call still
-- gets its own relay retry. Learning only saves the failed direct attempt.
--
-- learn_mail_relay_host keeps its signature and meaning (true = the host is now
-- relayed), so the edge function and the web app need no change for the rule.
-- growth_mail_relay_hosts gains the candidate columns for /admin/growth.

CREATE TABLE IF NOT EXISTS public.mail_relay_candidates (
  host text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('imap', 'smtp')),
  rescues integer NOT NULL DEFAULT 1,
  first_rescue_at timestamptz NOT NULL DEFAULT now(),
  last_rescue_at timestamptz NOT NULL DEFAULT now(),
  last_reason text,
  last_runtime text CHECK (last_runtime IS NULL OR last_runtime IN ('web', 'edge')),
  -- Direct successes counted at the last rescue, and whether rule 1 refused it.
  direct_successes integer NOT NULL DEFAULT 0,
  refused boolean NOT NULL DEFAULT false,
  PRIMARY KEY (host, protocol)
);

COMMENT ON TABLE public.mail_relay_candidates IS
  'Hosts the relay rescued once (or that rule 1 refused): learned into mail_relay_hosts only at a second rescue 5+ minutes after the first, and never with 5+ direct successes in 7 days. Service-role only.';

ALTER TABLE public.mail_relay_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_relay_candidates FROM anon, authenticated;

-- Rule thresholds, named once.
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

  v_host text := lower(trim(p_host));
  v_known public.mail_relay_hosts%ROWTYPE;
  v_since timestamptz := now() - c_window;
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
    INTO v_ok
    FROM public.activity_log a
    JOIN public.inboxes i ON i.id = a.inbox_id
   WHERE a.created_at > v_since
     AND a.status = 'success'
     AND CASE
           WHEN p_protocol = 'smtp' THEN
             lower(i.smtp_host) = v_host
             AND a.tool_name IN ('email_send', 'email_reply', 'email_forward', 'draft_send', 'email_compose')
           ELSE
             lower(i.imap_host) = v_host
             AND a.tool_name NOT IN ('email_send', 'email_reply', 'email_forward', 'draft_send', 'email_compose')
         END;

  -- Rule 1: a host that works directly is never learned.
  IF v_ok >= c_max_direct_successes THEN
    INSERT INTO public.mail_relay_candidates AS c
      (host, protocol, rescues, last_reason, last_runtime, direct_successes, refused)
    VALUES (v_host, p_protocol, 1, left(p_reason, 300), p_runtime, v_ok, true)
    ON CONFLICT (host, protocol) DO UPDATE SET
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

-- ---------------------------------------------------------------------------
-- The board reader gains the candidate state. Its row type changes, so it is
-- dropped and recreated.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.growth_mail_relay_hosts(integer);

CREATE FUNCTION public.growth_mail_relay_hosts(p_days integer)
RETURNS TABLE (
  host text,
  protocol text,
  learned boolean,
  learned_source text,
  first_learned_at timestamptz,
  learned_expires_at timestamptz,
  candidate_rescues integer,
  candidate_refused boolean,
  candidate_direct_successes integer,
  routes text,
  connections bigint,
  ok bigint,
  relay_down bigint,
  host_refused bigint,
  avg_ms integer,
  last_at timestamptz,
  last_failure_at timestamptz,
  last_failure text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH s AS (
    SELECT * FROM public.mail_relay_stats
     WHERE hour >= date_trunc('hour', now()) - make_interval(days => GREATEST(p_days, 1))
  ),
  keys AS (
    SELECT DISTINCT s.host, s.protocol FROM s
    UNION
    SELECT h.host, h.protocol FROM public.mail_relay_hosts h
     WHERE h.source = 'manual' OR h.last_learned_at > now() - interval '30 days'
    UNION
    SELECT c.host, c.protocol FROM public.mail_relay_candidates c
     WHERE c.last_rescue_at > now() - make_interval(days => GREATEST(p_days, 1))
  )
  SELECT
    k.host,
    k.protocol,
    (h.host IS NOT NULL AND (h.source = 'manual' OR h.last_learned_at > now() - interval '30 days')) AS learned,
    h.source,
    h.first_learned_at,
    CASE WHEN h.source = 'auto' THEN h.last_learned_at + interval '30 days' END,
    c.rescues,
    c.refused,
    c.direct_successes,
    (SELECT string_agg(DISTINCT s2.route, ',' ORDER BY s2.route) FROM s s2
      WHERE s2.host = k.host AND s2.protocol = k.protocol),
    COALESCE(sum(s.count), 0)::bigint,
    COALESCE(sum(s.count) FILTER (WHERE s.outcome = 'ok'), 0)::bigint,
    COALESCE(sum(s.count) FILTER (WHERE s.outcome = 'relay_down'), 0)::bigint,
    COALESCE(sum(s.count) FILTER (WHERE s.outcome = 'host_refused'), 0)::bigint,
    CASE WHEN sum(s.count) > 0 THEN (sum(s.total_ms) / sum(s.count))::integer END,
    max(s.last_at),
    max(s.last_at) FILTER (WHERE s.outcome <> 'ok'),
    (SELECT s3.last_detail FROM s s3
      WHERE s3.host = k.host AND s3.protocol = k.protocol AND s3.outcome <> 'ok'
      ORDER BY s3.last_at DESC LIMIT 1)
  FROM keys k
  LEFT JOIN s ON s.host = k.host AND s.protocol = k.protocol
  LEFT JOIN public.mail_relay_hosts h ON h.host = k.host AND h.protocol = k.protocol
  LEFT JOIN public.mail_relay_candidates c ON c.host = k.host AND c.protocol = k.protocol
  GROUP BY k.host, k.protocol, h.host, h.source, h.first_learned_at, h.last_learned_at,
           c.rescues, c.refused, c.direct_successes
  ORDER BY COALESCE(sum(s.count), 0) DESC, k.host, k.protocol;
$fn$;

REVOKE ALL ON FUNCTION public.growth_mail_relay_hosts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_mail_relay_hosts(integer) TO service_role;

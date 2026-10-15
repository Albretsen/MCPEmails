-- Mail relay registry: hosts that learned to need the relay, and a count of
-- every connection the relay carried.
--
-- WHY. Some mail hosts refuse connections from our AWS egress (Domeneshop
-- submission, Orange sign-in). Until now each one went on a hand-kept list in
-- code after a customer wrote in. A 2026-10-15 sweep found others nobody
-- reported (Telstra submission timed out 15 times for two workspaces, both of
-- which settled for receive-only). Now a direct connection that fails in a way
-- a different address can fix is retried once through the relay, and a host
-- where that works is remembered here, so the web app and the edge function
-- both relay it from then on. See supabase/functions/mcp-server/relay-registry.ts
-- and apps/web/src/lib/email/relay-fallback.ts.
--
-- WHAT.
--   mail_relay_hosts  one row per (host, protocol) that needs the relay. A
--                     learned row is honoured for 30 days from last_learned_at
--                     (the readers apply that), after which the host is tried
--                     directly again and re-learned if it still needs it.
--   mail_relay_stats  hourly counters per (runtime, protocol, host, route,
--                     outcome), plus the last failure text. Bounded by the
--                     number of relayed hosts, so it needs no purge job; the
--                     writer trims rows older than 120 days on its own.
--
-- No credential, address or message content is stored: host names, counts and
-- a server's refusal text with the credential already redacted by the caller.
--
-- Service role only, like draft_lineage. The app tolerates this migration
-- being unapplied: every read and write is best-effort and logged.

CREATE TABLE IF NOT EXISTS public.mail_relay_hosts (
  host text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('imap', 'smtp')),
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  -- The direct failure that taught it, as the runtime described it.
  reason text,
  learned_by text CHECK (learned_by IS NULL OR learned_by IN ('web', 'edge')),
  first_learned_at timestamptz NOT NULL DEFAULT now(),
  last_learned_at timestamptz NOT NULL DEFAULT now(),
  times_learned integer NOT NULL DEFAULT 1,
  PRIMARY KEY (host, protocol),
  CONSTRAINT mail_relay_hosts_host_shape CHECK (host ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$')
);

COMMENT ON TABLE public.mail_relay_hosts IS
  'Mail hosts reached through the non-AWS relay because a direct connection failed and a relayed one worked. auto rows expire 30 days after last_learned_at (readers apply it) and are re-learned if still needed. Service-role only.';

ALTER TABLE public.mail_relay_hosts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_relay_hosts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mail_relay_stats (
  hour timestamptz NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('web', 'edge')),
  protocol text NOT NULL CHECK (protocol IN ('imap', 'smtp')),
  host text NOT NULL,
  route text NOT NULL CHECK (route IN ('listed', 'learned', 'fallback')),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'relay_down', 'host_refused')),
  count integer NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  last_detail text,
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hour, runtime, protocol, host, route, outcome)
);

CREATE INDEX IF NOT EXISTS mail_relay_stats_last_at_idx ON public.mail_relay_stats (last_at);

COMMENT ON TABLE public.mail_relay_stats IS
  'Hourly counters of connections carried by the mail relay: listed (hand-kept list), learned (mail_relay_hosts) or fallback (one retry after a direct failure); ok, relay_down or host_refused. Service-role only.';

ALTER TABLE public.mail_relay_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_relay_stats FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- record_mail_relay_use: count one relayed connection.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_mail_relay_use(
  p_runtime text,
  p_protocol text,
  p_host text,
  p_route text,
  p_outcome text,
  p_ms integer,
  p_detail text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  INSERT INTO public.mail_relay_stats AS s
    (hour, runtime, protocol, host, route, outcome, count, total_ms, last_detail, last_at)
  VALUES (
    date_trunc('hour', now()), p_runtime, p_protocol, lower(p_host), p_route, p_outcome,
    1, GREATEST(COALESCE(p_ms, 0), 0), left(p_detail, 300), now()
  )
  ON CONFLICT (hour, runtime, protocol, host, route, outcome) DO UPDATE SET
    count = s.count + 1,
    total_ms = s.total_ms + GREATEST(COALESCE(p_ms, 0), 0),
    last_detail = COALESCE(left(EXCLUDED.last_detail, 300), s.last_detail),
    last_at = now();

  -- Self-trimming, about once in two hundred writes. Cheap: the table holds a
  -- handful of rows per relayed host per hour.
  IF random() < 0.005 THEN
    DELETE FROM public.mail_relay_stats WHERE last_at < now() - interval '120 days';
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_mail_relay_use(text, text, text, text, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_mail_relay_use(text, text, text, text, text, integer, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- learn_mail_relay_host: remember that a host needs the relay.
--
-- Returns true when the host is (now) relayed, false when it was refused.
--
-- THE GATE. A lucky relay retry after a one-off network blip must not move a
-- big provider's traffic onto the relay: imap.mail.yahoo.com alone carries
-- 120k+ calls a month and has a few network failures a day. So a host that is
-- NOT already known is only learned when, over the last seven days, it has not
-- been working directly: fewer than 20 successful calls, or a success rate
-- below one half. The hosts this exists for score 0 (Orange, Telstra
-- submission) or about 15 percent (Domeneshop submission); Yahoo scores 99.
-- A host already in the table (re-learned after expiry, or entered by hand) is
-- refreshed without the gate: its successes since then went THROUGH the relay.
-- ---------------------------------------------------------------------------
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
  v_host text := lower(trim(p_host));
  v_ok bigint;
  v_failed bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM public.mail_relay_hosts WHERE host = v_host AND protocol = p_protocol) THEN
    UPDATE public.mail_relay_hosts
       SET last_learned_at = now(),
           times_learned = times_learned + 1,
           reason = COALESCE(left(p_reason, 300), reason),
           learned_by = p_runtime
     WHERE host = v_host AND protocol = p_protocol;
    RETURN true;
  END IF;

  SELECT count(*) FILTER (WHERE a.status = 'success'),
         count(*) FILTER (WHERE a.status <> 'success')
    INTO v_ok, v_failed
    FROM public.activity_log a
    JOIN public.inboxes i ON i.id = a.inbox_id
   WHERE a.created_at > now() - interval '7 days'
     AND CASE
           WHEN p_protocol = 'smtp' THEN
             lower(i.smtp_host) = v_host
             AND a.tool_name IN ('email_send', 'email_reply', 'email_forward', 'draft_send', 'email_compose')
           ELSE
             lower(i.imap_host) = v_host
             AND a.tool_name NOT IN ('email_send', 'email_reply', 'email_forward', 'draft_send', 'email_compose')
         END;

  IF v_ok >= 20 AND v_ok > v_failed THEN
    RETURN false;
  END IF;

  INSERT INTO public.mail_relay_hosts (host, protocol, source, reason, learned_by)
  VALUES (v_host, p_protocol, 'auto', left(p_reason, 300), p_runtime)
  ON CONFLICT (host, protocol) DO UPDATE SET
    last_learned_at = now(),
    times_learned = public.mail_relay_hosts.times_learned + 1;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.learn_mail_relay_host(text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.learn_mail_relay_host(text, text, text, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Readers for /admin/growth.
-- ---------------------------------------------------------------------------

-- One row per relayed host and protocol over the window, learned or not.
CREATE OR REPLACE FUNCTION public.growth_mail_relay_hosts(p_days integer)
RETURNS TABLE (
  host text,
  protocol text,
  learned boolean,
  learned_source text,
  first_learned_at timestamptz,
  learned_expires_at timestamptz,
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
  )
  SELECT
    k.host,
    k.protocol,
    (h.host IS NOT NULL AND (h.source = 'manual' OR h.last_learned_at > now() - interval '30 days')) AS learned,
    h.source,
    h.first_learned_at,
    CASE WHEN h.source = 'auto' THEN h.last_learned_at + interval '30 days' END,
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
  GROUP BY k.host, k.protocol, h.host, h.source, h.first_learned_at, h.last_learned_at
  ORDER BY COALESCE(sum(s.count), 0) DESC, k.host, k.protocol;
$fn$;

-- Daily totals over the window, every day present (zero-filled).
CREATE OR REPLACE FUNCTION public.growth_mail_relay_daily(p_days integer)
RETURNS TABLE (
  day date,
  ok bigint,
  relay_down bigint,
  host_refused bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT
    d::date,
    COALESCE(sum(s.count) FILTER (WHERE s.outcome = 'ok'), 0)::bigint,
    COALESCE(sum(s.count) FILTER (WHERE s.outcome = 'relay_down'), 0)::bigint,
    COALESCE(sum(s.count) FILTER (WHERE s.outcome = 'host_refused'), 0)::bigint
  FROM generate_series(
         (now() AT TIME ZONE 'utc')::date - (GREATEST(p_days, 1) - 1),
         (now() AT TIME ZONE 'utc')::date,
         interval '1 day'
       ) AS d
  LEFT JOIN public.mail_relay_stats s
    ON (s.hour AT TIME ZONE 'utc')::date = d::date
  GROUP BY d
  ORDER BY d;
$fn$;

REVOKE ALL ON FUNCTION public.growth_mail_relay_hosts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_mail_relay_hosts(integer) TO service_role;
REVOKE ALL ON FUNCTION public.growth_mail_relay_daily(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_mail_relay_daily(integer) TO service_role;

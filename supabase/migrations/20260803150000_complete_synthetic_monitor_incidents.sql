-- Atomic incident transitions for the synthetic monitor. All persisted values
-- are controlled identifiers; notification payloads never enter these tables.
CREATE OR REPLACE FUNCTION public.record_synthetic_monitor_failure(
  p_run_id uuid,
  p_failure_class text,
  p_failed_step text,
  p_fingerprint text
)
RETURNS TABLE (id uuid, fingerprint text, should_alert boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_incident public.synthetic_monitor_incidents;
  v_previous_fingerprint text;
  v_consecutive integer;
  v_immediate boolean;
BEGIN
  -- Serialize updates for one failure path, including an insert race.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_fingerprint, 0));
  SELECT failure_fingerprint INTO v_previous_fingerprint
  FROM public.synthetic_monitor_runs
  WHERE synthetic_monitor_runs.id <> p_run_id AND synthetic_monitor_runs.status <> 'running'
  ORDER BY synthetic_monitor_runs.started_at DESC LIMIT 1;
  SELECT * INTO v_incident FROM public.synthetic_monitor_incidents WHERE synthetic_monitor_incidents.fingerprint = p_fingerprint FOR UPDATE;
  v_consecutive := CASE
    WHEN v_previous_fingerprint = p_fingerprint AND FOUND AND v_incident.status = 'open' THEN v_incident.consecutive_failures + 1
    WHEN v_previous_fingerprint = p_fingerprint THEN 2
    ELSE 1
  END;
  IF NOT FOUND THEN
    INSERT INTO public.synthetic_monitor_incidents (fingerprint, failure_class, failed_step, consecutive_failures, last_run_id)
    VALUES (p_fingerprint, p_failure_class, p_failed_step, v_consecutive, p_run_id)
    RETURNING * INTO v_incident;
  ELSIF v_incident.status = 'resolved' THEN
    UPDATE public.synthetic_monitor_incidents SET status = 'open', resolved_at = NULL, first_failure_at = now(), last_failure_at = now(),
      consecutive_failures = v_consecutive, incident_alerted_at = NULL, recovery_alerted_at = NULL, last_run_id = p_run_id, updated_at = now()
    WHERE synthetic_monitor_incidents.id = v_incident.id RETURNING * INTO v_incident;
  ELSE
    UPDATE public.synthetic_monitor_incidents SET last_failure_at = now(), consecutive_failures = v_consecutive,
      last_run_id = p_run_id, updated_at = now()
    WHERE synthetic_monitor_incidents.id = v_incident.id RETURNING * INTO v_incident;
  END IF;
  v_immediate := p_failure_class IN ('authentication', 'mcp_protocol', 'internal');
  RETURN QUERY SELECT v_incident.id, v_incident.fingerprint,
    v_incident.incident_alerted_at IS NULL AND (v_immediate OR v_incident.consecutive_failures >= 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_synthetic_monitor_incidents(p_run_id uuid)
RETURNS TABLE (id uuid, fingerprint text, should_recover boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH resolved AS (
    UPDATE public.synthetic_monitor_incidents
    SET status = 'resolved', resolved_at = now(), last_run_id = p_run_id, updated_at = now()
    WHERE status = 'open'
       OR (status = 'resolved' AND incident_alerted_at IS NOT NULL AND recovery_alerted_at IS NULL)
    RETURNING synthetic_monitor_incidents.id, synthetic_monitor_incidents.fingerprint,
      synthetic_monitor_incidents.incident_alerted_at IS NOT NULL AND synthetic_monitor_incidents.recovery_alerted_at IS NULL AS should_recover
  ) SELECT * FROM resolved;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_synthetic_monitor_incident_alerted(p_incident_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  UPDATE public.synthetic_monitor_incidents SET incident_alerted_at = COALESCE(incident_alerted_at, now()), updated_at = now() WHERE id = p_incident_id;
$$;

CREATE OR REPLACE FUNCTION public.mark_synthetic_monitor_recovery_alerted(p_incident_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  UPDATE public.synthetic_monitor_incidents SET recovery_alerted_at = COALESCE(recovery_alerted_at, now()), updated_at = now() WHERE id = p_incident_id;
$$;

REVOKE ALL ON FUNCTION public.record_synthetic_monitor_failure(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_synthetic_monitor_incidents(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_synthetic_monitor_incident_alerted(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_synthetic_monitor_recovery_alerted(uuid) FROM PUBLIC, anon, authenticated;

-- Replace the prior one-argument function.  The default keeps the cron calls
-- exactly `public.invoke_synthetic_monitor('read')`.
DROP FUNCTION IF EXISTS public.invoke_synthetic_monitor(text);

-- The optional flag is only sent by an authenticated, manual production test.
CREATE OR REPLACE FUNCTION public.invoke_synthetic_monitor(mode text, controlled_failure boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
BEGIN
  IF mode <> 'read' THEN RAISE EXCEPTION 'unsupported monitor mode'; END IF;
  PERFORM net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'synthetic_monitor_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Synthetic-Monitor-Token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'synthetic_monitor_token')),
    body := jsonb_build_object('mode', mode, 'controlled_failure', controlled_failure)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_synthetic_monitor(text, boolean) FROM PUBLIC, anon, authenticated;

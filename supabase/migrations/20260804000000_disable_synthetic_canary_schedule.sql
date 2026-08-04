-- Stop the legacy outbound canary schedule. Routine health checks remain
-- read-only; only incident and recovery notifications send email.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mcp-synthetic-send-every-15m') THEN
    PERFORM cron.unschedule('mcp-synthetic-send-every-15m');
  END IF;
END;
$$;

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
    body := jsonb_build_object('mode', 'read', 'controlled_failure', controlled_failure)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_synthetic_monitor(text, boolean) FROM PUBLIC, anon, authenticated;

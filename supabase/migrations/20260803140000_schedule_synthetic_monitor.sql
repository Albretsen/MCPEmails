-- Invoke the protected synthetic-monitor Edge Function from pg_cron.
-- Vault values are provisioned outside source control so no scheduler token is
-- ever committed to this repository.
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.invoke_synthetic_monitor(mode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
BEGIN
  IF mode <> 'read' THEN RAISE EXCEPTION 'unsupported monitor mode'; END IF;
  PERFORM net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'synthetic_monitor_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Synthetic-Monitor-Token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'synthetic_monitor_token')
    ),
    body := jsonb_build_object('mode', mode)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_synthetic_monitor(text) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('mcp-synthetic-read-every-5m', '*/5 * * * *', $$SELECT public.invoke_synthetic_monitor('read')$$);

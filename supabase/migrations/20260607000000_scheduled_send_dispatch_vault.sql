-- ============================================================
-- MCPEmails — Re-architect scheduled-send dispatcher to use Vault
-- 20260607000000_scheduled_send_dispatch_vault
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The original dispatcher (migration 20260603000001) read its runtime
-- config from database GUCs:
--
--     current_setting('app.mcp_server_url')
--     current_setting('app.dispatch_secret')
--
-- Setting those values requires `ALTER DATABASE postgres SET ...`, which
-- requires the `superuser` role. On Supabase the project `postgres` role
-- is NOT a superuser, so neither the dashboard SQL editor nor the CLI can
-- run that ALTER DATABASE (it fails with `42501: permission denied to set
-- parameter`). The GUC approach is therefore a dead end.
--
-- NEW APPROACH: Supabase Vault.
--   • The dispatch base URL is PUBLIC (it is just the Edge Function URL),
--     so it is hardcoded directly in the function below.
--   • The dispatch secret is read at call time from `vault.decrypted_secrets`
--     where name = 'dispatch_secret'. Vault is writable by the regular
--     `postgres` role — no superuser required.
--
-- THE SECRET IS NEVER STORED IN THIS FILE.
--   The secret value is inserted ONCE via a one-off remote SQL statement
--   (vault.create_secret(...)) run directly against the remote DB, kept out
--   of git. This migration only CREATES the dependency on the named secret
--   and REWRITES the function. If the secret has not been created the
--   function raises a WARNING and skips (the cron job keeps running).
--
-- The Edge Function checks the incoming `X-Dispatch-Secret` header against
-- its `DISPATCH_SECRET` env var with an exact string match, and the URL it
-- expects is the BASE mcp-server URL (the function appends `/dispatch`).
-- See supabase/functions/mcp-server/index.ts (handleScheduledDispatch /
-- the `reqUrl.pathname.endsWith("/dispatch")` route).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- ── Rewritten dispatcher ──────────────────────────────────────────────────
-- Reads the dispatch secret from Vault; hardcodes the public base URL.
CREATE OR REPLACE FUNCTION public.dispatch_scheduled_sends()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function.
  -- The /dispatch route validates the X-Dispatch-Secret header.
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
  v_secret text;
BEGIN
  -- Read the dispatch secret from Vault. Wrapped in a sub-block so that a
  -- missing secret (or an inaccessible vault) downgrades to a WARNING +
  -- skip rather than raising and tripping the pg_cron run into an error.
  BEGIN
    SELECT decrypted_secret
      INTO v_secret
      FROM vault.decrypted_secrets
     WHERE name = 'dispatch_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'dispatch_scheduled_sends: Vault secret "dispatch_secret" is not set — skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$$;

COMMENT ON FUNCTION public.dispatch_scheduled_sends() IS
  'Called by pg_cron every minute. Posts to the mcp-server /dispatch route '
  'so the Edge Function can pick up and send pending scheduled_sends rows. '
  'Base URL is hardcoded (public); the dispatch secret is read from Vault '
  '(vault.decrypted_secrets WHERE name=''dispatch_secret''). The secret is '
  'created out-of-git via a one-off vault.create_secret() statement.';

-- ── Re-assert the cron schedule (idempotent) ──────────────────────────────
-- cron.schedule replaces any existing job of the same name, so re-running
-- this migration is safe and keeps the every-minute cadence intact.
SELECT cron.schedule(
  'dispatch-scheduled-sends',
  '* * * * *',
  'SELECT public.dispatch_scheduled_sends()'
);

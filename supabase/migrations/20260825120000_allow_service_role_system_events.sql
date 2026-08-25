-- ============================================================
-- Let the Edge Functions emit system events
--
-- WHY THIS GRANT EXISTS
-- --------------------
-- public.emit_system_event() was introduced by
-- 20260805170000_add_system_event_notifications.sql for exactly one caller:
-- the handle_new_user() signup trigger, which runs as the definer. Its
-- REVOKE ALL ... FROM PUBLIC, anon, authenticated therefore also took EXECUTE
-- away from service_role, which was harmless while a trigger was the only
-- caller and is not harmless now.
--
-- The unattended triage runner (mcp-server/triage-engine.ts) needs to announce
-- that an automation has switched itself off after 5 consecutive failed runs.
-- Before this, that auto-disable was completely SILENT: one customer's rules
-- failed 134 times over four days, five of them switched themselves off, and
-- nobody was told by any channel. The runner is an Edge Function holding the
-- service-role key, so it needs EXECUTE to reach the same notification
-- pipeline the signup event already uses, rather than growing a second one.
--
-- Scope of the grant: service_role ONLY. anon and authenticated stay revoked,
-- because emit_system_event is SECURITY DEFINER and fires an outbound pg_net
-- request; a browser must never be able to call it.
-- ============================================================

GRANT EXECUTE ON FUNCTION public.emit_system_event(text, jsonb) TO service_role;

-- The event types the pipeline now carries. Documented on the table so the
-- set is discoverable from the schema rather than only from the Edge Function
-- that renders each one (see supabase/functions/system-notify/index.ts).
COMMENT ON COLUMN public.system_events.event_type IS
  'Event name the system-notify Edge Function renders a template for. Known values: '
  '''user.signup'' (a new user was provisioned) and ''automation.auto_disabled'' '
  '(a triage_rules row switched itself off after 5 consecutive failed runs). '
  'An event_type with no matching template is recorded and marked failed, never delivered.';

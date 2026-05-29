-- Add new operator scopes to the allow-list for first-party OAuth clients.
--
-- New scopes added:
--   delete:email     — hard-delete and trash operations (confirm-gated)
--   manage:contacts  — contact search and lookup
--   schedule:email   — send scheduling
--
-- manage:drafts and manage:folders were already present in all first-party
-- client records from migration 20260525210003_register_claude_clients.sql
-- and 20260525130000_oauth_clients_and_auth_codes.sql; they are omitted here
-- to keep this migration idempotent.
--
-- Idempotent: array_append only adds a scope if it is not already present
-- (using array_cat + DISTINCT via the sub-select). Running this migration
-- twice leaves the scopes_allowed unchanged on the second run.

DO $$
DECLARE
  new_scopes text[] := ARRAY['delete:email', 'manage:contacts', 'schedule:email'];
  scope      text;
  cid        text;
BEGIN
  FOREACH cid IN ARRAY ARRAY['claude-ai-web', 'claude-code', 'claude-desktop']
  LOOP
    FOREACH scope IN ARRAY new_scopes
    LOOP
      UPDATE public.oauth_clients
      SET    scopes_allowed = array_append(scopes_allowed, scope)
      WHERE  client_id = cid
        AND  NOT (scopes_allowed @> ARRAY[scope]);
    END LOOP;
  END LOOP;
END;
$$;

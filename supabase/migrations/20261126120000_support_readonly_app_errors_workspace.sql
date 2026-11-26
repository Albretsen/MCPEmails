-- ============================================================
-- support_readonly.app_errors gains workspace_id (Pelset PEL-724)
-- ============================================================
-- A support agent answering a "could not connect" report needs the failed
-- attempts of the sender's own workspace, including a first connection that
-- failed before any inbox row existed. public.app_errors has no workspace
-- column; the routes that know the workspace put it in `context` as
-- `workspaceId` (most callers) or `workspace_id` (a few). This view exposes
-- that one value, as a uuid, and nothing else from `context`.
--
-- Appended as the last column (CREATE OR REPLACE VIEW cannot reorder).
-- A value that is not a well-formed uuid becomes NULL, so a stray string in
-- `context` can never make a read of the view fail.
--
-- Still left out on purpose: stack, and the rest of context (detail can hold
-- a sanitized server rejection; other keys may hold anything).
--
-- Secret-column check (run as postgres; must return no rows), unchanged from
-- 20261125120000 and also in supabase/tests/support_readonly_views.sql:
--
--   select table_name, column_name
--   from information_schema.columns
--   where table_schema = 'support_readonly'
--     and (column_name ~* '(token|secret|password|passw|oauth|hash|cipher|payload|lease|nonce|verifier|session|stack|body|ip_address|user_agent)'
--          or (column_name ~* 'key' and column_name not in ('api_key_id', 'key_prefix')));
-- ============================================================

create or replace view support_readonly.app_errors as
  select id, created_at, severity, message, resolved_at,
         case
           when coalesce(context->>'workspaceId', context->>'workspace_id')
                ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then coalesce(context->>'workspaceId', context->>'workspace_id')::uuid
         end as workspace_id
  from public.app_errors;

revoke all on support_readonly.app_errors from public, anon, authenticated, service_role;
grant select on support_readonly.app_errors to support_readonly;

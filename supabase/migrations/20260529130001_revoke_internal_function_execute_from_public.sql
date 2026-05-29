-- Functions are granted EXECUTE to PUBLIC by default; anon/authenticated
-- inherit that. Revoke from PUBLIC so these internal trigger/cron functions
-- are not exposed on the PostgREST RPC surface at all.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ensure_activity_log_partitions(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_workspace_invites() FROM PUBLIC;

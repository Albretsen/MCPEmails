-- Reconstructed from the remote migration ledger.
--
-- This migration was applied directly to production by another session
-- without leaving a local file, which left `supabase migration list` showing
-- a remote version with no local counterpart and would have blocked the next
-- `db push`. The body below is the exact statement recorded in
-- supabase_migrations.schema_migrations for version 20260819180721, so this
-- file only restores the record; it changes nothing that is already live.

CREATE OR REPLACE FUNCTION public.growth_public_tool_name(p_tool_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_tool_name
    WHEN 'email_list' THEN 'email_read'
    WHEN 'email_read' THEN 'email_read'
    WHEN 'email_read_batch' THEN 'email_read'
    WHEN 'email_search' THEN 'email_read'
    WHEN 'email_attachment' THEN 'email_read'
    WHEN 'email_extract' THEN 'email_read'
    WHEN 'email_original' THEN 'email_read'
    WHEN 'email_move' THEN 'email_organize'
    WHEN 'email_move_batch' THEN 'email_organize'
    WHEN 'email_copy' THEN 'email_organize'
    WHEN 'email_copy_batch' THEN 'email_organize'
    WHEN 'email_flag' THEN 'email_organize'
    WHEN 'email_archive' THEN 'email_organize'
    WHEN 'email_search_and_move' THEN 'email_organize'
    WHEN 'email_delete' THEN 'email_delete'
    WHEN 'email_delete_batch' THEN 'email_delete'
    WHEN 'email_search_and_delete' THEN 'email_delete'
    WHEN 'email_send' THEN 'email_compose'
    WHEN 'email_reply' THEN 'email_compose'
    WHEN 'email_forward' THEN 'email_compose'
    WHEN 'folder_list' THEN 'folder_list'
    WHEN 'folder_create' THEN 'folder_manage'
    WHEN 'folder_rename' THEN 'folder_manage'
    WHEN 'folder_delete' THEN 'folder_delete'
    WHEN 'folder' THEN 'folder'
    WHEN 'draft_list' THEN 'draft_list'
    WHEN 'draft_create' THEN 'draft_write'
    WHEN 'draft_reply' THEN 'draft_write'
    WHEN 'draft_update' THEN 'draft_write'
    WHEN 'draft_send' THEN 'draft_write'
    WHEN 'draft_delete' THEN 'draft_delete'
    WHEN 'draft' THEN 'draft'
    WHEN 'schedule_list' THEN 'schedule_list'
    WHEN 'schedule_create' THEN 'schedule_manage'
    WHEN 'schedule_cancel' THEN 'schedule_manage'
    WHEN 'schedule' THEN 'schedule'
    WHEN 'signature_get' THEN 'signature_get'
    WHEN 'signature_set' THEN 'signature_set'
    WHEN 'signature' THEN 'signature'
    WHEN 'inbox_list' THEN 'inbox_list'
    WHEN 'contact_search' THEN 'contact_search'
    WHEN 'folder_manage' THEN 'folder_manage'
    WHEN 'draft_write' THEN 'draft_write'
    WHEN 'schedule_manage' THEN 'schedule_manage'
    ELSE p_tool_name
  END;
$$;

REVOKE ALL ON FUNCTION public.growth_public_tool_name(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_public_tool_name(text) TO service_role;
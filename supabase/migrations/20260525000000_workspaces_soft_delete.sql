-- ============================================================
-- MCPEmails — Add soft-delete support to workspaces
-- 20260525000000_workspaces_soft_delete
-- ============================================================
-- Adds deleted_at to the workspaces table so accounts can be
-- soft-deleted via the Delete Account flow.  Updates
-- my_workspace_ids() to exclude deleted workspaces so deleted
-- workspace data is invisible to authenticated queries immediately.
-- ============================================================

-- 1. Add deleted_at column to workspaces.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Index for efficiently excluding deleted workspaces.
CREATE INDEX IF NOT EXISTS idx_workspaces_deleted_at
  ON public.workspaces (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 2. Update the my_workspace_ids() helper to exclude deleted workspaces.
--    All RLS policies that call this function automatically inherit the filter.
CREATE OR REPLACE FUNCTION public.my_workspace_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(
    SELECT wm.workspace_id
    FROM   public.workspace_members wm
    JOIN   public.workspaces w ON w.id = wm.workspace_id
    WHERE  wm.user_id = auth.uid()
    AND    w.deleted_at IS NULL
  );
$$;

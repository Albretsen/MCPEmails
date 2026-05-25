-- Fix "Database error deleting user" from the Supabase Auth dashboard.
--
-- Deleting from auth.users cascades to public.users, but two ON DELETE RESTRICT
-- FK constraints block the cascade:
--   1. workspaces.owner_id   — every user owns an auto-provisioned workspace
--   2. api_keys.created_by   — any user who created an API key
--
-- Fix:
--   • workspaces.owner_id  → ON DELETE CASCADE  (workspace goes with its owner)
--   • api_keys.created_by  → ON DELETE SET NULL (key survives, creator reference cleared)
--     also made nullable since SET NULL requires it

-- 1. workspaces.owner_id: RESTRICT → CASCADE
ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_owner_id_fkey;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 2. api_keys.created_by: RESTRICT (NOT NULL) → SET NULL (nullable)
ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_created_by_fkey;

ALTER TABLE public.api_keys
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

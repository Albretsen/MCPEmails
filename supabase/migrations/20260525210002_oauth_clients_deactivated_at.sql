-- 2.3: Allow disabling dynamic clients without deleting them (preserves audit trail).
-- NULL means active. A non-null value means the client is deactivated and cannot
-- initiate new authorization requests.
ALTER TABLE public.oauth_clients
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

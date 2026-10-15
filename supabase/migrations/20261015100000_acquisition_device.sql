-- The device class of a signup, recorded where it can be measured.
--
-- WHY. Nobody can compare mobile and desktop signups. The only device signal
-- is auth.sessions.user_agent, and for Google and GitHub signups (about two
-- thirds of all signups) that says `node`, because the session is created
-- server-side in the OAuth callback. A one-off look at password signups (40
-- mobile, 125 desktop) had phone signups creating a credential at 35% against
-- 68% on desktop, which is too large a gap to leave unmeasured for the rest.
--
-- WHAT. workspaces.acquisition_device: mobile | tablet | desktop, classified
-- by deviceClass() in apps/web/src/lib/acquisition-device.mjs from the headers
-- of the first request the new user's own browser makes to the app
-- (/auth/callback for Google and GitHub, the first dashboard render for
-- password signups), written once by apps/web/src/lib/acquisition-device-stamp.ts
-- and never overwritten. It sits with the other acquisition_* columns because
-- it is the same kind of fact: something true about how the workspace arrived,
-- fixed at signup. It is a WORD, never the User-Agent: the class is what
-- analysis needs, and the string would be browser data in an analytics column.
--
-- NULL means unknown: every workspace created before this column (there is no
-- backfill, the User-Agent of those signups was never kept), and a new one
-- whose browser could not be classified.
--
-- handle_new_user() is NOT touched. The class does not travel in signup
-- metadata, so the trigger has nothing to read, and a new workspace starts
-- NULL until the app stamps it.
--
-- The app tolerates this migration being unapplied: the write is best-effort
-- and logged, it is a statement of its own, and nothing reads the column on a
-- request path.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS acquisition_device text;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_device_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_device_check
  CHECK (
    acquisition_device IS NULL
    OR acquisition_device IN ('mobile', 'tablet', 'desktop')
  );

COMMENT ON COLUMN public.workspaces.acquisition_device IS
  'Device class of the owner''s signup browser: mobile | tablet | desktop. '
  'Set once by the app from deviceClass() in apps/web/src/lib/acquisition-device.mjs; '
  'the User-Agent itself is never stored. NULL = unknown.';

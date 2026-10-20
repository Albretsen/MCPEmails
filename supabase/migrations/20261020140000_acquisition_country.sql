-- The country of a signup, recorded where it can be measured.
--
-- WHY. Nobody can tell which country users are in. acquisition_locale is the
-- URL prefix of the first landing page, not a place: the unprefixed English
-- site, which most of the world reads, records 'en' for everyone.
--
-- WHAT. workspaces.acquisition_country: a two-letter ISO 3166-1 alpha-2 code,
-- taken from the `x-vercel-ip-country` header Vercel's edge adds to every
-- request, on the first request the new user's own browser makes to the app.
-- That is the same request, and the same gate, as acquisition_device
-- (20261015100000_acquisition_device.sql): /auth/callback for Google and
-- GitHub, which the provider redirects the browser to (the session itself is
-- made server-side, so auth.sessions has no usable address for these), and
-- the first dashboard render for password signups, which never pass the
-- callback. Written once by apps/web/src/lib/acquisition-country-stamp.ts and
-- never overwritten. Only the code is stored: the IP address is never read or
-- kept for this, and Vercel's placeholder codes (XX and the like) are dropped
-- by sanitizedCountry() in apps/web/src/lib/acquisition-country.mjs before
-- anything is written.
--
-- NULL means unknown: every workspace created before this column (there is no
-- backfill), and a new one whose request carried no usable country.
--
-- handle_new_user() is NOT touched. The country does not travel in signup
-- metadata, so the trigger has nothing to read, and a new workspace starts
-- NULL until the app stamps it.
--
-- The app tolerates this migration being unapplied: the write is best-effort
-- and logged, it is a statement of its own, and nothing reads the column on a
-- request path.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS acquisition_country text;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_country_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_country_check
  CHECK (
    acquisition_country IS NULL
    OR acquisition_country ~ '^[A-Z]{2}$'
  );

COMMENT ON COLUMN public.workspaces.acquisition_country IS
  'ISO 3166-1 alpha-2 country of the owner''s signup request, from Vercel''s '
  'x-vercel-ip-country header. Set once by apps/web/src/lib/acquisition-country-stamp.ts; '
  'the IP address itself is never stored. NULL = unknown.';

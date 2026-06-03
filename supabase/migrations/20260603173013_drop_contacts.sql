-- ---------------------------------------------------------------------------
-- Drop the persisted contacts table.
--
-- contact_search no longer reads from (or writes to) a stored contacts table.
-- It is now served entirely by a LIVE, header-only scan of recent matching mail
-- in the mcp-server edge function (gmail / outlook / imap aggregators). Nothing
-- about a user's correspondents is persisted between calls.
--
-- This aligns the data model with the product's core privacy promise — "we
-- store no email data". Removing the derived contacts table eliminates the last
-- place email metadata (addresses, display names, contact frequency) was kept
-- at rest, so there is no email-derived data left in the database to leak,
-- export, or breach.
--
-- CASCADE drops any dependent objects (indexes, RLS policies, FKs) created
-- alongside the table in 20260602000000_create_contacts.sql.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS public.contacts CASCADE;

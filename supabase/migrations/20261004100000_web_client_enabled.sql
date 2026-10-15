-- ---------------------------------------------------------------------------
-- workspaces.web_client_enabled — the gate on app.mcpemails.com
-- 20261004100000_web_client_enabled
--
-- Design: docs/VISION-web-client.md. Read by the `client-api` edge function
-- (supabase/functions/client-api/auth.ts) on every route.
--
-- WHAT THE FLAG DECIDES. With it false, `client-api` refuses every request for
-- that workspace with 403 `web_client_disabled`: no mailbox read, no send, no
-- assistant run. With it true, members of the workspace can use the web mail
-- client against the workspace's connected inboxes.
--
-- WHY IT IS A GATE AND NOT A LAUNCH. The web client's assistant sends mail
-- content to an LLM provider. The published privacy copy says mail is fetched
-- live and never leaves for a third party. Until that copy changes, the client
-- may only be on for workspaces that were told. Default false is the point;
-- widening it is a deliberate later decision.
--
-- WHY PER WORKSPACE. Same reasoning as draft_editor_enabled (20260916140000):
-- it answers "who is using this product surface", not "which mailbox".
--
-- NO SEED. Unlike draft_editor_enabled this migration turns the flag on for
-- nobody. Allow-listing is one statement, run by the owner on purpose:
--
--   UPDATE public.workspaces SET web_client_enabled = true WHERE id = '<uuid>';
--
-- `client-api` caches membership and this flag for up to 60 seconds per
-- isolate, so a change takes up to a minute to be seen.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, and the comment is idempotent.
-- NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with the normal migration
-- workflow (never `db push`).
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS web_client_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.web_client_enabled IS
  'Gate for the first-party web mail client (app.mcpemails.com, the client-api edge function). False = every client-api route answers 403 web_client_disabled for this workspace. Default false; allow-listed per workspace by hand. Never mass-update: the assistant sends mail content to an LLM provider, which the published privacy copy does not yet cover.';

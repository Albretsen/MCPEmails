-- Widen dynamically-registered OAuth clients to the full grantable scope set.
--
-- Previously dynamic clients were capped to read/search/send, so the /authorize
-- consent screen could only ever offer those three (and, when the client sent no
-- `scope` param, nothing at all). We now let the user select any scope on the
-- consent screen — the client's scopes_allowed is the ceiling of what may be
-- requested, but nothing is granted without explicit user consent.
--
-- First-party clients are NOT touched: their scopes_allowed is configured
-- deliberately. This only lifts the cap on self-registered (dyn_) clients.
--
-- Idempotent: re-running sets the same array. New dynamic clients receive this
-- set at registration time via DYNAMIC_SCOPES in app/api/oauth/register/route.ts.

UPDATE public.oauth_clients
SET scopes_allowed = ARRAY[
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email'
]
WHERE is_first_party = false;

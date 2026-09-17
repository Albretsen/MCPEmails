-- ---------------------------------------------------------------------------
-- workspaces.card_diagnostics: who may see the card's protocol diagnostics
--
-- Contract: docs/mcp-apps/contract.md §1. The line itself is
-- apps/mcp-app/src/components/App.tsx#Diagnostics, gated by
-- apps/mcp-app/src/diagnostics.ts.
--
-- WHY A SECOND FLAG AND NOT `draft_editor_enabled`. The diagnostics line rode
-- along with EVERY card kind, and the other two card opt-ins
-- (`inboxes.send_approval_required`, `inboxes.bulk_review_mode = 'plan'`) are
-- CUSTOMER-facing choices about holding an operation, not an internal rollout
-- switch. That is how five non-internal workspaces came to see
-- `hs 1 · rx 8/0` under a send they were being asked to approve. Gating on
-- `draft_editor_enabled` instead would be worse than leaving the line off: it
-- would turn it on for every workspace that ever gets the draft editor, which
-- is the whole rollout. So the question "may this workspace see our protocol
-- counters" gets a column of its own, and it is the only per-workspace source
-- the card has.
--
-- WHAT THE LINE DISCLOSES, because the severity depends on it: host name and
-- version, display mode, four yes/no counters, two timings, and the dispatched
-- tool name (neutralised and sliced to 64 in the card's store.ts). No subject,
-- no address, no body. Trust and polish, not disclosure.
--
-- PER WORKSPACE, like `draft_editor_enabled` and for the same reason: it is a
-- question about who is looking at the card, not about which mailbox the
-- operation touches.
--
-- DEFAULT FALSE. False is not a degraded mode, it is the only state a customer
-- should ever be in.
--
-- NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with the normal migration
-- workflow (never `db push`; see the migration-history note in the project
-- memory).
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS card_diagnostics boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.card_diagnostics IS
  'MCP App cards: may this workspace see the protocol diagnostics line (contract §1)? Host name/version, display mode, counters and timings, never mail content. Internal only; false is the state every customer should be in.';


-- ---------------------------------------------------------------------------
-- Seed: our own workspaces, and only ours.
--
-- Without this the flag would ship dead: the card would have a server source
-- that nothing ever sets, which is where this change started. "Ours" is
-- `public.growth_is_internal_email(text)`, the one-argument form that reads its
-- address list from `public.internal_accounts`; going through the predicate
-- rather than joining that table is deliberate, because plus-tagged variants
-- and `@mcpemails.com` / `@mcpemails.dev` match there and would be missed by an
-- `email IN (SELECT ...)`. A workspace is identified by its OWNER, exactly as
-- `20260916140000_draft_editor_flag.sql` does it: a workspace one of us was
-- invited into belongs to its owner, and enabling an internal-only surface
-- there would be enabling it for a customer.
--
-- Idempotent: it only ever sets the flag true, and the `IS DISTINCT FROM true`
-- guard means a re-run updates no rows at all.
-- ---------------------------------------------------------------------------

UPDATE public.workspaces w
SET card_diagnostics = true
FROM public.users u
WHERE u.id = w.owner_id
  AND w.deleted_at IS NULL
  AND w.card_diagnostics IS DISTINCT FROM true
  AND public.growth_is_internal_email(u.email);

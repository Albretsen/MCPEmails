-- ---------------------------------------------------------------------------
-- workspaces.draft_editor_enabled — the MCP App draft-editor gate
--
-- Contract: docs/mcp-apps/contract.md §8. Background: CONCEPT-draft-editor.md.
--
-- WHAT THE FLAG DECIDES. With it false, the consolidated `draft` tool behaves
-- byte-for-byte as it does today in BOTH channels and carries no `_meta.ui` at
-- `tools/list`, so a workspace that is not gated in cannot tell this feature
-- shipped. With it true, `draft` is listed with the review-card resource and
-- its create / reply / update / send / delete results carry a card envelope in
-- `structuredContent` only — `content` is unchanged on every path.
--
-- WHY IT IS PER WORKSPACE AND NOT PER INBOX. The other two MCP App opt-ins
-- (`inboxes.send_approval_required`, `inboxes.bulk_review_mode`) decide whether
-- an OPERATION is held, so they have to sit on the inbox the operation targets.
-- This one decides whether a card is offered at all, which is a question about
-- who is using the product, not about which mailbox is being written to.
--
-- DEFAULT FALSE, AND THE DEFAULT IS THE POINT. `_meta.ui` is per tool, not per
-- call: a host mounts and fetches the 53 KB card bundle for every result of a
-- tool that carries it. Turning this on for everyone would put an iframe under
-- every draft any agent has ever written, including for the hosts that render
-- MCP Apps badly. v1 is internal only; widening it is a deliberate later
-- decision with a read-out behind it, not a default.
--
-- NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with the normal migration
-- workflow (never `db push`; see the migration-history note in the project
-- memory).
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS draft_editor_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.draft_editor_enabled IS
  'MCP App draft editor (contract §8). False = the draft tool behaves exactly as it did before the editor existed, in both channels and at tools/list. Internal only in v1.';


-- ---------------------------------------------------------------------------
-- Seed: our own workspaces, and only ours.
--
-- "Ours" is `public.growth_is_internal_email(text)`, the one-argument form that
-- reads its address list from `public.internal_accounts`. Going through the
-- predicate rather than joining the table directly is not a style choice: the
-- table's own comment says plus-tagged variants match automatically and must
-- NOT be listed separately, so `u.email IN (SELECT email FROM
-- internal_accounts)` would silently miss `asgeir+test@…` — an address that is
-- ours by the only definition this codebase has. The predicate also covers
-- `@mcpemails.com` / `@mcpemails.dev` via `internal_account_domains()`, which
-- are ours outright.
--
-- A workspace is identified by its OWNER, exactly as every internal-exclusion
-- query in this schema does it (`workspaces w JOIN users u ON u.id =
-- w.owner_id`). Membership is deliberately not consulted: a workspace one of us
-- was invited into belongs to its owner, and enabling an internal-only feature
-- there would be enabling it for a customer.
--
-- Idempotent, and safe to re-run: it only ever sets the flag true, and the
-- `IS DISTINCT FROM true` guard means a re-run updates no rows at all.
-- ---------------------------------------------------------------------------

UPDATE public.workspaces w
SET draft_editor_enabled = true
FROM public.users u
WHERE u.id = w.owner_id
  AND w.deleted_at IS NULL
  AND w.draft_editor_enabled IS DISTINCT FROM true
  AND public.growth_is_internal_email(u.email);

-- H6 + LOW (mcp-security): purge guessable / stale SEED data from production.
--
-- The all-zeros seed workspace 00000000-0000-0000-0000-000000000001 carries:
--   * a GUESSABLE live api_key: plaintext "mcpe_" + 64x"a", key_hash
--     bf0d1f42f3fcf45c66e66bc9b154427c03d38ca7eab46ba04a3f2d7a6b5eaed3
--     ( = sha256('mcpe_aaaa…aaaa'), verified ). It authenticates in prod today.
--   * stale seed api_keys with legacy scope names (email:read / email:send) and
--     placeholder hashes (seed_hash_1_… / seed_hash_2_…).
--   * fixture inboxes with SEED_DATA_NOT_A_REAL_TOKEN credentials.
--   * a seed workspace_members row and the workspace itself.
--
-- ALL deletes below are scoped to the seed workspace id ONLY. Verified (SELECT-only,
-- 2026-06-03) that every seed api_key hash exists ONLY in this workspace and that no
-- real user data lives under it:
--   inboxes:    …010 seed-work@gmail.com, …011 seed-work@outlook.com,
--               …012 seed-personal@fastmail.fm, …013 seed-old@gmail.com (all SEED tokens)
--   api_keys:   …020 (seed_hash_1), …021 (seed_hash_2, soft-deleted),
--               …022 GUESSABLE list_inbox test key, …030 legacy-scope Auth test key
--   members:    1 row (owner …099), invites: 0, scheduled_sends: 0
--
-- NOT touched here (out of scope; lead to decide separately): the seed owner user
-- 00000000-0000-0000-0000-000000000099 (seed-test@mcpemails.dev) and its auto-created
-- free workspace 8834ae66-eed9-4f88-8e04-2f85e62630c3. Deleting the user is risky and
-- unnecessary for closing the guessable-key hole.
--
-- Idempotent: re-running after the rows are gone is a no-op. Wrapped in a guard so it
-- only ever affects the all-zeros seed workspace.

DO $$
DECLARE
  v_seed_ws constant uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- Children first (FKs cascade, but we delete explicitly to keep intent obvious
  -- and to leave no dependency on cascade configuration).

  -- Any scheduled sends under the seed workspace (currently 0).
  DELETE FROM public.scheduled_sends WHERE workspace_id = v_seed_ws;

  -- Seed api_keys (guessable + legacy-scope + placeholder-hash). Scoped to the
  -- seed workspace so no real key can be hit.
  DELETE FROM public.api_keys WHERE workspace_id = v_seed_ws;

  -- Seed inboxes (fixture credentials only).
  DELETE FROM public.inboxes WHERE workspace_id = v_seed_ws;

  -- Seed workspace_invites (currently 0).
  DELETE FROM public.workspace_invites WHERE workspace_id = v_seed_ws;

  -- Seed membership row.
  DELETE FROM public.workspace_members WHERE workspace_id = v_seed_ws;

  -- Finally the seed workspace itself.
  DELETE FROM public.workspaces WHERE id = v_seed_ws;
END $$;

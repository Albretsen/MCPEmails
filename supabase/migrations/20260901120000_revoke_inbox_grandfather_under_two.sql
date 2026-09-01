-- ============================================================================
-- 2026-09-01: narrow the 2026-08-19 inbox grandfather to people who actually
-- use more than one inbox.
--
-- The 2026-08-19 repricing granted `unlimited_inboxes` to EVERY user that
-- existed at that moment: 176 accounts. In practice 151 of them never went
-- past a single mailbox, so the grant was not protecting anything they had
-- built under the old terms, it was only making them permanently unreachable
-- by the inbox paywall (and, via checkout-core's `grandfathered_personal`
-- guard, unable to buy the $5 Personal tier at all).
--
-- Owner's decision: keep the promise for anyone who is genuinely running
-- 2+ inboxes, revoke it for everyone sitting at 0 or 1.
--
-- The rule is CURRENT STATE, deliberately, not history: a user who once
-- connected a second mailbox and has since disconnected it counts as 0/1 and
-- loses the grant. 5 accounts fall in that gap; they are recorded in the
-- snapshot table below with `had_multiple_before = true` so support can
-- restore an individual one with a single UPDATE.
--
-- What this does NOT do:
--   * It does not disconnect anybody. The cap is only ever evaluated on the
--     five connect paths (checkInboxLimit), never on read. Every inbox that
--     is live right now stays live.
--   * It does not block credential rotation. inboxExistsForEmail() exempts
--     reconnects of an address the workspace already has, which is what keeps
--     an at-cap free user from being locked out of their own mailbox.
--   * It does not touch comped_scale grants. A comped user resolves to plan
--     'pro' in effective_workspace_plan and keeps unlimited inboxes from the
--     plan itself, so for the 3 comped accounts in the revoked set this is a
--     no-op by design.
--   * It does not touch `workspaces.grandfathered`, which is the unrelated
--     August 3rd unlimited-ACTIONS flag on 7 accounts.
--
-- Effect for the revoked cohort: free plan, cap of 1. The 79 users at zero
-- inboxes can still connect their first one. The 72 users at one inbox are at
-- the cap and meet the paywall on their next new mailbox.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Snapshot first. The audit trigger on user_usage_entitlements already logs
-- the before-image of every row, but that log is keyed by time, not by intent;
-- this table is the named, queryable record of exactly who was revoked by THIS
-- decision and what their inbox count was when it was made. Rollback is a join
-- against it, not an archaeology exercise in the audit log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbox_grandfather_revocations_20260901 (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  live_inboxes integer NOT NULL,
  distinct_addresses_ever integer NOT NULL,
  had_multiple_before boolean NOT NULL,
  entitlement_kind text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inbox_grandfather_revocations_20260901 IS
  'Who lost user_usage_entitlements.unlimited_inboxes in the 2026-09-01 narrowing of the 2026-08-19 grandfather, and their inbox state at that moment. Rollback: UPDATE user_usage_entitlements SET unlimited_inboxes = true FROM this table USING user_id.';

COMMENT ON COLUMN public.inbox_grandfather_revocations_20260901.had_multiple_before IS
  'True when the user had connected 2+ distinct addresses at some point but was down to 0 or 1 live at revocation time. The 5 accounts where the current-state rule and the "never added a second" rule disagree.';

-- Operator-only table: no RLS policies, so PostgREST exposes nothing to
-- authenticated users. Service role bypasses RLS and keeps working.
ALTER TABLE public.inbox_grandfather_revocations_20260901 ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- One-shot. Guarded on the snapshot being empty so that a re-apply (a fresh
-- environment replaying history, a `db reset`) cannot re-evaluate the rule
-- against a LATER state of the world and revoke a cohort nobody decided on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_already bigint;
  v_target bigint;
  v_revoked bigint;
  v_remaining bigint;
BEGIN
  SELECT count(*) INTO v_already FROM public.inbox_grandfather_revocations_20260901;
  IF v_already > 0 THEN
    RAISE NOTICE 'inbox grandfather revocation already applied to % users; skipping', v_already;
    RETURN;
  END IF;

  WITH grandfathered AS (
    SELECT e.user_id, e.kind
    FROM public.user_usage_entitlements e
    WHERE e.unlimited_inboxes = true
  ),
  measured AS (
    SELECT
      g.user_id,
      g.kind,
      -- Inboxes are workspace-scoped but the grant is user-scoped, and
      -- effective_workspace_plan joins the entitlement on workspaces.owner_id.
      -- So the count that matches the grant's blast radius is every live inbox
      -- in every workspace this user OWNS, not just their first workspace.
      (SELECT count(*)
         FROM public.workspaces w
         JOIN public.inboxes i ON i.workspace_id = w.id AND i.deleted_at IS NULL
        WHERE w.owner_id = g.user_id) AS live_inboxes,
      -- DISTINCT address, not row count: a disconnect/reconnect of the same
      -- mailbox must not read as "they once had two".
      (SELECT count(DISTINCT i.email_address)
         FROM public.workspaces w
         JOIN public.inboxes i ON i.workspace_id = w.id
        WHERE w.owner_id = g.user_id) AS ever_addresses
    FROM grandfathered g
  )
  INSERT INTO public.inbox_grandfather_revocations_20260901
    (user_id, live_inboxes, distinct_addresses_ever, had_multiple_before, entitlement_kind)
  SELECT user_id, live_inboxes, ever_addresses, ever_addresses >= 2, kind
  FROM measured
  WHERE live_inboxes <= 1;

  GET DIAGNOSTICS v_target = ROW_COUNT;

  UPDATE public.user_usage_entitlements e
     SET unlimited_inboxes = false,
         -- kind, granted_at, source and any comped grant are left alone: this
         -- narrows one capability, it does not rewrite why the row exists.
         reason = e.reason || ' | 2026-09-01: unlimited_inboxes revoked (0 or 1 connected inbox at the time of the repricing review)'
    FROM public.inbox_grandfather_revocations_20260901 r
   WHERE e.user_id = r.user_id
     AND e.unlimited_inboxes = true;

  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  SELECT count(*) INTO v_remaining
    FROM public.user_usage_entitlements WHERE unlimited_inboxes = true;

  RAISE NOTICE 'inbox grandfather narrowed: % targeted, % revoked, % still grandfathered',
    v_target, v_revoked, v_remaining;

  -- Snapshot and effect must agree exactly. A mismatch means the rule selected
  -- rows the UPDATE did not reach, and the rollback table would then be lying
  -- about who was changed.
  IF v_revoked <> v_target THEN
    RAISE EXCEPTION 'revocation mismatch: snapshotted % users but revoked %', v_target, v_revoked;
  END IF;

  -- Nobody with 2+ live inboxes may lose the grant.
  IF EXISTS (
    SELECT 1 FROM public.inbox_grandfather_revocations_20260901 WHERE live_inboxes > 1
  ) THEN
    RAISE EXCEPTION 'revocation touched a user with more than one live inbox';
  END IF;
END;
$$;

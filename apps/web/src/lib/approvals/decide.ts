import { PENDING_APPROVAL_COLUMNS, runTolerantly } from './columns';
import { isUnsendableLegacyDraft } from './payload';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The single place an outbound send is approved or rejected.
 *
 * SECURITY — read `docs/mcp-apps/contract.md` §6 before touching this file.
 * `_meta.ui.visibility` on an MCP tool is a host UI hint, not an authorisation
 * boundary: the server cannot tell an app-originated `tools/call` from a
 * model-originated one. A prompt-injected agent can therefore reach every tool
 * the review card can reach. The mitigation is structural, not cosmetic:
 *
 *   • Approving is reachable ONLY from an authenticated browser session with
 *     an owner/admin role — never from the MCP channel. `approval_decide`
 *     accepts `decision: "reject"` and nothing else.
 *   • Both authenticated callers (the dashboard panel and the /approvals/[id]
 *     review page) funnel through `decideApproval` so the atomic claim and the
 *     `scheduled_sends` dispatcher marker exist on exactly one code path.
 *
 * Do not add a second approve path. Do not relax the `.eq('status','pending')`
 * claim: it is what makes a double-click, a stale review card and two
 * simultaneous reviewers safe.
 *
 * AN APPROVAL IS OF A VERSION (security review 2026-10-16, F-04-02). The MCP
 * channel can still rewrite a pending send (`approval_update`,
 * `approval_schedule`), and every such write bumps `send_approvals.revision`
 * (a trigger, migration 20261016160600). Both approve surfaces submit the
 * revision they RENDERED, and the claim below is `.eq('revision', submitted)`,
 * so a click on a page showing an older version matches no row and is answered
 * `changed`: the UI reloads the current content and the human looks again.
 * Rejecting needs no revision: it is fail-safe whatever the content says.
 */

/** Where the human made the call. Persisted for audit provenance. */
export type DecisionSurface = 'dashboard' | 'review_page';

export type ApprovalDecision = 'approve' | 'reject';

export type DecisionFailureCode =
  | 'not_pending'
  | 'expired'
  | 'changed'
  | 'not_sendable'
  | 'usage_limit'
  | 'queue_failed'
  | 'write_failed';

/** What a reviewer is told when the request changed after their page rendered it. */
export const CHANGED_ERROR = 'This request changed after you opened it. Review it again before deciding.';

/**
 * The revision a decision request says it rendered: a positive integer, or
 * null when it sent none or something else (which can never approve).
 */
export function parseRenderedRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

export type DecisionOutcome =
  | { ok: true; decision: ApprovalDecision }
  | { ok: false; code: DecisionFailureCode; status: number; error: string };

/** Roles allowed to decide. Mirrored by ApprovalsPanel's `canDecide`. */
export const DECIDING_ROLES = ['owner', 'admin'] as const;

export function canDecide(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** True when a still-`pending` row has passed its expiry (if the column exists). */
export function isExpired(approval: { expires_at?: string | null } | null): boolean {
  const expiresAt = approval?.expires_at;
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

/** Ask the scheduled-send dispatcher to run now. Never throws. */
export async function kickDispatch(db: any): Promise<void> {
  try {
    const { error } = await db.rpc('dispatch_scheduled_sends');
    if (error) console.warn('[approvals] dispatch_kick_failed', error.message);
  } catch (err) {
    console.warn('[approvals] dispatch_kick_failed', err instanceof Error ? err.message : String(err));
  }
}

export interface DecideArgs {
  /** Service-role client. RLS would reject the status write from a user client. */
  db: any;
  approvalId: string;
  /** Resolved from the approval row itself, never from a client-supplied value. */
  workspaceId: string;
  userId: string;
  decision: ApprovalDecision;
  via: DecisionSurface;
  /**
   * The `revision` of the approval the human was shown, as the page submitted
   * it. Required to approve; null approves nothing.
   */
  revision: number | null;
}

/**
 * True when an approval is a rule's forward and the allowance has nothing left.
 *
 * Reads the one definition of the allowance (`workspace_action_allowance`), so
 * this and the edge function's reservation agree. Exempt, in grace and failed
 * lookups are all "no": the allowance is a plan rule, and an outage in it must not
 * stop a person approving a send. The dispatcher's reservation is what enforces.
 */
async function ruleForwardOverAllowance(db: any, approval: any, workspaceId: string): Promise<boolean> {
  if (approval.operation !== 'email_forward' || typeof approval.triage_rule_name !== 'string') return false;
  const { data, error } = await db
    .rpc('workspace_action_allowance', { p_workspace_id: workspaceId })
    .maybeSingle();
  if (error || !data) return false;
  return !data.exempt && !data.in_grace && data.cap !== null && data.remaining !== null && data.remaining <= 0;
}

/**
 * Applies a decision to a pending approval.
 *
 * Callers MUST have already established that `userId` is an owner/admin of
 * `workspaceId`; this function re-scopes every statement to that workspace but
 * does not itself authenticate or authorise.
 */
export async function decideApproval({
  db,
  approvalId,
  workspaceId,
  userId,
  decision,
  via,
  revision,
}: DecideArgs): Promise<DecisionOutcome> {
  const { data: approval, error } = await db
    .from('send_approvals')
    .select('*')
    .eq('id', approvalId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error || !approval) {
    return {
      ok: false,
      code: 'not_pending',
      status: 409,
      error: 'This approval is no longer pending.',
    };
  }

  const now = new Date().toISOString();

  // An expired request must never be sendable, even by an authorised human
  // arriving from a stale review card. Retire the row so the next visit reads
  // a terminal state rather than a live one.
  if (isExpired(approval)) {
    await runTolerantly(
      { status: 'expired', decided_at: now, decided_via: via },
      PENDING_APPROVAL_COLUMNS,
      (patch) =>
        db.from('send_approvals').update(patch).eq('id', approvalId).eq('status', 'pending'),
    );
    return {
      ok: false,
      code: 'expired',
      status: 409,
      error: 'This approval expired before it was decided.',
    };
  }

  if (decision === 'approve') {
    // The page must say which version it showed, and it must be this one. A
    // missing revision (a page rendered before this check existed) is treated
    // as stale, never as "any version".
    if (revision === null || approval.revision !== revision) {
      return { ok: false, code: 'changed', status: 409, error: CHANGED_ERROR };
    }
    // The dispatcher would refuse it anyway; approving it would only queue a
    // send that fails. Both UIs disable Approve for it; this is the backstop.
    if (isUnsendableLegacyDraft(approval)) {
      return {
        ok: false,
        code: 'not_sendable',
        status: 409,
        error:
          'This draft send was prepared before a copy of the draft was recorded, so it cannot be sent. Reject it and send the draft again.',
      };
    }
    // A rule's forward counts when it is sent, so this is the moment the allowance
    // is its business. Refused here it stays pending and can be approved once the
    // allowance is back, inside its expiry. The dispatcher checks again, for the
    // approvals that pass this together.
    if (await ruleForwardOverAllowance(db, approval, workspaceId)) {
      return {
        ok: false,
        code: 'usage_limit',
        status: 409,
        error:
          'This workspace has used its included actions for this period, so this forward cannot be sent yet. It stays here until it expires.',
      };
    }
    // Atomic claim: only one caller can move pending → approved, and only for
    // the revision it rendered. An edit landing between the read above and
    // this write bumps the revision, so the claim matches nothing.
    const { data: claimed, error: claimError } = await runTolerantly<any>(
      { status: 'approved', decided_at: now, decided_by: userId, decided_via: via },
      PENDING_APPROVAL_COLUMNS,
      (patch) =>
        db
          .from('send_approvals')
          .update(patch)
          .eq('id', approvalId)
          .eq('status', 'pending')
          .eq('revision', revision)
          .select('id')
          .maybeSingle(),
    );
    if (claimError || !claimed) {
      // Lost to an edit (still pending, newer revision) or to another decision.
      const { data: current } = await db
        .from('send_approvals')
        .select('status, revision')
        .eq('id', approvalId)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (!claimError && current?.status === 'pending' && current.revision !== revision) {
        return { ok: false, code: 'changed', status: 409, error: CHANGED_ERROR };
      }
      return {
        ok: false,
        code: 'not_pending',
        status: 409,
        error: 'This approval is no longer pending.',
      };
    }

    // The edge dispatcher resolves the encrypted approval snapshot and invokes
    // its original outbound operation. This marker contains no email content,
    // and it is the ONLY dispatch path — the dashboard panel and the review
    // page both land here.
    const { error: queued } = await db.from('scheduled_sends').insert({
      workspace_id: workspaceId,
      inbox_id: approval.inbox_id,
      payload: { approval_id: approval.id },
      payload_encrypted: false,
      send_at: approval.send_at ?? now,
      status: 'pending',
    });

    if (queued) {
      // Release the claim so the send can be retried rather than silently lost.
      await runTolerantly(
        { status: 'pending', decided_at: null, decided_by: null, decided_via: null },
        PENDING_APPROVAL_COLUMNS,
        (patch) =>
          db.from('send_approvals').update(patch).eq('id', approvalId).eq('status', 'approved'),
      );
      return {
        ok: false,
        code: 'queue_failed',
        status: 500,
        error: 'Could not queue this approved email.',
      };
    }

    // Send now rather than on the next per-minute cron tick: the person just
    // pressed Approve and is watching. `dispatch_scheduled_sends()` is what the
    // cron calls (pg_net POST to the mcp-server dispatcher, returns at once),
    // and the dispatcher's pending -> sending claim makes racing the cron safe.
    // A failure here is logged only: the row is queued and the cron sends it.
    if (!approval.send_at || Date.parse(approval.send_at) <= Date.now()) {
      await kickDispatch(db);
    }

    return { ok: true, decision: 'approve' };
  }

  const { error: updated } = await runTolerantly(
    { status: 'rejected', decided_at: now, decided_by: userId, decided_via: via },
    PENDING_APPROVAL_COLUMNS,
    (patch) =>
      db.from('send_approvals').update(patch).eq('id', approvalId).eq('status', 'pending'),
  );
  if (updated) {
    return {
      ok: false,
      code: 'write_failed',
      status: 500,
      error: 'Could not record decision.',
    };
  }

  return { ok: true, decision: 'reject' };
}

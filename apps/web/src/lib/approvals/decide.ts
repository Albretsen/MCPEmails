import { PENDING_APPROVAL_COLUMNS, runTolerantly } from './columns';

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
 */

/** Where the human made the call. Persisted for audit provenance. */
export type DecisionSurface = 'dashboard' | 'review_page';

export type ApprovalDecision = 'approve' | 'reject';

export type DecisionFailureCode =
  | 'not_pending'
  | 'expired'
  | 'queue_failed'
  | 'write_failed';

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

export interface DecideArgs {
  /** Service-role client. RLS would reject the status write from a user client. */
  db: any;
  approvalId: string;
  /** Resolved from the approval row itself, never from a client-supplied value. */
  workspaceId: string;
  userId: string;
  decision: ApprovalDecision;
  via: DecisionSurface;
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
    // Atomic claim: only one caller can move pending → approved.
    const { data: claimed, error: claimError } = await runTolerantly<any>(
      { status: 'approved', decided_at: now, decided_by: userId, decided_via: via },
      PENDING_APPROVAL_COLUMNS,
      (patch) =>
        db
          .from('send_approvals')
          .update(patch)
          .eq('id', approvalId)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle(),
    );
    if (claimError || !claimed) {
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

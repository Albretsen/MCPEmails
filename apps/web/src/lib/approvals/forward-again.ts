import { isExpired } from './decide';
import { readPayload } from './payload';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * "Forward again" on an expired rule forward.
 *
 * SAFETY. This widens nothing. It takes an approval id and nothing else: the
 * message and the address are copied from the expired row, as encrypted, and the
 * caller has no way to supply either. The result is a NEW PENDING request, which
 * still needs a person to approve it. Only a dashboard session with an owner or
 * admin role reaches this (app/api/approvals/[id]/forward-again/route.ts).
 *
 * WHEN THE RULE IS GONE. A person who deleted a rule said they do not want it
 * producing more mail, so a forward from a deleted rule can not be asked for
 * again. Requests already waiting when it was deleted stay approvable one by one,
 * since each is a person's explicit decision; deleting a rule offers to cancel
 * them (DELETE /api/automations/[id]).
 */

/** Mirror of the same constant in mcp-app-approvals.ts (a test pins them). */
export const RULE_FORWARD_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Retention clears a decided approval's payload 7 days after `decided_at`
 * (retention_low_risk), and there is nothing to forward after that.
 */
const PAYLOAD_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

export type ForwardAgainFailure =
  | 'not_found'
  | 'not_expired'
  | 'not_rule_forward'
  | 'rule_deleted'
  | 'already'
  | 'gone'
  | 'key_gone'
  | 'write_failed';

export type ForwardAgainOutcome =
  | { ok: true; id: string; expires_at: string }
  | { ok: false; code: ForwardAgainFailure; status: number; error: string };

const fail = (code: ForwardAgainFailure, status: number, error: string): ForwardAgainOutcome => ({
  ok: false,
  code,
  status,
  error,
});

/** True while this row's stored message should still be there. */
export function forwardAgainWindowOpen(
  row: { decided_at?: unknown; expires_at?: unknown },
  nowMs: number = Date.now(),
): boolean {
  const decided = typeof row.decided_at === 'string' ? row.decided_at : row.expires_at;
  const at = typeof decided === 'string' ? Date.parse(decided) : NaN;
  return Number.isFinite(at) && nowMs - at < PAYLOAD_KEPT_MS;
}

export async function forwardAgain(args: {
  db: any;
  approvalId: string;
  workspaceId: string;
  nowMs?: number;
}): Promise<ForwardAgainOutcome> {
  const { db, approvalId, workspaceId, nowMs = Date.now() } = args;
  const { data: old } = await db
    .from('send_approvals')
    .select('*')
    .eq('id', approvalId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!old) return fail('not_found', 404, 'Not found.');

  if (old.operation !== 'email_forward' || (typeof old.triage_rule_id !== 'string' && typeof old.triage_rule_name !== 'string')) {
    return fail('not_rule_forward', 409, 'Only a forward from a rule can be forwarded again.');
  }
  const expired = old.status === 'expired' || (old.status === 'pending' && isExpired(old));
  if (!expired) return fail('not_expired', 409, 'Only an expired request can be forwarded again.');

  if (typeof old.triage_rule_id !== 'string') {
    return fail('rule_deleted', 409, 'The rule behind this forward was deleted, so it cannot be forwarded again.');
  }
  const { data: rule } = await db
    .from('triage_rules')
    .select('id, deleted_at')
    .eq('id', old.triage_rule_id)
    .maybeSingle();
  if (!rule || rule.deleted_at) {
    return fail('rule_deleted', 409, 'The rule behind this forward was deleted, so it cannot be forwarded again.');
  }

  // Retention empties the payload to `{}`. A row that no longer decrypts to a
  // forward has nothing to send, and would only fail after someone approved it.
  const stored = readPayload(old);
  if (!stored || typeof stored.message_id !== 'string' || !Array.isArray(stored.to) || stored.to.length === 0) {
    return fail('gone', 410, 'This request is too old to forward again.');
  }

  const { data: key } = await db
    .from('api_keys')
    .select('id')
    .eq('id', old.api_key_id)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!key) return fail('key_gone', 409, 'The API key this rule ran with was deleted, so this cannot be sent.');

  const expiresAt = new Date(nowMs + RULE_FORWARD_APPROVAL_TTL_MS).toISOString();
  const { data: created, error } = await db
    .from('send_approvals')
    .insert({
      workspace_id: old.workspace_id,
      inbox_id: old.inbox_id,
      api_key_id: old.api_key_id,
      operation: old.operation,
      payload: old.payload,
      payload_encrypted: old.payload_encrypted,
      summary: old.summary,
      expires_at: expiresAt,
      triage_rule_id: old.triage_rule_id,
      triage_rule_name: old.triage_rule_name,
      reforward_of: old.id,
    })
    .select('id')
    .maybeSingle();
  // The unique index on reforward_of: another click or another admin got there.
  if (error?.code === '23505') return fail('already', 409, 'This was already forwarded again.');
  if (error || !created) return fail('write_failed', 500, 'Could not create the new request.');

  // Past its deadline but not retired yet: close it, so it reads as expired
  // everywhere. Its own deadline is the honest time.
  if (old.status === 'pending') {
    await db
      .from('send_approvals')
      .update({ status: 'expired', decided_at: old.expires_at })
      .eq('id', old.id)
      .eq('status', 'pending');
  }
  return { ok: true, id: created.id, expires_at: expiresAt };
}

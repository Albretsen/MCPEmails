/**
 * Team changes for the Security audit view: public.workspace_audit_events
 * (migration 20261111190100_business_admin_audit).
 *
 * Written only from server routes, AFTER they have authorised the change and
 * the change has landed, with the service-role client (the table has no write
 * policy). Owners and admins read them through GET /api/security/audit-log.
 *
 * NEVER THROWS. A team change that already happened must not answer 500
 * because its audit row could not be written: the failure is logged and the
 * route carries on. `details` stays small and value-free (a role, a
 * visibility, a domain list); never message content, never a token.
 */

export const WORKSPACE_AUDIT_KINDS = [
  'invite_sent',
  'invite_cancelled',
  'invite_accepted',
  'member_removed',
  'member_left',
  'role_changed',
  'inbox_visibility_changed',
  'recipient_rule_changed',
  'approval_window_changed',
] as const;

export type WorkspaceAuditKind = (typeof WORKSPACE_AUDIT_KINDS)[number];

export interface WorkspaceAuditEventInput {
  workspaceId: string;
  actorUserId: string | null;
  kind: WorkspaceAuditKind;
  /** What it was done to: an invited address, a member's user id, an inbox id. */
  target?: string | null;
  details?: Record<string, unknown>;
}

/** The row as inserted. Exported for tests. */
export function workspaceAuditRow(input: WorkspaceAuditEventInput): Record<string, unknown> {
  return {
    workspace_id: input.workspaceId,
    actor_user_id: input.actorUserId,
    kind: input.kind,
    target: input.target == null ? null : String(input.target).slice(0, 320),
    details: input.details ?? {},
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `service` is the service-role client, or a function that makes one (so a
 * route that has none yet does not throw before this function's guard).
 */
export async function recordWorkspaceAuditEvent(service: any, input: WorkspaceAuditEventInput): Promise<boolean> {
  try {
    const db = typeof service === 'function' ? service() : service;
    const { error } = await db.from('workspace_audit_events').insert(workspaceAuditRow(input));
    if (error) {
      console.error('[workspace-audit] insert failed:', input.kind, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[workspace-audit] insert threw:', input.kind, err instanceof Error ? err.message : String(err));
    return false;
  }
}

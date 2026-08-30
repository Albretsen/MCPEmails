import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The workspace role model, and the one place that decides what each role may
 * do outside its own feature area.
 *
 * WHY THIS EXISTS. Membership is not permission, and until this module landed
 * several routes treated it as if it were. The inbox routes (connect,
 * disconnect, settings, and both OAuth callbacks) established only that the
 * caller belonged to the workspace, then acted. Proven against production: a
 * real `viewer` member of somebody else's workspace reached the destructive
 * branch of DELETE /api/inboxes/[id] (which revokes the Google OAuth grant and
 * soft-deletes the mailbox) and got a 404 for a random id rather than a 403,
 * meaning a real id would have succeeded. The same viewer got past
 * authorization on POST /api/inboxes/imap and could attach a mailbox to a
 * workspace they can only read.
 *
 * THE POLICY, stated once so the routes do not each invent one:
 *
 *   owner   full control, including billing, deletion and role changes.
 *   admin   manages the workspace day to day: invites, member removal,
 *           approvals decisions, renaming. Mirrors `canDecide` in
 *           lib/approvals/decide.ts.
 *   member  operates the workspace: connects and disconnects mailboxes, edits
 *           signatures, creates keys, runs automations.
 *   viewer  READ ONLY. May hold keys carrying the read-only scope allow-list
 *           (see lib/api-keys/scopes.ts) and nothing else, and may not change
 *           workspace state.
 *
 * WHERE THE INBOX LINE IS DRAWN, and why it is drawn there. Connecting a
 * mailbox is treated as an OPERATOR action (owner/admin/member), not an
 * owner/admin one. `member` is the default invite role, and connecting your own
 * mailbox to the team workspace is the thing a person is invited in order to
 * do; restricting it to owner/admin would refuse the product's main team flow
 * in the name of closing a viewer hole. Disconnecting is kept on the same side
 * of the line as connecting deliberately: an operator who can add a mailbox and
 * cannot remove it can only ever add.
 *
 * The one inbox setting that is NOT operator-level is the outbound review gate
 * (`send_review_mode` / `send_approval_required`). Turning review off removes
 * the human check on every outbound send from that mailbox, and the decision it
 * governs is owner/admin-only by design (see the SECURITY note in
 * lib/approvals/decide.ts). A member who could switch it off could approve
 * their own sends by abolishing approval, so that field requires
 * `canManageWorkspace`.
 */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** owner/admin: may change who is in the workspace and how it is configured. */
export function canManageWorkspace(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * owner/admin/member: may change workspace CONTENT (mailboxes, signatures,
 * keys) but not necessarily its configuration. Viewers are excluded, and so is
 * any unrecognised value: an unknown role is refused rather than assumed
 * harmless, because the roles list is a CHECK constraint on
 * workspace_members.role and a value outside it means something is wrong.
 */
export function canOperateWorkspace(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

/**
 * Whether this role may connect or disconnect a mailbox. An alias of
 * `canOperateWorkspace` with a name that says which decision is being made, so
 * a future change to the inbox policy has one call site to change and does not
 * silently drag every other operator action with it.
 */
export function canManageInboxes(role: string | null | undefined): boolean {
  return canOperateWorkspace(role);
}

/** Read-only: exists so `role === 'viewer'` checks stop being written by hand. */
export function isViewer(role: string | null | undefined): boolean {
  return role === 'viewer';
}

/**
 * The 403 body every role refusal returns.
 *
 * Shape matches the viewer-scope refusal already shipped in
 * app/api/api-keys/route.ts so a client can branch on one `error_code` for all
 * of them.
 */
export interface InsufficientRoleBody {
  error: string;
  error_code: 'insufficient_role';
}

export function insufficientRoleBody(message: string): InsufficientRoleBody {
  return { error: message, error_code: 'insufficient_role' };
}

/**
 * The `?error=` code the OAuth callbacks redirect with when the caller's role
 * is too low. The callbacks answer with a redirect rather than JSON, so they
 * cannot use `insufficientRoleBody`; this keeps the two surfaces naming the
 * same condition the same way.
 */
export const INSUFFICIENT_ROLE_REDIRECT_CODE = 'insufficient_role';

/**
 * Reads the caller's role in a workspace, or null when they are not a member.
 *
 * MUST be called with the request-scoped USER client. Under the service-role
 * client this bypasses the workspace_members RLS policy and would happily
 * report a role in a workspace the caller has no relationship with, which
 * turns an authorization check into a rubber stamp.
 */
export async function fetchWorkspaceRole(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return isWorkspaceRole(data.role) ? data.role : null;
}

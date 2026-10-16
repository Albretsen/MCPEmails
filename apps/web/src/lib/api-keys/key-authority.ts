import { canManageWorkspace, isWorkspaceRole } from '@/lib/workspace/roles';
import { VIEWER_SCOPES } from '@/lib/api-keys/scopes';

/**
 * Who may change an existing API key, and what a key may carry.
 *
 * WHY THIS EXISTS. The revoke and edit routes used to check only that the
 * caller belonged to the workspace, then wrote to any key in it. A viewer could
 * revoke the owner's keys and OAuth connections, and a member could widen
 * another member's (or a viewer's) key to `send:email`, because the viewer
 * scope cap looked at the EDITOR's role instead of the role of the person who
 * holds the key.
 *
 * THE RULE, used by the routes and mirrored by the dashboard so the buttons a
 * person cannot use are not offered to them:
 *
 *   - owner/admin may revoke or edit any ordinary key in the workspace;
 *   - anyone else (member, viewer) may revoke or edit only a key they created.
 *     A key with no creator (legacy rows) is owner/admin-only.
 *
 * And separately, what the key may hold: a key whose CREATOR is a viewer (or
 * whose creator's role cannot be established) is capped to the read-only
 * VIEWER_SCOPES allow-list, whoever is doing the editing.
 */
export function canChangeApiKey(input: {
  callerRole: string | null | undefined;
  callerId: string;
  keyCreatorId: string | null | undefined;
}): boolean {
  if (canManageWorkspace(input.callerRole)) return true;
  if (!isWorkspaceRole(input.callerRole)) return false;
  return typeof input.keyCreatorId === 'string'
    && input.keyCreatorId.length > 0
    && input.keyCreatorId === input.callerId;
}

/**
 * The scope cap a key's holder imposes on an edit:
 *
 *   'viewer'   the creator is a viewer: every scope must be on VIEWER_SCOPES.
 *   'no_widen' the creator's role cannot be established (they left, or the row
 *              has no creator): the edit may keep or drop what the key already
 *              has but may not ADD a scope beyond VIEWER_SCOPES. Refusing to
 *              widen is the safe default, and it never strips a working key.
 *   'none'     owner/admin/member: any valid scope.
 */
export type KeyScopeCap = 'viewer' | 'no_widen' | 'none';

export function keyScopeCap(creatorRole: string | null | undefined): KeyScopeCap {
  if (!isWorkspaceRole(creatorRole)) return 'no_widen';
  return creatorRole === 'viewer' ? 'viewer' : 'none';
}

/**
 * The first requested scope the cap forbids, or undefined when the request is
 * inside it. `current` is the key's scopes before the edit.
 */
export function scopeBeyondCap(
  cap: KeyScopeCap,
  requested: readonly string[],
  current: readonly string[] | null | undefined,
): string | undefined {
  if (cap === 'none') return undefined;
  const held = new Set(current ?? []);
  return requested.find((s) => !VIEWER_SCOPES.has(s) && (cap === 'viewer' || !held.has(s)));
}

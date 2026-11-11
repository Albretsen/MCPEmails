import { canDecide } from './decide';
import { isInboxVisibleTo, type VisibilityRow } from '@/lib/inboxes/visibility';

/**
 * What one person may do with one held send, under the Business privacy model
 * (migration 20261111120000_inbox_owner_visibility).
 *
 *   inbox visible to them          full view; decide if owner/admin, or if the
 *                                  inbox is THEIR private inbox (any operator
 *                                  role: the mailbox is theirs alone)
 *   not visible, owner/admin       metadata only (no recipients, subject or
 *                                  body), and they may still decide: approving
 *                                  sends is a workspace policy right
 *   not visible, anyone else       hidden: the same 404 as a missing id
 *
 * A held send with no inbox (inbox_id null) follows the role rule alone.
 */
export interface ApprovalAccess {
  hidden: boolean;
  redacted: boolean;
  canDecide: boolean;
}

export function approvalAccess(
  role: string | null | undefined,
  userId: string,
  inbox: (VisibilityRow & { id?: string | null }) | null | undefined,
): ApprovalAccess {
  const roleDecides = canDecide(role);
  if (!inbox) return { hidden: false, redacted: false, canDecide: roleDecides };
  const visible = isInboxVisibleTo(inbox, userId);
  if (!visible) {
    return roleDecides
      ? { hidden: false, redacted: true, canDecide: true }
      : { hidden: true, redacted: false, canDecide: false };
  }
  const ownsPrivate =
    inbox.visibility === 'private' && inbox.owner_user_id === userId && role != null && role !== 'viewer';
  return { hidden: false, redacted: false, canDecide: roleDecides || ownsPrivate };
}

/** The columns a redacted list row keeps. Everything else is content. */
export function redactApprovalRow(row: Record<string, unknown>): Record<string, unknown> {
  const inbox = (row.inboxes ?? null) as { email_address?: string | null } | null;
  return {
    id: row.id,
    inbox_id: row.inbox_id ?? null,
    operation: row.operation,
    status: row.status,
    created_at: row.created_at ?? null,
    expires_at: row.expires_at ?? null,
    decided_at: row.decided_at ?? null,
    decided_via: row.decided_via ?? null,
    inboxes: inbox ? { email_address: inbox.email_address ?? null, display_name: null } : null,
    summary: {},
    redacted: true,
  };
}

/** Reads an embedded `inboxes(...)` relation as a visibility row. */
export function embeddedInbox(row: Record<string, unknown>): (VisibilityRow & { id?: string | null }) | null {
  if (!row.inbox_id) return null;
  const rel = row.inboxes as (VisibilityRow & { id?: string | null }) | null | undefined;
  // An inbox id whose row did not embed (hard-deleted): nobody's to see.
  return rel ?? { visibility: 'private', owner_user_id: null };
}

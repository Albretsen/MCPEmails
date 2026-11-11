import { canDecide } from './decide';
import { canAccessInbox, isInboxVisibleTo, type VisibilityRow } from '@/lib/inboxes/visibility';

/**
 * What one person may do with one held send, under the Business privacy model
 * (migration 20261111190000_inbox_owner_visibility).
 *
 *   inbox visible to them          full view; decide if owner/admin, or if the
 *                                  inbox is THEIR private inbox (any operator
 *                                  role: the mailbox is theirs alone)
 *   not visible, owner/admin       metadata only (no recipients, subject or
 *                                  body), and they may still decide: approving
 *                                  sends is a workspace policy right. A send
 *                                  the RECIPIENT RULE held also shows them the
 *                                  To/Cc/Bcc addresses (`showRecipients`): the
 *                                  recipients are the whole question they are
 *                                  asked. Subject and body stay redacted.
 *   not visible, anyone else       hidden: the same 404 as a missing id
 *
 * A held send with no inbox (inbox_id null) follows the role rule alone.
 *
 * A send the workspace recipient rule held (`hold_reason = 'recipient_rule'`,
 * migration 20261111190100) is decided by an owner or admin only: the rule is
 * the company's, so the inbox owner's own right to decide does not apply.
 */
export interface ApprovalAccess {
  hidden: boolean;
  redacted: boolean;
  canDecide: boolean;
  /** Redacted, but the recipient addresses may be shown (recipient-rule holds). */
  showRecipients?: boolean;
}

/** send_approvals.hold_reason of a send the workspace recipient rule held. */
export const RECIPIENT_RULE_HOLD_REASON = 'recipient_rule';

export function approvalAccess(
  role: string | null | undefined,
  userId: string,
  inbox: (VisibilityRow & { id?: string | null }) | null | undefined,
  holdReason?: string | null,
): ApprovalAccess {
  const roleDecides = canDecide(role);
  if (!inbox) return { hidden: false, redacted: false, canDecide: roleDecides };
  const visible = isInboxVisibleTo(inbox, userId);
  if (!visible) {
    if (!roleDecides) return { hidden: true, redacted: false, canDecide: false };
    return holdReason === RECIPIENT_RULE_HOLD_REASON
      ? { hidden: false, redacted: true, canDecide: true, showRecipients: true }
      : { hidden: false, redacted: true, canDecide: true };
  }
  const ownsPrivate =
    holdReason !== RECIPIENT_RULE_HOLD_REASON &&
    inbox.visibility === 'private' && inbox.owner_user_id === userId && role != null && role !== 'viewer';
  return { hidden: false, redacted: false, canDecide: roleDecides || ownsPrivate };
}

/**
 * The columns a redacted list row keeps. Everything else is content. With
 * `recipients` (a recipient-rule hold seen by an owner/admin) the summary
 * keeps To, Cc and the Bcc count; the subject never.
 */
export function redactApprovalRow(
  row: Record<string, unknown>,
  opts: { recipients?: boolean; summary?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const inbox = (row.inboxes ?? null) as { email_address?: string | null } | null;
  const s = opts.summary ?? {};
  const summary = opts.recipients
    ? {
        to: Array.isArray(s.to) ? s.to : [],
        cc: Array.isArray(s.cc) ? s.cc : [],
        ...(typeof s.bcc_count === 'number' ? { bcc_count: s.bcc_count } : {}),
      }
    : {};
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
    summary,
    redacted: true,
  };
}

/** Reads an embedded `inboxes(...)` relation as a visibility row. */
/** The row's hold_reason, when it was selected. */
export function holdReasonOf(row: Record<string, unknown> | null | undefined): string | null {
  const v = row?.hold_reason;
  return typeof v === 'string' ? v : null;
}

export function embeddedInbox(row: Record<string, unknown>): (VisibilityRow & { id?: string | null }) | null {
  if (!row.inbox_id) return null;
  const rel = row.inboxes as (VisibilityRow & { id?: string | null }) | null | undefined;
  // An inbox id whose row did not embed (hard-deleted): nobody's to see.
  return rel ?? { visibility: 'private', owner_user_id: null };
}

/**
 * May `userId` read the mail behind a held send? A send with no inbox follows the
 * role rule alone (true here); otherwise the inbox must be visible to them
 * (inbox_visible_to, which fails closed). Used by the routes that read or resend a
 * held send's original message (original, Forward again, Approve all).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function canReadApprovalMail(db: any, inboxId: string | null | undefined, userId: string): Promise<boolean> {
  if (!inboxId) return true;
  return canAccessInbox(db, inboxId, userId);
}

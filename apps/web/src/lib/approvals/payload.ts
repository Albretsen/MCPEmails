import { decryptToken } from '@/lib/crypto';
import { neutralizeList } from '@/lib/textSafety';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Reading an approval's encrypted payload, for the signed-in review surfaces
 * and the decide path. Server-only: it decrypts.
 */

/**
 * Decrypts the stored snapshot. Returns null if the row is not decryptable —
 * never throws into the page render.
 */
export function readPayload(approval: any): Record<string, unknown> | null {
  const payload = approval?.payload;
  if (!payload) return null;
  if (approval.payload_encrypted === false) {
    return typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  }
  const ciphertext = (payload as any)?.data;
  if (typeof ciphertext !== 'string') return null;
  try {
    const parsed = JSON.parse(decryptToken(ciphertext));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.error('[approvals] Failed to decrypt approval payload:', (error as Error)?.message);
    return null;
  }
}

/** The `draft_snapshot` a held draft send carries, or null. */
export function draftSnapshotFrom(payload: Record<string, unknown> | null): Record<string, any> | null {
  const raw = payload?.draft_snapshot;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : null;
}

export function bccFromPayload(operation: unknown, payload: Record<string, unknown> | null): string[] {
  const source = operation === 'draft_send' ? draftSnapshotFrom(payload)?.bcc : payload?.bcc;
  return neutralizeList(source).filter(Boolean);
}

/**
 * The Bcc addresses a reviewer with `role` may see on an approval row (as
 * selected with `payload` and `payload_encrypted`). Empty for `viewer`, and
 * empty when the payload cannot be read: the count is still shown from the
 * summary, so a hidden recipient is never presented as none.
 */
export function reviewerBccFor(approval: any, role: string | null | undefined): string[] {
  if (!role || role === 'viewer') return [];
  return bccFromPayload(approval?.operation, readPayload(approval));
}

/**
 * A draft send queued before the server recorded a copy of the draft
 * (`draft_snapshot`, 2026-10-16). The dispatcher refuses to send one
 * ("approved without a recorded copy"), so approving it would only produce a
 * failed send: both approve surfaces disable Approve for it, and
 * `decideApproval` refuses it. Rejecting stays possible. `payload` is the
 * decrypted payload when the caller already has it.
 */
export function isUnsendableLegacyDraft(
  approval: any,
  payload: Record<string, unknown> | null = readPayload(approval),
): boolean {
  return approval?.operation === 'draft_send' && payload !== null && draftSnapshotFrom(payload) === null;
}

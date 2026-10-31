/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What happened to a send after it was approved.
 *
 * `send_approvals.status` stops at 'approved': that records the person's decision,
 * not the delivery. The delivery is on the `scheduled_sends` marker row whose
 * payload names the approval, which the dispatcher moves through pending, sending,
 * sent or error. This is the one place that row is turned into something to show,
 * for the queue, the review page and the rule run log.
 *
 * A marker's `error_detail` may hold a provider's own words, and is never shown.
 * It is reduced to a reason here, and the reason has a translated sentence under
 * `approvals.delivery.reasons`.
 */

export type DeliveryState = 'scheduled' | 'sending' | 'held' | 'sent' | 'failed';

export type DeliveryReason =
  | 'original_not_found'
  | 'original_ambiguous'
  | 'original_too_large'
  | 'original_unavailable'
  | 'may_have_sent'
  | 'mailbox'
  | 'key'
  | 'expired'
  | 'send_limit'
  | 'generic';

export interface ApprovalDelivery {
  state: DeliveryState;
  /** Why it failed or is waiting. Null when there is nothing to explain. */
  reason: DeliveryReason | null;
  /** When it was sent, when that is known. */
  at: string | null;
}

/** First match wins. Written by handleScheduledDispatch and its refusals. */
const REASON_PATTERNS: Array<[RegExp, DeliveryReason]> = [
  [/original_ambiguous/, 'original_ambiguous'],
  [/original_not_found|message_not_found/, 'original_not_found'],
  [/original_too_large/, 'original_too_large'],
  [/original_unavailable/, 'original_unavailable'],
  [/delivery_uncertain|dispatch interrupted|provider_error|-32603/, 'may_have_sent'],
  [/no longer connected|receiving only|imap_auth_failed|gmail_auth_failed|outlook_auth_failed|Inbox .* not found/i, 'mailbox'],
  [/API key is unavailable|scope_denied|no longer has access/i, 'key'],
  [/expired before it was decided/, 'expired'],
  [/send limit|daily_send_limit|sends_paused|sends_frozen|many recipients/i, 'send_limit'],
];

export function deliveryReasonFromDetail(detail: unknown): DeliveryReason {
  const text = typeof detail === 'string' ? detail : '';
  for (const [pattern, reason] of REASON_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return 'generic';
}

/**
 * One marker row as a delivery. Null when there is no row, or when it was
 * cancelled: the decision then stands by itself.
 */
export function deliveryFromScheduledSend(
  row: { status?: unknown; error_detail?: unknown; sent_at?: unknown; send_at?: unknown } | null | undefined,
  approvalSendAt?: unknown,
  nowMs: number = Date.now(),
): ApprovalDelivery | null {
  if (!row) return null;
  switch (row.status) {
    case 'sent':
      return { state: 'sent', reason: null, at: typeof row.sent_at === 'string' ? row.sent_at : null };
    case 'error':
      return { state: 'failed', reason: deliveryReasonFromDetail(row.error_detail), at: null };
    case 'sending':
      return { state: 'sending', reason: null, at: null };
    case 'pending': {
      // A deferral leaves its note on a row that is back to pending.
      if (typeof row.error_detail === 'string' && row.error_detail.length > 0) {
        const reason = deliveryReasonFromDetail(row.error_detail);
        return reason === 'send_limit'
          ? { state: 'held', reason, at: null }
          : { state: 'sending', reason: null, at: null };
      }
      // The person chose a later time. A row paced a few seconds out by "Approve
      // all" has no time on the approval, and is simply on its way.
      const chosen = typeof approvalSendAt === 'string' ? Date.parse(approvalSendAt) : NaN;
      if (Number.isFinite(chosen) && chosen > nowMs) return { state: 'scheduled', reason: null, at: null };
      return { state: 'sending', reason: null, at: null };
    }
    default:
      return null;
  }
}

/**
 * The marker rows of these approvals, by approval id, in one workspace. A failed
 * read is an empty map, which reads as "approved" rather than as a failed send.
 */
export async function loadScheduledSendsByApproval(
  db: any,
  workspaceId: string,
  approvalIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const byApproval = new Map<string, Record<string, unknown>>();
  if (approvalIds.length === 0) return byApproval;
  const { data, error } = await db
    .from('scheduled_sends')
    .select('payload, status, error_detail, sent_at, send_at')
    .eq('workspace_id', workspaceId)
    .eq('payload_encrypted', false)
    .in('payload->>approval_id', approvalIds);
  if (error || !Array.isArray(data)) return byApproval;
  for (const row of data) {
    const id = row?.payload?.approval_id;
    if (typeof id === 'string') byApproval.set(id, row);
  }
  return byApproval;
}

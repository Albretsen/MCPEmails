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
  | 'refused'
  | 'recipient_refused'
  | 'provider_quota'
  | 'mailbox'
  | 'key'
  | 'expired'
  | 'send_limit'
  | 'allowance'
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
  [/refused before transmission \(recipient\)|invalid_recipient|outbound_recipient_not_allowed/, 'recipient_refused'],
  [/refused before transmission/, 'refused'],
  [/quota_exceeded/, 'provider_quota'],
  [/no longer connected|receiving only|imap_auth_failed|gmail_auth_failed|outlook_auth_failed|Inbox .* not found|could not be read to find the original/i, 'mailbox'],
  [/API key is unavailable|scope_denied|no longer has access/i, 'key'],
  [/expired before it was decided/, 'expired'],
  [/included actions/, 'allowance'],
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
 * The reasons that prove nothing went out, because the failure came before any
 * byte reached the provider. Anything else, a new reason and `generic` included,
 * may have been sent, and is never offered for sending again. This is a list of
 * what is proven, on purpose: a new failure has to be added here to get a retry.
 */
const NOT_SENT_REASONS: ReadonlySet<DeliveryReason> = new Set<DeliveryReason>([
  'original_ambiguous',
  'original_not_found',
  'original_too_large',
  'original_unavailable',
  'refused',
  'recipient_refused',
  'provider_quota',
  'mailbox',
  'key',
  'expired',
  'allowance',
]);

/** True only for a failed marker whose recorded reason proves nothing was sent. */
export function provablyNotSent(row: { status?: unknown; error_detail?: unknown } | null | undefined): boolean {
  return row?.status === 'error' && NOT_SENT_REASONS.has(deliveryReasonFromDetail(row.error_detail));
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
 * Every marker row of one approval, or null when they could not be read. An
 * approval has one, but a decision about sending again should not assume it.
 */
export async function loadAllScheduledSends(
  db: any,
  workspaceId: string,
  approvalId: string,
): Promise<Array<Record<string, unknown>> | null> {
  const { data, error } = await db
    .from('scheduled_sends')
    .select('payload, status, error_detail, sent_at, send_at')
    .eq('workspace_id', workspaceId)
    .eq('payload_encrypted', false)
    .in('payload->>approval_id', [approvalId]);
  return error || !Array.isArray(data) ? null : data;
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

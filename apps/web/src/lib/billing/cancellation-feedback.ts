/**
 * Recording why a subscriber cancelled, after the cancellation is done.
 *
 * Two ways in, one row per cancellation:
 *   cancel_email  the reader tapped a reason link in the post-cancel email and
 *                 pressed Send on /billing/feedback. The signed token
 *                 (feedback-token.ts) says which cancellation; no session.
 *   billing_card  a signed-in subscriber answered on the Billing card. The
 *                 subscription is read from their own `user_billing` row, never
 *                 from the request.
 *
 * The flow is here and the I/O is behind `FeedbackDeps`, so the route is a thin
 * adapter and the rules are tested without a database.
 */
import { CANCEL_REASON_DETAIL_MAX, isCancelReason, type CancelReason } from '@/lib/billing/cancel-reasons';
import type { CancellationFeedbackInsert, CancellationFeedbackSource } from '@/lib/billing/feedback-db';
import { verifyFeedbackToken } from '@/lib/billing/feedback-token';

export interface FeedbackAnswer {
  reason: CancelReason;
  detail: string | null;
}

/**
 * The answer in a request body, or null when there is no valid reason.
 *
 * `detail` is kept only for `other`, trimmed and cut to the column limit
 * (same rule as checkout-feedback.ts: losing an honest answer over a length
 * rule is the wrong trade). An `other` with nothing typed is a valid answer.
 */
export function parseFeedbackAnswer(body: Record<string, unknown>): FeedbackAnswer | null {
  const { reason, detail } = body;
  if (!isCancelReason(reason)) return null;
  let text: string | null = null;
  if (reason === 'other' && typeof detail === 'string') {
    const trimmed = detail.trim().slice(0, CANCEL_REASON_DETAIL_MAX);
    text = trimmed.length > 0 ? trimmed : null;
  }
  return { reason, detail: text };
}

/** What the signed-in path needs from `user_billing`. */
export interface BillingSubscription {
  userId: string;
  subscriptionId: string | null;
  customerId: string | null;
  periodEnd: string | null;
}

export interface FeedbackDeps {
  /** The signed-in user's id, or null. Only consulted when there is no token. */
  sessionUserId(): Promise<string | null>;
  billingForUser(userId: string): Promise<BillingSubscription | null>;
  /** The user a Stripe customer belongs to, for the funnel row. Null when unknown. */
  userIdForCustomer(customerId: string): Promise<string | null>;
  upsert(row: CancellationFeedbackInsert): Promise<boolean>;
  /** Best-effort funnel row. Never throws. */
  recordFunnel(userId: string, reason: CancelReason): Promise<void>;
  now(): number;
}

export type FeedbackOutcome =
  | { status: 200; body: { ok: true } }
  | { status: 400; body: { ok: false; error: 'invalid_reason' | 'invalid_body' } }
  | { status: 401; body: { ok: false; error: 'invalid_token' | 'not_signed_in' } }
  | { status: 404; body: { ok: false; error: 'no_subscription' } }
  | { status: 500; body: { ok: false; error: 'server_error' } };

function isoFromSeconds(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function normaliseIso(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function submitCancellationFeedback(
  body: unknown,
  deps: FeedbackDeps,
): Promise<FeedbackOutcome> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  }
  const record = body as Record<string, unknown>;
  const answer = parseFeedbackAnswer(record);
  if (!answer) return { status: 400, body: { ok: false, error: 'invalid_reason' } };

  let row: CancellationFeedbackInsert;
  let userId: string | null;
  const source: CancellationFeedbackSource = record.t !== undefined ? 'cancel_email' : 'billing_card';

  if (source === 'cancel_email') {
    const scope = verifyFeedbackToken(record.t, deps.now());
    if (!scope) return { status: 401, body: { ok: false, error: 'invalid_token' } };
    userId = scope.customerId ? await deps.userIdForCustomer(scope.customerId) : null;
    row = {
      subscription_id: scope.subscriptionId,
      stripe_customer_id: scope.customerId,
      period_end: isoFromSeconds(scope.periodEnd),
      user_id: userId,
      reason: answer.reason,
      detail: answer.detail,
      source,
    };
  } else {
    userId = await deps.sessionUserId();
    if (!userId) return { status: 401, body: { ok: false, error: 'not_signed_in' } };
    const billing = await deps.billingForUser(userId);
    if (!billing?.subscriptionId) return { status: 404, body: { ok: false, error: 'no_subscription' } };
    row = {
      subscription_id: billing.subscriptionId,
      stripe_customer_id: billing.customerId,
      period_end: normaliseIso(billing.periodEnd),
      user_id: userId,
      reason: answer.reason,
      detail: answer.detail,
      source,
    };
  }

  if (!(await deps.upsert(row))) return { status: 500, body: { ok: false, error: 'server_error' } };
  if (userId) await deps.recordFunnel(userId, answer.reason);
  return { status: 200, body: { ok: true } };
}

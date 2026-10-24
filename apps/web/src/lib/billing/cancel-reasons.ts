/**
 * Why a subscriber cancelled, asked only AFTER the cancellation is done.
 *
 * Fixed answers, one tap each, in the order the email and /billing/feedback
 * show them. `other` is last and is the only one that keeps typed text. The
 * same list is the CHECK on `cancellation_feedback.reason` and, as categories,
 * on `product_funnel_events` (stage `cancel_reason_submitted`); see
 * supabase/migrations/20261024220000_cancellation_feedback.sql.
 *
 * Ground rule (Documents/plans/pause-downgrade-20261024.md, section 0): no
 * answer is ever followed by an offer keyed to it. The reason is stored and
 * thanked, nothing else.
 */
export const CANCEL_REASONS = [
  'too_expensive',
  'not_using_enough',
  'missing_feature',
  'reliability',
  'switched_tool',
  'temporary_need',
  'other',
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/** Matches the CHECK on `cancellation_feedback.detail`. */
export const CANCEL_REASON_DETAIL_MAX = 500;

export function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value);
}

/** English labels for the email (the billing emails are English only). */
export const CANCEL_REASON_EMAIL_LABELS: Record<CancelReason, string> = {
  too_expensive: 'Too expensive',
  not_using_enough: 'Not using it enough',
  missing_feature: 'Missing a feature',
  reliability: 'Connection or reliability problems',
  switched_tool: 'Switched to another tool',
  temporary_need: 'Only needed it for a while',
  other: 'Other',
};

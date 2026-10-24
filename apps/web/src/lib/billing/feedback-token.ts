/**
 * The signed link in the post-cancel email that opens /billing/feedback.
 *
 * The page is public (the reader is not signed in when they tap a link in an
 * email), so the token is the only thing that says which cancellation an
 * answer belongs to. It names the subscription, the Stripe customer and the
 * period end the cancellation was queued for, which is the same pair the
 * `billing_email_sends` scope key and the `cancellation_feedback` unique key
 * use, so an answer from the email and one from the billing card land on the
 * same row.
 *
 * Format: `<base64url JSON>.<base64url HMAC>`, HMAC-SHA256 under the
 * 'billing-feedback' label of the existing CSRF_SECRET (src/lib/support/
 * signing.ts), so a token of any other kind can never verify as this one.
 * Verification is constant time and fails closed: a missing secret, a bad
 * MAC, a malformed body or an expired token all return null.
 *
 * Nothing in the token is secret (the ids are already in the customer's own
 * Stripe receipts); the MAC is what stops someone from filing an answer
 * against a subscription that is not theirs.
 */
import { supportHmac, verifySupportHmac } from '@/lib/support/signing';

/** 60 days: the email stays useful for about two billing periods. */
export const FEEDBACK_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Far above any real token (two Stripe ids and two timestamps). */
const MAX_TOKEN_LENGTH = 600;

export interface FeedbackScope {
  /** Stripe subscription id, `sub_...`. */
  subscriptionId: string;
  /** Stripe customer id, `cus_...`, when the queue row carried one. */
  customerId: string | null;
  /** Unix seconds: the end of the period the cancellation was queued for. */
  periodEnd: number | null;
}

interface TokenBody {
  v: 1;
  s: string;
  c: string | null;
  p: number | null;
  /** Unix seconds the token expires. */
  e: number;
}

const SUBSCRIPTION_RE = /^sub_[A-Za-z0-9]{1,250}$/;
const CUSTOMER_RE = /^cus_[A-Za-z0-9]{1,250}$/;

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1e11;
}

/**
 * A signed token for one cancellation, or '' when it cannot be signed (no
 * usable secret, or ids that do not look like Stripe's). The email then leaves
 * the reason links out and keeps "just reply".
 */
export function issueFeedbackToken(scope: FeedbackScope, nowMs: number = Date.now()): string {
  if (!SUBSCRIPTION_RE.test(scope.subscriptionId)) return '';
  if (scope.customerId !== null && !CUSTOMER_RE.test(scope.customerId)) return '';
  if (scope.periodEnd !== null && !isSeconds(scope.periodEnd)) return '';
  const body: TokenBody = {
    v: 1,
    s: scope.subscriptionId,
    c: scope.customerId,
    p: scope.periodEnd,
    e: Math.floor((nowMs + FEEDBACK_TOKEN_TTL_MS) / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const mac = supportHmac('billing-feedback', encoded);
  return mac ? `${encoded}.${mac.toString('base64url')}` : '';
}

/** The cancellation a token names, or null when it does not verify or has expired. */
export function verifyFeedbackToken(token: unknown, nowMs: number = Date.now()): FeedbackScope | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return null;
  // MAC first, constant time, before the body is parsed at all.
  if (!verifySupportHmac('billing-feedback', match[1], match[2])) return null;

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { v, s, c, p, e } = body as Record<string, unknown>;
  if (v !== 1) return null;
  if (typeof s !== 'string' || !SUBSCRIPTION_RE.test(s)) return null;
  if (c !== null && (typeof c !== 'string' || !CUSTOMER_RE.test(c))) return null;
  if (p !== null && !isSeconds(p)) return null;
  if (!isSeconds(e) || e * 1000 < nowMs) return null;
  return { subscriptionId: s, customerId: c, periodEnd: p };
}

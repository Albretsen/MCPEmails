/**
 * Ticket rate limits, counted from `support_tickets` rows themselves.
 *
 * No separate bucket table: every accepted ticket is a row with its
 * ip_hash, email, source and created_at, so "how many in the last hour" is a
 * count over indexed columns. Silently dropped submissions (honeypot, too
 * fast) write nothing and so count for nothing, which is fine: they also send
 * nothing.
 *
 * WHY THESE NUMBERS. A real customer writes once, perhaps twice with a
 * correction. The cost we guard against is not storage but OUTBOUND MAIL: a
 * signed-out ticket sends a confirmation to whatever address was typed, so an
 * attacker could use the form to mail a third party. Hence:
 *
 *   per destination email   3 / hour, 6 / day   caps what any one victim
 *                                               can receive from us
 *   per client IP           5 / hour, 20 / day  one office behind NAT can
 *                                               still file a few
 *   signed-out, all sources 30 / hour           IP and address rotation
 *                                               still cannot turn the form
 *                                               into a mailer
 *
 * The confirmation never echoes the visitor's subject or message (see
 * emails.ts), so even within these caps it carries nothing of an attacker's.
 *
 * FAIL OPEN on a count error, logged. If the database is down the insert that
 * follows fails too and the visitor gets a 500; refusing on a transient count
 * error alone would turn a slow query into a lost ticket.
 */
import type { SupportTicketSource } from '@/lib/support/validation';

export const SUPPORT_RATE_LIMITS = {
  emailPerHour: 3,
  emailPerDay: 6,
  ipPerHour: 5,
  ipPerDay: 20,
  signedOutGlobalPerHour: 30,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Rows created at or after `sinceIso` matching ONE of the keys. Null on error. */
export interface TicketCounter {
  count(filter: { ipHash?: string; email?: string; source?: SupportTicketSource }, sinceIso: string): Promise<number | null>;
}

export async function isRateLimited(
  counter: TicketCounter,
  input: { ipHash: string | null; email: string; source: SupportTicketSource; nowMs: number },
): Promise<boolean> {
  const hourAgo = new Date(input.nowMs - HOUR_MS).toISOString();
  const dayAgo = new Date(input.nowMs - DAY_MS).toISOString();
  const L = SUPPORT_RATE_LIMITS;

  const checks: Array<[Promise<number | null>, number]> = [
    [counter.count({ email: input.email }, hourAgo), L.emailPerHour],
    [counter.count({ email: input.email }, dayAgo), L.emailPerDay],
  ];
  if (input.ipHash) {
    checks.push([counter.count({ ipHash: input.ipHash }, hourAgo), L.ipPerHour]);
    checks.push([counter.count({ ipHash: input.ipHash }, dayAgo), L.ipPerDay]);
  }
  if (input.source === 'form_signed_out') {
    checks.push([counter.count({ source: 'form_signed_out' }, hourAgo), L.signedOutGlobalPerHour]);
  }

  const counts = await Promise.all(checks.map(([p]) => p.catch(() => null)));
  let limited = false;
  counts.forEach((n, i) => {
    if (n === null) {
      console.error('[support] rate-limit count failed; failing open for this check');
      return;
    }
    if (n >= checks[i][1]) limited = true;
  });
  return limited;
}

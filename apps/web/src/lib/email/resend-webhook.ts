/**
 * Resend delivery feedback: hard bounces and spam complaints stop marketing
 * email to that person.
 *
 * WHY. The paywall follow-up (paywall-followup.ts) and the billing win-backs
 * (billing-lifecycle.ts) are non-transactional. Before this existed, a
 * recipient who pressed "Report spam" on step 1 still got steps 2 and 3, and
 * an address that hard-bounced kept being mailed. Both hurt the one sending
 * domain that the purchase confirmation and dunning mail also use (see the
 * reputation note at the top of billing-lifecycle.ts).
 *
 * WHAT A SUPPRESSION IS. It REUSES the existing opt-out: `users.unsubscribed_at`
 * is set (only when it is still NULL). That column is, by its own migration
 * comment, "global opt-out from every non-transactional email", and every
 * lifecycle sender already checks it before every send:
 *   - the paywall follow-up via ineligibility() -> 'unsubscribed', which it
 *     also persists as a 'skipped' ledger row, so the sequence stays stopped;
 *   - the billing win-backs via isSuppressed() in lifecycle.ts.
 * Transactional mail (receipts, dunning, invites, auth, security, usage-cap
 * notices) does not read the column and keeps sending, which is the point of
 * the split. There is no separate suppression table on purpose; lifecycle.ts
 * explains why two opt-out stores is worse than one. `marketing_consent_at` is
 * left untouched: it is the record that consent was given, and withdrawal goes
 * through the unsubscribe columns (20260929100000_marketing_consent.sql).
 *
 * WHICH EVENTS.
 *   email.complained              always suppress. Whatever email it was on,
 *                                 a person who calls our mail spam gets no more
 *                                 marketing from us.
 *   email.bounced, type Permanent suppress. The address does not exist or
 *                                 Resend has it on its own suppression list.
 *   email.bounced, anything else  ignore (a transient/undetermined bounce says
 *                                 nothing lasting about the address).
 *   every other type              ignore, 2xx.
 *
 * WHO. The users whose `users.email` is one of the event's `to` addresses,
 * plus the owner of any `lifecycle_email_sends` row whose provider_message_id
 * is the event's email_id (covers someone who changed address after the send).
 *
 * IDEMPOTENT without a ledger: the write is `SET unsubscribed_at = now() WHERE
 * id IN (...) AND unsubscribed_at IS NULL`, so a Svix replay of the same
 * svix-id (or a second event about the same person) changes nothing and still
 * gets a 2xx. Nothing in the codebase ever clears unsubscribed_at, so a replay
 * cannot undo a later re-subscribe either.
 *
 * SIGNATURE. Resend delivers through Svix. verifySvixSignature() implements the
 * Svix scheme with node:crypto (the `svix` package is not a dependency):
 *   signed content  `${svix-id}.${svix-timestamp}.${raw body}`
 *   key             base64-decode of the secret after its `whsec_` prefix
 *   signature       base64(HMAC-SHA256(key, signed content)), sent in
 *                   `svix-signature` as space-separated `v1,<sig>` entries
 *                   (several during a secret rotation; any one may match)
 *   timestamp       unix seconds, within +-5 minutes. Svix re-signs every
 *                   delivery attempt with a fresh timestamp, so retries pass.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'bad_secret' | 'bad_timestamp' | 'stale_timestamp' | 'no_match' };

export interface VerifyInput {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  /** Unix seconds. Injected for tests. */
  nowSeconds?: number;
  toleranceSeconds?: number;
}

function decodeSecret(secret: string): Buffer | null {
  const raw = secret.trim().startsWith('whsec_') ? secret.trim().slice('whsec_'.length) : secret.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length > 0 ? key : null;
}

export function signSvix(secret: string, id: string, timestamp: string, body: string): string {
  const key = decodeSecret(secret);
  if (!key) throw new Error('bad secret');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function verifySvixSignature(input: VerifyInput): VerifyResult {
  const { id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const key = decodeSecret(input.secret);
  if (!key) return { ok: false, reason: 'bad_secret' };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no_match' };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type SuppressionReason = 'hard_bounce' | 'complaint';

export type Classified =
  | { action: 'suppress'; reason: SuppressionReason; recipients: string[]; emailId: string | null }
  | { action: 'ignore'; reason: string };

/**
 * A plausible address, checked with string operations rather than a regex so
 * that no input can make it slow (CodeQL js/polynomial-redos).
 */
function looksLikeAddress(addr: string): boolean {
  if (addr.length < 3 || addr.length > 320 || /\s/.test(addr)) return false;
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@')) return false;
  const dot = addr.lastIndexOf('.');
  return dot > at + 1 && dot < addr.length - 1;
}

/** "Name <addr@x>" -> "addr@x"; a bare address is returned trimmed. */
function bareAddress(entry: string): string {
  const open = entry.lastIndexOf('<');
  const close = entry.lastIndexOf('>');
  return (open !== -1 && close > open ? entry.slice(open + 1, close) : entry).trim();
}

function recipientsOf(data: Record<string, unknown>): string[] {
  const to = data.to;
  const list = Array.isArray(to) ? to : typeof to === 'string' ? [to] : [];
  const out = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    if (entry.length > 1000) continue;
    const addr = bareAddress(entry);
    if (looksLikeAddress(addr)) out.add(addr);
  }
  return [...out];
}

export function classifyResendEvent(payload: unknown): Classified {
  if (!payload || typeof payload !== 'object') return { action: 'ignore', reason: 'malformed' };
  const event = payload as { type?: unknown; data?: unknown };
  const type = typeof event.type === 'string' ? event.type : '';
  const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : null;

  if (type !== 'email.bounced' && type !== 'email.complained') {
    return { action: 'ignore', reason: `type_${type || 'missing'}` };
  }
  if (!data) return { action: 'ignore', reason: 'no_data' };

  let reason: SuppressionReason;
  if (type === 'email.complained') {
    reason = 'complaint';
  } else {
    const bounce = data.bounce && typeof data.bounce === 'object' ? (data.bounce as Record<string, unknown>) : {};
    const bounceType = typeof bounce.type === 'string' ? bounce.type.trim().toLowerCase() : '';
    if (bounceType !== 'permanent') return { action: 'ignore', reason: `bounce_${bounceType || 'unknown'}` };
    reason = 'hard_bounce';
  }

  const recipients = recipientsOf(data);
  const emailId = typeof data.email_id === 'string' && data.email_id ? data.email_id : null;
  if (recipients.length === 0 && !emailId) return { action: 'ignore', reason: 'no_recipient' };
  return { action: 'suppress', reason, recipients, emailId };
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

export interface SuppressionStore {
  /** users.id for each address, exact match on the address or its lowercase form. */
  userIdsByEmail(addresses: string[]): Promise<string[]>;
  /** Owners of lifecycle ledger rows sent with this Resend email id. */
  userIdsByProviderMessageId(emailId: string): Promise<string[]>;
  /**
   * SET unsubscribed_at = at WHERE id IN (ids) AND unsubscribed_at IS NULL.
   * Returns how many rows it changed.
   */
  suppress(userIds: string[], at: Date): Promise<number>;
}

export interface SuppressionOutcome {
  reason: SuppressionReason;
  matchedUsers: number;
  newlySuppressed: number;
}

export async function applySuppression(
  store: SuppressionStore,
  event: Extract<Classified, { action: 'suppress' }>,
  now: Date = new Date(),
): Promise<SuppressionOutcome> {
  const ids = new Set<string>();
  if (event.recipients.length > 0) for (const id of await store.userIdsByEmail(event.recipients)) ids.add(id);
  if (event.emailId) for (const id of await store.userIdsByProviderMessageId(event.emailId)) ids.add(id);
  const matched = [...ids];
  const newlySuppressed = matched.length > 0 ? await store.suppress(matched, now) : 0;
  return { reason: event.reason, matchedUsers: matched.length, newlySuppressed };
}

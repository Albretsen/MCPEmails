/**
 * The Black Week 2026 email: one send, to whom, when, and exactly once.
 *
 * WHEN. pg_cron pokes /api/internal/black-week-email/dispatch every 10 minutes
 * between 07:00 and 20:59 UTC on 27 November (migration
 * 20261024150000_schedule_black_week_email.sql). The route itself gates on
 * time as well: it sends only when now >= 2026-11-27T07:00:00Z (08:00 Oslo)
 * AND the offer window is open (until 1 Dec 23:59 Oslo). The first run at
 * 07:00 sends as many as fit in its time budget; the next runs finish the rest
 * and then find nobody left. No reminder, no second send.
 *
 * KILL SWITCH. getActiveSeasonalOffers() is read at send time. Unless BOTH the
 * Personal and the Pro offer are live (coupon valid, price unchanged, window
 * open) nothing is sent, because the email quotes both.
 *
 * WHO. Users with marketing_consent_at set, not unsubscribed (globally or from
 * 'lifecycle'; a spam complaint or permanent bounce sets unsubscribed_at, see
 * resend-webhook.ts), with an unsubscribe token, not internal, who OWN a live
 * workspace, and whose billing is one of:
 *   free              no entitled subscription (and no comped grant)
 *   monthly_personal  active Personal on the CURRENT monthly price
 *   monthly_pro       active Pro on the CURRENT monthly price
 * Everyone else is excluded: any annual plan, Business, legacy Team, retired
 * prices ($5 Personal, $29 Pro), past_due/unpaid, comped, and anyone whose
 * subscription already carries offer=bw2026.
 *
 * EXACTLY ONCE. `lifecycle_email_sends`, primary key (user_id, template,
 * trigger_key) = (user, 'black_week_2026', 'bw2026'). A run inserts 'claimed'
 * rows with ON CONFLICT DO NOTHING before sending, and only sends to the users
 * whose insert won. The row then becomes 'sent' or 'failed'; neither is ever
 * retried. Definitive exclusions (annual, Business, ...) are written as
 * 'skipped' so later runs do not re-read Stripe for them. A Resend
 * Idempotency-Key per batch covers a lost response.
 *
 * This file is pure decision logic plus the run loop; the database adapter is
 * black-week-email-store.ts and the copy black-week-email-template.ts.
 */

import { createHash } from 'node:crypto';

import { PLANS, basePlanItem, getPlanByStripePriceId } from '@/lib/stripe/plans';
import {
  BLACK_WEEK_2026,
  SEASONAL_OFFER_METADATA_KEY,
  isSeasonalWindowOpen,
  type SeasonalOffers,
} from '@/lib/stripe/seasonal-offer';
import {
  BLACK_WEEK_EMAIL_CATEGORY,
  composeBlackWeekEmail,
  type BlackWeekSegment,
} from '@/lib/email/black-week-email-template';

export const BLACK_WEEK_TEMPLATE = 'black_week_2026';
export const BLACK_WEEK_TRIGGER_KEY = BLACK_WEEK_2026.id;

/** 27 Nov 2026 08:00 Oslo. */
export const BLACK_WEEK_SEND_AT = '2026-11-27T07:00:00.000Z';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Resend's batch endpoint takes at most 100 emails per call. */
export const BATCH_SIZE = 100;

export function isInSendWindow(now: Date): boolean {
  return now.getTime() >= Date.parse(BLACK_WEEK_SEND_AT) && isSeasonalWindowOpen(now);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Candidate {
  userId: string;
  email: string | null;
  unsubscribedAt: string | null;
  unsubscribedCategories: string[];
  unsubscribeToken: string | null;
  marketingConsentAt: string | null;
  /** Owns at least one workspace with deleted_at null. */
  ownsLiveWorkspace: boolean;
  internal: boolean;
  compedGrant: boolean;
  billing: { plan: string; subscriptionStatus: string | null; stripeSubscriptionId: string | null } | null;
  /** Already has a ledger row for this campaign (any status). */
  alreadyInLedger: boolean;
}

/** What Stripe says about the subscription, for paid candidates only. */
export interface SubscriptionFacts {
  status: string;
  basePriceId: string | null;
  offerTag: string | null;
}

export type SkipReason =
  | 'already_in_ledger'
  | 'no_consent'
  | 'unsubscribed'
  | 'unsubscribed_lifecycle'
  | 'no_unsubscribe_token'
  | 'unusable_email'
  | 'internal'
  | 'not_workspace_owner'
  | 'comped'
  | 'not_self_serve_subscription'
  | 'subscription_unreadable'
  | 'not_active'
  | 'annual'
  | 'business_or_legacy_team'
  | 'retired_price'
  | 'already_redeemed';

export type Classification =
  | { kind: 'send'; segment: BlackWeekSegment }
  /** `persist`: write a 'skipped' ledger row so later runs never re-check. */
  | { kind: 'skip'; reason: SkipReason; persist: boolean };

const ENTITLED = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * Everything that can be decided from the database alone. Returns null when
 * the candidate is a paid subscriber whose Stripe subscription has to be read
 * before the decision.
 */
export function classifyFromDb(c: Candidate): Classification | null {
  if (c.alreadyInLedger) return { kind: 'skip', reason: 'already_in_ledger', persist: false };
  if (!c.marketingConsentAt) return { kind: 'skip', reason: 'no_consent', persist: false };
  if (c.unsubscribedAt) return { kind: 'skip', reason: 'unsubscribed', persist: false };
  if ((c.unsubscribedCategories ?? []).includes(BLACK_WEEK_EMAIL_CATEGORY)) {
    return { kind: 'skip', reason: 'unsubscribed_lifecycle', persist: false };
  }
  if (!c.unsubscribeToken) return { kind: 'skip', reason: 'no_unsubscribe_token', persist: false };
  if (!c.email || !EMAIL_RE.test(c.email.trim())) return { kind: 'skip', reason: 'unusable_email', persist: false };
  if (c.internal) return { kind: 'skip', reason: 'internal', persist: false };
  if (!c.ownsLiveWorkspace) return { kind: 'skip', reason: 'not_workspace_owner', persist: false };
  if (c.compedGrant) return { kind: 'skip', reason: 'comped', persist: true };

  const b = c.billing;
  const paid =
    b != null && b.plan !== 'free' && (b.subscriptionStatus == null || ENTITLED.has(b.subscriptionStatus));
  if (!paid) return { kind: 'send', segment: 'free' };

  if (b!.plan !== 'personal' && b!.plan !== 'solo') {
    return { kind: 'skip', reason: 'business_or_legacy_team', persist: true };
  }
  if (!b!.stripeSubscriptionId) return { kind: 'skip', reason: 'not_self_serve_subscription', persist: true };
  return null;
}

/** The decision for a paid Personal / Pro candidate, given its subscription. */
export function classifySubscription(sub: SubscriptionFacts | null): Classification {
  if (!sub) return { kind: 'skip', reason: 'subscription_unreadable', persist: false };
  if (sub.offerTag === BLACK_WEEK_2026.id) return { kind: 'skip', reason: 'already_redeemed', persist: true };
  if (sub.status !== 'active' && sub.status !== 'trialing') {
    return { kind: 'skip', reason: 'not_active', persist: false };
  }
  const resolved = getPlanByStripePriceId(sub.basePriceId);
  if (!resolved) return { kind: 'skip', reason: 'retired_price', persist: true };
  if (resolved.interval === 'year') return { kind: 'skip', reason: 'annual', persist: true };
  const planId = resolved.plan.id;
  if (planId !== 'personal' && planId !== 'solo') {
    return { kind: 'skip', reason: 'business_or_legacy_team', persist: true };
  }
  // Only the price sold today: the retired $5 Personal and $29 Pro resolve to
  // the same plan through legacyStripePriceIds and are excluded here.
  if (sub.basePriceId !== PLANS[planId].stripePriceIdMonthly) {
    return { kind: 'skip', reason: 'retired_price', persist: true };
  }
  return { kind: 'send', segment: planId === 'personal' ? 'monthly_personal' : 'monthly_pro' };
}

/** Pull the three facts out of a Stripe subscription object. */
export function subscriptionFacts(sub: {
  status: string;
  metadata?: Record<string, string> | null;
  items: { data: Array<{ price?: { id?: string | null } | null }> };
}): SubscriptionFacts {
  return {
    status: sub.status,
    basePriceId: basePlanItem(sub.items.data)?.price?.id ?? null,
    offerTag: sub.metadata?.[SEASONAL_OFFER_METADATA_KEY] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface LedgerClaim {
  userId: string;
  email: string;
  status: 'claimed' | 'skipped';
  detail: string | null;
}

export interface BlackWeekStore {
  /** Every candidate, paged past the 1000-row cap. */
  listCandidates(): Promise<Candidate[]>;
  /** INSERT ... ON CONFLICT DO NOTHING; returns the user ids whose row was created. */
  claim(rows: LedgerClaim[]): Promise<Set<string>>;
  finish(
    userId: string,
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string },
  ): Promise<void>;
}

export type ReadSubscription = (subscriptionId: string) => Promise<SubscriptionFacts | null>;

export interface OutgoingEmail {
  userId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export type BatchResult =
  | { ok: true; ids: Array<string | null> }
  | { ok: false; reason: string };

/** Sends up to BATCH_SIZE emails in one call, with the given idempotency key. */
export type BatchSender = (emails: OutgoingEmail[], idempotencyKey: string) => Promise<BatchResult>;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type RunMode = 'dry_run' | 'send';

export interface RunOptions {
  store: BlackWeekStore;
  readSubscription: ReadSubscription;
  getOffers: (now: Date) => Promise<SeasonalOffers>;
  mode: RunMode;
  send?: BatchSender;
  now?: Date;
  outOfTime?: () => boolean;
  /** Pause between batch calls (Resend rate limit). */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunReport {
  mode: RunMode;
  /** Why nothing was sent, when nothing could be. */
  gated: 'before_send_time' | 'window_closed' | 'offer_inactive' | null;
  inSendWindow: boolean;
  offerActive: boolean;
  candidates: number;
  bySegment: Record<BlackWeekSegment, number>;
  skipped: Record<string, number>;
  skippedRecorded: number;
  sent: number;
  failed: number;
  lostClaims: number;
  truncated: boolean;
}

function emptyReport(mode: RunMode): RunReport {
  return {
    mode,
    gated: null,
    inSendWindow: false,
    offerActive: false,
    candidates: 0,
    bySegment: { free: 0, monthly_personal: 0, monthly_pro: 0 },
    skipped: {},
    skippedRecorded: 0,
    sent: 0,
    failed: 0,
    lostClaims: 0,
    truncated: false,
  };
}

/** Deterministic, so a retried batch carries the same key. */
export function batchIdempotencyKey(userIds: string[]): string {
  const digest = createHash('sha256').update([...userIds].sort().join(',')).digest('hex').slice(0, 32);
  return `${BLACK_WEEK_TEMPLATE}-${digest}`;
}

export async function runBlackWeekEmail(options: RunOptions): Promise<RunReport> {
  const { store, mode } = options;
  const now = options.now ?? new Date();
  const report = emptyReport(mode);
  if (mode === 'send' && !options.send) throw new Error('mode "send" needs a sender');
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pauseMs = options.pauseMs ?? 600;

  report.inSendWindow = isInSendWindow(now);
  if (!report.inSendWindow) {
    report.gated = now.getTime() < Date.parse(BLACK_WEEK_SEND_AT) ? 'before_send_time' : 'window_closed';
  }

  // The dry run evaluates offers as if it were send time, so it can be run
  // ahead of the day to see the counts.
  const offerNow = mode === 'dry_run' && !report.inSendWindow ? new Date(BLACK_WEEK_SEND_AT) : now;
  const offers = await options.getOffers(offerNow);
  report.offerActive = Boolean(offers.personal && offers.solo);
  if (!report.offerActive && report.gated === null) report.gated = 'offer_inactive';

  // Sending needs every gate open. A dry run counts regardless.
  if (mode === 'send' && report.gated !== null) return report;

  const candidates = await store.listCandidates();
  report.candidates = candidates.length;

  const skip = (reason: string) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };

  let pending: Array<{ candidate: Candidate; segment: BlackWeekSegment }> = [];
  const toRecordSkipped: LedgerClaim[] = [];
  let firstBatch = true;

  const flushSkipped = async () => {
    if (mode !== 'send' || toRecordSkipped.length === 0) return;
    const rows = toRecordSkipped.splice(0, toRecordSkipped.length);
    const won = await store.claim(rows);
    report.skippedRecorded += won.size;
  };

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (mode === 'dry_run') return;

    const composed = batch
      .map(({ candidate, segment }) => ({
        candidate,
        email: composeBlackWeekEmail({ segment, offers, unsubscribeToken: candidate.unsubscribeToken }),
      }))
      .filter((x) => x.email !== null);

    // THE CLAIM. Only users whose insert won are sent to.
    const won = await store.claim(
      composed.map(({ candidate }) => ({
        userId: candidate.userId,
        email: candidate.email!.trim(),
        status: 'claimed',
        detail: null,
      })),
    );
    const winners = composed.filter(({ candidate }) => won.has(candidate.userId));
    report.lostClaims += composed.length - winners.length;
    if (winners.length === 0) return;

    if (!firstBatch && pauseMs > 0) await sleep(pauseMs);
    firstBatch = false;

    const emails: OutgoingEmail[] = winners.map(({ candidate, email }) => ({
      userId: candidate.userId,
      to: candidate.email!.trim(),
      subject: email!.subject,
      text: email!.text,
      html: email!.html,
      headers: email!.headers,
    }));
    const key = batchIdempotencyKey(emails.map((e) => e.userId));

    let result: BatchResult;
    try {
      result = await options.send!(emails, key);
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
    }

    for (let i = 0; i < emails.length; i += 1) {
      if (result.ok) {
        await store.finish(emails[i].userId, { status: 'sent', providerId: result.ids[i] ?? null });
        report.sent += 1;
      } else {
        // Kept and never retried: a blind retry is how someone gets two.
        await store.finish(emails[i].userId, { status: 'failed', detail: result.reason });
        report.failed += 1;
      }
    }
  };

  for (const candidate of candidates) {
    if (mode === 'send' && options.outOfTime?.()) {
      report.truncated = true;
      break;
    }

    let decision = classifyFromDb(candidate);
    if (decision === null) {
      const subId = candidate.billing!.stripeSubscriptionId!;
      let facts: SubscriptionFacts | null = null;
      try {
        facts = await options.readSubscription(subId);
      } catch {
        facts = null;
      }
      decision = classifySubscription(facts);
    }

    if (decision.kind === 'skip') {
      skip(decision.reason);
      if (decision.persist) {
        toRecordSkipped.push({
          userId: candidate.userId,
          email: (candidate.email ?? '').trim(),
          status: 'skipped',
          detail: decision.reason,
        });
        if (toRecordSkipped.length >= BATCH_SIZE) await flushSkipped();
      }
      continue;
    }

    report.bySegment[decision.segment] += 1;
    pending.push({ candidate, segment: decision.segment });
    if (pending.length >= BATCH_SIZE) await flush();
  }

  await flush();
  await flushSkipped();
  return report;
}

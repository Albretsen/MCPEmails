/**
 * The abandoned-checkout reminder: one email after a Stripe Checkout session
 * expires unpaid, with a 20% holdout so the effect can be measured.
 *
 * TRIGGER. `checkout.session.expired`, handled in
 * app/api/stripe/webhook/route.ts and run in `after()`, so nothing here can
 * delay or fail the webhook. Sessions keep Stripe's default 24-hour expiry, so
 * the reminder lands about a day after the buyer left: late enough not to chase
 * someone who is still reading the page, early enough that they remember it.
 * A shorter expiry was not chosen because it would also cut off buyers who
 * leave the tab open and come back the same day.
 *
 * WHY AN APP LINK AND NOT STRIPE'S `after_expiration.recovery`. Stripe's
 * recovery URL replays the expired session as it was: the same line items
 * (including the Pro mailbox add-on quantity counted a day ago), no
 * entitlement guards, and no `checkout_started` funnel row. The link here goes
 * to /api/stripe/checkout/start with the same plan and interval, which builds a
 * fresh session through runCheckout like every buy button, and carries
 * `recovered_from=<expired session id>` into the new session's metadata.
 *
 * WHO GETS IT. Every rule below must hold, checked when the event arrives:
 *   - a subscription-mode session with a purchasable plan_id, an interval and
 *     a user_id in its metadata (every session runCheckout creates has them)
 *   - the session was not expired by us as a chat checkout link's racing
 *     duplicate (CHECKOUT_LINK_SUPERSEDED_KEY in its metadata)
 *   - the session expired at most MAX_EVENT_AGE_MS ago (a queue replay after
 *     an outage does not send a reminder for a checkout days old)
 *   - the user exists, is not one of ours, has a usable address and a working
 *     unsubscribe token
 *   - users.marketing_consent_at is set: this is marketing, so only people who
 *     ticked the signup opt-in, and nobody globally unsubscribed or
 *     unsubscribed from 'lifecycle'
 *   - the user has not paid since: no entitled subscription now, and no
 *     completed checkout after this session was created
 *   - no reminder row (sent OR holdout) for this user in the last 30 days, for
 *     any plan. Stricter than "for that plan" on purpose: a buyer who opened
 *     Personal monthly and then Personal yearly abandons two sessions a minute
 *     apart and should get one email, not two.
 * Then 20% of workspaces, chosen by a hash of the workspace id, are held out:
 * the row is written as skipped/holdout and nothing is sent.
 *
 * LEDGER. `lifecycle_email_sends`, template abandoned_checkout_<plan>_<interval>,
 * trigger_key = the expired session id. The claim is INSERT ... ON CONFLICT DO
 * NOTHING before the send, as in paywall-followup.ts; a claimed or failed row
 * is never retried. Two sessions of one user expiring together both claim
 * (different trigger keys), so after claiming each re-reads the user's rows and
 * only the earliest claim sends; the other is marked skipped/duplicate.
 *
 * RECOVERY. On `checkout.session.completed` the webhook calls
 * markRecovered(), which stamps recovered_at / recovered_session_id /
 * recovered_via_link on this user's newest reminder row from the last 30 days,
 * sent or holdout alike. The holdout comparison is then:
 *
 *   SELECT detail = 'holdout' AS holdout, count(*), count(recovered_at)
 *     FROM lifecycle_email_sends
 *    WHERE template LIKE 'abandoned\_checkout\_%' AND status IN ('sent', 'skipped')
 *      AND (status = 'sent' OR detail = 'holdout')
 *    GROUP BY 1;
 *
 * SWITCH. ABANDONED_CHECKOUT_EMAIL, read at call time: `off` stops everything,
 * `dry_run` decides and logs but writes and sends nothing, anything else
 * (including unset) is live. Changing it needs a redeploy, like every env var
 * on this project.
 */

import { createHash } from 'node:crypto';

import {
  composeAbandonedCheckout,
  reminderLocale,
  ABANDONED_CHECKOUT_CATEGORY,
  type ReminderInterval,
  type ReminderLocale,
  type ReminderPlanId,
} from '@/lib/email/abandoned-checkout-templates';
import { appUrl } from '@/lib/email/lifecycle';

export const TEMPLATE_PREFIX = 'abandoned_checkout';
export const HOLDOUT_PERCENT = 20;
export const DEDUPE_WINDOW_MS = 30 * 24 * 3_600_000;
export const RECOVERY_WINDOW_MS = 30 * 24 * 3_600_000;
export const MAX_EVENT_AGE_MS = 3 * 24 * 3_600_000;

/**
 * Session metadata set by the chat checkout link (app/u/[token]/route.ts) on a
 * session it created and then expired at once because a racing open had
 * already stored another one. Nobody abandoned it, so it never gets a reminder.
 */
export const CHECKOUT_LINK_SUPERSEDED_KEY = 'checkout_link_superseded';

const PLAN_IDS: ReadonlySet<string> = new Set(['personal', 'solo', 'pro']);
const SUBSCRIBED_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SESSION_ID_RE = /^cs_(?:test|live)_[A-Za-z0-9]{8,240}$/;

export function templateFor(planId: ReminderPlanId, interval: ReminderInterval): string {
  return `${TEMPLATE_PREFIX}_${planId}_${interval}`;
}

/** A Checkout session id, or null. Used to validate `recovered_from` from a URL. */
export function checkoutSessionIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && SESSION_ID_RE.test(value) ? value : null;
}

/**
 * Deterministic 20% holdout by workspace: the same workspace is always in the
 * same arm, across sessions and deploys. Salted so it is independent of any
 * other split keyed on the workspace id.
 */
export function isHoldout(workspaceId: string): boolean {
  const digest = createHash('sha256').update(`abandoned_checkout:v1:${workspaceId}`).digest();
  return digest.readUInt32BE(0) % 100 < HOLDOUT_PERCENT;
}

/** Where the button goes: a fresh checkout for the same plan and interval. */
export function resumeUrl(
  planId: ReminderPlanId,
  interval: ReminderInterval,
  locale: ReminderLocale,
  expiredSessionId: string,
): string {
  const params = new URLSearchParams({ plan: planId, interval });
  if (locale !== 'en') params.set('lang', locale);
  params.set('recovered_from', expiredSessionId);
  return `${appUrl()}/api/stripe/checkout/start?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The fields of a Stripe Checkout session this module reads. */
export interface ExpiredSession {
  id: string;
  mode: string | null;
  status: string | null;
  created: number;
  expiresAt: number | null;
  locale: string | null;
  metadata: Record<string, string> | null;
}

export interface ReminderRow {
  template: string;
  triggerKey: string;
  status: string;
  detail: string | null;
  sentAt: string;
  recoveredAt: string | null;
}

export interface ReminderContext {
  owner: {
    id: string;
    email: string | null;
    marketingConsentAt: string | null;
    unsubscribedAt: string | null;
    unsubscribedCategories: string[];
    unsubscribeToken: string | null;
  } | null;
  workspaceId: string | null;
  internal: boolean;
  subscriptionStatus: string | null;
  /** A checkout_completed funnel row for the workspace after this session was created. */
  completedSince: boolean;
  /** This user's abandoned_checkout rows, any template. */
  rows: ReminderRow[];
}

export type SkipReason =
  | 'not_subscription'
  | 'bad_metadata'
  | 'stale_event'
  | 'owner_missing'
  | 'workspace_missing'
  | 'internal'
  | 'no_consent'
  | 'unsubscribed'
  | 'unsubscribed_lifecycle'
  | 'no_unsubscribe_token'
  | 'unusable_email'
  | 'paid_since'
  | 'recent_reminder'
  | 'superseded';

export interface Target {
  userId: string;
  planId: ReminderPlanId;
  interval: ReminderInterval;
  locale: ReminderLocale;
}

export type Decision =
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'holdout'; target: Target }
  | { kind: 'send'; target: Target };

function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** The plan, interval, user and language the session was for, or null. */
export function sessionTarget(session: ExpiredSession): Target | null {
  const m = session.metadata ?? {};
  const planId = m.plan_id;
  const interval = m.interval;
  const userId = m.user_id;
  if (!planId || !PLAN_IDS.has(planId)) return null;
  if (interval !== 'month' && interval !== 'year') return null;
  if (!userId) return null;
  // `lang` is stamped by runCheckout from the buyer's app language. Sessions
  // created before it existed fall back to the hosted page's own locale.
  const locale = reminderLocale(m.lang ?? (session.locale === 'de' ? 'de' : 'en'));
  return { userId, planId: planId as ReminderPlanId, interval, locale };
}

/** Pure. Everything that decides whether this expired session gets an email. */
export function decide(session: ExpiredSession, ctx: ReminderContext, now: Date): Decision {
  if (session.mode !== 'subscription') return { kind: 'skip', reason: 'not_subscription' };
  if (session.metadata?.[CHECKOUT_LINK_SUPERSEDED_KEY]) return { kind: 'skip', reason: 'superseded' };
  const target = sessionTarget(session);
  if (!target) return { kind: 'skip', reason: 'bad_metadata' };

  const expiredMs = (session.expiresAt ?? session.created) * 1000;
  if (now.getTime() - expiredMs > MAX_EVENT_AGE_MS) return { kind: 'skip', reason: 'stale_event' };

  const owner = ctx.owner;
  if (!owner || owner.id !== target.userId) return { kind: 'skip', reason: 'owner_missing' };
  if (!ctx.workspaceId) return { kind: 'skip', reason: 'workspace_missing' };
  if (ctx.internal) return { kind: 'skip', reason: 'internal' };
  if (!Number.isFinite(ms(owner.marketingConsentAt))) return { kind: 'skip', reason: 'no_consent' };
  if (owner.unsubscribedAt) return { kind: 'skip', reason: 'unsubscribed' };
  if ((owner.unsubscribedCategories ?? []).includes(ABANDONED_CHECKOUT_CATEGORY)) {
    return { kind: 'skip', reason: 'unsubscribed_lifecycle' };
  }
  if (!owner.unsubscribeToken) return { kind: 'skip', reason: 'no_unsubscribe_token' };
  if (!owner.email || !EMAIL_RE.test(owner.email.trim())) return { kind: 'skip', reason: 'unusable_email' };

  if (ctx.completedSince) return { kind: 'skip', reason: 'paid_since' };
  if (ctx.subscriptionStatus && SUBSCRIBED_STATUSES.has(ctx.subscriptionStatus)) {
    return { kind: 'skip', reason: 'paid_since' };
  }

  const windowStart = now.getTime() - DEDUPE_WINDOW_MS;
  const recent = ctx.rows.some(
    (r) => r.triggerKey !== session.id && ms(r.sentAt) >= windowStart && countsAsReminder(r),
  );
  if (recent) return { kind: 'skip', reason: 'recent_reminder' };

  return isHoldout(ctx.workspaceId) ? { kind: 'holdout', target } : { kind: 'send', target };
}

/** Sent, in flight, failed or held out. A row skipped as a duplicate is not a reminder. */
function countsAsReminder(row: ReminderRow): boolean {
  return row.status !== 'skipped' || row.detail === 'holdout';
}

/**
 * Of this user's reminder rows created around the same time, the one that
 * should go out: the earliest claim, ties broken by trigger key. Every
 * concurrent handler computes the same answer from the same rows.
 */
export function winningClaim(rows: ReminderRow[], now: Date): ReminderRow | null {
  const windowStart = now.getTime() - DEDUPE_WINDOW_MS;
  const live = rows.filter((r) => countsAsReminder(r) && ms(r.sentAt) >= windowStart);
  live.sort((a, b) => ms(a.sentAt) - ms(b.sentAt) || (a.triggerKey < b.triggerKey ? -1 : a.triggerKey > b.triggerKey ? 1 : 0));
  return live[0] ?? null;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ClaimInput {
  userId: string;
  template: string;
  triggerKey: string;
  email: string;
  status: 'claimed' | 'skipped';
  detail: string | null;
}

export interface ReminderStore {
  loadContext(userId: string, sessionCreatedAt: Date): Promise<ReminderContext>;
  /** This user's abandoned_checkout rows. */
  readRows(userId: string): Promise<ReminderRow[]>;
  /** INSERT ... ON CONFLICT (user_id, template, trigger_key) DO NOTHING. True when this call created the row. */
  claim(row: ClaimInput): Promise<boolean>;
  /** Move a claimed row on. Never deletes. */
  finish(
    key: { userId: string; template: string; triggerKey: string },
    outcome:
      | { status: 'sent'; providerId: string | null }
      | { status: 'failed'; detail: string }
      | { status: 'skipped'; detail: string },
  ): Promise<void>;
  /** Stamp recovery on one row. Only rows with recovered_at still NULL. */
  markRecovered(
    key: { userId: string; template: string; triggerKey: string },
    recovery: { at: string; sessionId: string; viaLink: boolean },
  ): Promise<void>;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  idempotencyKey: string;
}

export type SendResult = { ok: true; id: string | null } | { ok: false; reason: string };
export type Sender = (email: OutgoingEmail) => Promise<SendResult>;

export type ReminderMode = 'off' | 'dry_run' | 'on';

export function reminderMode(env: Record<string, string | undefined> = process.env): ReminderMode {
  const raw = (env.ABANDONED_CHECKOUT_EMAIL ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'false') return 'off';
  if (raw === 'dry_run') return 'dry_run';
  return 'on';
}

export type Outcome =
  | 'off'
  | `skipped:${SkipReason}`
  | 'holdout'
  | 'would_send'
  | 'would_holdout'
  | 'lost_claim'
  | 'duplicate'
  | 'not_composable'
  | 'sent'
  | 'failed';

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export async function handleExpiredSession(options: {
  session: ExpiredSession;
  store: ReminderStore;
  send: Sender;
  mode?: ReminderMode;
  now?: Date;
}): Promise<Outcome> {
  const { session, store } = options;
  const mode = options.mode ?? reminderMode();
  const now = options.now ?? new Date();
  if (mode === 'off') return 'off';

  // The cheap checks first, so an event we would skip anyway costs no reads.
  if (session.mode !== 'subscription') return 'skipped:not_subscription';
  if (session.metadata?.[CHECKOUT_LINK_SUPERSEDED_KEY]) return 'skipped:superseded';
  const early = sessionTarget(session);
  if (!early) return 'skipped:bad_metadata';

  const ctx = await store.loadContext(early.userId, new Date(session.created * 1000));
  const decision = decide(session, ctx, now);
  if (decision.kind === 'skip') return `skipped:${decision.reason}`;

  const { target } = decision;
  const template = templateFor(target.planId, target.interval);
  const email = ctx.owner!.email!.trim();

  if (mode === 'dry_run') return decision.kind === 'holdout' ? 'would_holdout' : 'would_send';

  const composed = decision.kind === 'send'
    ? composeAbandonedCheckout({
      planId: target.planId,
      interval: target.interval,
      locale: target.locale,
      resumeUrl: resumeUrl(target.planId, target.interval, target.locale, session.id),
      unsubscribeToken: ctx.owner!.unsubscribeToken,
    })
    : null;
  if (decision.kind === 'send' && !composed) return 'not_composable';

  // Both arms claim the same way, so the duplicate check below covers both and
  // a holdout row is exactly as countable as a sent one.
  const key = { userId: target.userId, template, triggerKey: session.id };
  const won = await store.claim({ ...key, email, status: 'claimed', detail: null });
  if (!won) return 'lost_claim';

  // Two sessions of the same user expiring together both win their own claim.
  // Only the earliest one counts.
  const winner = winningClaim(await store.readRows(target.userId), now);
  if (winner && winner.triggerKey !== session.id) {
    await store.finish(key, { status: 'skipped', detail: 'duplicate' });
    return 'duplicate';
  }

  if (decision.kind === 'holdout' || !composed) {
    await store.finish(key, { status: 'skipped', detail: 'holdout' });
    return 'holdout';
  }

  let result: SendResult;
  try {
    result = await options.send({
      to: email,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      headers: composed.headers,
      idempotencyKey: `${TEMPLATE_PREFIX}-${session.id}`,
    });
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
  }

  if (result.ok) {
    await store.finish(key, { status: 'sent', providerId: result.id });
    return 'sent';
  }
  await store.finish(key, { status: 'failed', detail: result.reason });
  return 'failed';
}

/**
 * A checkout completed. Credit this user's newest reminder row (sent or
 * holdout) from the last 30 days that is not already credited.
 */
export async function recordRecovery(options: {
  userId: string;
  completedSessionId: string;
  recoveredFrom: string | null;
  store: ReminderStore;
  now?: Date;
}): Promise<'recovered' | 'none'> {
  const now = options.now ?? new Date();
  const windowStart = now.getTime() - RECOVERY_WINDOW_MS;
  const rows = (await options.store.readRows(options.userId))
    .filter((r) => !r.recoveredAt && ms(r.sentAt) >= windowStart)
    .filter((r) => r.status === 'sent' || (r.status === 'skipped' && r.detail === 'holdout'))
    .sort((a, b) => ms(b.sentAt) - ms(a.sentAt));

  // Prefer the row the link came from, if it is one of them.
  const row = rows.find((r) => r.triggerKey === options.recoveredFrom) ?? rows[0];
  if (!row) return 'none';
  await options.store.markRecovered(
    { userId: options.userId, template: row.template, triggerKey: row.triggerKey },
    { at: now.toISOString(), sessionId: options.completedSessionId, viaLink: row.triggerKey === options.recoveredFrom },
  );
  return 'recovered';
}

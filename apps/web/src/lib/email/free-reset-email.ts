/**
 * The monthly "your Free actions reset" email (owner decision 2026-11-11).
 *
 * WHO. The owner of a Free workspace that the Free monthly action allowance
 * refused on 2 or more distinct UTC days in the previous UTC calendar month
 * (`usage_limit_events`, limit_kind 'actions'), checked at send time:
 *   - workspace exists, not deleted, plan 'free', and metered: the
 *     workspace_action_allowance row says plan 'free', not exempt, with a cap
 *   - the owner has no active / trialing / past_due / unpaid subscription
 *   - not one of ours, usable address, working unsubscribe token, not
 *     unsubscribed globally or from 'lifecycle'
 *   - nothing for this owner and month in the ledger yet
 *
 * WHAT. The arm comes from lifecycle-region.ts: consented and soft_opt_in
 * owners get the Personal line (and the 3-month pass line when the pass
 * experiment shows it for the workspace); service_notice owners (European or
 * unknown, no consent) get the facts only. Copy: free-reset-email-template.ts.
 *
 * HOLDOUT. 20% of workspaces (salted hash of the workspace id) get a
 * 'holdout' row and no email. Read-out, per month:
 *
 *   SELECT detail AS arm, status, count(*) FROM lifecycle_email_sends
 *    WHERE template = 'free_reset' AND trigger_key = '2026-12'
 *      AND status IN ('sent', 'holdout') GROUP BY 1, 2;
 *
 * joined to checkout_completed for the owner's workspaces in that month.
 *
 * IDEMPOTENT. Ledger key (user_id, 'free_reset', 'YYYY-MM'): once per owner
 * per month whatever number of workspaces qualify (the one refused on the
 * most days claims first). The claim is INSERT ... ON CONFLICT DO NOTHING
 * before the send; a claimed or failed row is never retried. Resend's
 * Idempotency-Key covers a lost response.
 *
 * WHEN. pg_cron on the 2nd of each month at 07:05 UTC (with two catch-up runs
 * later that morning; each one only picks up what the ledger does not have).
 * Outside days 2 to 7 of a month the run sends nothing, so a late manual call
 * cannot say "reset on the 1st" weeks later.
 *
 * SWITCHES. LIFECYCLE_EXPANSION_START_AT must be set and in the past, or the
 * route returns before reading anything. Until LIFECYCLE_EXPANSION_DRY_RUN is
 * exactly `false` it is a dry run: decided and counted, nothing written or
 * sent.
 */

import { createHash } from 'node:crypto';

import { composeFreeReset } from '@/lib/email/free-reset-email-template';
import type { PaywallPassLine } from '@/lib/email/paywall-followup-templates';
import {
  expansionCovers,
  lifecycleArm,
  mayPromote,
  ownerRegion,
  type ExpansionConfig,
  type LifecycleArm,
} from '@/lib/email/lifecycle-region';

export const TEMPLATE = 'free_reset';
export const HOLDOUT_PERCENT = 20;
export const MIN_REFUSED_DAYS = 2;
/** The run sends only on these days of the month (UTC). */
export const FIRST_SEND_DAY = 2;
export const LAST_SEND_DAY = 7;
export const DEFAULT_MAX_SENDS = 100;

const SUBSCRIBED_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isHoldout(workspaceId: string): boolean {
  const digest = createHash('sha256').update(`free_reset:v1:${workspaceId}`).digest();
  return digest.readUInt32BE(0) % 100 < HOLDOUT_PERCENT;
}

export function anonymise(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

/** The previous UTC calendar month: [start, end) and its 'YYYY-MM' key. */
export function previousMonth(now: Date): { key: string; start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { key, start, end };
}

export interface LimitEventRow {
  workspace_id: string;
  occurred_at: string;
}

/** Distinct UTC days with a refusal, per workspace. Pure. */
export function refusedDaysByWorkspace(rows: LimitEventRow[]): Map<string, number> {
  const days = new Map<string, Set<string>>();
  for (const r of rows) {
    const t = new Date(r.occurred_at);
    if (!Number.isFinite(t.getTime())) continue;
    const set = days.get(r.workspace_id) ?? new Set<string>();
    set.add(t.toISOString().slice(0, 10));
    days.set(r.workspace_id, set);
  }
  return new Map([...days].map(([id, set]) => [id, set.size]));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Candidate {
  workspaceId: string;
  refusedDays: number;
}

export interface LedgerRow {
  triggerKey: string;
  status: string;
}

export interface CandidateContext extends Candidate {
  workspace: { ownerId: string; plan: string; deletedAt: string | null } | null;
  /** From workspace_action_allowance; null when it could not be read. */
  allowance: { plan: string; exempt: boolean; cap: number | null } | null;
  owner: {
    id: string;
    email: string | null;
    marketingConsentAt: string | null;
    unsubscribedAt: string | null;
    unsubscribedCategories: string[];
    unsubscribeToken: string | null;
  } | null;
  subscriptionStatus: string | null;
  internal: boolean;
  ownerCountries: Array<string | null>;
  /** This owner's free_reset rows, any month. */
  ledger: LedgerRow[];
}

export type SkipReason =
  | 'not_started'
  | 'outside_send_days'
  | 'too_few_days'
  | 'workspace_missing'
  | 'workspace_deleted'
  | 'owner_missing'
  | 'internal'
  | 'not_free'
  | 'subscribed'
  | 'allowance_unknown'
  | 'not_metered'
  | 'unsubscribed'
  | 'unsubscribed_lifecycle'
  | 'no_unsubscribe_token'
  | 'unusable_email'
  | 'already_this_month';

export type Decision =
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'holdout' | 'send'; arm: LifecycleArm };

function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** Pure. Everything that decides whether this workspace's owner gets the email this month. */
export function decide(ctx: CandidateContext, now: Date, monthKey: string, expansion: ExpansionConfig): Decision {
  if (!expansionCovers(expansion, now.getTime())) return { kind: 'skip', reason: 'not_started' };
  const day = now.getUTCDate();
  if (day < FIRST_SEND_DAY || day > LAST_SEND_DAY) return { kind: 'skip', reason: 'outside_send_days' };
  if (!(ctx.refusedDays >= MIN_REFUSED_DAYS)) return { kind: 'skip', reason: 'too_few_days' };

  const w = ctx.workspace;
  if (!w) return { kind: 'skip', reason: 'workspace_missing' };
  if (w.deletedAt) return { kind: 'skip', reason: 'workspace_deleted' };
  const owner = ctx.owner;
  if (!owner || owner.id !== w.ownerId) return { kind: 'skip', reason: 'owner_missing' };
  if (ctx.internal) return { kind: 'skip', reason: 'internal' };

  if (w.plan !== 'free') return { kind: 'skip', reason: 'not_free' };
  if (ctx.subscriptionStatus && SUBSCRIBED_STATUSES.has(ctx.subscriptionStatus)) return { kind: 'skip', reason: 'subscribed' };
  if (!ctx.allowance) return { kind: 'skip', reason: 'allowance_unknown' };
  if (ctx.allowance.exempt || ctx.allowance.plan !== 'free' || ctx.allowance.cap == null) {
    return { kind: 'skip', reason: 'not_metered' };
  }

  if (owner.unsubscribedAt) return { kind: 'skip', reason: 'unsubscribed' };
  if ((owner.unsubscribedCategories ?? []).includes('lifecycle')) return { kind: 'skip', reason: 'unsubscribed_lifecycle' };
  if (!owner.unsubscribeToken) return { kind: 'skip', reason: 'no_unsubscribe_token' };
  if (!owner.email || !EMAIL_RE.test(owner.email.trim())) return { kind: 'skip', reason: 'unusable_email' };

  if (ctx.ledger.some((r) => r.triggerKey === monthKey)) return { kind: 'skip', reason: 'already_this_month' };

  const arm = lifecycleArm({
    consented: Number.isFinite(ms(owner.marketingConsentAt)),
    region: ownerRegion(ctx.ownerCountries ?? []),
  });
  return { kind: isHoldout(ctx.workspaceId) ? 'holdout' : 'send', arm };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ClaimRow {
  userId: string;
  monthKey: string;
  email: string;
  status: 'claimed' | 'holdout';
  detail: string;
}

export interface FreeResetStore {
  /** Workspaces with an 'actions' limit event in [start, end), with their refused days. */
  listCandidates(start: Date, end: Date): Promise<Candidate[]>;
  loadContexts(candidates: Candidate[]): Promise<CandidateContext[]>;
  /** INSERT ... ON CONFLICT (user_id, template, trigger_key) DO NOTHING. True when this call created the row. */
  claim(row: ClaimRow): Promise<boolean>;
  finish(
    key: { userId: string; monthKey: string },
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string },
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

export type RunMode = 'dry_run' | 'send';

export interface RunOptions {
  store: FreeResetStore;
  send?: Sender;
  mode: RunMode;
  expansion: ExpansionConfig;
  now?: Date;
  maxSends?: number;
  outOfTime?: () => boolean;
  /** Promotional arms, live sends only: the pass line, or null. Must not throw. */
  passOffer?: (workspaceId: string, now: Date) => Promise<PaywallPassLine | null>;
  onPassOfferShown?: (workspaceId: string) => Promise<void>;
}

export interface RunEntry {
  workspace: string;
  refusedDays: number;
  decision: Decision['kind'];
  arm: LifecycleArm | null;
  reason: SkipReason | null;
  outcome: 'sent' | 'failed' | 'lost_claim' | 'holdout_recorded' | 'would_send' | 'would_hold_out' | 'none';
}

export interface RunReport {
  mode: RunMode;
  month: string;
  candidates: number;
  sent: number;
  failed: number;
  heldOut: number;
  lostClaims: number;
  wouldSend: number;
  wouldHoldOut: number;
  byArm: Record<LifecycleArm, number>;
  skipped: Record<string, number>;
  truncated: boolean;
  entries: RunEntry[];
}

export async function runFreeReset(options: RunOptions): Promise<RunReport> {
  const { store } = options;
  const now = options.now ?? new Date();
  const maxSends = options.maxSends ?? DEFAULT_MAX_SENDS;
  // Sending needs both the caller's send mode and the expansion switch.
  const mode: RunMode = options.mode === 'send' && options.expansion.live ? 'send' : 'dry_run';
  if (mode === 'send' && !options.send) throw new Error('mode "send" needs a sender');
  const month = previousMonth(now);

  const report: RunReport = {
    mode,
    month: month.key,
    candidates: 0,
    sent: 0,
    failed: 0,
    heldOut: 0,
    lostClaims: 0,
    wouldSend: 0,
    wouldHoldOut: 0,
    byArm: { consented: 0, soft_opt_in: 0, service_notice: 0 },
    skipped: {},
    truncated: false,
    entries: [],
  };

  // Nothing is read before the switches allow it.
  if (!expansionCovers(options.expansion, now.getTime())) {
    report.skipped.not_started = 1;
    return report;
  }

  const candidates = (await options.store.listCandidates(month.start, month.end))
    .filter((c) => c.refusedDays >= MIN_REFUSED_DAYS)
    // Most refused days first, so the owner's hardest-hit workspace claims.
    .sort((a, b) => b.refusedDays - a.refusedDays || (a.workspaceId < b.workspaceId ? -1 : 1));
  const contexts = await store.loadContexts(candidates);
  report.candidates = contexts.length;

  for (const ctx of contexts) {
    if (options.outOfTime?.()) {
      report.truncated = true;
      break;
    }
    const decision = decide(ctx, now, month.key, options.expansion);
    const entry: RunEntry = {
      workspace: anonymise(ctx.workspaceId),
      refusedDays: ctx.refusedDays,
      decision: decision.kind,
      arm: decision.kind === 'skip' ? null : decision.arm,
      reason: decision.kind === 'skip' ? decision.reason : null,
      outcome: 'none',
    };
    report.entries.push(entry);

    if (decision.kind === 'skip') {
      report.skipped[decision.reason] = (report.skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    const owner = ctx.owner!;
    const email = owner.email!.trim();

    if (decision.kind === 'holdout') {
      if (mode === 'dry_run') {
        report.wouldHoldOut += 1;
        entry.outcome = 'would_hold_out';
        continue;
      }
      const won = await store.claim({ userId: owner.id, monthKey: month.key, email, status: 'holdout', detail: decision.arm });
      if (won) {
        report.heldOut += 1;
        entry.outcome = 'holdout_recorded';
      } else {
        report.lostClaims += 1;
        entry.outcome = 'lost_claim';
      }
      continue;
    }

    if (mode === 'dry_run') {
      report.wouldSend += 1;
      report.byArm[decision.arm] += 1;
      entry.outcome = 'would_send';
      continue;
    }
    if (report.sent + report.failed >= maxSends) {
      report.truncated = true;
      break;
    }

    let pass: PaywallPassLine | null = null;
    if (mayPromote(decision.arm) && options.passOffer) {
      try {
        pass = await options.passOffer(ctx.workspaceId, now);
      } catch {
        pass = null;
      }
    }
    const composed = composeFreeReset({
      arm: decision.arm,
      refusedDays: ctx.refusedDays,
      resetOn: month.end,
      unsubscribeToken: owner.unsubscribeToken,
      pass,
    });
    if (!composed) {
      report.skipped.not_composable = (report.skipped.not_composable ?? 0) + 1;
      continue;
    }

    const won = await store.claim({ userId: owner.id, monthKey: month.key, email, status: 'claimed', detail: decision.arm });
    if (!won) {
      report.lostClaims += 1;
      entry.outcome = 'lost_claim';
      continue;
    }

    let result: SendResult;
    try {
      result = await options.send!({
        to: email,
        subject: composed.subject,
        text: composed.text,
        html: composed.html,
        headers: composed.headers,
        idempotencyKey: `${TEMPLATE}-${month.key}-${owner.id}`,
      });
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
    }

    const key = { userId: owner.id, monthKey: month.key };
    if (result.ok) {
      await store.finish(key, { status: 'sent', providerId: result.id });
      report.sent += 1;
      report.byArm[decision.arm] += 1;
      entry.outcome = 'sent';
      if (pass && options.onPassOfferShown) {
        try {
          await options.onPassOfferShown(ctx.workspaceId);
        } catch {
          // Analytics only.
        }
      }
    } else {
      await store.finish(key, { status: 'failed', detail: result.reason });
      report.failed += 1;
      entry.outcome = 'failed';
    }
  }

  return report;
}

/** FREE_RESET_EMAIL_MAX_PER_RUN, clamped to 1..500, default DEFAULT_MAX_SENDS. */
export function freeResetMaxPerRun(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.FREE_RESET_EMAIL_MAX_PER_RUN ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_SENDS;
  return Math.min(500, Math.max(1, n));
}

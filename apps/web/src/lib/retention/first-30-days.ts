/**
 * The first 30 paid days: who gets which retention message, when, and once.
 * Approved plan: Documents/plans/first-30-days-20261024.md, sections M2 + M3.
 *
 * TWO MESSAGES, BOTH CLOCKED FROM THE WORKSPACE'S FIRST EVER
 * `product_funnel_events.stage = 'checkout_completed'` (a plan change does not
 * restart it):
 *
 *   M2  retention_stuck_note     72 hours after paying, zero successful tool
 *                                calls since paying. NOT sent to the customer:
 *                                a ready-to-send draft is saved in Asgeir's own
 *                                mailbox (or, if that fails, an internal notice
 *                                with the draft goes to that mailbox). No
 *                                holdout: a customer with a broken setup is
 *                                never left alone to protect a test.
 *   M3  retention_week1_summary  day 8, an activity report on days 0 to 7,
 *                                only when there was at least one successful
 *                                call in that week. 50% holdout through the
 *                                experiments tables (key first30_week1_summary).
 *
 * Copy lives in first-30-days-templates.ts, the database adapter in
 * first-30-days-store.ts, the IMAP draft writer in first-30-days-draft.ts and
 * the cron entry point in app/api/internal/first-30-days/dispatch/route.ts.
 * This file is pure decision logic plus the run loop, with the store and the
 * senders injected, so every rule is covered by first-30-days.test.ts without
 * a network. Same shape as src/lib/email/paywall-followup.ts.
 *
 * SHARED RULES, CHECKED AT SEND TIME (re-read immediately before acting):
 *   - workspace exists and is not soft-deleted, the person is its owner
 *   - owner is not internal (internal_accounts, GROWTH_INTERNAL_EMAILS, our
 *     own domains)
 *   - owner's user_billing.subscription_status is active or trialing
 *   - owner has a usable address
 *   - the ledger row for (owner, template, workspace) does not exist
 *   - the first payment is on or after the go-live date, so nothing is ever
 *     backfilled to older customers
 * Day-0 cancellers (cancel_at set) still get both: a service report, not a
 * save attempt (plan section 3).
 *
 * M3 ONLY: not globally unsubscribed, 'activity_summary' not in
 * unsubscribed_categories, an unsubscribe token exists. marketing_consent_at
 * is deliberately NOT required (plan 1h): this is a report on the paid
 * service, not marketing.
 *
 * IDEMPOTENCY. `lifecycle_email_sends`, primary key (user_id, template,
 * trigger_key), trigger_key = workspace id. A 'claimed' row is inserted with
 * ON CONFLICT DO NOTHING before anything is written or sent; only the winner
 * acts. The row ends 'sent' (detail says how, for M2) or 'failed'. Never
 * retried. The M3 holdout is a 'skipped' row with detail 'holdout', so the
 * readout is one query on this table plus experiment_assignments.
 */

import { hashUnit, pickVariant } from '@/lib/experiments/bucketing';
import type { ExperimentVariant } from '@/lib/experiments/constants';
import {
  ACTIVITY_SUMMARY_CATEGORY,
  composeStuckNote,
  composeWeek1Summary,
  firstNameFrom,
  week1Tip,
  type ComposedStuckNote,
  type Week1Counts,
} from '@/lib/retention/first-30-days-templates';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TEMPLATE_STUCK = 'retention_stuck_note';
export const TEMPLATE_WEEK1 = 'retention_week1_summary';
export type RetentionTemplate = typeof TEMPLATE_STUCK | typeof TEMPLATE_WEEK1;
export const RETENTION_TEMPLATES: readonly RetentionTemplate[] = [TEMPLATE_STUCK, TEMPLATE_WEEK1];

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** M2: due 72 hours after paying, never later than day 7 (M3 takes over). */
export const STUCK_DUE_MS = 72 * HOUR;
export const STUCK_WINDOW_END_MS = 7 * DAY;

/** M3: the reported week is [paidAt, paidAt + 7 days). */
export const WEEK1_LENGTH_MS = 7 * DAY;
/** M3: due on day 8, at 09:00 UTC (owner time zones are not stored). */
export const WEEK1_DUE_MS = 8 * DAY;
export const WEEK1_SEND_HOUR_UTC = 9;
/** M3: a missed cron still sends until day 10, never after. */
export const WEEK1_WINDOW_END_MS = 10 * DAY;

/** Payments older than this are never read: past every window. */
export const CANDIDATE_MAX_AGE_MS = WEEK1_WINDOW_END_MS + DAY;

/**
 * The go-live date. Only first payments on or after it are considered, so the
 * feature never backfills customers who paid before it existed. Override with
 * FIRST30_START_AT (an ISO timestamp).
 */
export const DEFAULT_START_AT = '2026-10-25T00:00:00.000Z';

export const HOLDOUT_EXPERIMENT_KEY = 'first30_week1_summary';
export const VARIANT_HOLDOUT = 'holdout';
export const VARIANT_SUMMARY = 'summary';
/** Mirrors the row seeded by 20261024170000_first_30_days.sql. variants[0] is the control. */
export const HOLDOUT_VARIANTS: ExperimentVariant[] = [
  { id: VARIANT_HOLDOUT, label: 'No week-1 summary email', weight: 50 },
  { id: VARIANT_SUMMARY, label: 'Week-1 summary email', weight: 50 },
];

/** Entitled for these messages. Narrower than checkout-core: no past_due, no unpaid. */
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LedgerRow {
  template: string;
  triggerKey: string;
  status: string;
  detail: string | null;
  sentAt: string;
  finishedAt: string | null;
}

export interface FirstPayment {
  workspaceId: string;
  firstPaidAt: string;
}

export interface CandidateContext extends FirstPayment {
  workspace: { ownerId: string; deletedAt: string | null } | null;
  owner: {
    id: string;
    email: string | null;
    displayName: string | null;
    unsubscribedAt: string | null;
    unsubscribedCategories: string[];
    unsubscribeToken: string | null;
  } | null;
  subscriptionStatus: string | null;
  internal: boolean;
  /** Successful activity_log rows from the first payment until now. */
  successSincePaid: number;
  /** This owner's retention_* rows for THIS workspace. */
  ledger: LedgerRow[];
}

/** What the stuck note is filled with. Loaded only when M2 is due. */
export interface StuckDetails {
  totalCalls: number;
  topErrorCodes: Array<{ code: string; count: number }>;
  clientNames: string[];
  inboxProviders: string[];
}

/** What the week-1 summary is filled with. Loaded only when M3 is due. */
export interface Week1Stats {
  counts: Week1Counts;
  totalSuccess: number;
  activeDays: number;
  automationsSorted: number;
  hasAutomation: boolean;
  inboxAddresses: string[];
}

export type StopReason =
  | 'before_go_live'
  | 'workspace_missing'
  | 'workspace_deleted'
  | 'owner_missing'
  | 'internal'
  | 'not_subscribed'
  | 'unusable_email'
  | 'unsubscribed'
  | 'unsubscribed_activity_summary'
  | 'no_unsubscribe_token'
  | 'not_stuck'
  | 'no_week1_activity'
  | 'window_missed'
  | 'experiment_unavailable'
  | 'not_composable';

export type Decision =
  | { kind: 'send' }
  | { kind: 'wait'; dueAt: string }
  | { kind: 'stop'; reason: StopReason }
  | { kind: 'done'; status: string };

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

export interface CheckoutEventRow {
  workspace_id: string;
  occurred_at: string;
}

/**
 * The FIRST EVER checkout_completed of each workspace, given the rows inside
 * the look-back window and the workspaces that also have one BEFORE it (those
 * are dropped: their first payment is older than the window). Pure.
 */
export function pickFirstPayments(recent: CheckoutEventRow[], earlier: ReadonlySet<string>): FirstPayment[] {
  const first = new Map<string, FirstPayment>();
  const sorted = [...recent].sort((a, b) => ms(a.occurred_at) - ms(b.occurred_at));
  for (const row of sorted) {
    if (earlier.has(row.workspace_id) || first.has(row.workspace_id)) continue;
    first.set(row.workspace_id, { workspaceId: row.workspace_id, firstPaidAt: row.occurred_at });
  }
  return [...first.values()];
}

// ---------------------------------------------------------------------------
// The decisions
// ---------------------------------------------------------------------------

export function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** The first 09:00 UTC at or after `fromMs`. */
export function nextSendHour(fromMs: number): number {
  const d = new Date(fromMs);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WEEK1_SEND_HOUR_UTC);
  return at >= fromMs ? at : at + DAY;
}

/** The rules both messages share. Exported for the tests. */
export function sharedIneligibility(ctx: CandidateContext, startAtMs: number): StopReason | null {
  if (!(ms(ctx.firstPaidAt) >= startAtMs)) return 'before_go_live';
  if (!ctx.workspace) return 'workspace_missing';
  if (ctx.workspace.deletedAt) return 'workspace_deleted';
  const owner = ctx.owner;
  if (!owner || owner.id !== ctx.workspace.ownerId) return 'owner_missing';
  if (ctx.internal) return 'internal';
  if (!ctx.subscriptionStatus || !ACTIVE_STATUSES.has(ctx.subscriptionStatus)) return 'not_subscribed';
  if (!owner.email || !EMAIL_RE.test(owner.email.trim()) || /[\r\n]/.test(owner.email)) return 'unusable_email';
  return null;
}

function ledgerRow(ctx: CandidateContext, template: RetentionTemplate): LedgerRow | undefined {
  return ctx.ledger.find((r) => r.template === template && r.triggerKey === ctx.workspaceId);
}

/**
 * M2. Order: ledger, go-live, timing, eligibility, the stuck test, the
 * window. Pure.
 */
export function decideStuck(ctx: CandidateContext, now: Date, startAtMs: number): Decision {
  const row = ledgerRow(ctx, TEMPLATE_STUCK);
  if (row) return { kind: 'done', status: row.status };

  const paidMs = ms(ctx.firstPaidAt);
  if (!(paidMs >= startAtMs)) return { kind: 'stop', reason: 'before_go_live' };
  const dueMs = paidMs + STUCK_DUE_MS;
  if (now.getTime() < dueMs) return { kind: 'wait', dueAt: new Date(dueMs).toISOString() };

  const reason = sharedIneligibility(ctx, startAtMs);
  if (reason) return { kind: 'stop', reason };
  if (ctx.successSincePaid > 0) return { kind: 'stop', reason: 'not_stuck' };
  if (now.getTime() > paidMs + STUCK_WINDOW_END_MS) return { kind: 'stop', reason: 'window_missed' };
  return { kind: 'send' };
}

/**
 * M3, the part that needs no activity numbers: ledger, go-live, timing,
 * eligibility, opt-out, window. The week-1 gate is week1Gate(), applied once
 * the stats are loaded. Pure.
 */
export function decideWeek1(ctx: CandidateContext, now: Date, startAtMs: number): Decision {
  const row = ledgerRow(ctx, TEMPLATE_WEEK1);
  if (row) return { kind: 'done', status: row.status };

  const paidMs = ms(ctx.firstPaidAt);
  if (!(paidMs >= startAtMs)) return { kind: 'stop', reason: 'before_go_live' };
  const dueMs = nextSendHour(paidMs + WEEK1_DUE_MS);
  if (now.getTime() < dueMs) return { kind: 'wait', dueAt: new Date(dueMs).toISOString() };

  const reason = sharedIneligibility(ctx, startAtMs) ?? week1OptOut(ctx);
  if (reason) return { kind: 'stop', reason };
  if (now.getTime() > paidMs + WEEK1_WINDOW_END_MS) return { kind: 'stop', reason: 'window_missed' };
  return { kind: 'send' };
}

function week1OptOut(ctx: CandidateContext): StopReason | null {
  const owner = ctx.owner!;
  if (owner.unsubscribedAt) return 'unsubscribed';
  if ((owner.unsubscribedCategories ?? []).includes(ACTIVITY_SUMMARY_CATEGORY)) return 'unsubscribed_activity_summary';
  if (!owner.unsubscribeToken || !owner.unsubscribeToken.trim()) return 'no_unsubscribe_token';
  return null;
}

/** M3 needs at least one successful call in days 0 to 7. With none, M2 covered it. */
export function week1Gate(stats: Week1Stats): StopReason | null {
  return stats.totalSuccess >= 1 ? null : 'no_week1_activity';
}

/** The variant the local hash proposes. The stored assignment, if any, wins. */
export function proposedVariant(workspaceId: string): string {
  return pickVariant(HOLDOUT_VARIANTS, hashUnit(subjectIdFor(workspaceId), HOLDOUT_EXPERIMENT_KEY));
}

/** experiment_assignments.subject_id must be 32 lowercase hex: a uuid without dashes is exactly that. */
export function subjectIdFor(workspaceId: string): string {
  return workspaceId.replace(/-/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ClaimRow {
  userId: string;
  workspaceId: string;
  template: RetentionTemplate;
  email: string;
  status: 'claimed' | 'skipped';
  detail: string | null;
}

export type FinishOutcome =
  | { status: 'sent'; providerId: string | null; detail: string | null }
  | { status: 'failed'; detail: string };

export interface First30Store {
  /** Workspaces whose FIRST EVER checkout_completed is at or after `since`. */
  listFirstPayments(since: Date): Promise<FirstPayment[]>;
  loadContexts(firsts: FirstPayment[]): Promise<CandidateContext[]>;
  loadStuckDetails(ctx: CandidateContext): Promise<StuckDetails>;
  loadWeek1Stats(ctx: CandidateContext): Promise<Week1Stats>;
  /**
   * Record the holdout assignment and return the STORED variant (sticky), or
   * null when the experiment cannot be read. Null fails closed: no email.
   */
  assignVariant(workspaceId: string, proposed: string): Promise<string | null>;
  /** INSERT ... ON CONFLICT DO NOTHING. True only for the caller whose insert created the row. */
  claim(row: ClaimRow): Promise<boolean>;
  finish(key: { userId: string; workspaceId: string; template: RetentionTemplate }, outcome: FinishOutcome): Promise<void>;
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

/** The stuck note, handed to whatever puts it in front of Asgeir. */
export interface StuckDraft {
  to: string;
  note: ComposedStuckNote;
  workspaceId: string;
  idempotencyKey: string;
}

/** `via` names the path that worked, e.g. 'imap_draft' or 'internal_notice'. */
export type DraftResult = { ok: true; via: string; id: string | null } | { ok: false; reason: string };
export type DraftWriter = (draft: StuckDraft) => Promise<DraftResult>;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type RunMode = 'dry_run' | 'send';

export interface RunOptions {
  store: First30Store;
  mode: RunMode;
  /** Required for mode 'send'. Never called in dry_run. */
  send?: Sender;
  /** Required for mode 'send'. Never called in dry_run. */
  writeDraft?: DraftWriter;
  now?: Date;
  startAt?: Date;
  maxActions?: number;
  outOfTime?: () => boolean;
  /**
   * Dry run only: called once per candidate decision, after it is final.
   * Never called in mode 'send'. Carries no email address, only whether the
   * would-be recipient still matches the workspace owner.
   */
  onDecision?: (record: DecisionRecord) => void;
}

export type LoggedDecision = 'would_draft' | 'would_send' | 'would_holdout' | 'wait' | 'done' | 'stop';

/** One dry-run decision, as first30_dry_run_log stores it. No address, no copy. */
export interface DecisionRecord {
  workspaceId: string;
  template: RetentionTemplate;
  decision: LoggedDecision;
  reason: string | null;
  firstPaidAt: string;
  /** would_* only: the recipient equals the workspace owner's address on a fresh read. */
  recipientMatchesOwner: boolean | null;
  /** would_* only: on that fresh read. */
  ownerInternal: boolean | null;
  /** would_* only: on that fresh read, active or trialing. */
  subscriptionActive: boolean | null;
}

type Verified = Pick<DecisionRecord, 'recipientMatchesOwner' | 'ownerInternal' | 'subscriptionActive'>;

/**
 * For a would-draft / would-send: re-read the workspace, as send mode does
 * right before acting, and compare the would-be recipient with the owner's
 * current address. Returns booleans only.
 */
async function verifyRecipient(store: First30Store, ctx: CandidateContext, to: string): Promise<Verified> {
  const [fresh] = await store.loadContexts([{ workspaceId: ctx.workspaceId, firstPaidAt: ctx.firstPaidAt }]);
  if (!fresh || !fresh.workspace || !fresh.owner) {
    return { recipientMatchesOwner: false, ownerInternal: null, subscriptionActive: false };
  }
  const freshEmail = (fresh.owner.email ?? '').trim().toLowerCase();
  return {
    recipientMatchesOwner:
      fresh.owner.id === fresh.workspace.ownerId &&
      fresh.owner.id === ctx.owner?.id &&
      freshEmail !== '' &&
      freshEmail === to.trim().toLowerCase(),
    ownerInternal: fresh.internal,
    subscriptionActive: !!fresh.subscriptionStatus && ACTIVE_STATUSES.has(fresh.subscriptionStatus),
  };
}

export type Message = 'stuck_note' | 'week1_summary';

export interface RunEntry {
  workspace: string;
  message: Message;
  paidHoursAgo: number;
  decision: Decision['kind'];
  reason: string | null;
  variant: string | null;
  tip: string | null;
  outcome:
    | 'sent'
    | 'drafted'
    | 'failed'
    | 'lost_claim'
    | 'holdout_recorded'
    | 'would_send'
    | 'would_draft'
    | 'would_holdout'
    | 'none';
}

export interface RunReport {
  mode: RunMode;
  startAt: string;
  candidates: number;
  drafted: number;
  sent: number;
  failed: number;
  holdout: number;
  lostClaims: number;
  wouldDraft: number;
  wouldSend: number;
  wouldHoldout: number;
  waiting: number;
  stopped: Record<string, number>;
  done: number;
  truncated: boolean;
  entries: RunEntry[];
}

export const DEFAULT_MAX_ACTIONS = 20;

export async function runFirst30(options: RunOptions): Promise<RunReport> {
  const { store, mode } = options;
  const now = options.now ?? new Date();
  const startAtMs = (options.startAt ?? new Date(DEFAULT_START_AT)).getTime();
  const maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  if (mode === 'send' && (!options.send || !options.writeDraft)) {
    throw new Error('mode "send" needs a sender and a draft writer');
  }

  const report: RunReport = {
    mode,
    startAt: new Date(startAtMs).toISOString(),
    candidates: 0,
    drafted: 0,
    sent: 0,
    failed: 0,
    holdout: 0,
    lostClaims: 0,
    wouldDraft: 0,
    wouldSend: 0,
    wouldHoldout: 0,
    waiting: 0,
    stopped: {},
    done: 0,
    truncated: false,
    entries: [],
  };

  // Never earlier than go-live: older payments are not even read.
  const since = Math.max(now.getTime() - CANDIDATE_MAX_AGE_MS, startAtMs);
  const firsts = await store.listFirstPayments(new Date(since));
  firsts.sort((a, b) => ms(a.firstPaidAt) - ms(b.firstPaidAt));
  const contexts = await store.loadContexts(firsts);
  report.candidates = contexts.length;

  const actions = () => report.drafted + report.sent + report.failed + report.holdout;
  const stop = (entry: RunEntry, reason: string) => {
    entry.decision = 'stop';
    entry.reason = reason;
    report.stopped[reason] = (report.stopped[reason] ?? 0) + 1;
  };

  outer: for (const initial of contexts) {
    for (const message of ['stuck_note', 'week1_summary'] as const) {
      if (options.outOfTime?.()) {
        report.truncated = true;
        break outer;
      }
      const decideFor = (c: CandidateContext) =>
        message === 'stuck_note' ? decideStuck(c, now, startAtMs) : decideWeek1(c, now, startAtMs);

      let ctx = initial;
      let decision = decideFor(ctx);

      // Re-read this workspace right before acting, so eligibility is checked
      // as close to the write as possible.
      if (decision.kind === 'send' && mode === 'send') {
        const [fresh] = await store.loadContexts([initial]);
        ctx = fresh ?? { ...initial, workspace: null };
        decision = decideFor(ctx);
      }

      let verified: Verified = { recipientMatchesOwner: null, ownerInternal: null, subscriptionActive: null };
      const entry: RunEntry = {
        workspace: ctx.workspaceId,
        message,
        paidHoursAgo: Math.round((now.getTime() - ms(ctx.firstPaidAt)) / HOUR),
        decision: decision.kind,
        reason: decision.kind === 'stop' ? decision.reason : decision.kind === 'done' ? decision.status : null,
        variant: null,
        tip: null,
        outcome: 'none',
      };

      try {
        if (decision.kind === 'wait') {
          report.waiting += 1;
          report.entries.push(entry);
          continue;
        }
        if (decision.kind === 'done') {
          report.done += 1;
          report.entries.push(entry);
          continue;
        }
        if (decision.kind === 'stop') {
          // Not-stuck and before-go-live are the normal state of nearly every
          // workspace on nearly every tick: counted, not listed.
          report.stopped[decision.reason] = (report.stopped[decision.reason] ?? 0) + 1;
          if (decision.reason !== 'not_stuck' && decision.reason !== 'before_go_live') report.entries.push(entry);
          continue;
        }
        report.entries.push(entry);

        if (mode === 'send' && actions() >= maxActions) {
          report.truncated = true;
          break outer;
        }

        const owner = ctx.owner!;
        const to = owner.email!.trim();
        const firstName = firstNameFrom(owner.displayName);

        // ---- M2 ------------------------------------------------------------
        if (message === 'stuck_note') {
          const details = await store.loadStuckDetails(ctx);
          const note = composeStuckNote({ firstName, paidAt: ctx.firstPaidAt, ...details });
          if (mode === 'dry_run') {
            report.wouldDraft += 1;
            entry.outcome = 'would_draft';
            if (options.onDecision) verified = await verifyRecipient(store, ctx, to);
            continue;
          }
          const won = await store.claim({
            userId: owner.id,
            workspaceId: ctx.workspaceId,
            template: TEMPLATE_STUCK,
            email: to,
            status: 'claimed',
            detail: null,
          });
          if (!won) {
            report.lostClaims += 1;
            entry.outcome = 'lost_claim';
            continue;
          }
          let result: DraftResult;
          try {
            result = await options.writeDraft!({
              to,
              note,
              workspaceId: ctx.workspaceId,
              idempotencyKey: `${TEMPLATE_STUCK}-${ctx.workspaceId}`,
            });
          } catch (err) {
            result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
          }
          const key = { userId: owner.id, workspaceId: ctx.workspaceId, template: TEMPLATE_STUCK } as const;
          if (result.ok) {
            await store.finish(key, { status: 'sent', providerId: result.id, detail: result.via });
            report.drafted += 1;
            entry.outcome = 'drafted';
          } else {
            await store.finish(key, { status: 'failed', detail: result.reason });
            report.failed += 1;
            entry.outcome = 'failed';
          }
          continue;
        }

        // ---- M3 ------------------------------------------------------------
        const stats = await store.loadWeek1Stats(ctx);
        const gate = week1Gate(stats);
        if (gate) {
          stop(entry, gate);
          continue;
        }
        entry.tip = week1Tip({ totalCalls: stats.totalSuccess, activeDays: stats.activeDays, hasAutomation: stats.hasAutomation });

        const paidMs = ms(ctx.firstPaidAt);
        const composed = composeWeek1Summary({
          firstName,
          from: ctx.firstPaidAt,
          to: new Date(paidMs + WEEK1_LENGTH_MS - 1).toISOString(),
          counts: stats.counts,
          automationsSorted: stats.automationsSorted,
          inboxAddresses: stats.inboxAddresses,
          totalCalls: stats.totalSuccess,
          activeDays: stats.activeDays,
          hasAutomation: stats.hasAutomation,
          unsubscribeToken: owner.unsubscribeToken,
        });

        const proposed = proposedVariant(ctx.workspaceId);
        if (mode === 'dry_run') {
          entry.variant = proposed;
          if (!composed) {
            stop(entry, 'not_composable');
          } else if (proposed === VARIANT_HOLDOUT) {
            report.wouldHoldout += 1;
            entry.outcome = 'would_holdout';
          } else {
            report.wouldSend += 1;
            entry.outcome = 'would_send';
          }
          if (composed && options.onDecision) verified = await verifyRecipient(store, ctx, to);
          continue;
        }

        if (!composed) {
          stop(entry, 'not_composable');
          continue;
        }

        const variant = await store.assignVariant(ctx.workspaceId, proposed);
        entry.variant = variant;
        if (variant === null) {
          stop(entry, 'experiment_unavailable');
          continue;
        }

        if (variant !== VARIANT_SUMMARY) {
          // The holdout gets nothing, and that is recorded once.
          const won = await store.claim({
            userId: owner.id,
            workspaceId: ctx.workspaceId,
            template: TEMPLATE_WEEK1,
            email: to,
            status: 'skipped',
            detail: 'holdout',
          });
          if (won) {
            report.holdout += 1;
            entry.outcome = 'holdout_recorded';
          } else {
            report.lostClaims += 1;
            entry.outcome = 'lost_claim';
          }
          continue;
        }

        const won = await store.claim({
          userId: owner.id,
          workspaceId: ctx.workspaceId,
          template: TEMPLATE_WEEK1,
          email: to,
          status: 'claimed',
          detail: null,
        });
        if (!won) {
          report.lostClaims += 1;
          entry.outcome = 'lost_claim';
          continue;
        }

        let result: SendResult;
        try {
          result = await options.send!({
            to,
            subject: composed.subject,
            text: composed.text,
            html: composed.html,
            headers: composed.headers,
            idempotencyKey: `${TEMPLATE_WEEK1}-${ctx.workspaceId}`,
          });
        } catch (err) {
          result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
        }
        const key = { userId: owner.id, workspaceId: ctx.workspaceId, template: TEMPLATE_WEEK1 } as const;
        if (result.ok) {
          await store.finish(key, { status: 'sent', providerId: result.id, detail: null });
          report.sent += 1;
          entry.outcome = 'sent';
        } else {
          await store.finish(key, { status: 'failed', detail: result.reason });
          report.failed += 1;
          entry.outcome = 'failed';
        }
      } finally {
        if (mode === 'dry_run' && options.onDecision) {
          const logged: LoggedDecision = entry.outcome.startsWith('would_')
            ? (entry.outcome as LoggedDecision)
            : entry.decision === 'send'
              ? 'stop'
              : entry.decision;
          options.onDecision({
            workspaceId: ctx.workspaceId,
            template: message === 'stuck_note' ? TEMPLATE_STUCK : TEMPLATE_WEEK1,
            decision: logged,
            reason: entry.reason,
            firstPaidAt: ctx.firstPaidAt,
            ...verified,
          });
        }
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Admin list: stuck payers
// ---------------------------------------------------------------------------

export interface StuckRow {
  workspaceId: string;
  ownerEmail: string | null;
  paidAt: string;
  topErrorCodes: Array<{ code: string; count: number }>;
  totalCalls: number;
  /** waiting (until dueAt), drafted, failed, would_draft, or a stop reason. */
  status: string;
  dueAt: string | null;
  detail: string | null;
}

/**
 * Every recent payer with zero successful calls since paying, with what M2
 * did or will do about them. Reads only; ignores go-live so the list is
 * useful before the switch is on.
 */
export async function listStuckPayers(store: First30Store, now: Date, lookbackMs = 14 * DAY): Promise<StuckRow[]> {
  const firsts = await store.listFirstPayments(new Date(now.getTime() - lookbackMs));
  const contexts = await store.loadContexts(firsts);
  const rows: StuckRow[] = [];
  for (const ctx of contexts) {
    if (ctx.successSincePaid > 0) continue;
    if (ctx.internal) continue;
    if (!ctx.workspace || ctx.workspace.deletedAt) continue;
    const details = await store.loadStuckDetails(ctx);
    const decision = decideStuck(ctx, now, 0);
    const ledger = ledgerRow(ctx, TEMPLATE_STUCK);
    let status: string;
    let dueAt: string | null = null;
    if (ledger) status = ledger.status === 'sent' ? 'drafted' : ledger.status;
    else if (decision.kind === 'wait') {
      status = 'waiting';
      dueAt = decision.dueAt;
    } else if (decision.kind === 'send') status = 'due';
    else if (decision.kind === 'stop') status = decision.reason;
    else status = 'done';
    rows.push({
      workspaceId: ctx.workspaceId,
      ownerEmail: ctx.owner?.email ?? null,
      paidAt: ctx.firstPaidAt,
      topErrorCodes: details.topErrorCodes,
      totalCalls: details.totalCalls,
      status,
      dueAt,
      detail: ledger?.detail ?? null,
    });
  }
  rows.sort((a, b) => ms(b.paidAt) - ms(a.paidAt));
  return rows;
}

// ---------------------------------------------------------------------------
// Switches, read at CALL time (a module-scope const is not a kill switch on
// Vercel; see src/lib/billing/lifecycle-mode.ts)
// ---------------------------------------------------------------------------

export type First30Mode = 'off' | RunMode;

/**
 *   FIRST30_ENABLED   must be exactly `on` (or `true`). Anything else,
 *                     including unset, is `off`: the route returns before
 *                     touching the database.
 *   FIRST30_DRY_RUN   dry run unless exactly `false` (or `off`).
 *
 * A real draft or email needs BOTH, and a typo in either fails towards silence.
 */
export function first30Mode(env: Record<string, string | undefined> = process.env): First30Mode {
  const enabled = (env.FIRST30_ENABLED ?? '').trim().toLowerCase();
  if (enabled !== 'on' && enabled !== 'true') return 'off';
  const dry = (env.FIRST30_DRY_RUN ?? '').trim().toLowerCase();
  return dry === 'false' || dry === 'off' ? 'send' : 'dry_run';
}

/** FIRST30_START_AT when it parses, else DEFAULT_START_AT. */
export function first30StartAt(env: Record<string, string | undefined> = process.env): Date {
  const raw = (env.FIRST30_START_AT ?? '').trim();
  const parsed = raw ? new Date(raw) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date(DEFAULT_START_AT);
}

/** FIRST30_MAX_PER_RUN, clamped to 1..100, default DEFAULT_MAX_ACTIONS. */
export function first30MaxPerRun(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.FIRST30_MAX_PER_RUN ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ACTIONS;
  return Math.min(100, Math.max(1, n));
}

/** The mailbox the stuck-note draft goes into. FIRST30_DRAFT_MAILBOX, default the founder's. */
export function first30DraftMailbox(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.FIRST30_DRAFT_MAILBOX ?? '').trim().toLowerCase();
  return raw && EMAIL_RE.test(raw) ? raw : 'asgeir@mcpemails.com';
}

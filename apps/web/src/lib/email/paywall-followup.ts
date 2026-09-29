/**
 * The paywall follow-up sequence: who gets which step, when, and exactly once.
 *
 * WHAT IT IS. Three lifecycle emails to the OWNER of a workspace after that
 * workspace's FIRST EVER `product_funnel_events.stage = 'paywall_reached'`:
 *
 *   step 1  ~1 hour after    what a second inbox makes possible
 *   step 2  ~3 days after    one concrete cross-inbox workflow
 *   step 3  ~7 days after    the plans side by side, monthly first
 *
 * Copy lives in paywall-followup-templates.ts; the database adapter in
 * paywall-followup-store.ts; the cron entry point in
 * app/api/internal/paywall-followup/dispatch/route.ts. This file is pure
 * decision logic plus the run loop, with the store and the sender injected, so
 * every rule below is covered by paywall-followup.test.ts without a network.
 *
 * NO MATERIALISED QUEUE. The candidate query is the state machine, evaluated
 * fresh on every run (same position as docs/PLAN-activation-lifecycle-email.md
 * section 5.3). A queued row would need a cancel path for every exit
 * condition; re-deriving from live tables means an exit condition only has to
 * be checked, never remembered.
 *
 * ELIGIBILITY IS CHECKED AT SEND TIME, FOR EVERY STEP. Any failure stops the
 * sequence:
 *   - users.marketing_consent_at IS NOT NULL (explicit opt-in; there is no
 *     soft opt-in here), and the first paywall happened AFTER that consent
 *   - not globally unsubscribed, and 'lifecycle' not in unsubscribed_categories
 *   - no active / trialing / past_due / unpaid subscription, workspace on Free
 *   - workspace exists and is not soft-deleted
 *   - owner is not one of ours (internal_accounts, GROWTH_INTERNAL_EMAILS,
 *     our own domains)
 *   - owner has a users.unsubscribe_token (no working opt-out, no email)
 *   - owner does not already have unlimited inboxes free (the grandfather
 *     entitlement), because step 1's premise would be false for them
 *   - owner is not already in this sequence for a different workspace
 *
 * IDEMPOTENCY. `lifecycle_email_sends`, primary key (user_id, template,
 * trigger_key), with template = paywall_followup_<step> and trigger_key =
 * workspace id. The run INSERTs a 'claimed' row with ON CONFLICT DO NOTHING
 * BEFORE sending; only the caller whose insert returned a row sends. The row
 * is then finished as 'sent' (with the provider id) or 'failed' (with the
 * error). A failed or still-'claimed' row is never retried, and it ends the
 * sequence: step n+1 requires step n to be 'sent'. The Resend Idempotency-Key
 * (`paywall_followup_<step>-<workspace id>`) covers a lost response.
 *
 * A stop that must outlive the moment (unsubscribed, subscribed, workspace
 * deleted, and any stop after step 1 went out) is written as a 'skipped' row
 * through the same ON CONFLICT DO NOTHING insert, so the sequence stays
 * stopped even if the condition later flips back. A stop that only means "not
 * in the sequence" (no consent, internal, paywall before consent) writes
 * nothing.
 */

import { createHash } from 'node:crypto';

import {
  PAYWALL_FOLLOWUP_CATEGORY,
  PAYWALL_FOLLOWUP_STEPS,
  composePaywallFollowup,
  type PaywallFollowupStep,
  type PaywallKind,
} from '@/lib/email/paywall-followup-templates';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SEQUENCE = 'paywall_followup';

export function templateFor(step: PaywallFollowupStep): string {
  return `${SEQUENCE}_${step}`;
}

export function stepOfTemplate(template: string): PaywallFollowupStep | null {
  const m = /^paywall_followup_([123])$/.exec(template);
  return m ? (Number(m[1]) as PaywallFollowupStep) : null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * When each step becomes due, relative to the first paywall, and until when it
 * may still go out. `minGapMs` is the least time after the PREVIOUS step was
 * sent, so a late step 1 cannot be followed by step 2 minutes later.
 *
 * A step whose window has passed is not sent late. For step 1 that simply
 * means the workspace never enters the sequence (nothing is written); for
 * steps 2 and 3 a 'skipped' row ends the sequence.
 */
export const STEP_TIMING: Record<PaywallFollowupStep, { dueMs: number; windowEndMs: number; minGapMs: number }> = {
  1: { dueMs: 1 * HOUR, windowEndMs: 1 * DAY, minGapMs: 0 },
  2: { dueMs: 3 * DAY, windowEndMs: 5 * DAY, minGapMs: 1 * DAY },
  3: { dueMs: 7 * DAY, windowEndMs: 10 * DAY, minGapMs: 1 * DAY },
};

/**
 * Candidates are workspaces whose first paywall is at most this old. Past the
 * last step's window nothing can happen anyway, so older hits are never read.
 */
export const CANDIDATE_MAX_AGE_MS = STEP_TIMING[3].windowEndMs + DAY;

/** Mirrors the entitled list in src/lib/stripe/checkout-core.ts. */
const SUBSCRIBED_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerStatus = 'claimed' | 'sent' | 'failed' | 'skipped';

export interface LedgerRow {
  template: string;
  triggerKey: string;
  status: LedgerStatus | string;
  detail: string | null;
  sentAt: string;
  finishedAt: string | null;
}

export interface FirstPaywall {
  workspaceId: string;
  firstPaywallAt: string;
  paywallKind: PaywallKind;
}

export interface CandidateContext extends FirstPaywall {
  workspace: { ownerId: string; plan: string; deletedAt: string | null } | null;
  owner: {
    id: string;
    email: string | null;
    marketingConsentAt: string | null;
    unsubscribedAt: string | null;
    unsubscribedCategories: string[];
    unsubscribeToken: string | null;
  } | null;
  subscriptionStatus: string | null;
  unlimitedInboxes: boolean;
  internal: boolean;
  inboxCount: number;
  /** The owner's rows for THIS sequence, across all of their workspaces. */
  ledger: LedgerRow[];
}

export type StopReason =
  | 'workspace_missing'
  | 'workspace_deleted'
  | 'owner_missing'
  | 'internal'
  | 'no_consent'
  | 'paywall_before_consent'
  | 'unsubscribed'
  | 'unsubscribed_lifecycle'
  | 'no_unsubscribe_token'
  | 'subscribed'
  | 'unlimited_inboxes'
  | 'unusable_email'
  | 'enrolled_elsewhere'
  | 'window_missed'
  | 'not_composable';

export type Decision =
  | { kind: 'send'; step: PaywallFollowupStep }
  | { kind: 'wait'; step: PaywallFollowupStep; dueAt: string }
  | { kind: 'stop'; step: PaywallFollowupStep; reason: StopReason; persist: boolean }
  | { kind: 'done'; reason: 'completed' | `ended_at_step_${PaywallFollowupStep}_${string}` };

/** Stops recorded even at step 1, because they must survive the condition flipping back. */
const PERSIST_AT_ENTRY: ReadonlySet<StopReason> = new Set([
  'workspace_deleted',
  'unsubscribed',
  'unsubscribed_lifecycle',
  'subscribed',
  'unlimited_inboxes',
]);

/** Stops that mean "never in the sequence" and are never written, whatever the step. */
const NEVER_PERSIST: ReadonlySet<StopReason> = new Set([
  'workspace_missing',
  'owner_missing',
  'internal',
  'paywall_before_consent',
  'enrolled_elsewhere',
]);

export interface DecideOptions {
  /**
   * REPORTING ONLY. Lets the dry-run script count who would match if consent
   * were not required. runPaywallFollowup refuses it outside dry_run.
   */
  ignoreConsent?: boolean;
}

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

export interface PaywallEventRow {
  workspace_id: string;
  occurred_at: string;
  connection_type: string | null;
}

/**
 * The FIRST EVER paywall of each workspace, given the paywall rows inside the
 * look-back window and the set of workspaces that also have one BEFORE it.
 * A workspace in `earlier` is dropped: its first paywall is older than the
 * window, so nothing inside the window is a first. Pure; the store feeds it.
 *
 * The inbox-cap beacon marks its rows `connection_type = 'first_connect'`; the
 * action cap leaves the column NULL (see recordInboxPaywallReached in
 * src/lib/analytics/billing-funnel.ts).
 */
export function pickFirstPaywalls(recent: PaywallEventRow[], earlier: ReadonlySet<string>): FirstPaywall[] {
  const first = new Map<string, FirstPaywall>();
  const sorted = [...recent].sort((a, b) => ms(a.occurred_at) - ms(b.occurred_at));
  for (const row of sorted) {
    if (earlier.has(row.workspace_id) || first.has(row.workspace_id)) continue;
    first.set(row.workspace_id, {
      workspaceId: row.workspace_id,
      firstPaywallAt: row.occurred_at,
      paywallKind: row.connection_type === 'first_connect' ? 'inbox_cap' : 'action_cap',
    });
  }
  return [...first.values()];
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Where this workspace stands in the sequence right now. Pure.
 *
 * Order: sequence state from the ledger, then timing, then eligibility, then
 * the late-window rule. Eligibility runs on every step, not just the first.
 */
export function decide(ctx: CandidateContext, now: Date, options: DecideOptions = {}): Decision {
  const nowMs = now.getTime();
  const firstMs = ms(ctx.firstPaywallAt);

  // 1. Sequence state. Step n+1 needs step n 'sent'; anything else ends it.
  const own = ctx.ledger.filter((r) => r.triggerKey === ctx.workspaceId);
  let step: PaywallFollowupStep | null = null;
  let previousSentMs = NaN;
  for (const s of PAYWALL_FOLLOWUP_STEPS) {
    const row = own.find((r) => r.template === templateFor(s));
    if (!row) {
      step = s;
      break;
    }
    if (row.status !== 'sent') {
      return { kind: 'done', reason: `ended_at_step_${s}_${row.detail ?? row.status}` };
    }
    previousSentMs = ms(row.finishedAt ?? row.sentAt);
  }
  if (step === null) return { kind: 'done', reason: 'completed' };

  // 2. Timing.
  const timing = STEP_TIMING[step];
  let dueMs = firstMs + timing.dueMs;
  if (step > 1 && Number.isFinite(previousSentMs)) dueMs = Math.max(dueMs, previousSentMs + timing.minGapMs);
  if (!Number.isFinite(dueMs)) return stop(step, 'workspace_missing');
  if (nowMs < dueMs) return { kind: 'wait', step, dueAt: new Date(dueMs).toISOString() };

  // 3. Eligibility, at send time.
  const reason = ineligibility(ctx, firstMs, options);
  if (reason) return stop(step, reason);

  // 4. Too late for this step: never sent late.
  if (nowMs > firstMs + timing.windowEndMs) return stop(step, 'window_missed');

  return { kind: 'send', step };
}

function stop(step: PaywallFollowupStep, reason: StopReason): Decision {
  const persist = NEVER_PERSIST.has(reason)
    ? false
    : step > 1 || PERSIST_AT_ENTRY.has(reason);
  return { kind: 'stop', step, reason, persist };
}

/** The first failing eligibility rule, or null. Exported for the tests. */
export function ineligibility(
  ctx: CandidateContext,
  firstPaywallMs: number,
  options: DecideOptions = {},
): StopReason | null {
  if (!ctx.workspace) return 'workspace_missing';
  if (ctx.workspace.deletedAt) return 'workspace_deleted';
  const owner = ctx.owner;
  if (!owner || owner.id !== ctx.workspace.ownerId) return 'owner_missing';
  if (ctx.internal) return 'internal';

  if (!options.ignoreConsent) {
    const consentMs = ms(owner.marketingConsentAt);
    if (!Number.isFinite(consentMs)) return 'no_consent';
    // Only a paywall hit AFTER the opt-in may start the sequence.
    if (!(firstPaywallMs > consentMs)) return 'paywall_before_consent';
  }

  if (owner.unsubscribedAt) return 'unsubscribed';
  if ((owner.unsubscribedCategories ?? []).includes(PAYWALL_FOLLOWUP_CATEGORY)) return 'unsubscribed_lifecycle';
  if (!owner.unsubscribeToken) return 'no_unsubscribe_token';

  if (ctx.workspace.plan !== 'free') return 'subscribed';
  if (ctx.subscriptionStatus && SUBSCRIBED_STATUSES.has(ctx.subscriptionStatus)) return 'subscribed';
  if (ctx.unlimitedInboxes) return 'unlimited_inboxes';

  if (!owner.email || !EMAIL_RE.test(owner.email.trim())) return 'unusable_email';

  // One sequence per person: a second workspace of the same owner hitting a
  // paywall does not start a second run of the same three emails.
  if (ctx.ledger.some((r) => r.triggerKey !== ctx.workspaceId)) return 'enrolled_elsewhere';

  return null;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ClaimRow {
  userId: string;
  workspaceId: string;
  step: PaywallFollowupStep;
  email: string;
  status: 'claimed' | 'skipped';
  detail: string | null;
}

export interface PaywallFollowupStore {
  /** Workspaces whose FIRST EVER paywall_reached is at or after `since`. */
  listFirstPaywalls(since: Date): Promise<FirstPaywall[]>;
  /** Everything decide() reads, for these workspaces. */
  loadContexts(firsts: FirstPaywall[]): Promise<CandidateContext[]>;
  /**
   * INSERT ... ON CONFLICT (user_id, template, trigger_key) DO NOTHING.
   * True only for the caller whose insert created the row.
   */
  claim(row: ClaimRow): Promise<boolean>;
  /** Move a claimed row to its terminal state. Never deletes. */
  finish(
    key: { userId: string; workspaceId: string; step: PaywallFollowupStep },
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

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type RunMode = 'dry_run' | 'send';

export interface RunOptions {
  store: PaywallFollowupStore;
  /** Required for mode 'send'. Never called in dry_run. */
  send?: Sender;
  mode: RunMode;
  now?: Date;
  maxSends?: number;
  ignoreConsent?: boolean;
  /** Returns true when the run should stop early (wall clock). */
  outOfTime?: () => boolean;
}

export interface RunEntry {
  /** sha256(workspace id), first 12 hex characters. Never the raw id. */
  workspace: string;
  paywallAgeHours: number;
  paywallKind: PaywallKind;
  inboxCount: number;
  decision: Decision['kind'];
  step: PaywallFollowupStep | null;
  reason: string | null;
  subject: string | null;
  outcome: 'sent' | 'failed' | 'lost_claim' | 'skipped_recorded' | 'would_send' | 'none';
}

export interface RunReport {
  mode: RunMode;
  candidates: number;
  sent: number;
  failed: number;
  lostClaims: number;
  skippedRecorded: number;
  wouldSend: Record<`step${PaywallFollowupStep}`, number>;
  waiting: number;
  stopped: Record<string, number>;
  done: number;
  truncated: boolean;
  entries: RunEntry[];
}

export function anonymise(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export const DEFAULT_MAX_SENDS = 20;

export async function runPaywallFollowup(options: RunOptions): Promise<RunReport> {
  const { store, mode } = options;
  const now = options.now ?? new Date();
  const maxSends = options.maxSends ?? DEFAULT_MAX_SENDS;
  if (options.ignoreConsent && mode !== 'dry_run') {
    throw new Error('ignoreConsent is a dry-run reporting option and cannot be used to send');
  }
  if (mode === 'send' && !options.send) throw new Error('mode "send" needs a sender');
  const decideOptions: DecideOptions = { ignoreConsent: mode === 'dry_run' && options.ignoreConsent === true };

  const report: RunReport = {
    mode,
    candidates: 0,
    sent: 0,
    failed: 0,
    lostClaims: 0,
    skippedRecorded: 0,
    wouldSend: { step1: 0, step2: 0, step3: 0 },
    waiting: 0,
    stopped: {},
    done: 0,
    truncated: false,
    entries: [],
  };

  const firsts = await store.listFirstPaywalls(new Date(now.getTime() - CANDIDATE_MAX_AGE_MS));
  // Oldest first, so an owner's earliest workspace is the one that enrols.
  firsts.sort((a, b) => ms(a.firstPaywallAt) - ms(b.firstPaywallAt));
  const contexts = await store.loadContexts(firsts);
  report.candidates = contexts.length;

  for (const initial of contexts) {
    if (options.outOfTime?.()) {
      report.truncated = true;
      break;
    }

    let ctx = initial;
    let decision = decide(ctx, now, decideOptions);

    // Re-read this one workspace immediately before acting on a send, so the
    // eligibility check is as close to the send as it can be.
    if (decision.kind === 'send' && mode === 'send') {
      const [fresh] = await store.loadContexts([initial]);
      ctx = fresh ?? { ...initial, workspace: null };
      decision = decide(ctx, now, decideOptions);
    }

    const entry: RunEntry = {
      workspace: anonymise(ctx.workspaceId),
      paywallAgeHours: Math.round((now.getTime() - ms(ctx.firstPaywallAt)) / HOUR),
      paywallKind: ctx.paywallKind,
      inboxCount: ctx.inboxCount,
      decision: decision.kind,
      step: decision.kind === 'done' ? null : decision.step,
      reason: decision.kind === 'stop' || decision.kind === 'done' ? decision.reason : null,
      subject: null,
      outcome: 'none',
    };
    report.entries.push(entry);

    if (decision.kind === 'wait') {
      report.waiting += 1;
      continue;
    }
    if (decision.kind === 'done') {
      report.done += 1;
      continue;
    }
    if (decision.kind === 'stop') {
      report.stopped[decision.reason] = (report.stopped[decision.reason] ?? 0) + 1;
      if (decision.persist && mode === 'send' && ctx.owner) {
        const won = await store.claim({
          userId: ctx.owner.id,
          workspaceId: ctx.workspaceId,
          step: decision.step,
          email: ctx.owner.email ?? '',
          status: 'skipped',
          detail: decision.reason,
        });
        if (won) {
          report.skippedRecorded += 1;
          entry.outcome = 'skipped_recorded';
        }
      }
      continue;
    }

    // decision.kind === 'send'
    const owner = ctx.owner!;
    const composed = composePaywallFollowup({
      step: decision.step,
      paywallKind: ctx.paywallKind,
      unsubscribeToken: owner.unsubscribeToken,
    });
    entry.subject = composed?.subject ?? null;

    if (mode === 'dry_run') {
      report.wouldSend[`step${decision.step}`] += 1;
      entry.outcome = 'would_send';
      continue;
    }

    if (report.sent + report.failed >= maxSends) {
      report.truncated = true;
      break;
    }

    if (!composed) {
      report.stopped.not_composable = (report.stopped.not_composable ?? 0) + 1;
      await store.claim({
        userId: owner.id,
        workspaceId: ctx.workspaceId,
        step: decision.step,
        email: owner.email ?? '',
        status: 'skipped',
        detail: 'not_composable',
      });
      continue;
    }

    // THE CLAIM. Only the winner of this insert sends.
    const won = await store.claim({
      userId: owner.id,
      workspaceId: ctx.workspaceId,
      step: decision.step,
      email: owner.email!.trim(),
      status: 'claimed',
      detail: null,
    });
    if (!won) {
      report.lostClaims += 1;
      entry.outcome = 'lost_claim';
      continue;
    }

    const key = { userId: owner.id, workspaceId: ctx.workspaceId, step: decision.step };
    let result: SendResult;
    try {
      result = await options.send!({
        to: owner.email!.trim(),
        subject: composed.subject,
        text: composed.text,
        html: composed.html,
        headers: composed.headers,
        idempotencyKey: `${templateFor(decision.step)}-${ctx.workspaceId}`,
      });
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
    }

    if (result.ok) {
      await store.finish(key, { status: 'sent', providerId: result.id });
      report.sent += 1;
      entry.outcome = 'sent';
    } else {
      // Kept, never retried: the next run sees a non-'sent' row and stops.
      await store.finish(key, { status: 'failed', detail: result.reason });
      report.failed += 1;
      entry.outcome = 'failed';
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Switches, read at CALL time (see src/lib/billing/lifecycle-mode.ts for why a
// module-scope const is not a kill switch on Vercel)
// ---------------------------------------------------------------------------

export type PaywallFollowupMode = 'off' | RunMode;

/**
 *   PAYWALL_FOLLOWUP_ENABLED   must be exactly `on` (or `true`). Anything
 *                              else, including unset, is `off`: the route
 *                              returns before touching the database.
 *   PAYWALL_FOLLOWUP_DRY_RUN   dry run unless exactly `false` (or `off`).
 *                              Unset means dry run.
 *
 * So a real email needs BOTH `ENABLED=on` and `DRY_RUN=false`, and a typo in
 * either fails towards silence.
 */
export function paywallFollowupMode(env: Record<string, string | undefined> = process.env): PaywallFollowupMode {
  const enabled = (env.PAYWALL_FOLLOWUP_ENABLED ?? '').trim().toLowerCase();
  if (enabled !== 'on' && enabled !== 'true') return 'off';
  const dry = (env.PAYWALL_FOLLOWUP_DRY_RUN ?? '').trim().toLowerCase();
  return dry === 'false' || dry === 'off' ? 'send' : 'dry_run';
}

/** PAYWALL_FOLLOWUP_MAX_PER_RUN, clamped to 1..100, default DEFAULT_MAX_SENDS. */
export function paywallFollowupMaxPerRun(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.PAYWALL_FOLLOWUP_MAX_PER_RUN ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_SENDS;
  return Math.min(100, Math.max(1, n));
}

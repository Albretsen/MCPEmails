/**
 * Broken-inbox alert for paying customers, with a 50% holdout.
 *
 * WHY. Four of five paid customers who churned after month 1 had an inbox
 * whose sign-in broke, and nothing told them except the next failed AI call.
 * This tells the workspace owner, by email and on the dashboard, while the
 * holdout half gets nothing new, so the read-out can say whether it helps.
 *
 * WHAT COUNTS AS BROKEN. The same rule the mcp-server's inbox_list reports as
 * `reconnect_required` (src/lib/inboxes/health.ts), narrowed to the provider's
 * own refusals:
 *   - status 'error': Google or Microsoft refused the refresh token (revoked,
 *     expired, interaction required), or "Check connection" got a definitive
 *     auth failure. NOT the two Outlook cases a reconnect does not fix (no
 *     mailbox; an admin blocking mailbox access), and not a row with no
 *     error text at all.
 *   - status 'active' with the login-refused marker: an IMAP server said NO
 *     to the password (mcp-server and client-api write it, and clear it on the
 *     next success).
 * Timeouts, relay and network failures never set either signal: they are
 * logged as search_timeout / network_failed / provider_error and leave the
 * row alone, so they cannot start a break.
 *
 * WHEN. Broken for at least 24 hours, measured from the break start (the first
 * `auth_failed` call on the inbox after its last success; the error row's own
 * time when no call logged one), and no successful call on that inbox since.
 * Paid plan (Personal, Pro, Team), the owner's subscription active, owner not
 * internal: all in SQL, public.inbox_alert_candidates().
 *
 * WHAT HAPPENS. Per workspace, the experiment `inbox_broken_alert` (50/50)
 * decides the arm, assigned only when a first alert is due in live mode.
 *   alert:   phase 1 email now; phase 2 five days after phase 1 was sent if
 *            the same break is still open. Plus a dashboard banner.
 *   holdout: nothing sent; a ledger row and an `inbox_alert_holdout` funnel
 *            row at the same moments, so both arms share one baseline.
 * Ledger: public.inbox_alert_sends, UNIQUE (inbox_id, break_started_at,
 * phase): one break is never mailed twice. When a broken inbox works again,
 * both arms get `inbox_reconnected` and the break is closed.
 *
 * MODE. INBOX_ALERT_ENABLED: off (default; the route returns before reading
 * anything), dry_run (reads and reports, writes nothing, assigns nothing,
 * sends nothing), on.
 */

import { hashUnit, pickVariant } from '@/lib/experiments/bucketing';
import type { ExperimentVariant } from '@/lib/experiments/constants';
import { OUTLOOK_NO_MAILBOX_REASON } from '@/lib/email-providers/outlook-oauth';
import { inboxHealth, loginRefusedAt } from '@/lib/inboxes/health';
import { getProvider, PROVIDERS } from '@/lib/connect/providers.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INBOX_ALERT_EXPERIMENT_KEY = 'inbox_broken_alert';
export const ARM_HOLDOUT = 'holdout';
export const ARM_ALERT = 'alert';
export type InboxAlertArm = typeof ARM_HOLDOUT | typeof ARM_ALERT;

/** Mirrors the row seeded by 20261111140000_inbox_broken_alert.sql. variants[0] is the control. */
export const INBOX_ALERT_VARIANTS: ExperimentVariant[] = [
  { id: ARM_HOLDOUT, label: 'No broken-inbox alert', weight: 50 },
  { id: ARM_ALERT, label: 'Broken-inbox email and banner', weight: 50 },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A break must be this old before the first alert. */
export const MIN_BROKEN_MS = 24 * HOUR;
/** The second alert, this long after the first was sent. */
export const SECOND_ALERT_AFTER_MS = 5 * DAY;
/** A failed send is retried on later runs, up to this many attempts in all. */
export const MAX_ATTEMPTS = 3;
/** At most this many emails per run; the rest wait an hour. */
export const DEFAULT_MAX_SENDS_PER_RUN = 25;

/** Outlook, check route: an admin blocks mailbox access. A reconnect does not fix it. */
const OUTLOOK_FORBIDDEN_PREFIX = 'Microsoft accepted the sign-in but refused access to this mailbox';

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export type InboxAlertMode = 'off' | 'dry_run' | 'on';

export function inboxAlertMode(env: Record<string, string | undefined> = process.env): InboxAlertMode {
  const raw = (env.INBOX_ALERT_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'on') return 'on';
  if (raw === 'dry_run' || raw === 'dry-run' || raw === 'dryrun') return 'dry_run';
  return 'off';
}

export function inboxAlertMaxSends(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.INBOX_ALERT_MAX_PER_RUN ?? '', 10);
  return Number.isFinite(n) && n > 0 && n <= 200 ? n : DEFAULT_MAX_SENDS_PER_RUN;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One row of public.inbox_alert_candidates(). */
export interface CandidateRow {
  inboxId: string;
  workspaceId: string;
  ownerId: string;
  ownerEmail: string;
  plan: string;
  acquisitionLocale: string | null;
  emailAddress: string;
  provider: string;
  service: string | null;
  imapHost: string | null;
  inboxStatus: string;
  lastError: string | null;
  errorRowAt: string | null;
  firstAuthFailedAt: string | null;
  lastAuthFailedAt: string | null;
  lastSuccessAt: string | null;
  lastClosedAt: string | null;
}

/** One row of public.inbox_alert_sends. */
export interface LedgerRow {
  id: number;
  inboxId: string;
  workspaceId: string;
  breakStartedAt: string;
  phase: 1 | 2;
  arm: InboxAlertArm;
  status: 'claimed' | 'sent' | 'failed' | 'holdout';
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  closedAt: string | null;
}

/** The current state of an inbox, for the reconnect sweep. */
export interface InboxState {
  provider: string;
  status: string;
  lastError: string | null;
  deletedAt: string | null;
  parkedAt: string | null;
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * True when the row is broken because the provider refused the credentials or
 * the token, which a reconnect fixes. False for our-side or unfixable states.
 */
export function isProviderSideBreak(row: { provider: string; inboxStatus: string; lastError: string | null }): boolean {
  if (row.inboxStatus === 'active') return loginRefusedAt(row.lastError) !== null;
  if (row.inboxStatus !== 'error') return false;
  const err = (row.lastError ?? '').trim();
  if (!err) return false;
  if (err === OUTLOOK_NO_MAILBOX_REASON) return false;
  if (err.startsWith(OUTLOOK_FORBIDDEN_PREFIX)) return false;
  return inboxHealth({ provider: row.provider, status: row.inboxStatus, last_error: row.lastError }) === 'reconnect_required';
}

export type BreakSource = 'ledger' | 'activity' | 'row';

/**
 * When this break started.
 *
 *   ledger:   an open ledger row for the inbox, and no success since its break
 *             start. Kept as is, so a later `updated_at` cannot open a second
 *             break for the same outage.
 *   activity: the first auth_failed call after the last success (and after
 *             the last break the ledger saw end).
 *   row:      no such call: the error row's own time.
 * Null when nothing dates it, or when the only date is not after the last
 * break the ledger closed (the row has not changed since it was fixed).
 */
export function resolveBreakStart(
  row: Pick<CandidateRow, 'firstAuthFailedAt' | 'errorRowAt' | 'lastSuccessAt' | 'lastClosedAt'>,
  open: Pick<LedgerRow, 'breakStartedAt'> | null,
): { at: string; source: BreakSource } | null {
  const success = ms(row.lastSuccessAt);
  if (open) {
    const openAt = ms(open.breakStartedAt);
    if (openAt !== null && (success === null || success <= openAt)) return { at: open.breakStartedAt, source: 'ledger' };
  }
  if (row.firstAuthFailedAt && ms(row.firstAuthFailedAt) !== null) return { at: row.firstAuthFailedAt, source: 'activity' };
  const rowAt = ms(row.errorRowAt);
  if (rowAt === null) return null;
  const closed = ms(row.lastClosedAt);
  if (closed !== null && rowAt <= closed) return null;
  return { at: row.errorRowAt!, source: 'row' };
}

export type FirstGate = 'not_provider_side' | 'no_break_start' | 'success_since_break' | 'under_24h' | null;

/** Null when the first alert may go out for this break; otherwise why not. */
export function firstAlertGate(row: CandidateRow, breakStart: { at: string } | null, now: Date): FirstGate {
  if (!isProviderSideBreak(row)) return 'not_provider_side';
  if (!breakStart) return 'no_break_start';
  const start = ms(breakStart.at)!;
  const success = ms(row.lastSuccessAt);
  if (success !== null && success >= start) return 'success_since_break';
  if (now.getTime() - start < MIN_BROKEN_MS) return 'under_24h';
  return null;
}

/** experiment_assignments.subject_id: a uuid without dashes. */
export function subjectIdFor(workspaceId: string): string {
  return workspaceId.replace(/-/g, '').toLowerCase();
}

/** The arm the local hash proposes. The stored assignment, if any, wins. */
export function proposedArm(workspaceId: string): InboxAlertArm {
  return pickVariant(INBOX_ALERT_VARIANTS, hashUnit(subjectIdFor(workspaceId), INBOX_ALERT_EXPERIMENT_KEY)) as InboxAlertArm;
}

/**
 * The open break the reconnect sweep is looking at, given the inbox now.
 *   'removed':     deleted, parked, or gone.
 *   'reconnected': usable again (the same rule as inbox_list).
 *   null:          still broken.
 */
export function openBreakOutcome(state: InboxState | null): 'removed' | 'reconnected' | null {
  if (!state || state.deletedAt || state.parkedAt) return 'removed';
  if (state.status !== 'active') return null;
  return inboxHealth({ provider: state.provider, status: state.status, last_error: state.lastError }) === 'ok'
    ? 'reconnected'
    : null;
}

// ---------------------------------------------------------------------------
// Provider name and connect guide
// ---------------------------------------------------------------------------

interface ProviderEntry {
  slug: string;
  name: string;
  imap: { host: string } | null;
  locales?: string[];
}

const HOST_TO_SLUG: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const p of PROVIDERS as ProviderEntry[]) {
    const host = p.imap?.host?.toLowerCase();
    if (host && !map.has(host)) map.set(host, p.slug);
  }
  return map;
})();

/** The /connect/<slug> guide that matches this inbox, or null when none does. */
export function guideSlugFor(inbox: { provider: string; service: string | null; imapHost: string | null }): string | null {
  if (inbox.provider === 'gmail') return 'gmail';
  if (inbox.provider === 'outlook') return 'outlook';
  const service = (inbox.service ?? '').toLowerCase();
  if (service && service !== 'generic' && service !== 'imap' && getProvider(service)) return service;
  const host = (inbox.imapHost ?? '').trim().toLowerCase();
  return host ? HOST_TO_SLUG.get(host) ?? null : null;
}

/** The provider's public name, or the mail host for an unknown one. */
export function providerLabel(inbox: { provider: string; service: string | null; imapHost: string | null }): string {
  const slug = guideSlugFor(inbox);
  const entry = slug ? (getProvider(slug) as ProviderEntry | null) : null;
  if (entry) return entry.name;
  if (inbox.provider === 'gmail') return 'Gmail';
  if (inbox.provider === 'outlook') return 'Outlook';
  return (inbox.imapHost ?? '').trim() || 'IMAP';
}

/** Absolute guide URL, in the reader's locale when the guide has one. */
export function guideUrl(slug: string | null, locale: string, baseUrl: string): string | null {
  if (!slug) return null;
  const entry = getProvider(slug) as ProviderEntry | null;
  if (!entry) return null;
  const localised = locale !== 'en' && (entry.locales ?? ['en']).includes(locale);
  return `${baseUrl}${localised ? `/${locale}` : ''}/connect/${slug}`;
}

/** The funnel `category` column for the provider. Mirrors the closed list in product-funnel.ts. */
export function funnelProviderCategory(provider: string): 'gmail' | 'outlook' | 'generic_imap' {
  return provider === 'gmail' ? 'gmail' : provider === 'outlook' ? 'outlook' : 'generic_imap';
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface NewLedgerRow {
  inboxId: string;
  workspaceId: string;
  userId: string;
  breakStartedAt: string;
  phase: 1 | 2;
  arm: InboxAlertArm;
  status: 'claimed' | 'holdout';
  provider: string;
}

export type FunnelStage = 'inbox_alert_sent' | 'inbox_alert_holdout' | 'inbox_reconnected';
export type FunnelCategory = 'alert_1' | 'alert_2' | 'alert' | 'holdout';

export interface InboxAlertStore {
  listCandidates(): Promise<CandidateRow[]>;
  /** Every ledger row with closed_at null. */
  listOpenLedger(): Promise<LedgerRow[]>;
  loadInboxStates(inboxIds: string[]): Promise<Map<string, InboxState>>;
  /** Sticky assignment; null when the experiment cannot be read (fails closed). */
  assignArm(workspaceId: string, proposed: InboxAlertArm): Promise<InboxAlertArm | null>;
  /** INSERT ... ON CONFLICT DO NOTHING. The new row, or null when it already existed. */
  insertRow(row: NewLedgerRow): Promise<LedgerRow | null>;
  /** Mark a claimed or failed row as being attempted again. False when someone else holds it. */
  reclaimRow(id: number, attempts: number): Promise<boolean>;
  finishRow(id: number, outcome: { status: 'sent'; providerMessageId: string | null } | { status: 'failed'; detail: string }): Promise<void>;
  closeBreak(inboxId: string, breakStartedAt: string, reason: 'reconnected' | 'removed', at: Date): Promise<void>;
  recordFunnel(workspaceId: string, stage: FunnelStage, category: FunnelCategory): Promise<void>;
}

export interface AlertEmailInput {
  to: string;
  phase: 1 | 2;
  locale: string | null;
  inboxAddress: string;
  providerName: string;
  guideSlug: string | null;
  brokenSince: string;
  idempotencyKey: string;
}

export type AlertSender = (input: AlertEmailInput) => Promise<{ ok: true; id: string | null } | { ok: false; reason: string }>;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunEntry {
  inboxId: string;
  workspaceId: string;
  action:
    | 'send_1' | 'send_2' | 'holdout_1' | 'holdout_2' | 'retry'
    | 'reconnected' | 'removed' | 'skip';
  reason?: string;
  breakStartedAt?: string;
  breakSource?: BreakSource;
  arm?: InboxAlertArm | 'unassigned';
  outcome?: 'sent' | 'failed' | 'recorded' | 'would' | 'lost_claim' | 'conflict';
}

export interface RunReport {
  mode: 'dry_run' | 'on';
  candidates: number;
  entries: RunEntry[];
  counts: Record<string, number>;
  truncated: boolean;
}

export interface RunInput {
  mode: 'dry_run' | 'on';
  store: InboxAlertStore;
  send: AlertSender;
  now: Date;
  maxSends?: number;
  outOfTime?: () => boolean;
}

function count(report: RunReport, key: string) {
  report.counts[key] = (report.counts[key] ?? 0) + 1;
}

/**
 * One dispatcher run: close breaks that ended, then send (or record for the
 * holdout) first and second alerts. In dry run nothing is written and nobody
 * is assigned; the report says what would happen, with the arm the hash
 * proposes marked as such.
 */
export async function runInboxAlerts(input: RunInput): Promise<RunReport> {
  const { mode, store, send, now } = input;
  const dry = mode === 'dry_run';
  const maxSends = input.maxSends ?? DEFAULT_MAX_SENDS_PER_RUN;
  const outOfTime = input.outOfTime ?? (() => false);
  const report: RunReport = { mode, candidates: 0, entries: [], counts: {}, truncated: false };

  const [candidates, openRows] = await Promise.all([store.listCandidates(), store.listOpenLedger()]);
  report.candidates = candidates.length;

  // Group open ledger rows by break.
  const breaks = new Map<string, LedgerRow[]>();
  for (const r of openRows) {
    const key = `${r.inboxId}|${r.breakStartedAt}`;
    breaks.set(key, [...(breaks.get(key) ?? []), r]);
  }
  const candidateByInbox = new Map(candidates.map((c) => [c.inboxId, c]));

  // 1. Breaks that ended. Every open break is checked against the inbox as it
  //    is now, whatever the workspace's plan: the reconnect rate is measured
  //    for both arms.
  const states = await store.loadInboxStates([...new Set(openRows.map((r) => r.inboxId))]);
  const stillOpen = new Map<string, LedgerRow[]>();
  for (const rows of breaks.values()) {
    const first = rows.find((r) => r.phase === 1) ?? rows[0];
    let outcome = openBreakOutcome(states.get(first.inboxId) ?? null);
    // Broken again, but a success came after this break's start: the old
    // break ended in between (the inbox worked, then broke anew).
    const cand = candidateByInbox.get(first.inboxId);
    if (outcome === null && cand) {
      const success = ms(cand.lastSuccessAt);
      if (success !== null && success > ms(first.breakStartedAt)!) outcome = 'reconnected';
    }
    if (outcome === null) {
      stillOpen.set(first.inboxId, rows);
      continue;
    }
    const entry: RunEntry = {
      inboxId: first.inboxId,
      workspaceId: first.workspaceId,
      action: outcome,
      breakStartedAt: first.breakStartedAt,
      arm: first.arm,
      outcome: dry ? 'would' : 'recorded',
    };
    if (!dry) {
      await store.closeBreak(first.inboxId, first.breakStartedAt, outcome, now);
      if (outcome === 'reconnected') await store.recordFunnel(first.workspaceId, 'inbox_reconnected', first.arm);
    }
    report.entries.push(entry);
    count(report, outcome);
  }

  // 2. Alerts.
  let sends = 0;
  const assigned = new Map<string, InboxAlertArm | null>();
  for (const cand of candidates) {
    if (outOfTime()) {
      report.truncated = true;
      break;
    }
    const base = { inboxId: cand.inboxId, workspaceId: cand.workspaceId };
    let open = stillOpen.get(cand.inboxId) ?? null;
    // Belt and braces: an open break with a success since its start was closed
    // above and is not in `stillOpen`; if the rule ever disagrees, a fresh
    // break wins over a stale one.
    const resolved = resolveBreakStart(cand, open ? open.find((r) => r.phase === 1) ?? open[0] : null);
    if (open && resolved && resolved.source !== 'ledger') open = null;

    const phase1 = open?.find((r) => r.phase === 1) ?? null;
    const phase2 = open?.find((r) => r.phase === 2) ?? null;

    if (!phase1) {
      const gate = firstAlertGate(cand, resolved, now);
      if (gate) {
        report.entries.push({ ...base, action: 'skip', reason: gate, breakStartedAt: resolved?.at });
        count(report, `skip_${gate}`);
        continue;
      }
      const breakStartedAt = resolved!.at;

      let arm: InboxAlertArm | null | 'unassigned';
      if (dry) {
        arm = 'unassigned';
      } else {
        if (!assigned.has(cand.workspaceId)) {
          assigned.set(cand.workspaceId, await store.assignArm(cand.workspaceId, proposedArm(cand.workspaceId)));
        }
        arm = assigned.get(cand.workspaceId) ?? null;
        if (arm === null) {
          report.entries.push({ ...base, action: 'skip', reason: 'experiment_unavailable' });
          count(report, 'skip_experiment_unavailable');
          continue;
        }
      }

      if (dry) {
        report.entries.push({ ...base, action: 'send_1', breakStartedAt, breakSource: resolved!.source, arm: 'unassigned', outcome: 'would' });
        count(report, 'would_first');
        continue;
      }

      if (arm === ARM_HOLDOUT) {
        const row = await store.insertRow({ ...rowBase(cand), breakStartedAt, phase: 1, arm, status: 'holdout' });
        if (row) await store.recordFunnel(cand.workspaceId, 'inbox_alert_holdout', 'alert_1');
        report.entries.push({ ...base, action: 'holdout_1', breakStartedAt, breakSource: resolved!.source, arm, outcome: row ? 'recorded' : 'conflict' });
        count(report, 'holdout_1');
        continue;
      }

      if (sends >= maxSends) {
        report.truncated = true;
        continue;
      }
      const row = await store.insertRow({ ...rowBase(cand), breakStartedAt, phase: 1, arm: ARM_ALERT, status: 'claimed' });
      if (!row) {
        report.entries.push({ ...base, action: 'send_1', breakStartedAt, arm: ARM_ALERT, outcome: 'conflict' });
        continue;
      }
      sends += 1;
      const outcome = await deliver(store, send, cand, row, 1, breakStartedAt);
      report.entries.push({ ...base, action: 'send_1', breakStartedAt, breakSource: resolved!.source, arm: ARM_ALERT, outcome });
      count(report, `send_1_${outcome}`);
      continue;
    }

    // An open break with a phase-1 row. Still provider-side?
    if (!isProviderSideBreak(cand)) {
      report.entries.push({ ...base, action: 'skip', reason: 'not_provider_side', breakStartedAt: phase1.breakStartedAt });
      count(report, 'skip_not_provider_side');
      continue;
    }

    // Retry the latest email of this break that failed (or whose outcome was lost).
    const latest = phase2 ?? phase1;
    if (latest.arm === ARM_ALERT && (latest.status === 'failed' || latest.status === 'claimed')) {
      if (latest.attempts >= MAX_ATTEMPTS || ms(latest.createdAt)! > now.getTime() - HOUR) {
        const reason = latest.attempts >= MAX_ATTEMPTS ? 'attempts_exhausted' : 'retry_wait';
        report.entries.push({ ...base, action: 'skip', reason, breakStartedAt: latest.breakStartedAt, arm: ARM_ALERT });
        count(report, `skip_${reason}`);
        continue;
      }
      if (dry) {
        report.entries.push({ ...base, action: 'retry', breakStartedAt: latest.breakStartedAt, arm: ARM_ALERT, outcome: 'would' });
        count(report, 'would_retry');
        continue;
      }
      if (sends >= maxSends) {
        report.truncated = true;
        continue;
      }
      if (!(await store.reclaimRow(latest.id, latest.attempts))) {
        report.entries.push({ ...base, action: 'retry', outcome: 'lost_claim' });
        continue;
      }
      sends += 1;
      const outcome = await deliver(store, send, cand, latest, latest.phase, latest.breakStartedAt, true);
      report.entries.push({ ...base, action: 'retry', breakStartedAt: latest.breakStartedAt, arm: ARM_ALERT, outcome });
      count(report, `retry_${outcome}`);
      continue;
    }

    if (phase2) {
      report.entries.push({ ...base, action: 'skip', reason: 'both_phases_done', breakStartedAt: phase1.breakStartedAt, arm: phase1.arm });
      continue;
    }

    // Phase 2: five days after phase 1 went out (holdout: after its row).
    const anchor = phase1.arm === ARM_ALERT ? (phase1.status === 'sent' ? ms(phase1.sentAt) : null) : ms(phase1.createdAt);
    if (anchor === null || now.getTime() - anchor < SECOND_ALERT_AFTER_MS) {
      report.entries.push({ ...base, action: 'skip', reason: 'second_not_due', breakStartedAt: phase1.breakStartedAt, arm: phase1.arm });
      count(report, 'skip_second_not_due');
      continue;
    }
    if (dry) {
      report.entries.push({
        ...base,
        action: phase1.arm === ARM_ALERT ? 'send_2' : 'holdout_2',
        breakStartedAt: phase1.breakStartedAt,
        arm: phase1.arm,
        outcome: 'would',
      });
      count(report, 'would_second');
      continue;
    }
    if (phase1.arm === ARM_HOLDOUT) {
      const row = await store.insertRow({ ...rowBase(cand), breakStartedAt: phase1.breakStartedAt, phase: 2, arm: ARM_HOLDOUT, status: 'holdout' });
      if (row) await store.recordFunnel(cand.workspaceId, 'inbox_alert_holdout', 'alert_2');
      report.entries.push({ ...base, action: 'holdout_2', breakStartedAt: phase1.breakStartedAt, arm: ARM_HOLDOUT, outcome: row ? 'recorded' : 'conflict' });
      count(report, 'holdout_2');
      continue;
    }
    if (sends >= maxSends) {
      report.truncated = true;
      continue;
    }
    const row2 = await store.insertRow({ ...rowBase(cand), breakStartedAt: phase1.breakStartedAt, phase: 2, arm: ARM_ALERT, status: 'claimed' });
    if (!row2) {
      report.entries.push({ ...base, action: 'send_2', outcome: 'conflict' });
      continue;
    }
    sends += 1;
    const outcome = await deliver(store, send, cand, row2, 2, phase1.breakStartedAt);
    report.entries.push({ ...base, action: 'send_2', breakStartedAt: phase1.breakStartedAt, arm: ARM_ALERT, outcome });
    count(report, `send_2_${outcome}`);
  }

  return report;
}

function rowBase(cand: CandidateRow) {
  return { inboxId: cand.inboxId, workspaceId: cand.workspaceId, userId: cand.ownerId, provider: cand.provider };
}

/** Idempotency key for Resend: one per (inbox, break, phase), stable across retries. */
export function alertIdempotencyKey(inboxId: string, breakStartedAt: string, phase: 1 | 2): string {
  return `inbox-alert-${inboxId}-${Date.parse(breakStartedAt)}-${phase}`;
}

async function deliver(
  store: InboxAlertStore,
  send: AlertSender,
  cand: CandidateRow,
  row: LedgerRow,
  phase: 1 | 2,
  breakStartedAt: string,
  isRetry = false,
): Promise<'sent' | 'failed'> {
  const result = await send({
    to: cand.ownerEmail,
    phase,
    locale: cand.acquisitionLocale,
    inboxAddress: cand.emailAddress,
    providerName: providerLabel(cand),
    guideSlug: guideSlugFor(cand),
    brokenSince: breakStartedAt,
    idempotencyKey: alertIdempotencyKey(cand.inboxId, breakStartedAt, phase),
  });
  if (result.ok) {
    await store.finishRow(row.id, { status: 'sent', providerMessageId: result.id });
    await store.recordFunnel(cand.workspaceId, 'inbox_alert_sent', phase === 1 ? 'alert_1' : 'alert_2');
    return 'sent';
  }
  await store.finishRow(row.id, { status: 'failed', detail: `${isRetry ? 'retry: ' : ''}${result.reason}`.slice(0, 200) });
  return 'failed';
}

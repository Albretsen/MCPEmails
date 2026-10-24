/**
 * Activation help: at most two service emails per workspace, ever, with a 20%
 * holdout, for people who started setting up and stopped.
 *
 *   E1 connection_help  The workspace's latest `inbox_connection` funnel row is
 *                       a failure, nothing succeeded after it, there is no
 *                       connected inbox, and that failure is at least 60
 *                       minutes and less than 48 hours old. Past an hour the
 *                       natural recovery rate is close to zero.
 *   E2 first_call_help  An inbox connected (a success row, the first-connect
 *                       marker or a live inbox), no tool call yet, and the
 *                       first connection is at least 3 hours and less than 72
 *                       hours old. 90% of natural first calls land within about
 *                       an hour, so 3 hours still arrives the same day.
 *
 * Copy is in activation-help-templates.ts, the database adapter in
 * activation-help-store.ts, the cron entry point in
 * app/api/internal/activation-help/dispatch/route.ts. This file is pure
 * decision logic plus the run loop, with the store and the sender injected, so
 * every rule is covered by activation-help.test.ts without a network.
 *
 * SERVICE EMAIL. No marketing opt-in is required (see the templates header),
 * but every send checks the `lifecycle` unsubscribe category and the global
 * opt-out, once from the batch read and again through isSuppressed() right
 * before the send.
 *
 * WHO NEVER GETS ONE. A deleted workspace, a deleted account, an owner in
 * internal_accounts (or one of our domains), a workspace created before
 * ACTIVATION_HELP_START_AT (unset means nobody), an owner without a usable
 * address or unsubscribe token, anyone unsubscribed.
 *
 * ONCE EVER. `lifecycle_email_sends`, template activation_help_connection or
 * activation_help_first_call, trigger_key = workspace id. Any row for that
 * pair (claimed, sent, failed, holdout) means never again. The claim is an
 * INSERT ... ON CONFLICT DO NOTHING before the send, as in
 * paywall-followup.ts; a claimed or failed row is never retried. A partial
 * unique index on (template, trigger_key) makes "one per workspace" hold even
 * if the owner changed.
 *
 * HOLDOUT. 20% of eligible workspaces, by hashUnit(workspace id) from the
 * experiments bucketing, get a 'holdout' ledger row instead of an email, so the
 * control arm is counted with exactly the same eligibility as the send arm.
 * Read-out (first call within 7 days of the ledger row, by arm):
 *
 *   SELECT s.template, s.status = 'holdout' AS holdout, count(*),
 *          count(w.analytics_first_tool_used_at)
 *            FILTER (WHERE w.analytics_first_tool_used_at < s.sent_at + interval '7 days')
 *     FROM lifecycle_email_sends s
 *     JOIN workspaces w ON w.id::text = s.trigger_key
 *    WHERE s.template LIKE 'activation\_help\_%' AND s.status IN ('sent', 'holdout')
 *    GROUP BY 1, 2;
 *
 * SWITCHES, read at call time: ACTIVATION_HELP_ENABLED (default off) and
 * ACTIVATION_HELP_DRY_RUN (default on: decide and log, write and send nothing).
 */

import { createHash } from 'node:crypto';

import { hashUnit } from '@/lib/experiments/bucketing';
import {
  PROVIDER_LINKS,
  composeActivationHelp,
  helpLocale,
  type ActivationHelpContent,
  type ConnectionHelpKey,
  type FirstCallState,
  type HelpClient,
  type HelpLocale,
} from '@/lib/email/activation-help-templates';
import { appUrl } from '@/lib/email/lifecycle';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACTIVATION_HELP_EMAILS = ['connection_help', 'first_call_help'] as const;
export type ActivationHelpEmail = (typeof ACTIVATION_HELP_EMAILS)[number];

export const TEMPLATE_PREFIX = 'activation_help';

export const TEMPLATES: Record<ActivationHelpEmail, string> = {
  connection_help: 'activation_help_connection',
  first_call_help: 'activation_help_first_call',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const E1_DELAY_MS = 60 * MINUTE;
export const E1_MAX_AGE_MS = 48 * HOUR;
export const E2_DELAY_MS = 3 * HOUR;
export const E2_MAX_AGE_MS = 72 * HOUR;

/** How far back the store looks for anything that could make a candidate. */
export const CANDIDATE_LOOKBACK_MS = Math.max(E1_MAX_AGE_MS, E2_MAX_AGE_MS) + HOUR;

export const HOLDOUT_PERCENT = 20;
/** Salt for hashUnit, so this split is independent of every other one. */
export const HOLDOUT_KEY = 'activation_help:v1';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Server never answered, or answered with something that was not a mail server. */
const UNREACHABLE_PHASES = new Set(['tcp', 'greeting', 'smtp_tcp', 'smtp_greeting']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionRow {
  outcome: string;
  occurredAt: string;
  category: string;
  errorCategory: string | null;
  phase: string | null;
  authReason: string | null;
}

export interface LedgerRow {
  template: string;
  status: string;
}

export interface CandidateContext {
  workspaceId: string;
  workspace: {
    ownerId: string;
    createdAt: string;
    deletedAt: string | null;
    acquisitionLocale: string | null;
    onboardingClient: string | null;
    firstInboxConnectedAt: string | null;
    firstCredentialCreatedAt: string | null;
    firstToolUsedAt: string | null;
  } | null;
  owner: {
    id: string;
    email: string | null;
    unsubscribedAt: string | null;
    unsubscribedCategories: string[];
    unsubscribeToken: string | null;
  } | null;
  /**
   * From auth: 'deleted' for a deleted account, 'unknown' when the read
   * failed. null = not read yet; the run reads it before it acts on a send or
   * a holdout, and decide() only lets 'live' through to either.
   */
  accountState: 'live' | 'deleted' | 'unknown' | null;
  internal: boolean;
  /** Every `inbox_connection` row of the workspace, any order. */
  connections: ConnectionRow[];
  /** Earliest created_at among the workspace's non-deleted inboxes, or null. */
  firstLiveInboxAt: string | null;
  liveInboxCount: number;
  /** A `first_tool_call` or `technical_activation` row exists. */
  calledEvent: boolean;
  /** A successful `credential_created` row exists. */
  credentialEvent: boolean;
  /** Category of the latest `client_selected` row, if any. */
  latestClientSelected: string | null;
  /** IMAP host from the latest connect error logged for this workspace, if any. */
  failureHost: string | null;
  /** This workspace's activation help ledger rows. */
  ledger: LedgerRow[];
}

export interface DecideConfig {
  /** Workspaces created before this are never emailed. null = nobody is. */
  startAt: Date | null;
}

export type SkipReason =
  | 'workspace_missing'
  | 'workspace_deleted'
  | 'owner_missing'
  | 'account_deleted'
  | 'account_unknown'
  | 'internal'
  | 'no_start_at'
  | 'before_start'
  | 'already_called'
  | 'not_triggered'
  | 'too_late'
  | 'already_sent'
  | 'unsubscribed'
  | 'unsubscribed_lifecycle'
  | 'no_unsubscribe_token'
  | 'unusable_email'
  | 'not_composable';

export type Decision =
  | { kind: 'send' | 'holdout'; email: ActivationHelpEmail; content: ActivationHelpContent; locale: HelpLocale }
  | { kind: 'wait'; email: ActivationHelpEmail; dueAt: string }
  | { kind: 'skip'; email: ActivationHelpEmail | null; reason: SkipReason };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

function minFinite(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  return finite.length ? Math.min(...finite) : NaN;
}

/** Stable, 20% of workspaces. Same workspace, same arm, on every run. */
export function isHoldout(workspaceId: string): boolean {
  return hashUnit(workspaceId, HOLDOUT_KEY) < HOLDOUT_PERCENT / 100;
}

export function anonymise(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

/** ChatGPT, Claude, or anything else (including nothing chosen). */
export function helpClient(value: string | null | undefined): HelpClient {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'chatgpt' || v === 'openai') return 'chatgpt';
  if (v === 'claude' || v === 'claude_code' || v === 'claude-code') return 'claude';
  return 'other';
}

// ---------------------------------------------------------------------------
// Which E1 body
// ---------------------------------------------------------------------------

/**
 * Public provider name and connect-modal slug for a mail host typed into the
 * generic IMAP form. Only consulted when the failure row says generic_imap and
 * the connect error log for the workspace recorded the host; otherwise the
 * email is keyed on the provider category alone. The host is never printed.
 */
interface HostMatch {
  provider: 'gmail' | 'yahoo' | 'aol' | 'icloud' | 'office365' | 'yandex' | 'zoho' | 'other';
  label: string;
  slug: string;
}

const HOST_TABLE: ReadonlyArray<{ suffixes: readonly string[]; match: HostMatch }> = [
  { suffixes: ['imap.gmail.com', 'imap.googlemail.com'], match: { provider: 'gmail', label: 'Gmail', slug: 'gmail' } },
  { suffixes: ['.mail.yahoo.com', 'imap.mail.yahoo.com'], match: { provider: 'yahoo', label: 'Yahoo', slug: 'yahoo' } },
  { suffixes: ['imap.aol.com'], match: { provider: 'aol', label: 'AOL', slug: 'aol' } },
  { suffixes: ['imap.mail.me.com'], match: { provider: 'icloud', label: 'iCloud', slug: 'icloud' } },
  {
    suffixes: ['outlook.office365.com', 'outlook.office.com', 'imap-mail.outlook.com', 'imap.outlook.com'],
    match: { provider: 'office365', label: 'Microsoft 365', slug: 'office365' },
  },
  { suffixes: ['imap.yandex.com', 'imap.yandex.ru'], match: { provider: 'yandex', label: 'Yandex', slug: 'yandex' } },
  { suffixes: ['imap.zoho.com', 'imap.zoho.eu', 'imappro.zoho.com', 'imappro.zoho.eu'], match: { provider: 'zoho', label: 'Zoho', slug: 'zoho' } },
  { suffixes: ['.ionos.com', '.ionos.de', '.ionos.co.uk', '.ionos.fr', '.ionos.es', '.ionos.it', '.1and1.com'], match: { provider: 'other', label: 'IONOS', slug: 'ionos' } },
  { suffixes: ['secureimap.t-online.de', 'imap.t-online.de'], match: { provider: 'other', label: 'T-Online', slug: 't-online' } },
  { suffixes: ['imap.mail.ru'], match: { provider: 'other', label: 'Mail.ru', slug: 'mail-ru' } },
  { suffixes: ['imap.qq.com', 'imap.exmail.qq.com'], match: { provider: 'other', label: 'QQ Mail', slug: 'qq' } },
  { suffixes: ['imap.mail.com'], match: { provider: 'other', label: 'mail.com', slug: 'mail-com' } },
  { suffixes: ['imap.gmx.net', 'imap.gmx.com'], match: { provider: 'other', label: 'GMX', slug: 'gmx' } },
  { suffixes: ['imap.web.de'], match: { provider: 'other', label: 'WEB.DE', slug: 'web-de' } },
  { suffixes: ['mail.infomaniak.com'], match: { provider: 'other', label: 'Infomaniak', slug: 'infomaniak' } },
  { suffixes: ['imap.orange.fr'], match: { provider: 'other', label: 'Orange', slug: 'orange-fr' } },
  { suffixes: ['imap.seznam.cz'], match: { provider: 'other', label: 'Seznam', slug: 'seznam' } },
  { suffixes: ['imap.titan.email'], match: { provider: 'other', label: 'Titan', slug: 'titan' } },
  { suffixes: ['imap.strato.de'], match: { provider: 'other', label: 'STRATO', slug: 'strato' } },
];

export function matchHost(host: string | null | undefined): HostMatch | null {
  const h = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  for (const row of HOST_TABLE) {
    for (const s of row.suffixes) {
      if (s.startsWith('.') ? h.endsWith(s) : h === s) return row.match;
    }
  }
  return null;
}

/** Category to public name and connect-modal slug, for the branded cards. */
const CATEGORY_LABELS: Record<string, { label: string; slug: string }> = {
  gmail: { label: 'Gmail', slug: 'gmail' },
  outlook: { label: 'Outlook', slug: 'outlook' },
  yahoo: { label: 'Yahoo', slug: 'yahoo' },
  icloud: { label: 'iCloud', slug: 'icloud' },
  zoho: { label: 'Zoho', slug: 'zoho' },
  yandex: { label: 'Yandex', slug: 'yandex' },
  fastmail: { label: 'Fastmail', slug: 'fastmail' },
};

const PASSWORD_REASONS = new Set([
  'account_password_used',
  'app_password_required',
  'app_password_length',
  'password_rejected',
  'provider_refused_signin',
  'login_username_required',
]);

export interface ConnectionHelpChoice {
  content: Extract<ActivationHelpContent, { email: 'connection_help' }>;
  /** Connect-modal slug for the CTA link, or null for the plain connect step. */
  slug: string | null;
}

/**
 * The E1 body for one failure row. Pure; exported for the tests.
 *
 * `host` is the IMAP host from the connect error log, used only when the row
 * is a generic IMAP failure. Without it a generic failure is keyed on what the
 * row alone says.
 */
export function connectionHelpKey(row: ConnectionRow, host: string | null): ConnectionHelpChoice {
  const errorCategory = row.errorCategory ?? '';
  const reason = row.authReason ?? '';
  const phase = row.phase ?? '';
  const generic = row.category === 'generic_imap';
  const hostMatch = generic ? matchHost(host) : null;

  // Which provider this really is: the card, or the host typed into "Other".
  let provider: string = row.category;
  let label: string | null = CATEGORY_LABELS[row.category]?.label ?? null;
  let slug: string | null = CATEGORY_LABELS[row.category]?.slug ?? null;
  if (hostMatch) {
    provider = hostMatch.provider === 'other' ? 'known_host' : hostMatch.provider;
    label = hostMatch.label;
    slug = hostMatch.slug;
  }

  const make = (key: ConnectionHelpKey, overrides: { label?: string | null; link?: string | null; slug?: string | null } = {}): ConnectionHelpChoice => ({
    content: {
      email: 'connection_help',
      key,
      label: overrides.label !== undefined ? overrides.label : label,
      providerLink: overrides.link ?? null,
    },
    slug: overrides.slug !== undefined ? overrides.slug : slug,
  });

  // The consent screen was closed or refused (OAuth: Outlook or Gmail).
  if (errorCategory === 'provider_denied') {
    if (row.category === 'outlook') return make('consent_cancelled', { label: 'Microsoft', slug: 'outlook' });
    if (row.category === 'gmail') return make('consent_cancelled', { label: 'Google', slug: 'gmail' });
  }

  // The server never answered (or was not a mail server).
  if (errorCategory === 'validation_failed' && UNREACHABLE_PHASES.has(phase)) {
    return make('server_unreachable', { label: null, slug: null });
  }

  const authFailed = errorCategory === 'auth_failed';

  if (authFailed && reason === 'imap_disabled' && label) return make('imap_disabled');

  // Microsoft 365 typed into "Other": basic auth is blocked, use the sign-in card.
  if (provider === 'office365' && (authFailed || PASSWORD_REASONS.has(reason))) {
    return make('office365_basic_auth', { slug: 'office365' });
  }

  // Reading worked, the SMTP login did not.
  if (authFailed && phase.startsWith('smtp')) return make('smtp_rejected');

  if (authFailed || PASSWORD_REASONS.has(reason)) {
    if (provider === 'gmail') return make('gmail_app_password', { label: 'Gmail' });
    if (provider === 'yahoo') {
      return make('yahoo_app_password', { label: 'Yahoo', link: PROVIDER_LINKS.yahooAppPasswords });
    }
    if (provider === 'aol') return make('yahoo_app_password', { label: 'AOL', link: PROVIDER_LINKS.aolAppPasswords });
    if (provider === 'icloud') return make('icloud_app_password', { label: 'iCloud' });
    if (provider === 'known_host') return make('known_host');
    if (generic) return make('generic_password', { label: null });
  }

  return make('generic');
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Latest row first; on a tie, a success sorts first (it cannot be ignored). */
function latestFirst(rows: ConnectionRow[]): ConnectionRow[] {
  return [...rows].sort((a, b) => {
    const d = ms(b.occurredAt) - ms(a.occurredAt);
    if (d !== 0) return d;
    return (a.outcome === 'success' ? 0 : 1) - (b.outcome === 'success' ? 0 : 1);
  });
}

type Trigger =
  | { email: 'connection_help'; at: number; row: ConnectionRow }
  | { email: 'first_call_help'; at: number }
  | null;

/** Which email this workspace is a candidate for right now, if any. */
export function trigger(ctx: CandidateContext): Trigger {
  const w = ctx.workspace!;
  const finished = ctx.connections.filter((r) => r.outcome === 'success' || r.outcome === 'failure');
  const ordered = latestFirst(finished);
  const successes = finished.filter((r) => r.outcome === 'success');

  const firstConnectedMs = minFinite([
    ms(w.firstInboxConnectedAt),
    ...successes.map((r) => ms(r.occurredAt)),
    ms(ctx.firstLiveInboxAt),
  ]);
  const connected = ctx.liveInboxCount > 0 || Number.isFinite(firstConnectedMs);

  const latest = ordered[0];
  if (latest && latest.outcome === 'failure' && ctx.liveInboxCount === 0) {
    return { email: 'connection_help', at: ms(latest.occurredAt), row: latest };
  }
  if (connected && Number.isFinite(firstConnectedMs)) {
    return { email: 'first_call_help', at: firstConnectedMs };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What to do with this workspace right now. Pure.
 *
 * Order: who may never be emailed, then which email applies, then once-only,
 * then timing, then the per-person opt-out, then the holdout. The holdout is
 * last, so the control arm has exactly the send arm's eligibility.
 */
export function decide(ctx: CandidateContext, now: Date, config: DecideConfig): Decision {
  const nowMs = now.getTime();
  const w = ctx.workspace;
  if (!w) return skip(null, 'workspace_missing');
  if (w.deletedAt) return skip(null, 'workspace_deleted');
  const owner = ctx.owner;
  if (!owner || owner.id !== w.ownerId) return skip(null, 'owner_missing');
  if (ctx.accountState === 'deleted') return skip(null, 'account_deleted');
  if (ctx.internal) return skip(null, 'internal');
  if (!config.startAt || !Number.isFinite(config.startAt.getTime())) return skip(null, 'no_start_at');
  if (!(ms(w.createdAt) >= config.startAt.getTime())) return skip(null, 'before_start');

  const hasCalled = ctx.calledEvent || Boolean(w.firstToolUsedAt);
  if (hasCalled) return skip(null, 'already_called');

  const t = trigger(ctx);
  if (!t) return skip(null, 'not_triggered');
  const email = t.email;

  if (ctx.ledger.some((r) => r.template === TEMPLATES[email])) return skip(email, 'already_sent');

  const delay = email === 'connection_help' ? E1_DELAY_MS : E2_DELAY_MS;
  const maxAge = email === 'connection_help' ? E1_MAX_AGE_MS : E2_MAX_AGE_MS;
  if (nowMs < t.at + delay) return { kind: 'wait', email, dueAt: new Date(t.at + delay).toISOString() };
  if (nowMs >= t.at + maxAge) return skip(email, 'too_late');

  if (owner.unsubscribedAt) return skip(email, 'unsubscribed');
  if ((owner.unsubscribedCategories ?? []).includes('lifecycle')) return skip(email, 'unsubscribed_lifecycle');
  if (!owner.unsubscribeToken) return skip(email, 'no_unsubscribe_token');
  if (!owner.email || !EMAIL_RE.test(owner.email.trim())) return skip(email, 'unusable_email');
  if (ctx.accountState === 'unknown') return skip(email, 'account_unknown');

  const locale = helpLocale(w.acquisitionLocale);
  let content: ActivationHelpContent;
  if (t.email === 'connection_help') {
    content = connectionHelpKey(t.row, ctx.failureHost).content;
  } else {
    const linked = ctx.credentialEvent || Boolean(w.firstCredentialCreatedAt);
    const state: FirstCallState = linked ? 'linked_no_call' : 'not_linked';
    content = { email: 'first_call_help', state, client: helpClient(w.onboardingClient ?? ctx.latestClientSelected) };
  }

  return { kind: isHoldout(ctx.workspaceId) ? 'holdout' : 'send', email, content, locale };
}

function skip(email: ActivationHelpEmail | null, reason: SkipReason): Decision {
  return { kind: 'skip', email, reason };
}

/** The one link back into the product. */
export function ctaUrlFor(ctx: CandidateContext, decision: Extract<Decision, { kind: 'send' | 'holdout' }>): string {
  const base = appUrl();
  if (decision.email === 'first_call_help') return `${base}/dashboard`;
  const t = trigger(ctx);
  const slug = t && t.email === 'connection_help' ? connectionHelpKey(t.row, ctx.failureHost).slug : null;
  return slug ? `${base}/dashboard/inboxes?provider=${encodeURIComponent(slug)}` : `${base}/dashboard/inboxes`;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ClaimRow {
  userId: string;
  workspaceId: string;
  email: ActivationHelpEmail;
  address: string;
  status: 'claimed' | 'holdout';
  detail: string | null;
}

export interface ActivationHelpStore {
  /** Workspace ids with any activity in the look-back window that could trigger an email. */
  listCandidateIds(since: Date, startAt: Date): Promise<string[]>;
  /** Everything decide() reads, for these workspaces. accountState is left null. */
  loadContexts(workspaceIds: string[]): Promise<CandidateContext[]>;
  /** 'live', 'deleted' or 'unknown' for the owner's auth account. */
  accountState(userId: string): Promise<'live' | 'deleted' | 'unknown'>;
  /** Fresh read of the opt-out right before a send. Fails closed (true). */
  isSuppressed(userId: string): Promise<boolean>;
  /** INSERT ... ON CONFLICT DO NOTHING. True only for the caller that created the row. */
  claim(row: ClaimRow): Promise<boolean>;
  /** Move a claimed row to its terminal state. Never deletes. */
  finish(
    key: { userId: string; workspaceId: string; email: ActivationHelpEmail },
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
  store: ActivationHelpStore;
  /** Required for mode 'send'. Never called in dry_run. */
  send?: Sender;
  mode: RunMode;
  config: DecideConfig;
  now?: Date;
  maxSends?: number;
  outOfTime?: () => boolean;
}

export interface RunEntry {
  /** sha256(workspace id), first 12 hex characters. Never the raw id. */
  workspace: string;
  decision: Decision['kind'];
  email: ActivationHelpEmail | null;
  reason: string | null;
  /** E1 body key or E2 state/client, for review in a dry run. */
  content: string | null;
  locale: HelpLocale | null;
  subject: string | null;
  outcome: 'sent' | 'failed' | 'lost_claim' | 'holdout_recorded' | 'would_send' | 'would_hold_out' | 'none';
}

export interface RunReport {
  mode: RunMode;
  candidates: number;
  sent: number;
  failed: number;
  heldOut: number;
  lostClaims: number;
  wouldSend: Record<ActivationHelpEmail, number>;
  wouldHoldOut: Record<ActivationHelpEmail, number>;
  waiting: number;
  skipped: Record<string, number>;
  truncated: boolean;
  entries: RunEntry[];
}

export const DEFAULT_MAX_SENDS = 25;

function contentTag(content: ActivationHelpContent): string {
  return content.email === 'connection_help' ? content.key : `${content.state}:${content.client}`;
}

export async function runActivationHelp(options: RunOptions): Promise<RunReport> {
  const { store, mode, config } = options;
  const now = options.now ?? new Date();
  const maxSends = options.maxSends ?? DEFAULT_MAX_SENDS;
  if (mode === 'send' && !options.send) throw new Error('mode "send" needs a sender');

  const report: RunReport = {
    mode,
    candidates: 0,
    sent: 0,
    failed: 0,
    heldOut: 0,
    lostClaims: 0,
    wouldSend: { connection_help: 0, first_call_help: 0 },
    wouldHoldOut: { connection_help: 0, first_call_help: 0 },
    waiting: 0,
    skipped: {},
    truncated: false,
    entries: [],
  };

  // Without a start date nobody is eligible; do not even read the candidates.
  if (!config.startAt || !Number.isFinite(config.startAt.getTime())) {
    report.skipped.no_start_at = 1;
    return report;
  }

  const ids = await store.listCandidateIds(new Date(now.getTime() - CANDIDATE_LOOKBACK_MS), config.startAt);
  const contexts = await store.loadContexts(ids);
  report.candidates = contexts.length;

  for (const initial of contexts) {
    if (options.outOfTime?.()) {
      report.truncated = true;
      break;
    }

    let ctx = initial;
    let decision = decide(ctx, now, config);

    // Before acting on a send or a holdout: re-read this workspace, read the
    // auth account, and decide again, so every check is as fresh as it can be.
    if (decision.kind === 'send' || decision.kind === 'holdout') {
      const [fresh] = await store.loadContexts([ctx.workspaceId]);
      ctx = fresh ?? { ...ctx, workspace: null };
      if (ctx.owner) ctx = { ...ctx, accountState: await store.accountState(ctx.owner.id) };
      decision = decide(ctx, now, config);
    }

    const entry: RunEntry = {
      workspace: anonymise(ctx.workspaceId),
      decision: decision.kind,
      email: decision.email,
      reason: decision.kind === 'skip' ? decision.reason : null,
      content: decision.kind === 'send' || decision.kind === 'holdout' ? contentTag(decision.content) : null,
      locale: decision.kind === 'send' || decision.kind === 'holdout' ? decision.locale : null,
      subject: null,
      outcome: 'none',
    };
    report.entries.push(entry);

    if (decision.kind === 'wait') {
      report.waiting += 1;
      continue;
    }
    if (decision.kind === 'skip') {
      report.skipped[decision.reason] = (report.skipped[decision.reason] ?? 0) + 1;
      continue;
    }

    const owner = ctx.owner!;
    const address = owner.email!.trim();

    if (decision.kind === 'holdout') {
      if (mode === 'dry_run') {
        report.wouldHoldOut[decision.email] += 1;
        entry.outcome = 'would_hold_out';
        continue;
      }
      const won = await store.claim({
        userId: owner.id,
        workspaceId: ctx.workspaceId,
        email: decision.email,
        address,
        status: 'holdout',
        detail: contentTag(decision.content),
      });
      if (won) {
        report.heldOut += 1;
        entry.outcome = 'holdout_recorded';
      } else {
        report.lostClaims += 1;
        entry.outcome = 'lost_claim';
      }
      continue;
    }

    // decision.kind === 'send'
    const composed = composeActivationHelp({
      content: decision.content,
      locale: decision.locale,
      ctaUrl: ctaUrlFor(ctx, decision),
      unsubscribeToken: owner.unsubscribeToken,
    });
    entry.subject = composed?.subject ?? null;
    if (!composed) {
      report.skipped.not_composable = (report.skipped.not_composable ?? 0) + 1;
      continue;
    }

    if (mode === 'dry_run') {
      report.wouldSend[decision.email] += 1;
      entry.outcome = 'would_send';
      continue;
    }

    if (report.sent + report.failed >= maxSends) {
      report.truncated = true;
      break;
    }

    // The opt-out, read once more on its own, immediately before the send.
    if (await store.isSuppressed(owner.id)) {
      report.skipped.unsubscribed = (report.skipped.unsubscribed ?? 0) + 1;
      entry.decision = 'skip';
      entry.reason = 'unsubscribed';
      continue;
    }

    // THE CLAIM. Only the winner of this insert sends.
    const won = await store.claim({
      userId: owner.id,
      workspaceId: ctx.workspaceId,
      email: decision.email,
      address,
      status: 'claimed',
      detail: contentTag(decision.content),
    });
    if (!won) {
      report.lostClaims += 1;
      entry.outcome = 'lost_claim';
      continue;
    }

    const key = { userId: owner.id, workspaceId: ctx.workspaceId, email: decision.email };
    let result: SendResult;
    try {
      result = await options.send!({
        to: address,
        subject: composed.subject,
        text: composed.text,
        html: composed.html,
        headers: composed.headers,
        idempotencyKey: `${TEMPLATES[decision.email]}-${ctx.workspaceId}`,
      });
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'unexpected_error' };
    }

    if (result.ok) {
      await store.finish(key, { status: 'sent', providerId: result.id });
      report.sent += 1;
      entry.outcome = 'sent';
    } else {
      // Kept, never retried: the ledger row makes this workspace done.
      await store.finish(key, { status: 'failed', detail: result.reason });
      report.failed += 1;
      entry.outcome = 'failed';
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Switches, read at CALL time
// ---------------------------------------------------------------------------

export type ActivationHelpMode = 'off' | RunMode;

/**
 *   ACTIVATION_HELP_ENABLED   must be exactly `on` (or `true`). Anything else,
 *                             including unset, is `off`: the route returns
 *                             before touching the database.
 *   ACTIVATION_HELP_DRY_RUN   dry run unless exactly `false` (or `off`).
 *
 * A real email needs BOTH, plus ACTIVATION_HELP_START_AT, and a typo in any of
 * them fails towards silence.
 */
export function activationHelpMode(env: Record<string, string | undefined> = process.env): ActivationHelpMode {
  const enabled = (env.ACTIVATION_HELP_ENABLED ?? '').trim().toLowerCase();
  if (enabled !== 'on' && enabled !== 'true') return 'off';
  const dry = (env.ACTIVATION_HELP_DRY_RUN ?? '').trim().toLowerCase();
  return dry === 'false' || dry === 'off' ? 'send' : 'dry_run';
}

/** ACTIVATION_HELP_START_AT as a date, or null when unset or not a date. */
export function activationHelpStartAt(env: Record<string, string | undefined> = process.env): Date | null {
  const raw = (env.ACTIVATION_HELP_START_AT ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** ACTIVATION_HELP_MAX_PER_RUN, clamped to 1..100, default DEFAULT_MAX_SENDS. */
export function activationHelpMaxPerRun(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.ACTIVATION_HELP_MAX_PER_RUN ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_SENDS;
  return Math.min(100, Math.max(1, n));
}

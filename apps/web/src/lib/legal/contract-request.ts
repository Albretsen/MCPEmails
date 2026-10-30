/**
 * The public cancellation and withdrawal form (/cancel): validate, rate-limit,
 * store, then send.
 *
 * WHY IT EXISTS. Two rules ask for the same thing. §312k BGB requires a
 * "cancel contracts here" button that reaches a form without a login, one
 * page with the details and a "cancel now" button, and a confirmation the
 * customer can keep. The customer may name the date an ordinary cancellation
 * takes effect (§312k(2) Nr. 1), so `effectiveDate` is optional. Directive (EU)
 * 2023/2673 (in force for distance contracts from 2026-06-19) adds the same
 * shape for the right of withdrawal. A customer must be able to end the
 * contract with nothing but their name, the account address and two clicks.
 *
 * THE CANCELLATION ITSELF IS MANUAL. This form records the declaration and
 * tells both sides; a person then sets `cancel_at` (or refunds) in Stripe. The
 * declaration is legally effective when it is received, not when Stripe is
 * updated, which is why the receipt states the time we received it.
 *
 * THREE KINDS. `cancel` stops a subscription's next renewal. `withdraw` is
 * the 14-day withdrawal from a subscription. `withdraw_pass` is the 14-day
 * withdrawal from the non-renewing 3-month Personal pass (a one-off payment,
 * no subscription behind it). None of them looks up the account: a pass
 * buyer with no subscription goes through exactly like everyone else, and
 * the refund stays a manual step in Stripe (refunding the pass payment ends
 * the pass through the `charge.refunded` webhook). The kind is stored on the
 * row and named in the notice subject, so a pass request is never mistaken
 * for a subscription one.
 *
 * STORED AS A SUPPORT TICKET. Same table, same MCPE-1234 reference, same
 * rate limits as the /help form (src/lib/support/tickets.ts), so a request
 * lands in the support inbox with a ref and is findable with one query:
 *   select * from support_tickets where context ? 'contract_request';
 * No migration: category 'billing' and source 'form_signed_out' already pass
 * the table's CHECK constraints.
 *
 * WHAT THE RECEIPT ECHOES. The receipt goes to whatever address was typed, so
 * it repeats only the structured choices plus the name and contract number,
 * each one line and capped at 100 characters. The free-text reason for an
 * extraordinary cancellation is never echoed (see the note in
 * src/lib/support/emails.ts on why a public form must not carry visitor text
 * to a third party).
 *
 * Everything with I/O is injected (`ContractRequestDeps`) so the flow is
 * testable without a network.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createResend } from '@/lib/email/resend';

import type { Database, Json } from '@/types/database.types';

import { CANCEL_PATH, POSTAL_ADDRESS_LINE, WITHDRAWAL_PATH } from '@/lib/email/legal';
import { EMPTY_TICKET_CONTEXT } from '@/lib/support/context';
import { oneLine, SUPPORT_FROM, SUPPORT_INBOX, supportIdempotencyKey } from '@/lib/support/emails';
import { checkSupportFormToken } from '@/lib/support/form-token';
import { isRateLimited, type TicketCounter } from '@/lib/support/rate-limit';
import { normalizeEmail } from '@/lib/support/validation';

export const CONTRACT_REQUEST_KINDS = ['cancel', 'withdraw', 'withdraw_pass'] as const;
export type ContractRequestKind = (typeof CONTRACT_REQUEST_KINDS)[number];

export const CANCEL_TYPES = ['ordinary', 'extraordinary'] as const;
export type CancelType = (typeof CANCEL_TYPES)[number];

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de'] as const;

export const CONTRACT_REQUEST_LIMITS = {
  name: 100,
  contract: 100,
  reason: 2000,
} as const;

/** How far ahead an effective date may be, in days (about five years). */
export const EFFECTIVE_DATE_MAX_DAYS = 5 * 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ContractRequestErrorCode =
  | 'invalid_json'
  | 'invalid_form_token'
  | 'invalid_kind'
  | 'name_required'
  | 'name_too_long'
  | 'invalid_email'
  | 'contract_too_long'
  | 'invalid_cancel_type'
  | 'reason_required'
  | 'reason_too_long'
  | 'invalid_effective_date';

export interface ValidContractRequest {
  kind: ContractRequestKind;
  name: string;
  email: string;
  contract: string | null;
  /** Null for either withdrawal. */
  cancelType: CancelType | null;
  /** Only for an extraordinary cancellation. */
  reason: string | null;
  /**
   * YYYY-MM-DD the customer asked an ordinary cancellation to take effect on.
   * Null means the earliest possible date, and for every other kind.
   */
  effectiveDate: string | null;
  locale: string;
}

export type ContractRequestValidation =
  | { kind: 'ok'; request: ValidContractRequest }
  | { kind: 'drop' }
  | { kind: 'error'; error: ContractRequestErrorCode };

/** Strips NULs and other C0 controls except newline and tab; normalises CRLF. */
function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

/** One line of visitor text, or '' when absent. */
function cleanLine(value: unknown): string {
  return typeof value === 'string' ? oneLine(cleanText(value)) : '';
}

/**
 * An optional YYYY-MM-DD from today (in the visitor's time zone, so one day of
 * slack behind UTC) to about five years out. Returns null when absent, false
 * when present but invalid.
 */
export function parseEffectiveDate(value: unknown, nowMs: number): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return false;
  const todayUtc = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  if (ms < todayUtc - DAY_MS) return false;
  if (ms > todayUtc + EFFECTIVE_DATE_MAX_DAYS * DAY_MS) return false;
  return value;
}

/**
 * Honeypot and form token first (a bot gets its silent 200 before anything
 * else is looked at), then the fields in form order.
 */
export function validateContractRequest(raw: unknown, opts: { nowMs: number }): ContractRequestValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'error', error: 'invalid_json' };
  const body = raw as Record<string, unknown>;

  if (body.website !== undefined && body.website !== null && body.website !== '') return { kind: 'drop' };

  const token = checkSupportFormToken(body.formToken, opts.nowMs);
  if (token === 'too_fast') return { kind: 'drop' };
  if (token !== 'ok') return { kind: 'error', error: 'invalid_form_token' };

  const kind = body.kind;
  if (typeof kind !== 'string' || !(CONTRACT_REQUEST_KINDS as readonly string[]).includes(kind)) {
    return { kind: 'error', error: 'invalid_kind' };
  }

  const name = cleanLine(body.name);
  if (!name) return { kind: 'error', error: 'name_required' };
  if (name.length > CONTRACT_REQUEST_LIMITS.name) return { kind: 'error', error: 'name_too_long' };

  const email = normalizeEmail(body.email);
  if (!email) return { kind: 'error', error: 'invalid_email' };

  const contract = cleanLine(body.contract);
  if (contract.length > CONTRACT_REQUEST_LIMITS.contract) return { kind: 'error', error: 'contract_too_long' };

  let cancelType: CancelType | null = null;
  let reason: string | null = null;
  let effectiveDate: string | null = null;
  if (kind === 'cancel') {
    const type = body.cancelType;
    if (typeof type !== 'string' || !(CANCEL_TYPES as readonly string[]).includes(type)) {
      return { kind: 'error', error: 'invalid_cancel_type' };
    }
    cancelType = type as CancelType;
    if (cancelType === 'extraordinary') {
      reason = typeof body.reason === 'string' ? cleanText(body.reason) : '';
      if (!reason) return { kind: 'error', error: 'reason_required' };
      if (reason.length > CONTRACT_REQUEST_LIMITS.reason) return { kind: 'error', error: 'reason_too_long' };
    } else {
      // A date sent with a withdrawal or an extraordinary cancellation is
      // ignored: both take effect immediately.
      const date = parseEffectiveDate(body.effectiveDate, opts.nowMs);
      if (date === false) return { kind: 'error', error: 'invalid_effective_date' };
      effectiveDate = date;
    }
  }

  const locale =
    typeof body.locale === 'string' && (LOCALES as readonly string[]).includes(body.locale) ? body.locale : 'en';

  return {
    kind: 'ok',
    request: {
      kind: kind as ContractRequestKind,
      name,
      email,
      contract: contract || null,
      cancelType,
      reason,
      effectiveDate,
      locale,
    },
  };
}

// ---------------------------------------------------------------------------
// Emails (English, like every other transactional email; see emails.ts)
// ---------------------------------------------------------------------------

export interface ComposedEmail {
  subject: string;
  body: string;
  htmlBody: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "2026-10-20 14:03 UTC": unambiguous for a reader in any time zone. */
export function receivedAtLabel(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** True for both withdrawals (subscription and 3-month pass). */
export function isWithdrawal(kind: ContractRequestKind): boolean {
  return kind === 'withdraw' || kind === 'withdraw_pass';
}

function requestLabel(r: ValidContractRequest): string {
  if (r.kind === 'withdraw_pass') return 'Withdrawal from your MCPEmails 3-month Personal pass';
  if (r.kind === 'withdraw') return 'Withdrawal from your MCPEmails subscription';
  return r.cancelType === 'extraordinary'
    ? 'Extraordinary cancellation of your MCPEmails subscription'
    : 'Cancellation of your MCPEmails subscription';
}

function effectiveLabel(r: ValidContractRequest): string {
  if (r.kind === 'cancel' && r.cancelType === 'ordinary') {
    if (r.effectiveDate) {
      return `${r.effectiveDate}, or the end of the period you have already paid for if that is later`;
    }
    return 'At the earliest possible date: the end of the period you have already paid for';
  }
  return 'Immediately';
}

function nextStep(r: ValidContractRequest): string {
  if (r.kind === 'withdraw_pass') {
    return 'We refund the payment for your pass in full within 14 days, to the card you paid with, and email you when it is done. The pass does not renew, so there is nothing else to cancel.';
  }
  if (r.kind === 'withdraw') {
    return 'We refund the first charge in full within 14 days, to the card you paid with, and email you when it is done.';
  }
  return 'We stop your subscription in our billing system within two business days and email you when that is done. You do not need to do anything else.';
}

/** The facts both emails share, in order. Visitor text is one line and capped by validation. */
function factRows(r: ValidContractRequest, ref: string, receivedAt: string): Array<[string, string]> {
  return [
    ['Reference', ref],
    ['Received', receivedAtLabel(receivedAt)],
    ['Request', requestLabel(r)],
    ['Takes effect', effectiveLabel(r)],
    ['Name', r.name],
    ['Account email', r.email],
    ['Plan or invoice number', r.contract ?? '-'],
  ];
}

export function buildContractReceiptEmail(r: ValidContractRequest, ref: string, receivedAt: string, baseUrl: string): ComposedEmail {
  const what = isWithdrawal(r.kind) ? 'withdrawal' : 'cancellation';
  const subject = `Your ${what} is received (${oneLine(ref)})`;
  const rows = factRows(r, ref, receivedAt);
  const reasonNote = r.reason ? 'You also gave a reason, which we keep with this request.' : null;
  const notYou = 'If you did not send this, reply to this email before we process it and we will not act on it.';
  const body = [
    `We received your ${what}. This email is your confirmation; keep it for your records.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(reasonNote ? ['', reasonNote] : []),
    '',
    nextStep(r),
    '',
    notYou,
    '',
    'MCPEmails Support',
    SUPPORT_INBOX,
    `${baseUrl}${WITHDRAWAL_PATH}`,
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');
  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#64748b;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 0;color:#0f172a;">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const htmlBody = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;font-size:15px;line-height:1.6;">
<p>We received your ${what}. This email is your confirmation; keep it for your records.</p>
<table cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 16px;">${table}</table>
${reasonNote ? `<p>${escapeHtml(reasonNote)}</p>` : ''}
<p>${escapeHtml(nextStep(r))}</p>
<p style="color:#64748b;font-size:13px;">${escapeHtml(notYou)}</p>
<p>MCPEmails Support<br><a href="mailto:${SUPPORT_INBOX}" style="color:#3b82f6;">${SUPPORT_INBOX}</a></p>
<p style="color:#94a3b8;font-size:12px;">${escapeHtml(POSTAL_ADDRESS_LINE)}</p>
</body></html>`;
  return { subject, body, htmlBody };
}

export function buildContractNoticeEmail(r: ValidContractRequest, ref: string, receivedAt: string): ComposedEmail {
  const label =
    r.kind === 'withdraw_pass'
      ? 'WITHDRAWAL (3-month pass)'
      : r.kind === 'withdraw'
        ? 'WITHDRAWAL'
        : r.cancelType === 'extraordinary'
          ? 'CANCEL (extraordinary)'
          : 'CANCEL';
  const subject = oneLine(`[${ref}] ${label}: ${r.name} <${r.email}>`).slice(0, 200);
  const todo =
    r.kind === 'withdraw_pass'
      ? 'To do: refund the 3-month pass payment in full in Stripe, within 14 days of the received time. The refund ends the pass. The customer may also have a Personal subscription bought during the pass that starts charging at the pass end: the refund webhook moves that first charge to today (or to the end of a queued pass), so check the customer in Stripe afterwards. If the account has a subscription, ask the customer which one they meant.'
      : r.kind === 'withdraw'
        ? 'To do: refund the first charge in full and cancel the subscription now, within 14 days of the received time.'
        : r.cancelType === 'extraordinary'
          ? 'To do: read the reason, end the subscription now if it holds, and reply to the customer.'
          : r.effectiveDate
            ? `To do: set cancel_at in Stripe to ${r.effectiveDate} or the end of the paid period, whichever is later, then reply to the customer.`
            : 'To do: set cancel_at to the end of the paid period in Stripe, then reply to the customer.';
  const lines = [
    todo,
    '',
    ...factRows(r, ref, receivedAt).map(([k, v]) => `${k}: ${v}`),
    `Locale: ${r.locale}`,
    ...(r.reason ? ['', 'Reason:', r.reason] : []),
    '',
    `Submitted through ${CANCEL_PATH} without a login. The address has not been verified.`,
  ];
  const body = lines.join('\n');
  const htmlBody = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
<pre style="font-size:13px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(body)}</pre>
</body></html>`;
  return { subject, body, htmlBody };
}

/** The row's `message`: everything the notice says, so the record stands without the email. */
function storedMessage(r: ValidContractRequest, receivedAt: string): string {
  return buildContractNoticeEmail(r, 'pending', receivedAt).body.slice(0, 5000);
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface ContractRequestStore extends TicketCounter {
  insert(row: {
    email: string;
    subject: string;
    message: string;
    context: Record<string, unknown>;
    ip_hash: string | null;
  }): Promise<{ id: string; ref: string } | null>;
  markSent(id: string, fields: { notified_at?: string; confirmation_sent_at?: string }): Promise<void>;
}

export interface ContractRequestDeps {
  store: ContractRequestStore;
  sendNotice(email: ComposedEmail, replyTo: string, ref: string): Promise<boolean>;
  sendReceipt(email: ComposedEmail, to: string, ref: string): Promise<boolean>;
  now(): number;
  baseUrl: string;
}

export type ContractRequestResponseBody =
  | { ok: true; ref: string | null; receivedAt: string | null }
  | { ok: false; error: ContractRequestErrorCode | 'rate_limited' | 'server_error' };

export interface ContractRequestOutcome {
  status: 200 | 201 | 400 | 429 | 500;
  body: ContractRequestResponseBody;
}

export async function submitContractRequest(
  input: { rawBody: string; ipHash: string | null },
  deps: ContractRequestDeps,
): Promise<ContractRequestOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json' } };
  }

  const nowMs = deps.now();
  const result = validateContractRequest(parsed, { nowMs });
  if (result.kind === 'drop') return { status: 200, body: { ok: true, ref: null, receivedAt: null } };
  if (result.kind === 'error') return { status: 400, body: { ok: false, error: result.error } };
  const r = result.request;

  if (await isRateLimited(deps.store, { ipHash: input.ipHash, email: r.email, source: 'form_signed_out', nowMs })) {
    return { status: 429, body: { ok: false, error: 'rate_limited' } };
  }

  const receivedAt = new Date(nowMs).toISOString();
  const subject =
    r.kind === 'withdraw_pass'
      ? 'Withdrawal from 3-month pass'
      : r.kind === 'withdraw'
        ? 'Withdrawal from contract'
        : `Cancellation (${r.cancelType})`;

  let stored: { id: string; ref: string } | null = null;
  try {
    stored = await deps.store.insert({
      email: r.email,
      subject,
      message: storedMessage(r, receivedAt),
      context: {
        ...EMPTY_TICKET_CONTEXT,
        contract_request: {
          kind: r.kind,
          cancel_type: r.cancelType,
          effective_date: r.effectiveDate,
          name: r.name,
          contract: r.contract,
          locale: r.locale,
          received_at: receivedAt,
        },
      },
      ip_hash: input.ipHash,
    });
  } catch (err) {
    console.error('[contract-request] insert threw:', err instanceof Error ? err.message : String(err));
    stored = null;
  }
  if (!stored) return { status: 500, body: { ok: false, error: 'server_error' } };

  const [notified, confirmed] = await Promise.all([
    deps.sendNotice(buildContractNoticeEmail(r, stored.ref, receivedAt), r.email, stored.ref).catch(() => false),
    deps.sendReceipt(buildContractReceiptEmail(r, stored.ref, receivedAt, deps.baseUrl), r.email, stored.ref).catch(() => false),
  ]);

  const sentAt = new Date(deps.now()).toISOString();
  const fields: { notified_at?: string; confirmation_sent_at?: string } = {};
  if (notified) fields.notified_at = sentAt;
  if (confirmed) fields.confirmation_sent_at = sentAt;
  if (!notified) console.error(`[contract-request] ${stored.ref} stored but the notice to support was not sent`);
  if (!confirmed) console.error(`[contract-request] ${stored.ref} stored but the customer receipt was not sent`);
  if (notified || confirmed) {
    await deps.store.markSent(stored.id, fields).catch((err: unknown) => {
      console.error('[contract-request] markSent failed:', err instanceof Error ? err.message : String(err));
    });
  }

  return { status: 201, body: { ok: true, ref: stored.ref, receivedAt } };
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

/** support_tickets, with the service-role client (the table has no policies). */
export function createSupabaseContractRequestStore(service: SupabaseClient<Database>): ContractRequestStore {
  return {
    async count(filter, sinceIso) {
      let q = service.from('support_tickets').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
      if (filter.ipHash) q = q.eq('ip_hash', filter.ipHash);
      if (filter.email) q = q.eq('email', filter.email);
      if (filter.source) q = q.eq('source', filter.source);
      const { count, error } = await q;
      return error ? null : (count ?? 0);
    },
    async insert(row) {
      const { data, error } = await service
        .from('support_tickets')
        .insert({
          user_id: null,
          workspace_id: null,
          email: row.email,
          category: 'billing',
          subject: row.subject,
          message: row.message,
          context: row.context as unknown as NonNullable<Json>,
          source: 'form_signed_out',
          ip_hash: row.ip_hash,
        })
        .select('id, ref')
        .single();
      if (error || !data) {
        console.error('[contract-request] insert failed:', error?.code ?? 'no_row');
        return null;
      }
      return { id: data.id, ref: data.ref };
    },
    async markSent(id, fields) {
      const { error } = await service.from('support_tickets').update(fields).eq('id', id);
      if (error) console.error('[contract-request] markSent failed:', error.code);
    },
  };
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value) ? value : 'unexpected_response';
}

/** One attempt, an Idempotency-Key from the environment and ref, never throws (same rules as emails.ts). */
export async function sendViaResend(
  kind: 'notice' | 'receipt',
  ref: string,
  message: { to: string; replyTo: string } & ComposedEmail,
): Promise<boolean> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.error(`[contract-request] no RESEND_API_KEY configured; ${kind} for ${ref} not sent`);
      return false;
    }
    const { error } = await createResend(key).emails.send(
      {
        from: SUPPORT_FROM,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.htmlBody,
        text: message.body,
      },
      { idempotencyKey: supportIdempotencyKey('contract', kind, ref) },
    );
    if (error) {
      console.error(`[contract-request] ${kind} FAILED for ${ref}: ${safeCode(error.message)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[contract-request] ${kind} for ${ref} threw, swallowed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

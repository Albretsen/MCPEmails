/**
 * The one place a Resend client is constructed. Every sender in apps/web calls
 * createResend(key) instead of `new Resend(key)`; resend-factory.test.ts fails
 * the build if a `new Resend(` appears anywhere else.
 *
 * IN EVERY ENVIRONMENT a refused or thrown send is reported to the owner
 * (./resend-failure-alert.ts). The answer passed back to the caller is
 * unchanged.
 *
 * IN PRODUCTION (APP_ENV unset or `production`) nothing else changes: the
 * payload goes to Resend as given.
 *
 * ANYWHERE ELSE (staging, development) `emails.send` and `batch.send` are
 * wrapped so mail can only reach EMAIL_RECIPIENT_ALLOWLIST (exact addresses and
 * `@domain` entries, see src/lib/env/app-env.ts). Every other to/cc/bcc address
 * is dropped and logged. When no recipient is left, the call is skipped and
 * answers like an accepted send, with an id starting `skipped-not-allowlisted`
 * and no error. That is deliberate: the dispatchers record a claimed row as
 * sent or failed from this answer, and a "failed" row would be retried or would
 * end a sequence, which is not what a staging skip means. A batch keeps its
 * positions: skipped emails get a synthetic id in place, so callers that map
 * ids back by index still line up.
 *
 * IN EVERY ENVIRONMENT a recipient that cannot be a real address (no dot in
 * the domain, or an ending such as `.x` that no top-level domain has) is
 * dropped before the payload reaches Resend, which would answer 422 for the
 * whole send. Such addresses come from typos at signup: production confirms
 * email signups instantly, so nothing else catches them. The drop is logged
 * with the domain only and does NOT alert: there is nothing to fix on our
 * side. When no `to` recipient is left, a single send answers with an
 * `invalid_recipient` error (the caller records it as failed, which also ends
 * a lifecycle sequence) and a batch fills the position with an id starting
 * `skipped-invalid-recipient`.
 */
import { Resend } from 'resend';

import { isAllowlistedAddress, isProduction, recipientAllowlist } from '@/lib/env/app-env';

import { fromDomain, reportResendFailure, type ResendFailure } from '@/lib/email/resend-failure-alert';

export const SKIPPED_ID_PREFIX = 'skipped-not-allowlisted';
export const INVALID_RECIPIENT_ID_PREFIX = 'skipped-invalid-recipient';
export const INVALID_RECIPIENT_ERROR = 'invalid_recipient';

type Recipients = string | string[] | undefined;
type Addressed = { to?: Recipients; cc?: Recipients; bcc?: Recipients };

function asList(value: Recipients): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The mail domain only, so a log line never carries a whole address. */
function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? `*${address.slice(at).replace(/>.*$/, '')}` : '*';
}

/**
 * Removes every recipient outside the allowlist. Returns the filtered payload,
 * or null when no `to` recipient is left (cc/bcc alone never carry a send).
 */
export function filterRecipients<T extends Addressed>(payload: T, allowlist: string[]): T | null {
  const dropped: string[] = [];
  const keep = (value: Recipients): string[] =>
    asList(value).filter((address) => {
      const ok = isAllowlistedAddress(address, allowlist);
      if (!ok) dropped.push(maskAddress(address));
      return ok;
    });
  const to = keep(payload.to);
  const cc = keep(payload.cc);
  const bcc = keep(payload.bcc);
  if (dropped.length > 0) {
    console.warn(`[resend] non-production: dropped ${dropped.length} recipient(s) outside EMAIL_RECIPIENT_ALLOWLIST: ${dropped.join(', ')}`);
  }
  if (to.length === 0) return null;
  const next = { ...payload, to };
  if (payload.cc !== undefined) next.cc = cc;
  if (payload.bcc !== undefined) next.bcc = bcc;
  return next;
}

// local@label.label...tld, where the last label is 2+ letters or an IDN
// (xn--) label. Looser than RFC 5322 on purpose: it only has to catch what
// Resend refuses, never a deliverable address.
const ADDRESS_SHAPE = /^[^\s@<>"(),;:]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

/** True when `address` (bare or `Name <address>`) has the shape of a real address. */
export function isPlausibleAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  const angled = /<([^<>]*)>\s*$/.exec(trimmed);
  return ADDRESS_SHAPE.test((angled ? angled[1] : trimmed).trim());
}

/**
 * Removes every recipient that cannot be a real address. Returns the payload
 * unchanged when all are fine, the filtered payload otherwise, or null when no
 * `to` recipient is left.
 */
export function dropImplausibleRecipients<T extends Addressed>(payload: T): T | null {
  const dropped: string[] = [];
  const keep = (value: Recipients): string[] =>
    asList(value).filter((address) => {
      const ok = isPlausibleAddress(address);
      if (!ok) dropped.push(maskAddress(String(address)));
      return ok;
    });
  const to = keep(payload.to);
  const cc = keep(payload.cc);
  const bcc = keep(payload.bcc);
  if (dropped.length === 0) return payload;
  console.warn(`[resend] dropped ${dropped.length} recipient(s) that are not valid addresses: ${dropped.join(', ')}`);
  if (to.length === 0) return null;
  const next = { ...payload, to };
  if (payload.cc !== undefined) next.cc = cc;
  if (payload.bcc !== undefined) next.bcc = bcc;
  return next;
}

/**
 * Runs before the failure watcher, so a typo'd address never reaches Resend
 * and never raises the owner alert.
 */
function guardRecipients(resend: Resend): void {
  const sendOne = resend.emails.send.bind(resend.emails);
  resend.emails.send = (async (payload, options) => {
    const checked = dropImplausibleRecipients(payload as Addressed);
    if (!checked) {
      return {
        data: null,
        error: {
          name: INVALID_RECIPIENT_ERROR,
          statusCode: 422,
          // Plain characters only, so callers that keep a short code (safeCode) keep it.
          message: 'invalid_recipient: no valid recipient address',
        },
        headers: null,
      };
    }
    return sendOne(checked as typeof payload, options);
  }) as typeof resend.emails.send;

  if (!resend.batch) return;
  const sendBatch = resend.batch.send.bind(resend.batch);
  resend.batch.send = (async (payloads, options) => {
    const checked = payloads.map((p) => dropImplausibleRecipients(p as Addressed) as typeof p | null);
    const live = checked.filter((p): p is (typeof payloads)[number] => p !== null);
    const invalidId = () => ({ id: `${INVALID_RECIPIENT_ID_PREFIX}-${crypto.randomUUID()}` });
    if (live.length === checked.length) return sendBatch(live, options);
    if (live.length === 0) {
      return { data: { data: payloads.map(invalidId) }, error: null, headers: null };
    }
    const result = await sendBatch(live, options);
    if (result.error || !result.data) return result;
    const sentIds = [...result.data.data];
    const data = checked.map((p) => (p === null ? invalidId() : sentIds.shift() ?? invalidId()));
    return { ...result, data: { ...result.data, data } };
  }) as typeof resend.batch.send;
}

function skippedId(): string {
  return `${SKIPPED_ID_PREFIX}-${crypto.randomUUID()}`;
}

type Reporter = (failure: ResendFailure) => Promise<void>;

function errorFields(error: unknown): { name: string; statusCode: number | null; message: string } {
  const e = (error ?? {}) as { name?: unknown; statusCode?: unknown; message?: unknown };
  return {
    name: typeof e.name === 'string' && e.name ? e.name : 'unknown_error',
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : null,
    message: typeof e.message === 'string' ? e.message : String(error),
  };
}

/**
 * Every error answer or throw from Resend is reported (see
 * ./resend-failure-alert.ts), in every environment. The answer itself is
 * passed back unchanged, so callers keep their own handling. The report is not
 * awaited: a slow alert must never hold up a send.
 */
function watchFailures(resend: Resend, report: Reporter): void {
  const fire = (failure: ResendFailure) => {
    void report(failure).catch(() => {});
  };
  const sendOne = resend.emails.send.bind(resend.emails);
  resend.emails.send = (async (payload, options) => {
    const from = fromDomain((payload as { from?: unknown }).from);
    try {
      const result = await sendOne(payload, options);
      if (result.error) fire({ kind: 'one', from, count: 1, ...errorFields(result.error) });
      return result;
    } catch (err) {
      fire({ kind: 'one', from, count: 1, ...errorFields(err) });
      throw err;
    }
  }) as typeof resend.emails.send;

  if (!resend.batch) return;
  const sendBatch = resend.batch.send.bind(resend.batch);
  resend.batch.send = (async (payloads, options) => {
    const from = fromDomain((payloads[0] as { from?: unknown } | undefined)?.from);
    try {
      const result = await sendBatch(payloads, options);
      if (result.error) fire({ kind: 'batch', from, count: payloads.length, ...errorFields(result.error) });
      return result;
    } catch (err) {
      fire({ kind: 'batch', from, count: payloads.length, ...errorFields(err) });
      throw err;
    }
  }) as typeof resend.batch.send;
}

export function createResend(
  key: string,
  env: Record<string, string | undefined> = process.env,
  report: Reporter = reportResendFailure,
): Resend {
  const resend = new Resend(key);
  watchFailures(resend, report);
  guardRecipients(resend);
  if (isProduction(env)) return resend;

  const allowlist = recipientAllowlist(env);
  const sendOne = resend.emails.send.bind(resend.emails);

  resend.emails.send = (async (payload, options) => {
    const filtered = filterRecipients(payload as Addressed, allowlist);
    if (!filtered) {
      console.warn('[resend] non-production: no allowlisted recipient left; send skipped');
      return { data: { id: skippedId() }, error: null, headers: null };
    }
    return sendOne(filtered as typeof payload, options);
  }) as typeof resend.emails.send;

  // Test doubles of the client may have no batch API.
  if (!resend.batch) return resend;
  const sendBatch = resend.batch.send.bind(resend.batch);
  resend.batch.send = (async (payloads, options) => {
    const filtered = payloads.map((p) => filterRecipients(p as Addressed, allowlist) as typeof p | null);
    const live = filtered.filter((p): p is (typeof payloads)[number] => p !== null);
    if (live.length < payloads.length) {
      console.warn(`[resend] non-production: ${payloads.length - live.length} of ${payloads.length} batch email(s) skipped`);
    }
    if (live.length === 0) {
      return { data: { data: payloads.map(() => ({ id: skippedId() })) }, error: null, headers: null };
    }
    const result = await sendBatch(live, options);
    if (result.error || !result.data) return result;
    const sentIds = [...result.data.data];
    const data = filtered.map((p) => (p === null ? { id: skippedId() } : sentIds.shift() ?? { id: skippedId() }));
    return { ...result, data: { ...result.data, data } };
  }) as typeof resend.batch.send;

  return resend;
}

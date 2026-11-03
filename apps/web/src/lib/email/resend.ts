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
 */
import { Resend } from 'resend';

import { isAllowlistedAddress, isProduction, recipientAllowlist } from '@/lib/env/app-env';

import { fromDomain, reportResendFailure, type ResendFailure } from '@/lib/email/resend-failure-alert';

export const SKIPPED_ID_PREFIX = 'skipped-not-allowlisted';

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

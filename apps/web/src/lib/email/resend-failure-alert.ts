/**
 * Makes a refused Resend send loud.
 *
 * Most senders in apps/web are written to never throw: a receipt or a
 * lifecycle email that fails is logged and swallowed so the request that
 * triggered it still succeeds. That is how mcpemails.com sat unverified in
 * Resend for weeks (every send 403'd) and how RESEND_FROM_EMAIL pointed at a
 * removed domain from 2026-10-25 to 2026-10-29 without anyone noticing.
 *
 * createResend (./resend.ts) calls reportResendFailure for every error answer
 * or throw from emails.send / batch.send. Each one becomes an app_errors row,
 * and the first of each kind per hour per instance also goes to the owner's
 * inbox as an `email.send_failed` system event. That alert is delivered by
 * system-notify through an MCPEmails inbox, not through Resend, so it still
 * arrives when Resend itself is the thing failing.
 *
 * The payload carries the From domain, the Resend error name, status and a
 * message with every address masked: never a recipient (system_events
 * contract).
 */
import { captureError } from '@/lib/errors/capture';
import { createServiceRoleClient } from '@/lib/supabase/service';

export type ResendFailure = {
  kind: 'one' | 'batch';
  from: string | null;
  name: string;
  statusCode: number | null;
  message: string;
  count: number;
};

/** A rate limit is retried by the callers that hit it; only a real refusal alerts. */
const TRANSIENT = new Set(['rate_limit_exceeded']);
const ALERT_EVERY_MS = 60 * 60 * 1000;
const lastAlert = new Map<string, number>();

const ADDRESS = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g;

/** Keeps the domain of every address so the message still says which sender failed. */
export function maskAddresses(text: string): string {
  return text.replace(ADDRESS, (address) => `*@${address.slice(address.lastIndexOf('@') + 1)}`);
}

/** The domain of a From header such as `Name <a@b.com>`, or null. */
export function fromDomain(from: unknown): string | null {
  if (typeof from !== 'string') return null;
  const match = /@([^\s<>"]+?)>?\s*$/.exec(from.trim());
  return match ? match[1].toLowerCase() : null;
}

export function shouldAlert(failure: ResendFailure, now: number, seen: Map<string, number> = lastAlert): boolean {
  if (TRANSIENT.has(failure.name)) return false;
  const key = `${failure.from ?? '-'}|${failure.name}|${failure.statusCode ?? '-'}`;
  const last = seen.get(key);
  if (last !== undefined && now - last < ALERT_EVERY_MS) return false;
  seen.set(key, now);
  return true;
}

export async function reportResendFailure(failure: ResendFailure): Promise<void> {
  const message = maskAddresses(failure.message).slice(0, 500);
  console.error('[resend] send refused', { ...failure, message });
  if (TRANSIENT.has(failure.name)) return;
  try {
    await captureError(new Error(`Resend refused a send: ${failure.name}: ${message}`), {
      severity: 'high',
      source: 'resend',
      from_domain: failure.from,
      error_name: failure.name,
      status_code: failure.statusCode,
      kind: failure.kind,
      count: failure.count,
    });
    if (!shouldAlert(failure, Date.now())) return;
    const db = createServiceRoleClient();
    const { error } = await db.rpc('emit_system_event', {
      p_event_type: 'email.send_failed',
      p_payload: {
        from_domain: failure.from,
        error_name: failure.name,
        status_code: failure.statusCode,
        message,
        kind: failure.kind,
        count: failure.count,
        app_env: process.env.APP_ENV ?? 'production',
      },
    });
    if (error) console.error('[resend] failure alert not emitted', { error: error.message });
  } catch (err) {
    console.error('[resend] failure alert crashed', err instanceof Error ? err.message : err);
  }
}

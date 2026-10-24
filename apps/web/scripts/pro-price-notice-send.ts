/**
 * The Pro price notice email: one send, run by hand on the announcement day.
 *
 * DRY RUN BY DEFAULT. Without `--send` it reads, decides and prints counts per
 * reason. It never prints an address, a domain or a raw id.
 *
 * NORMALLY NOT NEEDED: pg_cron sends the notice through
 * /api/internal/pro-price-notice/dispatch on the announcement day. This is
 * the manual fallback and the dry run.
 *
 * `--send` additionally requires:
 *   - the announcement day with the notice on (noticeSendAllowed), so the
 *     email can never outrun the page or become a reminder;
 *   - RESEND_API_KEY in the environment.
 * Each recipient is claimed in `lifecycle_email_sends` BEFORE the send (ON
 * CONFLICT DO NOTHING), so a re-run, or two runs at once, never mails anyone
 * twice. One attempt per person, never a retry.
 *
 * Usage, from apps/web:
 *   node --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     scripts/pro-price-notice-send.ts [--send] [--limit N]
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * GROWTH_INTERNAL_EMAILS from the environment, falling back to
 * apps/web/.env.local (which points at production), so running it is a
 * deliberate act.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of (() => {
  try {
    return readFileSync(resolve(webRoot, '.env.local'), 'utf8').split('\n');
  } catch {
    return [];
  }
})()) {
  const m = /^\s*(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|GROWTH_INTERNAL_EMAILS|NEXT_PUBLIC_APP_URL)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const SEND = process.argv.includes('--send');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 0) : Infinity;

const { createServiceRoleClient } = await import('@/lib/supabase/service');
const { lifecycleFrom } = await import('@/lib/email/lifecycle');
const { noticeSendAllowed } = await import('@/lib/email/pro-price-notice');
const { runProPriceNotice } = await import('@/lib/email/pro-price-notice-run');

if (SEND && !noticeSendAllowed()) {
  console.error('Refusing to send: it is not the announcement day, or the notice is off.');
  process.exit(2);
}
if (SEND && !process.env.RESEND_API_KEY) {
  console.error('Refusing to send: RESEND_API_KEY is not set.');
  process.exit(2);
}
if (!SEND) delete process.env.RESEND_API_KEY;

const sender = SEND
  ? (async () => {
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY!);
      return async (email: { to: string; subject: string; html: string; text: string; headers: Record<string, string>; idempotencyKey: string }) => {
        try {
          const { data, error } = await resend.emails.send(
            { from: lifecycleFrom(), to: email.to, subject: email.subject, html: email.html, text: email.text, headers: email.headers },
            { idempotencyKey: email.idempotencyKey },
          );
          return error ? { ok: false as const, reason: String(error.message) } : { ok: true as const, id: data?.id ?? null };
        } catch (err) {
          return { ok: false as const, reason: err instanceof Error ? err.message : 'unexpected_error' };
        }
      };
    })()
  : null;

const report = await runProPriceNotice({
  db: createServiceRoleClient(),
  sender: sender ? await sender : null,
  dryRun: !SEND,
  maxSends: LIMIT,
  pauseMs: 600,
});
const target = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://missing').host.split('.')[0];
console.log(`Pro price notice: project ${target}, ${SEND ? 'SENDING' : 'dry run, nothing written'}`);
console.log(JSON.stringify(report, null, 2));

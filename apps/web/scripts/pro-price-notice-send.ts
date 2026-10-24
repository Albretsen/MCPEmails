/**
 * The Pro price notice email: one send, run by hand on the announcement day.
 *
 * DRY RUN BY DEFAULT. Without `--send` it reads, decides and prints counts per
 * reason. It never prints an address, a domain or a raw id.
 *
 * `--send` additionally requires:
 *   - the notice to be visible (PRO_PRICE_CHANGE.announce on, price not live,
 *     switch instant not passed), so the email can never outrun the page;
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
const { matchesInternal } = await import('@/lib/email/paywall-followup-store');
const { lifecycleFrom } = await import('@/lib/email/lifecycle');
const {
  PRO_PRICE_NOTICE_TEMPLATE,
  composeProPriceNotice,
  decideNotice,
  noticeSendAllowed,
  proPriceNoticeTriggerKey,
} = await import('@/lib/email/pro-price-notice');

type NoticeCandidate = import('@/lib/email/pro-price-notice').NoticeCandidate;

if (SEND && !noticeSendAllowed()) {
  console.error('Refusing to send: the Pro price notice is not visible (announce off, price live, or switch passed).');
  process.exit(2);
}
if (SEND && !process.env.RESEND_API_KEY) {
  console.error('Refusing to send: RESEND_API_KEY is not set.');
  process.exit(2);
}
if (!SEND) delete process.env.RESEND_API_KEY;

const db = createServiceRoleClient();
const triggerKey = proPriceNoticeTriggerKey();
const PAGE = 1000;
const CHUNK = 100;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Consenting users, paged on a total order (PostgREST stops at 1000 rows).
const users: Array<{
  id: string;
  email: string | null;
  marketing_consent_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_categories: string[] | null;
  unsubscribe_token: string | null;
}> = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await db
    .from('users')
    .select('id, email, marketing_consent_at, unsubscribed_at, unsubscribed_categories, unsubscribe_token')
    .not('marketing_consent_at', 'is', null)
    .order('id')
    .range(from, from + PAGE - 1);
  if (error) throw new Error(`users read failed: ${error.message}`);
  users.push(...(data ?? []));
  if ((data ?? []).length < PAGE) break;
}

const { data: internalRows, error: internalError } = await db.from('internal_accounts').select('email');
if (internalError) throw new Error(`internal account read failed: ${internalError.message}`);
const listed = new Set((internalRows ?? []).map((r) => r.email.toLowerCase()));

const ownedPlans = new Map<string, string[]>();
const lastActive = new Map<string, number>();
const status = new Map<string, string | null>();
const claimed = new Set<string>();
const bump = (userId: string, at: string | null) => {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isFinite(t) && t > (lastActive.get(userId) ?? 0)) lastActive.set(userId, t);
};

for (const ids of chunks(users.map((u) => u.id))) {
  const { data: ws, error: wsError } = await db
    .from('workspaces')
    .select('id, owner_id, plan, created_at')
    .in('owner_id', ids)
    .is('deleted_at', null);
  if (wsError) throw new Error(`workspaces read failed: ${wsError.message}`);
  const ownerOf = new Map<string, string>();
  for (const w of ws ?? []) {
    ownerOf.set(w.id, w.owner_id);
    ownedPlans.set(w.owner_id, [...(ownedPlans.get(w.owner_id) ?? []), w.plan]);
    bump(w.owner_id, w.created_at);
  }

  for (const wsIds of chunks([...ownerOf.keys()])) {
    const { data: keys, error: keyError } = await db
      .from('api_keys')
      .select('workspace_id, last_used_at')
      .in('workspace_id', wsIds)
      .not('last_used_at', 'is', null);
    if (keyError) throw new Error(`api_keys read failed: ${keyError.message}`);
    for (const k of keys ?? []) {
      const owner = ownerOf.get(k.workspace_id);
      if (owner) bump(owner, k.last_used_at);
    }
  }

  const { data: billing, error: billingError } = await db
    .from('user_billing')
    .select('user_id, subscription_status')
    .in('user_id', ids);
  if (billingError) throw new Error(`user_billing read failed: ${billingError.message}`);
  for (const b of billing ?? []) status.set(b.user_id, b.subscription_status);

  const { data: ledger, error: ledgerError } = await db
    .from('lifecycle_email_sends')
    .select('user_id')
    .eq('template', PRO_PRICE_NOTICE_TEMPLATE)
    .eq('trigger_key', triggerKey)
    .in('user_id', ids);
  if (ledgerError) throw new Error(`ledger read failed: ${ledgerError.message}`);
  for (const r of ledger ?? []) claimed.add(r.user_id);
}

const now = new Date();
const counts = new Map<string, number>();
const recipients: NoticeCandidate[] = [];
for (const u of users) {
  const candidate: NoticeCandidate = {
    userId: u.id,
    email: u.email,
    marketingConsentAt: u.marketing_consent_at,
    unsubscribedAt: u.unsubscribed_at,
    unsubscribedCategories: u.unsubscribed_categories,
    unsubscribeToken: u.unsubscribe_token,
    internal: matchesInternal(u.email, listed),
    ownedPlans: ownedPlans.get(u.id) ?? [],
    subscriptionStatus: status.get(u.id) ?? null,
    lastActiveAt: lastActive.has(u.id) ? new Date(lastActive.get(u.id)!).toISOString() : null,
    alreadyClaimed: claimed.has(u.id),
  };
  const decision = decideNotice(candidate, now);
  const key = decision.send ? 'send' : decision.reason;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (decision.send) recipients.push(candidate);
}

const target = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://missing').host.split('.')[0];
console.log(`Pro price notice: project ${target}, ${SEND ? 'SENDING' : 'dry run, nothing written'}`);
console.log(`consenting users read: ${users.length}`);
for (const [key, n] of [...counts.entries()].sort()) console.log(`  ${key}: ${n}`);

if (!SEND) process.exit(0);

const { Resend } = await import('resend');
const resend = new Resend(process.env.RESEND_API_KEY!);
let sent = 0;
let failed = 0;
for (const r of recipients.slice(0, LIMIT)) {
  const mail = composeProPriceNotice(r.unsubscribeToken);
  if (!mail || !r.email) continue;
  const { data: claim, error: claimError } = await db
    .from('lifecycle_email_sends')
    .upsert(
      { user_id: r.userId, template: PRO_PRICE_NOTICE_TEMPLATE, trigger_key: triggerKey, email: r.email, status: 'claimed' },
      { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
    )
    .select('user_id');
  if (claimError || (claim ?? []).length !== 1) continue;

  let outcome: { status: 'sent'; provider_message_id: string | null; detail: null } | { status: 'failed'; provider_message_id: null; detail: string };
  try {
    const { data, error } = await resend.emails.send(
      { from: lifecycleFrom(), to: r.email, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers },
      { idempotencyKey: `${PRO_PRICE_NOTICE_TEMPLATE}-${triggerKey}-${r.userId}` },
    );
    outcome = error
      ? { status: 'failed', provider_message_id: null, detail: String(error.message).slice(0, 500) }
      : { status: 'sent', provider_message_id: data?.id ?? null, detail: null };
  } catch (err) {
    outcome = { status: 'failed', provider_message_id: null, detail: (err instanceof Error ? err.message : 'unexpected_error').slice(0, 500) };
  }
  if (outcome.status === 'sent') sent += 1;
  else failed += 1;
  await db
    .from('lifecycle_email_sends')
    .update({ ...outcome, finished_at: new Date().toISOString() })
    .eq('user_id', r.userId)
    .eq('template', PRO_PRICE_NOTICE_TEMPLATE)
    .eq('trigger_key', triggerKey)
    .eq('status', 'claimed');
  // Stay well under Resend's default rate limit.
  await new Promise((done) => setTimeout(done, 600));
}
console.log(`sent: ${sent}, failed: ${failed}`);

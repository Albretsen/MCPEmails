/**
 * Paywall follow-up: a READ-ONLY dry run against whichever database the
 * environment points at, printing only aggregate and anonymised output.
 *
 * It uses the exact store and decision code the dispatcher uses
 * (src/lib/email/paywall-followup*.ts), wrapped so that claim() and finish()
 * throw: nothing can be written and no sender exists in this process. Every
 * read is sequential (the store awaits each query before the next).
 *
 * What it prints, for first paywalls in the last N days (default 30):
 *   A. IGNORING consent: who matches the trigger and passes every other rule,
 *      split by the step that would be due now if the sequence had been
 *      running all along ("steady state"), plus what the dispatcher would
 *      actually do right now against the real (empty) ledger.
 *   B. The same WITH consent enforced. If users.marketing_consent_at does not
 *      exist yet, it says so and B is necessarily zero.
 *   Up to 3 examples: sha256(workspace id) truncated, paywall age, inbox
 *   count, wall hit, step due. Never an address, a domain or a raw id.
 *
 * Usage, from apps/web:
 *   node --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     scripts/paywall-followup-dry-run.ts [--days 30]
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 * environment, falling back to apps/web/.env.local, so pointing it at
 * production is a deliberate act. RESEND_API_KEY is removed from the process
 * environment before anything else runs.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.RESEND_API_KEY;

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of (() => {
  try {
    return readFileSync(resolve(webRoot, '.env.local'), 'utf8').split('\n');
  } catch {
    return [];
  }
})()) {
  const m = /^\s*(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|GROWTH_INTERNAL_EMAILS)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const daysArg = process.argv.indexOf('--days');
const days = daysArg > 0 ? Math.max(1, Number(process.argv[daysArg + 1]) || 30) : 30;

const { createServiceRoleClient } = await import('@/lib/supabase/service');
const { SupabasePaywallFollowupStore } = await import('@/lib/email/paywall-followup-store');
const { anonymise, decide, templateFor } = await import('@/lib/email/paywall-followup');

type Ctx = import('@/lib/email/paywall-followup').CandidateContext;
type Decision = import('@/lib/email/paywall-followup').Decision;
type LedgerRow = import('@/lib/email/paywall-followup').LedgerRow;

const target = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://missing').host.split('.')[0];
console.log(`paywall follow-up dry run: project ${target}, first paywalls in the last ${days} days, READ ONLY\n`);

const store = new SupabasePaywallFollowupStore(createServiceRoleClient());
const readOnly = {
  listFirstPaywalls: store.listFirstPaywalls.bind(store),
  loadContexts: store.loadContexts.bind(store),
  claim: async () => {
    throw new Error('read-only dry run: claim is disabled');
  },
  finish: async () => {
    throw new Error('read-only dry run: finish is disabled');
  },
};

const now = new Date();
const firsts = await readOnly.listFirstPaywalls(new Date(now.getTime() - days * 86_400_000));
const contexts = await readOnly.loadContexts(firsts);

/**
 * Steady state: pretend every earlier step went out on time, then ask what is
 * due now. A step whose window has passed is treated as sent and the walk
 * moves on; the first send / wait / eligibility stop is the answer.
 */
function steadyState(ctx: Ctx, ignoreConsent: boolean): Decision {
  const ledger: LedgerRow[] = [];
  for (let guard = 0; guard < 4; guard += 1) {
    const d = decide({ ...ctx, ledger }, now, { ignoreConsent });
    if (d.kind === 'stop' && d.reason === 'window_missed') {
      // Treated as sent long ago, so the next step's minimum gap does not hold it.
      const long = new Date(0).toISOString();
      ledger.push({ template: templateFor(d.step), triggerKey: ctx.workspaceId, status: 'sent', detail: null, sentAt: long, finishedAt: long });
      continue;
    }
    return d;
  }
  return { kind: 'done', reason: 'completed' };
}

function label(d: Decision): string {
  if (d.kind === 'send') return `step ${d.step} due now`;
  if (d.kind === 'wait') return `waiting for step ${d.step}`;
  if (d.kind === 'done') return d.reason === 'completed' ? 'sequence finished (past step 3)' : `ended (${d.reason})`;
  return `not eligible: ${d.reason}`;
}

function tally(ignoreConsent: boolean) {
  const steady = new Map<string, number>();
  const actual = new Map<string, number>();
  for (const ctx of contexts) {
    const s = label(steadyState(ctx, ignoreConsent));
    steady.set(s, (steady.get(s) ?? 0) + 1);
    const a = label(decide(ctx, now, { ignoreConsent }));
    actual.set(a, (actual.get(a) ?? 0) + 1);
  }
  return { steady, actual };
}

function print(title: string, m: Map<string, number>) {
  console.log(`  ${title}`);
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
}

console.log(`workspaces whose FIRST EVER paywall is in the window: ${contexts.length}`);
const kinds = contexts.reduce<Record<string, number>>((acc, c) => ((acc[c.paywallKind] = (acc[c.paywallKind] ?? 0) + 1), acc), {});
console.log(`  by wall: ${JSON.stringify(kinds)}\n`);

const a = tally(true);
console.log('A. IGNORING consent');
print('steady state (as if the sequence had always been running):', a.steady);
print('actual dispatcher right now (empty ledger, step 1 window 24h):', a.actual);

console.log('\nB. WITH consent');
if (store.consentColumnMissing) {
  console.log('  users.marketing_consent_at does NOT exist in this database yet: every owner reads as no consent.');
}
const b = tally(false);
print('steady state:', b.steady);
print('actual dispatcher right now:', b.actual);

console.log('\nexamples (ignoring consent, eligible, one per step where possible):');
let shown = 0;
const seen = new Set<string>();
for (const ctx of contexts) {
  if (shown >= 3) break;
  const d = steadyState(ctx, true);
  if (d.kind !== 'send' || seen.has(label(d))) continue;
  seen.add(label(d));
  const ageDays = (now.getTime() - new Date(ctx.firstPaywallAt).getTime()) / 86_400_000;
  console.log(
    `  workspace ${anonymise(ctx.workspaceId).slice(0, 8)}…, paywall ${ageDays < 1 ? `${Math.round(ageDays * 24)}h` : `${ageDays.toFixed(1)}d`} ago (${ctx.paywallKind}), ${ctx.inboxCount} inbox${ctx.inboxCount === 1 ? '' : 'es'}, ${label(d)}`,
  );
  shown += 1;
}
if (shown === 0) console.log('  none');

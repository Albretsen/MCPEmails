/**
 * The Pro price notice run: read the audience, decide, and (unless dry) claim
 * and send. Shared by the scheduled route
 * (app/api/internal/pro-price-notice/dispatch) and the manual script
 * (scripts/pro-price-notice-send.ts), so both apply exactly the same rules.
 *
 * Rules are in pro-price-notice.ts (decideNotice, noticeSendAllowed). Here:
 *   - reads page on a total order (PostgREST stops at 1000 rows silently);
 *   - a recipient is CLAIMED in lifecycle_email_sends before the send, with
 *     ON CONFLICT DO NOTHING, so overlapping or repeated runs never mail
 *     anyone twice; one attempt each, never a retry;
 *   - output is counts only: no address, no id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { matchesInternal } from '@/lib/email/paywall-followup-store';
import {
  PRO_PRICE_NOTICE_TEMPLATE,
  composeProPriceNotice,
  decideNotice,
  noticeSendAllowed,
  proPriceNoticeTriggerKey,
  type ComposedNotice,
  type NoticeCandidate,
} from '@/lib/email/pro-price-notice';

type Db = SupabaseClient<Database>;

export type NoticeSender = (email: ComposedNotice & { to: string; idempotencyKey: string }) => Promise<
  { ok: true; id: string | null } | { ok: false; reason: string }
>;

export interface NoticeRunReport {
  mode: 'dry_run' | 'send' | 'outside_window';
  read: number;
  decisions: Record<string, number>;
  sent: number;
  failed: number;
  skippedClaim: number;
}

const PAGE = 1000;
const CHUNK = 100;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every consenting user, with what decideNotice needs. */
export async function loadNoticeCandidates(db: Db): Promise<NoticeCandidate[]> {
  const triggerKey = proPriceNoticeTriggerKey();
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

  return users.map((u) => ({
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
  }));
}

/**
 * One run. `dryRun` reads and decides only. A sending run outside the
 * announcement day reads nothing and reports `outside_window`.
 */
export async function runProPriceNotice(opts: {
  db: Db;
  sender: NoticeSender | null;
  dryRun: boolean;
  now?: Date;
  maxSends?: number;
  pauseMs?: number;
}): Promise<NoticeRunReport> {
  const now = opts.now ?? new Date();
  const report: NoticeRunReport = {
    mode: opts.dryRun ? 'dry_run' : 'send',
    read: 0,
    decisions: {},
    sent: 0,
    failed: 0,
    skippedClaim: 0,
  };
  if (!opts.dryRun && (!noticeSendAllowed(now.getTime()) || !opts.sender)) {
    report.mode = 'outside_window';
    return report;
  }

  const candidates = await loadNoticeCandidates(opts.db);
  report.read = candidates.length;
  const recipients: NoticeCandidate[] = [];
  for (const c of candidates) {
    const d = decideNotice(c, now);
    const key = d.send ? 'send' : d.reason;
    report.decisions[key] = (report.decisions[key] ?? 0) + 1;
    if (d.send) recipients.push(c);
  }
  if (opts.dryRun || !opts.sender) return report;

  const triggerKey = proPriceNoticeTriggerKey();
  for (const r of recipients.slice(0, opts.maxSends ?? Infinity)) {
    const mail = composeProPriceNotice(r.unsubscribeToken);
    if (!mail || !r.email) continue;
    const { data: claim, error: claimError } = await opts.db
      .from('lifecycle_email_sends')
      .upsert(
        { user_id: r.userId, template: PRO_PRICE_NOTICE_TEMPLATE, trigger_key: triggerKey, email: r.email, status: 'claimed' },
        { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
      )
      .select('user_id');
    if (claimError || (claim ?? []).length !== 1) {
      report.skippedClaim += 1;
      continue;
    }

    const result = await opts.sender({
      ...mail,
      to: r.email,
      idempotencyKey: `${PRO_PRICE_NOTICE_TEMPLATE}-${triggerKey}-${r.userId}`,
    });
    if (result.ok) report.sent += 1;
    else report.failed += 1;
    await opts.db
      .from('lifecycle_email_sends')
      .update({
        status: result.ok ? 'sent' : 'failed',
        provider_message_id: result.ok ? result.id : null,
        detail: result.ok ? null : result.reason.slice(0, 500),
        finished_at: new Date().toISOString(),
      })
      .eq('user_id', r.userId)
      .eq('template', PRO_PRICE_NOTICE_TEMPLATE)
      .eq('trigger_key', triggerKey)
      .eq('status', 'claimed');
    if (opts.pauseMs) await new Promise((done) => setTimeout(done, opts.pauseMs));
  }
  return report;
}

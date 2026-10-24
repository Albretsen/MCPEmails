/**
 * The Supabase side of the first-30-days retention loop. Thin on purpose:
 * every decision lives in first-30-days.ts, which is tested against an
 * in-memory store. This file reads rows and performs the inserts that are the
 * claim and the holdout assignment.
 *
 * READS ARE SEQUENTIAL and ids are batched with `.in()`, same as the paywall
 * follow-up store.
 *
 * THE 1000-ROW CAP. PostgREST cuts any select off at 1000 rows without an
 * error. Every count here is therefore a `head: true, count: 'exact'` query
 * (Postgres counts, no rows come back), never a length of a returned array.
 * The two places that do read rows say what a truncated read means:
 * active days (a floor; it only matters below 100 calls, where it is exact)
 * and the error-code sample (the latest 500 failures, plenty for a top 3).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { matchesInternal } from '@/lib/email/paywall-followup-store';
import {
  DAY,
  HOLDOUT_EXPERIMENT_KEY,
  RETENTION_TEMPLATES,
  VARIANT_HOLDOUT,
  WEEK1_LENGTH_MS,
  ms,
  pickFirstPayments,
  subjectIdFor,
  type CandidateContext,
  type ClaimRow,
  type FinishOutcome,
  type First30Store,
  type FirstPayment,
  type LedgerRow,
  type RetentionTemplate,
  type StuckDetails,
  type Week1Stats,
} from '@/lib/retention/first-30-days';

type Db = SupabaseClient<Database>;
type LedgerUpdate = Database['public']['Tables']['lifecycle_email_sends']['Update'];

const CHUNK = 100;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** activity_log tool names per summary line (plan, M3 Data). */
export const WEEK1_TOOL_GROUPS = {
  search: ['email_search', 'email_list'],
  opened: ['email_read', 'email_read_batch'],
  drafts: ['draft_create', 'draft_reply'],
  sent: ['email_send', 'draft_send', 'email_reply'],
  scheduled: ['schedule_create'],
} as const;

/** Count error codes into a most-frequent-first top list. Pure; exported for tests. */
export function topCodes(codes: Array<string | null>, limit = 3): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of codes) {
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, limit);
}

/** Distinct 24-hour days after `startMs` that hold at least one timestamp. Pure; exported for tests. */
export function activeDayCount(timestamps: string[], startMs: number): number {
  const days = new Set<number>();
  for (const t of timestamps) {
    const offset = Math.floor((ms(t) - startMs) / DAY);
    if (offset >= 0 && offset < 7) days.add(offset);
  }
  return days.size;
}

/** PostgREST's silent row cap, and the page size every paged read below uses. */
export const PAGE_SIZE = 1000;
/** A paged read that needs more pages than this throws rather than truncating. */
export const MAX_PAGES = 100;

/**
 * Read every row of a query, one PostgREST page at a time. `fetchPage` must
 * apply a TOTAL order (a unique tiebreaker last) and `.range(from, to)`; a
 * short page ends the read. Too many pages throws: a silently truncated read
 * is the bug this exists to prevent. Pure apart from the callback; exported
 * for tests.
 */
export async function readAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(`${what} failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error(`${what} has more than ${maxPages * pageSize} rows; refusing a truncated read`);
}

export class SupabaseFirst30Store implements First30Store {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async listFirstPayments(since: Date): Promise<FirstPayment[]> {
    const rows = await readAllPages(
      (from, to) =>
        this.db
          .from('product_funnel_events')
          .select('workspace_id, occurred_at')
          .eq('stage', 'checkout_completed')
          .gte('occurred_at', since.toISOString())
          .order('occurred_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      'checkout read',
    );

    // Which of these also paid BEFORE the window? Every earlier row is read
    // (paged), so a payer from before go-live can never look new because a
    // page was cut short.
    const ids = [...new Set(rows.map((r) => r.workspace_id))];
    const earlier = new Set<string>();
    for (const batch of chunks(ids)) {
      const data = await readAllPages(
        (from, to) =>
          this.db
            .from('product_funnel_events')
            .select('workspace_id')
            .eq('stage', 'checkout_completed')
            .lt('occurred_at', since.toISOString())
            .in('workspace_id', batch)
            .order('id', { ascending: true })
            .range(from, to),
        'earlier checkout read',
      );
      for (const row of data) earlier.add(row.workspace_id);
    }
    return pickFirstPayments(rows, earlier);
  }

  async loadContexts(firsts: FirstPayment[]): Promise<CandidateContext[]> {
    if (firsts.length === 0) return [];
    const workspaceIds = firsts.map((f) => f.workspaceId);

    const workspaces = new Map<string, { owner_id: string; deleted_at: string | null }>();
    for (const ids of chunks(workspaceIds)) {
      const { data, error } = await this.db.from('workspaces').select('id, owner_id, deleted_at').in('id', ids);
      if (error) throw new Error(`workspace read failed: ${error.message}`);
      for (const w of data ?? []) workspaces.set(w.id, w);
    }

    const ownerIds = [...new Set([...workspaces.values()].map((w) => w.owner_id))];

    const owners = new Map<
      string,
      {
        id: string;
        email: string | null;
        display_name: string | null;
        unsubscribed_at: string | null;
        unsubscribed_categories: string[] | null;
        unsubscribe_token: string | null;
      }
    >();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db
        .from('users')
        .select('id, email, display_name, unsubscribed_at, unsubscribed_categories, unsubscribe_token')
        .in('id', ids);
      if (error) throw new Error(`owner read failed: ${error.message}`);
      for (const o of data ?? []) owners.set(o.id, o);
    }

    const billing = new Map<string, string | null>();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db.from('user_billing').select('user_id, subscription_status').in('user_id', ids);
      if (error) throw new Error(`billing read failed: ${error.message}`);
      for (const b of data ?? []) billing.set(b.user_id, b.subscription_status);
    }

    const { data: internalRows, error: internalError } = await this.db.from('internal_accounts').select('email');
    if (internalError) throw new Error(`internal account read failed: ${internalError.message}`);
    const listed = new Set((internalRows ?? []).map((r) => r.email.toLowerCase()));

    const ledger = new Map<string, LedgerRow[]>();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db
        .from('lifecycle_email_sends')
        .select('user_id, template, trigger_key, status, detail, sent_at, finished_at')
        .in('user_id', ids)
        .in('template', [...RETENTION_TEMPLATES]);
      if (error) throw new Error(`ledger read failed: ${error.message}`);
      for (const r of data ?? []) {
        const list = ledger.get(r.user_id) ?? [];
        list.push({
          template: r.template,
          triggerKey: r.trigger_key,
          status: r.status,
          detail: r.detail,
          sentAt: r.sent_at,
          finishedAt: r.finished_at,
        });
        ledger.set(r.user_id, list);
      }
    }

    const out: CandidateContext[] = [];
    for (const f of firsts) {
      const w = workspaces.get(f.workspaceId) ?? null;
      const o = w ? owners.get(w.owner_id) ?? null : null;
      const { count, error } = await this.db
        .from('activity_log')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', f.workspaceId)
        .eq('status', 'success')
        .gte('created_at', f.firstPaidAt);
      if (error) throw new Error(`activity count failed: ${error.message}`);
      out.push({
        ...f,
        workspace: w ? { ownerId: w.owner_id, deletedAt: w.deleted_at } : null,
        owner: o
          ? {
              id: o.id,
              email: o.email,
              displayName: o.display_name,
              unsubscribedAt: o.unsubscribed_at,
              unsubscribedCategories: o.unsubscribed_categories ?? [],
              unsubscribeToken: o.unsubscribe_token,
            }
          : null,
        subscriptionStatus: w ? billing.get(w.owner_id) ?? null : null,
        internal: matchesInternal(o?.email ?? null, listed),
        successSincePaid: count ?? 0,
        ledger: w ? (ledger.get(w.owner_id) ?? []).filter((r) => r.triggerKey === f.workspaceId) : [],
      });
    }
    return out;
  }

  async loadStuckDetails(ctx: CandidateContext): Promise<StuckDetails> {
    const { count: total, error: totalError } = await this.db
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId)
      .gte('created_at', ctx.firstPaidAt);
    if (totalError) throw new Error(`activity total failed: ${totalError.message}`);

    const { data: failures, error: failError } = await this.db
      .from('activity_log')
      .select('error_code')
      .eq('workspace_id', ctx.workspaceId)
      .neq('status', 'success')
      .gte('created_at', ctx.firstPaidAt)
      .order('created_at', { ascending: false })
      .limit(500);
    if (failError) throw new Error(`activity errors failed: ${failError.message}`);

    const { data: clients, error: clientError } = await this.db
      .from('mcp_client_capabilities')
      .select('client_name')
      .eq('workspace_id', ctx.workspaceId)
      .order('last_seen', { ascending: false })
      .limit(20);
    if (clientError) throw new Error(`client read failed: ${clientError.message}`);

    const { data: inboxes, error: inboxError } = await this.db
      .from('inboxes')
      .select('provider')
      .eq('workspace_id', ctx.workspaceId)
      .is('deleted_at', null)
      .limit(100);
    if (inboxError) throw new Error(`inbox read failed: ${inboxError.message}`);

    return {
      totalCalls: total ?? 0,
      topErrorCodes: topCodes((failures ?? []).map((r) => r.error_code)),
      clientNames: [...new Set((clients ?? []).map((c) => c.client_name).filter(Boolean))],
      inboxProviders: (inboxes ?? []).map((i) => i.provider),
    };
  }

  private async countSuccess(ctx: CandidateContext, endIso: string, tools?: readonly string[]): Promise<number> {
    let query = this.db
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId)
      .eq('status', 'success')
      .gte('created_at', ctx.firstPaidAt)
      .lt('created_at', endIso);
    // Automation runs log triage_* rows; week-1 use means the assistant, not the runner.
    query = tools ? query.in('tool_name', [...tools]) : query.not('tool_name', 'like', 'triage_%');
    const { count, error } = await query;
    if (error) throw new Error(`activity count failed: ${error.message}`);
    return count ?? 0;
  }

  async loadWeek1Stats(ctx: CandidateContext): Promise<Week1Stats> {
    const startMs = ms(ctx.firstPaidAt);
    const endIso = new Date(startMs + WEEK1_LENGTH_MS).toISOString();

    const counts = {
      search: await this.countSuccess(ctx, endIso, WEEK1_TOOL_GROUPS.search),
      opened: await this.countSuccess(ctx, endIso, WEEK1_TOOL_GROUPS.opened),
      drafts: await this.countSuccess(ctx, endIso, WEEK1_TOOL_GROUPS.drafts),
      sent: await this.countSuccess(ctx, endIso, WEEK1_TOOL_GROUPS.sent),
      scheduled: await this.countSuccess(ctx, endIso, WEEK1_TOOL_GROUPS.scheduled),
    };
    const totalSuccess = await this.countSuccess(ctx, endIso);

    const { data: stamps, error: stampError } = await this.db
      .from('activity_log')
      .select('created_at')
      .eq('workspace_id', ctx.workspaceId)
      .eq('status', 'success')
      .not('tool_name', 'like', 'triage_%')
      .gte('created_at', ctx.firstPaidAt)
      .lt('created_at', endIso)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (stampError) throw new Error(`activity days failed: ${stampError.message}`);

    const automationsSorted = await this.sumAutomationsSorted(ctx, endIso);

    const { count: rules, error: ruleError } = await this.db
      .from('triage_rules')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ctx.workspaceId)
      .is('deleted_at', null);
    if (ruleError) throw new Error(`triage rule read failed: ${ruleError.message}`);

    const { data: inboxes, error: inboxError } = await this.db
      .from('inboxes')
      .select('email_address')
      .eq('workspace_id', ctx.workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(100);
    if (inboxError) throw new Error(`inbox read failed: ${inboxError.message}`);

    return {
      counts,
      totalSuccess,
      activeDays: activeDayCount((stamps ?? []).map((s) => s.created_at), startMs),
      automationsSorted,
      hasAutomation: (rules ?? 0) > 0,
      inboxAddresses: (inboxes ?? []).map((i) => i.email_address),
    };
  }

  /**
   * sum(triage_runs.succeeded) in [firstPaidAt, endIso). Every run is read,
   * paged in a total order: a busy automation runs far more than 1000 times a
   * week, and this number is printed to the customer.
   */
  async sumAutomationsSorted(ctx: CandidateContext, endIso: string): Promise<number> {
    const runs = await readAllPages(
      (from, to) =>
        this.db
          .from('triage_runs')
          .select('succeeded')
          .eq('workspace_id', ctx.workspaceId)
          .gte('started_at', ctx.firstPaidAt)
          .lt('started_at', endIso)
          .order('started_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      'triage run read',
    );
    return runs.reduce((sum, r) => sum + (r.succeeded ?? 0), 0);
  }

  /**
   * Same precedence as the experiments library (src/lib/experiments/resolve.ts):
   * concluded serves the winner, draft serves variants[0] (the holdout here),
   * running records the assignment once and returns the stored one.
   */
  async assignVariant(workspaceId: string, proposed: string): Promise<string | null> {
    const { data, error } = await this.db
      .from('experiments')
      .select('status, winner_variant_id')
      .eq('key', HOLDOUT_EXPERIMENT_KEY)
      .maybeSingle();
    if (error || !data) {
      console.error('[first-30-days] holdout experiment unreadable:', error?.message ?? 'missing row');
      return null;
    }
    if (data.status === 'concluded') return data.winner_variant_id ?? null;
    if (data.status !== 'running') return VARIANT_HOLDOUT;

    const { data: stored, error: rpcError } = await this.db.rpc('experiment_assign', {
      p_key: HOLDOUT_EXPERIMENT_KEY,
      p_subject_id: subjectIdFor(workspaceId),
      p_variant_id: proposed,
    });
    if (rpcError) {
      console.error('[first-30-days] holdout assignment failed:', rpcError.message);
      return null;
    }
    return typeof stored === 'string' && stored ? stored : null;
  }

  async claim(row: ClaimRow): Promise<boolean> {
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .upsert(
        {
          user_id: row.userId,
          template: row.template,
          trigger_key: row.workspaceId,
          email: row.email,
          status: row.status,
          detail: row.detail,
        },
        { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
      )
      .select('user_id');
    if (error) {
      // Fail closed: an insert we cannot confirm is a claim we did not win.
      console.error('[first-30-days] claim failed:', error.message);
      return false;
    }
    return (data ?? []).length === 1;
  }

  async finish(
    key: { userId: string; workspaceId: string; template: RetentionTemplate },
    outcome: FinishOutcome,
  ): Promise<void> {
    const patch = {
      status: outcome.status,
      provider_message_id: outcome.status === 'sent' ? outcome.providerId : null,
      detail: outcome.detail ? outcome.detail.slice(0, 500) : null,
      finished_at: new Date().toISOString(),
    } as LedgerUpdate;
    const { error } = await this.db
      .from('lifecycle_email_sends')
      .update(patch)
      .eq('user_id', key.userId)
      .eq('template', key.template)
      .eq('trigger_key', key.workspaceId)
      .eq('status', 'claimed');
    if (error) {
      // The row stays 'claimed', which also blocks a second attempt.
      console.error('[first-30-days] could not finish ledger row:', error.message);
    }
  }
}

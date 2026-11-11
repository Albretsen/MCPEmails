/**
 * The Supabase side of the monthly Free reset email. Thin on purpose: every
 * decision is in free-reset-email.ts, tested against an in-memory store.
 *
 * Reads are sequential and batched with `.in()`. usage_limit_events is paged
 * with `.range()` over a total order (occurred_at, id), because PostgREST cuts
 * any select at 1000 rows without an error and a month has several thousand.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { matchesInternal } from '@/lib/email/paywall-followup-store';
import {
  TEMPLATE,
  refusedDaysByWorkspace,
  type Candidate,
  type CandidateContext,
  type ClaimRow,
  type FreeResetStore,
  type LimitEventRow,
} from '@/lib/email/free-reset-email';

type Db = SupabaseClient<Database>;
type LedgerUpdate = Database['public']['Tables']['lifecycle_email_sends']['Update'];

const CHUNK = 100;
const PAGE = 1000;
const MAX_PAGES = 50;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface AllowanceRpcRow {
  plan: string;
  exempt: boolean;
  cap: number | null;
}

export class SupabaseFreeResetStore implements FreeResetStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async listCandidates(start: Date, end: Date): Promise<Candidate[]> {
    const rows: LimitEventRow[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data, error } = await this.db
        .from('usage_limit_events')
        .select('workspace_id, occurred_at')
        .eq('limit_kind', 'actions')
        .gte('occurred_at', start.toISOString())
        .lt('occurred_at', end.toISOString())
        .order('occurred_at', { ascending: true })
        .order('id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error(`limit event read failed: ${error.message}`);
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE) break;
    }
    return [...refusedDaysByWorkspace(rows)].map(([workspaceId, refusedDays]) => ({ workspaceId, refusedDays }));
  }

  async loadContexts(candidates: Candidate[]): Promise<CandidateContext[]> {
    // Only the ones that can qualify are worth reading.
    const wanted = candidates.filter((c) => c.refusedDays >= 2);
    if (wanted.length === 0) return [];
    const workspaceIds = wanted.map((c) => c.workspaceId);

    const workspaces = new Map<string, { owner_id: string; plan: string; deleted_at: string | null }>();
    for (const ids of chunks(workspaceIds)) {
      const { data, error } = await this.db.from('workspaces').select('id, owner_id, plan, deleted_at').in('id', ids);
      if (error) throw new Error(`workspace read failed: ${error.message}`);
      for (const w of data ?? []) workspaces.set(w.id, w);
    }
    const ownerIds = [...new Set([...workspaces.values()].map((w) => w.owner_id))];

    const owners = new Map<
      string,
      {
        id: string;
        email: string | null;
        marketing_consent_at: string | null;
        unsubscribed_at: string | null;
        unsubscribed_categories: string[] | null;
        unsubscribe_token: string | null;
      }
    >();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db
        .from('users')
        .select('id, email, marketing_consent_at, unsubscribed_at, unsubscribed_categories, unsubscribe_token')
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

    const countries = new Map<string, Array<string | null>>();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db.from('workspaces').select('owner_id, acquisition_country').in('owner_id', ids);
      if (error) throw new Error(`country read failed: ${error.message}`);
      for (const w of data ?? []) {
        const list = countries.get(w.owner_id) ?? [];
        list.push(w.acquisition_country);
        countries.set(w.owner_id, list);
      }
    }

    const ledger = new Map<string, Array<{ triggerKey: string; status: string }>>();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db
        .from('lifecycle_email_sends')
        .select('user_id, trigger_key, status')
        .in('user_id', ids)
        .eq('template', TEMPLATE);
      if (error) throw new Error(`ledger read failed: ${error.message}`);
      for (const r of data ?? []) {
        const list = ledger.get(r.user_id) ?? [];
        list.push({ triggerKey: r.trigger_key, status: r.status });
        ledger.set(r.user_id, list);
      }
    }

    const { data: internalRows, error: internalError } = await this.db.from('internal_accounts').select('email');
    if (internalError) throw new Error(`internal account read failed: ${internalError.message}`);
    const listed = new Set((internalRows ?? []).map((r) => r.email.toLowerCase()));

    // One RPC per workspace, sequentially: the allowance function is the only
    // definition of "metered" (cap, exemptions, grace), so it is not re-derived.
    // Bound, or .rpc() loses `this` (see src/lib/usage/allowance.ts).
    const rpc = this.db.rpc.bind(this.db) as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: AllowanceRpcRow[] | AllowanceRpcRow | null; error: { message: string } | null }>;
    const allowances = new Map<string, AllowanceRpcRow | null>();
    for (const id of workspaceIds) {
      if (!workspaces.has(id)) continue;
      const { data, error } = await rpc('workspace_action_allowance', { p_workspace_id: id });
      if (error) {
        console.error('[free-reset] allowance read failed:', error.message);
        allowances.set(id, null);
        continue;
      }
      const row = Array.isArray(data) ? data[0] ?? null : data;
      allowances.set(id, row ? { plan: row.plan, exempt: row.exempt, cap: row.cap } : null);
    }

    return wanted.map((c) => {
      const w = workspaces.get(c.workspaceId) ?? null;
      const o = w ? owners.get(w.owner_id) ?? null : null;
      return {
        ...c,
        workspace: w ? { ownerId: w.owner_id, plan: w.plan, deletedAt: w.deleted_at } : null,
        allowance: allowances.get(c.workspaceId) ?? null,
        owner: o
          ? {
              id: o.id,
              email: o.email,
              marketingConsentAt: o.marketing_consent_at,
              unsubscribedAt: o.unsubscribed_at,
              unsubscribedCategories: o.unsubscribed_categories ?? [],
              unsubscribeToken: o.unsubscribe_token,
            }
          : null,
        subscriptionStatus: w ? billing.get(w.owner_id) ?? null : null,
        internal: matchesInternal(o?.email ?? null, listed),
        ownerCountries: w ? countries.get(w.owner_id) ?? [] : [],
        ledger: w ? ledger.get(w.owner_id) ?? [] : [],
      };
    });
  }

  async claim(row: ClaimRow): Promise<boolean> {
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .upsert(
        {
          user_id: row.userId,
          template: TEMPLATE,
          trigger_key: row.monthKey,
          email: row.email,
          status: row.status,
          detail: row.detail,
        },
        { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
      )
      .select('user_id');
    if (error) {
      // Fail closed: an insert we cannot confirm is a claim we did not win.
      console.error('[free-reset] claim failed:', error.message);
      return false;
    }
    return (data ?? []).length === 1;
  }

  async finish(
    key: { userId: string; monthKey: string },
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string },
  ): Promise<void> {
    // A send keeps the arm the claim wrote in `detail`.
    const patch: LedgerUpdate = {
      status: outcome.status,
      provider_message_id: outcome.status === 'sent' ? outcome.providerId : null,
      ...(outcome.status === 'failed' ? { detail: outcome.detail.slice(0, 500) } : {}),
      finished_at: new Date().toISOString(),
    };
    const { error } = await this.db
      .from('lifecycle_email_sends')
      .update(patch)
      .eq('user_id', key.userId)
      .eq('template', TEMPLATE)
      .eq('trigger_key', key.monthKey)
      .eq('status', 'claimed');
    if (error) console.error('[free-reset] could not finish ledger row:', error.message);
  }
}

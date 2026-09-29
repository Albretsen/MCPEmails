/**
 * The Supabase side of the paywall follow-up sequence. Thin on purpose: every
 * decision lives in paywall-followup.ts, which is tested against an in-memory
 * store. This file only reads rows and performs the one insert that is the
 * claim.
 *
 * READS ARE SEQUENTIAL. Every query below is awaited before the next one
 * starts, and ids are batched with `.in()` rather than fetched one workspace at
 * a time. The dry-run script points this same adapter at production, and
 * production reads are run one at a time, never in parallel.
 *
 * TWO COLUMNS MAY NOT EXIST YET.
 *   users.marketing_consent_at   added by 20260929100000_marketing_consent.sql
 *   lifecycle_email_sends.finished_at  added by 20260929110000
 * Until those migrations are applied, and until database.types.ts is
 * regenerated, the reads fall back to the older column list. A missing
 * consent column reads as NO consent for everyone, which sends nothing: the
 * fallback can only ever make the sequence quieter. `consentColumnMissing`
 * records that it happened so the dispatcher and the dry run can say so.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { isInternalAccount } from '@/lib/analytics/internal-accounts';
import type {
  CandidateContext,
  ClaimRow,
  FirstPaywall,
  LedgerRow,
  PaywallFollowupStore,
} from '@/lib/email/paywall-followup';
import { SEQUENCE, pickFirstPaywalls, templateFor } from '@/lib/email/paywall-followup';

type Db = SupabaseClient<Database>;
type LedgerUpdate = Database['public']['Tables']['lifecycle_email_sends']['Update'];

const CHUNK = 100;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A PostgREST / Postgres "that column does not exist" error. */
function isMissingColumn(error: { code?: string; message?: string } | null, column: string): boolean {
  if (!error) return false;
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    (typeof error.message === 'string' && error.message.includes(column))
  );
}

/** Same matching as growth_is_internal_email(text): exact, plus-tag-insensitive, or our domains. */
export function matchesInternal(email: string | null, listed: ReadonlySet<string>): boolean {
  if (!email) return false;
  if (isInternalAccount(email)) return true;
  const e = email.trim().toLowerCase();
  const untagged = e.replace(/\+[^@]*@/, '@');
  return listed.has(e) || listed.has(untagged);
}

interface OwnerRow {
  id: string;
  email: string | null;
  unsubscribed_at: string | null;
  unsubscribed_categories: string[] | null;
  unsubscribe_token: string | null;
  marketing_consent_at?: string | null;
}

export class SupabasePaywallFollowupStore implements PaywallFollowupStore {
  private readonly db: Db;
  consentColumnMissing = false;

  constructor(db: Db) {
    this.db = db;
  }

  async listFirstPaywalls(since: Date): Promise<FirstPaywall[]> {
    const { data: recent, error } = await this.db
      .from('product_funnel_events')
      .select('workspace_id, occurred_at, connection_type')
      .eq('stage', 'paywall_reached')
      .gte('occurred_at', since.toISOString())
      .order('occurred_at', { ascending: true })
      .limit(5000);
    if (error) throw new Error(`paywall read failed: ${error.message}`);

    const rows = recent ?? [];
    const ids = [...new Set(rows.map((r) => r.workspace_id))];

    // Which of these also had a paywall BEFORE the window? For those, the one
    // in the window is not the first.
    const earlier = new Set<string>();
    for (const batch of chunks(ids)) {
      const { data, error: earlierError } = await this.db
        .from('product_funnel_events')
        .select('workspace_id')
        .eq('stage', 'paywall_reached')
        .lt('occurred_at', since.toISOString())
        .in('workspace_id', batch)
        .limit(5000);
      if (earlierError) throw new Error(`earlier paywall read failed: ${earlierError.message}`);
      for (const row of data ?? []) earlier.add(row.workspace_id);
    }

    return pickFirstPaywalls(rows, earlier);
  }

  async loadContexts(firsts: FirstPaywall[]): Promise<CandidateContext[]> {
    if (firsts.length === 0) return [];
    const workspaceIds = firsts.map((f) => f.workspaceId);

    const workspaces = new Map<string, { owner_id: string; plan: string; deleted_at: string | null }>();
    for (const ids of chunks(workspaceIds)) {
      const { data, error } = await this.db
        .from('workspaces')
        .select('id, owner_id, plan, deleted_at')
        .in('id', ids);
      if (error) throw new Error(`workspace read failed: ${error.message}`);
      for (const w of data ?? []) workspaces.set(w.id, w);
    }

    const ownerIds = [...new Set([...workspaces.values()].map((w) => w.owner_id))];

    const owners = new Map<string, OwnerRow>();
    for (const ids of chunks(ownerIds)) {
      for (const row of await this.readOwners(ids)) owners.set(row.id, row);
    }

    const billing = new Map<string, string | null>();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db
        .from('user_billing')
        .select('user_id, subscription_status')
        .in('user_id', ids);
      if (error) throw new Error(`billing read failed: ${error.message}`);
      for (const b of data ?? []) billing.set(b.user_id, b.subscription_status);
    }

    const unlimited = new Set<string>();
    for (const ids of chunks(ownerIds)) {
      const { data, error } = await this.db
        .from('user_usage_entitlements')
        .select('user_id, kind, unlimited_inboxes, expires_at')
        .in('user_id', ids);
      if (error) throw new Error(`entitlement read failed: ${error.message}`);
      const nowMs = Date.now();
      for (const e of data ?? []) {
        const live = !e.expires_at || new Date(e.expires_at).getTime() > nowMs;
        // The inbox grandfather is permanent; a comped scale grant also lifts
        // the inbox cap while it lasts. Either makes step 1's premise false.
        if (e.unlimited_inboxes || (e.kind === 'comped_scale' && live)) unlimited.add(e.user_id);
      }
    }

    const { data: internalRows, error: internalError } = await this.db
      .from('internal_accounts')
      .select('email');
    if (internalError) throw new Error(`internal account read failed: ${internalError.message}`);
    const listed = new Set((internalRows ?? []).map((r) => r.email.toLowerCase()));

    const inboxCounts = new Map<string, number>();
    for (const ids of chunks(workspaceIds)) {
      const { data, error } = await this.db
        .from('inboxes')
        .select('workspace_id')
        .in('workspace_id', ids)
        .is('deleted_at', null);
      if (error) throw new Error(`inbox read failed: ${error.message}`);
      for (const i of data ?? []) inboxCounts.set(i.workspace_id, (inboxCounts.get(i.workspace_id) ?? 0) + 1);
    }

    const ledger = new Map<string, LedgerRow[]>();
    for (const ids of chunks(ownerIds)) {
      for (const row of await this.readLedger(ids)) {
        const list = ledger.get(row.userId) ?? [];
        list.push(row);
        ledger.set(row.userId, list);
      }
    }

    return firsts.map((f) => {
      const w = workspaces.get(f.workspaceId) ?? null;
      const o = w ? owners.get(w.owner_id) ?? null : null;
      return {
        ...f,
        workspace: w ? { ownerId: w.owner_id, plan: w.plan, deletedAt: w.deleted_at } : null,
        owner: o
          ? {
              id: o.id,
              email: o.email,
              marketingConsentAt: o.marketing_consent_at ?? null,
              unsubscribedAt: o.unsubscribed_at,
              unsubscribedCategories: o.unsubscribed_categories ?? [],
              unsubscribeToken: o.unsubscribe_token,
            }
          : null,
        subscriptionStatus: w ? billing.get(w.owner_id) ?? null : null,
        unlimitedInboxes: w ? unlimited.has(w.owner_id) : false,
        internal: matchesInternal(o?.email ?? null, listed),
        inboxCount: inboxCounts.get(f.workspaceId) ?? 0,
        ledger: w ? ledger.get(w.owner_id) ?? [] : [],
      };
    });
  }

  private async readOwners(ids: string[]): Promise<OwnerRow[]> {
    const base = 'id, email, unsubscribed_at, unsubscribed_categories, unsubscribe_token';
    if (!this.consentColumnMissing) {
      // A `string`, not a literal: marketing_consent_at is not in the generated
      // types until they are regenerated after 20260929100000 is applied.
      const withConsent: string = `${base}, marketing_consent_at`;
      const { data, error } = await this.db.from('users').select(withConsent).in('id', ids);
      if (!error) return (data ?? []) as unknown as OwnerRow[];
      if (!isMissingColumn(error, 'marketing_consent_at')) throw new Error(`owner read failed: ${error.message}`);
      this.consentColumnMissing = true;
    }
    const { data, error } = await this.db.from('users').select(base).in('id', ids);
    if (error) throw new Error(`owner read failed: ${error.message}`);
    return (data ?? []).map((row) => ({ ...row, marketing_consent_at: null }));
  }

  private async readLedger(userIds: string[]): Promise<Array<LedgerRow & { userId: string }>> {
    const base = 'user_id, template, trigger_key, status, detail, sent_at';
    const withFinished: string = `${base}, finished_at`;
    let rows: Array<Record<string, unknown>>;
    const first = await this.db
      .from('lifecycle_email_sends')
      .select(withFinished)
      .in('user_id', userIds)
      .like('template', `${SEQUENCE}_%`);
    if (!first.error) {
      rows = (first.data ?? []) as unknown as Array<Record<string, unknown>>;
    } else if (isMissingColumn(first.error, 'finished_at')) {
      const second = await this.db
        .from('lifecycle_email_sends')
        .select(base)
        .in('user_id', userIds)
        .like('template', `${SEQUENCE}_%`);
      if (second.error) throw new Error(`ledger read failed: ${second.error.message}`);
      rows = (second.data ?? []) as unknown as Array<Record<string, unknown>>;
    } else {
      throw new Error(`ledger read failed: ${first.error.message}`);
    }
    return rows.map((r) => ({
      userId: String(r.user_id),
      template: String(r.template),
      triggerKey: String(r.trigger_key),
      status: String(r.status),
      detail: (r.detail as string | null) ?? null,
      sentAt: String(r.sent_at),
      finishedAt: (r.finished_at as string | null | undefined) ?? null,
    }));
  }

  async claim(row: ClaimRow): Promise<boolean> {
    // upsert + ignoreDuplicates is PostgREST's INSERT ... ON CONFLICT DO
    // NOTHING; the conflicting row is not returned, so an empty result means
    // somebody else already holds this (user, step, workspace).
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .upsert(
        {
          user_id: row.userId,
          template: templateFor(row.step),
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
      console.error('[paywall-followup] claim failed:', error.message);
      return false;
    }
    return (data ?? []).length === 1;
  }

  async finish(
    key: { userId: string; workspaceId: string; step: 1 | 2 | 3 },
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string },
  ): Promise<void> {
    const patch = {
      status: outcome.status,
      provider_message_id: outcome.status === 'sent' ? outcome.providerId : null,
      detail: outcome.status === 'failed' ? outcome.detail.slice(0, 500) : null,
      finished_at: new Date().toISOString(),
    } as LedgerUpdate;
    const { error } = await this.db
      .from('lifecycle_email_sends')
      .update(patch)
      .eq('user_id', key.userId)
      .eq('template', templateFor(key.step))
      .eq('trigger_key', key.workspaceId)
      .eq('status', 'claimed');
    if (error) {
      // The email may already be gone. The row stays 'claimed', which also
      // ends the sequence, so the failure direction is still "no second send".
      console.error('[paywall-followup] could not finish ledger row:', error.message);
    }
  }
}

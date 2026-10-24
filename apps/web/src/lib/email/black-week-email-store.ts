/**
 * The Supabase side of the Black Week 2026 email. Thin on purpose: every
 * decision lives in black-week-email.ts, which is tested against an in-memory
 * store. This file reads rows and performs the inserts that are the claim.
 *
 * PAGING. PostgREST cuts a select off at 1000 rows without an error, so the
 * consented users are read in pages of 1000 with a total order on id, and
 * every follow-up read is chunked by 100 ids with `.in()`. Reads are
 * sequential.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import {
  BLACK_WEEK_TEMPLATE,
  BLACK_WEEK_TRIGGER_KEY,
  type BlackWeekStore,
  type Candidate,
  type LedgerClaim,
} from '@/lib/email/black-week-email';
import { matchesInternal } from '@/lib/email/paywall-followup-store';

type Db = SupabaseClient<Database>;
type LedgerUpdate = Database['public']['Tables']['lifecycle_email_sends']['Update'];

const PAGE = 1000;
const CHUNK = 100;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class SupabaseBlackWeekStore implements BlackWeekStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async listCandidates(): Promise<Candidate[]> {
    // 1. Consented users, not globally unsubscribed. The category opt-out and
    //    everything else is checked in classifyFromDb.
    const users: Array<{
      id: string;
      email: string;
      marketing_consent_at: string | null;
      unsubscribed_at: string | null;
      unsubscribed_categories: string[];
      unsubscribe_token: string;
    }> = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.db
        .from('users')
        .select('id, email, marketing_consent_at, unsubscribed_at, unsubscribed_categories, unsubscribe_token')
        .not('marketing_consent_at', 'is', null)
        .is('unsubscribed_at', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`user read failed: ${error.message}`);
      users.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    if (users.length === 0) return [];
    const ids = users.map((u) => u.id);

    const owners = new Set<string>();
    const billing = new Map<string, Candidate['billing']>();
    const comped = new Set<string>();
    const inLedger = new Set<string>();
    const nowMs = Date.now();

    for (const batch of chunks(ids)) {
      const ws = await this.db
        .from('workspaces')
        .select('owner_id')
        .in('owner_id', batch)
        .is('deleted_at', null);
      if (ws.error) throw new Error(`workspace read failed: ${ws.error.message}`);
      for (const w of ws.data ?? []) owners.add(w.owner_id);

      const ub = await this.db
        .from('user_billing')
        .select('user_id, plan, subscription_status, stripe_subscription_id')
        .in('user_id', batch);
      if (ub.error) throw new Error(`billing read failed: ${ub.error.message}`);
      for (const b of ub.data ?? []) {
        billing.set(b.user_id, {
          plan: b.plan,
          subscriptionStatus: b.subscription_status,
          stripeSubscriptionId: b.stripe_subscription_id,
        });
      }

      const ent = await this.db
        .from('user_usage_entitlements')
        .select('user_id, kind, expires_at')
        .in('user_id', batch);
      if (ent.error) throw new Error(`entitlement read failed: ${ent.error.message}`);
      for (const e of ent.data ?? []) {
        const live = !e.expires_at || new Date(e.expires_at).getTime() > nowMs;
        if (e.kind === 'comped_scale' && live) comped.add(e.user_id);
      }

      const led = await this.db
        .from('lifecycle_email_sends')
        .select('user_id')
        .in('user_id', batch)
        .eq('template', BLACK_WEEK_TEMPLATE)
        .eq('trigger_key', BLACK_WEEK_TRIGGER_KEY);
      if (led.error) throw new Error(`ledger read failed: ${led.error.message}`);
      for (const l of led.data ?? []) inLedger.add(l.user_id);
    }

    const { data: internalRows, error: internalError } = await this.db
      .from('internal_accounts')
      .select('email');
    if (internalError) throw new Error(`internal account read failed: ${internalError.message}`);
    const listed = new Set((internalRows ?? []).map((r) => r.email.toLowerCase()));

    return users.map((u) => ({
      userId: u.id,
      email: u.email,
      unsubscribedAt: u.unsubscribed_at,
      unsubscribedCategories: u.unsubscribed_categories ?? [],
      unsubscribeToken: u.unsubscribe_token,
      marketingConsentAt: u.marketing_consent_at,
      ownsLiveWorkspace: owners.has(u.id),
      internal: matchesInternal(u.email, listed),
      compedGrant: comped.has(u.id),
      billing: billing.get(u.id) ?? null,
      alreadyInLedger: inLedger.has(u.id),
    }));
  }

  async claim(rows: LedgerClaim[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    // upsert + ignoreDuplicates is INSERT ... ON CONFLICT DO NOTHING; only the
    // rows this call created come back.
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .upsert(
        rows.map((r) => ({
          user_id: r.userId,
          template: BLACK_WEEK_TEMPLATE,
          trigger_key: BLACK_WEEK_TRIGGER_KEY,
          email: r.email,
          status: r.status,
          detail: r.detail,
        })),
        { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
      )
      .select('user_id');
    if (error) {
      // Fail closed: a claim we cannot confirm is a claim we did not win.
      console.error('[black-week-email] claim failed:', error.message);
      return new Set();
    }
    return new Set((data ?? []).map((r) => r.user_id));
  }

  async finish(
    userId: string,
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
      .eq('user_id', userId)
      .eq('template', BLACK_WEEK_TEMPLATE)
      .eq('trigger_key', BLACK_WEEK_TRIGGER_KEY)
      .eq('status', 'claimed');
    if (error) console.error('[black-week-email] finish failed:', error.message);
  }
}

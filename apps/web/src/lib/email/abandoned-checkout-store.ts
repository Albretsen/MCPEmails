/**
 * The Supabase side of the abandoned-checkout reminder. Thin on purpose: every
 * decision lives in abandoned-checkout.ts, which is tested against an
 * in-memory store. Service-role client only (the webhook's).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { primaryWorkspaceId } from '@/lib/analytics/billing-funnel';
import { matchesInternal } from '@/lib/email/paywall-followup-store';
import type { ClaimInput, ReminderContext, ReminderRow, ReminderStore } from '@/lib/email/abandoned-checkout';
import { TEMPLATE_PREFIX } from '@/lib/email/abandoned-checkout';

type Db = SupabaseClient<Database>;
type LedgerUpdate = Database['public']['Tables']['lifecycle_email_sends']['Update'];

export class SupabaseReminderStore implements ReminderStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async loadContext(userId: string, sessionCreatedAt: Date): Promise<ReminderContext> {
    const { data: owner, error: ownerError } = await this.db
      .from('users')
      .select('id, email, marketing_consent_at, unsubscribed_at, unsubscribed_categories, unsubscribe_token')
      .eq('id', userId)
      .maybeSingle();
    if (ownerError) throw new Error(`owner read failed: ${ownerError.message}`);

    const workspaceId = await primaryWorkspaceId(this.db, userId);

    const { data: billing, error: billingError } = await this.db
      .from('user_billing')
      .select('subscription_status')
      .eq('user_id', userId)
      .maybeSingle();
    if (billingError) throw new Error(`billing read failed: ${billingError.message}`);

    let completedSince = false;
    if (workspaceId) {
      const { data: completed, error: completedError } = await this.db
        .from('product_funnel_events')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('stage', 'checkout_completed')
        .gte('occurred_at', sessionCreatedAt.toISOString())
        .limit(1);
      if (completedError) throw new Error(`funnel read failed: ${completedError.message}`);
      completedSince = (completed ?? []).length > 0;
    }

    const { data: internalRows, error: internalError } = await this.db
      .from('internal_accounts')
      .select('email');
    if (internalError) throw new Error(`internal account read failed: ${internalError.message}`);
    const listed = new Set((internalRows ?? []).map((r) => r.email.toLowerCase()));

    return {
      owner: owner
        ? {
            id: owner.id,
            email: owner.email,
            marketingConsentAt: owner.marketing_consent_at,
            unsubscribedAt: owner.unsubscribed_at,
            unsubscribedCategories: owner.unsubscribed_categories ?? [],
            unsubscribeToken: owner.unsubscribe_token,
          }
        : null,
      workspaceId,
      internal: matchesInternal(owner?.email ?? null, listed),
      subscriptionStatus: billing?.subscription_status ?? null,
      completedSince,
      rows: await this.readRows(userId),
    };
  }

  async readRows(userId: string): Promise<ReminderRow[]> {
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .select('template, trigger_key, status, detail, sent_at, recovered_at')
      .eq('user_id', userId)
      .like('template', `${TEMPLATE_PREFIX}\\_%`);
    if (error) throw new Error(`ledger read failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      template: r.template,
      triggerKey: r.trigger_key,
      status: r.status,
      detail: r.detail,
      sentAt: r.sent_at,
      recoveredAt: r.recovered_at,
    }));
  }

  async claim(row: ClaimInput): Promise<boolean> {
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .upsert(
        {
          user_id: row.userId,
          template: row.template,
          trigger_key: row.triggerKey,
          email: row.email,
          status: row.status,
          detail: row.detail,
        },
        { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
      )
      .select('user_id');
    if (error) {
      // Fail closed: an insert we cannot confirm is a claim we did not win.
      console.error('[abandoned-checkout] claim failed:', error.message);
      return false;
    }
    return (data ?? []).length === 1;
  }

  async finish(
    key: { userId: string; template: string; triggerKey: string },
    outcome:
      | { status: 'sent'; providerId: string | null }
      | { status: 'failed'; detail: string }
      | { status: 'skipped'; detail: string },
  ): Promise<void> {
    const patch: LedgerUpdate = {
      status: outcome.status,
      provider_message_id: outcome.status === 'sent' ? outcome.providerId : null,
      detail: outcome.status === 'sent' ? null : outcome.detail.slice(0, 500),
      finished_at: new Date().toISOString(),
    };
    const { error } = await this.db
      .from('lifecycle_email_sends')
      .update(patch)
      .eq('user_id', key.userId)
      .eq('template', key.template)
      .eq('trigger_key', key.triggerKey)
      .eq('status', 'claimed');
    if (error) console.error('[abandoned-checkout] could not finish ledger row:', error.message);
  }

  async markRecovered(
    key: { userId: string; template: string; triggerKey: string },
    recovery: { at: string; sessionId: string; viaLink: boolean },
  ): Promise<void> {
    const { error } = await this.db
      .from('lifecycle_email_sends')
      .update({
        recovered_at: recovery.at,
        recovered_session_id: recovery.sessionId,
        recovered_via_link: recovery.viaLink,
      })
      .eq('user_id', key.userId)
      .eq('template', key.template)
      .eq('trigger_key', key.triggerKey)
      .is('recovered_at', null);
    if (error) console.error('[abandoned-checkout] could not record recovery:', error.message);
  }
}

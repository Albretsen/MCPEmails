/**
 * The dashboard's `workspace.annualSwitch` prop, read on the server.
 *
 * Returns null (no card, no notice) unless every cheap check passes first
 * (flag, owner, plan, status, not comped, no pass, outside Black Week); only
 * then does it read the billing row, the workspace's payment-issue and
 * dismissal columns, and Stripe. Any read error is null. See annual-switch.ts.
 */

import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  annualNoticeVisible,
  annualSwitchMode,
  getAnnualSwitch,
  mayOfferAnnualSwitch,
  type AnnualSwitch,
  type AnnualSwitchInput,
} from '@/lib/billing/annual-switch';

export interface AnnualSwitchProp extends AnnualSwitch {
  /** Whether the dismissible Overview notice may show. The card always may. */
  noticeVisible: boolean;
}

interface WorkspaceFacts {
  payment_issue_since: string | null;
  annual_switch_dismissed_at: string | null;
  annual_switch_dismiss_count: number | null;
}

/** The dismissal columns are not in the generated types until gen:types runs. */
type FactsDb = {
  from(table: 'workspaces'): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: WorkspaceFacts | null; error: { message: string } | null }>;
      };
    };
  };
};

export async function loadAnnualSwitch(args: {
  userId: string;
  workspaceId: string | null | undefined;
  plan: string | null | undefined;
  isOwner: boolean;
  compedScale: boolean;
  onPass: boolean;
  subscriptionStatus: string | null | undefined;
  now?: Date;
}): Promise<AnnualSwitchProp | null> {
  const base: AnnualSwitchInput = {
    mode: annualSwitchMode(),
    now: args.now ?? new Date(),
    plan: args.plan,
    isOwner: args.isOwner,
    compedScale: args.compedScale,
    onPass: args.onPass,
    subscriptionStatus: args.subscriptionStatus,
    paymentIssueSince: null,
    // Placeholders for the pre-check; the real ids are read below.
    stripeCustomerId: 'pending',
    stripeSubscriptionId: 'pending',
  };
  if (!args.workspaceId || !mayOfferAnnualSwitch(base)) return null;

  try {
    const db = createServiceRoleClient();
    const [billing, facts] = await Promise.all([
      db
        .from('user_billing')
        .select('stripe_customer_id, stripe_subscription_id')
        .eq('user_id', args.userId)
        .maybeSingle(),
      (db as unknown as FactsDb)
        .from('workspaces')
        .select('payment_issue_since, annual_switch_dismissed_at, annual_switch_dismiss_count')
        .eq('id', args.workspaceId)
        .maybeSingle(),
    ]);
    // A missing column (migration not applied yet) lands here: no card.
    if (billing.error || facts.error || !facts.data) return null;

    const resolved = await getAnnualSwitch({
      ...base,
      paymentIssueSince: facts.data.payment_issue_since,
      stripeCustomerId: billing.data?.stripe_customer_id ?? null,
      stripeSubscriptionId: billing.data?.stripe_subscription_id ?? null,
    });
    if (!resolved) return null;
    return {
      ...resolved,
      noticeVisible: annualNoticeVisible({
        dismissedAt: facts.data.annual_switch_dismissed_at,
        dismissCount: facts.data.annual_switch_dismiss_count,
        now: base.now,
      }),
    };
  } catch (err) {
    console.error('[annual-switch] load failed, no card:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

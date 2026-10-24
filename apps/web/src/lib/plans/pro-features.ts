import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveEffectiveWorkspacePlan } from '@/lib/plans/effective-plan';
import type { Database } from '@/types/database.types';

/**
 * The Pro feature gate for the dashboard. Mirror of
 * supabase/functions/mcp-server/pro-features.ts; keep the two decisions in
 * step (both test files pin the same table).
 *
 *   visible = workspaces.pro_features_enabled (internal rollout flag)
 *             OR pricing_switches.pro_features_public (launch switch)
 *   allowed = visible AND effective plan in (solo, pro)
 *
 * `solo` is sold as Pro and `pro` as Business. The effective plan comes from
 * effective_workspace_plan() (comped-aware). Only NEW features are gated;
 * nothing Free or Personal has today goes behind this.
 *
 * Not visible: render nothing new. Visible but not allowed: show the feature
 * with an upgrade prompt. Allowed: show it working.
 */

export type ProFeature = 'reminders' | 'cross_inbox_search' | 'inbox_instructions' | 'morning_brief';

export const PRO_FEATURES: readonly ProFeature[] = [
  'reminders',
  'cross_inbox_search',
  'inbox_instructions',
  'morning_brief',
];

/** Plan ids that get Pro features: solo (Pro) and pro (Business). */
export const PRO_FEATURE_PLANS: readonly string[] = ['solo', 'pro'];

/** The `pricing_switches` key of the public launch switch. */
export const PRO_FEATURES_PUBLIC_SWITCH = 'pro_features_public';

export interface ProGateInputs {
  /** Effective plan id, or null when it could not be resolved. */
  plan: string | null;
  /** workspaces.pro_features_enabled. */
  rolloutEnabled: boolean;
  /** pricing_switches.pro_features_public. */
  publicLaunch: boolean;
}

export interface ProFeatureAccess {
  visible: boolean;
  /** Never true unless visible. */
  allowed: boolean;
  plan: string | null;
}

export const CLOSED_PRO_GATE: ProGateInputs = Object.freeze({
  plan: null,
  rolloutEnabled: false,
  publicLaunch: false,
});

export function isProFeaturePlan(plan: string | null | undefined): boolean {
  return typeof plan === 'string' && PRO_FEATURE_PLANS.includes(plan);
}

/** The decision. Pure. */
export function decideProFeatureAccess(inputs: ProGateInputs): ProFeatureAccess {
  const visible = inputs.rolloutEnabled === true || inputs.publicLaunch === true;
  return {
    visible,
    allowed: visible && isProFeaturePlan(inputs.plan),
    plan: inputs.plan,
  };
}

/**
 * Read the gate for one workspace. Server-side only.
 *
 * `userClient` is the request-scoped USER client: the plan comes from
 * resolveEffectiveWorkspacePlan, which returns nothing under the service role
 * (see effective-plan.ts), and the rollout flag is read through RLS, so a
 * non-member gets the closed answer. `serviceClient` reads only the launch
 * switch, which is server-owned (no grant to authenticated).
 *
 * Fails closed: any failed read leaves the workspace hidden and refused.
 * Pages that already hold the plan and the workspace row can call
 * decideProFeatureAccess directly instead.
 */
export async function loadProFeatureAccess(
  userClient: SupabaseClient<Database>,
  serviceClient: SupabaseClient<Database>,
  workspaceId: string,
): Promise<ProFeatureAccess> {
  try {
    const [plan, workspace, launchSwitch] = await Promise.all([
      resolveEffectiveWorkspacePlan(userClient, workspaceId),
      userClient.from('workspaces').select('pro_features_enabled').eq('id', workspaceId).maybeSingle(),
      serviceClient.from('pricing_switches').select('enabled').eq('key', PRO_FEATURES_PUBLIC_SWITCH).maybeSingle(),
    ]);
    if (!plan.resolved || workspace.error || !workspace.data) {
      return decideProFeatureAccess(CLOSED_PRO_GATE);
    }
    return decideProFeatureAccess({
      plan: plan.plan,
      rolloutEnabled: workspace.data.pro_features_enabled === true,
      publicLaunch: !launchSwitch.error && launchSwitch.data?.enabled === true,
    });
  } catch {
    return decideProFeatureAccess(CLOSED_PRO_GATE);
  }
}

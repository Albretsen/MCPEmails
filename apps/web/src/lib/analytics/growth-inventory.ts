/**
 * Current-state inventory for /admin/growth.
 *
 * These are the cheap "what does the estate look like right now" queries:
 * plan mix, provider mix, MCP client mix, cap utilization, billable volume.
 * They read small tables directly rather than going through a reporting RPC,
 * because at ~116 workspaces the row counts are trivial and a SQL function
 * would add indirection without buying anything.
 *
 * The expensive time-series work lives in `growth-queries.ts`, which talks to
 * the reporting functions added in migration 20260813140000. Everything here
 * follows that module's two conventions: results are cached with a tag so the
 * page's Refresh button can invalidate them, and a failure returns a result
 * object rather than throwing, so one dead query degrades to one dead panel
 * instead of a blank page.
 */

import { unstable_cache } from 'next/cache';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolvePlanLimits } from '@/lib/stripe/plans';
import { GROWTH_TAG, GROWTH_TAGS, type GrowthResult } from '@/lib/analytics/growth-queries';

const DAY_MS = 24 * 60 * 60 * 1000;

export type MixEntry = { name: string; count: number };

export type GrowthInventory = {
  workspaces: number;
  planMix: MixEntry[];
  providerMix: MixEntry[];
  clientMix: MixEntry[];
  /** Workspaces bucketed by share of their plan's monthly action allowance. */
  utilizationBands: MixEntry[];
  billableActions: number;
  billableWorkspaces: number;
  capHitWorkspaces: number;
  capRejections: number;
  paidWorkspaces: number;
};

/** Display names for the internal plan slugs. `pro` is sold as "Scale". */
const PLAN_LABELS: Record<string, string> = { free: 'Free', solo: 'Agent', pro: 'Scale' };

const BANDS = ['0-24%', '25-49%', '50-79%', '80-99%', '100%+'] as const;

function bandFor(ratio: number): (typeof BANDS)[number] {
  if (ratio >= 1) return '100%+';
  if (ratio >= 0.8) return '80-99%';
  if (ratio >= 0.5) return '50-79%';
  if (ratio >= 0.25) return '25-49%';
  return '0-24%';
}

function sortDescending(counts: Map<string, number>): MixEntry[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

async function loadInventory(days: number): Promise<GrowthInventory> {
  const service = createServiceRoleClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();

  const [workspaceResult, inboxResult, actionResult, limitResult] = await Promise.all([
    service.from('workspaces').select('id, plan, analytics_first_tool_client').is('deleted_at', null),
    service.from('inboxes').select('provider, service, status').is('deleted_at', null),
    service.from('action_usage').select('workspace_id, quantity').eq('billable', true).gte('occurred_at', since),
    service.from('usage_limit_events').select('workspace_id').gte('occurred_at', since),
  ]);

  if (workspaceResult.error) throw new Error(`workspaces: ${workspaceResult.error.message}`);
  if (inboxResult.error) throw new Error(`inboxes: ${inboxResult.error.message}`);
  if (actionResult.error) throw new Error(`action_usage: ${actionResult.error.message}`);
  if (limitResult.error) throw new Error(`usage_limit_events: ${limitResult.error.message}`);

  const actionsByWorkspace = new Map<string, number>();
  for (const action of actionResult.data ?? []) {
    actionsByWorkspace.set(action.workspace_id, (actionsByWorkspace.get(action.workspace_id) ?? 0) + action.quantity);
  }

  const planCounts = new Map<string, number>();
  const clientCounts = new Map<string, number>();
  const bandCounts = new Map<string, number>(BANDS.map((band) => [band, 0]));
  for (const workspace of workspaceResult.data ?? []) {
    const plan = workspace.plan ?? 'free';
    const planLabel = PLAN_LABELS[plan] ?? plan;
    planCounts.set(planLabel, (planCounts.get(planLabel) ?? 0) + 1);
    if (workspace.analytics_first_tool_client) {
      clientCounts.set(workspace.analytics_first_tool_client, (clientCounts.get(workspace.analytics_first_tool_client) ?? 0) + 1);
    }
    // Cap comes from the canonical plan table rather than a copy of the
    // numbers, so a pricing change can never silently skew this chart.
    const cap = resolvePlanLimits(plan).maxMonthlyToolCalls;
    const band = bandFor(Number.isFinite(cap) && cap > 0 ? (actionsByWorkspace.get(workspace.id) ?? 0) / cap : 0);
    bandCounts.set(band, (bandCounts.get(band) ?? 0) + 1);
  }

  const providerCounts = new Map<string, number>();
  for (const inbox of inboxResult.data ?? []) {
    if (inbox.status !== 'active') continue;
    // A generic IMAP connection says nothing useful; a named service does.
    const provider = inbox.provider === 'imap' && inbox.service && inbox.service !== 'generic' ? inbox.service : inbox.provider;
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  }

  return {
    workspaces: workspaceResult.data?.length ?? 0,
    planMix: [...planCounts.entries()].map(([name, count]) => ({ name, count })),
    providerMix: sortDescending(providerCounts),
    clientMix: sortDescending(clientCounts),
    utilizationBands: BANDS.map((band) => ({ name: band, count: bandCounts.get(band) ?? 0 })),
    billableActions: (actionResult.data ?? []).reduce((total, action) => total + action.quantity, 0),
    billableWorkspaces: actionsByWorkspace.size,
    capHitWorkspaces: new Set((limitResult.data ?? []).map((event) => event.workspace_id)).size,
    capRejections: limitResult.data?.length ?? 0,
    paidWorkspaces: (planCounts.get('Agent') ?? 0) + (planCounts.get('Scale') ?? 0),
  };
}

export async function fetchInventory(days: number): Promise<GrowthResult<GrowthInventory>> {
  const fetchedAt = new Date().toISOString();
  try {
    const data = await unstable_cache(
      () => loadInventory(days),
      ['growth-inventory', String(days)],
      { revalidate: 600, tags: [GROWTH_TAG, GROWTH_TAGS.inventory] },
    )();
    return { ok: true, data, fetchedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[growth] inventory failed', { message });
    return { ok: false, error: message, fetchedAt };
  }
}

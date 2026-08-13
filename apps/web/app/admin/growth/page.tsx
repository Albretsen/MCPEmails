import { createServiceRoleClient } from '@/lib/supabase/service';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  DAY_MS,
  buildSessions,
  firstActivityTimes,
  frequencyBand,
  groupSuccessfulActivities,
  isValueActivity,
  rollingReturn,
  twoDayValueWithinFirstWeek,
  type SuccessfulActivity,
} from '@/lib/analytics/retention';
import '../../../styles/admin-growth.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

const DAY = DAY_MS;
const DAYS_TO_SHOW = 28;
const HISTORY_DAYS = 180;

type Activity = SuccessfulActivity & { status: string };
type ActionUsage = { workspace_id: string; quantity: number; occurred_at: string };
type UsageLimitEvent = { workspace_id: string; occurred_at: string };
type BillingFunnelRow = {
  workspace_id: string;
  plan: string | null;
  paywall_hits: number;
  pricing_views: number;
  checkouts_started: number;
  checkouts_failed: number;
  checkouts_completed: number;
  abandoned_checkout: boolean;
};

function utcDay(date: Date | string) {
  const value = new Date(date);
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
function key(date: Date | string) { return utcDay(date).toISOString().slice(0, 10); }
function label(date: string) { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)); }
function percent(numerator: number, denominator: number) { return denominator ? `${Math.round((numerator / denominator) * 100)}%` : '—'; }

async function fetchActivities(): Promise<Activity[]> {
  const service = createServiceRoleClient();
  const since = new Date(Date.now() - HISTORY_DAYS * DAY).toISOString();
  const rows: Activity[] = [];
  const pageSize = 1000;

  // PostgREST caps rows per response. Pagination keeps this view correct as
  // usage grows while selecting only aggregate-safe columns.
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await service
      .from('activity_log')
      .select('workspace_id, status, tool_name, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not load product activity: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}

async function fetchUsageReporting(): Promise<{ actions: ActionUsage[]; limitEvents: UsageLimitEvent[] }> {
  const service = createServiceRoleClient();
  const since = new Date(Date.now() - DAYS_TO_SHOW * DAY).toISOString();
  const [actionsResult, limitEventsResult] = await Promise.all([
    service.from('action_usage').select('workspace_id, quantity, occurred_at').eq('billable', true).gte('occurred_at', since),
    service.from('usage_limit_events').select('workspace_id, occurred_at').gte('occurred_at', since),
  ]);
  if (actionsResult.error) throw new Error(`Could not load action usage: ${actionsResult.error.message}`);
  if (limitEventsResult.error) throw new Error(`Could not load cap events: ${limitEventsResult.error.message}`);
  return { actions: actionsResult.data ?? [], limitEvents: limitEventsResult.data ?? [] };
}

/**
 * Billing funnel. Unlike the activation metrics above, this reads the funnel
 * event table directly rather than deriving from activity: a paywall hit, a
 * pricing view, and an abandoned checkout leave no trace in `activity_log`.
 * Reported all-time, not windowed, because the counts are small enough that a
 * 28-day window would usually show zeros and hide the real shape.
 */
async function fetchBillingFunnel(): Promise<BillingFunnelRow[]> {
  // Generated database types cover tables, not views; cast locally rather than
  // weakening the shared application client (same convention as product-funnel).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;
  const { data, error } = await service
    .from('billing_funnel_by_workspace')
    .select('workspace_id, plan, paywall_hits, pricing_views, checkouts_started, checkouts_failed, checkouts_completed, abandoned_checkout');
  if (error) throw new Error(`Could not load billing funnel: ${error.message}`);
  return (data ?? []) as BillingFunnelRow[];
}

export default async function GrowthAnalyticsPage() {
  await requireAdmin();
  const service = createServiceRoleClient();
  const [activities, usageReporting, billingFunnel, workspaceResult, inboxResult] = await Promise.all([
    fetchActivities(),
    fetchUsageReporting(),
    fetchBillingFunnel(),
    service.from('workspaces').select('id, created_at, deleted_at, analytics_first_tool_client, onboarding_technical_activated_at, onboarding_value_activated_at, plan').is('deleted_at', null),
    service.from('inboxes').select('workspace_id, provider, service, status').is('deleted_at', null),
  ]);
  if (workspaceResult.error) throw new Error(`Could not load workspaces: ${workspaceResult.error.message}`);
  if (inboxResult.error) throw new Error(`Could not load inboxes: ${inboxResult.error.message}`);

  const billing = {
    paywalled: billingFunnel.filter((row) => row.paywall_hits > 0).length,
    viewedPricing: billingFunnel.filter((row) => row.pricing_views > 0).length,
    startedCheckout: billingFunnel.filter((row) => row.checkouts_started > 0).length,
    failedCheckout: billingFunnel.filter((row) => row.checkouts_failed > 0).length,
    abandoned: billingFunnel.filter((row) => row.abandoned_checkout).length,
    paid: billingFunnel.filter((row) => row.checkouts_completed > 0).length,
  };

  const today = utcDay(new Date());
  const successfulActivities = activities.filter((activity) => activity.status === 'success');
  const activitiesByWorkspace = groupSuccessfulActivities(successfulActivities);
  const firstSuccess = firstActivityTimes(activitiesByWorkspace);
  const firstValue = firstActivityTimes(activitiesByWorkspace, true);
  // Durable server-authored timestamps keep cohort denominators stable after
  // detailed activity ages out of this page's bounded reporting query.
  for (const workspace of workspaceResult.data ?? []) {
    if (workspace.onboarding_technical_activated_at) {
      firstSuccess.set(workspace.id, new Date(workspace.onboarding_technical_activated_at).getTime());
    }
    if (workspace.onboarding_value_activated_at) {
      firstValue.set(workspace.id, new Date(workspace.onboarding_value_activated_at).getTime());
    }
  }
  const retentionHistoryFloor = today.getTime() - (HISTORY_DAYS - 1) * DAY;
  const retentionFirstValue = new Map(
    [...firstValue].filter(([, firstAt]) => firstAt >= retentionHistoryFloor),
  );
  const successesByWorkspace = new Map<string, number[]>();
  const dailyCalls = new Map<string, { calls: number; successes: number }>();
  for (const activity of activities) {
    const time = new Date(activity.created_at).getTime();
    const day = key(activity.created_at);
    const totals = dailyCalls.get(day) ?? { calls: 0, successes: 0 };
    totals.calls += 1;
    if (activity.status === 'success') {
      totals.successes += 1;
      const workspaceSuccesses = successesByWorkspace.get(activity.workspace_id) ?? [];
      workspaceSuccesses.push(time);
      successesByWorkspace.set(activity.workspace_id, workspaceSuccesses);
    }
    dailyCalls.set(day, totals);
  }

  const newWorkspaces = new Map<string, number>();
  const clientMix = new Map<string, number>();
  for (const workspace of workspaceResult.data ?? []) {
    const workspaceDay = key(workspace.created_at);
    newWorkspaces.set(workspaceDay, (newWorkspaces.get(workspaceDay) ?? 0) + 1);
    if (workspace.analytics_first_tool_client) clientMix.set(workspace.analytics_first_tool_client, (clientMix.get(workspace.analytics_first_tool_client) ?? 0) + 1);
  }

  const activations = new Map<string, number>();
  for (const time of firstSuccess.values()) {
    const day = key(new Date(time));
    activations.set(day, (activations.get(day) ?? 0) + 1);
  }
  const valueActivations = new Map<string, number>();
  for (const time of firstValue.values()) {
    const day = key(new Date(time));
    valueActivations.set(day, (valueActivations.get(day) ?? 0) + 1);
  }
  const activeInWindow = (days: number, end = today) => {
    const cutoff = end.getTime() - (days - 1) * DAY;
    return new Set([...successesByWorkspace.entries()].filter(([, times]) => times.some((time) => time >= cutoff && time < end.getTime() + DAY)).map(([workspaceId]) => workspaceId)).size;
  };
  const valueReturnDays1To7 = rollingReturn(retentionFirstValue, activitiesByWorkspace, 1, 7, today.getTime(), true);
  const valueReturnDays8To28 = rollingReturn(retentionFirstValue, activitiesByWorkspace, 8, 28, today.getTime(), true);
  const twoDayValue = twoDayValueWithinFirstWeek(retentionFirstValue, activitiesByWorkspace, today.getTime());
  let valueSecondSessionWorkspaces = 0;
  for (const workspaceId of retentionFirstValue.keys()) {
    const rows = activitiesByWorkspace.get(workspaceId) ?? [];
    const sessions = buildSessions(rows.filter(isValueActivity).map((activity) => new Date(activity.created_at).getTime()));
    if (sessions.length >= 2) valueSecondSessionWorkspaces += 1;
  }

  const daily = Array.from({ length: DAYS_TO_SHOW }, (_, index) => {
    const date = new Date(today.getTime() - (DAYS_TO_SHOW - 1 - index) * DAY);
    const day = key(date); const usage = dailyCalls.get(day) ?? { calls: 0, successes: 0 };
    return { day, newWorkspaces: newWorkspaces.get(day) ?? 0, activated: activations.get(day) ?? 0, valueActivated: valueActivations.get(day) ?? 0, active7d: activeInWindow(7, date), calls: usage.calls, successes: usage.successes, successRate: percent(usage.successes, usage.calls) };
  });
  const weekly = Array.from({ length: 4 }, (_, index) => {
    const end = new Date(today.getTime() - (3 - index) * 7 * DAY);
    const start = new Date(end.getTime() - 6 * DAY);
    const group = daily.filter((row) => row.day >= key(start) && row.day <= key(end));
    const calls = group.reduce((total, row) => total + row.calls, 0);
    const successes = group.reduce((total, row) => total + row.successes, 0);
    const startTime = utcDay(start).getTime();
    const endTime = utcDay(end).getTime() + DAY;
    const returningOlder = new Set([...successesByWorkspace.entries()].filter(([workspaceId, times]) => {
      const activatedAt = firstSuccess.get(workspaceId);
      return activatedAt !== undefined && activatedAt < startTime && times.some((time) => time >= startTime && time < endTime);
    }).map(([workspaceId]) => workspaceId)).size;
    return { label: `${label(key(start))}–${label(key(end))}`, newWorkspaces: group.reduce((total, row) => total + row.newWorkspaces, 0), activated: group.reduce((total, row) => total + row.activated, 0), valueActivated: group.reduce((total, row) => total + row.valueActivated, 0), returningOlder, active7d: activeInWindow(7, end), calls, successes, successRate: percent(successes, calls) };
  });
  const providerMix = new Map<string, number>();
  for (const inbox of inboxResult.data ?? []) {
    if (inbox.status !== 'active') continue;
    const provider = inbox.provider === 'imap' && inbox.service && inbox.service !== 'generic' ? inbox.service : inbox.provider;
    providerMix.set(provider, (providerMix.get(provider) ?? 0) + 1);
  }
  const mixRows = (values: Map<string, number>) => [...values.entries()].sort((a, b) => b[1] - a[1]);
  const callsLast28 = daily.reduce((total, row) => total + row.calls, 0);
  const actionsByWorkspace = new Map<string, number>();
  for (const action of usageReporting.actions) actionsByWorkspace.set(action.workspace_id, (actionsByWorkspace.get(action.workspace_id) ?? 0) + action.quantity);
  const planCaps: Record<string, number> = { free: 2_500, solo: 50_000, pro: 300_000 };
  const utilizationBands = new Map<string, number>([['0–24%', 0], ['25–49%', 0], ['50–79%', 0], ['80–99%', 0], ['100%+', 0]]);
  const planMix = new Map<string, number>();
  for (const workspace of workspaceResult.data ?? []) {
    const plan = workspace.plan ?? 'free';
    planMix.set(plan, (planMix.get(plan) ?? 0) + 1);
    const ratio = (actionsByWorkspace.get(workspace.id) ?? 0) / (planCaps[plan] ?? planCaps.free);
    const band = ratio >= 1 ? '100%+' : ratio >= .8 ? '80–99%' : ratio >= .5 ? '50–79%' : ratio >= .25 ? '25–49%' : '0–24%';
    utilizationBands.set(band, (utilizationBands.get(band) ?? 0) + 1);
  }
  const actionTotal = usageReporting.actions.reduce((total, action) => total + action.quantity, 0);
  const capHitWorkspaces = new Set(usageReporting.limitEvents.map((event) => event.workspace_id)).size;
  const latest28Start = today.getTime() - 27 * DAY;
  const activeDayBands = new Map<string, number>([['1', 0], ['2–3', 0], ['4–7', 0], ['8+', 0]]);
  const sessionBands = new Map<string, number>([['1', 0], ['2–3', 0], ['4–7', 0], ['8+', 0]]);
  let sessionsLast28 = 0;
  let activeWorkspacesLast28 = 0;
  for (const rows of activitiesByWorkspace.values()) {
    const recent = rows.filter((activity) => {
      const time = new Date(activity.created_at).getTime();
      return time >= latest28Start && time < today.getTime() + DAY;
    });
    if (!recent.length) continue;
    activeWorkspacesLast28 += 1;
    const activeDays = new Set(recent.map((activity) => key(activity.created_at))).size;
    const sessions = buildSessions(recent.map((activity) => new Date(activity.created_at).getTime())).length;
    sessionsLast28 += sessions;
    const dayBand = frequencyBand(activeDays);
    const sessionBand = frequencyBand(sessions);
    activeDayBands.set(dayBand, (activeDayBands.get(dayBand) ?? 0) + 1);
    sessionBands.set(sessionBand, (sessionBands.get(sessionBand) ?? 0) + 1);
  }
  const sessionsPerActiveWorkspace = activeWorkspacesLast28 ? (sessionsLast28 / activeWorkspacesLast28).toFixed(1) : '—';

  return <main className="growth-page">
    <header className="growth-header"><div><h1 className="growth-title">Growth analytics</h1><p className="growth-subtitle">Aggregate product usage only. Updated on request; all dates are UTC.</p></div><p className="growth-definition"><strong>Active workspace:</strong> at least one successful MCP tool call in the rolling window. No customer names, email addresses, IDs, or request content are shown.</p></header>
    <section className="growth-stat-grid" aria-label="Growth summary">
      <Stat label="Active workspaces (7d)" value={activeInWindow(7)} detail="Successful call in last 7 days" />
      <Stat label="Active workspaces (28d)" value={activeInWindow(28)} detail="Successful call in last 28 days" />
      <Stat label="New workspaces (28d)" value={daily.reduce((total, row) => total + row.newWorkspaces, 0)} detail="Non-deleted workspaces created" />
      <Stat label="Value activations (28d)" value={daily.reduce((total, row) => total + row.valueActivated, 0)} detail="First successful inbox-dependent operation" />
    </section>
    <section className="growth-stat-grid" aria-label="Usage pricing summary">
      <Stat label="Billable actions (28d)" value={actionTotal.toLocaleString()} detail={`${actionsByWorkspace.size} workspace${actionsByWorkspace.size === 1 ? '' : 's'} with billable use`} />
      <Stat label="Cap-hit workspaces (28d)" value={capHitWorkspaces} detail={`${usageReporting.limitEvents.length} rejected billable call${usageReporting.limitEvents.length === 1 ? '' : 's'}`} />
      <Stat label="Cap-hit rate (28d)" value={percent(capHitWorkspaces, actionsByWorkspace.size)} detail="Workspaces with a cap response / billable-action workspaces" />
      <Stat label="Paid workspaces" value={(planMix.get('solo') ?? 0) + (planMix.get('pro') ?? 0)} detail={`${planMix.get('solo') ?? 0} Agent · ${planMix.get('pro') ?? 0} Scale`} />
    </section>
    <section className="growth-stat-grid" aria-label="Retention summary">
      <Stat label="Value return (days 1–7)" value={percent(valueReturnDays1To7.retained, valueReturnDays1To7.eligible)} detail={`${valueReturnDays1To7.retained} of ${valueReturnDays1To7.eligible} eligible value-activated workspaces`} />
      <Stat label="Value return (days 8–28)" value={percent(valueReturnDays8To28.retained, valueReturnDays8To28.eligible)} detail={`${valueReturnDays8To28.retained} of ${valueReturnDays8To28.eligible} eligible value-activated workspaces`} />
      <Stat label="Two-day value (first 7d)" value={percent(twoDayValue.retained, twoDayValue.eligible)} detail={`${twoDayValue.retained} of ${twoDayValue.eligible} used a mailbox on two distinct days`} />
      <Stat label="Second value session" value={percent(valueSecondSessionWorkspaces, retentionFirstValue.size)} detail={`${valueSecondSessionWorkspaces} of ${retentionFirstValue.size} value-activated workspaces in ${HISTORY_DAYS}d · 30m gap`} />
    </section>
    <Table title="Weekly product metrics" subtitle="Four completed-to-date rolling seven-day periods." rows={weekly} firstColumn="Week" />
    <Table title="Daily product metrics" subtitle="Technical activation is any successful call; value activation requires an inbox-dependent operation." rows={daily} firstColumn="Day" />
    <section className="growth-stat-grid" aria-label="Engagement frequency summary">
      <Stat label="Successful sessions (28d)" value={sessionsLast28.toLocaleString()} detail="Sessions separated by at least 30 minutes" />
      <Stat label="Sessions / active workspace" value={sessionsPerActiveWorkspace} detail={`${activeWorkspacesLast28} active workspaces in the window`} />
      <Stat label="Returning older cohorts (7d)" value={weekly.at(-1)?.returningOlder ?? 0} detail="Active this week and activated before the week began" />
      <Stat label="Tool calls (28d)" value={callsLast28.toLocaleString()} detail={`${percent(daily.reduce((total, row) => total + row.successes, 0), callsLast28)} successful`} />
    </section>
    <section className="growth-section"><h2>Engagement frequency</h2><p>Workspace distribution over the rolling 28-day window. Active days measure habit; sessions use a 30-minute inactivity boundary.</p><div className="growth-split"><MixTable title="Active days" rows={mixRows(activeDayBands)} secondHeader="Workspaces" /><MixTable title="Successful sessions" rows={mixRows(sessionBands)} secondHeader="Workspaces" /></div></section>
    <section className="growth-section"><h2>Usage and conversion baseline</h2><p>Rolling 28-day action utilization by current plan cap. The plan mix is a current-state baseline; conversion is reported once a workspace changes plan.</p><div className="growth-split"><MixTable title="Cap utilization" rows={mixRows(utilizationBands)} /><MixTable title="Current plan" rows={mixRows(new Map([['Free', planMix.get('free') ?? 0], ['Agent', planMix.get('solo') ?? 0], ['Scale', planMix.get('pro') ?? 0]]))} /></div></section>
    <section className="growth-section">
      <h2>Billing funnel</h2>
      <p>All-time, workspace-level. Each stage counts workspaces that reached it at least once, so a stage showing zero means no user has ever got that far. <strong>Paywalled</strong> is the entry point: a workspace cannot be expected to convert if it was never asked to pay.</p>
      <div className="growth-table-wrap">
        <table className="growth-table">
          <thead><tr><th>Stage</th><th>Workspaces</th><th>Meaning of zero</th></tr></thead>
          <tbody>
            <tr><td>Hit the action cap</td><td>{billing.paywalled}</td><td>Nobody has ever been blocked by a plan limit.</td></tr>
            <tr><td>Viewed pricing (signed in)</td><td>{billing.viewedPricing}</td><td>No existing user has looked at the plans.</td></tr>
            <tr><td>Reached Stripe checkout</td><td>{billing.startedCheckout}</td><td>No checkout session was ever created.</td></tr>
            <tr><td>Checkout request failed</td><td>{billing.failedCheckout}</td><td>The upgrade endpoint has never errored.</td></tr>
            <tr><td>Abandoned on Stripe</td><td>{billing.abandoned}</td><td>Nobody reached Stripe and left without paying.</td></tr>
            <tr><td>Completed payment</td><td>{billing.paid}</td><td>No paid conversion recorded.</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section className="growth-section"><h2>Connection mix</h2><p>Active inboxes and the client recorded with a workspace’s first successful MCP tool call.</p><div className="growth-split"><MixTable title="Provider" rows={mixRows(providerMix)} /><MixTable title="MCP client" rows={mixRows(clientMix)} /></div></section>
  </main>;
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail: string }) { return <div className="growth-stat"><div className="growth-stat-label">{label}</div><div className="growth-stat-value">{value}</div><div className="growth-stat-detail">{detail}</div></div>; }
function Table({ title, subtitle, rows, firstColumn }: { title: string; subtitle: string; rows: Array<{ day?: string; label?: string; newWorkspaces: number; activated: number; valueActivated: number; returningOlder?: number; active7d: number; calls: number; successes: number; successRate: string }>; firstColumn: string }) { return <section className="growth-section"><h2>{title}</h2><p>{subtitle}</p><div className="growth-table-wrap"><table className="growth-table"><thead><tr><th>{firstColumn}</th><th>New workspaces</th><th>Technical activation</th><th>Value activation</th><th>Returning older</th><th>Active (7d)</th><th>Tool calls</th><th>Success rate</th></tr></thead><tbody>{rows.map((row) => <tr key={row.day ?? row.label}><td>{row.day ? label(row.day) : row.label}</td><td>{row.newWorkspaces}</td><td>{row.activated}</td><td>{row.valueActivated}</td><td>{row.returningOlder ?? '—'}</td><td>{row.active7d}</td><td>{row.calls.toLocaleString()}</td><td>{row.successRate}</td></tr>)}</tbody></table></div></section>; }
function MixTable({ title, rows, secondHeader = 'Workspaces / inboxes' }: { title: string; rows: [string, number][]; secondHeader?: string }) { return <div className="growth-table-wrap"><table className="growth-table"><thead><tr><th>{title}</th><th>{secondHeader}</th></tr></thead><tbody>{rows.length ? rows.map(([name, count]) => <tr key={name}><td>{name}</td><td>{count}</td></tr>) : <tr><td className="growth-empty" colSpan={2}>No data recorded yet.</td></tr>}</tbody></table></div>; }

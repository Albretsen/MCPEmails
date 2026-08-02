import { createServiceRoleClient } from '@/lib/supabase/service';
import { requireAdmin } from '@/lib/admin/require-admin';
import '../../../styles/admin-growth.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Growth analytics · MCP Emails', robots: { index: false, follow: false } };

const DAY = 24 * 60 * 60 * 1000;
const DAYS_TO_SHOW = 28;
const HISTORY_DAYS = 180;

type Activity = { workspace_id: string; status: string; created_at: string };

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
      .select('workspace_id, status, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not load product activity: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}

export default async function GrowthAnalyticsPage() {
  await requireAdmin();
  const service = createServiceRoleClient();
  const [activities, workspaceResult, inboxResult] = await Promise.all([
    fetchActivities(),
    service.from('workspaces').select('id, created_at, deleted_at, analytics_first_tool_client').is('deleted_at', null),
    service.from('inboxes').select('workspace_id, provider, service, status').is('deleted_at', null),
  ]);
  if (workspaceResult.error) throw new Error(`Could not load workspaces: ${workspaceResult.error.message}`);
  if (inboxResult.error) throw new Error(`Could not load inboxes: ${inboxResult.error.message}`);

  const today = utcDay(new Date());
  const firstSuccess = new Map<string, number>();
  const successesByWorkspace = new Map<string, number[]>();
  const dailyCalls = new Map<string, { calls: number; successes: number }>();
  for (const activity of activities) {
    const time = new Date(activity.created_at).getTime();
    const day = key(activity.created_at);
    const totals = dailyCalls.get(day) ?? { calls: 0, successes: 0 };
    totals.calls += 1;
    if (activity.status === 'success') {
      totals.successes += 1;
      if (!firstSuccess.has(activity.workspace_id)) firstSuccess.set(activity.workspace_id, time);
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
  const activeInWindow = (days: number, end = today) => {
    const cutoff = end.getTime() - (days - 1) * DAY;
    return new Set([...successesByWorkspace.entries()].filter(([, times]) => times.some((time) => time >= cutoff && time < end.getTime() + DAY)).map(([workspaceId]) => workspaceId)).size;
  };
  const hasSuccessOnDay = (times: number[] | undefined, target: number) => times?.some((time) => key(new Date(time)) === key(new Date(target))) ?? false;
  const retention = (offset: number) => {
    let eligible = 0; let retained = 0;
    for (const [workspaceId, activatedAt] of firstSuccess) {
      const target = utcDay(new Date(activatedAt)).getTime() + offset * DAY;
      if (target >= today.getTime()) continue;
      eligible += 1;
      if (hasSuccessOnDay(successesByWorkspace.get(workspaceId), target)) retained += 1;
    }
    return { eligible, retained };
  };
  const d7 = retention(7); const d28 = retention(28);

  const daily = Array.from({ length: DAYS_TO_SHOW }, (_, index) => {
    const date = new Date(today.getTime() - (DAYS_TO_SHOW - 1 - index) * DAY);
    const day = key(date); const usage = dailyCalls.get(day) ?? { calls: 0, successes: 0 };
    return { day, newWorkspaces: newWorkspaces.get(day) ?? 0, activated: activations.get(day) ?? 0, active7d: activeInWindow(7, date), calls: usage.calls, successes: usage.successes, successRate: percent(usage.successes, usage.calls) };
  });
  const weekly = Array.from({ length: 4 }, (_, index) => {
    const end = new Date(today.getTime() - (3 - index) * 7 * DAY);
    const start = new Date(end.getTime() - 6 * DAY);
    const group = daily.filter((row) => row.day >= key(start) && row.day <= key(end));
    const calls = group.reduce((total, row) => total + row.calls, 0);
    const successes = group.reduce((total, row) => total + row.successes, 0);
    return { label: `${label(key(start))}–${label(key(end))}`, newWorkspaces: group.reduce((total, row) => total + row.newWorkspaces, 0), activated: group.reduce((total, row) => total + row.activated, 0), active7d: activeInWindow(7, end), calls, successes, successRate: percent(successes, calls) };
  });
  const providerMix = new Map<string, number>();
  for (const inbox of inboxResult.data ?? []) {
    if (inbox.status !== 'active') continue;
    const provider = inbox.provider === 'imap' && inbox.service && inbox.service !== 'generic' ? inbox.service : inbox.provider;
    providerMix.set(provider, (providerMix.get(provider) ?? 0) + 1);
  }
  const mixRows = (values: Map<string, number>) => [...values.entries()].sort((a, b) => b[1] - a[1]);
  const callsLast28 = daily.reduce((total, row) => total + row.calls, 0);

  return <main className="growth-page">
    <header className="growth-header"><div><h1 className="growth-title">Growth analytics</h1><p className="growth-subtitle">Aggregate product usage only. Updated on request; all dates are UTC.</p></div><p className="growth-definition"><strong>Active workspace:</strong> at least one successful MCP tool call in the rolling window. No customer names, email addresses, IDs, or request content are shown.</p></header>
    <section className="growth-stat-grid" aria-label="Growth summary">
      <Stat label="Active workspaces (7d)" value={activeInWindow(7)} detail="Successful call in last 7 days" />
      <Stat label="Active workspaces (28d)" value={activeInWindow(28)} detail="Successful call in last 28 days" />
      <Stat label="New workspaces (28d)" value={daily.reduce((total, row) => total + row.newWorkspaces, 0)} detail="Non-deleted workspaces created" />
      <Stat label="Tool calls (28d)" value={callsLast28.toLocaleString()} detail={`${percent(daily.reduce((total, row) => total + row.successes, 0), callsLast28)} successful`} />
    </section>
    <section className="growth-stat-grid" aria-label="Retention summary">
      <Stat label="D7 retention" value={percent(d7.retained, d7.eligible)} detail={`${d7.retained} of ${d7.eligible} activated workspaces called again on day 7`} />
      <Stat label="D28 retention" value={percent(d28.retained, d28.eligible)} detail={`${d28.retained} of ${d28.eligible} activated workspaces called again on day 28`} />
    </section>
    <Table title="Weekly product metrics" subtitle="Four completed-to-date rolling seven-day periods." rows={weekly} firstColumn="Week" />
    <Table title="Daily product metrics" subtitle="Activation is a workspace’s first successful MCP tool call observed in the last 180 days." rows={daily} firstColumn="Day" />
    <section className="growth-section"><h2>Connection mix</h2><p>Active inboxes and the client recorded with a workspace’s first successful MCP tool call.</p><div className="growth-split"><MixTable title="Provider" rows={mixRows(providerMix)} /><MixTable title="MCP client" rows={mixRows(clientMix)} /></div></section>
  </main>;
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail: string }) { return <div className="growth-stat"><div className="growth-stat-label">{label}</div><div className="growth-stat-value">{value}</div><div className="growth-stat-detail">{detail}</div></div>; }
function Table({ title, subtitle, rows, firstColumn }: { title: string; subtitle: string; rows: Array<{ day?: string; label?: string; newWorkspaces: number; activated: number; active7d: number; calls: number; successes: number; successRate: string }>; firstColumn: string }) { return <section className="growth-section"><h2>{title}</h2><p>{subtitle}</p><div className="growth-table-wrap"><table className="growth-table"><thead><tr><th>{firstColumn}</th><th>New workspaces</th><th>Activated</th><th>Active (7d)</th><th>Tool calls</th><th>Success rate</th></tr></thead><tbody>{rows.map((row) => <tr key={row.day ?? row.label}><td>{row.day ? label(row.day) : row.label}</td><td>{row.newWorkspaces}</td><td>{row.activated}</td><td>{row.active7d}</td><td>{row.calls.toLocaleString()}</td><td>{row.successRate}</td></tr>)}</tbody></table></div></section>; }
function MixTable({ title, rows }: { title: string; rows: [string, number][] }) { return <div className="growth-table-wrap"><table className="growth-table"><thead><tr><th>{title}</th><th>Workspaces / inboxes</th></tr></thead><tbody>{rows.length ? rows.map(([name, count]) => <tr key={name}><td>{name}</td><td>{count}</td></tr>) : <tr><td className="growth-empty" colSpan={2}>No data recorded yet.</td></tr>}</tbody></table></div>; }

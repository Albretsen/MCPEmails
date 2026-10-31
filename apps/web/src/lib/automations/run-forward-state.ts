/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What became of a forward a rule queued, read when the run log is opened.
 *
 * A run item is written once, when the forward is queued. Writing back to it after
 * each decision would mean every decide path and the dispatcher have to know about
 * the run log. So the item stays as it was and the approval says what happened:
 * this joins `send_approvals` and the `scheduled_sends` row that delivered it.
 */

export type ForwardState = 'waiting' | 'sending' | 'sent' | 'failed' | 'rejected' | 'expired' | 'closed';

export interface ForwardApprovalRow {
  id: string;
  status: string;
  expires_at: string | null;
  dispatch_scheduled_send_id: string | null;
}

export interface ForwardSendRow {
  id: string;
  status: string;
  approval_id: string | null;
}

/**
 * `closed` is an approval that is no longer on record (retention removes decided
 * ones). The log must not call that Waiting, and has nothing to say it was sent.
 */
export function forwardStateOf(
  approval: ForwardApprovalRow | undefined,
  send: ForwardSendRow | undefined,
  nowMs: number,
): ForwardState {
  if (!approval) return 'closed';
  switch (approval.status) {
    case 'pending':
      // Expired but not yet retired by the daily sweep. It can no longer be approved.
      return approval.expires_at && Date.parse(approval.expires_at) <= nowMs ? 'expired' : 'waiting';
    case 'approved':
      if (send?.status === 'sent') return 'sent';
      if (send?.status === 'error' || send?.status === 'cancelled') return 'failed';
      return 'sending';
    case 'rejected':
    case 'cancelled':
      return 'rejected';
    case 'expired':
      return 'expired';
    default:
      return 'closed';
  }
}

/** Page through ids in chunks: an `in` list goes in the URL, and a select stops at 1000 rows. */
const CHUNK = 200;

export async function loadForwardStates(
  db: any,
  workspaceId: string,
  approvalIds: readonly string[],
  nowMs = Date.now(),
): Promise<Map<string, ForwardState>> {
  const ids = [...new Set(approvalIds)];
  const approvals = new Map<string, ForwardApprovalRow>();
  const sends = new Map<string, ForwardSendRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data } = await db.from('send_approvals')
      .select('id, status, expires_at, dispatch_scheduled_send_id')
      .eq('workspace_id', workspaceId)
      .in('id', chunk);
    for (const row of (data ?? []) as ForwardApprovalRow[]) approvals.set(row.id, row);

    // By the marker's own reference to the approval, which exists from the moment
    // of approval. dispatch_scheduled_send_id only exists once the dispatcher binds it.
    const { data: markers } = await db.from('scheduled_sends')
      .select('id, status, approval_id:payload->>approval_id')
      .eq('workspace_id', workspaceId)
      .in('payload->>approval_id', chunk);
    for (const row of (markers ?? []) as ForwardSendRow[]) {
      if (row.approval_id) sends.set(row.approval_id, row);
    }
  }
  const states = new Map<string, ForwardState>();
  for (const id of ids) states.set(id, forwardStateOf(approvals.get(id), sends.get(id), nowMs));
  return states;
}

function approvalIdOf(item: { detail?: unknown }): string | null {
  const detail = item.detail && typeof item.detail === 'object' ? (item.detail as Record<string, unknown>) : {};
  return typeof detail.approval_id === 'string' ? detail.approval_id : null;
}

/** The items of one run, each queued forward carrying `forward_state`. */
export async function attachForwardStates<T extends { outcome?: unknown; detail?: unknown }>(
  db: any,
  workspaceId: string,
  items: readonly T[],
): Promise<(T & { forward_state?: ForwardState })[]> {
  const ids = items
    .filter((item) => item.outcome === 'queued_for_approval')
    .map(approvalIdOf)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return [...items];
  const states = await loadForwardStates(db, workspaceId, ids);
  return items.map((item) => {
    const id = item.outcome === 'queued_for_approval' ? approvalIdOf(item) : null;
    return id ? { ...item, forward_state: states.get(id) } : item;
  });
}

export type ForwardCounts = Record<Exclude<ForwardState, 'closed'>, number>;

/**
 * Per run, how its queued forwards stand now. Runs that queued none are left out.
 * The caller must already have scoped `runs` to the workspace: items are read by run id.
 */
export async function forwardCountsByRun(
  db: any,
  workspaceId: string,
  runs: ReadonlyArray<Record<string, unknown>>,
): Promise<Map<string, ForwardCounts>> {
  const runIds = runs.filter((run) => Number(run.queued ?? 0) > 0).map((run) => run.id as string);
  const counts = new Map<string, ForwardCounts>();
  if (runIds.length === 0) return counts;
  // A page holds at most 100 runs, each with at most 200 items, so this pages.
  const items: { run_id: string; detail: unknown }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('triage_run_items')
      .select('id, run_id, detail')
      .eq('outcome', 'queued_for_approval')
      .in('run_id', runIds)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    items.push(...(data as { run_id: string; detail: unknown }[]));
    if (data.length < PAGE) break;
  }
  const states = await loadForwardStates(
    db,
    workspaceId,
    items.map(approvalIdOf).filter((id): id is string => id !== null),
  );
  for (const item of items) {
    const id = approvalIdOf(item);
    const state = id ? states.get(id) : undefined;
    if (!state || state === 'closed') continue;
    const row = counts.get(item.run_id) ?? { waiting: 0, sending: 0, sent: 0, failed: 0, rejected: 0, expired: 0 };
    row[state]++;
    counts.set(item.run_id, row);
  }
  return counts;
}

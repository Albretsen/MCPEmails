import { decideApproval, isExpired, kickDispatch } from './decide';
import { readSummary } from './payload';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * "Approve all from this rule".
 *
 * SAFETY. A person who has seen a count and one address approves exactly the rows
 * they saw. It is allowed only while every waiting row from the rule goes to that
 * one address, with no copies to anyone else, so one click can not cover a
 * recipient the dialog did not name. Every row still goes through decideApproval,
 * with the revision the page showed. Only a dashboard session with an owner or
 * admin role reaches this (app/api/approvals/approve-rule/route.ts).
 *
 * PACING (20261024130000_outbound_abuse_brakes.sql). Three things can stop sends:
 *   * a workspace freeze and a provider-refusal pause: while either is on, nothing
 *     is approved, since the rows would only sit there approved and unsent;
 *   * the rolling daily ceiling: rows beyond what is left today stay waiting, and
 *     are reported, so they stay rejectable rather than queueing out of reach;
 *   * three provider refusals in an hour pause the inbox. Sends are spaced out so
 *     that this brake sees the refusals and stops the rest. A burst would be gone
 *     before it could. The brake also holds anything still queued, so nothing is lost.
 * An approved send skips the fan-out brake by design (`p_human_approved`).
 */

/** At most this many rows per click; the rest stay waiting and are reported. */
export const APPROVE_ALL_MAX = 50;
/** Seconds between sends. The dispatcher runs each minute, so about 4 per tick. */
export const APPROVE_ALL_PACE_SECONDS = 15;
/** Mirror of DAILY_SEND_LIMIT_PER_INBOX in mcp-server/outbound-brakes.ts. */
const DAILY_SEND_LIMIT_PER_INBOX = 500;

export type RowOutcome = 'approved' | 'expired' | 'changed' | 'not_pending' | 'left_waiting' | 'failed';

export interface ApproveAllItem {
  id: string;
  revision: number;
}

export type ApproveAllResult =
  | { ok: true; outcomes: Array<{ id: string; outcome: RowOutcome }> }
  | { ok: false; code: string; status: number; error: string };

const refuse = (code: string, status: number, error: string): ApproveAllResult => ({ ok: false, code, status, error });

/** The one address every row goes to, or null when that can not be said. */
export function singleAddress(summaries: Array<Record<string, unknown>>): string | null {
  const addresses = new Set<string>();
  for (const summary of summaries) {
    const to = Array.isArray(summary.to) ? summary.to : [];
    const cc = Array.isArray(summary.cc) ? summary.cc : [];
    if (to.length !== 1 || cc.length > 0 || Number(summary.bcc_count ?? 0) > 0) return null;
    if (typeof to[0] !== 'string') return null;
    addresses.add(to[0].trim().toLowerCase());
  }
  return addresses.size === 1 ? [...addresses][0] : null;
}

/** Valid `items` from a request body, or null. */
export function parseApproveAllItems(value: unknown): ApproveAllItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return null;
  const items: ApproveAllItem[] = [];
  for (const entry of value) {
    if (typeof entry?.id !== 'string' || !Number.isInteger(entry?.revision)) return null;
    items.push({ id: entry.id, revision: entry.revision });
  }
  return items;
}

export async function approveAllFromRule(args: {
  db: any;
  workspaceId: string;
  userId: string;
  ruleId: string;
  address: string;
  items: ApproveAllItem[];
  nowMs?: number;
}): Promise<ApproveAllResult> {
  const { db, workspaceId, userId, ruleId, items, nowMs = Date.now() } = args;
  const address = args.address.trim().toLowerCase();

  const { data: rule } = await db
    .from('triage_rules')
    .select('id, deleted_at')
    .eq('id', ruleId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!rule) return refuse('not_found', 404, 'Not found.');
  if (rule.deleted_at) {
    return refuse('rule_deleted', 409, 'This rule was deleted. Review its waiting forwards one at a time.');
  }

  const { data: rows, error } = await db
    .from('send_approvals')
    .select('id, inbox_id, operation, summary, status, expires_at, revision')
    .eq('workspace_id', workspaceId)
    .eq('triage_rule_id', ruleId)
    .eq('status', 'pending');
  if (error) return refuse('read_failed', 500, 'Could not read the waiting forwards.');

  // Everything waiting from this rule counts, not only the rows sent: a request
  // that arrived for another address after the page loaded changes the answer.
  const live = (rows ?? []).filter((row: any) => !isExpired(row));
  const liveById = new Map<string, any>(live.map((row: any) => [row.id, row]));
  if (live.some((row: any) => row.operation !== 'email_forward')) {
    return refuse('mixed_addresses', 409, 'These cannot be approved together. Review them one at a time.');
  }
  if (live.length > 0 && singleAddress(live.map((row: any) => readSummary(row.summary))) !== address) {
    return refuse('mixed_addresses', 409, 'These do not all go to that one address. Review them one at a time.');
  }

  const inboxIds = [...new Set<string>(live.map((row: any) => row.inbox_id))];
  const { data: workspace } = await db.from('workspaces').select('sends_frozen_at').eq('id', workspaceId).maybeSingle();
  if (workspace?.sends_frozen_at) return refuse('sends_paused', 409, 'Sending is paused for this workspace, so nothing was approved.');

  const leftToday = new Map<string, number>();
  for (const inboxId of inboxIds) {
    const { data: brake } = await db.from('inbox_send_brakes').select('refusal_pause_until').eq('inbox_id', inboxId).maybeSingle();
    if (brake?.refusal_pause_until && Date.parse(brake.refusal_pause_until) > nowMs) {
      return refuse('sends_paused', 409, 'Sending from this inbox is paused for now, so nothing was approved. Try again later.');
    }
    // At most one row per send, under the 500 ceiling, so 1000 rows are plenty.
    const { data: sent } = await db
      .from('outbound_send_events')
      .select('messages')
      .eq('inbox_id', inboxId)
      .eq('kind', 'message')
      .gt('created_at', new Date(nowMs - 24 * 60 * 60 * 1000).toISOString())
      .limit(1000);
    const used = (sent ?? []).reduce((sum: number, row: any) => sum + (Number(row.messages) || 0), 0);
    leftToday.set(inboxId, Math.max(0, DAILY_SEND_LIMIT_PER_INBOX - used));
  }

  const outcomes: Array<{ id: string; outcome: RowOutcome }> = [];
  let approved = 0;
  for (const item of items) {
    const row = liveById.get(item.id);
    if (!row) {
      // Not a live row of this rule. Say why when the row can tell us; an id from
      // another rule or workspace reads the same as one already decided.
      const stale = (rows ?? []).find((candidate: any) => candidate.id === item.id);
      outcomes.push({ id: item.id, outcome: stale ? 'expired' : 'not_pending' });
      continue;
    }
    const left = leftToday.get(row.inbox_id) ?? 0;
    if (approved >= APPROVE_ALL_MAX || left <= 0) {
      outcomes.push({ id: item.id, outcome: 'left_waiting' });
      continue;
    }
    const decision = await decideApproval({
      db,
      approvalId: item.id,
      workspaceId,
      userId,
      decision: 'approve',
      via: 'dashboard',
      revision: item.revision,
      dispatchAt: new Date(nowMs + approved * APPROVE_ALL_PACE_SECONDS * 1000).toISOString(),
      kick: false,
    });
    if (decision.ok) {
      approved++;
      leftToday.set(row.inbox_id, left - 1);
      outcomes.push({ id: item.id, outcome: 'approved' });
    } else if (decision.code === 'expired' || decision.code === 'changed' || decision.code === 'not_pending') {
      outcomes.push({ id: item.id, outcome: decision.code });
    } else {
      outcomes.push({ id: item.id, outcome: 'failed' });
    }
  }
  if (approved > 0) await kickDispatch(db);
  return { ok: true, outcomes };
}

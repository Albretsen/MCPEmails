/**
 * What the /onboarding flow needs to know about a workspace, in one batch of
 * parallel reads. Served by GET /api/onboarding/status and streamed into the
 * first render of /onboarding (app/onboarding/page.tsx). Server only.
 *
 * Every "since reset" signal ignores what happened before
 * workspaces.onboarding_reset_at, so an internal account can run the flow again
 * after Settings > Reset onboarding without anything being deleted.
 *
 * THE SHAPE (OnboardingStatus, camelCase, ISO timestamps or null):
 *
 *   workspaceId     string
 *   serverTime      when this was read (compare timestamps against it, not the
 *                   browser clock)
 *   resetAt         last reset, or null
 *   completedAt     the flow was finished (POST /api/onboarding {completed})
 *   client          the stored chip choice (workspaces.onboarding_client) when
 *                   it is one the chip offers, else null
 *   inboxes         { count, sinceReset, chosenAt, items: [{ id, address,
 *                   provider, status, createdAt }] }  live inboxes, oldest
 *                   first, max 10. chosenAt: the inbox step was passed since
 *                   reset (workspaces.onboarding_inbox_connected_at: a new
 *                   inbox, or "Use <address>" after a reset), else null
 *   credential      { exists, sinceReset, latestAt, scopes }  a connector grant
 *                   or API key (api_keys.kind IS NULL: the web client's own key
 *                   is not one); scopes = the newest one's scopes (the prompt
 *                   step never offers a draft prompt to a read-only key)
 *   handshake       { at, client, clients: [{ client, name, firstSeen,
 *                   lastSeen }] }  MCP `initialize` seen (mcp_client_capabilities),
 *                   newest first, only rows seen since reset. `client` is the
 *                   chip id of the newest one (null when unknown).
 *   firstCall       { at, tool, client }  the first SUCCESSFUL call against a real
 *                   inbox (onboarding_value_activated_at: never inbox_list,
 *                   never a call without a resolved inbox), since reset.
 *                   `tool` is that call's tool from activity_log (the
 *                   earliest success with an inbox, not inbox_list, around
 *                   the marker), never the any-call tool name. `client` is
 *                   the chip id of the app that made that call (the newest
 *                   handshake on its API key), null when unknown
 *   anyCall         { at }  the first successful call of any kind
 *                   (analytics_first_tool_used_at), since reset
 *   lastFailure     { at, tool, code } | null  the newest failed tool call in
 *                   the last 24 hours and since reset (activity_log.status is
 *                   not 'success'; code is activity_log.error_code)
 *
 * Reads go through the CALLER's client (RLS), so a member can only ever read a
 * workspace they belong to. Five parallel reads, plus one small activity_log
 * read for firstCall.tool once the first real call has happened, and one
 * mcp_client_capabilities read for the app behind it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { chipClientFromHandshakeName, normalizeChipClient } from './clients.mjs';

type Db = SupabaseClient<Database>;

export interface OnboardingInboxItem {
  id: string;
  address: string;
  provider: string;
  status: string | null;
  createdAt: string;
}

export interface OnboardingHandshake {
  client: string | null;
  name: string;
  firstSeen: string;
  lastSeen: string;
}

export interface OnboardingStatus {
  workspaceId: string;
  serverTime: string;
  resetAt: string | null;
  completedAt: string | null;
  client: string | null;
  inboxes: { count: number; sinceReset: number; chosenAt: string | null; items: OnboardingInboxItem[] };
  credential: { exists: boolean; sinceReset: boolean; latestAt: string | null; scopes: string[] | null };
  handshake: { at: string | null; client: string | null; clients: OnboardingHandshake[] };
  firstCall: { at: string | null; tool: string | null; client: string | null };
  anyCall: { at: string | null };
  lastFailure: { at: string; tool: string; code: string | null } | null;
}

/** How far back a failed call still counts as "the last thing that went wrong". */
export const FAILURE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_INBOX_ITEMS = 10;

/** The raw rows, as the reads return them. Exported for the shaping tests. */
export interface OnboardingStatusRows {
  workspaceId: string;
  now: number;
  workspace: {
    onboarding_client: string | null;
    onboarding_reset_at: string | null;
    onboarding_completed_at: string | null;
    onboarding_inbox_connected_at?: string | null;
    onboarding_value_activated_at: string | null;
    analytics_first_tool_used_at: string | null;
    analytics_first_tool_name: string | null;
  } | null;
  inboxes: Array<{ id: string; email_address: string; provider: string; status: string | null; created_at: string }>;
  inboxCount: number | null;
  latestKey: { created_at: string; scopes?: string[] | null } | null;
  handshakes: Array<{ client_name: string; first_seen: string; last_seen: string }>;
  lastFailure: { created_at: string; tool_name: string; error_code: string | null } | null;
  /** The activating call (firstCallToolRead), when it was read. */
  firstCallTool?: string | null;
  /** The handshake client_name on the activating call's API key, when known. */
  firstCallClientName?: string | null;
}

function after(ts: string | null | undefined, floor: number | null): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return floor === null || t >= floor;
}

/**
 * firstCall.tool: the activating call read from activity_log, else the
 * any-call tool name when it is not inbox_list (the two are the same call
 * whenever the first call of all was a real-inbox one), else null.
 */
export function firstCallToolName(activating: string | null | undefined, anyCallTool: string | null): string | null {
  if (activating) return activating;
  return anyCallTool && anyCallTool !== 'inbox_list' ? anyCallTool : null;
}

/** activity_log rows within this much of the value marker can be the activating call. */
export const FIRST_CALL_WINDOW_MS = 2 * 60 * 1000;

/**
 * The window to look for the activating call in: from the later of the reset
 * and (marker - window) to (marker + window), or null when there is no marker
 * since reset. The marker is stamped after the call; its activity_log row may
 * land a little before or after it.
 */
export function firstCallWindow(valueActivatedAt: string | null | undefined, resetAt: string | null | undefined): { from: string; to: string } | null {
  const at = valueActivatedAt ? Date.parse(valueActivatedAt) : NaN;
  if (!Number.isFinite(at)) return null;
  const reset = resetAt ? Date.parse(resetAt) : NaN;
  if (Number.isFinite(reset) && at < reset) return null;
  const from = Math.max(at - FIRST_CALL_WINDOW_MS, Number.isFinite(reset) ? reset : -Infinity);
  return { from: new Date(from).toISOString(), to: new Date(at + FIRST_CALL_WINDOW_MS).toISOString() };
}

/** Pure: rows in, OnboardingStatus out. Applies every since-reset rule. */
export function shapeOnboardingStatus(rows: OnboardingStatusRows): OnboardingStatus {
  const ws = rows.workspace;
  const resetAt = ws?.onboarding_reset_at ?? null;
  const resetFloor = resetAt && Number.isFinite(Date.parse(resetAt)) ? Date.parse(resetAt) : null;

  const items: OnboardingInboxItem[] = rows.inboxes.slice(0, MAX_INBOX_ITEMS).map((row) => ({
    id: row.id,
    address: row.email_address,
    provider: row.provider,
    status: row.status ?? null,
    createdAt: row.created_at,
  }));
  const count = rows.inboxCount ?? rows.inboxes.length;
  const sinceReset = resetFloor === null ? count : rows.inboxes.filter((row) => after(row.created_at, resetFloor)).length;

  const handshakes = rows.handshakes
    .filter((row) => after(row.last_seen, resetFloor))
    .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
    .map((row) => ({
      client: chipClientFromHandshakeName(row.client_name),
      name: row.client_name,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    }));

  const failure = rows.lastFailure;
  const failureFloor = Math.max(rows.now - FAILURE_LOOKBACK_MS, resetFloor ?? -Infinity);
  const lastFailure = failure && after(failure.created_at, failureFloor)
    ? { at: failure.created_at, tool: failure.tool_name, code: failure.error_code ?? null }
    : null;

  const firstCallAt = after(ws?.onboarding_value_activated_at, resetFloor) ? ws!.onboarding_value_activated_at : null;
  const anyCallAt = after(ws?.analytics_first_tool_used_at, resetFloor) ? ws!.analytics_first_tool_used_at : null;

  return {
    workspaceId: rows.workspaceId,
    serverTime: new Date(rows.now).toISOString(),
    resetAt,
    completedAt: after(ws?.onboarding_completed_at, resetFloor) ? ws!.onboarding_completed_at : null,
    client: normalizeChipClient(ws?.onboarding_client ?? null),
    inboxes: { count, sinceReset, chosenAt: after(ws?.onboarding_inbox_connected_at, resetFloor) ? ws!.onboarding_inbox_connected_at! : null, items },
    credential: {
      exists: rows.latestKey !== null,
      sinceReset: after(rows.latestKey?.created_at, resetFloor),
      latestAt: rows.latestKey?.created_at ?? null,
      scopes: Array.isArray(rows.latestKey?.scopes) ? rows.latestKey.scopes : null,
    },
    handshake: { at: handshakes[0]?.lastSeen ?? null, client: handshakes[0]?.client ?? null, clients: handshakes },
    firstCall: {
      at: firstCallAt,
      tool: firstCallAt ? firstCallToolName(rows.firstCallTool, ws?.analytics_first_tool_name ?? null) : null,
      client: firstCallAt ? chipClientFromHandshakeName(rows.firstCallClientName ?? null) : null,
    },
    anyCall: { at: anyCallAt },
    lastFailure,
  };
}

/**
 * Read and shape. `db` should be the signed-in user's client (RLS scopes
 * every read to workspaces they belong to). Throws only when the workspace
 * row itself cannot be read; a failed side read degrades to "nothing yet".
 */
export async function loadOnboardingStatus(db: Db, workspaceId: string, now: number = Date.now()): Promise<OnboardingStatus> {
  const since = new Date(now - FAILURE_LOOKBACK_MS).toISOString();
  const [workspace, inboxes, latestKey, handshakes, lastFailure] = await Promise.all([
    db.from('workspaces')
      .select('onboarding_client, onboarding_reset_at, onboarding_completed_at, onboarding_inbox_connected_at, onboarding_value_activated_at, analytics_first_tool_used_at, analytics_first_tool_name')
      .eq('id', workspaceId)
      .maybeSingle(),
    db.from('inboxes')
      .select('id, email_address, provider, status, created_at', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(MAX_INBOX_ITEMS),
    db.from('api_keys')
      .select('created_at, scopes')
      .eq('workspace_id', workspaceId)
      .is('kind', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('mcp_client_capabilities')
      .select('client_name, first_seen, last_seen')
      .eq('workspace_id', workspaceId)
      .order('last_seen', { ascending: false })
      .limit(10),
    db.from('activity_log')
      .select('created_at, tool_name, error_code')
      .eq('workspace_id', workspaceId)
      .neq('status', 'success')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (workspace.error) throw new Error(`onboarding status: workspace read failed: ${workspace.error.message}`);
  for (const [name, result] of [['inboxes', inboxes], ['api_keys', latestKey], ['mcp_client_capabilities', handshakes], ['activity_log', lastFailure]] as const) {
    if (result.error) console.error(`[onboarding] status: ${name} read failed`, result.error.message);
  }
  // The activating call's tool (WP-Z m4): the earliest successful call on a
  // resolved inbox, never inbox_list, around the value marker.
  let firstCallTool: string | null = null;
  let firstCallClientName: string | null = null;
  const callWindow = firstCallWindow(workspace.data?.onboarding_value_activated_at, workspace.data?.onboarding_reset_at);
  if (callWindow) {
    const first = await db.from('activity_log')
      .select('tool_name, api_key_id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'success')
      .not('inbox_id', 'is', null)
      .neq('tool_name', 'inbox_list')
      .gte('created_at', callWindow.from)
      .lte('created_at', callWindow.to)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (first.error) console.error('[onboarding] status: first call read failed', first.error.message);
    else firstCallTool = first.data?.tool_name ?? null;
    // Which app made it: "It works" names that app, not the chip choice.
    const keyId = first.data?.api_key_id ?? null;
    if (keyId) {
      const caller = await db.from('mcp_client_capabilities')
        .select('client_name')
        .eq('workspace_id', workspaceId)
        .eq('api_key_id', keyId)
        .order('last_seen', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (caller.error) console.error('[onboarding] status: first call client read failed', caller.error.message);
      else firstCallClientName = caller.data?.client_name ?? null;
    }
  }
  return shapeOnboardingStatus({
    workspaceId,
    now,
    firstCallTool,
    firstCallClientName,
    workspace: workspace.data ?? null,
    inboxes: inboxes.error ? [] : (inboxes.data ?? []),
    inboxCount: inboxes.error ? 0 : (inboxes.count ?? null),
    latestKey: latestKey.error ? null : (latestKey.data ?? null),
    handshakes: handshakes.error ? [] : (handshakes.data ?? []),
    lastFailure: lastFailure.error ? null : (lastFailure.data ?? null),
  });
}

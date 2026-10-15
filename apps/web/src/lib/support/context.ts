/**
 * The diagnostic context attached to a signed-in ticket.
 *
 * /help shows the customer this exact object before they send ("what we
 * attach"), and the ticket API attaches the same object, so what they saw is
 * what we got. It is an allow-list: workspace id, plan, and for each
 * connected mailbox its provider, service, host, status and last error. NEVER
 * passwords, tokens, usernames, addresses or mail content: the select lists
 * below name the only columns read, and no other column can leak through.
 *
 * Reads with the service-role client, so membership is enforced here, not by
 * RLS: the workspace is one the user is a member of (the active-workspace
 * cookie when it is still theirs, else the earliest joined), the same rule as
 * resolveActiveWorkspaceId() in src/lib/workspace/active.ts.
 *
 * The server-only modules (next/headers, the service client) are imported
 * inside getTicketContextPreview() so the pure half of this file loads in a
 * bare `node --test` run.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';

export interface TicketMailbox {
  provider: string;
  service: string | null;
  host: string | null;
  status: string;
  last_error_code: string | null;
}

export interface TicketContext {
  workspace_id: string | null;
  plan: string | null;
  mailboxes: TicketMailbox[];
  from: string | null;
  provider: string | null;
  code: string | null;
}

export const EMPTY_TICKET_CONTEXT: TicketContext = {
  workspace_id: null,
  plan: null,
  mailboxes: [],
  from: null,
  provider: null,
  code: null,
};

const MAX_MAILBOXES = 20;
const MAX_ERROR_LENGTH = 120;

/**
 * `inboxes.last_error` is a short reason our own code wrote (an OAuth error
 * code, an IMAP status line). Kept, but one line, no control characters, and
 * capped, so the context block stays readable.
 */
export function toErrorCode(lastError: string | null | undefined): string | null {
  if (!lastError) return null;
  const v = lastError.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v) return null;
  return v.length > MAX_ERROR_LENGTH ? `${v.slice(0, MAX_ERROR_LENGTH - 1)}…` : v;
}

type InboxRow = {
  provider: string;
  service: string | null;
  imap_host: string | null;
  status: string;
  last_error: string | null;
};

/** Pure: rows in, context out. Exported for tests and for the route. */
export function buildTicketContext(
  base: { workspaceId: string | null; plan: string | null; inboxes: InboxRow[] },
  extra: { from?: string | null; provider?: string | null; code?: string | null } = {},
): TicketContext {
  return {
    workspace_id: base.workspaceId,
    plan: base.plan,
    mailboxes: base.inboxes.slice(0, MAX_MAILBOXES).map((row) => ({
      provider: row.provider,
      service: row.service,
      host: row.imap_host,
      status: row.status,
      last_error_code: toErrorCode(row.last_error),
    })),
    from: extra.from ?? null,
    provider: extra.provider ?? null,
    code: extra.code ?? null,
  };
}

async function preferredWorkspaceId(): Promise<string | null> {
  try {
    const [{ cookies }, { ACTIVE_WORKSPACE_COOKIE }] = await Promise.all([
      import('next/headers'),
      import('@/lib/workspace/active'),
    ]);
    return (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/** Exported for tests: the reads, against any client with the same shape. */
export async function loadTicketContext(
  service: SupabaseClient<Database>,
  userId: string,
  preferred: string | null,
): Promise<TicketContext> {
  const { data: memberships } = await service
    .from('workspace_members')
    .select('workspace_id, joined_at')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })
    .limit(50);
  const ids = (memberships ?? []).map((m) => m.workspace_id);
  const workspaceId = (preferred && ids.includes(preferred) ? preferred : ids[0]) ?? null;
  if (!workspaceId) return { ...EMPTY_TICKET_CONTEXT };

  const [{ data: workspace }, { data: inboxes }] = await Promise.all([
    service.from('workspaces').select('id, plan').eq('id', workspaceId).is('deleted_at', null).maybeSingle(),
    service
      .from('inboxes')
      .select('provider, service, imap_host, status, last_error')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(MAX_MAILBOXES),
  ]);
  if (!workspace) return { ...EMPTY_TICKET_CONTEXT };

  return buildTicketContext({ workspaceId: workspace.id, plan: workspace.plan, inboxes: inboxes ?? [] });
}

/**
 * The context for this user, as /help shows it and the ticket API stores it.
 * Never throws: a failed read yields an empty context, never a lost ticket.
 */
export async function getTicketContextPreview(userId: string): Promise<TicketContext> {
  try {
    const { createServiceRoleClient } = await import('@/lib/supabase/service');
    return await loadTicketContext(createServiceRoleClient(), userId, await preferredWorkspaceId());
  } catch (err) {
    console.error('[support] context read failed:', err instanceof Error ? err.message : String(err));
    return { ...EMPTY_TICKET_CONTEXT };
  }
}

/**
 * The diagnostic context attached to a signed-in ticket.
 *
 * /help shows the customer this exact object before they send ("what we
 * attach"), and the ticket API attaches the same object, so what they saw is
 * what we got. It is an allow-list: workspace id, plan, and for each
 * connected mailbox its address, provider, service, host, status, health and
 * last error. The address is the customer's own (support cannot tell five
 * inboxes on one host apart without it). NEVER passwords, tokens, usernames or
 * mail content: the select lists below name the only columns read, and no
 * other column can leak through.
 *
 * `health` is the mcp-server's rule (src/lib/inboxes/health.ts), so a row
 * that is 'active' but whose password the server refused reads "needs
 * reconnect" here exactly as AI clients are told.
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

import { getProvider } from '@/lib/connect/providers.mjs';
import { inboxHealth, lastErrorForDisplay, type InboxHealth } from '@/lib/inboxes/health';
import type { Database } from '@/types/database.types';

export interface TicketMailbox {
  email: string | null;
  provider: string;
  service: string | null;
  /** Display name for the provider or service: "Gmail", "Migadu", "IMAP". */
  service_name: string;
  host: string | null;
  status: string;
  health: InboxHealth;
  /** Raw, one line, for support. */
  last_error_code: string | null;
  /** For the customer: no "(Checked <time>)" suffix, shortened on a word. */
  last_error_text: string | null;
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
const MAX_ERROR_LENGTH = 200;
const MAX_ERROR_TEXT_LENGTH = 120;

/**
 * `inboxes.last_error` is a short reason our own code wrote (an OAuth error
 * code, an IMAP status line). Kept raw for support, timestamp included, but
 * one line, no control characters, and capped on a word boundary, so the
 * context block stays readable. 200 fits the login-refused marker whole.
 */
export function toErrorCode(lastError: string | null | undefined): string | null {
  if (!lastError) return null;
  const v = lastError.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v) return null;
  if (v.length <= MAX_ERROR_LENGTH) return v;
  const cut = v.slice(0, MAX_ERROR_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

/**
 * The name a customer knows a mailbox's provider by. `service` (the IMAP
 * preset slug) wins over `provider` for IMAP rows; the generic preset, and
 * anything the catalogue does not know, reads "IMAP".
 */
export function serviceDisplayName(provider: string | null | undefined, service?: string | null): string {
  const named = (slug: string | null | undefined) =>
    slug && !GENERIC_SLUGS.has(slug) ? ((getProvider(slug) as { name?: string } | null)?.name ?? null) : null;
  return named(service) ?? (provider ? PROVIDER_NAMES[provider] : undefined) ?? named(provider) ?? 'IMAP';
}

/** `inboxes.provider` values whose catalogue name is a narrower product ("Outlook.com"). */
const PROVIDER_NAMES: Record<string, string> = { gmail: 'Gmail', outlook: 'Outlook', fastmail: 'Fastmail' };
const GENERIC_SLUGS = new Set(['generic', 'imap', 'other']);

type InboxRow = {
  email_address?: string | null;
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
      email: row.email_address ?? null,
      provider: row.provider,
      service: row.service,
      service_name: serviceDisplayName(row.provider, row.service),
      host: row.imap_host,
      status: row.status,
      health: inboxHealth(row),
      last_error_code: toErrorCode(row.last_error),
      last_error_text: lastErrorForDisplay(row.last_error, MAX_ERROR_TEXT_LENGTH),
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
      .select('email_address, provider, service, imap_host, status, last_error')
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

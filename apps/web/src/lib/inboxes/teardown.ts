/**
 * What happens to a mailbox's grant and queued mail when it goes away.
 *
 * Three callers take inboxes away: a single disconnect (DELETE
 * /api/inboxes/[id]), a workspace delete (DELETE /api/workspaces/[id]) and an
 * account delete (DELETE /api/user/delete-account). Until 2026-10-30 only the
 * single disconnect revoked the Google grant, and none of them touched the
 * scheduled sends or held approvals queued for the inbox, which then either
 * failed at send time or, after a reconnect, went out after all.
 *
 * Everything here is best effort and never throws: a provider that is down, a
 * token that no longer decrypts or a database blip is logged, and the caller's
 * deletion goes ahead. Nothing is ever logged that identifies a token.
 *
 * Server-only: it decrypts stored credentials.
 */
import { decryptToken } from '@/lib/crypto';
import { selectAllRows } from '@/lib/supabase/paginate';

/** How long one Google revoke may take before it is abandoned. */
const REVOKE_TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Revokes a Google grant. Google's revocation endpoint revokes the whole grant
 * when given the refresh token (preferred) or just that access token.
 */
export async function revokeGoogleGrant(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  });
}

/**
 * Microsoft offers no token revocation endpoint; its tokens are invalidated
 * by expiry (1 hour). The logout endpoint is called for completeness only.
 */
export async function revokeOutlookToken(fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl('https://login.microsoftonline.com/common/oauth2/v2.0/logout', {
    method: 'GET',
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The slice of the service-role client these helpers use. */
type ServiceDb = { from: (table: string) => any };

/** Which inboxes: these ids, or every live inbox of these workspaces. */
export type InboxScope = { inboxIds: string[] } | { workspaceIds: string[] };

function scoped(query: any, scope: InboxScope): any {
  return 'inboxIds' in scope
    ? query.in('inbox_id', scope.inboxIds)
    : query.in('workspace_id', scope.workspaceIds);
}

function isEmpty(scope: InboxScope): boolean {
  return 'inboxIds' in scope ? scope.inboxIds.length === 0 : scope.workspaceIds.length === 0;
}

export interface RevokeSummary {
  attempted: number;
  failed: number;
}

/**
 * Revokes the Google grant of every live Gmail OAuth inbox in `workspaceIds`.
 * Must run BEFORE the caller nulls the stored tokens. App-password inboxes
 * (imap_host set) have no grant to revoke and are skipped.
 */
export async function revokeGmailGrantsForWorkspaces(
  db: ServiceDb,
  workspaceIds: string[],
  deps: { fetchImpl?: FetchLike; label?: string } = {},
): Promise<RevokeSummary> {
  const label = deps.label ?? 'inbox-teardown';
  if (workspaceIds.length === 0) return { attempted: 0, failed: 0 };

  let rows: Array<{
    id: string;
    imap_host: string | null;
    oauth_access_token: string | null;
    oauth_refresh_token: string | null;
  }>;
  try {
    const { data, error } = await selectAllRows<{
      id: string;
      imap_host: string | null;
      oauth_access_token: string | null;
      oauth_refresh_token: string | null;
    }>((from, to) =>
      db
        .from('inboxes')
        .select('id, imap_host, oauth_access_token, oauth_refresh_token')
        .in('workspace_id', workspaceIds)
        .eq('provider', 'gmail')
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (error) {
      console.error(`[${label}] Gmail grant lookup failed:`, error.message);
      return { attempted: 0, failed: 0 };
    }
    rows = data ?? [];
  } catch (err) {
    console.error(`[${label}] Gmail grant lookup failed:`, (err as Error).message);
    return { attempted: 0, failed: 0 };
  }

  const targets = rows.filter((r) => !r.imap_host && (r.oauth_refresh_token || r.oauth_access_token));
  const results = await Promise.allSettled(
    targets.map(async (row) => {
      const token = decryptToken((row.oauth_refresh_token ?? row.oauth_access_token) as string);
      await revokeGoogleGrant(token, deps.fetchImpl);
    }),
  );
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed += 1;
      console.error(
        `[${label}] Google revocation failed for inbox ${targets[i].id}:`,
        (result.reason as Error)?.message ?? 'unknown error',
      );
    }
  });
  return { attempted: targets.length, failed };
}

/**
 * Cancels the mail still queued for inboxes that are going away, and removes
 * the stored message from it:
 *   - pending scheduled_sends become 'cancelled' (a row already 'sending' is
 *     in flight and is left to finish);
 *   - pending send_approvals become 'expired', as a lapsed request would.
 * Without this, a queued send failed at send time, or went out after all if
 * the inbox was reconnected first.
 */
export async function cancelQueuedMail(
  db: ServiceDb,
  scope: InboxScope,
  label = 'inbox-teardown',
): Promise<void> {
  if (isEmpty(scope)) return;
  const now = new Date().toISOString();
  try {
    const [sends, approvals] = await Promise.all([
      scoped(
        db
          .from('scheduled_sends')
          .update({ status: 'cancelled', payload: {}, payload_encrypted: true, updated_at: now }),
        scope,
      ).eq('status', 'pending'),
      scoped(
        db
          .from('send_approvals')
          .update({ status: 'expired', decided_at: now, payload: {} }),
        scope,
      ).eq('status', 'pending'),
    ]);
    if (sends?.error) console.error(`[${label}] scheduled send cancel failed:`, sends.error.message);
    if (approvals?.error) console.error(`[${label}] held send expiry failed:`, approvals.error.message);
  } catch (err) {
    console.error(`[${label}] queued mail cancel failed:`, (err as Error).message);
  }
}

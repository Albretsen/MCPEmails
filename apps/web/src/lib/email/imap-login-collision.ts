import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { selectAllRows } from '@/lib/supabase/paginate';

/**
 * Workspace-scoped IMAP-login collision check (defense-in-depth).
 *
 * Incident context: a user connected `torstein@vikse.dev` (host
 * imap.domeneshop.no) but the IMAP login *username* field was autofilled with
 * `bonussok1` — the SASL login of a DIFFERENT mailbox (`hei@bonussok.no`)
 * already connected in the same workspace. Because `bonussok1` + its password
 * is a VALID login, credential validation passed and the connect routes saved
 * it, so reading `torstein@vikse.dev` actually returned the bonussok.no mailbox.
 *
 * The connect routes only verify "do these credentials authenticate"; they
 * never verify that the login isn't already bound to a different address. This
 * helper closes that gap: it rejects a connect when another active, non-deleted
 * inbox in the same workspace already uses the SAME IMAP server + SAME effective
 * login but a DIFFERENT email address.
 *
 * "Effective login" = the SASL username actually used to authenticate =
 * `imap_username || email_address`. The collision key is the tuple
 * `(imap_host, lower(effective_login))`.
 *
 * Note: a plain RE-connect of the same address is never blocked — the query
 * filters out rows whose email_address equals the address being connected.
 *
 * The effective-login comparison is done in JS (rather than a SQL
 * coalesce/ilike combo) to avoid depending on that SQL shape; host equality +
 * workspace filter already narrows the candidate set to a handful of rows.
 */
export async function findConflictingInbox(
  // Pass a client that can read ALL inboxes in the workspace. Routes hand us the
  // service-role `db` instance they already build for the upsert, so the read
  // is not subject to RLS and reliably sees every workspace row.
  db: SupabaseClient<Database>,
  workspaceId: string,
  params: { host: string; effectiveLogin: string; email: string },
): Promise<{ conflict: true; address: string } | { conflict: false }> {
  const host = params.host.toLowerCase().trim();
  const effectiveLogin = params.effectiveLogin.toLowerCase().trim();
  const email = params.email.toLowerCase().trim();

  // Narrow on the cheap, indexable predicates; do the effective-login equality
  // in JS below. `email_address <> email` excludes the same-address reconnect.
  //
  // Paged, not a plain select: PostgREST silently truncates an unpaged result at
  // `db-max-rows` (1000) with no error, and a guard that scans the rows it was
  // handed would then skip the colliding candidate and wave the connect through.
  // A security check must never depend on the candidate set staying small.
  const { data, error } = await selectAllRows<{
    email_address: string;
    imap_username: string | null;
  }>((from, to) =>
    db
      .from('inboxes')
      .select('email_address, imap_username')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .eq('imap_host', host)
      .neq('email_address', email)
      // Total order: OFFSET paging over an unordered read may repeat or skip
      // rows between pages, and a skipped row here is a missed collision.
      .order('id', { ascending: true })
      .range(from, to),
  );

  // Scan whatever was read before deciding what a read error means. selectAllRows
  // returns the pages it completed alongside the error, so a failure on page 2
  // still carries page 1, and a collision found there is a real row that really
  // exists: acting on it costs nothing in false positives and is the whole point
  // of the guard. Checking first and failing open second is therefore strictly
  // better than discarding evidence already in hand.
  for (const row of data) {
    const rowLogin = (row.imap_username || row.email_address).toLowerCase().trim();
    if (rowLogin === effectiveLogin) {
      return { conflict: true, address: row.email_address };
    }
  }

  // No collision in what we could read. If `error` is set the candidate set was
  // incomplete, and we still fail open: a read error must not break a legitimate
  // connect. The unique (workspace_id, email_address) constraint and credential
  // validation remain in force; this check is an extra guard, not the only one.
  if (error) {
    console.error('[imap-login-collision] partial read, failing open', error);
  }
  return { conflict: false };
}

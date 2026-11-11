/**
 * Who may see and use an inbox (the Business privacy model, migration
 * 20261111120000_inbox_owner_visibility).
 *
 *   user U may use inbox I  <=>  U is a member of I's live workspace
 *                                AND (I.visibility = 'company' OR I.owner_user_id = U)
 *
 * RLS enforces this for the user-session client. Service-role clients bypass
 * RLS, so every service-role route that takes an inbox id or lists inboxes
 * asks these helpers instead. Every helper fails CLOSED: an RPC error reads
 * as "not visible".
 *
 * Workspace owners and admins may still see the METADATA of every inbox (the
 * `workspace_inbox_directory` RPC) and may disconnect any of them, but they do
 * not get the row itself for someone else's private inbox.
 */

export type InboxVisibility = 'private' | 'company';

export interface VisibilityRow {
  visibility?: string | null;
  owner_user_id?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export function isInboxVisibility(value: unknown): value is InboxVisibility {
  return value === 'private' || value === 'company';
}

/**
 * For a row already loaded with `visibility` and `owner_user_id`. Workspace
 * membership is the caller's job (the row was read scoped to a workspace the
 * user belongs to). Select both columns: a row without them reads as not
 * visible (fails closed).
 */
export function isInboxVisibleTo(row: VisibilityRow | null | undefined, userId: string | null | undefined): boolean {
  if (!row || !userId) return false;
  return row.visibility === 'company' || (row.owner_user_id != null && row.owner_user_id === userId);
}

/** Does `userId` own this inbox (and so may change its visibility)? */
export function ownsInbox(row: VisibilityRow | null | undefined, userId: string | null | undefined): boolean {
  return Boolean(row && userId && row.owner_user_id && row.owner_user_id === userId);
}

/** inbox_visible_to(): membership + visibility in one call. False on any error. */
export async function canAccessInbox(db: Db, inboxId: string, userId: string): Promise<boolean> {
  if (!inboxId || !userId) return false;
  try {
    const { data, error } = await db.rpc('inbox_visible_to', { p_inbox_id: inboxId, p_user_id: userId });
    if (error) {
      console.error('[inbox-visibility] inbox_visible_to failed:', error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error('[inbox-visibility] inbox_visible_to threw:', (err as Error).message);
    return false;
  }
}

/**
 * visible_inbox_ids(): every inbox id in the workspace the user may see. An
 * empty set on any error, so a caller filtering by it shows nothing rather
 * than everything.
 */
export async function visibleInboxIds(db: Db, workspaceId: string, userId: string): Promise<Set<string>> {
  if (!workspaceId || !userId) return new Set();
  try {
    const { data, error } = await db.rpc('visible_inbox_ids', { p_workspace_id: workspaceId, p_user_id: userId });
    if (error) {
      console.error('[inbox-visibility] visible_inbox_ids failed:', error.message);
      return new Set();
    }
    return new Set(Array.isArray(data) ? (data as string[]).map((id) => String(id).toLowerCase()) : []);
  } catch (err) {
    console.error('[inbox-visibility] visible_inbox_ids threw:', (err as Error).message);
    return new Set();
  }
}

/** True when every id is in `visible` (ids compared case-insensitively). */
export function allVisible(ids: readonly string[], visible: Set<string>): boolean {
  return ids.every((id) => visible.has(String(id).toLowerCase()));
}

/**
 * Before a connect route writes (workspace_id, email_address): is there a
 * LIVE inbox with that address that this user may not see? The upsert would
 * otherwise overwrite another person's credentials on their private inbox.
 * A soft-deleted row is a fresh connection (the DB trigger hands it to the new
 * owner and makes it private again), so it never blocks.
 *
 * `exists` says whether a live row is there at all, read with the service
 * role so a hidden row still counts (the plan cap and reconnect logic need the
 * true answer, not the RLS-filtered one).
 */
export type ConnectTarget =
  | { ok: true; exists: boolean }
  | { ok: false; reason: 'owned_by_other' | 'unavailable' };

export async function checkConnectTarget(
  db: Db,
  workspaceId: string,
  email: string,
  userId: string,
): Promise<ConnectTarget> {
  try {
    const { data, error } = await db
      .from('inboxes')
      .select('id, owner_user_id, visibility')
      .eq('workspace_id', workspaceId)
      .eq('email_address', email)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      console.error('[inbox-visibility] connect target lookup failed:', error.message);
      return { ok: false, reason: 'unavailable' };
    }
    if (!data) return { ok: true, exists: false };
    if (!isInboxVisibleTo(data, userId)) return { ok: false, reason: 'owned_by_other' };
    return { ok: true, exists: true };
  } catch (err) {
    console.error('[inbox-visibility] connect target lookup threw:', (err as Error).message);
    return { ok: false, reason: 'unavailable' };
  }
}

/** The one-line refusal every connect route returns for `owned_by_other`. */
export const INBOX_OWNED_BY_OTHER_CODE = 'inbox_owned_by_other';
export function inboxOwnedByOtherBody(): { error: string; error_code: string } {
  return {
    error: 'Someone else in this workspace has already connected this address as a private mailbox.',
    error_code: INBOX_OWNED_BY_OTHER_CODE,
  };
}

/**
 * The refusal for the Business per-person private mailbox cap
 * (src/lib/plans/check-private-inbox-limit.ts). Its own code, not
 * `inbox_limit_reached`: upgrading does not lift it, making a mailbox
 * company-wide does, so the dashboard must not open the upgrade panel.
 */
export const PRIVATE_INBOX_LIMIT_CODE = 'private_inbox_limit_reached';
export function privateInboxLimitErrorBody(result: { currentCount: number; maxPrivateInboxes: number | null }): {
  error: string;
  error_code: string;
  current_count: number;
  max_private_inboxes: number;
} {
  const max = result.maxPrivateInboxes ?? 0;
  return {
    error: `Private mailbox limit reached: each person can keep ${max} private mailboxes. Make one company-wide to connect another.`,
    error_code: PRIVATE_INBOX_LIMIT_CODE,
    current_count: result.currentCount,
    max_private_inboxes: max,
  };
}

/** One row of workspace_inbox_directory(). */
export interface DirectoryRow {
  id: string;
  email_address: string;
  display_name: string | null;
  provider: string;
  service: string | null;
  status: string;
  visibility: string;
  owner_user_id: string | null;
  owner_email: string | null;
  owner_display_name: string | null;
  parked_at: string | null;
  created_at: string;
  can_access: boolean;
}

/**
 * The metadata rows an owner/admin sees for inboxes they cannot open. Empty
 * for anyone else, and on any error (the RPC itself returns hidden rows only
 * to owners and admins).
 */
export async function hiddenInboxDirectory(supabase: Db, workspaceId: string): Promise<DirectoryRow[]> {
  try {
    const { data, error } = await supabase.rpc('workspace_inbox_directory', { p_workspace_id: workspaceId });
    if (error || !Array.isArray(data)) return [];
    return (data as DirectoryRow[]).filter((row) => row.can_access === false);
  } catch {
    return [];
  }
}

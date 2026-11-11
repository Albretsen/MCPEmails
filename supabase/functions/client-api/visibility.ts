// ---------------------------------------------------------------------------
// Inbox visibility (the Business privacy model), as client-api enforces it.
//
//   a user U may see and use inbox I  <=>  U is a member of I's (live)
//   workspace AND (I.visibility = 'company' OR I.owner_user_id = U)
//
// Migration 20261111190000_inbox_owner_visibility defines the rule and puts it
// in RLS. client-api runs as the service role, so RLS does not protect it: the
// rule is applied here, per (user, workspace), as an `InboxScope`:
//
//   { restricted: false }           nothing in the workspace is hidden from
//                                   this user (every single-member workspace,
//                                   and every workspace where all inboxes are
//                                   company-wide). The key keeps inbox_ids null,
//                                   exactly as before this model existed.
//   { restricted: true, ids: [...] } exactly these inboxes; [] reaches nothing.
//
// The scope comes from the membership load when it carried the inbox ACL
// (store.ts, same round trip), else from `credential_inbox_scope` (one RPC,
// cached per user and workspace). A failed read is never "unrestricted":
// the request is refused.
// ---------------------------------------------------------------------------

export type InboxScope =
  | { restricted: false }
  | { restricted: true; ids: readonly string[] };

/**
 * An inbox id no row can have. Executors treat `inbox_ids: []` as "no
 * allow-list" in several places, so "reach nothing" is this one-element list.
 */
export const NO_INBOX_ID = "00000000-0000-0000-0000-000000000000";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nothing visible: a removed member, or a failed shape check. */
export const NOTHING: InboxScope = { restricted: true, ids: [] };

export function scopeAllows(scope: InboxScope, inboxId: string): boolean {
  if (!scope.restricted) return true;
  const id = inboxId.toLowerCase();
  return scope.ids.includes(id);
}

/** What the executor's key carries as `inbox_ids` for this scope. */
export function keyInboxIds(scope: InboxScope): string[] | null {
  if (!scope.restricted) return null;
  return scope.ids.length > 0 ? [...scope.ids] : [NO_INBOX_ID];
}

export interface InboxAclRow {
  id: string;
  workspace_id?: string;
  visibility?: unknown;
  owner_user_id?: unknown;
}

/**
 * The scope for `userId`, from every live inbox row of ONE workspace the user
 * is a member of (the caller guarantees the membership). Null when the rows do
 * not carry the ACL columns, so the caller falls back to the RPC rather than
 * guessing.
 */
export function scopeFromAcl(rows: readonly InboxAclRow[], userId: string): InboxScope | null {
  const user = userId.toLowerCase();
  const visible: string[] = [];
  let hidden = 0;
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.visibility !== "string") return null;
    const owner = typeof row.owner_user_id === "string" ? row.owner_user_id.toLowerCase() : null;
    if (row.visibility === "company" || owner === user) visible.push(row.id.toLowerCase());
    else hidden++;
  }
  return hidden === 0 ? { restricted: false } : { restricted: true, ids: visible };
}

/** `credential_inbox_scope(...)`'s jsonb. Anything unexpected reaches nothing. */
export function parseCredentialScope(data: unknown): InboxScope {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") return NOTHING;
  const { restricted, inbox_ids } = value as { restricted?: unknown; inbox_ids?: unknown };
  if (restricted === false) return { restricted: false };
  if (restricted !== true || !Array.isArray(inbox_ids)) return NOTHING;
  return {
    restricted: true,
    ids: inbox_ids.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)).map((id) => id.toLowerCase()),
  };
}

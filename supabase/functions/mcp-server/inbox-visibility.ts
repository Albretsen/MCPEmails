/**
 * Inbox visibility for credentials (the Business privacy model).
 *
 * A user may use an inbox iff they are a member of its workspace AND the inbox
 * is company-wide or they own it (migration 20261111190000). The MCP server
 * runs as the service role, so RLS does not apply here: the rule is enforced by
 * narrowing the credential's `inbox_ids` allow-list once per request, right
 * after authentication. Every resolver already honours `inbox_ids`, so every
 * tool that takes or lists an inbox inherits the rule.
 *
 * An API key acts as its creator (`api_keys.created_by`); an OAuth grant is an
 * api_keys row whose `created_by` is the granting user. `credential_inbox_scope`
 * (SQL) treats a null creator as the workspace owner.
 *
 * Fails CLOSED: any error reading the scope yields a key that reaches nothing.
 */

/**
 * Matches no inbox. Used instead of `[]` because several resolvers read an
 * empty allow-list as "no filter".
 */
export const NO_INBOX_ID = "00000000-0000-0000-0000-000000000000";

export interface CredentialScope {
  restricted: boolean;
  inbox_ids: string[] | null;
}

/** Parse the jsonb answer of `credential_inbox_scope`; null when malformed. */
export function parseCredentialScope(raw: unknown): CredentialScope | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.restricted !== "boolean") return null;
  const ids = r.inbox_ids;
  if (ids === null || ids === undefined) {
    // An unrestricted scope may carry the key's own null allow-list. A
    // restricted one must always name its list.
    return r.restricted ? null : { restricted: false, inbox_ids: null };
  }
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return null;
  return { restricted: r.restricted, inbox_ids: ids as string[] };
}

/**
 * The `inbox_ids` the request must use. `scope` null (read failed or
 * malformed) reaches nothing. Unrestricted keeps the key's own list untouched,
 * which is every single-member workspace and every workspace with nothing
 * private in it.
 */
export function effectiveInboxIds(
  keyInboxIds: string[] | null,
  scope: CredentialScope | null,
): string[] | null {
  if (!scope) return [NO_INBOX_ID];
  if (!scope.restricted) return keyInboxIds;
  const ids = scope.inbox_ids ?? [];
  return ids.length > 0 ? ids : [NO_INBOX_ID];
}

// deno-lint-ignore no-explicit-any
type Db = any;

/** Read the scope for one credential. Never throws; null on any failure. */
export async function readCredentialScope(
  db: Db,
  workspaceId: string,
  userId: string | null | undefined,
  keyInboxIds: string[] | null,
): Promise<CredentialScope | null> {
  try {
    const { data, error } = await db.rpc("credential_inbox_scope", {
      p_workspace_id: workspaceId,
      p_user_id: userId ?? null,
      p_inbox_ids: keyInboxIds,
    });
    if (error) {
      console.error("[mcp-server] credential_inbox_scope_failed", {
        workspace_id: workspaceId,
        error: error.message,
      });
      return null;
    }
    return parseCredentialScope(data);
  } catch (e) {
    console.error("[mcp-server] credential_inbox_scope_failed", {
      workspace_id: workspaceId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * For unattended work (scheduled sends, automations, reminders, briefs): may
 * the credential `apiKeyId` still reach `inboxId`? Reads the key's creator,
 * then the scope. False on any failure, a deleted key, or a hidden inbox.
 */
export async function credentialCanReachInbox(
  db: Db,
  apiKeyId: string | null | undefined,
  workspaceId: string,
  inboxId: string,
  /**
   * The person the stored row says it acts as (scheduled_sends / reminders
   * `created_by`), when set. Wins over the key's creator: a web mail client
   * request runs on the workspace's shared key, whose creator is null (the
   * workspace owner), and records the signed-in member here. The key's own
   * inbox allow-list still applies.
   */
  actingUserId?: string | null,
): Promise<boolean> {
  if (!apiKeyId) return false;
  try {
    const { data: key, error } = await db
      .from("api_keys")
      .select("workspace_id, created_by, inbox_ids")
      .eq("id", apiKeyId)
      .maybeSingle();
    if (error || !key || key.workspace_id !== workspaceId) return false;
    const scope = await readCredentialScope(db, workspaceId, actingUserId ?? key.created_by ?? null, key.inbox_ids ?? null);
    return inboxAllowed(effectiveInboxIds(key.inbox_ids ?? null, scope), inboxId);
  } catch {
    return false;
  }
}

/**
 * For a user (no key): may `userId` reach `inboxId` in `workspaceId`?
 * Same rule, same fail-closed behaviour.
 */
export async function userCanReachInbox(
  db: Db,
  workspaceId: string,
  userId: string | null | undefined,
  inboxId: string,
): Promise<boolean> {
  const scope = await readCredentialScope(db, workspaceId, userId ?? null, null);
  return inboxAllowed(effectiveInboxIds(null, scope), inboxId);
}

/** Does an effective allow-list admit `inboxId`? null = every inbox. */
export function inboxAllowed(ids: string[] | null, inboxId: string): boolean {
  if (ids === null || ids.length === 0) return true;
  return ids.includes(inboxId);
}

export interface InboxAudienceRow {
  id: string;
  visibility?: string | null;
  owner_user_id?: string | null;
}

/**
 * Which inboxes may a digest delivered INTO `target` describe? Whoever can read
 * the target must already be able to see every inbox it summarises:
 *   - a company-wide target is read by every member: company-wide inboxes only;
 *   - a private target is read by its owner: company-wide plus their own.
 * A target with no owner, or an unknown visibility, describes only itself.
 */
export function inboxesVisibleToAudienceOf<T extends InboxAudienceRow>(target: InboxAudienceRow, rows: T[]): T[] {
  if (target.visibility === "company") return rows.filter((r) => r.visibility === "company");
  if (target.visibility === "private" && target.owner_user_id) {
    return rows.filter((r) => r.visibility === "company" || r.owner_user_id === target.owner_user_id);
  }
  return rows.filter((r) => r.id === target.id);
}

/**
 * The scope looked up by the bearer key's hash (`credential_inbox_scope_for_key`),
 * so it can be asked in parallel with authentication. The answer is used only
 * when its `key_id` is the key authentication accepted; otherwise, or on any
 * failure, null (fail closed).
 */
export async function readCredentialScopeForKey(
  db: Db,
  keyHash: string,
): Promise<{ keyId: string; scope: CredentialScope } | null> {
  try {
    const { data, error } = await db.rpc("credential_inbox_scope_for_key", { p_key_hash: keyHash });
    if (error) {
      console.error("[mcp-server] credential_inbox_scope_failed", { error: error.message });
      return null;
    }
    const keyId = data && typeof data === "object" ? (data as Record<string, unknown>).key_id : null;
    const scope = parseCredentialScope(data);
    if (typeof keyId !== "string" || !scope) return null;
    return { keyId, scope };
  } catch (e) {
    console.error("[mcp-server] credential_inbox_scope_failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** The scope for `keyId` out of a by-hash answer, or null when it is for another key. */
export function scopeForKey(
  answer: { keyId: string; scope: CredentialScope } | null,
  keyId: string,
): CredentialScope | null {
  return answer && answer.keyId === keyId ? answer.scope : null;
}

/**
 * The key an approved send dispatches with. A key nobody minted (created_by
 * null: the web mail client's shared key) acts as the approval's requester,
 * the person whose request was held; a minted key always acts as its creator.
 */
export function approvalActingKey<K extends { created_by?: string | null }>(key: K, requestedBy: unknown): K {
  if (key.created_by) return key;
  if (typeof requestedBy !== "string" || !requestedBy) return key;
  return { ...key, created_by: requestedBy };
}

/**
 * How many mailboxes in the workspace are private to someone other than
 * `userId`. Read only when a credential reaches no mailbox at all, so the
 * answer can say "your teammates have private mailboxes" instead of the
 * first-run "no mailbox is connected", which is false for a Business owner
 * whose colleagues connected theirs privately. Counts active and errored rows,
 * not parked or deleted ones. Never throws; 0 on any failure, which keeps the
 * first-run answer.
 */
export async function countTeammatePrivateInboxes(
  db: Db,
  workspaceId: string,
  userId: string | null | undefined,
): Promise<number> {
  try {
    let q = db
      .from("inboxes")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("visibility", "private")
      .is("deleted_at", null)
      .is("parked_at", null)
      .in("status", ["active", "error"])
      .not("owner_user_id", "is", null);
    if (userId) q = q.neq("owner_user_id", userId);
    const { count, error } = await q;
    if (error) return 0;
    return typeof count === "number" && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/**
 * The answer when the caller reaches no mailbox but teammates own private
 * ones. Says what is there, that only their owners can use them, and the two
 * ways forward: connect your own, or ask the owner or an admin to make one
 * company-wide.
 */
export function teammatePrivateInboxesMessage(count: number, setupUrl: string): string {
  const what = count === 1
    ? "This workspace has 1 private mailbox, owned by a teammate. Only its owner can use it"
    : `This workspace has ${count} private mailboxes, owned by teammates. Only their owners can use them`;
  return (
    `${what}, so there is no mailbox you can read or send from yet. Tell the user this ` +
    "and give them two options: connect their own mailbox at the setup_url (render it " +
    "as a clickable link), or ask the teammate who owns a mailbox, or a workspace admin, " +
    "to make it company-wide in the dashboard under Inboxes. Once either is done, call " +
    "inbox_list again."
  );
}

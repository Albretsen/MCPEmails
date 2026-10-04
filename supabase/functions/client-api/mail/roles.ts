// ---------------------------------------------------------------------------
// `folders[].role`: which folder is the Inbox, Sent, Drafts, Trash, Archive
// and Spam of this mailbox.
//
// The tool layer's `folder_list` returns ids and names only. An Outlook id is
// opaque and its names are localised ("Gesendete Elemente"), an IMAP server
// may call its trash anything, so the client could not tell which entry to put
// the Sent icon on. This adds `role` to each entry of the client-api `folders`
// result and nothing else; MCP `folder_list` output is untouched (the role is
// computed here, after the executor has answered).
//
//   role: "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam" | null
//
// At most one folder carries each role. A role is the folder the SAME alias
// resolves to in `list` / `status` / `search` ("sent", "trash", ...), so
// `list { folder: "trash" }` and the entry with `role: "trash"` are always the
// same folder:
//
//   IMAP     the tool layer's own matcher (`resolveImapAlias`) over the LIST
//            reply: the SPECIAL-USE attribute when the server sends one
//            (\Sent \Drafts \Trash \Junk \Archive), else the names it knows.
//            `archive` on a mailbox with no archive of its own is the folder
//            flagged \All (Gmail's All Mail), as it is for a read. A role two
//            folders could equally claim is given to neither.
//   Gmail    the system labels INBOX, SENT, DRAFT, TRASH, SPAM. No label is
//            the archive (archiving removes INBOX), so no entry has that role.
//   Outlook  Graph's well-known folder names (inbox, sentitems, drafts,
//            deleteditems, archive, junkemail), looked up once per inbox and
//            remembered: they are ids, and ids do not move.
//
// Never fails the op: a role that cannot be determined is null.
// ---------------------------------------------------------------------------

import { CANONICAL_FOLDER_ALIASES, resolveImapAlias } from "../../mcp-server/imap-folder-target.ts";
import { graphFetch } from "../../mcp-server/outlook-graph.ts";
import type { ApiKeyRow, InboxRow, McpSeam } from "../seam.ts";

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam";

export const FOLDER_ROLES: readonly FolderRole[] = ["inbox", "sent", "drafts", "trash", "archive", "spam"];

/** Graph well-known folder name per role. */
export const OUTLOOK_WELL_KNOWN: Record<FolderRole, string> = Object.fromEntries(
  CANONICAL_FOLDER_ALIASES.map((alias) => [alias.aliases[0], alias.outlook]),
) as Record<FolderRole, string>;

const GMAIL_LABEL_ROLE: Record<string, FolderRole> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  TRASH: "trash",
  SPAM: "spam",
};

/** Folder id -> role for an IMAP mailbox list. Pure. */
export function imapFolderRoles(
  mailboxes: Array<{ name: string; flags: string[]; delimiter?: string }>,
): Map<string, FolderRole> {
  const roles = new Map<string, FolderRole>();
  for (const alias of CANONICAL_FOLDER_ALIASES) {
    const role = alias.aliases[0] as FolderRole;
    const match = resolveImapAlias(mailboxes, alias, { forRead: true });
    if (match.kind !== "matched") continue;
    // "INBOX" is reserved and case-insensitive: answer with the listed spelling.
    const listed = role === "inbox"
      ? mailboxes.find((mb) => mb.name.toUpperCase() === "INBOX")?.name ?? match.name
      : match.name;
    if (!roles.has(listed)) roles.set(listed, role);
  }
  return roles;
}

/** Outlook well-known folder ids, per inbox. Ids are stable, so this is kept for the isolate's life (bounded). */
const outlookRoleIds = new Map<string, { roles: Map<string, FolderRole>; complete: boolean; at: number }>();
const OUTLOOK_ROLE_TTL_MS = 60 * 60_000;

export function forgetOutlookRolesForTests(): void {
  outlookRoleIds.clear();
}

async function outlookFolderRoles(mcp: McpSeam, inbox: InboxRow, now: number): Promise<Map<string, FolderRole>> {
  const hit = outlookRoleIds.get(inbox.id);
  if (hit && hit.complete && now - hit.at < OUTLOOK_ROLE_TTL_MS) return hit.roles;
  const token = await mcp.withFreshOutlookToken(inbox);
  const roles = new Map<string, FolderRole>();
  let complete = true;
  // Three at a time: Exchange allows four concurrent requests per mailbox.
  const pending = [...FOLDER_ROLES];
  const worker = async (): Promise<void> => {
    for (let role = pending.shift(); role !== undefined; role = pending.shift()) {
      try {
        const resp = await graphFetch(token, `/me/mailFolders/${OUTLOOK_WELL_KNOWN[role]}?$select=id`);
        if (!resp.ok) {
          await resp.body?.cancel().catch(() => {});
          // 404: this mailbox has no such folder (an account without an
          // archive). That is an answer; anything else is not.
          if (resp.status !== 404) complete = false;
          continue;
        }
        const id = (await resp.json() as { id?: unknown }).id;
        if (typeof id === "string" && id && !roles.has(id)) roles.set(id, role);
      } catch {
        complete = false;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (outlookRoleIds.size > 2000) outlookRoleIds.clear();
  outlookRoleIds.set(inbox.id, { roles, complete, at: now });
  return roles;
}

/**
 * The ids of this Outlook mailbox's folders with one of `roles` (the `thread`
 * op leaves Deleted Items, Junk and Drafts out of a conversation). Served from
 * the remembered well-known ids when the `folders` op has run in this isolate.
 */
export async function outlookRoleFolderIds(
  mcp: McpSeam,
  inbox: InboxRow,
  now: number,
  roles: readonly FolderRole[],
): Promise<Set<string>> {
  const all = await outlookFolderRoles(mcp, inbox, now);
  const out = new Set<string>();
  for (const [id, role] of all) if (roles.includes(role)) out.add(id);
  return out;
}

/**
 * The `folders` result with `role` on every entry. Must run inside
 * `firstPartyContext.run` (the IMAP branch asks the pooled connection for the
 * folder list it has just remembered: no extra round trip).
 */
export async function withFolderRoles(
  mcp: McpSeam,
  apiKey: ApiKeyRow,
  inboxId: string,
  result: unknown,
  now: number = Date.now(),
): Promise<unknown> {
  const body = result as { folders?: unknown } | null;
  if (!body || !Array.isArray(body.folders)) return result;
  const folders = body.folders as Array<Record<string, unknown>>;
  let roles = new Map<string, FolderRole>();
  try {
    const inbox = await mcp.resolveInbox(inboxId, apiKey);
    if (inbox?.provider === "gmail") {
      for (const folder of folders) {
        const role = GMAIL_LABEL_ROLE[String(folder["id"])];
        if (role) roles.set(String(folder["id"]), role);
      }
    } else if (inbox?.provider === "outlook") {
      roles = await outlookFolderRoles(mcp, inbox, now);
    } else if (inbox) {
      const session = mcp.imapSessionFor(inbox);
      if (session) {
        try {
          roles = imapFolderRoles(await (await session.client()).listMailboxes());
        } finally {
          await session.close().catch(() => {});
        }
      }
    }
  } catch {
    // The listing itself succeeded; it goes out without roles.
  }
  return { ...body, folders: folders.map((folder) => ({ ...folder, role: roles.get(String(folder["id"])) ?? null })) };
}

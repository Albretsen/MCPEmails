import { type FolderRef, type MailboxScope, type MessageKey, folderRefId } from "../api/types";

/** What a message-list query is a list OF. Stored in the query key so cache
 *  updaters can tell which lists a change belongs to. */
export interface ListMeta {
  scope: MailboxScope;
  /** folderRefId of the folder. */
  folder: string;
  /** Empty for a folder listing; set for a search (which ignores `folder`). */
  query: string;
}

export function listMeta(scope: MailboxScope, folder: FolderRef, query = ""): ListMeta {
  const q = query.trim();
  return { scope, folder: q ? "" : folderRefId(folder), query: q };
}

export const keys = {
  inboxes: ["inboxes"] as const,
  foldersRoot: ["folders"] as const,
  folders: (inbox_id: string) => ["folders", inbox_id] as const,
  messagesRoot: ["messages"] as const,
  messages: (meta: ListMeta) => ["messages", meta] as const,
  messageRoot: ["message"] as const,
  message: (key: MessageKey) => ["message", key] as const,
  draftsRoot: ["drafts"] as const,
  drafts: (inbox_id: string) => ["drafts", inbox_id] as const,
  draft: (inbox_id: string, draft_id: string) => ["draft", inbox_id, draft_id] as const,
  scheduled: ["scheduled"] as const,
  contacts: (query: string) => ["contacts", query] as const,
  allowance: ["allowance"] as const,
};

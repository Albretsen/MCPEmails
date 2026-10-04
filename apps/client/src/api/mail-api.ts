/* MailApi: the one seam between the UI and the mailbox backend.
 *
 * HOW TO SWAP THE MOCK FOR THE REAL BACKEND
 * 1. Fill in `api/http/http-mail-api.ts`. Every method there names the MCP tool
 *    (and action + args) it must call; the wire types in `api/types.ts` already
 *    match the backend's result shapes, so most methods are a pass-through plus
 *    `toRow()` to attach `key` / `inbox_id` / `folder_role`.
 * 2. In `api/index.ts`, return `new HttpMailApi(...)` from `getMailApi()` (and
 *    the real transport from `getAssistantTransport()`).
 * Nothing else changes: hooks, stores and panes only ever import from
 * `api/index.ts` and `api/types.ts`.
 *
 * Rules every implementation must keep (they are backend facts):
 * - Every backend call is per inbox. A scope of 'all' is a client-side merge
 *   across inboxes sorted by date: use `mergeInboxPages` from `api/merge.ts`.
 * - Pagination is offset based per inbox (`PageCursor` = one offset per inbox).
 * - Folders are addressed by id or by alias inbox|sent|drafts|trash|archive|spam.
 *   `starred` is a flagged search and `scheduled` is the schedule list; the
 *   implementation maps those two roles so callers can list any FolderRole.
 * - `readMessage` never marks the message read. Call `setFlags`.
 * - `updateDraft` returns the id to use from now on (IMAP ids change on update).
 * - Reads take an AbortSignal and must reject with an AbortError when aborted.
 */

import type {
  AssistantAllowance,
  AttachmentDownload,
  ContactHit,
  DraftDetail,
  DraftInput,
  DraftRef,
  DraftSummary,
  FolderEntry,
  FolderRef,
  ForwardMessageInput,
  Inbox,
  ListMessagesParams,
  MailEventListener,
  MessageDetail,
  MessageFlags,
  MessageThread,
  MessageKey,
  MessagePage,
  MoveResult,
  ReplyMessageInput,
  ScheduledSend,
  ScheduleSendInput,
  SearchMessagesParams,
  SendMessageInput,
  SendResult,
} from "./types";

export type PartialPageListener = (page: MessagePage) => void;

export interface MailApi {
  /* ---- reads ---- */
  listInboxes(signal?: AbortSignal): Promise<Inbox[]>;
  listFolders(inbox_id: string, signal?: AbortSignal): Promise<FolderEntry[]>;
  /** `onPartial`: for the first page of a unified listing, called with a
   *  provisional page each time a mailbox answers while others are still out
   *  (`MessagePage.pending_inboxes`). An implementation may never call it. */
  listMessages(params: ListMessagesParams, signal?: AbortSignal, onPartial?: PartialPageListener): Promise<MessagePage>;
  readMessage(
    inbox_id: string,
    id: string,
    opts: { include_html: boolean },
    signal?: AbortSignal,
  ): Promise<MessageDetail>;
  searchMessages(params: SearchMessagesParams, signal?: AbortSignal, onPartial?: PartialPageListener): Promise<MessagePage>;
  /** The messages of the conversation `key` belongs to, across folders
   *  (Inbox, Sent, Archive; all mail on Gmail), oldest first, WITHOUT bodies.
   *  `thread_key` is the key that row carried. Never merges mailboxes. */
  getThread(key: MessageKey, opts?: { thread_key?: string; limit?: number }, signal?: AbortSignal): Promise<MessageThread>;
  /** The bytes of one attachment (`attachment_index` from ReadEmailAttachmentMeta). */
  downloadAttachment(key: MessageKey, attachment_index: number, signal?: AbortSignal): Promise<AttachmentDownload>;

  /* ---- message mutations ---- */
  setFlags(keys: MessageKey[], flags: MessageFlags): Promise<void>;
  /** Keys outside the destination's inbox are rejected: a message cannot change inbox. */
  moveMessages(keys: MessageKey[], destination: FolderRef): Promise<MoveResult>;
  archiveMessages(keys: MessageKey[]): Promise<MoveResult>;
  /** Default moves to Trash. `permanent` cannot be undone: confirm first. */
  deleteMessages(keys: MessageKey[], opts?: { permanent?: boolean }): Promise<MoveResult>;

  /* ---- sending ---- */
  sendMessage(input: SendMessageInput): Promise<SendResult>;
  replyToMessage(input: ReplyMessageInput): Promise<SendResult>;
  forwardMessage(input: ForwardMessageInput): Promise<SendResult>;

  /* ---- drafts ---- */
  listDrafts(inbox_id: string, signal?: AbortSignal): Promise<DraftSummary[]>;
  readDraft(inbox_id: string, draft_id: string, signal?: AbortSignal): Promise<DraftDetail>;
  createDraft(input: DraftInput): Promise<DraftRef>;
  /** Returns the NEW draft_id. Discard the old one. */
  updateDraft(inbox_id: string, draft_id: string, input: DraftInput): Promise<DraftRef>;
  deleteDraft(inbox_id: string, draft_id: string): Promise<void>;
  sendDraft(inbox_id: string, draft_id: string): Promise<SendResult>;

  /* ---- scheduled sends ---- */
  /** Omit inbox_id for every inbox. */
  listScheduled(inbox_id?: string, signal?: AbortSignal): Promise<ScheduledSend[]>;
  scheduleSend(input: ScheduleSendInput): Promise<ScheduledSend>;
  cancelScheduled(inbox_id: string, id: string): Promise<void>;

  /* ---- misc ---- */
  searchContacts(query: string, signal?: AbortSignal): Promise<ContactHit[]>;
  getAssistantAllowance(signal?: AbortSignal): Promise<AssistantAllowance>;

  /** Server-pushed events. Returns an unsubscribe function. */
  subscribe(listener: MailEventListener): () => void;
}

export const DEFAULT_PAGE_SIZE = 50;

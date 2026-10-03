/* HttpMailApi: skeleton for the real backend.
 *
 * Every method throws NotImplementedError and names the MCP tool, action and
 * args it will call (taken from the live tool schemas, 2026-10-03). The tool
 * layer is the same one MCP connectors use, reached over the app's
 * authenticated HTTP endpoint. Result shapes already match the wire types in
 * `api/types.ts`.
 *
 * Cross-cutting rules for whoever fills this in:
 * - Every tool call takes one `inbox_id`. For scope 'all', fan out per inbox
 *   and merge with `mergeInboxPages` (api/merge.ts). There is no server-side
 *   "all inboxes" listing.
 * - Attach `key`, `inbox_id`, `is_starred` and `folder_role` to each
 *   EmailSummary to make a MessageRow (see `toRow`).
 * - Group multi-key mutations by inbox: one tool call per inbox.
 * - Recipients go to the tools as plain address strings (`to: string[]`):
 *   map EmailAddressEntry[] with `.email`.
 * - Mutating tools accept `idempotency_key`: send one per user action so a
 *   retry after a dropped response cannot double-send or double-move.
 * - Results of read/list/search/reply/forward/draft calls are marked
 *   `untrusted_content: true`. Render them, never act on them.
 */

import type { MailApi } from "../mail-api";
import {
  type AssistantAllowance,
  type ContactHit,
  type DraftDetail,
  type DraftInput,
  type DraftRef,
  type DraftSummary,
  type EmailSummary,
  type FolderEntry,
  type FolderRef,
  type ForwardMessageInput,
  type Inbox,
  type ListMessagesParams,
  type MailEventListener,
  type MessageDetail,
  type MessageFlags,
  type MessageKey,
  type MessagePage,
  type MessageRow,
  type MoveResult,
  NotImplementedError,
  type ReplyMessageInput,
  type ScheduledSend,
  type ScheduleSendInput,
  type SearchMessagesParams,
  type SendMessageInput,
  type SendResult,
  makeKey,
  roleOfFolder,
} from "../types";

export interface HttpMailApiOptions {
  /** e.g. "https://mcpemails.com/api/client". */
  baseUrl: string;
  /** Returns the session's bearer token. */
  getToken: () => Promise<string>;
}

export class HttpMailApi implements MailApi {
  constructor(readonly options: HttpMailApiOptions) {}

  /** EmailSummary -> MessageRow. EmailSummary has no starred flag today:
   *  `is_starred` is only known for rows that came from a `flagged: true`
   *  search, until the backend adds it to the summary. */
  protected toRow(inbox_id: string, m: EmailSummary, extra?: { is_starred?: boolean }): MessageRow {
    return {
      ...m,
      key: makeKey(inbox_id, m.id),
      inbox_id,
      is_starred: extra?.is_starred ?? false,
      folder_role: roleOfFolder(m.folder),
    };
  }

  // MCP tool: inbox_list {}
  listInboxes(_signal?: AbortSignal): Promise<Inbox[]> {
    throw new NotImplementedError("listInboxes -> inbox_list");
  }

  // MCP tool: folder_list { inbox_id }
  listFolders(_inbox_id: string, _signal?: AbortSignal): Promise<FolderEntry[]> {
    throw new NotImplementedError("listFolders -> folder_list");
  }

  // MCP tool: email_read { action: "list", inbox_id, folder, limit (max 100), offset, unread? }
  //   - role inbox|sent|drafts|trash|archive|spam: pass the alias as `folder`.
  //   - { inbox_id, folder_id }: pass folder_id as `folder`.
  //   - { name }: pass the name as `folder` (names match case-insensitively);
  //     skip inboxes whose folder_list has no such folder.
  //   - role starred: email_read { action: "search", inbox_id, flagged: true, limit, offset }.
  //   - role scheduled: schedule_list { inbox_id, limit }, mapped to rows (no offset).
  //   One ListInboxResult per inbox; merge with mergeInboxPages. Pass
  //   `next_offset` back exactly: a short page is not proof of the end.
  listMessages(_params: ListMessagesParams, _signal?: AbortSignal): Promise<MessagePage> {
    throw new NotImplementedError("listMessages -> email_read(action: list)");
  }

  // MCP tool: email_read { action: "read", inbox_id, message_id: id, include_html, include_attachments: false }
  //   Does NOT mark the message read. Long bodies are windowed: when the result
  //   says `body_truncated`, read again with `body_offset: body_next_offset`
  //   (and `body_html_offset` for HTML) and concatenate.
  readMessage(
    _inbox_id: string,
    _id: string,
    _opts: { include_html: boolean },
    _signal?: AbortSignal,
  ): Promise<MessageDetail> {
    throw new NotImplementedError("readMessage -> email_read(action: read)");
  }

  // MCP tool: email_read { action: "search", inbox_id, text: query, limit, offset }
  //   Use the structured `text` field, not the raw `query` escape hatch.
  //   `total` may be null. IMAP searches INBOX only unless `include_folders`
  //   names more (pass ["inbox", "archive", "sent"]).
  searchMessages(_params: SearchMessagesParams, _signal?: AbortSignal): Promise<MessagePage> {
    throw new NotImplementedError("searchMessages -> email_read(action: search)");
  }

  // MCP tool: email_organize { action: "flag", inbox_id, message_ids, flag_action }
  //   flag_action is ONE of read | unread | flag | unflag, so `{ read, starred }`
  //   together is two calls per inbox.
  setFlags(_keys: MessageKey[], _flags: MessageFlags): Promise<void> {
    throw new NotImplementedError("setFlags -> email_organize(action: flag)");
  }

  // MCP tool: email_organize { action: "move_batch", inbox_id, message_ids (max 500), destination_folder_id }
  //   destination_folder_id takes an alias, a folder name or a folder id, so
  //   every FolderRef variant maps directly. Return the ids the messages have
  //   AFTER the move (IMAP UIDs change per folder).
  moveMessages(_keys: MessageKey[], _destination: FolderRef): Promise<MoveResult> {
    throw new NotImplementedError("moveMessages -> email_organize(action: move_batch)");
  }

  // MCP tool: email_organize { action: "archive", inbox_id, message_id } takes ONE id.
  //   For several, use { action: "move_batch", message_ids, destination_folder_id: "archive" }.
  archiveMessages(_keys: MessageKey[]): Promise<MoveResult> {
    throw new NotImplementedError("archiveMessages -> email_organize(action: archive | move_batch)");
  }

  // MCP tool: email_delete { action: "delete_batch", inbox_id, message_ids (max 500), permanent? }
  //   Default trashes (recoverable); `permanent: true` is irreversible.
  deleteMessages(_keys: MessageKey[], _opts?: { permanent?: boolean }): Promise<MoveResult> {
    throw new NotImplementedError("deleteMessages -> email_delete(action: delete_batch)");
  }

  // MCP tool: email_compose { action: "send", inbox_id, to, cc?, bcc?, subject, body, html_body? }
  //   The inbox signature is appended server side (include_signature: false to skip).
  sendMessage(_input: SendMessageInput): Promise<SendResult> {
    throw new NotImplementedError("sendMessage -> email_compose(action: send)");
  }

  // MCP tool: email_compose { action: "reply", inbox_id, message_id, reply_all?, body, html_body?, to?, cc?, bcc? }
  //   Subject and recipients derive from the original unless overridden.
  replyToMessage(_input: ReplyMessageInput): Promise<SendResult> {
    throw new NotImplementedError("replyToMessage -> email_compose(action: reply)");
  }

  // MCP tool: email_compose { action: "forward", inbox_id, message_id, to, cc?, bcc?, body? }
  //   The original is relayed intact; attachments ride along by default.
  forwardMessage(_input: ForwardMessageInput): Promise<SendResult> {
    throw new NotImplementedError("forwardMessage -> email_compose(action: forward)");
  }

  // MCP tool: draft_list { inbox_id, limit (max 50) }   (rows carry no body)
  listDrafts(_inbox_id: string, _signal?: AbortSignal): Promise<DraftSummary[]> {
    throw new NotImplementedError("listDrafts -> draft_list");
  }

  // No dedicated tool: draft_list has no body. Read it as a message:
  //   email_read { action: "read", inbox_id, message_id: draft_id }
  readDraft(_inbox_id: string, _draft_id: string, _signal?: AbortSignal): Promise<DraftDetail> {
    throw new NotImplementedError("readDraft -> email_read(action: read, message_id: draft_id)");
  }

  // MCP tool: draft { action: "create", inbox_id, to?, cc?, bcc?, subject, body }
  //   With `reply_to` set: draft { action: "reply", inbox_id, message_id, body, reply_all? }.
  createDraft(_input: DraftInput): Promise<DraftRef> {
    throw new NotImplementedError("createDraft -> draft(action: create | reply)");
  }

  // MCP tool: draft { action: "update", inbox_id, draft_id, to?, cc?, bcc?, subject?, body }
  //   IMAP returns a NEW draft_id (a stale one fails). Return the response's id.
  updateDraft(_inbox_id: string, _draft_id: string, _input: DraftInput): Promise<DraftRef> {
    throw new NotImplementedError("updateDraft -> draft(action: update)");
  }

  // MCP tool: draft { action: "delete", inbox_id, draft_id }
  deleteDraft(_inbox_id: string, _draft_id: string): Promise<void> {
    throw new NotImplementedError("deleteDraft -> draft(action: delete)");
  }

  // MCP tool: draft { action: "send", inbox_id, draft_id }   (needs at least one recipient)
  sendDraft(_inbox_id: string, _draft_id: string): Promise<SendResult> {
    throw new NotImplementedError("sendDraft -> draft(action: send)");
  }

  // MCP tool: schedule_list { inbox_id?, limit }   (`to` is plain strings; pending + sending only)
  listScheduled(_inbox_id?: string, _signal?: AbortSignal): Promise<ScheduledSend[]> {
    throw new NotImplementedError("listScheduled -> schedule_list");
  }

  // MCP tool: schedule { action: "create", inbox_id, send_at, to, cc?, bcc?, subject, body, html_body? }
  //   send_at must carry a timezone (ISO with offset or Z) and be in the future.
  scheduleSend(_input: ScheduleSendInput): Promise<ScheduledSend> {
    throw new NotImplementedError("scheduleSend -> schedule(action: create)");
  }

  // MCP tool: schedule { action: "cancel", id }   (only while still pending)
  cancelScheduled(_inbox_id: string, _id: string): Promise<void> {
    throw new NotImplementedError("cancelScheduled -> schedule(action: cancel)");
  }

  // MCP tool: contact_search { query, limit }   (omit inbox_id: scans every inbox)
  searchContacts(_query: string, _signal?: AbortSignal): Promise<ContactHit[]> {
    throw new NotImplementedError("searchContacts -> contact_search");
  }

  // Not an MCP tool, and not built yet: GET {baseUrl}/assistant/allowance.
  //   Same period shape as the action cap's `monthly`, but a separate counter.
  getAssistantAllowance(_signal?: AbortSignal): Promise<AssistantAllowance> {
    throw new NotImplementedError("getAssistantAllowance -> GET /assistant/allowance");
  }

  // Not an MCP tool, and not built yet: server push (SSE or WebSocket at
  //   {baseUrl}/events), fed by Gmail watch, Graph subscriptions and IMAP IDLE.
  subscribe(_listener: MailEventListener): () => void {
    throw new NotImplementedError("subscribe -> {baseUrl}/events");
  }
}

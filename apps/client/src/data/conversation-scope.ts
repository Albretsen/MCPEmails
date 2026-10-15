import type { MessageKey, MessageRow, MessageThread } from "../api/types";
import { conversationOf } from "../state/conversation-store";
import { useUiStore } from "../state/ui-store";
import { findRow } from "./cache";
import { type Conversation, conversationThreadId, mergeThread } from "./conversations";
import { keys } from "./keys";
import { queryClient } from "./query-client";

/* Which messages an action on a conversation applies to.
 *
 * Archive, delete, move, mark unread and star act on the WHOLE conversation
 * "in the current folder scope": every message of it that the list on screen
 * holds, plus any the `thread` op found in that same folder but on a page the
 * list has not loaded yet. Messages of the conversation in other folders (the
 * person's own replies in Sent) are left where they are.
 *
 * Reply, Reply all and Forward act on ONE message (state/conversation-store
 * `replyTargetOf`).
 */

/** The cache id of a conversation's thread. ONE per conversation, whichever of
 *  its messages is asked about: the conversation's own id when the list holds
 *  it, else the row's key, or the message's own id for a row that carries none. */
export function threadQueryId(row: Pick<MessageRow, "thread_key" | "id">, conv?: Conversation): string {
  return conv ? conversationThreadId(conv) : row.thread_key || `id:${row.id}`;
}

function cachedThread(row: MessageRow, conv?: Conversation): MessageThread | undefined {
  return queryClient.getQueryData<MessageThread>(keys.thread(row.inbox_id, threadQueryId(row, conv)));
}

const conversationView = (): boolean => useUiStore.getState().settings.conversationView;

/** Every message of `key`'s conversation that is known right now, oldest
 *  first: list rows plus the cached thread. `[]` when nothing is known. */
export function conversationMessages(key: MessageKey): MessageRow[] {
  const conv = conversationView() ? conversationOf(key) : undefined;
  const anchor = conv?.head ?? findRow(key);
  if (!anchor) return [];
  if (!conversationView()) return [anchor];
  return mergeThread(conv?.rows ?? [anchor], cachedThread(anchor, conv)?.rows ?? []);
}

/** See the header. `[key]` for a message nothing is known about. */
export function conversationKeys(key: MessageKey): MessageKey[] {
  if (!conversationView()) return [key];
  const conv = conversationOf(key);
  if (!conv) return [key];
  const out = [...conv.keys];
  const thread = cachedThread(conv.head, conv);
  if (thread) {
    const have = new Set(out);
    const ids = new Set(conv.rows.map((r) => r.message_id_header).filter(Boolean));
    for (const r of thread.rows) {
      if (have.has(r.key) || r.inbox_id !== conv.head.inbox_id || r.folder !== conv.head.folder) continue;
      if (r.message_id_header && ids.has(r.message_id_header)) continue;
      out.push(r.key);
    }
  }
  return out;
}

/** The same for several rows (a multi-selection), without duplicates. */
export function expandToConversations(selected: readonly MessageKey[]): MessageKey[] {
  const out: MessageKey[] = [];
  const seen = new Set<MessageKey>();
  for (const key of selected) {
    for (const k of conversationKeys(key)) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/** Is any message of the conversation starred (the star toggles all of them). */
export function conversationStarred(key: MessageKey): boolean {
  const conv = conversationView() ? conversationOf(key) : undefined;
  return conv ? conv.starred : (findRow(key)?.is_starred ?? false);
}

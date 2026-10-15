import type { MessageKey, MessageRow } from "../api/types";

/* Conversations: rows of ONE list grouped by thread.
 *
 * What links two rows (always inside one mailbox, never across):
 *   - the same `thread_key` (the server's: Gmail thread, Outlook conversation,
 *     root Message-ID, see client-api mail/thread-key.ts), or
 *   - for header-keyed rows (`m:`): one row's Message-ID appearing in the
 *     other's In-Reply-To or References. That joins a reply whose References
 *     were cut short by some mail client, and a reply that was loaded before
 *     the page its parent is on.
 * The subject NEVER links anything here. Two "Re: Invoice" mails are one
 * conversation only when a header says so.
 *
 * A row without a `thread_key` (an older server, a draft, a scheduled send)
 * is a conversation of one.
 *
 * Incremental: the grouper remembers, per row object, the link it derived, and
 * keeps one union-find over link tokens. A new page costs the links of its new
 * rows plus one pass over the row array that reads a cached token per row and
 * appends the row to its conversation. Nothing is sorted: the rows come in
 * newest first, so the first row met of each conversation is its newest (the
 * head), and conversations come out in the order of their heads. A
 * conversation whose rows did not change keeps its object identity.
 */

export interface Conversation {
  /** Stable for the life of the list: survives a new head, and a later
   *  conversation being found to belong to it. */
  id: string;
  /** The newest row in this list. The list row shows it. */
  head: MessageRow;
  /** Every row of the conversation in this list, newest first. */
  rows: readonly MessageRow[];
  keys: readonly MessageKey[];
  /** Distinct messages (the same Message-ID filed twice counts once). */
  count: number;
  /** Any message unread / starred / with an attachment. */
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
}

export interface ConversationList {
  /** In the order of their heads: newest conversation first. */
  conversations: readonly Conversation[];
  /** Every member row's key -> its conversation. */
  byKey: ReadonlyMap<MessageKey, Conversation>;
}

export const EMPTY_CONVERSATIONS: ConversationList = { conversations: [], byKey: new Map() };

const SEP = "\u0001";

/** What a conversation's `thread` answer is cached under (inside its mailbox):
 *  the conversation's id without the mailbox. For an ordinary conversation
 *  that is its `thread_key`. Unlike the head row's own key it stays the same
 *  when a reply becomes the head, also for a conversation whose rows carry
 *  different keys (References cut short by some mail client). */
export function conversationThreadId(conv: Pick<Conversation, "id" | "head">): string {
  const box = conv.head.inbox_id + SEP;
  return conv.id.startsWith(box) ? conv.id.slice(box.length) : conv.id;
}

/** Rows that are never grouped: no key, or not mail yet. */
function standsAlone(row: MessageRow): boolean {
  return !row.thread_key || row.folder_role === "drafts" || row.folder_role === "scheduled";
}

/** The link tokens of a row, primary first. Tokens carry the mailbox, so two
 *  mailboxes can never share one. */
export function linkTokens(row: MessageRow): string[] {
  if (standsAlone(row)) return [`${row.inbox_id}${SEP}k:${row.key}`];
  const box = row.inbox_id + SEP;
  const key = row.thread_key as string;
  const out = [box + key];
  // Only header-keyed rows link through their ids: a Gmail thread or an
  // Outlook conversation is the provider's own answer and is not second-guessed.
  if (!key.startsWith("m:")) return out;
  const add = (id: string | null | undefined) => {
    if (!id) return;
    const token = `${box}m:${id}`;
    if (!out.includes(token)) out.push(token);
  };
  add(row.message_id_header);
  add(row.in_reply_to);
  if (row.references) for (const id of row.references) add(id);
  return out;
}

interface Building {
  id: string;
  rows: MessageRow[];
}

function build(b: Building, prev: Conversation | undefined): Conversation {
  const rows = b.rows;
  if (prev && prev.rows.length === rows.length) {
    let same = true;
    for (let i = 0; i < rows.length; i++) {
      if (prev.rows[i] !== rows[i]) {
        same = false;
        break;
      }
    }
    if (same) return prev;
  }
  const head = rows[0] as MessageRow;
  if (rows.length === 1) {
    return {
      id: b.id,
      head,
      rows,
      keys: [head.key],
      count: 1,
      unread: !head.is_read,
      starred: head.is_starred,
      hasAttachment: head.has_attachments,
    };
  }
  let unread = false;
  let starred = false;
  let hasAttachment = false;
  const keys: MessageKey[] = [];
  const ids = new Set<string>();
  for (const r of rows) {
    keys.push(r.key);
    ids.add(r.message_id_header || r.key);
    if (!r.is_read) unread = true;
    if (r.is_starred) starred = true;
    if (r.has_attachments) hasAttachment = true;
  }
  return { id: b.id, head, rows, keys, count: ids.size, unread, starred, hasAttachment };
}

/** One per list on screen. `group` is called with that list's rows every time
 *  they change. */
export class ConversationGrouper {
  /** Union-find over link tokens. A token absent from the map is its own root. */
  private parent = new Map<string, string>();
  /** When each token was first seen: the older root wins a union, so a
   *  conversation's id does not change when a later one is joined to it. */
  private seen = new Map<string, number>();
  private clock = 0;
  /** The primary token derived for each row object. */
  private tokenOf = new WeakMap<MessageRow, string>();
  private prev = new Map<string, Conversation>();
  private singles = new WeakMap<MessageRow, Conversation>();

  private find(token: string): string {
    let root = token;
    for (let p = this.parent.get(root); p !== undefined; p = this.parent.get(root)) root = p;
    // Path compression.
    while (token !== root) {
      const next = this.parent.get(token) as string;
      this.parent.set(token, root);
      token = next;
    }
    return root;
  }

  private touch(token: string): void {
    if (!this.seen.has(token)) this.seen.set(token, this.clock++);
  }

  private union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if ((this.seen.get(ra) as number) <= (this.seen.get(rb) as number)) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  private link(row: MessageRow): string {
    const tokens = linkTokens(row);
    const primary = tokens[0] as string;
    this.touch(primary);
    for (let i = 1; i < tokens.length; i++) {
      this.touch(tokens[i] as string);
      this.union(primary, tokens[i] as string);
    }
    this.tokenOf.set(row, primary);
    return primary;
  }

  /** `rows`: newest first, no duplicate keys. `enabled: false` makes every row
   *  its own conversation (conversation view switched off). */
  group(rows: readonly MessageRow[], enabled = true): ConversationList {
    const conversations: Conversation[] = [];
    const byKey = new Map<MessageKey, Conversation>();
    if (!enabled) {
      for (const row of rows) {
        let c = this.singles.get(row);
        if (!c) {
          c = build({ id: `${row.inbox_id}${SEP}k:${row.key}`, rows: [row] }, undefined);
          this.singles.set(row, c);
        }
        conversations.push(c);
        byKey.set(row.key, c);
      }
      return { conversations, byKey };
    }

    // 1. Links, for the rows that are new (or whose object changed).
    const primaries: string[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as MessageRow;
      primaries[i] = this.tokenOf.get(row) ?? this.link(row);
    }
    // 2. One pass, in order: the first row met of a conversation is its head.
    const building = new Map<string, Building>();
    const order: Building[] = [];
    for (let i = 0; i < rows.length; i++) {
      const root = this.find(primaries[i] as string);
      let b = building.get(root);
      if (!b) {
        b = { id: root, rows: [] };
        building.set(root, b);
        order.push(b);
      }
      b.rows.push(rows[i] as MessageRow);
    }
    const next = new Map<string, Conversation>();
    for (const b of order) {
      const c = build(b, this.prev.get(b.id));
      next.set(b.id, c);
      conversations.push(c);
      for (const r of c.rows) byKey.set(r.key, c);
    }
    this.prev = next;
    return { conversations, byKey };
  }
}

/* ------------------------------------------------------------------
 * What a conversation row says
 * ------------------------------------------------------------------ */

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? "";

/** "Maya, me" for the people who wrote in a conversation, oldest first.
 *  `self` is the mailbox's own address. More than three: first, "…", last two. */
export function participantNames(rows: readonly MessageRow[], self: string): string {
  const mine = self.toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const from = (rows[i] as MessageRow).from;
    const email = from.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    names.push(mine && email === mine ? "me" : firstName(from.name) || from.email.split("@")[0] || from.email);
  }
  if (names.length <= 3) return names.join(", ");
  return `${names[0]} … ${names[names.length - 2]}, ${names[names.length - 1]}`;
}

/** The messages of an open conversation: the list's own rows plus what the
 *  `thread` op found in other folders. Oldest first. The same message filed
 *  in two folders is shown once, the list's copy winning. */
export function mergeThread(listRows: readonly MessageRow[], threadRows: readonly MessageRow[]): MessageRow[] {
  const out: MessageRow[] = [];
  const keys = new Set<MessageKey>();
  const ids = new Set<string>();
  const add = (row: MessageRow) => {
    if (keys.has(row.key)) return;
    if (row.message_id_header) {
      if (ids.has(row.message_id_header)) return;
      ids.add(row.message_id_header);
    }
    keys.add(row.key);
    out.push(row);
  };
  for (const r of listRows) add(r);
  for (const r of threadRows) add(r);
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

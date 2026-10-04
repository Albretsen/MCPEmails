/* In-memory MailApi. Behaves like the real backend where it matters to the UI:
 * per-inbox offset pagination, opaque folder ids, reads that do not mark read,
 * IMAP draft ids that change on update, null totals from IMAP search, latency,
 * and writes that can be made to fail.
 */

import type { MailApi } from "../mail-api";
import { mergeInboxPages } from "../merge";
import {
  type AssistantAllowance,
  type AttachmentDownload,
  type ContactHit,
  type DraftDetail,
  type DraftInput,
  type DraftRef,
  type DraftSummary,
  type EmailAddressEntry,
  type FolderEntry,
  type FolderRef,
  type ForwardMessageInput,
  type Inbox,
  type ListMessagesParams,
  type MailEvent,
  type MailEventListener,
  type MessageDetail,
  type MessageFlags,
  type MessageKey,
  type MessagePage,
  type MessageRow,
  type MessageThread,
  type MoveResult,
  type ReplyMessageInput,
  type ScheduledSend,
  type ScheduleSendInput,
  type SearchMessagesParams,
  type SendMessageInput,
  type SendResult,
  isExactRef,
  isNameRef,
  isRoleRef,
  makeKey,
  parseKey,
  roleOfFolder,
} from "../types";
import { readDelay, writeDelay } from "./latency";
import {
  type AssistantHints,
  CUSTOM_FOLDERS,
  INCOMING,
  MOCK_INBOXES,
  MOCK_PROFILES,
  type MockBox,
  type MockProfile,
  type SeedEmail,
  SEED,
  SEED_RICH,
  THREADS,
  generateFiller,
  hintsOf,
} from "./seed";

export interface MockMessage {
  inbox_id: string;
  id: string;
  from: EmailAddressEntry;
  to: EmailAddressEntry[];
  cc: EmailAddressEntry[];
  subject: string;
  date: string;
  preview: string;
  body_text: string;
  is_read: boolean;
  is_starred: boolean;
  has_attachments: boolean;
  /** Folder id. Opaque to the UI. */
  folder: string;
  thread_id: string;
  /** Threading headers, as the client API sends them on every row. */
  message_id_header: string;
  in_reply_to: string | null;
  references: string[];
}

const MOCK_ID_DOMAIN = "mock.mail";
const messageIdOf = (id: string) => `${id}@${MOCK_ID_DOMAIN}`;

interface MockScheduled extends ScheduledSend {
  body_text: string;
}

const ALIAS_FOLDER = {
  inbox: "INBOX",
  sent: "Sent",
  drafts: "Drafts",
  trash: "Trash",
  archive: "Archive",
  spam: "Spam",
} as const;

const SYSTEM_FOLDERS: { id: string; name: string }[] = [
  { id: "INBOX", name: "Inbox" },
  { id: "Sent", name: "Sent" },
  { id: "Drafts", name: "Drafts" },
  { id: "Archive", name: "Archive" },
  { id: "Trash", name: "Trash" },
  { id: "Spam", name: "Spam" },
];

const byDateDesc = (a: { date: string }, b: { date: string }) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

export class MockMailApi implements MailApi {
  profile: MockProfile;
  /** Mock-only: what the scripted assistant "knows" about each email. */
  readonly hints = new Map<MessageKey, AssistantHints>();

  private inboxes: Inbox[] = [];
  private messages = new Map<MessageKey, MockMessage>();
  private drafts = new Map<string, DraftDetail>();
  private scheduled: MockScheduled[] = [];
  private listeners = new Set<MailEventListener>();
  private allowance: AssistantAllowance;
  private seq = 1;
  private incomingIdx = 0;

  constructor(profile: MockProfile = "pro", now: number = Date.now()) {
    this.profile = profile;
    this.allowance = this.makeAllowance(profile, now);
    this.seed(profile, now);
  }

  /* ================= mock-only surface ================= */

  /** Rebuilds the whole backend for a profile. Callers must clear their caches. */
  reset(profile: MockProfile, now: number = Date.now()): void {
    this.profile = profile;
    this.messages.clear();
    this.drafts.clear();
    this.hints.clear();
    this.scheduled = [];
    this.seq = 1;
    this.incomingIdx = 0;
    this.allowance = this.makeAllowance(profile, now);
    this.seed(profile, now);
  }

  getMessage(key: MessageKey): MockMessage | undefined {
    return this.messages.get(key);
  }

  allMessages(): MockMessage[] {
    return [...this.messages.values()];
  }

  getHints(key: MessageKey): AssistantHints | undefined {
    return this.hints.get(key);
  }

  toRow(m: MockMessage): MessageRow {
    return {
      key: makeKey(m.inbox_id, m.id),
      inbox_id: m.inbox_id,
      id: m.id,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      preview: m.preview,
      is_read: m.is_read,
      has_attachments: m.has_attachments,
      folder: m.folder,
      thread_id: m.thread_id,
      is_starred: m.is_starred,
      folder_role: roleOfFolder(m.folder),
      message_id_header: m.message_id_header,
      in_reply_to: m.in_reply_to,
      references: m.references,
      thread_key: this.threadKey(m),
    };
  }

  /** The conversation key the real server would compute (client-api
   *  mail/thread-key.ts): the provider's thread id on Gmail and Outlook, the
   *  root Message-ID everywhere else. */
  private threadKey(m: MockMessage): string {
    const provider = this.inboxes.find((i) => i.inbox_id === m.inbox_id)?.provider;
    if (provider === "gmail") return `g:${m.thread_id}`;
    if (provider === "outlook") return `o:${m.thread_id}`;
    return `m:${m.references[0] ?? m.in_reply_to ?? m.message_id_header}`;
  }

  /** The headers of a reply to `parent`. */
  private replyHeaders(parent: MockMessage | undefined): Pick<MockMessage, "in_reply_to" | "references"> {
    if (!parent) return { in_reply_to: null, references: [] };
    return { in_reply_to: parent.message_id_header, references: [...parent.references, parent.message_id_header] };
  }

  /** Emits to subscribers as if the server pushed it. */
  emit(event: MailEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  /** Delivers the next canned incoming email and emits `new_mail`. */
  simulateIncoming(): MessageRow[] {
    const src = INCOMING[this.incomingIdx % INCOMING.length];
    this.incomingIdx++;
    if (!src) return [];
    const boxes = MOCK_PROFILES[this.profile].boxes;
    const box = boxes.includes(src.box) ? src.box : (boxes[0] as MockBox);
    const inbox = MOCK_INBOXES[box];
    const id = `${src.id}_${this.seq++}`;
    const m: MockMessage = {
      inbox_id: inbox.inbox_id,
      id,
      from: { name: src.from, email: src.email },
      to: [{ name: "Jordan Reyes", email: inbox.email_address }],
      cc: [],
      subject: src.subject,
      date: new Date().toISOString(),
      preview: src.snippet,
      body_text: src.body,
      is_read: false,
      is_starred: false,
      has_attachments: false,
      folder: ALIAS_FOLDER.inbox,
      thread_id: `t-${id}`,
      message_id_header: messageIdOf(id),
      in_reply_to: null,
      references: [],
    };
    const key = makeKey(m.inbox_id, m.id);
    this.messages.set(key, m);
    const h = hintsOf(src);
    if (h) this.hints.set(key, h);
    const rows = [this.toRow(m)];
    this.emit({ type: "new_mail", rows });
    return rows;
  }

  /** Counts one assistant action against the allowance. */
  consumeAssistantAction(n = 1): AssistantAllowance {
    const a = this.allowance;
    const used = a.used + n;
    this.allowance = { ...a, used, remaining: a.cap == null ? null : Math.max(0, a.cap - used) };
    return this.allowance;
  }

  setAllowance(patch: Partial<AssistantAllowance>): void {
    this.allowance = { ...this.allowance, ...patch };
  }

  /* ================= MailApi: reads ================= */

  async listInboxes(signal?: AbortSignal): Promise<Inbox[]> {
    await readDelay(signal);
    return this.inboxes.map((i) => ({ ...i }));
  }

  async listFolders(inbox_id: string, signal?: AbortSignal): Promise<FolderEntry[]> {
    await readDelay(signal);
    const inbox = this.requireInbox(inbox_id);
    const mine = this.allMessages().filter((m) => m.inbox_id === inbox_id);
    const count = (id: string) => {
      if (id === ALIAS_FOLDER.drafts) {
        const n = [...this.drafts.values()].filter((d) => d.inbox_id === inbox_id).length;
        return { total: n, unread: 0 };
      }
      const inFolder = mine.filter((m) => m.folder === id);
      return { total: inFolder.length, unread: inFolder.filter((m) => !m.is_read).length };
    };
    const custom = CUSTOM_FOLDERS.map((name) => ({ id: name, name }));
    return [...SYSTEM_FOLDERS, ...custom].map((f, i) => {
      const c = count(f.id);
      const isCustom = i >= SYSTEM_FOLDERS.length;
      return {
        id: f.id,
        name: f.name,
        type: isCustom && inbox.provider === "gmail" ? ("label" as const) : ("folder" as const),
        total_messages: c.total,
        unread_messages: c.unread,
      };
    });
  }

  async listMessages(params: ListMessagesParams, signal?: AbortSignal): Promise<MessagePage> {
    await readDelay(signal);
    const ids = this.scopeInboxes(params.scope, params.folder);
    return mergeInboxPages(ids, params.cursor, params.limit, async (inbox_id, offset, limit) => {
      const all = this.rowsFor(inbox_id, params.folder, params.unread);
      return {
        inbox_id,
        rows: all.slice(offset, offset + limit),
        total: all.length,
        has_more: offset + limit < all.length,
      };
    });
  }

  async readMessage(
    inbox_id: string,
    id: string,
    _opts: { include_html: boolean },
    signal?: AbortSignal,
  ): Promise<MessageDetail> {
    await readDelay(signal);
    const key = makeKey(inbox_id, id);
    const m = this.messages.get(key);
    if (m) {
      return {
        ...this.detailBase(key, inbox_id, id),
        thread_id: m.thread_id,
        message_id_header: m.message_id_header,
        in_reply_to: m.in_reply_to,
        references: m.references,
        thread_key: this.threadKey(m),
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        date: m.date,
        body_text: m.body_text,
        is_read: m.is_read,
        is_starred: m.is_starred,
        folder: m.folder,
        folder_role: roleOfFolder(m.folder),
        body_html: SEED_RICH[m.id]?.html ?? null,
        attachments: SEED_RICH[m.id]?.attachments
          ? SEED_RICH[m.id]!.attachments!.map((a, i) => ({ attachment_index: i, ...a, data: null }))
          : m.has_attachments
            ? [{ attachment_index: 0, filename: "attachment.pdf", mime_type: "application/pdf", size_bytes: 184_320, data: null }]
            : [],
      };
    }
    // Drafts and scheduled sends are listed as rows too, so they can be read by id.
    const d = this.drafts.get(this.draftKey(inbox_id, id));
    if (d) {
      return {
        ...this.detailBase(key, inbox_id, id),
        from: this.self(inbox_id),
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        date: d.created_at,
        body_text: d.body_text,
        folder: ALIAS_FOLDER.drafts,
        folder_role: "drafts",
      };
    }
    const s = this.scheduled.find((x) => x.inbox_id === inbox_id && x.id === id);
    if (s) {
      return {
        ...this.detailBase(key, inbox_id, id),
        from: this.self(inbox_id),
        to: s.to.map((email) => ({ name: "", email })),
        subject: s.subject,
        date: s.send_at,
        body_text: s.body_text,
        folder: "Scheduled",
        folder_role: "scheduled",
      };
    }
    throw new Error("message_not_found");
  }

  /** Like the real `thread` op: every message of the conversation in this
   *  mailbox, whatever its folder (not Trash, Spam or Drafts), oldest first. */
  async getThread(key: MessageKey, _opts?: { thread_key?: string; limit?: number }, signal?: AbortSignal): Promise<MessageThread> {
    await readDelay(signal);
    const anchor = this.messages.get(key);
    if (!anchor) throw new Error("message_not_found");
    const rows = this.allMessages()
      .filter(
        (m) =>
          m.inbox_id === anchor.inbox_id &&
          m.thread_id === anchor.thread_id &&
          m.folder !== ALIAS_FOLDER.trash &&
          m.folder !== ALIAS_FOLDER.spam,
      )
      .map((m) => this.toRow(m))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { thread_key: this.threadKey(anchor), rows, partial: false };
  }

  async downloadAttachment(key: MessageKey, attachment_index: number, signal?: AbortSignal): Promise<AttachmentDownload> {
    await readDelay(signal);
    const { inbox_id, id } = parseKey(key);
    const detail = await this.readMessage(inbox_id, id, { include_html: false }, signal);
    const meta = detail.attachments.find((a, i) => (a.attachment_index ?? i) === attachment_index);
    if (!meta) throw new Error("attachment_not_found");
    const blob = new Blob([`Mock attachment: ${meta.filename}\n`], { type: "text/plain" });
    return { blob, filename: meta.filename, mime_type: meta.mime_type };
  }

  async searchMessages(params: SearchMessagesParams, signal?: AbortSignal): Promise<MessagePage> {
    await readDelay(signal);
    const q = params.query.trim().toLowerCase();
    const ids = params.scope === "all" ? this.inboxes.map((i) => i.inbox_id) : [params.scope];
    return mergeInboxPages(ids, params.cursor, params.limit, async (inbox_id, offset, limit) => {
      const all = !q
        ? []
        : this.allMessages()
            .filter((m) => m.inbox_id === inbox_id && m.folder !== ALIAS_FOLDER.trash && m.folder !== ALIAS_FOLDER.spam)
            .filter((m) =>
              `${m.from.name} ${m.from.email} ${m.subject} ${m.preview} ${m.to.map((t) => t.email).join(" ")} ${m.body_text}`
                .toLowerCase()
                .includes(q),
            )
            .sort(byDateDesc)
            .map((m) => this.toRow(m));
      const provider = this.requireInbox(inbox_id).provider;
      return {
        inbox_id,
        rows: all.slice(offset, offset + limit),
        // IMAP search cannot count cheaply: the real backend reports null there.
        total: provider === "imap" ? null : all.length,
        has_more: offset + limit < all.length,
      };
    });
  }

  /* ================= MailApi: message mutations ================= */

  async setFlags(keys: MessageKey[], flags: MessageFlags): Promise<void> {
    await writeDelay();
    for (const key of keys) {
      const m = this.messages.get(key);
      if (!m) continue;
      if (flags.read !== undefined) m.is_read = flags.read;
      if (flags.starred !== undefined) m.is_starred = flags.starred;
    }
  }

  async moveMessages(keys: MessageKey[], destination: FolderRef): Promise<MoveResult> {
    await writeDelay();
    return this.moveNow(keys, destination);
  }

  async archiveMessages(keys: MessageKey[]): Promise<MoveResult> {
    await writeDelay();
    return this.moveNow(keys, { role: "archive" });
  }

  async deleteMessages(keys: MessageKey[], opts?: { permanent?: boolean }): Promise<MoveResult> {
    await writeDelay();
    if (opts?.permanent) {
      for (const key of keys) {
        this.messages.delete(key);
        this.hints.delete(key);
      }
      return { moved: [] };
    }
    return this.moveNow(keys, { role: "trash" });
  }

  /** Synchronous move without latency: used by the scripted assistant, which
   *  paces itself. Mock ids are stable across a move; real IMAP ids are not,
   *  so callers must still read `new_key`. */
  moveNow(keys: MessageKey[], destination: FolderRef): MoveResult {
    const moved: MoveResult["moved"] = [];
    for (const key of keys) {
      const m = this.messages.get(key);
      if (!m) continue;
      const folder = this.resolveFolder(m.inbox_id, destination);
      if (!folder) throw new Error("folder_not_found");
      m.folder = folder;
      moved.push({ key, new_key: key });
    }
    return { moved };
  }

  /* ================= MailApi: sending ================= */

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    await writeDelay();
    return this.deliver(input.inbox_id, input.to, input.cc ?? [], input.subject, input.body_text);
  }

  async replyToMessage(input: ReplyMessageInput): Promise<SendResult> {
    await writeDelay();
    const orig = this.messages.get(input.key);
    if (!orig) throw new Error("message_not_found");
    const selfAddr = this.self(orig.inbox_id).email;
    const to = input.to ?? [orig.from];
    const cc =
      input.cc ?? (input.reply_all ? [...orig.to, ...orig.cc].filter((a) => a.email !== selfAddr) : []);
    return this.deliver(orig.inbox_id, to, cc, `Re: ${orig.subject.replace(/^Re: /i, "")}`, input.body_text, orig);
  }

  async forwardMessage(input: ForwardMessageInput): Promise<SendResult> {
    await writeDelay();
    const orig = this.messages.get(input.key);
    if (!orig) throw new Error("message_not_found");
    const body = `${input.body_text ?? ""}\n\n---------- Forwarded message ----------\nFrom: ${orig.from.name} <${orig.from.email}>\nSubject: ${orig.subject}\n\n${orig.body_text}`;
    return this.deliver(orig.inbox_id, input.to, input.cc ?? [], `Fwd: ${orig.subject}`, body);
  }

  /* ================= MailApi: drafts ================= */

  async listDrafts(inbox_id: string, signal?: AbortSignal): Promise<DraftSummary[]> {
    await readDelay(signal);
    return [...this.drafts.values()]
      .filter((d) => d.inbox_id === inbox_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map(({ draft_id, subject, to, cc, created_at }) => ({ draft_id, subject, to, cc, created_at }));
  }

  async readDraft(inbox_id: string, draft_id: string, signal?: AbortSignal): Promise<DraftDetail> {
    await readDelay(signal);
    const d = this.drafts.get(this.draftKey(inbox_id, draft_id));
    if (!d) throw new Error("draft_not_found");
    return { ...d };
  }

  async createDraft(input: DraftInput): Promise<DraftRef> {
    await writeDelay();
    return this.putDraft(input);
  }

  async updateDraft(inbox_id: string, draft_id: string, input: DraftInput): Promise<DraftRef> {
    await writeDelay();
    const k = this.draftKey(inbox_id, draft_id);
    if (!this.drafts.has(k)) throw new Error("draft_not_found");
    // IMAP replaces the message, so the id changes. Other providers keep it.
    const keepId = this.requireInbox(inbox_id).provider !== "imap";
    this.drafts.delete(k);
    return this.putDraft({ ...input, inbox_id }, keepId ? draft_id : undefined);
  }

  async deleteDraft(inbox_id: string, draft_id: string): Promise<void> {
    await writeDelay();
    this.drafts.delete(this.draftKey(inbox_id, draft_id));
  }

  async sendDraft(inbox_id: string, draft_id: string): Promise<SendResult> {
    await writeDelay();
    const k = this.draftKey(inbox_id, draft_id);
    const d = this.drafts.get(k);
    if (!d) throw new Error("draft_not_found");
    this.drafts.delete(k);
    return this.deliver(inbox_id, d.to, d.cc, d.subject, d.body_text);
  }

  /* ================= MailApi: scheduled ================= */

  async listScheduled(inbox_id?: string, signal?: AbortSignal): Promise<ScheduledSend[]> {
    await readDelay(signal);
    return this.scheduled
      .filter((s) => !inbox_id || s.inbox_id === inbox_id)
      .map(({ body_text: _b, ...rest }) => rest);
  }

  async scheduleSend(input: ScheduleSendInput): Promise<ScheduledSend> {
    await writeDelay();
    this.requireInbox(input.inbox_id);
    const s: MockScheduled = {
      id: `sch${this.seq++}`,
      inbox_id: input.inbox_id,
      send_at: input.send_at,
      status: "scheduled",
      created_at: new Date().toISOString(),
      to: input.to.map((a) => a.email),
      subject: input.subject,
      body_text: input.body_text,
    };
    this.scheduled.push(s);
    const { body_text: _b, ...rest } = s;
    return rest;
  }

  async cancelScheduled(inbox_id: string, id: string): Promise<void> {
    await writeDelay();
    this.scheduled = this.scheduled.filter((s) => !(s.inbox_id === inbox_id && s.id === id));
  }

  /* ================= MailApi: misc ================= */

  async searchContacts(query: string, signal?: AbortSignal): Promise<ContactHit[]> {
    await readDelay(signal);
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = new Map<string, ContactHit>();
    for (const m of this.messages.values()) {
      const people = m.folder === ALIAS_FOLDER.sent ? m.to : [m.from];
      for (const p of people) {
        if (!`${p.name} ${p.email}`.toLowerCase().includes(q)) continue;
        const k = `${m.inbox_id}|${p.email}`;
        const cur = hits.get(k);
        if (cur) {
          cur.message_count++;
          if (m.date > cur.last_contacted_at) cur.last_contacted_at = m.date;
        } else {
          hits.set(k, {
            email_address: p.email,
            display_name: p.name || null,
            message_count: 1,
            last_contacted_at: m.date,
            inbox_id: m.inbox_id,
          });
        }
      }
    }
    return [...hits.values()].sort((a, b) => b.message_count - a.message_count).slice(0, 8);
  }

  async getAssistantAllowance(signal?: AbortSignal): Promise<AssistantAllowance> {
    await readDelay(signal);
    return { ...this.allowance };
  }

  subscribe(listener: MailEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ================= internals ================= */

  private makeAllowance(profile: MockProfile, now: number): AssistantAllowance {
    const p = MOCK_PROFILES[profile];
    const d = new Date(now);
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    return {
      plan: p.plan,
      used: p.used,
      cap: p.cap,
      remaining: p.cap == null ? null : Math.max(0, p.cap - p.used),
      period_start: start.toISOString(),
      resets_at: end.toISOString(),
    };
  }

  private seed(profile: MockProfile, now: number): void {
    const first = profile === "first";
    const boxes = MOCK_PROFILES[profile].boxes;
    this.inboxes = boxes.map((b) => MOCK_INBOXES[b]);
    const iso = (ago: number) => new Date(now - ago * 60_000).toISOString();
    const boxOf = (b: MockBox): MockBox => (first ? "gmail" : b);

    // First run mirrors the prototype: only the inbox, everything in one mailbox.
    const everything = [...SEED, ...THREADS];
    const seeds = first ? everything.filter((e) => e.folder === "inbox") : everything;
    const byId = new Map(everything.map((e) => [e.id, e]));
    /** The ancestors of a seed, oldest first, and the conversation's root. */
    const chain = (e: SeedEmail): string[] => {
      const out: string[] = [];
      for (let p = e.replyTo ? byId.get(e.replyTo) : undefined; p; p = p.replyTo ? byId.get(p.replyTo) : undefined) out.unshift(p.id);
      return out;
    };
    for (const e of seeds) {
      const inbox = MOCK_INBOXES[boxOf(e.box)];
      const self = { name: "Jordan Reyes", email: inbox.email_address };
      const outgoing = e.from === "You";
      const to = outgoing ? [{ name: "", email: e.to ?? "" }] : [self];
      if (e.isDraft) {
        const draft_id = e.id;
        this.drafts.set(this.draftKey(inbox.inbox_id, draft_id), {
          inbox_id: inbox.inbox_id,
          draft_id,
          subject: e.subject,
          to,
          cc: [],
          bcc: [],
          created_at: iso(e.ago),
          body_text: e.body,
          body_html: null,
          reply_to: null,
        });
        continue;
      }
      const folder =
        e.folder === "inbox" ? ALIAS_FOLDER.inbox : e.folder === "sent" ? ALIAS_FOLDER.sent : e.folder;
      const key = makeKey(inbox.inbox_id, e.id);
      this.messages.set(key, {
        inbox_id: inbox.inbox_id,
        id: e.id,
        from: outgoing ? self : { name: e.from, email: e.email },
        to,
        cc: [],
        subject: e.subject,
        date: iso(e.ago),
        preview: e.snippet,
        body_text: e.body,
        is_read: !e.unread,
        is_starred: false,
        has_attachments: e.id === "priya" || e.id === "dana-1" || !!SEED_RICH[e.id]?.attachments,
        folder,
        thread_id: `t-${chain(e)[0] ?? e.id}`,
        message_id_header: messageIdOf(e.id),
        in_reply_to: e.replyTo ? messageIdOf(e.replyTo) : null,
        references: chain(e).map(messageIdOf),
      });
      const h = hintsOf(e);
      if (h) this.hints.set(key, h);
    }

    for (const f of generateFiller()) {
      const inbox = MOCK_INBOXES[boxOf(f.box)];
      this.messages.set(makeKey(inbox.inbox_id, f.id), {
        inbox_id: inbox.inbox_id,
        id: f.id,
        from: { name: f.from, email: f.email },
        to: [{ name: "Jordan Reyes", email: inbox.email_address }],
        cc: [],
        subject: f.subject,
        date: iso(f.ago),
        preview: f.snippet,
        body_text: f.body,
        is_read: !f.unread,
        is_starred: false,
        has_attachments: f.has_attachments,
        folder: ALIAS_FOLDER.inbox,
        thread_id: `t-${f.id}`,
        message_id_header: messageIdOf(f.id),
        in_reply_to: null,
        references: [],
      });
    }
  }

  private requireInbox(inbox_id: string): Inbox {
    const inbox = this.inboxes.find((i) => i.inbox_id === inbox_id);
    if (!inbox) throw new Error("inbox_not_found");
    return inbox;
  }

  private self(inbox_id: string): EmailAddressEntry {
    return { name: "Jordan Reyes", email: this.requireInbox(inbox_id).email_address };
  }

  private draftKey(inbox_id: string, draft_id: string): string {
    return `${inbox_id}|${draft_id}`;
  }

  private scopeInboxes(scope: string, folder: FolderRef): string[] {
    const all = this.inboxes.map((i) => i.inbox_id);
    if (isExactRef(folder)) return all.includes(folder.inbox_id) ? [folder.inbox_id] : [];
    if (scope === "all") return all;
    return all.includes(scope) ? [scope] : [];
  }

  /** The concrete folder id a ref points at inside one inbox, or null. */
  private resolveFolder(inbox_id: string, ref: FolderRef): string | null {
    if (isExactRef(ref)) return ref.inbox_id === inbox_id ? ref.folder_id : null;
    if (isNameRef(ref)) return (CUSTOM_FOLDERS as readonly string[]).includes(ref.name) ? ref.name : null;
    if (ref.role === "starred" || ref.role === "scheduled") return null;
    return ALIAS_FOLDER[ref.role];
  }

  /** Every row of one folder of one inbox, newest first. */
  private rowsFor(inbox_id: string, folder: FolderRef, unread?: boolean): MessageRow[] {
    let rows: MessageRow[];
    if (isRoleRef(folder) && folder.role === "starred") {
      // No starred folder exists: this is a search with `flagged: true`.
      rows = this.allMessages()
        .filter((m) => m.inbox_id === inbox_id && m.is_starred && m.folder !== ALIAS_FOLDER.trash)
        .map((m) => this.toRow(m));
    } else if (isRoleRef(folder) && folder.role === "scheduled") {
      rows = this.scheduled.filter((s) => s.inbox_id === inbox_id).map((s) => this.scheduledRow(s));
    } else if (
      (isRoleRef(folder) && folder.role === "drafts") ||
      (isExactRef(folder) && folder.inbox_id === inbox_id && folder.folder_id === ALIAS_FOLDER.drafts)
    ) {
      rows = [...this.drafts.values()].filter((d) => d.inbox_id === inbox_id).map((d) => this.draftRow(d));
    } else {
      const id = this.resolveFolder(inbox_id, folder);
      rows = id
        ? this.allMessages()
            .filter((m) => m.inbox_id === inbox_id && m.folder === id)
            .map((m) => this.toRow(m))
        : [];
    }
    if (unread) rows = rows.filter((r) => !r.is_read);
    return rows.sort(byDateDesc);
  }

  private draftRow(d: DraftDetail): MessageRow {
    return {
      key: makeKey(d.inbox_id, d.draft_id),
      inbox_id: d.inbox_id,
      id: d.draft_id,
      from: this.self(d.inbox_id),
      to: d.to,
      subject: d.subject || "(no subject)",
      date: d.created_at,
      preview: d.body_text.replace(/\s+/g, " ").slice(0, 120),
      is_read: true,
      has_attachments: false,
      folder: ALIAS_FOLDER.drafts,
      thread_id: `t-${d.draft_id}`,
      is_starred: false,
      folder_role: "drafts",
    };
  }

  private scheduledRow(s: MockScheduled): MessageRow {
    return {
      key: makeKey(s.inbox_id, s.id),
      inbox_id: s.inbox_id,
      id: s.id,
      from: this.self(s.inbox_id),
      to: s.to.map((email) => ({ name: "", email })),
      subject: s.subject || "(no subject)",
      date: s.send_at,
      preview: s.body_text.replace(/\s+/g, " ").slice(0, 120),
      is_read: true,
      has_attachments: false,
      folder: "Scheduled",
      thread_id: `t-${s.id}`,
      is_starred: false,
      folder_role: "scheduled",
    };
  }

  private detailBase(key: MessageKey, inbox_id: string, id: string): MessageDetail {
    return {
      key,
      inbox_id,
      id,
      thread_id: `t-${id}`,
      from: { name: "", email: "" },
      to: [],
      cc: [],
      bcc: [],
      reply_to: null,
      subject: "",
      date: new Date(0).toISOString(),
      body_text: null,
      body_html: null,
      attachments: [],
      is_read: true,
      is_starred: false,
      labels: [],
      in_reply_to: null,
      references: [],
      folder: "",
      folder_role: null,
    };
  }

  private putDraft(input: DraftInput, keepId?: string): DraftRef {
    this.requireInbox(input.inbox_id);
    const draft_id = keepId ?? `d${this.seq++}`;
    this.drafts.set(this.draftKey(input.inbox_id, draft_id), {
      inbox_id: input.inbox_id,
      draft_id,
      subject: input.subject,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      created_at: new Date().toISOString(),
      body_text: input.body_text,
      body_html: null,
      reply_to: input.reply_to ?? null,
    });
    return { inbox_id: input.inbox_id, draft_id };
  }

  private deliver(
    inbox_id: string,
    to: EmailAddressEntry[],
    cc: EmailAddressEntry[],
    subject: string,
    body_text: string,
    /** The message being answered: the new one joins its conversation. */
    parent?: MockMessage,
  ): SendResult {
    const id = `s${this.seq++}`;
    this.messages.set(makeKey(inbox_id, id), {
      inbox_id,
      id,
      from: this.self(inbox_id),
      to,
      cc,
      subject: subject || "(no subject)",
      date: new Date().toISOString(),
      preview: body_text.replace(/\s+/g, " ").slice(0, 120),
      body_text,
      is_read: true,
      is_starred: false,
      has_attachments: false,
      folder: ALIAS_FOLDER.sent,
      thread_id: parent?.thread_id ?? `t-${id}`,
      message_id_header: messageIdOf(id),
      ...this.replyHeaders(parent),
    });
    return { message_id: id, inbox_id };
  }
}

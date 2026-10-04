// Provider stand-ins for assistant-tools.test.ts. No network, no socket.
//
// The shared fakes answer what the mail routes need. The assistant's tools
// also search with filters, move, archive and delete, so this file adds:
//
//   ScriptedImap   the scripted IMAP server plus UID MOVE / UID COPY /
//                  UID EXPUNGE and a UID SEARCH that evaluates the criteria
//                  the tool layer actually sent (and records them);
//   gmailMailbox   a Gmail whose labels really change on modify / trash;
//   graphMailbox   an Outlook (Graph) whose messages really move and change.
//
// Every one of them records what it was asked, so a test can assert that the
// value the model chose reached the provider and nothing else did.

import { FakeImapServer, type FakeMailbox, type FakeMessage } from "../../mcp-server/imap-fake-server.ts";
import * as harness from "../../mcp-server/provider-call-harness.ts";

const CRLF = "\r\n";

// ── IMAP ────────────────────────────────────────────────────────────────────

export function imapMessage(uid: number, options: {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  /** RFC 822 date, e.g. "15 Sep 2026 10:00:00 +0000". */
  date?: string;
  flags?: string[];
} = {}): FakeMessage {
  return {
    uid,
    flags: options.flags ?? [],
    raw: [
      `Date: ${options.date ?? "15 Sep 2026 10:00:00 +0000"}`,
      `From: ${options.from ?? `"Sender ${uid}" <sender${uid}@example.com>`}`,
      `To: ${options.to ?? "<owner@example.com>"}`,
      `Subject: ${options.subject ?? `Message ${uid}`}`,
      `Message-ID: <m${uid}@example.com>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      options.body ?? `Body of message ${uid}.`,
    ].join(CRLF),
  };
}

function header(raw: string, name: string): string {
  const head = raw.slice(0, raw.indexOf(CRLF + CRLF));
  const line = head.split(CRLF).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : "";
}

function bodyOf(raw: string): string {
  return raw.slice(raw.indexOf(CRLF + CRLF) + 4);
}

function parseUidSet(set: string): number[] {
  const out: number[] = [];
  for (const piece of set.split(",")) {
    const [a, b] = piece.split(":").map(Number);
    for (let n = a; n <= (b ?? a); n++) out.push(n);
  }
  return out;
}

function unquote(token: string): string {
  return token.startsWith('"') ? token.slice(1, -1).replace(/\\(.)/g, "$1") : token;
}

/** The messages an RFC 3501 SEARCH selects, or null for a key this fake does not know. */
function evaluateSearch(criteria: string, messages: FakeMessage[]): FakeMessage[] | null {
  const tokens = criteria.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
  let hits = messages.slice();
  const has = (text: string, needle: string) => text.toLowerCase().includes(needle.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i].toUpperCase();
    const arg = () => unquote(tokens[++i] ?? "");
    if (key === "ALL") continue;
    else if (key === "UNSEEN") hits = hits.filter((m) => !m.flags.includes("\\Seen"));
    else if (key === "SEEN") hits = hits.filter((m) => m.flags.includes("\\Seen"));
    else if (key === "FLAGGED") hits = hits.filter((m) => m.flags.includes("\\Flagged"));
    else if (key === "UNDELETED") hits = hits.filter((m) => !m.flags.includes("\\Deleted"));
    else if (key === "FROM" || key === "TO" || key === "CC" || key === "SUBJECT") {
      const needle = arg();
      hits = hits.filter((m) => has(header(m.raw, key), needle));
    } else if (key === "BODY") {
      const needle = arg();
      hits = hits.filter((m) => has(bodyOf(m.raw), needle));
    } else if (key === "TEXT") {
      const needle = arg();
      hits = hits.filter((m) => has(m.raw, needle));
    } else if (key === "SINCE" || key === "BEFORE") {
      const day = Date.parse(`${arg().replace(/-/g, " ")} 00:00:00 +0000`);
      if (Number.isNaN(day)) return null;
      hits = hits.filter((m) => {
        const at = Date.parse(header(m.raw, "Date"));
        return key === "SINCE" ? at >= day : at < day;
      });
    } else if (key === "UID") {
      const wanted = new Set(parseUidSet(arg()));
      hits = hits.filter((m) => wanted.has(m.uid));
    } else return null;
  }
  return hits;
}

export interface ImapWorld {
  mailboxes: FakeMailbox[];
  /** Every UID SEARCH as the tool layer wrote it, with the mailbox it ran in. */
  searches: Array<{ mailbox: string; criteria: string }>;
  /** Every UID MOVE / UID COPY, expanded. */
  moves: Array<{ verb: "MOVE" | "COPY"; from: string; to: string; uids: number[] }>;
  /** Every UID STORE that set or cleared flags. */
  stores: Array<{ mailbox: string; uids: number[]; mode: "+" | "-"; flags: string[] }>;
  /** Messages removed for good (EXPUNGE). Must stay empty for the assistant. */
  expunged: Array<{ mailbox: string; uid: number }>;
  /** Every command of every connection, in order. */
  commands: string[];
}

export function imapWorld(mailboxes: FakeMailbox[]): ImapWorld {
  return { mailboxes, searches: [], moves: [], stores: [], expunged: [], commands: [] };
}

/** `makeServer` for FakeDialPool: one mailbox state shared by every connection. */
export function scriptedImap(world: ImapWorld): () => FakeImapServer & { advertised: string[] } {
  const advertised = ["IMAP4REV1", "MOVE", "UIDPLUS"];
  return () => {
    let selected: FakeMailbox | null = null;
    const find = (name: string) =>
      world.mailboxes.find((m) => m.name === name || (m.name.toUpperCase() === "INBOX" && name.toUpperCase() === "INBOX"));
    const nextUid = (box: FakeMailbox) => box.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1;

    const server = new FakeImapServer({
      mailboxes: world.mailboxes,
      capabilities: advertised,
      onCommand: (command) => {
        world.commands.push(command);
        const select = /^SELECT (.+)$/i.exec(command);
        if (select) selected = find(unquote(select[1].trim())) ?? null;
        const store = /^UID STORE (\S+) ([+-])FLAGS(?:\.SILENT)? \(([^)]*)\)$/i.exec(command);
        if (store && selected) {
          world.stores.push({
            mailbox: selected.name,
            uids: parseUidSet(store[1]),
            mode: store[2] as "+" | "-",
            flags: store[3].split(/\s+/).filter(Boolean),
          });
        }
      },
      // "refuse" is the fake's hook for answering a command itself: the string
      // is the tagged reply. Used here to ADD commands, not to refuse them.
      refuse: (command) => {
        const transfer = /^UID (MOVE|COPY) (\S+) (.+)$/i.exec(command);
        if (transfer) {
          const verb = transfer[1].toUpperCase() as "MOVE" | "COPY";
          if (!selected) return "BAD No mailbox selected";
          const target = find(unquote(transfer[3].trim()));
          if (!target) return "NO [TRYCREATE] Mailbox does not exist";
          const source = selected;
          const uids = parseUidSet(transfer[2]).filter((uid) => source.messages.some((m) => m.uid === uid));
          const created: number[] = [];
          for (const uid of uids) {
            const message = source.messages.find((m) => m.uid === uid)!;
            const copy = { ...message, flags: message.flags.slice(), uid: nextUid(target) };
            target.messages.push(copy);
            created.push(copy.uid);
            if (verb === "MOVE") source.messages = source.messages.filter((m) => m.uid !== uid);
          }
          world.moves.push({ verb, from: source.name, to: target.name, uids });
          return uids.length > 0
            ? `OK [COPYUID 1 ${uids.join(",")} ${created.join(",")}] ${verb} completed`
            : `OK ${verb} completed`;
        }
        const expunge = /^UID EXPUNGE (\S+)$/i.exec(command);
        if (expunge || /^EXPUNGE$/i.test(command)) {
          if (!selected) return "BAD No mailbox selected";
          const box = selected;
          const wanted = expunge ? new Set(parseUidSet(expunge[1])) : null;
          const gone = box.messages.filter((m) => m.flags.includes("\\Deleted") && (!wanted || wanted.has(m.uid)));
          for (const m of gone) world.expunged.push({ mailbox: box.name, uid: m.uid });
          box.messages = box.messages.filter((m) => !gone.includes(m));
          return "OK EXPUNGE completed";
        }
        return null;
      },
    });

    // A UID SEARCH the base fake cannot evaluate is evaluated here and handed
    // on as the `UID <set>` form it does understand. The criteria the tool
    // layer wrote are kept in `world.searches`.
    const baseConn = server.conn.bind(server);
    server.conn = () => {
      const inner = baseConn();
      return {
        ...inner,
        write: (p: Uint8Array) => {
          const text = new TextDecoder("latin1").decode(p);
          const rewritten = text.replace(/^(\S+) UID SEARCH (.+)$/gm, (line, tag: string, rest: string) => {
            // `.` stops at the CR, so `rest` is the criteria and the CRLF stays in place.
            const criteria = rest;
            world.searches.push({ mailbox: selected?.name ?? "", criteria });
            if (/^(ALL|UNSEEN|SEEN)$/.test(criteria) || /^UID \S+$/.test(criteria)) return line;
            const hits = selected ? evaluateSearch(criteria, selected.messages) : null;
            if (hits === null) return line; // the base fake answers BAD: the test fails loudly
            return `${tag} UID SEARCH UID ${hits.length > 0 ? hits.map((m) => m.uid).join(",") : "0"}`;
          });
          const bytes = new Uint8Array(rewritten.length);
          for (let i = 0; i < rewritten.length; i++) bytes[i] = rewritten.charCodeAt(i) & 0xff;
          return inner.write(bytes).then(() => p.length);
        },
      };
    };
    return Object.assign(server, { advertised });
  };
}

// ── Gmail ───────────────────────────────────────────────────────────────────

export interface GmailMailbox {
  messages: harness.FakeGmailMessage[];
  labels: Array<{ id: string; name: string; type: "system" | "user" }>;
  drafts: Array<{ id: string; message: harness.FakeGmailMessage }>;
  /** `q` of every messages.list, in order. */
  queries: string[];
  /** `labelIds` of every messages.list, in order. */
  listedLabels: string[][];
  /** Every label change: one entry per message. */
  modified: Array<{ id: string; add: string[]; remove: string[] }>;
  trashed: string[];
  /** Permanent deletions. Must stay empty for the assistant. */
  deleted: string[];
  unscripted: string[];
}

export function gmailMailbox(messages: harness.FakeGmailMessage[]): GmailMailbox {
  return {
    messages,
    labels: [
      ...["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "STARRED", "UNREAD", "IMPORTANT"].map((id) => ({ id, name: id, type: "system" as const })),
      { id: "Label_7", name: "Projects", type: "user" as const },
    ],
    drafts: [],
    queries: [],
    listedLabels: [],
    modified: [],
    trashed: [],
    deleted: [],
    unscripted: [],
  };
}

function gmailMatches(m: harness.FakeGmailMessage, q: string): boolean {
  const labels = m.labelIds ?? ["INBOX"];
  const has = (text: string | undefined, needle: string) => (text ?? "").toLowerCase().includes(needle.toLowerCase());
  const day = (value: string) => Date.parse(`${value.replace(/\//g, "-")}T00:00:00Z`);
  const at = Number(m.internalDate ?? "1767225600000");
  for (const token of q.match(/[\w-]+:(?:"[^"]*"|\([^)]*\)|\S+)|"[^"]*"|\S+/g) ?? []) {
    const op = /^([\w-]+):(.*)$/.exec(token);
    const value = (op ? op[2] : token).replace(/^["(]|[")]$/g, "");
    if (!op) {
      if (!has(`${m.subject} ${m.text} ${m.from} ${m.snippet}`, value)) return false;
    } else if (op[1] === "from") {
      if (!has(m.from, value)) return false;
    } else if (op[1] === "to") {
      if (!has(m.to, value)) return false;
    } else if (op[1] === "cc") {
      if (!has(m.cc, value)) return false;
    } else if (op[1] === "subject") {
      if (!has(m.subject, value)) return false;
    } else if (op[1] === "is" && value === "unread") {
      if (!labels.includes("UNREAD")) return false;
    } else if (op[1] === "is" && value === "read") {
      if (labels.includes("UNREAD")) return false;
    } else if (op[1] === "is" && value === "starred") {
      if (!labels.includes("STARRED")) return false;
    } else if (op[1] === "has" && value === "attachment") {
      if ((m.attachments?.length ?? 0) === 0) return false;
    } else if (op[1] === "after") {
      if (!(at >= day(value))) return false;
    } else if (op[1] === "before") {
      if (!(at < day(value))) return false;
    }
    // in:, label:, -in: and friends are recorded in `queries`, not evaluated.
  }
  return true;
}

export function gmailHandler(box: GmailMailbox): harness.ProviderHandler {
  const apply = (id: string, add: string[], remove: string[]) => {
    const message = box.messages.find((m) => m.id === id);
    box.modified.push({ id, add, remove });
    if (!message) return false;
    const labels = new Set(message.labelIds ?? ["INBOX"]);
    for (const l of remove) labels.delete(l);
    for (const l of add) labels.add(l);
    message.labelIds = [...labels];
    return true;
  };
  const notFound = () => harness.json({ error: { code: 404, message: "Requested entity was not found." } }, 404);

  return async (call) => {
    await Promise.resolve();
    const url = new URL(call.url);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const body = call.body ? JSON.parse(call.body) as Record<string, unknown> : {};
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

    if (call.method === "GET" && path === "/profile") {
      return harness.json({ emailAddress: "owner@gmail-harness.example", historyId: "9001" });
    }
    if (call.method === "GET" && path === "/labels") return harness.json({ labels: box.labels });
    if (call.method === "GET" && path.startsWith("/labels/")) {
      const id = decodeURIComponent(path.slice("/labels/".length));
      const label = box.labels.find((l) => l.id === id);
      if (!label) return notFound();
      const inLabel = box.messages.filter((m) => (m.labelIds ?? ["INBOX"]).includes(id));
      return harness.json({
        ...label,
        messagesTotal: inLabel.length,
        messagesUnread: inLabel.filter((m) => (m.labelIds ?? []).includes("UNREAD")).length,
      });
    }
    if (call.method === "GET" && path === "/settings/sendAs") {
      return harness.json({ sendAs: [{ sendAsEmail: "owner@gmail-harness.example", isPrimary: true, isDefault: true }] });
    }
    if (call.method === "GET" && path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      const labelIds = url.searchParams.getAll("labelIds");
      box.queries.push(q);
      box.listedLabels.push(labelIds);
      const hits = box.messages
        .filter((m) => labelIds.every((l) => (m.labelIds ?? ["INBOX"]).includes(l)))
        .filter((m) => !(m.labelIds ?? []).includes("TRASH") || labelIds.includes("TRASH") || /in:(trash|anywhere)/.test(q))
        .filter((m) => gmailMatches(m, q));
      return harness.json({ messages: hits.map((m) => ({ id: m.id, threadId: `thread-${m.id}` })), resultSizeEstimate: hits.length });
    }
    if (call.method === "POST" && path === "/messages/batchModify") {
      for (const id of strings(body["ids"])) apply(id, strings(body["addLabelIds"]), strings(body["removeLabelIds"]));
      return new Response(null, { status: 204 });
    }
    if (call.method === "POST" && path === "/messages/batchDelete") {
      box.deleted.push(...strings(body["ids"]));
      return new Response(null, { status: 204 });
    }
    const one = /^\/messages\/([^/]+)(?:\/(modify|trash|untrash))?$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const message = box.messages.find((m) => m.id === id);
      if (call.method === "DELETE") {
        box.deleted.push(id);
        return new Response(null, { status: 204 });
      }
      if (!message) return notFound();
      if (call.method === "GET" && !one[2]) {
        return harness.json(url.searchParams.get("format") === "metadata" ? harness.gmailMeta(message) : harness.gmailFull(message));
      }
      if (call.method === "POST" && one[2] === "modify") {
        apply(id, strings(body["addLabelIds"]), strings(body["removeLabelIds"]));
        return harness.json({ id, threadId: `thread-${id}`, labelIds: message.labelIds });
      }
      if (call.method === "POST" && one[2] === "trash") {
        box.trashed.push(id);
        message.labelIds = [...(message.labelIds ?? []).filter((l) => l !== "INBOX"), "TRASH"];
        return harness.json({ id, threadId: `thread-${id}`, labelIds: message.labelIds });
      }
    }
    if (call.method === "GET" && path === "/drafts") {
      return harness.json({ drafts: box.drafts.map((d) => ({ id: d.id, message: { id: d.message.id, threadId: `thread-${d.message.id}` } })) });
    }
    const draft = /^\/drafts\/([^/]+)$/.exec(path);
    if (call.method === "GET" && draft) {
      const hit = box.drafts.find((d) => d.id === decodeURIComponent(draft[1]));
      if (!hit) return notFound();
      const full = url.searchParams.get("format") === "metadata" ? harness.gmailMeta(hit.message) : harness.gmailFull(hit.message);
      return harness.json({ id: hit.id, message: full });
    }
    box.unscripted.push(`${call.method} ${url.pathname}${url.search}`);
    return harness.json({ error: { code: 404, message: `unscripted ${call.method} ${path}` } }, 404);
  };
}

// ── Outlook (Microsoft Graph) ───────────────────────────────────────────────

export interface GraphItem {
  id: string;
  folder: string;
  subject: string;
  from: { name: string; address: string };
  isRead: boolean;
  flagged: boolean;
  hasAttachments?: boolean;
  receivedDateTime: string;
  text: string;
  isDraft?: boolean;
}

export interface GraphMailbox {
  items: GraphItem[];
  folders: Array<{ id: string; displayName: string; wellKnown?: string }>;
  /** `$search`, `$filter`, folder segment, `$top`, `$skip` of every message listing. */
  listings: Array<{ folder: string | null; search: string | null; filter: string | null; top: string | null; skip: string | null }>;
  patches: Array<{ id: string; body: Record<string, unknown> }>;
  moves: Array<{ id: string; destinationId: string }>;
  /** Permanent deletions. Must stay empty for the assistant. */
  deleted: string[];
  unscripted: string[];
}

export function graphMailbox(items: GraphItem[]): GraphMailbox {
  return {
    items,
    folders: [
      { id: "fid-inbox", displayName: "Inbox", wellKnown: "inbox" },
      { id: "fid-archive", displayName: "Archive", wellKnown: "archive" },
      { id: "fid-trash", displayName: "Deleted Items", wellKnown: "deleteditems" },
      { id: "fid-drafts", displayName: "Drafts", wellKnown: "drafts" },
      { id: "fid-sent", displayName: "Sent Items", wellKnown: "sentitems" },
      { id: "fid-junk", displayName: "Junk Email", wellKnown: "junkemail" },
      { id: "fid-projects", displayName: "Projects" },
    ],
    listings: [],
    patches: [],
    moves: [],
    deleted: [],
    unscripted: [],
  };
}

export function graphHandler(box: GraphMailbox): harness.ProviderHandler {
  const folderOf = (segment: string) => {
    const s = decodeURIComponent(segment);
    return box.folders.find((f) => f.id === s || f.wellKnown === s.toLowerCase() || f.displayName.toLowerCase() === s.toLowerCase());
  };
  const wire = (m: GraphItem) => ({
    id: m.id,
    conversationId: `conv-${m.id}`,
    parentFolderId: m.folder,
    subject: m.subject,
    from: { emailAddress: m.from },
    sender: { emailAddress: m.from },
    toRecipients: [{ emailAddress: { name: "Harness Owner", address: "owner@outlook-harness.example" } }],
    ccRecipients: [],
    bccRecipients: [],
    replyTo: [],
    receivedDateTime: m.receivedDateTime,
    sentDateTime: m.receivedDateTime,
    lastModifiedDateTime: m.receivedDateTime,
    bodyPreview: m.text.slice(0, 120),
    body: { contentType: "text", content: m.text },
    uniqueBody: { contentType: "text", content: m.text },
    isRead: m.isRead,
    isDraft: m.isDraft ?? false,
    hasAttachments: m.hasAttachments ?? false,
    flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
    internetMessageId: `<${m.id}@outlook-harness.example>`,
    internetMessageHeaders: [],
    categories: [],
  });
  const folderWire = (f: GraphMailbox["folders"][number]) => {
    const inside = box.items.filter((m) => m.folder === f.id);
    return {
      id: f.id,
      displayName: f.displayName,
      parentFolderId: "fid-root",
      childFolderCount: 0,
      totalItemCount: inside.length,
      unreadItemCount: inside.filter((m) => !m.isRead).length,
      ...(f.wellKnown ? { wellKnownName: f.wellKnown } : {}),
    };
  };

  const answer = (method: string, href: string, bodyText: string | null): { status: number; body: unknown } => {
    const url = new URL(href, "https://graph.microsoft.com");
    const path = url.pathname.replace(/^\/v1\.0/, "").replace(/^\/me/, "");
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
    const notFound = { status: 404, body: { error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } } };

    if (method === "GET" && (path === "" || path === "/")) {
      return { status: 200, body: { mail: "owner@outlook-harness.example", userPrincipalName: "owner@outlook-harness.example" } };
    }
    if (method === "GET" && /^\/mailFolders(\/delta)?$/.test(path)) {
      return { status: 200, body: { value: box.folders.map(folderWire) } };
    }
    const childFolders = /^\/mailFolders\/([^/]+)\/childFolders$/.exec(path);
    if (method === "GET" && childFolders) return { status: 200, body: { value: [] } };
    const folderMessages = /^\/mailFolders\/([^/]+)\/messages$/.exec(path);
    if (method === "GET" && (folderMessages || path === "/messages")) {
      const folder = folderMessages ? folderOf(folderMessages[1]) : null;
      if (folderMessages && !folder) return notFound;
      const search = url.searchParams.get("$search");
      const filter = url.searchParams.get("$filter");
      const top = url.searchParams.get("$top");
      const skip = url.searchParams.get("$skip");
      box.listings.push({ folder: folder?.id ?? null, search, filter, top, skip });
      let hits = box.items.filter((m) => !folder || m.folder === folder.id);
      if (filter) {
        if (/isRead eq false/.test(filter)) hits = hits.filter((m) => !m.isRead);
        if (/isRead eq true/.test(filter)) hits = hits.filter((m) => m.isRead);
        if (/flag\/flagStatus eq 'flagged'/.test(filter)) hits = hits.filter((m) => m.flagged);
        if (/hasAttachments eq true/.test(filter)) hits = hits.filter((m) => m.hasAttachments === true);
        const ge = /receivedDateTime ge (\S+)/.exec(filter);
        if (ge) hits = hits.filter((m) => Date.parse(m.receivedDateTime) >= Date.parse(ge[1]));
        const lt = /receivedDateTime lt (\S+)/.exec(filter);
        if (lt) hits = hits.filter((m) => Date.parse(m.receivedDateTime) < Date.parse(lt[1]));
      }
      if (search) {
        const kql = search.replace(/^"|"$/g, "").replace(/\\"/g, '"');
        for (const clause of kql.split(/ AND /)) {
          const op = /^(\w+):(.*)$/.exec(clause.trim());
          const needle = (op ? op[2] : clause).replace(/^["(]+|[")]+$/g, "").toLowerCase();
          hits = hits.filter((m) => {
            const hay = !op
              ? `${m.subject} ${m.text} ${m.from.name} ${m.from.address}`
              : op[1] === "from"
              ? `${m.from.name} ${m.from.address}`
              : op[1] === "subject"
              ? m.subject
              : op[1] === "body"
              ? m.text
              : op[1] === "to"
              ? "owner@outlook-harness.example Harness Owner"
              : "";
            return hay.toLowerCase().includes(needle);
          });
        }
      }
      const from = Number(skip ?? "0");
      const size = Number(top ?? "50");
      return { status: 200, body: { value: hits.slice(from, from + size).map(wire) } };
    }
    const folderOne = /^\/mailFolders\/([^/]+)$/.exec(path);
    if (method === "GET" && folderOne) {
      const folder = folderOf(folderOne[1]);
      return folder ? { status: 200, body: folderWire(folder) } : notFound;
    }
    const move = /^\/messages\/([^/]+)\/move$/.exec(path);
    if (method === "POST" && move) {
      const id = decodeURIComponent(move[1]);
      const message = box.items.find((m) => m.id === id);
      const destinationId = String(body["destinationId"] ?? "");
      box.moves.push({ id, destinationId });
      const target = folderOf(destinationId);
      if (!message || !target) return notFound;
      message.folder = target.id;
      // Graph gives a moved message a new id.
      message.id = `${id}-moved`;
      return { status: 201, body: wire(message) };
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const message = box.items.find((m) => m.id === id);
      if (method === "DELETE") {
        box.deleted.push(id);
        return { status: 204, body: null };
      }
      if (!message) return notFound;
      if (method === "GET") return { status: 200, body: wire(message) };
      if (method === "PATCH") {
        box.patches.push({ id, body });
        if (typeof body["isRead"] === "boolean") message.isRead = body["isRead"];
        const flag = body["flag"] as { flagStatus?: string } | undefined;
        if (flag?.flagStatus) message.flagged = flag.flagStatus === "flagged";
        return { status: 200, body: wire(message) };
      }
    }
    const attachments = /^\/messages\/([^/]+)\/attachments$/.exec(path);
    if (method === "GET" && attachments) return { status: 200, body: { value: [] } };
    if (method === "GET" && /^\/(people|contacts)$/.test(path)) return { status: 200, body: { value: [] } };
    box.unscripted.push(`${method} ${url.pathname}${url.search}`);
    return { status: 404, body: { error: { code: "unscripted", message: `unscripted ${method} ${path}` } } };
  };

  return async (call) => {
    await Promise.resolve();
    const url = new URL(call.url);
    if (call.method === "POST" && url.pathname.endsWith("/$batch")) {
      const requests = (JSON.parse(call.body ?? "{}") as { requests?: Array<{ id: string; method: string; url: string; body?: unknown }> }).requests ?? [];
      return harness.json({
        responses: requests.map((r) => {
          const out = answer(r.method.toUpperCase(), r.url, r.body === undefined ? null : JSON.stringify(r.body));
          return { id: r.id, status: out.status, headers: { "content-type": "application/json" }, body: out.body };
        }),
      });
    }
    const out = answer(call.method, call.url, call.body);
    return out.body === null ? new Response(null, { status: out.status }) : harness.json(out.body, out.status);
  };
}

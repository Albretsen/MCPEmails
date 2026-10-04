// ---------------------------------------------------------------------------
// A scripted IMAP server for tests. NOT imported by index.ts or by anything
// index.ts imports, so it is never bundled into the deployed function.
//
// The other IMAP test files each carry a small socket that answers one or two
// canned lines, which is the right tool for pinning one command. The latency
// work of 2026-10-02 needs to ask a different question, "how many commands and
// how many round trips does this tool spend, and is its answer unchanged?",
// and that needs a server that holds a mailbox and answers whatever it is
// asked from it: SELECT, UID SEARCH, FETCH by sequence and by UID, LIST (with
// and without RETURN (STATUS ...)), STATUS, CAPABILITY and LOGOUT.
//
// What it counts:
//   * `commands`   every command line received, tag stripped.
//   * `roundTrips` every write that carried at least one complete command. A
//                  pipelined write of twelve STATUS commands is ONE round trip,
//                  which is the whole point of pipelining them.
//
// It models one thing real servers do that matters here: the sequence numbers
// of a selected mailbox are a snapshot taken at SELECT. A message removed
// behind the client's back keeps its sequence number until the server is
// allowed to say EXPUNGE, and a FETCH that names it either leaves it out of
// the reply (Dovecot, Gmail) or answers NO (RFC 2180 4.1.2).
//
// No real mailbox data: every address in a fixture is under example.com.
// ---------------------------------------------------------------------------

import { ImapClient } from "./imap-client.ts";
import { bytesToByteString } from "./byte-string.ts";
import { decodeEncodedWords, decodeRawHeaderOctets, parseContentType, parseHeaders } from "./mime.ts";
import { decodeModifiedUtf7, encodeModifiedUtf7 } from "./utf7.ts";

export interface FakeMessage {
  uid: number;
  flags: string[];
  /** The raw RFC 822 message, one character per octet. */
  raw: string;
  /**
   * Gmail's ids and labels (X-GM-THRID, X-GM-MSGID, X-GM-LABELS), answered when
   * a FETCH asks for them and searched by `X-GM-THRID <id>`. Labels are given
   * as they go on the wire (`\\Inbox`, `"My label"` unquoted here).
   */
  gmThreadId?: string;
  gmMessageId?: string;
  gmLabels?: string[];
}

export interface FakeMailbox {
  name: string;
  /** LIST attributes, e.g. ["\\HasNoChildren", "\\Sent"]. */
  attrs?: string[];
  messages: FakeMessage[];
  /** STATUS answers NO for this mailbox (and LIST-STATUS leaves it out). */
  statusFails?: boolean;
  /** When set, STATUS reports it as HIGHESTMODSEQ and a UID STORE bumps it. */
  modSeq?: number;
}

export interface FakeServerOptions {
  mailboxes: FakeMailbox[];
  /** What CAPABILITY answers. */
  capabilities?: string[];
  /** Honour `LIST ... RETURN (STATUS (...))`. When false it is answered BAD. */
  listStatus?: boolean;
  /** What a FETCH does with a message expunged since SELECT. Default "omit". */
  expungedFetch?: "omit" | "no";
  /** Leave the `* n EXISTS` line out of a SELECT reply. */
  omitExists?: boolean;
  /** `false`: UID MOVE succeeds but reports no COPYUID (a server without UIDPLUS). */
  uidplus?: boolean;
  /** Runs before a command is answered; may mutate the mailboxes. */
  onCommand?: (command: string, server: FakeImapServer) => void;
  /** A tagged reply ("NO ...") to send INSTEAD of answering, or null. */
  refuse?: (command: string) => string | null;
  /** Rewrites the mailbox name on a `* STATUS` line. */
  statusName?: (name: string) => string;
  /** Answer the commands of one pipelined write in reverse order. */
  reversePipelined?: boolean;
  /** Receive LOGOUT but say nothing until `answerLogout()` is called. */
  holdLogout?: boolean;
  /**
   * A write carrying a command this returns true for is answered LATE: the
   * server goes quiet, and its replies arrive in front of the answer to
   * whatever the client writes next. This is what a read timeout leaves
   * behind on a real socket.
   */
  stall?: (command: string) => boolean;
  /** How long a read waits for the server before failing. Default 2000. */
  readTimeoutMs?: number;
  /**
   * `UID SEARCH` with a HEADER key answers OK with no hits, whatever is asked:
   * what Migadu does. Added for client-api's `thread` op tests.
   */
  headerSearchBroken?: boolean;
  /**
   * What Migadu really does (found live 2026-10-04): `HEADER Message-ID`
   * matches, while a `HEADER References` or `HEADER In-Reply-To` key silently
   * matches nothing. An OR of the three therefore finds the message itself and
   * none of its replies.
   */
  headerReferencesSearchBroken?: boolean;
  /**
   * A search rate limit: after this many UID SEARCH commands (counted across
   * every connection sharing this options object's `searchCount`), each further
   * one is answered `NO [LIMIT] ...` and the connection stays open and in sync.
   */
  searchLimit?: number;
  /** Shared counter for `searchLimit`; pass one object to every connection. */
  searchCount?: { n: number };
  /** Every UID SEARCH is answered this many milliseconds late. */
  searchDelayMs?: number;
  /** `UID SEARCH CHARSET ...` is answered NO [BADCHARSET]. */
  rejectCharset?: boolean;
  /** `false`: a `{n}` at the end of a UID SEARCH line is not treated as a literal. */
  clientLiterals?: boolean;
}

const CRLF = "\r\n";

function octets(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function nstring(value: string | null): string {
  return value === null || value === "" ? "NIL" : quote(value);
}

/** Parse one quoted or bare argument off the front of `rest`. */
function takeArgument(rest: string): { value: string; rest: string } {
  const text = rest.replace(/^ +/, "");
  if (!text.startsWith('"')) {
    const end = text.search(/[ (]/);
    return end === -1
      ? { value: text, rest: "" }
      : { value: text.slice(0, end), rest: text.slice(end) };
  }
  let value = "";
  let i = 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === "\\") i++;
    value += text[i];
    i++;
  }
  return { value, rest: text.slice(i + 1) };
}

function parseSet(set: string, largest: number): number[] {
  const out: number[] = [];
  for (const piece of set.split(",")) {
    const [a, b] = piece.split(":");
    const lo = a === "*" ? largest : Number(a);
    const hi = b === undefined ? lo : b === "*" ? largest : Number(b);
    for (let n = Math.min(lo, hi); n <= Math.max(lo, hi); n++) out.push(n);
  }
  return out;
}

function addressList(value: string | null): string {
  if (!value) return "NIL";
  const entries = value.split(",").map((part) => {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^@>]+)@([^>]+)>\s*$/.exec(part) ??
      /^\s*()([^@\s]+)@(\S+)\s*$/.exec(part);
    if (!m) return null;
    return `(${nstring(m[1]?.trim() ?? "")} NIL ${quote(m[2])} ${quote(m[3])})`;
  }).filter((entry): entry is string => entry !== null);
  return entries.length > 0 ? `(${entries.join("")})` : "NIL";
}

/** A header value as a person reads it: raw 8-bit octets and RFC 2047 words decoded. */
function headerText(value: string): string {
  return decodeEncodedWords(decodeRawHeaderOctets(value));
}

/** One header field exactly as the message has it, folding included, or null. */
function rawHeaderField(head: string, name: string): string | null {
  const lines = head.split(CRLF);
  const prefix = `${name.toLowerCase()}:`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().startsWith(prefix)) continue;
    let end = i + 1;
    while (end < lines.length && /^[ \t]/.test(lines[end])) end++;
    return lines.slice(i, end).join(CRLF);
  }
  return null;
}

/** The octets of a client literal (one character each) as the UTF-8 text they spell. */
function literalText(octetString: string): string {
  const bytes = new Uint8Array(octetString.length);
  for (let i = 0; i < octetString.length; i++) bytes[i] = octetString.charCodeAt(i) & 0xff;
  return new TextDecoder("utf-8").decode(bytes);
}

function splitRaw(raw: string): { head: string; body: string } {
  const at = raw.indexOf("\r\n\r\n");
  return at === -1 ? { head: raw, body: "" } : { head: raw.slice(0, at), body: raw.slice(at + 4) };
}

function envelopeOf(raw: string): string {
  const headers = parseHeaders(splitRaw(raw).head);
  const first = (name: string) => headers.get(name)?.[0] ?? null;
  const from = addressList(first("from"));
  return "(" + [
    nstring(first("date")),
    nstring(first("subject")),
    from,
    from,
    from,
    addressList(first("to")),
    addressList(first("cc")),
    "NIL",
    nstring(first("in-reply-to")),
    nstring(first("message-id")),
  ].join(" ") + ")";
}

function childParts(body: string, boundary: string): string[] {
  return body.split(`--${boundary}`)
    .filter((segment) => segment !== "" && !segment.startsWith("--") && segment.trim() !== "")
    .map((segment) => segment.replace(/^\r\n/, "").replace(/\r\n$/, ""));
}

function bodyStructureOf(source: string): string {
  const { head, body } = splitRaw(source);
  const headers = parseHeaders(head);
  const type = parseContentType(headers.get("content-type")?.[0] ?? null);
  const [major, minor] = type.mediaType.toUpperCase().split("/");
  if (major === "MULTIPART" && type.params["boundary"]) {
    const children = childParts(body, type.params["boundary"]).map(bodyStructureOf).join("");
    return `(${children} ${quote(minor)})`;
  }
  const params = Object.entries(type.params)
    .map(([key, value]) => `${quote(key.toUpperCase())} ${quote(value)}`).join(" ");
  const encoding = (headers.get("content-transfer-encoding")?.[0] ?? "7BIT").toUpperCase();
  const disposition = headers.get("content-disposition")?.[0] ?? null;
  const fields = [
    quote(major),
    quote(minor ?? "PLAIN"),
    params ? `(${params})` : "NIL",
    "NIL",
    "NIL",
    quote(encoding),
    String(body.length),
  ];
  if (major === "TEXT") fields.push(String(body.split("\r\n").length));
  if (disposition) fields.push("NIL", `(${quote(disposition.split(";")[0].trim().toUpperCase())} NIL)`);
  return `(${fields.join(" ")})`;
}

/** What `BODY[1]` addresses: the body of part one, without its headers. */
function partOneOf(raw: string): string {
  const { head, body } = splitRaw(raw);
  const type = parseContentType(parseHeaders(head).get("content-type")?.[0] ?? null);
  if (type.mediaType.startsWith("multipart/") && type.params["boundary"]) {
    const first = childParts(body, type.params["boundary"])[0] ?? "";
    return splitRaw(first).body;
  }
  return body;
}

/**
 * A small evaluator for the UID SEARCH keys client-api's `thread` op sends:
 * `OR a b`, `HEADER <field> <string>`, `SUBJECT <string>`, `SINCE <date>`,
 * with juxtaposition meaning AND. Returns null for anything else.
 */
function searchPredicate(
  criteria: string,
  quirks: { headerReferencesSearchBroken?: boolean } = {},
): ((message: FakeMessage) => boolean) | null {
  let rest = criteria;
  const word = (): string => {
    const arg = takeArgument(rest);
    rest = arg.rest;
    return arg.value;
  };
  const header = (message: FakeMessage, name: string): string =>
    (parseHeaders(splitRaw(message.raw).head).get(name.toLowerCase()) ?? []).join(" ");
  const key = (): ((message: FakeMessage) => boolean) | null => {
    const name = word().toUpperCase();
    if (name === "OR") {
      const a = key();
      const b = key();
      return a && b ? (m) => a(m) || b(m) : null;
    }
    if (name === "HEADER") {
      const field = word();
      const value = word().toLowerCase();
      if (quirks.headerReferencesSearchBroken && /^(references|in-reply-to)$/i.test(field)) return () => false;
      return (m) => header(m, field).toLowerCase().includes(value);
    }
    if (name === "X-GM-THRID") {
      const id = word();
      return (m) => m.gmThreadId === id;
    }
    if (name === "SUBJECT") {
      // Compared as text, the way a server that honours CHARSET does.
      const value = word().toLowerCase();
      return (m) => headerText(header(m, "subject")).toLowerCase().includes(value);
    }
    if (name === "SINCE") {
      const at = Date.parse(`${word().replace(/-/g, " ")} 00:00:00 +0000`);
      return (m) => Date.parse(header(m, "date")) >= at;
    }
    if (name === "ALL") return () => true;
    return null;
  };
  const all: Array<(message: FakeMessage) => boolean> = [];
  while (rest.trim() !== "") {
    const next = key();
    if (!next) return null;
    all.push(next);
  }
  return all.length > 0 ? (m) => all.every((p) => p(m)) : null;
}

export class FakeImapServer {
  /** Every command received, tag stripped, in arrival order. */
  readonly commands: string[] = [];
  /** Writes that carried at least one complete command. */
  roundTrips = 0;
  /** True once the client closed the socket. */
  closed = false;
  /** True once LOGOUT has been received. */
  logoutReceived = false;
  readonly mailboxes: FakeMailbox[];

  readonly #options: FakeServerOptions;
  #inbound: number[] = [];
  #partial = "";
  /** A command line still being assembled across a client literal. */
  #pendingLine = "";
  /** Octets of a client literal still to arrive, or -1 when none is expected. */
  #literalLeft = -1;
  #wake: (() => void) | null = null;
  #selected: { mailbox: FakeMailbox; uids: number[] } | null = null;
  #heldLogoutTag: string | null = null;
  #late = "";

  constructor(options: FakeServerOptions) {
    this.#options = options;
    this.mailboxes = options.mailboxes;
  }

  /** A client speaking to this server, already "authenticated". */
  client(): ImapClient {
    // The constructor is private on purpose (see imap-search-charset.test.ts);
    // a connected client can only be built this way without a real socket.
    const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
    return new ctor(this.conn());
  }

  /** The socket half the client reads and writes. */
  conn(): { write(p: Uint8Array): Promise<number>; read(p: Uint8Array): Promise<number | null>; close(): void } {
    return {
      write: (p) => {
        if (this.closed) return Promise.reject(new Deno.errors.BadResource("closed"));
        // Exact octets, one character each: a UTF-8 literal survives the trip.
        this.#receive(bytesToByteString(p));
        return Promise.resolve(p.length);
      },
      read: async (p) => {
        while (this.#inbound.length === 0) {
          if (this.closed) return null;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.#wake = null;
              reject(new Error("fake IMAP server: the client is waiting for a reply nobody scripted"));
            }, this.#options.readTimeoutMs ?? 2000);
            this.#wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        const n = Math.min(p.length, this.#inbound.length);
        for (let i = 0; i < n; i++) p[i] = this.#inbound[i];
        this.#inbound.splice(0, n);
        return n;
      },
      close: () => {
        this.closed = true;
        this.#wakeReader();
      },
    };
  }

  /** Release a LOGOUT held by `holdLogout`. */
  answerLogout(): void {
    if (this.#heldLogoutTag === null) return;
    this.#send(`* BYE logging out${CRLF}${this.#heldLogoutTag} OK LOGOUT completed${CRLF}`);
    this.#heldLogoutTag = null;
  }

  /** The server drops the connection: the client's next read sees EOF. */
  hangUp(): void {
    this.closed = true;
    this.#wakeReader();
  }

  /** Remove a message as another client would: no EXPUNGE is announced. */
  expungeBehindTheClient(mailbox: string, uid: number): void {
    const box = this.#mailbox(mailbox);
    if (box) box.messages = box.messages.filter((m) => m.uid !== uid);
  }

  #wakeReader(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #send(text: string): void {
    for (const b of octets(text)) this.#inbound.push(b);
    this.#wakeReader();
  }

  #mailbox(name: string): FakeMailbox | undefined {
    return this.mailboxes.find((m) =>
      m.name === name || (m.name.toUpperCase() === "INBOX" && name.toUpperCase() === "INBOX")
    );
  }

  #receive(chunk: string): void {
    this.#partial += chunk;
    const replies: string[] = [];
    let stalled = false;
    let at: number;
    for (;;) {
      // A synchronizing literal the client was told to send (RFC 3501 4.3):
      // its octets join the command line as a quoted string of the text they
      // spell, so `commands` and the search evaluator read one plain line.
      if (this.#literalLeft >= 0) {
        if (this.#partial.length < this.#literalLeft) break;
        const literal = literalText(this.#partial.slice(0, this.#literalLeft));
        this.#partial = this.#partial.slice(this.#literalLeft);
        this.#literalLeft = -1;
        this.#pendingLine += quote(literal);
      }
      if ((at = this.#partial.indexOf(CRLF)) === -1) break;
      const piece = this.#partial.slice(0, at);
      this.#partial = this.#partial.slice(at + 2);
      const announced = /\{(\d+)\}$/.exec(piece);
      if (announced && this.#options.clientLiterals !== false && /^\S+ UID SEARCH /i.test(this.#pendingLine + piece)) {
        this.#pendingLine += piece.slice(0, announced.index);
        this.#literalLeft = Number(announced[1]);
        this.#send(`+ Ready for literal data${CRLF}`);
        continue;
      }
      const line = this.#pendingLine + piece;
      this.#pendingLine = "";
      const space = line.indexOf(" ");
      const tag = line.slice(0, space);
      const command = line.slice(space + 1);
      this.commands.push(command);
      this.#options.onCommand?.(command, this);
      // The hook hung up: a dead server answers nothing, not even what it had
      // already worked out for the earlier commands of the same write.
      if (this.closed) return;
      if (this.#options.stall?.(command)) stalled = true;
      const refusal = this.#options.refuse?.(command) ?? null;
      replies.push(refusal !== null ? `${tag} ${refusal}${CRLF}` : this.#answer(tag, command));
    }
    if (replies.length === 0) return;
    this.roundTrips++;
    if (this.#options.reversePipelined) replies.reverse();
    if (stalled) {
      this.#late += replies.join("");
      return;
    }
    const out = this.#late + replies.join("");
    this.#late = "";
    const delay = this.#options.searchDelayMs ?? 0;
    if (delay > 0 && /^UID SEARCH /i.test(this.commands[this.commands.length - 1] ?? "")) {
      // A slow search: the server says nothing, then answers.
      setTimeout(() => {
        if (!this.closed) this.#send(out);
      }, delay);
      return;
    }
    this.#send(out);
  }

  #wireName(name: string): string {
    const encoded = encodeModifiedUtf7(name);
    return /^[A-Za-z0-9._\/-]+$/.test(encoded) ? encoded : quote(encoded);
  }

  #statusLine(box: FakeMailbox, items: string): string {
    const values: Record<string, number> = {
      MESSAGES: box.messages.length,
      UNSEEN: box.messages.filter((m) => !m.flags.includes("\\Seen")).length,
      RECENT: 0,
      UIDNEXT: box.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1,
      UIDVALIDITY: 1,
    };
    // Only for a mailbox that opted in (client-api's status tests), and only
    // ever asked for by `mailboxChangeState`.
    if (box.modSeq !== undefined) values["HIGHESTMODSEQ"] = box.modSeq;
    const body = items.trim().split(/\s+/).filter((item) => item in values)
      .map((item) => `${item} ${values[item]}`).join(" ");
    const name = this.#options.statusName?.(box.name) ?? box.name;
    return `* STATUS ${this.#wireName(name)} (${body})${CRLF}`;
  }

  #fetchRows(numbers: number[], byUid: boolean, items: string): string | null {
    const selected = this.#selected;
    if (!selected) return null;
    let out = "";
    for (const n of numbers) {
      const seq = byUid ? selected.uids.indexOf(n) + 1 : n;
      const uid = byUid ? n : selected.uids[n - 1];
      if (seq < 1 || uid === undefined) continue;
      const message = selected.mailbox.messages.find((m) => m.uid === uid);
      if (!message) {
        if (!byUid && this.#options.expungedFetch === "no") return null;
        continue;
      }
      const parts: string[] = [];
      // The one item with a space in it is given a spaceless stand-in first.
      for (const item of items.replace("BODY.PEEK[HEADER.FIELDS (REFERENCES)]", "REFERENCES-HEADER").split(/\s+/)) {
        if (item === "REFERENCES-HEADER") {
          // The field as the message has it, folding and odd whitespace included.
          const field = rawHeaderField(splitRaw(message.raw).head, "references");
          const block = field === null ? CRLF : `${field}${CRLF}${CRLF}`;
          parts.push(`BODY[HEADER.FIELDS (REFERENCES)] {${block.length}}${CRLF}${block}`);
        } else if (item === "X-GM-THRID") parts.push(`X-GM-THRID ${message.gmThreadId ?? "0"}`);
        else if (item === "X-GM-MSGID") parts.push(`X-GM-MSGID ${message.gmMessageId ?? "0"}`);
        else if (item === "X-GM-LABELS") {
          // System labels go out quoted with the backslash escaped, as Gmail sends them.
          parts.push(`X-GM-LABELS (${(message.gmLabels ?? []).map((label) => quote(label)).join(" ")})`);
        } else if (item === "UID") parts.push(`UID ${uid}`);
        else if (item === "FLAGS") parts.push(`FLAGS (${message.flags.join(" ")})`);
        else if (item === "ENVELOPE") parts.push(`ENVELOPE ${envelopeOf(message.raw)}`);
        else if (item === "BODYSTRUCTURE") parts.push(`BODYSTRUCTURE ${bodyStructureOf(message.raw)}`);
        else if (item === "BODY.PEEK[]") parts.push(`BODY[] {${message.raw.length}}${CRLF}${message.raw}`);
        else if (item === "BODY.PEEK[1]<0.2048>") {
          const prefix = partOneOf(message.raw).slice(0, 2048);
          parts.push(`BODY[1]<0> {${prefix.length}}${CRLF}${prefix}`);
        }
      }
      // A UID FETCH always reports the UID, asked for or not (RFC 3501 6.4.8).
      if (byUid && !parts.some((p) => p.startsWith("UID "))) parts.unshift(`UID ${uid}`);
      out += `* ${seq} FETCH (${parts.join(" ")})${CRLF}`;
    }
    return out;
  }

  #answer(tag: string, command: string): string {
    const ok = (text: string) => `${tag} OK ${text}${CRLF}`;
    const verb = command.split(" ")[0].toUpperCase();

    if (verb === "CAPABILITY") {
      const caps = this.#options.capabilities ?? ["IMAP4rev1"];
      return `* CAPABILITY ${caps.join(" ")}${CRLF}` + ok("CAPABILITY completed");
    }

    // NOOP and UID STORE were added for client-api's session-pool and flag
    // tests; no mcp-server test sends either.
    // NOOP is how a client polls the selected mailbox (RFC 3501 6.1.2): the
    // server delivers what changed since the last command, after which the
    // session addresses the mailbox as it is now. Arrivals are announced with
    // `* n EXISTS`; removals just leave the snapshot (a real server sends one
    // `* n EXPUNGE` each, which no caller here reads).
    if (verb === "NOOP") {
      const selected = this.#selected;
      if (!selected) return ok("NOOP completed");
      const now = selected.mailbox.messages.map((m) => m.uid).sort((a, b) => a - b);
      const grew = now.some((uid) => !selected.uids.includes(uid));
      selected.uids = now;
      return (grew ? `* ${now.length} EXISTS${CRLF}` : "") + ok("NOOP completed");
    }

    const store = /^UID STORE (\S+) ([+-])FLAGS(?:\.SILENT)? \(([^)]*)\)$/i.exec(command);
    if (store) {
      const selected = this.#selected;
      if (!selected) return `${tag} BAD No mailbox selected${CRLF}`;
      const largest = selected.uids[selected.uids.length - 1] ?? 0;
      const flags = store[3].split(/\s+/).filter(Boolean);
      for (const uid of parseSet(store[1], largest)) {
        const message = selected.mailbox.messages.find((m) => m.uid === uid);
        if (!message) continue;
        message.flags = store[2] === "+"
          ? [...new Set([...message.flags, ...flags])]
          : message.flags.filter((flag) => !flags.includes(flag));
      }
      if (selected.mailbox.modSeq !== undefined) selected.mailbox.modSeq += 1;
      return ok("STORE completed");
    }

    // UID MOVE (RFC 6851) with COPYUID (RFC 4315), added for client-api's
    // move / archive / delete tests; no mcp-server test sends it. A server
    // built with `uidplus: false` moves the same way and reports no COPYUID.
    const move = /^UID MOVE (\S+) (.+)$/i.exec(command);
    if (move) {
      const selected = this.#selected;
      if (!selected) return `${tag} BAD No mailbox selected${CRLF}`;
      const target = this.#mailbox(decodeModifiedUtf7(takeArgument(move[2]).value));
      if (!target) return `${tag} NO [TRYCREATE] Mailbox does not exist${CRLF}`;
      const largest = selected.uids[selected.uids.length - 1] ?? 0;
      const from: number[] = [];
      const to: number[] = [];
      for (const uid of parseSet(move[1], largest)) {
        const message = selected.mailbox.messages.find((m) => m.uid === uid);
        if (!message) continue;
        const next = target.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
        selected.mailbox.messages = selected.mailbox.messages.filter((m) => m !== message);
        target.messages.push({ ...message, uid: next });
        from.push(uid);
        to.push(next);
      }
      selected.uids = selected.mailbox.messages.map((m) => m.uid).sort((a, b) => a - b);
      const copyuid = from.length > 0 && this.#options.uidplus !== false
        ? `* OK [COPYUID 1 ${from.join(",")} ${to.join(",")}] Moved${CRLF}`
        : "";
      return copyuid + ok("MOVE completed");
    }

    if (verb === "LOGOUT") {
      this.logoutReceived = true;
      if (this.#options.holdLogout) {
        this.#heldLogoutTag = tag;
        return "";
      }
      return `* BYE logging out${CRLF}` + ok("LOGOUT completed");
    }

    if (verb === "SELECT") {
      const name = decodeModifiedUtf7(takeArgument(command.slice(6)).value);
      const box = this.#mailbox(name);
      if (!box) {
        this.#selected = null;
        return `${tag} NO [NONEXISTENT] Unknown Mailbox${CRLF}`;
      }
      this.#selected = { mailbox: box, uids: box.messages.map((m) => m.uid).sort((a, b) => a - b) };
      return `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)${CRLF}` +
        (this.#options.omitExists ? "" : `* ${this.#selected.uids.length} EXISTS${CRLF}`) +
        `* 0 RECENT${CRLF}` +
        `* OK [UIDVALIDITY 1] UIDs valid${CRLF}` +
        `* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited${CRLF}` +
        ok("[READ-WRITE] SELECT completed");
    }

    if (verb === "LIST") {
      const extended = /RETURN \(STATUS \(([^)]*)\)\)/i.exec(command);
      if (extended && !this.#options.listStatus) return `${tag} BAD Unknown argument RETURN${CRLF}`;
      let out = "";
      for (const box of this.mailboxes) {
        out += `* LIST (${(box.attrs ?? []).join(" ")}) "/" ${this.#wireName(box.name)}${CRLF}`;
        const selectable = !(box.attrs ?? []).some((a) => /^\\noselect$/i.test(a));
        if (extended && selectable && !box.statusFails) out += this.#statusLine(box, extended[1]);
      }
      return out + ok("LIST completed");
    }

    if (verb === "STATUS") {
      const arg = takeArgument(command.slice(6));
      const box = this.#mailbox(decodeModifiedUtf7(arg.value));
      const noselect = (box?.attrs ?? []).some((a) => /^\\noselect$/i.test(a));
      if (!box || noselect || box.statusFails) return `${tag} NO STATUS failed${CRLF}`;
      const items = /\(([^)]*)\)/.exec(arg.rest)?.[1] ?? "";
      return this.#statusLine(box, items) + ok("STATUS completed");
    }

    if (verb === "UID" && /^UID SEARCH /i.test(command)) {
      const selected = this.#selected;
      if (!selected) return `${tag} BAD No mailbox selected${CRLF}`;
      if (this.#options.searchLimit !== undefined) {
        const counter = (this.#options.searchCount ??= { n: 0 });
        counter.n++;
        if (counter.n > this.#options.searchLimit) return `${tag} NO [LIMIT] Search rate limit exceeded, try again later${CRLF}`;
      }
      let criteria = command.slice("UID SEARCH ".length).trim();
      const charset = /^CHARSET (\S+) /i.exec(criteria);
      if (charset) {
        if (this.#options.rejectCharset) return `${tag} NO [BADCHARSET (US-ASCII)] Unsupported charset${CRLF}`;
        criteria = criteria.slice(charset[0].length);
      }
      const live = selected.mailbox.messages.slice().sort((a, b) => a.uid - b.uid);
      let hits: FakeMessage[];
      if (criteria === "ALL") hits = live;
      else if (criteria === "UNSEEN") hits = live.filter((m) => !m.flags.includes("\\Seen"));
      else if (criteria === "SEEN") hits = live.filter((m) => m.flags.includes("\\Seen"));
      else if (/^UID /.test(criteria)) {
        const wanted = new Set(parseSet(criteria.slice(4), live[live.length - 1]?.uid ?? 0));
        hits = live.filter((m) => wanted.has(m.uid));
      } else {
        const predicate = searchPredicate(criteria, this.#options);
        if (!predicate) return `${tag} BAD Unsupported search in the fake${CRLF}`;
        hits = this.#options.headerSearchBroken && /\bHEADER\b/i.test(criteria) ? [] : live.filter(predicate);
      }
      return `* SEARCH${hits.map((m) => ` ${m.uid}`).join("")}${CRLF}` + ok("SEARCH completed");
    }

    const fetch = /^(UID )?FETCH (\S+) \((.*)\)$/i.exec(command);
    if (fetch) {
      const selected = this.#selected;
      if (!selected) return `${tag} BAD No mailbox selected${CRLF}`;
      const byUid = Boolean(fetch[1]);
      const largest = byUid ? selected.uids[selected.uids.length - 1] ?? 0 : selected.uids.length;
      const rows = this.#fetchRows(parseSet(fetch[2], largest), byUid, fetch[3]);
      if (rows === null) return `${tag} NO Some of the requested messages no longer exist${CRLF}`;
      return rows + ok("FETCH completed");
    }

    return `${tag} BAD Unknown command in the fake${CRLF}`;
  }
}

/** A small text message. Addresses are example.com by construction. */
export function fakeTextMessage(uid: number, options: {
  subject?: string;
  seen?: boolean;
  body?: string;
  date?: string;
} = {}): FakeMessage {
  const day = String(1 + (uid % 27)).padStart(2, "0");
  return {
    uid,
    flags: options.seen ? ["\\Seen"] : [],
    raw: [
      `Date: ${options.date ?? `${day} Sep 2026 10:00:00 +0000`}`,
      `From: "Sender ${uid}" <sender${uid}@example.com>`,
      "To: <owner@example.com>",
      `Subject: ${options.subject ?? `Message ${uid}`}`,
      `Message-ID: <m${uid}@example.com>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      options.body ?? `Body of message ${uid}.`,
    ].join(CRLF),
  };
}

/** A multipart/mixed message with one text part and one attachment. */
export function fakeMessageWithAttachment(uid: number, options: {
  filename?: string;
  /** Decoded attachment content, one character per octet. */
  content?: string;
  seen?: boolean;
} = {}): FakeMessage {
  const filename = options.filename ?? `file${uid}.txt`;
  const encoded = btoa(options.content ?? `attachment ${uid}`).replace(/(.{76})/g, `$1${CRLF}`);
  return {
    uid,
    flags: options.seen ? ["\\Seen"] : [],
    raw: [
      `Date: 02 Sep 2026 09:00:00 +0000`,
      `From: "Sender ${uid}" <sender${uid}@example.com>`,
      "To: <owner@example.com>",
      `Subject: With attachment ${uid}`,
      `Message-ID: <a${uid}@example.com>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="b${uid}"`,
      "",
      `--b${uid}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `See the attached file ${uid}.`,
      `--b${uid}`,
      `Content-Type: application/octet-stream; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      encoded,
      `--b${uid}--`,
      "",
    ].join(CRLF),
  };
}

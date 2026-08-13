/**
 * imap-client.ts — minimal IMAP client for the MCP edge function (Deno).
 *
 * Serves IMAP inboxes (iCloud, Yahoo, Zoho, Yandex, and the generic connector)
 * that have no JMAP/REST API. Uses Deno.connectTls for implicit-TLS IMAP
 * (port 993) and SASL PLAIN authentication with the stored app password.
 *
 * Scope (Phase 1): connect → authenticate → SELECT → UID SEARCH → UID FETCH
 * (ENVELOPE + FLAGS + BODYSTRUCTURE) → LOGOUT. This is enough for list_inbox;
 * email_read/search/send build on the same connection primitives.
 *
 * Auth failures throw ImapAuthError so callers can surface a reconnect prompt.
 * A faithful Node reference lives at apps/web/src/lib/email/imap.ts.
 */

export class ImapAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapAuthError";
  }
}

/**
 * Thrown when the server refuses the connection because the account has hit its
 * simultaneous-connection / rate limit (e.g. Yahoo caps an account at 5 IMAP
 * connections). Distinct from {@link ImapAuthError}: connection-limit refusals
 * are transient and retryable, whereas auth failures are permanent.
 */
export class ImapConnectionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapConnectionLimitError";
  }
}

/**
 * Detect whether a server response (greeting or AUTHENTICATE NO/BYE text)
 * indicates a transient connection/rate limit that is worth retrying.
 *
 * Mirrors the retryable connection-limit condition in the web reference
 * `connectImapWithRetry` (apps/web/src/lib/email/imap.ts) — `connection limit`,
 * `too many connections`, `[LIMIT]` — and additionally covers the resp-code
 * markers Yahoo / iCloud / Fastmail emit on the connect path itself:
 * `[OVERQUOTA]`, `[ALERT]`, `[UNAVAILABLE]`, `over quota`, `too many`,
 * `try again`. Genuine bad-credential responses do NOT match any of these and
 * therefore fall through to {@link ImapAuthError}.
 */
function isConnectionLimitResponse(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("connection limit") ||
    t.includes("too many connections") ||
    t.includes("too many") ||
    t.includes("[limit]") ||
    t.includes("[overquota]") ||
    t.includes("over quota") ||
    t.includes("[alert]") ||
    t.includes("[unavailable]") ||
    t.includes("try again")
  );
}

export interface ImapConnectConfig {
  host: string;
  port: number;
  /** Full email address — the SASL username. */
  email: string;
  /** Decrypted app password. */
  password: string;
  /** Defaults to implicit TLS for backwards compatibility. */
  security?: "tls" | "starttls";
}

export interface ImapAddress {
  name: string;
  email: string;
}

export interface ImapEnvelope {
  subject: string;
  from: ImapAddress[];
  to: ImapAddress[];
  date: string;
  messageId: string;
}

export interface ImapMessageSummary {
  uid: number;
  flags: string[];
  envelope: ImapEnvelope;
  hasAttachments: boolean;
  /** Best-effort plain-text preview (≤200 chars); "" when unavailable. */
  preview: string;
}

export interface ImapRawMessage {
  raw: string;
  flags: string[];
}

/** Returned by {@link ImapClient.listMailboxes}. */
export interface ImapMailboxInfo {
  /** Decoded mailbox name (e.g. "INBOX", "Sent", "Archive/2024"). */
  name: string;
  /** Hierarchy delimiter reported by the server, e.g. "/" or ".". */
  delimiter: string;
  /** Attribute flags, e.g. ["\\HasChildren", "\\Noinferiors"]. */
  flags: string[];
}

/** Returned by {@link ImapClient.mailboxStatus}. */
export interface ImapMailboxStatus {
  messages: number;
  unseen: number;
  recent: number;
  uidNext: number;
  uidValidity: number;
}

const CRLF = "\r\n";
const COMMAND_TIMEOUT_MS = 15_000;

/** A live, authenticated IMAP session over implicit TLS. */
export class ImapClient {
  private conn: Deno.Conn;
  private buffer: Uint8Array;
  private bufStart = 0;
  private bufEnd = 0;
  private tagCounter = 0;
  private readonly decoder = new TextDecoder("latin1");
  private readonly encoder = new TextEncoder();

  /**
   * Command-serialization chain. The IMAP protocol is strictly request/response
   * over a single socket, and this client shares ONE read buffer
   * (buffer/bufStart/bufEnd) and ONE tag stream across every command. Two
   * overlapping public command calls (e.g. a `Promise.allSettled` fan-out of
   * STATUS) would interleave writes and race on the shared buffer — stealing
   * each other's response lines, waiting on the wrong tag, or looping forever.
   *
   * `runExclusive` chains every command body onto this promise so the Nth call
   * only writes after the (N-1)th has fully read its tagged completion. The
   * chain is best-effort: a failing command does NOT poison the queue (the
   * `.catch` swallows the settle so the next command still runs).
   */
  private commandChain: Promise<unknown> = Promise.resolve();

  private constructor(conn: Deno.Conn) {
    this.conn = conn;
    this.buffer = new Uint8Array(64 * 1024);
  }

  /**
   * Serialize a command body on the single IMAP socket. Each call awaits the
   * prior one's completion before its `fn` runs, so concurrent callers are
   * queued rather than racing on the shared read buffer / tag stream. Errors
   * propagate to *this* caller but never break the chain for the next one.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commandChain.then(fn, fn);
    // Keep the chain alive regardless of this command's outcome.
    this.commandChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Open an authenticated IMAP session, retrying transient connection-limit
   * refusals with exponential back-off.
   *
   * Yahoo caps an account at 5 simultaneous IMAP connections (Fastmail/iCloud
   * have similar caps); concurrent MCP tool calls — or a server-side connection
   * still lingering after a prior LOGOUT — can transiently exceed the cap and
   * the server refuses the connect/greeting/AUTH. We retry such refusals.
   *
   * Back-off mirrors the web reference `connectImapWithRetry`
   * (apps/web/src/lib/email/imap.ts): up to 3 attempts, waiting
   * 5s → 10s before the 2nd and 3rd attempts (5_000 * 2^(attempt-1)).
   *
   * Genuine auth failures (bad credentials) throw {@link ImapAuthError} and are
   * NOT retried — they surface immediately so callers map them to
   * `imap_auth_failed`.
   */
  static async connect(cfg: ImapConnectConfig): Promise<ImapClient> {
    const maxRetries = 3;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await ImapClient.connectOnce(cfg);
      } catch (err) {
        lastErr = err;

        // Only the connection-limit / rate-limit class is retryable. Auth
        // failures and all other errors are permanent and rethrown at once.
        if (!(err instanceof ImapConnectionLimitError)) {
          throw err;
        }

        if (attempt < maxRetries) {
          const waitMs = 5_000 * Math.pow(2, attempt - 1); // 5s, 10s
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
    }

    // Retries exhausted on a connection-limit condition: surface a clear error.
    throw new ImapConnectionLimitError(
      `IMAP connection limit reached for ${cfg.host} after ${maxRetries} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  /**
   * One connect attempt: open a TLS connection, read the greeting, and
   * authenticate via SASL PLAIN.
   *
   * Throws {@link ImapConnectionLimitError} when the greeting or AUTH response
   * signals a transient connection/rate limit (retryable), and
   * {@link ImapAuthError} on genuine authentication failure (not retryable).
   */
  private static async connectOnce(cfg: ImapConnectConfig): Promise<ImapClient> {
    let conn: Deno.TcpConn | Deno.TlsConn = cfg.security === "starttls"
      ? await Deno.connect({ hostname: cfg.host, port: cfg.port })
      : await Deno.connectTls({ hostname: cfg.host, port: cfg.port });
    const client = new ImapClient(conn);

    // Server greeting: expect "* OK ...". A "* BYE" (or any non-OK greeting)
    // carrying a connection-limit marker means the account is over its cap —
    // retryable. Other non-OK greetings are a protocol error.
    const greeting = await client.readLine();
    if (!greeting.startsWith("* OK")) {
      client.close();
      if (isConnectionLimitResponse(greeting)) {
        throw new ImapConnectionLimitError(
          `IMAP connection refused at greeting: ${greeting.slice(0, 120)}`,
        );
      }
      throw new Error(`Unexpected IMAP greeting: ${greeting.slice(0, 80)}`);
    }

    if (cfg.security === "starttls") {
      const tag = client.nextTag();
      await client.write(`${tag} STARTTLS${CRLF}`);
      const response = await client.readTagged(tag);
      if (response.status !== "OK") {
        client.close();
        throw new Error("IMAP server refused STARTTLS");
      }
      conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: cfg.host });
      client.conn = conn;
    }

    // SASL PLAIN: base64("\x00" + user + "\x00" + pass).
    const token = btoa(`\x00${cfg.email}\x00${cfg.password}`);
    const tag = client.nextTag();
    await client.write(`${tag} AUTHENTICATE PLAIN ${token}${CRLF}`);
    let resp = await client.readTagged(tag);

    // A tagged BAD rejects the command rather than the credentials: the server
    // does not implement RFC 4959 (SASL-IR) and will not take the initial
    // response inline. Yandex answers "BAD AUTHENTICATE Command syntax error"
    // to the inline form. Retry the RFC 3501 two-step form on the same
    // connection; a NO is a genuine credential failure and is not retried.
    if (resp.status === "BAD") {
      const retryTag = client.nextTag();
      await client.write(`${retryTag} AUTHENTICATE PLAIN${CRLF}`);
      // Continuation is a bare "+" on Yandex, so don't require "+ ".
      const cont = await client.readLine();
      if (!cont.startsWith("+")) {
        client.close();
        throw new ImapAuthError(
          `IMAP server refused SASL PLAIN: ${cont.slice(0, 120)}`,
        );
      }
      await client.write(`${token}${CRLF}`);
      resp = await client.readTagged(retryTag);
    }

    if (resp.status !== "OK") {
      client.close();
      // Some servers report a connection-limit refusal as a NO/BYE on AUTH
      // rather than at the greeting (text like [OVERQUOTA]/[UNAVAILABLE]/
      // "too many connections"). Treat those as retryable; everything else is
      // a genuine credential failure.
      if (isConnectionLimitResponse(resp.text)) {
        throw new ImapConnectionLimitError(
          `IMAP connection refused at auth: ${resp.text}`,
        );
      }
      throw new ImapAuthError(`IMAP authentication failed: ${resp.text}`);
    }
    return client;
  }

  /** SELECT a mailbox. Throws if the folder does not exist. */
  selectMailbox(mailbox: string): Promise<void> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} SELECT ${quoteImap(mailbox)}${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`Mailbox not found: ${mailbox}`);
      }
    });
  }

  /** UID SEARCH; returns matching UIDs (ascending). criteria e.g. "ALL", "UNSEEN". */
  uidSearch(criteria: string): Promise<number[]> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} UID SEARCH ${criteria}${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`UID SEARCH failed: ${resp.text}`);
      }
      const line = resp.untagged.find((l) => /^\* SEARCH\b/.test(l));
      if (!line) return [];
      return line
        .replace(/^\* SEARCH/, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n));
    });
  }

  /**
   * UID FETCH (FLAGS ENVELOPE BODYSTRUCTURE) for a set of UIDs.
   *
   * `includePreview` avoids downloading a body prefix when a caller only needs
   * envelope metadata to rank a larger candidate set. The returned summaries
   * still have a string preview (the empty string when it was not fetched), so
   * callers that expose a preview can fetch it only for their final page.
   */
  fetchSummaries(
    uids: number[],
    options: { includePreview?: boolean } = {},
  ): Promise<ImapMessageSummary[]> {
    if (uids.length === 0) return Promise.resolve([]);
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      const set = uids.join(",");
      const previewPart = options.includePreview === false
        ? ""
        : " BODY.PEEK[1]<0.2048>";
      await this.write(
        `${tag} UID FETCH ${set} (UID FLAGS ENVELOPE BODYSTRUCTURE${previewPart})${CRLF}`,
      );
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`UID FETCH failed: ${resp.text}`);
      }

      const summaries: ImapMessageSummary[] = [];
      for (const line of resp.untagged) {
        if (!/^\* \d+ FETCH /.test(line)) continue;
        const parsed = parseFetchLine(line);
        if (parsed) summaries.push(parsed);
      }
      return summaries;
    });
  }

  /**
   * UID FETCH the full raw RFC 822 message plus flags. Returns null if the UID
   * is not present in the FETCH response.
   */
  fetchMessageRaw(uid: number): Promise<ImapRawMessage | null> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} UID FETCH ${uid} (FLAGS BODY.PEEK[])${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`UID FETCH failed: ${resp.text}`);
      }
      const line = resp.untagged.find((l) => /^\* \d+ FETCH /.test(l));
      if (!line) return null;

      const open = line.indexOf("(");
      if (open === -1) return null;
      const tokens = tokenize(line.slice(open));
      const attrs = Array.isArray(tokens[0]) ? tokens[0] : tokens;

      let raw = "";
      let flags: string[] = [];
      for (let i = 0; i < attrs.length; i++) {
        const key = attrs[i];
        if (key === "FLAGS" && Array.isArray(attrs[i + 1])) {
          flags = (attrs[i + 1] as Token[]).filter((t): t is string => typeof t === "string");
        } else if (
          typeof key === "string" && key.startsWith("BODY[") &&
          typeof attrs[i + 1] === "string"
        ) {
          raw = attrs[i + 1] as string;
        }
      }
      return { raw, flags };
    });
  }

  /** Mark a message read by setting the \Seen flag. Best-effort. */
  markSeen(uid: number): Promise<void> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} UID STORE ${uid} +FLAGS (\\Seen)${CRLF}`);
      await this.readTagged(tag).catch(() => {});
    });
  }

  /**
   * APPEND a message to a mailbox, flagged \Seen (used to file a Sent copy).
   * Returns true on a tagged OK, false if the server rejects (e.g. the mailbox
   * does not exist). Uses an IMAP literal: send "{len}", await the "+" prompt,
   * then the raw bytes.
   */
  append(mailbox: string, message: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      const bytes = this.encoder.encode(message);
      await this.write(`${tag} APPEND ${quoteImap(mailbox)} (\\Seen) {${bytes.length}}${CRLF}`);

      const cont = await this.readLine();
      if (!cont.startsWith("+")) {
        // Rejected before the literal (e.g. "<tag> NO [TRYCREATE]").
        return false;
      }

      await this.conn.write(bytes);
      await this.write(CRLF);
      const resp = await this.readTagged(tag);
      return resp.status === "OK";
    });
  }

  /**
   * Like append() but accepts a custom flags list and returns the assigned UID
   * when the server supports UIDPLUS (RFC 4315).
   *
   *   appendWithFlags("Drafts", mime, ["\\Draft", "\\Seen"])
   *     → { ok: true, uid: 42 }   // UIDPLUS supported
   *     → { ok: true, uid: undefined } // UIDPLUS not supported
   *     → { ok: false }               // server rejected the APPEND
   *
   * Used by the drafts tools (draft_create / draft_update) so the returned
   * draft_id can be encoded as "<folder>:<uid>".
   */
  appendWithFlags(
    mailbox: string,
    message: string,
    flags: string[],
  ): Promise<{ ok: boolean; uid?: number }> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      const bytes = this.encoder.encode(message);
      const flagStr = flags.length ? ` (${flags.join(" ")})` : "";
      await this.write(
        `${tag} APPEND ${quoteImap(mailbox)}${flagStr} {${bytes.length}}${CRLF}`,
      );
      const cont = await this.readLine();
      if (!cont.startsWith("+")) {
        return { ok: false };
      }
      await this.conn.write(bytes);
      await this.write(CRLF);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") return { ok: false };
      // Parse APPENDUID response code: [APPENDUID <uidvalidity> <uid>]
      const m = resp.text.match(/\[APPENDUID\s+\d+\s+(\d+)\]/i);
      return { ok: true, uid: m ? parseInt(m[1], 10) : undefined };
    });
  }

  // ── Phase-1+ low-level verbs (flags, MOVE, EXPUNGE, folders) ─────────────────
  // These are pure building blocks — no MCP tools call them yet (wired in later
  // phases). Each method mirrors the style of markSeen / append above.

  /**
   * Generic UID STORE flag setter/unsetter.
   *   mode "add"    → +FLAGS (flags…)
   *   mode "remove" → -FLAGS (flags…)
   * Use IMAP system flags like "\\Seen", "\\Flagged", "\\Deleted".
   * Accepts bulk UID sets (uids are compressed to a compact range string).
   */
  uidStore(uids: number[], flags: string[], mode: "add" | "remove"): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.runExclusive(() => this.uidStoreUnlocked(uids, flags, mode));
  }

  /** Unlocked UID STORE — only call while holding the command lock. */
  private async uidStoreUnlocked(
    uids: number[],
    flags: string[],
    mode: "add" | "remove",
  ): Promise<void> {
    const tag = this.nextTag();
    const uidSet = toUidSet(uids);
    const modePrefix = mode === "add" ? "+" : "-";
    const flagList = flags.join(" ");
    await this.write(`${tag} UID STORE ${uidSet} ${modePrefix}FLAGS (${flagList})${CRLF}`);
    const resp = await this.readTagged(tag);
    if (resp.status !== "OK") {
      throw new Error(`UID STORE failed: ${resp.text}`);
    }
  }

  /**
   * UID COPY messages to a destination mailbox.
   * Accepts bulk UID sets.
   */
  uidCopy(uids: number[], targetMailbox: string): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.runExclusive(() => this.uidCopyUnlocked(uids, targetMailbox));
  }

  /** Unlocked UID COPY — only call while holding the command lock. */
  private async uidCopyUnlocked(uids: number[], targetMailbox: string): Promise<void> {
    const tag = this.nextTag();
    const uidSet = toUidSet(uids);
    await this.write(`${tag} UID COPY ${uidSet} ${quoteImap(targetMailbox)}${CRLF}`);
    const resp = await this.readTagged(tag);
    if (resp.status !== "OK") {
      throw new Error(`UID COPY failed: ${resp.text}`);
    }
  }

  /**
   * UID MOVE messages to a destination mailbox (RFC 6851).
   * Falls back to COPY + STORE \\Deleted + UID EXPUNGE on servers that lack MOVE.
   * Accepts bulk UID sets.
   *
   * The whole sequence (MOVE, or the COPY→STORE→EXPUNGE fallback) runs inside a
   * SINGLE exclusive lock so the fallback steps stay atomic relative to other
   * commands; the steps call the *Unlocked helpers to avoid re-acquiring the
   * lock (which would deadlock on the chain this call already holds).
   */
  uidMove(uids: number[], targetMailbox: string): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.runExclusive(async () => {
      const uidSet = toUidSet(uids);
      const moveTag = this.nextTag();
      await this.write(`${moveTag} UID MOVE ${uidSet} ${quoteImap(targetMailbox)}${CRLF}`);
      const moveResp = await this.readTagged(moveTag);
      if (moveResp.status === "OK") return;
      // Server doesn't support RFC 6851 MOVE — fall back: COPY → \\Deleted → EXPUNGE.
      await this.uidCopyUnlocked(uids, targetMailbox);
      await this.uidStoreUnlocked(uids, ["\\Deleted"], "add");
      await this.uidExpungeUnlocked(uids);
    });
  }

  /**
   * Expunge only the given UIDs (RFC 4315 UID EXPUNGE).
   * Falls back to a plain EXPUNGE on servers that don't support the extension.
   * The calling code must have already marked the UIDs \\Deleted before calling this.
   */
  uidExpunge(uids: number[]): Promise<void> {
    if (uids.length === 0) return Promise.resolve();
    return this.runExclusive(() => this.uidExpungeUnlocked(uids));
  }

  /** Unlocked UID EXPUNGE — only call while holding the command lock. */
  private async uidExpungeUnlocked(uids: number[]): Promise<void> {
    const uidSet = toUidSet(uids);
    const tag = this.nextTag();
    await this.write(`${tag} UID EXPUNGE ${uidSet}${CRLF}`);
    const resp = await this.readTagged(tag);
    if (resp.status !== "OK") {
      // RFC 4315 UID EXPUNGE not supported — fall back to plain EXPUNGE.
      const fallbackTag = this.nextTag();
      await this.write(`${fallbackTag} EXPUNGE${CRLF}`);
      await this.readTagged(fallbackTag).catch(() => {});
    }
  }

  /**
   * LIST all mailboxes matching the given pattern (default: all).
   * Returns mailboxes sorted by name.
   */
  listMailboxes(pattern = "*"): Promise<ImapMailboxInfo[]> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} LIST "" ${quoteImap(pattern)}${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`LIST failed: ${resp.text}`);
      }
      const mailboxes: ImapMailboxInfo[] = [];
      for (const line of resp.untagged) {
        // Format: * LIST (\Attr …) "delimiter" mailbox-name-or-quoted
        const m = /^\* LIST \(([^)]*)\) ("[^"]*"|NIL) (.+)$/.exec(line);
        if (!m) continue;
        const flags = m[1].split(/\s+/).filter(Boolean);
        const delimiter = m[2] === "NIL" ? "/" : m[2].slice(1, -1);
        let name = m[3].trim();
        if (name.startsWith('"')) {
          name = name.slice(1, -1).replace(/\\(.)/g, "$1");
        }
        mailboxes.push({ name, delimiter, flags });
      }
      mailboxes.sort((a, b) => a.name.localeCompare(b.name));
      return mailboxes;
    });
  }

  /**
   * STATUS a single mailbox — returns message/unseen/recent counts and UID info.
   */
  mailboxStatus(mailbox: string): Promise<ImapMailboxStatus> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(
        `${tag} STATUS ${quoteImap(mailbox)} (MESSAGES UNSEEN RECENT UIDNEXT UIDVALIDITY)${CRLF}`,
      );
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`STATUS failed for "${mailbox}": ${resp.text}`);
      }
      const line = resp.untagged.find((l) => /^\* STATUS\b/.test(l));
      const pick = (key: string): number => {
        if (!line) return 0;
        const m = new RegExp(`\\b${key}\\b\\s+(\\d+)`).exec(line);
        return m ? Number(m[1]) : 0;
      };
      return {
        messages: pick("MESSAGES"),
        unseen: pick("UNSEEN"),
        recent: pick("RECENT"),
        uidNext: pick("UIDNEXT"),
        uidValidity: pick("UIDVALIDITY"),
      };
    });
  }

  /** CREATE a new mailbox. Throws on server error. */
  createMailbox(mailbox: string): Promise<void> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} CREATE ${quoteImap(mailbox)}${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`CREATE failed for "${mailbox}": ${resp.text}`);
      }
    });
  }

  /** DELETE a mailbox. Throws on server error. */
  deleteMailbox(mailbox: string): Promise<void> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} DELETE ${quoteImap(mailbox)}${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`DELETE failed for "${mailbox}": ${resp.text}`);
      }
    });
  }

  /** RENAME a mailbox. Throws on server error. */
  renameMailbox(from: string, to: string): Promise<void> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} RENAME ${quoteImap(from)} ${quoteImap(to)}${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`RENAME failed from "${from}" to "${to}": ${resp.text}`);
      }
    });
  }

  /**
   * Send LOGOUT and close the socket. Best-effort; always closes.
   * Serialized like every other command so it can't race a still-in-flight
   * command on the shared socket; the close() in finally always runs.
   */
  logout(): Promise<void> {
    return this.runExclusive(async () => {
      try {
        const tag = this.nextTag();
        await this.write(`${tag} LOGOUT${CRLF}`);
        await this.readTagged(tag).catch(() => {});
      } finally {
        this.close();
      }
    });
  }

  private close(): void {
    try {
      this.conn.close();
    } catch {
      // already closed
    }
  }

  // ── Low-level IO ────────────────────────────────────────────────────────────

  private nextTag(): string {
    this.tagCounter = (this.tagCounter + 1) % 100000;
    return `A${String(this.tagCounter).padStart(5, "0")}`;
  }

  private async write(data: string): Promise<void> {
    await this.conn.write(this.encoder.encode(data));
  }

  /** Refill the internal buffer from the socket. Returns false on EOF. */
  private async fill(): Promise<boolean> {
    if (this.bufStart > 0) {
      this.buffer.copyWithin(0, this.bufStart, this.bufEnd);
      this.bufEnd -= this.bufStart;
      this.bufStart = 0;
    }
    if (this.bufEnd === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    const n = await withTimeout(
      this.conn.read(this.buffer.subarray(this.bufEnd)),
      COMMAND_TIMEOUT_MS,
    );
    if (n === null) return false;
    this.bufEnd += n;
    return true;
  }

  /** Read one CRLF-terminated line (without the trailing CRLF). */
  private async readLine(): Promise<string> {
    while (true) {
      for (let i = this.bufStart; i < this.bufEnd - 1; i++) {
        if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) {
          const line = this.decoder.decode(this.buffer.subarray(this.bufStart, i));
          this.bufStart = i + 2;
          return line;
        }
      }
      const ok = await this.fill();
      if (!ok) {
        // EOF: return whatever remains.
        const line = this.decoder.decode(this.buffer.subarray(this.bufStart, this.bufEnd));
        this.bufStart = this.bufEnd;
        return line;
      }
    }
  }

  /** Read exactly n bytes (used for IMAP literals), as a latin1 string. */
  private async readExact(n: number): Promise<string> {
    while (this.bufEnd - this.bufStart < n) {
      const ok = await this.fill();
      if (!ok) break;
    }
    const end = Math.min(this.bufStart + n, this.bufEnd);
    const out = this.decoder.decode(this.buffer.subarray(this.bufStart, end));
    this.bufStart = end;
    return out;
  }

  /**
   * Read an untagged-line response up to the tagged completion line.
   * Literals ({N}) are expanded inline as IMAP quoted strings so the result is
   * one logical string per untagged item, safe to tokenize.
   */
  private async readTagged(
    tag: string,
  ): Promise<{ status: "OK" | "NO" | "BAD"; text: string; untagged: string[] }> {
    const untagged: string[] = [];
    while (true) {
      let line = await this.readLine();

      // Expand any trailing/embedded literals on this logical line.
      let litMatch = /\{(\d+)\}$/.exec(line);
      while (litMatch) {
        const n = Number(litMatch[1]);
        const literal = await this.readExact(n);
        const cont = await this.readLine();
        line = line.slice(0, litMatch.index) +
          `"${escapeQuoted(literal)}"` + cont;
        litMatch = /\{(\d+)\}$/.exec(line);
      }

      if (line.startsWith(`${tag} `)) {
        const m = /^(\S+)\s+(OK|NO|BAD)\s*(.*)$/.exec(line);
        const status = (m?.[2] as "OK" | "NO" | "BAD") ?? "BAD";
        return { status, text: m?.[3] ?? line, untagged };
      }
      untagged.push(line);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Compress an array of UIDs to a compact IMAP UID-set string, collapsing
 * consecutive runs into ranges. E.g. [1,2,3,5,7,8] → "1:3,5,7:8".
 * Deduplicates and sorts the input before building ranges.
 */
function toUidSet(uids: number[]): string {
  if (uids.length === 0) return "";
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}:${end}`);
      start = end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}:${end}`);
  return ranges.join(",");
}

function quoteImap(s: string): string {
  // SECURITY: reject CR/LF and other control chars before quoting. These flow
  // into raw IMAP command lines (SELECT/CREATE/RENAME/DELETE/COPY/MOVE/APPEND/
  // LIST/STATUS); a folder name containing CRLF would break out of the command
  // line and inject arbitrary IMAP commands.
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(s)) {
    throw new Error("Invalid folder name: control characters are not allowed");
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("IMAP read timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── FETCH / ENVELOPE parsing ────────────────────────────────────────────────────

type Token = string | Token[];

/** Parse a single "* N FETCH (...)" line into a summary. */
function parseFetchLine(line: string): ImapMessageSummary | null {
  const open = line.indexOf("(");
  if (open === -1) return null;
  const tokens = tokenize(line.slice(open));
  // tokens[0] is the parenthesised attribute list.
  const attrs = Array.isArray(tokens[0]) ? tokens[0] : tokens;

  let uid = 0;
  let flags: string[] = [];
  let envelope: ImapEnvelope = {
    subject: "(no subject)",
    from: [],
    to: [],
    date: new Date().toISOString(),
    messageId: "",
  };
  let hasAttachments = false;
  let preview = "";

  for (let i = 0; i < attrs.length; i++) {
    const key = attrs[i];
    if (key === "UID" && typeof attrs[i + 1] === "string") {
      uid = Number(attrs[i + 1]);
    } else if (key === "FLAGS" && Array.isArray(attrs[i + 1])) {
      flags = (attrs[i + 1] as Token[]).filter((t): t is string => typeof t === "string");
    } else if (key === "ENVELOPE" && Array.isArray(attrs[i + 1])) {
      envelope = parseEnvelope(attrs[i + 1] as Token[]);
    } else if (key === "BODYSTRUCTURE" && Array.isArray(attrs[i + 1])) {
      hasAttachments = bodyStructureHasAttachment(attrs[i + 1] as Token[]);
    } else if (
      typeof key === "string" && key.startsWith("BODY[") &&
      typeof attrs[i + 1] === "string"
    ) {
      preview = snippetToPreview(attrs[i + 1] as string);
    }
  }

  if (!uid) return null;
  return { uid, flags, envelope, hasAttachments, preview };
}

/**
 * Best-effort preview from a fetched body snippet: decode the part (base64 or
 * soft QP), strip HTML tags, collapse whitespace, cap at 200 chars. Returns ""
 * for binary/undecodable content.
 */
function snippetToPreview(snippet: string): string {
  // Base64 path: many providers (e.g. Fastmail) transfer-encode text parts as
  // base64, wrapped at ~76 chars with CRLF. After whitespace-stripping, such a
  // snippet is essentially the base64 alphabet only. Detect via ratio so prose
  // (with spaces/punctuation) is not misclassified, then decode.
  const stripped = snippet.replace(/\s+/g, "");
  if (stripped.length >= 32) {
    const b64Chars = (stripped.match(/[A-Za-z0-9+/=]/g) ?? []).length;
    if (b64Chars / stripped.length >= 0.95) {
      // Partial fetch (<0.2048>) may cut mid-quantum; trim to a multiple of 4.
      const b64 = stripped.slice(0, stripped.length - (stripped.length % 4));
      try {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const text = cleanPreviewText(decoded);
        // If it still looks binary (lots of control / U+FFFD replacement chars), drop it.
        const bad = (text.match(/[\x00-\x08\x0E-\x1F�]/g) ?? []).length;
        if (text && bad / text.length < 0.1) return text;
        return "";
      } catch {
        // Fall through to the plain/QP text path below.
      }
    }
  }

  // Plain / quoted-printable path: decode soft line breaks + =XX hex escapes.
  const t = snippet
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return cleanPreviewText(t);
}

/** Strip HTML tags, collapse whitespace, cap at 200 chars. */
function cleanPreviewText(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Parse an IMAP ENVELOPE token list into structured fields. */
function parseEnvelope(env: Token[]): ImapEnvelope {
  const date = asStr(env[0]);
  const subject = asStr(env[1]);
  const from = parseAddressList(env[2]);
  const to = parseAddressList(env[5]);
  const messageId = asStr(env[9]);

  return {
    subject: subject || "(no subject)",
    from,
    to,
    date: date ? normalizeDate(date) : new Date().toISOString(),
    messageId: messageId || "",
  };
}

/** IMAP address list: list of (name adl mailbox host). */
function parseAddressList(token: Token | undefined): ImapAddress[] {
  if (!Array.isArray(token)) return [];
  const out: ImapAddress[] = [];
  for (const entry of token) {
    if (!Array.isArray(entry)) continue;
    const name = asStr(entry[0]);
    const mailbox = asStr(entry[2]);
    const host = asStr(entry[3]);
    const email = host ? `${mailbox}@${host}` : mailbox;
    if (email) out.push({ name, email });
  }
  return out;
}

/** Heuristic: a BODYSTRUCTURE contains an attachment disposition. */
function bodyStructureHasAttachment(token: Token[]): boolean {
  let found = false;
  const walk = (t: Token): void => {
    if (found) return;
    if (typeof t === "string") {
      if (t.toLowerCase() === "attachment") found = true;
      return;
    }
    for (const child of t) walk(child);
  };
  for (const t of token) walk(t);
  return found;
}

function asStr(t: Token | undefined): string {
  if (typeof t !== "string") return "";
  if (t === "NIL") return "";
  return t;
}

/** Convert an RFC 5322 date string to an ISO 8601 timestamp; fall back to now. */
function normalizeDate(raw: string): string {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/**
 * Tokenize an IMAP parenthesised response into nested arrays of atoms/strings.
 * Handles quoted strings (with escapes), NIL atoms, numbers, and nesting.
 */
function tokenize(input: string): Token[] {
  let i = 0;

  function parseList(): Token[] {
    const list: Token[] = [];
    // assumes input[i] === '('
    i++; // consume '('
    while (i < input.length) {
      const ch = input[i];
      if (ch === ")") {
        i++;
        return list;
      }
      if (ch === " ") {
        i++;
        continue;
      }
      if (ch === "(") {
        list.push(parseList());
        continue;
      }
      if (ch === '"') {
        list.push(parseQuoted());
        continue;
      }
      list.push(parseAtom());
    }
    return list;
  }

  function parseQuoted(): string {
    i++; // consume opening quote
    let s = "";
    while (i < input.length) {
      const ch = input[i];
      if (ch === "\\") {
        s += input[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return s;
      }
      s += ch;
      i++;
    }
    return s;
  }

  function parseAtom(): string {
    let s = "";
    while (i < input.length) {
      const ch = input[i];
      if (ch === " " || ch === "(" || ch === ")" || ch === '"') break;
      s += ch;
      i++;
    }
    return s;
  }

  const result: Token[] = [];
  while (i < input.length) {
    const ch = input[i];
    if (ch === "(") {
      result.push(parseList());
    } else if (ch === " ") {
      i++;
    } else if (ch === '"') {
      result.push(parseQuoted());
    } else {
      result.push(parseAtom());
    }
  }
  return result;
}

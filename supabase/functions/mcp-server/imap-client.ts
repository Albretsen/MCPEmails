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
 * Oversized messages throw ImapMessageTooLargeError rather than being buffered,
 * because this runs in a 256MB Deno isolate that is shared with other tenants'
 * in-flight requests: one unbounded allocation kills the whole worker, not just
 * the request that caused it. See MAX_SHARED_BUFFER_BYTES and
 * DEFAULT_MAX_LITERAL_BYTES below for the two ceilings that enforce this.
 * A faithful Node reference lives at apps/web/src/lib/email/imap.ts.
 */

import { normalizeSnippetPreview } from "./text-extract.ts";
import { connectGuardedTcp } from "./host-guard.ts";

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

/**
 * Thrown when a server response carries a literal larger than the caller's
 * byte budget, or when a single protocol line would grow the read buffer past
 * {@link MAX_SHARED_BUFFER_BYTES}.
 *
 * This exists because the edge isolate has a hard 256MB memory limit and is
 * shared: an unbounded fetch does not fail the offending request, it kills the
 * worker (HTTP 546) and takes every other request in that isolate with it.
 * Refusing the message up front turns an infrastructure-wide failure into an
 * ordinary per-request error the caller can report.
 */
export class ImapMessageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapMessageTooLargeError";
  }
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

/**
 * The silence a UID SEARCH is allowed before its read is abandoned.
 *
 * COMMAND_TIMEOUT_MS is not a command budget, it is an IDLE budget: fifteen
 * seconds with nothing arriving on the socket. That is a generous ceiling for a
 * FETCH, a STORE or a LIST, all of which start answering immediately. It is the
 * wrong ceiling for SEARCH, which is the one command that legitimately goes
 * quiet: the server says nothing at all while it walks the mailbox, then sends
 * the whole UID list at once.
 *
 * The consequence was that the search budget the tools advertise could not be
 * reached. `email_search` races the provider against SEARCH_TIMEOUT_MS (30s) in
 * index.ts, but a silent server tripped this timer at 15s first, so the outer
 * budget was dead code on exactly the mailboxes it existed for. Four of the
 * five search timeouts in the 17:00 hour on 2026-09-01 came back at 15.7s
 * against one OVH host, against one at 31.5s; over thirty days the same shape
 * accounts for eight of the eighty-nine, with Yahoo behind six of the eight
 * worst inboxes.
 *
 * Twenty-five seconds, not thirty: it has to stay UNDER the outer race so a
 * genuinely dead socket is still closed by the timer that knows to destroy the
 * connection, rather than by a deadline that just stops waiting. The bulk tools
 * bound their search phase well below this anyway (see bulk-budget.ts), so this
 * changes nothing for them.
 */
const SEARCH_IDLE_TIMEOUT_MS = 25_000;

/**
 * Default ceiling on a single IMAP literal (one FETCH body, one long header).
 *
 * Sized off what the product actually supports rather than off a round number:
 * callers allow attachments up to 25MB, and a 25MB attachment is roughly 34MB
 * once base64-encoded, before headers and sibling parts. 40MB therefore clears
 * the largest currently-legal message with room to spare while still bounding
 * the allocation. Callers doing cheap work (summaries, flags, folder listings)
 * should pass a much tighter budget: the ceiling is a per-command parameter
 * precisely so a listing operation never pays a fetch-sized worst case.
 */
export const DEFAULT_MAX_LITERAL_BYTES = 40 * 1024 * 1024;

/** Starting size of the shared line buffer, and the size we shrink back to. */
const INITIAL_BUFFER_BYTES = 64 * 1024;

/**
 * Hard ceiling on the shared line buffer. Only whole protocol LINES have to fit
 * here now (large literals are streamed into their own exact-size allocation),
 * and the biggest realistic line is a UID SEARCH result: even a 500k-message
 * mailbox answers in well under 4MB, so 16MB is pathological rather than large.
 */
const MAX_SHARED_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Beyond this size the buffer grows in fixed steps instead of doubling.
 * Doubling is what made the old growth path so expensive: `grown.set(buffer)`
 * holds the old and new allocations simultaneously, so a 32MB buffer doubling
 * to 64MB peaked at 96MB inside a 256MB isolate.
 */
const BUFFER_GROWTH_STEP_BYTES = 1024 * 1024;

/**
 * Literals at or below this size are served from the shared buffer exactly as
 * before. Larger ones get their own right-sized allocation so the shared buffer
 * is never inflated (and never has to be grown) by a message body.
 */
const LITERAL_STREAM_THRESHOLD_BYTES = 64 * 1024;

/** Scratch chunk used when draining a literal we have refused to buffer. */
const DISCARD_CHUNK_BYTES = 32 * 1024;

/**
 * Stand-in emitted for a captured literal when `readTagged` runs in
 * capture mode. The NUL bytes make collisions with real server data impossible:
 * RFC 3501 forbids NUL inside a quoted string, so no genuine quoted value can
 * ever be mistaken for a placeholder.
 */
const LITERAL_PLACEHOLDER_PREFIX = "\u0000IMAP-LITERAL-";
const LITERAL_PLACEHOLDER_SUFFIX = "\u0000";

function literalPlaceholder(index: number): string {
  return `${LITERAL_PLACEHOLDER_PREFIX}${index}${LITERAL_PLACEHOLDER_SUFFIX}`;
}

/**
 * Swap a placeholder produced by capture mode back for its literal. Returns the
 * value untouched when it is not a placeholder, so callers can run every string
 * attribute through this regardless of whether the server used a literal or a
 * plain quoted string.
 */
function resolveLiteral(value: string, literals: string[]): string {
  if (
    !value.startsWith(LITERAL_PLACEHOLDER_PREFIX) ||
    !value.endsWith(LITERAL_PLACEHOLDER_SUFFIX)
  ) {
    return value;
  }
  const index = Number(
    value.slice(LITERAL_PLACEHOLDER_PREFIX.length, value.length - LITERAL_PLACEHOLDER_SUFFIX.length),
  );
  if (!Number.isInteger(index) || index < 0 || index >= literals.length) return value;
  return literals[index];
}

/** Shape returned by {@link ImapClient.readTagged}. */
interface ImapTaggedResponse {
  status: "OK" | "NO" | "BAD";
  text: string;
  untagged: string[];
  /**
   * Literals captured verbatim, in the order the server sent them, when the
   * command asked for capture mode. Empty otherwise (literals are then inlined
   * into the untagged lines exactly as they always were).
   */
  literals: string[];
}

/** Per-command knobs for {@link ImapClient.readTagged}. */
interface ReadTaggedOptions {
  /** Byte budget for any single literal. Defaults to {@link DEFAULT_MAX_LITERAL_BYTES}. */
  maxLiteralBytes?: number;
  /**
   * Hand literals back through `literals[]` instead of escaping and splicing
   * them into the logical line. Only worth it for commands that fetch large
   * bodies: it skips an escape pass, a giant string concatenation and a
   * re-tokenize pass, each of which was a full-size copy of the message.
   */
  captureLiterals?: boolean;
  /**
   * How long the server may stay SILENT during this one command before the
   * read is abandoned. Defaults to {@link COMMAND_TIMEOUT_MS}.
   *
   * Raised only by UID SEARCH; see {@link SEARCH_IDLE_TIMEOUT_MS} for why that
   * one command needs its own budget and why nothing else gets one.
   */
  idleTimeoutMs?: number;
}

/** A live, authenticated IMAP session over implicit TLS. */
export class ImapClient {
  private conn: Deno.Conn;
  private buffer: Uint8Array;
  private bufStart = 0;
  private bufEnd = 0;
  private tagCounter = 0;
  /**
   * The idle budget in force for the command currently being read.
   *
   * An instance field rather than a parameter threaded through readLine,
   * readExact and discardExact, all of which sit between readTagged and the
   * socket and none of which have any business knowing about timeouts. Safe
   * because `runExclusive` serialises commands on this connection: exactly one
   * readTagged is ever in flight, and it restores the default in a `finally`.
   */
  private readIdleTimeoutMs = COMMAND_TIMEOUT_MS;
  /**
   * Set once the peer has closed the socket. `readLine` answers EOF with an
   * empty string, which used to leave `readTagged` spinning forever waiting for
   * a tagged completion that can never arrive; the flag lets it give up instead.
   */
  private eofReached = false;
  /**
   * Set by {@link destroy}. Distinct from `eofReached` (which means the peer
   * hung up) because the two want different words in the error a caller sees,
   * and because it is also the flag that turns the BadResource a mid-flight
   * close raises into the ordinary end-of-connection path.
   */
  private destroyed = false;
  /**
   * Commands queued or running on this socket. Counted rather than a boolean:
   * a queued-but-not-yet-started command owes the socket just as much work as
   * the running one, and a graceful LOGOUT would wait behind both. Read through
   * {@link busy}.
   */
  private pending = 0;
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

  /**
   * PERMANENTFLAGS from the most recent SELECT, or null when the server sent
   * none. Per-mailbox, so it is reset on every SELECT rather than accumulated.
   */
  private lastPermanentFlags: string[] | null = null;

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
    this.pending++;
    const run = this.commandChain.then(fn, fn);
    // Keep the chain alive regardless of this command's outcome.
    this.commandChain = run.then(() => {}, () => {});
    // Settle-only bookkeeping. Both handlers are supplied so this never becomes
    // an unhandled rejection of its own; the caller still gets `run` untouched.
    const done = () => {
      this.pending--;
    };
    run.then(done, done);
    return run;
  }

  /**
   * True while any command is queued or running on this socket.
   *
   * The one caller that needs this is a session deciding between a graceful
   * LOGOUT and {@link destroy}: LOGOUT is itself a command, so on a busy socket
   * it waits for work whose result nobody is going to read, which is how a
   * handler with a 17-second budget was measured returning at 25 to 36 seconds.
   */
  get busy(): boolean {
    return this.pending > 0;
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
    // SSRF guard. The host on this row was public when the mailbox was
    // connected, but nothing stops its A record being repointed into a private
    // range afterwards, and this line is where that would be cashed in. The
    // guard resolves the name, refuses every non-public answer, and hands back
    // the address it approved so the socket lands there rather than on a name
    // that would be resolved a second time. See host-guard.ts, which is a
    // mirror of apps/web/src/lib/email/host-guard.ts — change one, change both.
    let conn: Deno.TcpConn | Deno.TlsConn = await connectGuardedTcp({
      host: cfg.host,
      port: cfg.port,
      protocol: "imap",
    });

    if (cfg.security !== "starttls") {
      // Implicit TLS on a PINNED address. Deno.connectTls cannot express this:
      // its `hostname` is both the dial target and the certificate name, so
      // pinning through it would check the certificate against an IP. startTls
      // separates the two — the peer comes from the socket, the certificate
      // name from this option — so the address stays pinned and certificate
      // validation is untouched. The eager handshake keeps the failure at the
      // connect step, where connectTls used to raise it.
      const tcp = conn as Deno.TcpConn;
      let tls: Deno.TlsConn;
      try {
        tls = await Deno.startTls(tcp, { hostname: cfg.host });
      } catch (err) {
        try {
          tcp.close();
        } catch { /* startTls may already have consumed the socket */ }
        throw err;
      }
      try {
        await tls.handshake();
      } catch (err) {
        try {
          tls.close();
        } catch { /* nothing was spoken on it */ }
        throw err;
      }
      conn = tls;
    }

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

  /**
   * SELECT a mailbox. Throws if the folder does not exist.
   *
   * Also captures the untagged `* OK [PERMANENTFLAGS (...)]` response code,
   * which is the ONLY way to learn whether this mailbox accepts custom keywords
   * before trying to set one. See {@link permanentFlags}.
   */
  selectMailbox(mailbox: string): Promise<void> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      this.lastPermanentFlags = null;
      await this.write(`${tag} SELECT ${quoteImap(mailbox)}${CRLF}`);
      const resp = await this.readTagged(tag);
      if (resp.status !== "OK") {
        throw new Error(`Mailbox not found: ${mailbox}`);
      }
      this.lastPermanentFlags = parsePermanentFlags(resp.untagged);
    });
  }

  /**
   * PERMANENTFLAGS reported by the last SELECT, or null when the server sent
   * none (which RFC 3501 says to read as "assume flags are permanent", i.e. as
   * an absence of information rather than a refusal).
   *
   * The value callers actually want out of this is whether the mailbox contains
   * `\*`, the server's statement that a client may invent keywords. Interpreting
   * it lives in label-target.ts's `permanentFlagsAllowKeyword` so the rule is
   * shared with the validators rather than restated per call site.
   */
  permanentFlags(): string[] | null {
    return this.lastPermanentFlags;
  }

  /**
   * UID SEARCH; returns matching UIDs (ascending). criteria e.g. "ALL", "UNSEEN".
   *
   * BUGFIX (2026-09-01): the criteria string used to be interpolated straight
   * into the command line and encoded as UTF-8 by `write`, which meant a search
   * term containing any character above U+007F (Norwegian ae/o/aa, French
   * accents, CJK, emoji) put raw multi-byte octets into an IMAP command line
   * that had declared no charset. RFC 3501 6.4.4 says a SEARCH whose operands
   * are not US-ASCII must name the encoding ("SEARCH CHARSET UTF-8 <key>
   * {n}CRLF<octets>"), and strict servers enforce it: Yahoo answered
   * "[BADCHARSET] UID SEARCH Unsupported text encoding" (production, Yahoo
   * IMAP, 2026-09-01T06:36:39Z) and ex4.mail.ovh.net answers "Command Error.
   * 11". Our user base is heavily Norwegian and European, so an accented search
   * term is an ordinary request, not an edge case.
   *
   * The pure-ASCII case is deliberately untouched, byte for byte and round trip
   * for round trip: it is essentially all live traffic, and this method is on
   * the path of every list, search, contact scan and draft lookup in the
   * product. Non-ASCII is detected first and is the ONLY thing that takes the
   * new, chattier path.
   *
   * DESIGN NOTE, why the split happens here and not in `toImapSearch`: a
   * criteria string reaches this method from several places, and only one of
   * them comes out of `toImapSearch`. index.ts also hand-builds
   * `HEADER Message-ID "<...>"` and the contact scanner's
   * `OR OR FROM "Q" TO "Q" CC "Q"`, where Q is a user-supplied name that is
   * every bit as likely to be "Bjorn" spelled properly. Returning a structured
   * operand list from `toImapSearch` would have fixed exactly one of those call
   * sites and left the others encoding raw octets. Parsing the assembled
   * criteria here fixes all of them at once, keeps `toImapSearch` a pure string
   * translator with its existing tests intact, and confines the change to this
   * file. See {@link splitSearchLiterals} for the tokenizer.
   */
  uidSearch(criteria: string): Promise<number[]> {
    return this.runExclusive(async () => {
      // The 99% path. No tokenizing, no CHARSET, no continuation round trip:
      // exactly the single write and single read this command has always done.
      if (!hasNonAscii(criteria)) {
        return await this.uidSearchAsciiUnlocked(criteria);
      }

      const segments = splitSearchLiterals(criteria);
      const resp = await this.uidSearchUtf8Unlocked(segments);
      if (resp.status === "OK") return resp.uids;

      // A server that refuses the charset says so with [BADCHARSET] (RFC 3501
      // response code) or by rejecting the command form outright with a tagged
      // BAD. A plain NO with no BADCHARSET marker is an ordinary search failure
      // (mailbox state, syntax in the caller's `raw` escape hatch) and must not
      // be papered over by retrying a different query.
      if (!isCharsetRejection(resp.status, resp.text)) {
        throw new Error(`UID SEARCH failed: ${resp.text}`);
      }

      // One retry, with the non-ASCII operands folded to their nearest ASCII
      // spelling. This is an approximation and we only make it when it is still
      // recognisably the user's term: an operand that folds away completely
      // (CJK, emoji, Greek) would turn the search into a question nobody asked,
      // and silently returning the results of a different query is worse than
      // an honest failure. See foldSearchCriteriaToAscii.
      const folded = foldSearchCriteriaToAscii(criteria);
      // The second condition is a backstop, not a duplicate of the first. The
      // tokenizer only promotes operands it can identify, and one shape defeats
      // it: an unterminated quoted string arriving through the `raw` escape
      // hatch is copied through verbatim on purpose (rewriting malformed input
      // only makes the server's complaint harder to read), so a non-ASCII
      // character inside one is still there after folding. Retrying with it
      // would put exactly the raw octets this whole change exists to remove
      // back on the wire, so refuse instead.
      if (folded.lost.length > 0 || hasNonAscii(folded.criteria)) {
        const why = folded.lost.length > 0
          ? `the search term ${folded.lost.map((t) => `"${t}"`).join(", ")} ` +
            `has no ASCII equivalent to fall back to`
          : "part of the criteria is not a string operand this client can fold to ASCII";
        throw new Error(
          `UID SEARCH failed: this server rejected CHARSET UTF-8 (${resp.text.trim()}) and ` +
            `${why}, so the search was not run rather than run for something else`,
        );
      }
      return await this.uidSearchAsciiUnlocked(folded.criteria);
    });
  }

  /**
   * The original single-round-trip UID SEARCH, for criteria that are already
   * pure ASCII. Split out of {@link uidSearch} so the fast path and the folded
   * retry share one implementation and cannot drift apart. Unlocked: both
   * callers are already inside `runExclusive`.
   */
  private async uidSearchAsciiUnlocked(criteria: string): Promise<number[]> {
    const tag = this.nextTag();
    await this.write(`${tag} UID SEARCH ${criteria}${CRLF}`);
    const resp = await this.readTagged(tag, { idleTimeoutMs: SEARCH_IDLE_TIMEOUT_MS });
    if (resp.status !== "OK") {
      throw new Error(`UID SEARCH failed: ${resp.text}`);
    }
    return parseSearchUids(resp.untagged);
  }

  /**
   * UID SEARCH CHARSET UTF-8, with every non-ASCII operand sent as a
   * synchronizing literal (RFC 3501 4.3): write up to and including "{n}CRLF",
   * wait for the server's "+" continuation, write exactly n octets, carry on
   * with the rest of the line.
   *
   * `n` is the UTF-8 BYTE count, which is the whole point of the exercise and
   * the classic way to get this wrong: "Bjorn" spelled with the Norwegian o is
   * 5 characters but 6 octets, and a literal that promises 5 leaves the sixth
   * octet sitting in the server's parser as the start of the next command. The
   * count therefore comes from the encoder, never from `String.length`.
   *
   * Returns the tagged outcome rather than throwing so the caller can tell a
   * charset refusal (retryable, folded) from a genuine failure. Unlocked: the
   * caller holds the command lock for the whole multi-step exchange, which is
   * what keeps another command from landing between our "{n}" and our octets.
   */
  private async uidSearchUtf8Unlocked(
    segments: ImapSearchSegment[],
  ): Promise<{ status: "OK" | "NO" | "BAD"; text: string; uids: number[] }> {
    const tag = this.nextTag();
    let pending = `${tag} UID SEARCH CHARSET UTF-8 `;

    for (const segment of segments) {
      if (segment.kind === "verbatim") {
        pending += segment.text;
        continue;
      }
      const bytes = this.encoder.encode(segment.value);
      await this.write(`${pending}{${bytes.length}}${CRLF}`);
      pending = "";

      const cont = await this.readLiteralContinuation(tag);
      if (cont !== null) {
        // The server refused the command at the continuation point. RFC 3501
        // says it does not read the literal in that case, so we must not send
        // the octets: the socket is already back at a command boundary and the
        // next command (our folded retry) can go out on a fresh tag.
        return { ...cont, uids: [] };
      }
      await this.writeAll(bytes);
    }

    await this.write(`${pending}${CRLF}`);
    const resp = await this.readTagged(tag, { idleTimeoutMs: SEARCH_IDLE_TIMEOUT_MS });
    return {
      status: resp.status,
      text: resp.text,
      uids: resp.status === "OK" ? parseSearchUids(resp.untagged) : [],
    };
  }

  /**
   * Wait for the "+" that authorises us to send a literal's octets.
   *
   * Returns null when the continuation arrived, or the tagged outcome when the
   * server rejected the command instead. Unsolicited untagged data (EXISTS,
   * EXPUNGE, RECENT) is legal at any point in a session and is skipped rather
   * than mistaken for a refusal; APPEND does not do this and has been fine, but
   * APPEND runs right after a SELECT while a search can be issued at any depth
   * of a long-lived session. The 100-line ceiling is only there so a
   * misbehaving server cannot spin this loop.
   */
  private async readLiteralContinuation(
    tag: string,
  ): Promise<{ status: "OK" | "NO" | "BAD"; text: string } | null> {
    for (let i = 0; i < 100; i++) {
      const line = await this.readLine();
      if (line.startsWith("+")) return null;
      if (line.startsWith(`${tag} `)) {
        const m = /^\S+\s+(OK|NO|BAD)\s*(.*)$/.exec(line);
        return { status: (m?.[1] as "OK" | "NO" | "BAD") ?? "BAD", text: m?.[2] ?? line };
      }
      if (this.eofReached) {
        if (this.destroyed) throw destroyedError();
        throw new Error("IMAP connection closed before the literal continuation");
      }
      if (line.startsWith("* ")) continue;
      // Anything else is a protocol response we cannot act on. Treat it as a
      // refusal of this command rather than sending octets into a parser that
      // is plainly not waiting for them.
      return { status: "BAD", text: line };
    }
    throw new Error("IMAP server never sent a literal continuation");
  }

  /**
   * Write every byte of `bytes`, looping until the socket has taken them all.
   *
   * `Deno.Conn.write` is allowed to accept only part of the buffer. Nothing
   * else in this file loops (a short write on a small command line has never
   * been observed), but a literal is the one place where a partial write is not
   * merely a truncated command: the server is counting octets, so the missing
   * tail would be read as the beginning of the next command and desynchronise
   * the connection for the rest of its life.
   */
  private async writeAll(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const written = await this.writeSocket(bytes.subarray(offset));
      if (written <= 0) throw new Error("IMAP socket accepted no bytes of a literal");
      offset += written;
    }
  }

  /**
   * UID FETCH (FLAGS ENVELOPE BODYSTRUCTURE) for a set of UIDs.
   *
   * `includePreview` avoids downloading a body prefix when a caller only needs
   * envelope metadata to rank a larger candidate set. The returned summaries
   * still have a string preview (the empty string when it was not fetched), so
   * callers that expose a preview can fetch it only for their final page.
   *
   * This command only ever asks for envelope metadata and a 2KB body prefix, so
   * `maxLiteralBytes` is worth setting well below the default: a listing has no
   * business buffering a message-sized literal, whatever the server sends.
   */
  fetchSummaries(
    uids: number[],
    options: { includePreview?: boolean; maxLiteralBytes?: number } = {},
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
      const resp = await this.readTagged(tag, {
        maxLiteralBytes: options.maxLiteralBytes,
      });
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
   *
   * `maxLiteralBytes` caps the raw message this call is willing to buffer,
   * defaulting to {@link DEFAULT_MAX_LITERAL_BYTES}; anything larger throws
   * {@link ImapMessageTooLargeError} instead of being read into memory. Callers
   * that only need headers or a small part should pass a far smaller budget so
   * a single outsized message cannot dominate the isolate's memory.
   *
   * The body is fetched in capture mode, which is what keeps this affordable:
   * the literal is decoded once and handed back as-is, rather than being escaped
   * into a quoted string, concatenated into a giant logical line, and then
   * unescaped again by the tokenizer (three extra copies of the whole message).
   */
  fetchMessageRaw(
    uid: number,
    options: { maxLiteralBytes?: number } = {},
  ): Promise<ImapRawMessage | null> {
    return this.runExclusive(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} UID FETCH ${uid} (FLAGS BODY.PEEK[])${CRLF}`);
      const resp = await this.readTagged(tag, {
        maxLiteralBytes: options.maxLiteralBytes,
        captureLiterals: true,
      });
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
          // In capture mode this is a placeholder standing in for the literal;
          // servers that answer with a plain quoted string come back unchanged.
          raw = resolveLiteral(attrs[i + 1] as string, resp.literals);
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
      // Nothing to say goodbye to, and nothing to close: destroy() already did
      // both. Returning quietly rather than failing matters because the callers
      // that reach for destroy are the ones on their way out under a deadline,
      // and a shutdown path that throws on an already-shut-down connection is
      // one more error for them to remember to swallow.
      if (this.destroyed) return;
      try {
        const tag = this.nextTag();
        await this.write(`${tag} LOGOUT${CRLF}`);
        await this.readTagged(tag).catch(() => {});
      } finally {
        this.close();
      }
    });
  }

  /**
   * Close the socket at once, WITHOUT taking the command lock.
   *
   * Bypassing `runExclusive` is the entire point of this method, so it is worth
   * being explicit about why. Callers bound a slow provider search with
   * `Promise.race` against a timer, and `Promise.race` abandons the loser
   * without cancelling it: the socket keeps working on a UID SEARCH or UID
   * FETCH whose result nobody will ever read. `logout()` is an ordinary
   * command and therefore queues behind that abandoned one, which is how
   * handlers with a 17-second budget were measured returning at 25 to 36
   * seconds. A destroy that queued the same way would inherit the same wait and
   * would not be a cancellation at all.
   *
   * The leak matters as much as the latency. When a caller simply returns and
   * orphans the promise, nothing runs `close()` until the abandoned command
   * eventually settles, and the isolate may be recycled first. Yahoo caps an
   * account at 5 simultaneous IMAP connections, so every orphan burns one of
   * five slots until the server's own idle timeout reclaims it.
   *
   * Safe while a command is in flight (its parked read unwinds through the
   * ordinary EOF path and the command rejects saying so), safe to call twice,
   * and safe on a socket that is already closed.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Any command that has not reached its read yet must not start one, and
    // any loop already waiting for a tagged completion has to stop waiting.
    this.eofReached = true;
    this.close();
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
    await this.writeSocket(this.encoder.encode(data));
  }

  /**
   * One socket write, with {@link destroy} folded into a clean failure.
   *
   * A destroy landing while a command is mid-write closes the socket underneath
   * this call and Deno raises BadResource. That is the intended outcome of
   * cancelling, not a fault, and it should read as one: the abandoned command
   * fails with a sentence that says the connection was destroyed rather than
   * with a resource error that looks like a bug in this file.
   */
  private async writeSocket(bytes: Uint8Array): Promise<number> {
    if (this.destroyed) throw destroyedError();
    try {
      return await this.conn.write(bytes);
    } catch (err) {
      if (this.destroyed) throw destroyedError();
      throw err;
    }
  }

  /**
   * One socket read, with the same destroy handling as {@link writeSocket} and
   * the shared command timeout.
   *
   * A read parked on the socket is the whole reason destroy exists, so the
   * parked call has to unwind rather than sit there: null is reported, which is
   * exactly what the peer hanging up looks like, and the caller's existing EOF
   * path carries the command out. `readTagged` then names destroy specifically
   * so the failure is not mistaken for a server that dropped the connection.
   */
  private async readSocket(view: Uint8Array): Promise<number | null> {
    if (this.destroyed) return null;
    try {
      return await withTimeout(this.conn.read(view), this.readIdleTimeoutMs);
    } catch (err) {
      if (this.destroyed) return null;
      throw err;
    }
  }

  /** Refill the internal buffer from the socket. Returns false on EOF. */
  private async fill(): Promise<boolean> {
    if (this.bufStart > 0) {
      this.buffer.copyWithin(0, this.bufStart, this.bufEnd);
      this.bufEnd -= this.bufStart;
      this.bufStart = 0;
    }
    if (this.bufEnd === this.buffer.length) {
      if (this.buffer.length >= MAX_SHARED_BUFFER_BYTES) {
        // Only whole protocol lines live in this buffer, so hitting the ceiling
        // means the server sent a single line larger than any legitimate IMAP
        // response. Failing this one command is far cheaper than letting the
        // allocation climb until the isolate is killed underneath every other
        // request sharing this worker.
        throw new ImapMessageTooLargeError(
          `IMAP response line exceeds the ${MAX_SHARED_BUFFER_BYTES}-byte read-buffer ceiling`,
        );
      }
      // Grow by doubling only while the buffer is small, then in fixed steps.
      // Both the old and the new allocation are live during `set()`, so
      // unbounded doubling is what turned a large read into a memory spike of
      // 1.5x the target size.
      const target = Math.min(
        MAX_SHARED_BUFFER_BYTES,
        this.buffer.length < BUFFER_GROWTH_STEP_BYTES
          ? this.buffer.length * 2
          : this.buffer.length + BUFFER_GROWTH_STEP_BYTES,
      );
      const grown = new Uint8Array(target);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    const n = await this.readSocket(this.buffer.subarray(this.bufEnd));
    if (n === null) return false;
    this.bufEnd += n;
    return true;
  }

  /**
   * Return the buffer to its starting size once a command has finished with it.
   *
   * Without this, a single oversized response left the connection carrying an
   * inflated buffer for the rest of its life, even though every later command
   * only needed a few kilobytes. Skipped when unread bytes would not fit, which
   * cannot happen between commands but keeps the invariant honest.
   */
  private shrinkBuffer(): void {
    if (this.buffer.length <= INITIAL_BUFFER_BYTES) return;
    const pending = this.bufEnd - this.bufStart;
    if (pending > INITIAL_BUFFER_BYTES) return;
    const fresh = new Uint8Array(INITIAL_BUFFER_BYTES);
    if (pending > 0) fresh.set(this.buffer.subarray(this.bufStart, this.bufEnd));
    this.buffer = fresh;
    this.bufStart = 0;
    this.bufEnd = pending;
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
        this.eofReached = true;
        const line = this.decoder.decode(this.buffer.subarray(this.bufStart, this.bufEnd));
        this.bufStart = this.bufEnd;
        return line;
      }
    }
  }

  /** Read exactly n bytes (used for IMAP literals), as a latin1 string. */
  private async readExact(n: number): Promise<string> {
    // Large literals get their own right-sized allocation and are read straight
    // off the socket. Routing them through the shared buffer instead would grow
    // that buffer to the size of the message (plus a transient copy of the old
    // one), and then keep it that big for the life of the connection.
    if (n > LITERAL_STREAM_THRESHOLD_BYTES) {
      const bytes = await this.readExactBytes(n);
      return this.decoder.decode(bytes);
    }
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
   * Read exactly n bytes into a dedicated buffer: whatever the shared buffer is
   * already holding, then the remainder direct from the socket. Returns a short
   * view on EOF, matching what the buffered path does when the peer hangs up
   * mid-literal. Safe to bypass the shared buffer because every caller holds the
   * command lock, so nothing else can be reading this socket.
   */
  private async readExactBytes(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    const buffered = Math.min(n, this.bufEnd - this.bufStart);
    if (buffered > 0) {
      out.set(this.buffer.subarray(this.bufStart, this.bufStart + buffered));
      this.bufStart += buffered;
    }
    if (this.bufStart === this.bufEnd) {
      this.bufStart = 0;
      this.bufEnd = 0;
    }
    let filled = buffered;
    while (filled < n) {
      const read = await this.readSocket(out.subarray(filled));
      if (read === null) {
        this.eofReached = true;
        break;
      }
      filled += read;
    }
    return filled === n ? out : out.subarray(0, filled);
  }

  /**
   * Consume n literal bytes and throw them away, reusing one small scratch
   * chunk so nothing accumulates. Used when a literal is over budget: the bytes
   * are already in flight and IMAP has no way to cancel them mid-response, so
   * the only alternatives are to read past them or to kill the connection.
   * Draining is preferred because it leaves the socket byte-aligned and the
   * session reusable, which matters when the caller is mid-way through a batch.
   */
  private async discardExact(n: number): Promise<void> {
    let remaining = n;
    const buffered = Math.min(remaining, this.bufEnd - this.bufStart);
    this.bufStart += buffered;
    remaining -= buffered;
    if (this.bufStart === this.bufEnd) {
      this.bufStart = 0;
      this.bufEnd = 0;
    }
    const scratch = new Uint8Array(DISCARD_CHUNK_BYTES);
    while (remaining > 0) {
      const chunk = scratch.subarray(0, Math.min(scratch.length, remaining));
      const read = await this.readSocket(chunk);
      if (read === null) {
        this.eofReached = true;
        return;
      }
      remaining -= read;
    }
  }

  /**
   * Read an untagged-line response up to the tagged completion line.
   * Literals ({N}) are expanded inline as IMAP quoted strings so the result is
   * one logical string per untagged item, safe to tokenize.
   *
   * Capture mode changes only what happens to the literal itself: the line gets
   * a short placeholder and the bytes are handed back through `literals[]`. The
   * inline expansion is still the default because every other command in this
   * file relies on reading its values straight out of the logical line.
   *
   * A literal over `maxLiteralBytes` is drained and discarded rather than
   * buffered. We keep reading (discarding further literals, dropping untagged
   * lines) until the tagged completion arrives and only then throw, so the
   * socket is left exactly where the next command expects it: byte-aligned, with
   * no half-read response waiting to corrupt the following one.
   */
  private async readTagged(
    tag: string,
    options: ReadTaggedOptions = {},
  ): Promise<ImapTaggedResponse> {
    const maxLiteralBytes = options.maxLiteralBytes ?? DEFAULT_MAX_LITERAL_BYTES;
    this.readIdleTimeoutMs = options.idleTimeoutMs ?? COMMAND_TIMEOUT_MS;
    const untagged: string[] = [];
    const literals: string[] = [];
    // Size of the first literal that blew the budget; non-null means "finish
    // draining this response, then fail".
    let oversized: number | null = null;

    try {
      while (true) {
        let line = await this.readLine();

        // Expand any trailing/embedded literals on this logical line.
        let litMatch = /\{(\d+)\}$/.exec(line);
        while (litMatch) {
          const n = Number(litMatch[1]);
          if (oversized !== null || n > maxLiteralBytes) {
            if (oversized === null) oversized = n;
            await this.discardExact(n);
            const cont = await this.readLine();
            // The line is on its way to the bin, but it still has to be
            // well-formed enough for the literal scan below to terminate.
            line = line.slice(0, litMatch.index) + '""' + cont;
          } else if (options.captureLiterals) {
            const literal = await this.readExact(n);
            const cont = await this.readLine();
            line = line.slice(0, litMatch.index) +
              `"${literalPlaceholder(literals.length)}"` + cont;
            literals.push(literal);
          } else {
            const literal = await this.readExact(n);
            const cont = await this.readLine();
            line = line.slice(0, litMatch.index) +
              `"${escapeQuoted(literal)}"` + cont;
          }
          litMatch = /\{(\d+)\}$/.exec(line);
        }

        if (line.startsWith(`${tag} `)) {
          if (oversized !== null) {
            throw new ImapMessageTooLargeError(
              `IMAP message is ${oversized} bytes, over the ${maxLiteralBytes}-byte limit for this operation`,
            );
          }
          const m = /^(\S+)\s+(OK|NO|BAD)\s*(.*)$/.exec(line);
          const status = (m?.[2] as "OK" | "NO" | "BAD") ?? "BAD";
          return { status, text: m?.[3] ?? line, untagged, literals };
        }
        if (this.eofReached) {
          // The peer hung up before completing the response, or destroy() did
          // it for us. Without this the loop would spin on empty lines forever,
          // burning the isolate.
          if (this.destroyed) throw destroyedError();
          throw new Error("IMAP connection closed before tagged response");
        }
        // Nothing downstream will look at this response once it is doomed, so
        // stop retaining lines the moment the budget is blown.
        if (oversized === null) untagged.push(line);
      }
    } finally {
      // Back to the default before the next command, whatever happened to this
      // one. A raised budget that leaked would apply a search's patience to
      // every FETCH that followed on the same connection.
      this.readIdleTimeoutMs = COMMAND_TIMEOUT_MS;
      this.shrinkBuffer();
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

/**
 * Pull PERMANENTFLAGS out of a SELECT's untagged lines.
 *
 * The line looks like `* OK [PERMANENTFLAGS (\Answered \Deleted \Seen \*)] ...`.
 * Returns null when the server sent no such line at all, which is a different
 * fact from "sent an empty list" and is why the return type is nullable.
 */
export function parsePermanentFlags(untagged: string[]): string[] | null {
  for (const line of untagged) {
    const m = line.match(/\[PERMANENTFLAGS\s*\(([^)]*)\)\]/i);
    if (m) return m[1].trim().split(/\s+/).filter(Boolean);
  }
  return null;
}

// -- UID SEARCH criteria: charset handling -------------------------------------
//
// Everything below exists to make a non-ASCII UID SEARCH legal on the wire.
// It is deliberately parked with the other wire-format helpers rather than in
// search-translate.ts: search-translate.ts is the pure "NormalizedSearch to a
// provider dialect" translator, it has no idea about literals, continuations or
// sockets, and only one of this client's several UID SEARCH call sites goes
// through it at all. See the design note on ImapClient.uidSearch.

/** One piece of a UID SEARCH command line, as it should be put on the wire. */
export type ImapSearchSegment =
  /** ASCII text to write exactly as given (keywords, dates, UID sets, quoting). */
  | { kind: "verbatim"; text: string }
  /**
   * A string operand that contains non-ASCII and therefore has to travel as an
   * IMAP literal. `value` is the DECODED operand: quoted-string escaping has
   * already been undone, because a literal carries raw octets and must not
   * re-apply it. `quoted` records whether the operand arrived inside a quoted
   * string, which is only needed by the ASCII-folding fallback so it can put
   * the operand back in the shape the caller wrote it.
   */
  | { kind: "literal"; value: string; quoted: boolean };

/** True when the string contains any character outside US-ASCII. */
export function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/**
 * Split an assembled RFC 3501 SEARCH criteria string into the pieces that can
 * go out verbatim and the operands that have to go out as literals.
 *
 * The grammar we have to survive here is narrow but not trivial: the criteria
 * string is whatever `toImapSearch` produced (keywords plus quoted astrings
 * plus dd-Mon-yyyy dates), or one of index.ts's hand-built expressions, or a
 * caller's `raw` escape hatch spliced in unquoted when its first token is a
 * recognised SEARCH key. Non-ASCII can therefore turn up inside a quoted string
 * (SUBJECT "Bjorn") or as a bare atom (a raw query such as `SUBJECT Bjorn`),
 * and both have to become literals: RFC 3501 allows a literal anywhere an
 * astring is allowed, so promoting either one is legal.
 *
 * Anything ASCII is copied through untouched, including the caller's original
 * quoting and escaping. Nothing is re-quoted or re-escaped on this path, so
 * there is no opportunity to change the meaning of a search that was already
 * fine. An unterminated quoted string is also copied through untouched: it is
 * malformed input the server will reject, and rewriting it would only turn a
 * clear error into a confusing one.
 */
export function splitSearchLiterals(criteria: string): ImapSearchSegment[] {
  const segments: ImapSearchSegment[] = [];
  let verbatim = "";
  const flush = () => {
    if (verbatim !== "") {
      segments.push({ kind: "verbatim", text: verbatim });
      verbatim = "";
    }
  };

  let i = 0;
  while (i < criteria.length) {
    const ch = criteria[i];

    if (ch === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < criteria.length) {
        const c = criteria[j];
        if (c === "\\" && j + 1 < criteria.length) {
          value += criteria[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      if (!closed || !hasNonAscii(value)) {
        verbatim += criteria.slice(i, j);
      } else {
        flush();
        segments.push({ kind: "literal", value, quoted: true });
      }
      i = j;
      continue;
    }

    if (ch === " " || ch === "\t") {
      verbatim += ch;
      i++;
      continue;
    }

    // A bare atom: everything up to the next space or quote. Parentheses and
    // the like ride along inside the atom, which is correct as long as the atom
    // is ASCII (it is copied verbatim) and harmless when it is not (an atom
    // carrying a non-ASCII character was never a SEARCH keyword).
    let j = i;
    while (
      j < criteria.length && criteria[j] !== " " && criteria[j] !== "\t" &&
      criteria[j] !== '"'
    ) {
      j++;
    }
    const atom = criteria.slice(i, j);
    if (hasNonAscii(atom)) {
      flush();
      segments.push({ kind: "literal", value: atom, quoted: false });
    } else {
      verbatim += atom;
    }
    i = j;
  }

  flush();
  return segments;
}

/**
 * Characters that have no canonical decomposition, so NFD leaves them intact
 * and the "drop anything still non-ASCII" pass would delete them outright.
 *
 * This matters far more than it looks. The Norwegian o-slash and ae-ligature
 * are exactly this class, and dropping them turns "Bjorn" into "Bjrn" and
 * "Maelstrom" into "Mlstrom", which is not an approximation of the user's term,
 * it is a different word. Handling them explicitly is what makes the fallback
 * worth having for the user base that hit this bug in the first place. Kept
 * small and Latin-only on purpose: a general transliteration table is a
 * library, and a script we cannot approximate honestly (Greek, Cyrillic, CJK)
 * is supposed to fail loudly rather than be guessed at.
 */
const ASCII_FOLD_MAP: Record<string, string> = {
  "Æ": "AE",
  "æ": "ae",
  "Ø": "O",
  "ø": "o",
  "Đ": "D",
  "đ": "d",
  "Ð": "D",
  "ð": "d",
  "Þ": "TH",
  "þ": "th",
  "ß": "ss",
  "Ł": "L",
  "ł": "l",
  "Œ": "OE",
  "œ": "oe",
};

/**
 * Fold a single operand to a searchable ASCII approximation: expand the
 * characters NFD cannot help with, decompose the rest so accents become
 * combining marks, drop the combining marks, then drop whatever is still
 * non-ASCII. An accented "cafe" comes back as "cafe"; a purely CJK or emoji
 * term comes back empty, which is the caller's signal to refuse.
 */
function foldOperandToAscii(value: string): string {
  let mapped = "";
  for (const ch of value) mapped += ASCII_FOLD_MAP[ch] ?? ch;
  return mapped
    .normalize("NFD")
    // Combining Diacritical Marks.
    .replace(/[\u0300-\u036f]/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/[^\x00-\x7F]/g, "");
}

/**
 * Rewrite a criteria string so every operand is ASCII, for the one retry we
 * allow after a server has refused CHARSET UTF-8.
 *
 * `lost` names every operand that folded away to nothing. It is not a warning:
 * the caller is expected to abandon the search entirely when it is non-empty,
 * because a search for the surviving half of the user's criteria is a different
 * search wearing the same result shape, and returning it silently is how a user
 * ends up trusting an answer nobody asked for.
 */
export function foldSearchCriteriaToAscii(
  criteria: string,
): { criteria: string; lost: string[] } {
  const lost: string[] = [];
  let out = "";
  for (const segment of splitSearchLiterals(criteria)) {
    if (segment.kind === "verbatim") {
      out += segment.text;
      continue;
    }
    const folded = foldOperandToAscii(segment.value);
    if (folded.trim() === "") {
      lost.push(segment.value);
      // Never actually shipped (the caller throws on a non-empty `lost`), but
      // the string stays syntactically valid so a future caller that decides to
      // report-and-continue cannot emit a broken command line.
      out += segment.quoted ? '""' : "";
      continue;
    }
    out += segment.quoted ? `"${escapeQuoted(folded)}"` : folded;
  }
  return { criteria: out, lost };
}

/**
 * Does this tagged failure mean "I do not do that charset"?
 *
 * [BADCHARSET] is the RFC 3501 response code for it and is what Yahoo sends. A
 * bare BAD is the other shape it takes: a server that does not implement the
 * optional CHARSET clause rejects the command form rather than the charset, the
 * way ex4.mail.ovh.net answers "Command Error. 11". A NO without the marker is
 * an ordinary search failure and deliberately does not match, because folding
 * and retrying on one of those would change what the user searched for in
 * response to something that had nothing to do with encoding.
 */
export function isCharsetRejection(status: "OK" | "NO" | "BAD", text: string): boolean {
  if (status === "OK") return false;
  if (/badcharset/i.test(text)) return true;
  return status === "BAD";
}

/**
 * Pull the UID list out of a SEARCH response's untagged lines.
 *
 * BUGFIX (2026-09-01): this used to take the FIRST `* SEARCH` line and ignore
 * the rest. Nothing in RFC 3501 promises a server puts its whole answer on one
 * line, and servers do split large result sets across several untagged SEARCH
 * lines. Every continuation line was being dropped, and dropping them does not
 * raise anything: the caller gets a short UID list, an under-reported match
 * total, and a candidate pool that was quietly truncated. That failure gets
 * worse exactly as the mailbox gets bigger, which is the worst possible place
 * to lose results without saying so. Accumulate across every line instead.
 *
 * ESEARCH (RFC 4731) is deliberately NOT parsed here. A server may only answer
 * with the untagged `* ESEARCH` form when the client asked for it, and there
 * are exactly two ways to ask: issue `SEARCH RETURN (...)`, or negotiate
 * IMAP4rev2 with `ENABLE IMAP4rev2` (RFC 9051 replaces the `* SEARCH` response
 * outright). This client does neither. It never sends a RETURN clause, it never
 * sends ENABLE at all, and every criteria string reaching uidSearch is plain
 * RFC 3501 search-key syntax. Speculative ESEARCH parsing would therefore be
 * dead code that no test could exercise honestly. If a RETURN clause or an
 * ENABLE is ever added, this function is the thing that has to change with it.
 *
 * Order is left exactly as the server sent it (servers answer ascending, and
 * callers that care about ordering sort for themselves), so this stays a
 * transcription of the response rather than an interpretation of it.
 */
function parseSearchUids(untagged: string[]): number[] {
  const uids: number[] = [];
  for (const line of untagged) {
    if (!/^\* SEARCH\b/.test(line)) continue;
    for (const token of line.replace(/^\* SEARCH/, "").trim().split(/\s+/)) {
      if (token === "") continue;
      const uid = Number(token);
      if (Number.isFinite(uid)) uids.push(uid);
    }
  }
  return uids;
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

/**
 * The single sentence a caller sees when its command lost a race and something
 * called {@link ImapClient.destroy} underneath it. One factory so the abandoned
 * command reads the same whether it died at a write, at a read, or waiting for
 * a literal continuation, and so a caller can match on it if it ever needs to.
 */
function destroyedError(): Error {
  return new Error("IMAP connection was destroyed while a command was in flight");
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

/**
 * Strip HTML tags, decode entities, drop invisible padding, collapse
 * whitespace, cap at 200 chars.
 *
 * Delegates to the shared cleaner so this path cannot drift from the Gmail and
 * Outlook summaries again. The cap has to come after the invisible strip, not
 * before: a preheader padded with U+200C would otherwise fill all 200
 * characters here and reach the caller as a preview that cleans up to nothing.
 */
function cleanPreviewText(s: string): string {
  return normalizeSnippetPreview(s);
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

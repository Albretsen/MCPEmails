/**
 * lib/email/imap.ts
 *
 * IMAP connection utility for MCPEmails.
 * Implements a full connect → authenticate → operate → logout cycle
 * for Fastmail and generic IMAP providers.
 *
 * Gmail and Outlook use their REST APIs (Gmail API / Microsoft Graph);
 * this utility is only invoked for IMAP-only providers (Fastmail, generic).
 *
 * Connection lifecycle per operation:
 *   1. Open TLS socket (implicit TLS, port 993)
 *   2. Read server greeting, verify "* OK" prefix
 *   3. Authenticate via XOAUTH2 (OAuth tokens) or PLAIN (app passwords)
 *   4. Execute IMAP commands (SELECT, FETCH, SEARCH, STORE)
 *   5. LOGOUT and close socket, always, including on error paths
 *
 * Retry: Fastmail connection-limit errors are retried up to 3 times with
 * exponential back-off (5s → 10s → 20s).
 *
 * See: Documents/Architecture/imap-smtp-connection-management.md
 */

import * as tls from 'tls';

// ── Error codes ───────────────────────────────────────────────────────────────

export type EmailErrorCode =
  | 'CONNECTION_REFUSED'      // Socket connect failed: host unreachable or port blocked
  | 'TLS_HANDSHAKE_FAILED'    // TLS negotiation failed: cert invalid, SNI mismatch
  | 'AUTH_FAILED'             // Wrong credentials or revoked token
  | 'AUTH_TOKEN_EXPIRED'      // Access token expired and refresh failed
  | 'AUTH_SCOPE_INSUFFICIENT' // Token lacks required OAuth scope
  | 'MAILBOX_NOT_FOUND'       // SELECT failed: folder does not exist
  | 'MESSAGE_NOT_FOUND'       // UID not found in mailbox
  | 'IMAP_NO_RESPONSE'        // Server returned NO to a command
  | 'IMAP_BAD_RESPONSE'       // Server returned BAD (malformed command, should never happen)
  | 'IMAP_PROTOCOL_ERROR'     // Unexpected server response format
  | 'SMTP_RELAY_REJECTED'     // Server refused MAIL FROM or RCPT TO
  | 'SMTP_QUOTA_EXCEEDED'     // Sending quota exceeded (provider-level)
  | 'PROVIDER_RATE_LIMITED'   // 429 from Gmail API or Graph API
  | 'PROVIDER_SERVER_ERROR'   // 5xx from Gmail API or Graph API
  | 'CONNECTION_TIMEOUT'      // Socket or API call exceeded timeout budget
  | 'MESSAGE_TOO_LARGE'       // Message exceeds MCPEmails 10 MB limit
  | 'INBOX_INACTIVE';         // Inbox status is not 'active' (config issue, not transient)

// ── Custom error classes ──────────────────────────────────────────────────────

/**
 * Structured error for all MCPEmails email-layer failures.
 * Maps raw protocol errors to typed codes before propagating upward.
 */
export class McpEmailsError extends Error {
  readonly code: EmailErrorCode;

  constructor(code: EmailErrorCode, message: string) {
    super(message);
    this.name = 'McpEmailsError';
    this.code = code;
  }
}

/**
 * IMAP authentication failure (tagged NO response to AUTHENTICATE command).
 */
export class ImapAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapAuthError';
  }
}

/**
 * IMAP NO response (server understood command, but declined: mailbox locked,
 * message not found, permission denied, etc.).
 */
export class ImapNoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapNoError';
  }
}

/**
 * IMAP BAD response (server considers the command malformed).
 * This should not occur from a correctly implemented client; it triggers a
 * Sentry alert upstream.
 */
export class ImapBadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapBadError';
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface ImapConfig {
  /** IMAP server hostname (e.g. "imap.fastmail.com"). */
  host: string;
  /** IMAP server port (993 for implicit TLS). */
  port: number;
  /** Full email address (sender identity; also the default SASL username). */
  email: string;
  /**
   * SASL login username for PLAIN auth. Defaults to `email`. Set this for hosts
   * that issue a login username distinct from the email address.
   */
  username?: string;
  /** Authentication mechanism. */
  authMethod: 'XOAUTH2' | 'PLAIN';
  /**
   * Valid OAuth2 access token. Required when authMethod is 'XOAUTH2'.
   * Must be non-expired; call the provider's token refresh endpoint before
   * constructing ImapConfig if the token expires within 5 minutes.
   */
  accessToken?: string;
  /**
   * App password or account password. Required when authMethod is 'PLAIN'.
   * Transmitted over the TLS-encrypted socket only.
   */
  appPassword?: string;
}

export interface ImapMessage {
  /** IMAP UID (unique within the mailbox). */
  uid: number;
  /** IMAP system flags, e.g. ['\\Seen', '\\Answered']. */
  flags: string[];
  /**
   * Envelope fields (from, to, subject, date, message-id).
   * Present when 'ENVELOPE' was included in the FETCH items string.
   */
  envelope?: {
    subject?: string;
    from?: string;
    to?: string;
    date?: string;
    messageId?: string;
    inReplyTo?: string;
  };
  /**
   * Raw RFC 5322 message bytes as a UTF-8 string.
   * Present when 'RFC822' or 'BODY[]' was included in the FETCH items string.
   */
  body?: string;
  /** Size of the message in bytes (RFC822.SIZE). */
  size?: number;
}

/**
 * A live IMAP session. All methods open one IMAP command sequence on the
 * already-authenticated socket; the socket is not closed between method calls.
 * Call logout() when done to LOGOUT and destroy the socket.
 */
export interface ImapSession {
  /**
   * Fetch messages from a mailbox by UID sequence set.
   *
   * @param mailbox - IMAP folder name, e.g. 'INBOX' or '[Gmail]/All Mail'
   * @param uidSet  - IMAP UID set string, e.g. '1:25' or '100,103,107'
   * @param items   - IMAP data items string, e.g. '(FLAGS ENVELOPE UID)'
   */
  fetch(mailbox: string, uidSet: string, items: string): Promise<ImapMessage[]>;

  /**
   * Search a mailbox and return matching UIDs.
   *
   * @param mailbox  - IMAP folder name
   * @param criteria - IMAP search criteria string, e.g. 'UNSEEN' or 'FROM "someone@example.com"'
   */
  search(mailbox: string, criteria: string): Promise<number[]>;

  /**
   * Update flags on messages identified by UID set.
   *
   * @param mailbox - IMAP folder name
   * @param uidSet  - IMAP UID set string
   * @param flags   - IMAP flag operation, e.g. '+FLAGS (\\Seen)' or '-FLAGS (\\Flagged)'
   */
  store(mailbox: string, uidSet: string, flags: string): Promise<void>;

  /**
   * List available mailboxes matching the pattern.
   *
   * @param refName - Reference name, typically '' (empty string)
   * @param pattern - Mailbox name with wildcards, e.g. '*' for all mailboxes
   */
  list(refName: string, pattern: string): Promise<ImapMailboxInfo[]>;

  /**
   * Send LOGOUT and destroy the socket.
   * Always call this (even on error paths) to allow the server to cleanly
   * account for the disconnected session.
   */
  logout(): Promise<void>;
}

export interface ImapMailboxInfo {
  /** Folder name as reported by the server. */
  name: string;
  /** Folder path delimiter (typically '/' or '.'). */
  delimiter: string;
  /** IMAP attributes, e.g. ['\\HasNoChildren', '\\Sent']. */
  attributes: string[];
}

// ── Private: tag generator ────────────────────────────────────────────────────

let tagCounter = 0;

function nextTag(): string {
  tagCounter = (tagCounter + 1) % 10000;
  return `A${String(tagCounter).padStart(4, '0')}`;
}

// ── Private: buffered line reader ─────────────────────────────────────────────

/**
 * Buffers data events from a TLS socket and provides a promise-based
 * readLine() interface that resolves on each CRLF-terminated line.
 *
 * IMAP literal strings (e.g. "{256}\r\n<256 bytes>") require reading raw bytes
 * rather than text lines. This reader handles the common case (line-oriented
 * commands and responses) and exposes readBytes() for literal sections.
 */
class LineReader {
  private textBuffer = '';
  private readonly pendingLines: string[] = [];
  private readonly lineResolvers: Array<(line: string) => void> = [];
  private readonly errorResolvers: Array<(err: Error) => void> = [];
  private socketError: Error | null = null;

  /** Feed raw bytes received from the socket into the buffer. */
  feed(chunk: Buffer): void {
    this.textBuffer += chunk.toString('binary');
    this.flush();
  }

  /** Signal a socket-level error to pending readers. */
  setError(err: Error): void {
    this.socketError = err;
    for (const reject of this.errorResolvers.splice(0)) {
      reject(err);
    }
    for (const resolve of this.lineResolvers.splice(0)) {
      // Signal error via a sentinel; callers check socketError
      void resolve; // eslint-disable-line @typescript-eslint/no-unused-vars
    }
  }

  private flush(): void {
    const parts = this.textBuffer.split('\r\n');
    // The last element is either '' (ended with CRLF) or an incomplete line.
    this.textBuffer = parts.pop() ?? '';

    for (const line of parts) {
      if (this.lineResolvers.length > 0) {
        const resolve = this.lineResolvers.shift()!;
        resolve(line);
      } else {
        this.pendingLines.push(line);
      }
    }
  }

  /**
   * Returns the next CRLF-terminated line (without the trailing CRLF).
   * Rejects if a socket error occurred.
   */
  readLine(): Promise<string> {
    if (this.socketError !== null) {
      return Promise.reject(this.socketError);
    }
    if (this.pendingLines.length > 0) {
      return Promise.resolve(this.pendingLines.shift()!);
    }
    return new Promise<string>((resolve, reject) => {
      this.lineResolvers.push(resolve);
      this.errorResolvers.push(reject);
    });
  }
}

// ── Private: tagged response reader ──────────────────────────────────────────

interface TaggedResponse {
  status: 'OK' | 'NO' | 'BAD';
  /** Text after the status keyword. */
  text: string;
  /** All untagged lines ("* ...") collected before the tagged response. */
  untagged: string[];
}

async function readTaggedResponse(
  reader: LineReader,
  tag: string,
  timeoutMs: number
): Promise<TaggedResponse> {
  const untagged: string[] = [];
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new McpEmailsError('CONNECTION_TIMEOUT', 'IMAP server did not respond in time');
    }

    // Race between readLine and a timeout.
    const line = await Promise.race([
      reader.readLine(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new McpEmailsError('CONNECTION_TIMEOUT', 'IMAP response timeout')), remaining)
      ),
    ]);

    if (line.startsWith(`${tag} OK`)) {
      return { status: 'OK', text: line.slice(tag.length + 4).trim(), untagged };
    }
    if (line.startsWith(`${tag} NO`)) {
      return { status: 'NO', text: line.slice(tag.length + 4).trim(), untagged };
    }
    if (line.startsWith(`${tag} BAD`)) {
      return { status: 'BAD', text: line.slice(tag.length + 5).trim(), untagged };
    }

    // Collect untagged and continuation lines
    if (line.startsWith('* ') || line.startsWith('+ ')) {
      untagged.push(line);
    }
    // Ignore any other lines (e.g. partial literal continuations not yet supported)
  }
}

// ── Private: SASL token builders ──────────────────────────────────────────────

/**
 * Build the base64-encoded XOAUTH2 string for IMAP AUTH=XOAUTH2.
 *
 * Format (before encoding): "user=<email>\x01auth=Bearer <token>\x01\x01"
 */
function buildXOAuth2Token(email: string, accessToken: string): string {
  const raw = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(raw, 'utf-8').toString('base64');
}

/**
 * Build the base64-encoded PLAIN token for IMAP AUTH=PLAIN.
 *
 * Format (before encoding): "\x00<username>\x00<password>"
 * Transmitted over TLS; the PLAIN label does not imply plaintext transport.
 */
function buildPlainAuthToken(username: string, password: string): string {
  const raw = `\x00${username}\x00${password}`;
  return Buffer.from(raw, 'binary').toString('base64');
}

// ── Private: FETCH response parser ───────────────────────────────────────────

/**
 * Parse a list of untagged IMAP FETCH response lines into ImapMessage objects.
 *
 * IMAP FETCH responses look like:
 *   * 1 FETCH (UID 42 FLAGS (\Seen) ENVELOPE ("..." ...) RFC822.SIZE 1234)
 *
 * This parser handles the most common data items used by MCPEmails:
 * FLAGS, UID, ENVELOPE (subject, from, date, message-id), RFC822.SIZE, and
 * the body literal marker (the actual body bytes are not line-buffered here,
 * they are appended to untagged by the caller when present).
 */
function parseFetchResponse(untaggedLines: string[]): ImapMessage[] {
  const messages: ImapMessage[] = [];
  let i = 0;

  while (i < untaggedLines.length) {
    const line = untaggedLines[i];

    // Match: "* <seq> FETCH (...)"
    const fetchMatch = /^\* \d+ FETCH \((.+)\)$/.exec(line);
    if (!fetchMatch) {
      i++;
      continue;
    }

    const payload = fetchMatch[1];
    const msg: ImapMessage = { uid: 0, flags: [] };

    // Extract UID
    const uidMatch = /\bUID (\d+)\b/.exec(payload);
    if (uidMatch) {
      msg.uid = parseInt(uidMatch[1], 10);
    }

    // Extract FLAGS
    const flagsMatch = /\bFLAGS \(([^)]*)\)/.exec(payload);
    if (flagsMatch) {
      msg.flags = flagsMatch[1]
        .split(' ')
        .map((f) => f.trim())
        .filter(Boolean);
    }

    // Extract RFC822.SIZE
    const sizeMatch = /\bRFC822\.SIZE (\d+)\b/.exec(payload);
    if (sizeMatch) {
      msg.size = parseInt(sizeMatch[1], 10);
    }

    // Extract ENVELOPE. Format: ENVELOPE ("date" "subject" (from) (reply-to) (to) ...)
    // ENVELOPE is complex; extract the fields we care about using positional parsing.
    const envelopeMatch = /\bENVELOPE \(/.exec(payload);
    if (envelopeMatch) {
      try {
        msg.envelope = parseEnvelope(payload.slice(envelopeMatch.index + 10));
      } catch {
        // Envelope parsing failure is non-fatal; leave envelope undefined
      }
    }

    // Check for literal body marker: "{<n>}" indicates the next untagged line(s)
    // contain the body. For now we include whatever the server returned.
    const bodyLiteralMatch = /\bBODY\[\] \{\d+\}$/.exec(line);
    if (bodyLiteralMatch && i + 1 < untaggedLines.length) {
      msg.body = untaggedLines[i + 1];
      i += 2;
    } else {
      i++;
    }

    messages.push(msg);
  }

  return messages;
}

/**
 * Parse the body of an IMAP ENVELOPE parenthesised list into a typed object.
 *
 * ENVELOPE format: ("date" "subject" from-list reply-to-list to-list cc-list
 *                   bcc-list in-reply-to message-id)
 *
 * Each address list is: (("name" NIL "mailbox" "host") ...) or NIL
 */
function parseEnvelope(raw: string): ImapMessage['envelope'] {
  const tokens = tokeniseImap(raw);
  let pos = 0;

  function nextToken(): string | string[] | null {
    if (pos >= tokens.length) return null;
    return tokens[pos++];
  }

  const date = nextToken();
  const subject = nextToken();
  const fromList = nextToken();
  nextToken(); // reply-to
  const toList = nextToken();
  nextToken(); // cc
  nextToken(); // bcc
  const inReplyTo = nextToken();
  const messageId = nextToken();

  return {
    date: typeof date === 'string' && date !== 'NIL' ? date : undefined,
    subject: typeof subject === 'string' && subject !== 'NIL' ? decodeImapString(subject) : undefined,
    from: Array.isArray(fromList) ? formatAddressList(fromList) : undefined,
    to: Array.isArray(toList) ? formatAddressList(toList) : undefined,
    inReplyTo: typeof inReplyTo === 'string' && inReplyTo !== 'NIL' ? inReplyTo : undefined,
    messageId: typeof messageId === 'string' && messageId !== 'NIL' ? messageId : undefined,
  };
}

/** Minimal IMAP response tokeniser for parenthesised lists and quoted strings. */
function tokeniseImap(raw: string): Array<string | string[]> {
  const result: Array<string | string[]> = [];
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    if (ch === ')') {
      break; // End of parent list
    }

    if (ch === '(') {
      // Nested list
      i++;
      const inner = tokeniseImap(raw.slice(i));
      result.push(inner as string[]);
      // Advance past the nested content
      let depth = 1;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '(') depth++;
        if (raw[i] === ')') depth--;
        i++;
      }
      continue;
    }

    if (ch === '"') {
      // Quoted string
      let s = '';
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') i++;
        s += raw[i++];
      }
      i++; // closing quote
      result.push(s);
      continue;
    }

    // Atom (NIL, number, etc.)
    let atom = '';
    while (i < raw.length && raw[i] !== ' ' && raw[i] !== ')' && raw[i] !== '(') {
      atom += raw[i++];
    }
    result.push(atom);
  }

  return result;
}

/** Decode IMAP encoded-word in subject etc. (rudimentary; mailparser handles full decode). */
function decodeImapString(s: string): string {
  // Return as-is; mailparser in the email parser handles full RFC 2047 decode.
  return s;
}

/** Format an IMAP address list token (nested array) as a display string. */
function formatAddressList(list: string[]): string {
  // IMAP address tuple: (name NIL mailbox host)
  if (typeof list[0] === 'string') {
    const name = list[0] !== 'NIL' ? list[0] : '';
    const mailbox = typeof list[2] === 'string' && list[2] !== 'NIL' ? list[2] : '';
    const host = typeof list[3] === 'string' && list[3] !== 'NIL' ? list[3] : '';
    const addr = host ? `${mailbox}@${host}` : mailbox;
    return name ? `${name} <${addr}>` : addr;
  }
  return '';
}

// ── Private: LIST response parser ─────────────────────────────────────────────

/**
 * Parse untagged LIST response lines into ImapMailboxInfo objects.
 *
 * LIST response format: * LIST (\HasNoChildren) "/" "INBOX"
 */
function parseListResponse(untaggedLines: string[]): ImapMailboxInfo[] {
  const mailboxes: ImapMailboxInfo[] = [];

  for (const line of untaggedLines) {
    const match = /^\* LIST \(([^)]*)\) "([^"]*)" (.+)$/.exec(line)
      ?? /^\* LIST \(([^)]*)\) NIL (.+)$/.exec(line);

    if (!match) continue;

    let attributes: string[] = [];
    let delimiter = '/';
    let name = '';

    if (match.length === 4) {
      // With delimiter
      attributes = match[1].split(' ').map((a) => a.trim()).filter(Boolean);
      delimiter = match[2];
      name = match[3].replace(/^"|"$/g, '').trim();
    } else if (match.length === 3) {
      // NIL delimiter
      attributes = match[1].split(' ').map((a) => a.trim()).filter(Boolean);
      name = match[2].replace(/^"|"$/g, '').trim();
    }

    mailboxes.push({ name, delimiter, attributes });
  }

  return mailboxes;
}

// ── Private: socket write helper ──────────────────────────────────────────────

function socketWrite(socket: tls.TLSSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = socket.write(data, 'binary', (err) => {
      if (err) reject(err);
      else resolve();
    });
    if (!ok) {
      socket.once('drain', resolve);
    }
  });
}

// ── Private: sleep helper ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Public: open IMAP session ─────────────────────────────────────────────────

/** Timeout constants (milliseconds) per the architecture spec. */
const TIMEOUT = {
  TCP_CONNECT: 5_000,
  TLS_HANDSHAKE: 5_000,
  AUTHENTICATE: 5_000,
  SELECT: 3_000,
  COMMAND: 8_000,
} as const;

/**
 * Establish a TLS IMAP session and return an ImapSession object.
 *
 * Lifecycle: connect → greeting → authenticate → (return session)
 * The session's methods (fetch, search, store, list) each SELECT the target
 * mailbox and issue the command; logout() sends LOGOUT and destroys the socket.
 *
 * @throws McpEmailsError on connection, TLS, or protocol errors
 * @throws ImapAuthError on authentication failure
 */
export async function openImapSession(config: ImapConfig): Promise<ImapSession> {
  // 1. Open TLS socket with timeout
  const socket = await Promise.race([
    new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect(
        {
          host: config.host,
          port: config.port,
          // Implicit TLS (no STARTTLS); server must speak TLS from the first byte.
          rejectUnauthorized: true,
          // servername for SNI
          servername: config.host,
        },
        () => resolve(s)
      );
      s.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new McpEmailsError('CONNECTION_REFUSED', `Cannot reach IMAP server ${config.host}:${config.port}`));
        } else if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
          reject(new McpEmailsError('TLS_HANDSHAKE_FAILED', `TLS certificate error connecting to ${config.host}`));
        } else {
          reject(new McpEmailsError('TLS_HANDSHAKE_FAILED', `TLS connection failed: ${err.message}`));
        }
      });
    }),
    sleep(TIMEOUT.TCP_CONNECT + TIMEOUT.TLS_HANDSHAKE).then(() => {
      throw new McpEmailsError('CONNECTION_TIMEOUT', `TLS connect to ${config.host}:${config.port} timed out`);
    }),
  ]);

  // 2. Attach line reader
  const reader = new LineReader();
  socket.on('data', (chunk: Buffer) => reader.feed(chunk));
  socket.on('error', (err: Error) => reader.setError(
    new McpEmailsError('CONNECTION_REFUSED', `IMAP socket error: ${err.message}`)
  ));

  // Helper: destroy socket and re-throw
  async function closeOnError<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  // 3. Read server greeting
  await closeOnError(async () => {
    const greeting = await Promise.race([
      reader.readLine(),
      sleep(TIMEOUT.TCP_CONNECT).then<never>(() => {
        throw new McpEmailsError('CONNECTION_TIMEOUT', 'Timed out waiting for IMAP greeting');
      }),
    ]);

    if (!greeting.startsWith('* OK')) {
      throw new McpEmailsError(
        'IMAP_PROTOCOL_ERROR',
        `Unexpected IMAP greeting: ${greeting.slice(0, 80)}`
      );
    }
  });

  // 4. Authenticate
  await closeOnError(async () => {
    const authTag = nextTag();

    if (config.authMethod === 'XOAUTH2') {
      if (!config.accessToken) {
        throw new McpEmailsError('AUTH_FAILED', 'XOAUTH2 requires an accessToken');
      }

      const payload = buildXOAuth2Token(config.email, config.accessToken);
      await socketWrite(socket, `${authTag} AUTHENTICATE XOAUTH2 ${payload}\r\n`);

      const authResult = await readTaggedResponse(reader, authTag, TIMEOUT.AUTHENTICATE);

      if (authResult.status !== 'OK') {
        // Server may send a "+ <base64>" challenge before the tagged NO.
        // We must respond with an empty line to complete the SASL exchange.
        const challenge = authResult.untagged.find((l) => l.startsWith('+ '));
        if (challenge) {
          const challengeBody = challenge.slice(2).trim();
          try {
            const decoded = Buffer.from(challengeBody, 'base64').toString('utf-8');
            // Log the decoded error code internally (no secrets, it's an error object)
            console.error('[IMAP XOAUTH2 challenge]', decoded);
          } catch {
            // Not base64; ignore
          }
          // Respond with empty string to signal we've acknowledged the challenge
          await socketWrite(socket, '\r\n');
          // Read the follow-up tagged response (server resends the NO/BAD)
          await readTaggedResponse(reader, authTag, TIMEOUT.AUTHENTICATE).catch(() => {
            // Best-effort read; we already know auth failed
          });
        }

        socket.destroy();

        // Check for scope-related error in the challenge
        if (challenge?.includes('scope') || challenge?.includes('insufficient')) {
          throw new McpEmailsError('AUTH_SCOPE_INSUFFICIENT', 'Insufficient OAuth scope for IMAP access');
        }

        throw new ImapAuthError(`XOAUTH2 authentication rejected: ${authResult.text}`);
      }
    } else {
      // AUTH PLAIN
      if (!config.appPassword) {
        throw new McpEmailsError('AUTH_FAILED', 'PLAIN auth requires an appPassword');
      }

      const payload = buildPlainAuthToken(config.username || config.email, config.appPassword);
      await socketWrite(socket, `${authTag} AUTHENTICATE PLAIN ${payload}\r\n`);

      const authResult = await readTaggedResponse(reader, authTag, TIMEOUT.AUTHENTICATE);

      if (authResult.status !== 'OK') {
        socket.destroy();
        throw new ImapAuthError(`PLAIN authentication rejected: ${authResult.text}`);
      }
    }
  });

  // ── Session object ──────────────────────────────────────────────────────────

  /** SELECT a mailbox; throws McpEmailsError on NO/BAD. */
  async function selectMailbox(mailbox: string): Promise<void> {
    const selectTag = nextTag();
    await socketWrite(socket, `${selectTag} SELECT "${mailbox}"\r\n`);
    const result = await readTaggedResponse(reader, selectTag, TIMEOUT.SELECT);

    if (result.status === 'NO') {
      throw new McpEmailsError('MAILBOX_NOT_FOUND', `Mailbox not found: ${mailbox}`);
    }
    if (result.status === 'BAD') {
      throw new ImapBadError(`SELECT BAD: ${result.text}`);
    }
  }

  return {
    async fetch(mailbox: string, uidSet: string, items: string): Promise<ImapMessage[]> {
      await selectMailbox(mailbox);

      const fetchTag = nextTag();
      await socketWrite(socket, `${fetchTag} UID FETCH ${uidSet} ${items}\r\n`);
      const result = await readTaggedResponse(reader, fetchTag, TIMEOUT.COMMAND);

      if (result.status === 'NO') {
        throw new McpEmailsError('MESSAGE_NOT_FOUND', `FETCH NO: ${result.text}`);
      }
      if (result.status === 'BAD') {
        throw new ImapBadError(`FETCH BAD: ${result.text}`);
      }

      return parseFetchResponse(result.untagged);
    },

    async search(mailbox: string, criteria: string): Promise<number[]> {
      await selectMailbox(mailbox);

      const searchTag = nextTag();
      await socketWrite(socket, `${searchTag} UID SEARCH ${criteria}\r\n`);
      const result = await readTaggedResponse(reader, searchTag, TIMEOUT.COMMAND);

      if (result.status === 'NO') {
        throw new ImapNoError(`SEARCH NO: ${result.text}`);
      }
      if (result.status === 'BAD') {
        throw new ImapBadError(`SEARCH BAD: ${result.text}`);
      }

      const searchLine = result.untagged.find((l) => l.startsWith('* SEARCH'));
      if (!searchLine || searchLine === '* SEARCH') {
        return [];
      }

      return searchLine
        .slice(9) // strip "* SEARCH "
        .split(' ')
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n));
    },

    async store(mailbox: string, uidSet: string, flags: string): Promise<void> {
      await selectMailbox(mailbox);

      const storeTag = nextTag();
      await socketWrite(socket, `${storeTag} UID STORE ${uidSet} ${flags}\r\n`);
      const result = await readTaggedResponse(reader, storeTag, TIMEOUT.COMMAND);

      if (result.status === 'NO') {
        throw new ImapNoError(`STORE NO: ${result.text}`);
      }
      if (result.status === 'BAD') {
        throw new ImapBadError(`STORE BAD: ${result.text}`);
      }
    },

    async list(refName: string, pattern: string): Promise<ImapMailboxInfo[]> {
      const listTag = nextTag();
      await socketWrite(socket, `${listTag} LIST "${refName}" "${pattern}"\r\n`);
      const result = await readTaggedResponse(reader, listTag, TIMEOUT.COMMAND);

      if (result.status === 'NO') {
        throw new ImapNoError(`LIST NO: ${result.text}`);
      }
      if (result.status === 'BAD') {
        throw new ImapBadError(`LIST BAD: ${result.text}`);
      }

      return parseListResponse(result.untagged);
    },

    async logout(): Promise<void> {
      const logoutTag = nextTag();
      try {
        await socketWrite(socket, `${logoutTag} LOGOUT\r\n`);
        await readTaggedResponse(reader, logoutTag, TIMEOUT.COMMAND);
      } catch {
        // Best-effort LOGOUT; always destroy the socket regardless
      } finally {
        socket.destroy();
      }
    },
  };
}

// ── Public: connect with retry ────────────────────────────────────────────────

/**
 * Open an IMAP session with automatic retry for connection-limit errors.
 *
 * Fastmail enforces a 20-connection-per-account limit. Under burst load from
 * concurrent MCP tool calls, individual connections may be refused. This
 * function retries up to maxRetries times with exponential back-off:
 *   attempt 1 → wait 5s
 *   attempt 2 → wait 10s
 *   attempt 3 → wait 20s
 *
 * Non-retryable errors (auth failure, TLS error, protocol error) are thrown
 * immediately without retrying.
 *
 * @throws McpEmailsError | ImapAuthError on unrecoverable failure
 */
export async function connectImapWithRetry(
  config: ImapConfig,
  maxRetries = 3
): Promise<ImapSession> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await openImapSession(config);
    } catch (err) {
      // Determine whether this is a connection-limit error worth retrying.
      const isConnectionLimit =
        err instanceof ImapNoError &&
        (err.message.includes('connection limit') ||
          err.message.includes('too many connections') ||
          err.message.includes('[LIMIT]'));

      // Auth and TLS errors are permanent: do not retry.
      const isPermanent =
        err instanceof ImapAuthError ||
        (err instanceof McpEmailsError &&
          (err.code === 'AUTH_FAILED' ||
            err.code === 'AUTH_TOKEN_EXPIRED' ||
            err.code === 'AUTH_SCOPE_INSUFFICIENT' ||
            err.code === 'TLS_HANDSHAKE_FAILED' ||
            err.code === 'IMAP_PROTOCOL_ERROR'));

      if (isPermanent) {
        throw err;
      }

      if (isConnectionLimit && attempt < maxRetries) {
        const waitMs = 5_000 * Math.pow(2, attempt - 1); // 5s, 10s, 20s
        await sleep(waitMs);
        continue;
      }

      // Last attempt or non-connection-limit transient error
      if (attempt >= maxRetries) {
        if (isConnectionLimit) {
          throw new McpEmailsError(
            'CONNECTION_REFUSED',
            `IMAP connection limit reached for ${config.host} after ${maxRetries} attempts`
          );
        }
        throw err;
      }

      // Transient error on a non-final attempt: retry with short delay
      await sleep(2_000);
    }
  }

  // TypeScript requires a return here; unreachable in practice.
  throw new McpEmailsError('CONNECTION_REFUSED', 'IMAP connection failed');
}

// ── Public: map caught errors to McpEmailsError ───────────────────────────────

/**
 * Normalise any error from the IMAP layer into a McpEmailsError with the
 * appropriate error code. Call this in MCP tool handlers to ensure consistent
 * error codes reach the JSON-RPC response layer.
 *
 * Inbox status updates (setting status='error') are the responsibility of the
 * caller based on the returned error code, per the error mapping table in the
 * architecture document.
 */
export function toEmailError(err: unknown): McpEmailsError {
  if (err instanceof McpEmailsError) return err;

  if (err instanceof ImapAuthError) {
    return new McpEmailsError('AUTH_FAILED', err.message);
  }

  if (err instanceof ImapBadError) {
    return new McpEmailsError('IMAP_BAD_RESPONSE', err.message);
  }

  if (err instanceof ImapNoError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('nonexistent') || msg.includes('not found') || msg.includes('no such mailbox')) {
      return new McpEmailsError('MAILBOX_NOT_FOUND', err.message);
    }
    return new McpEmailsError('IMAP_NO_RESPONSE', err.message);
  }

  if (err instanceof Error) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ECONNREFUSED') {
      return new McpEmailsError('CONNECTION_REFUSED', err.message);
    }
    if (nodeErr.code === 'ETIMEDOUT' || nodeErr.code === 'ESOCKETTIMEDOUT') {
      return new McpEmailsError('CONNECTION_TIMEOUT', err.message);
    }
    return new McpEmailsError('IMAP_PROTOCOL_ERROR', err.message);
  }

  return new McpEmailsError('IMAP_PROTOCOL_ERROR', 'Unknown IMAP error');
}

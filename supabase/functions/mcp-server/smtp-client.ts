/**
 * smtp-client.ts — minimal SMTP submission client for the MCP edge function.
 *
 * Sends mail for IMAP inboxes (iCloud, Yahoo, Zoho, Yandex, generic) that have
 * no send API. Supports both implicit TLS (port 465) and STARTTLS (port 587),
 * authenticating with whichever password mechanism the server advertises
 * (SASL PLAIN or SASL LOGIN), using the stored app password.
 *
 * Delivery flow: greeting → EHLO → [STARTTLS → EHLO] → AUTH → MAIL FROM →
 * RCPT TO (each recipient) → DATA → message → QUIT.
 *
 * Microsoft Exchange (OVH Hosted Exchange, Microsoft 365) advertises only
 * GSSAPI/NTLM/LOGIN and answers AUTH PLAIN with "504 5.7.4 Unrecognized
 * authentication type", so PLAIN alone cannot send through those hosts.
 *
 * Auth failures throw SmtpAuthError so callers can surface a reconnect prompt.
 */

import { connectGuardedTcp } from "./host-guard.ts";

export class SmtpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpAuthError";
  }
}

/**
 * A submission that provably transmitted nothing.
 *
 * SMTP hands us one clean dividing line: until the server answers DATA with
 * 354 it has not been given a single byte of the message, so every failure
 * before that point (a refused connection, a rejected MAIL FROM, a rejected
 * RCPT TO) means the mail was NOT sent. Past that line the outcome is
 * genuinely unknown and callers must stay conservative.
 *
 * The distinction is not cosmetic. Callers treat a generic send failure as
 * "may or may not have been delivered", which forbids a retry and strands the
 * message; this error tells them the opposite, and that a retry is safe.
 *
 * `retryable` narrows it further: a rejection naming the RECIPIENT address
 * (enhanced status 5.1.x) fails identically no matter how often it is tried,
 * while a rejection naming this SENDER (an IP-reputation or policy block) can
 * succeed from a different egress address.
 */
export class SmtpNotSentError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SmtpNotSentError";
    this.retryable = retryable;
  }
}

export type SmtpSecurity = "tls" | "starttls";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** SASL username (full email address). */
  email: string;
  /** Decrypted app password. */
  password: string;
}

export interface SmtpMessage {
  /** Envelope MAIL FROM address (bare email). */
  from: string;
  /** Envelope RCPT TO recipients (bare emails): to + cc + bcc. */
  recipients: string[];
  /** Full RFC 5322 message with CRLF line endings. */
  rawMessage: string;
}

const EHLO_DOMAIN = "mcpemails.com";
const SMTP_TIMEOUT_MS = 20_000;

/**
 * Total submission attempts, each on a brand new connection.
 *
 * WHY THIS EXISTS. This function runs on Supabase Edge Functions, whose
 * outbound traffic leaves from a rotating pool of AWS addresses. Several mail
 * hosts blocklist AWS ranges wholesale for submission (Domeneshop answers
 * RCPT TO with `550 [ACR04] Amazon AWS IP <addr> may not use this server`)
 * and because the pool rotates, the SAME message to the SAME recipient
 * succeeds or fails depending on which address the invocation happened to get.
 * On 2026-08-30 one inbox saw three rejections and one success inside five
 * minutes with nothing else different.
 *
 * A second attempt on a fresh connection is the cheapest thing that can help,
 * and it is free of the usual retry hazard: this only ever fires before DATA,
 * where duplicate delivery is impossible. It is deliberately ONE extra attempt
 * rather than many: a new connection from the same warm isolate may well reuse
 * the same egress address, so the reliable escape is the caller retrying later
 * (a new isolate, a new address), which {@link SmtpNotSentError} now permits.
 */
const SMTP_SUBMIT_ATTEMPTS = 2;

/** Breathing room between submission attempts. */
const SMTP_RETRY_DELAY_MS = 400;

/**
 * Submit one message, retrying only where a retry provably cannot duplicate it.
 *
 * See {@link SMTP_SUBMIT_ATTEMPTS} for why a retry is needed at all, and
 * {@link SmtpNotSentError} for the DATA dividing line that makes it safe.
 */
export async function sendViaSmtp(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  if (msg.recipients.length === 0) {
    throw new Error("SMTP send: no recipients");
  }

  for (let attempt = 1; attempt <= SMTP_SUBMIT_ATTEMPTS; attempt++) {
    try {
      await submitOnce(cfg, msg);
      return;
    } catch (err) {
      // Anything else (an auth failure, or a failure after the message bytes
      // went out) is either deterministic or indeterminate. Neither may be
      // retried here. The last attempt rethrows for the same reason.
      const last = attempt === SMTP_SUBMIT_ATTEMPTS;
      if (last || !(err instanceof SmtpNotSentError) || !err.retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, SMTP_RETRY_DELAY_MS));
    }
  }
}

/**
 * One connection, one submission attempt.
 *
 * Every failure raised before the server accepts DATA is re-thrown as
 * {@link SmtpNotSentError}; failures after that point pass through unchanged,
 * because from there on we genuinely cannot tell whether the message landed.
 */
async function submitOnce(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  // Flipped the instant the server answers DATA with 354: the next byte we
  // write is the message itself, and no failure past here is safe to retry.
  let dataAccepted = false;

  let conn: Deno.Conn;
  try {
    conn = await connectWithTimeout(cfg);
  } catch (err) {
    // Not one byte of the message existed on the wire.
    throw new SmtpNotSentError(errorText(err), true);
  }

  const session = new SmtpSession(conn);
  try {
    await session.expect(220);
    let capabilities = await session.ehlo(EHLO_DOMAIN);

    if (cfg.security === "starttls") {
      await session.command("STARTTLS", 220);
      // In this branch `conn` is the plain TCP connection from Deno.connect.
      conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: cfg.host });
      session.upgrade(conn);
      // Re-read capabilities under TLS: servers withhold password mechanisms
      // until the session is encrypted (Exchange only adds LOGIN after STARTTLS).
      capabilities = await session.ehlo(EHLO_DOMAIN);
    }

    // A refused mechanism costs one round trip and leaves the session usable,
    // so fall back in place rather than reconnecting.
    let auth: SmtpReply | null = null;
    for (const mechanism of mechanismOrder(advertisedMechanisms(capabilities.lines))) {
      auth = mechanism === "PLAIN"
        ? await session.authPlain(cfg.email, cfg.password)
        : await session.authLogin(cfg.email, cfg.password);
      if (auth.code === 235) break;
      if (!isMechanismRejection(auth)) break;
    }
    if (!auth || auth.code !== 235) {
      const reason = auth
        ? `${auth.code} ${auth.text}`
        : "no supported authentication mechanism";
      throw new SmtpAuthError(`SMTP authentication failed: ${reason}`);
    }

    await session.command(`MAIL FROM:<${msg.from}>`, 250);
    for (const rcpt of msg.recipients) {
      // 250 = accepted, 251 = forwarded.
      const r = await session.commandRaw(`RCPT TO:<${rcpt}>`);
      if (r.code !== 250 && r.code !== 251) {
        throw new SmtpNotSentError(
          `SMTP RCPT TO <${rcpt}> rejected: ${r.code} ${r.text}`,
          !isRecipientAddressRejection(r),
        );
      }
    }

    await session.command("DATA", 354);
    dataAccepted = true;
    await session.writeData(msg.rawMessage);
    await session.expect(250);

    await session.commandRaw("QUIT");
  } catch (err) {
    if (err instanceof SmtpAuthError || err instanceof SmtpNotSentError) throw err;
    // Already classified, or past the point of no return.
    if (dataAccepted) throw err;
    throw new SmtpNotSentError(errorText(err), true);
  } finally {
    session.close();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when the server blamed the RECIPIENT address rather than us.
 *
 * RFC 3463 reserves the 5.1.x enhanced-status class for "bad destination
 * address": no such mailbox, bad syntax, ambiguity. Those verdicts are a property
 * of the address and repeat identically on every attempt, so retrying only
 * spends the caller's time. Rejections aimed at the sender (5.7.x policy, or
 * the bare-code IP blocks that reputation filters emit) carry no such class and
 * stay retryable.
 */
export function isRecipientAddressRejection(reply: SmtpReply): boolean {
  return /\b5\.1\.\d+\b/.test(reply.text);
}

export interface SmtpReply {
  code: number;
  text: string;
  /** Each reply line with its "NNN-" prefix stripped, in order. */
  lines: string[];
}

/** SASL mechanisms this client can perform, both password-based. */
export type SaslMechanism = "PLAIN" | "LOGIN";

/**
 * Mechanisms named on the EHLO `AUTH` line, upper-cased. Both the RFC 4954
 * form (`AUTH LOGIN PLAIN`) and the pre-standard `AUTH=LOGIN PLAIN` that some
 * hosts still emit alongside it are recognised.
 */
export function advertisedMechanisms(lines: readonly string[]): Set<string> {
  const mechanisms = new Set<string>();
  for (const line of lines) {
    const match = /^AUTH[ =](.*)$/i.exec(line.trim());
    if (!match) continue;
    for (const mechanism of match[1].trim().split(/\s+/)) {
      if (mechanism) mechanisms.add(mechanism.toUpperCase());
    }
  }
  return mechanisms;
}

/**
 * PLAIN first when both are offered: one round trip, and it keeps every
 * provider that sends today on precisely the exchange it uses today. A server
 * that advertises no AUTH line still gets both tried, since that list is
 * advisory and a few hosts omit it entirely.
 */
export function mechanismOrder(advertised: Set<string>): SaslMechanism[] {
  const usable = (["PLAIN", "LOGIN"] as const).filter((m) => advertised.has(m));
  return usable.length > 0 ? [...usable] : ["PLAIN", "LOGIN"];
}

/**
 * True when the server refused the mechanism rather than the credential.
 * 504/534 (and 535 carrying enhanced code 5.7.4) mean "I don't do that kind of
 * auth"; a plain 535 is a wrong password and must not trigger a second attempt
 * against the provider's lockout counter.
 */
export function isMechanismRejection(reply: SmtpReply): boolean {
  if (reply.code === 504 || reply.code === 534) return true;
  return reply.code === 535 && /\b5\.7\.4\b/.test(reply.text);
}

/**
 * base64 of UTF-8 bytes. `btoa` throws on any code point above U+00FF, so an
 * app password with an accented character would otherwise fail before it ever
 * reached the server.
 */
function b64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

class SmtpSession {
  private conn: Deno.Conn;
  private buffer = "";
  private readonly decoder = new TextDecoder("latin1");
  private readonly encoder = new TextEncoder();
  private readBuf = new Uint8Array(8192);

  constructor(conn: Deno.Conn) {
    this.conn = conn;
  }

  /** Swap the underlying connection (after STARTTLS upgrade). */
  upgrade(conn: Deno.Conn): void {
    this.conn = conn;
  }

  close(): void {
    try {
      this.conn.close();
    } catch {
      // already closed
    }
  }

  async ehlo(domain: string): Promise<SmtpReply> {
    return await this.command(`EHLO ${domain}`, 250);
  }

  /** SASL PLAIN in one command: base64("\0" + user + "\0" + pass). */
  async authPlain(username: string, password: string): Promise<SmtpReply> {
    return await this.commandRaw(`AUTH PLAIN ${b64(`\x00${username}\x00${password}`)}`);
  }

  /**
   * SASL LOGIN: `AUTH LOGIN` → base64 username → base64 password, each a
   * separate line answered with a 334 challenge. The username is not sent as an
   * initial response because that is the form Exchange is inconsistent about.
   */
  async authLogin(username: string, password: string): Promise<SmtpReply> {
    const challenge = await this.commandRaw("AUTH LOGIN");
    if (challenge.code !== 334) return challenge;
    const prompt = await this.commandRaw(b64(username));
    if (prompt.code !== 334) return prompt;
    return await this.commandRaw(b64(password));
  }

  /** Send a command and assert the reply code equals `expected`. */
  async command(line: string, expected: number): Promise<SmtpReply> {
    const reply = await this.commandRaw(line);
    if (reply.code !== expected) {
      throw new Error(`SMTP: "${line.split(" ")[0]}" expected ${expected}, got ${reply.code} ${reply.text}`);
    }
    return reply;
  }

  /** Send a command and return the parsed reply without asserting. */
  async commandRaw(line: string): Promise<SmtpReply> {
    await this.conn.write(this.encoder.encode(line + "\r\n"));
    return this.readReply();
  }

  /** Read a reply (no command) and assert the code. */
  async expect(expected: number): Promise<SmtpReply> {
    const reply = await this.readReply();
    if (reply.code !== expected) {
      throw new Error(`SMTP: expected ${expected}, got ${reply.code} ${reply.text}`);
    }
    return reply;
  }

  /** Write the DATA payload with dot-stuffing and the terminating <CRLF>.<CRLF>. */
  async writeData(rawMessage: string): Promise<void> {
    const normalized = rawMessage.replace(/\r?\n/g, "\r\n");
    // Dot-stuffing: any line starting with '.' gets an extra leading '.'.
    const stuffed = normalized.replace(/^\./gm, "..");
    await this.conn.write(this.encoder.encode(stuffed + "\r\n.\r\n"));
  }

  /** Read a (possibly multi-line) SMTP reply and return its code + joined text. */
  private async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      // Format: "NNN<sp>text" (final) or "NNN-text" (continuation).
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) {
        // Unexpected line; keep reading until a parseable terminal line.
        continue;
      }
      lines.push(m[3]);
      if (m[2] === " ") {
        return { code: Number(m[1]), text: lines.join(" "), lines: [...lines] };
      }
    }
  }

  private async readLine(): Promise<string> {
    while (true) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        return line;
      }
      const n = await withTimeout(this.conn.read(this.readBuf), SMTP_TIMEOUT_MS);
      if (n === null) {
        const rest = this.buffer;
        this.buffer = "";
        return rest;
      }
      this.buffer += this.decoder.decode(this.readBuf.subarray(0, n));
    }
  }
}

/**
 * Open the submission socket through the SSRF guard.
 *
 * The host comes off a stored inbox row, and nothing stops its A record being
 * repointed into a private range after the mailbox was connected; this is the
 * line where that would be cashed in. The guard resolves the name, refuses
 * every non-public answer, and returns the address it approved so the socket
 * lands there rather than on a name that would be resolved a second time.
 *
 * Implicit TLS is reached by dialling that pinned address and then upgrading
 * with `Deno.startTls(conn, { hostname })`. `Deno.connectTls` cannot express
 * this, because its single `hostname` is both the dial target and the
 * certificate name: pinning through it would validate the certificate against
 * an IP. Splitting the two keeps the address pinned with certificate
 * validation completely intact. The handshake is forced here so that a TLS
 * failure still lands inside the connect timeout below, as it did when this
 * was `Deno.connectTls`.
 *
 * See host-guard.ts, a mirror of apps/web/src/lib/email/host-guard.ts. A change
 * to either must be made to the other.
 */
async function openGuardedSmtpConn(cfg: SmtpConfig): Promise<Deno.Conn> {
  const tcp = await connectGuardedTcp({ host: cfg.host, port: cfg.port, protocol: "smtp" });
  if (cfg.security !== "tls") return tcp;

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
  return tls;
}

/**
 * Open the SMTP TCP/TLS connection with a bounded timeout. Deno.connect(Tls)
 * has no built-in connect timeout, so an unreachable/filtered submission port
 * would otherwise block until the OS connect timeout (~130s) and blow past the
 * edge wall-clock limit. Race the connect against SMTP_TIMEOUT_MS (the same
 * guard used for reads); on timeout, close the socket if it lands late and
 * surface a clean, no-retry-safe error.
 */
async function connectWithTimeout(cfg: SmtpConfig): Promise<Deno.Conn> {
  const connectPromise = openGuardedSmtpConn(cfg);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `SMTP connect timeout — ${cfg.host}:${cfg.port} did not respond within ${SMTP_TIMEOUT_MS}ms (submission port unreachable)`,
          ),
        ),
      SMTP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([connectPromise, timeout]);
  } catch (err) {
    // If the connect resolves after the timeout rejected, don't leak the socket.
    connectPromise.then((c) => c.close()).catch(() => {});
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("SMTP read timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

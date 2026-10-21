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
import {
  connectThroughRelay,
  guardRelayTarget,
  isIpLiteralHost,
  noteRelayFailure,
  noteRelaySuccess,
  relayFailureIsRelayDown,
  type RelayConfig,
  relayFor,
  relayForFallback,
  relayOnlyHost,
  relayConfigured,
  relayRouteFor,
  RelayUnavailableError,
} from "./smtp-relay.ts";
import {
  isOriginRefusalText,
  learnRelayHost,
  noteRelayFallbackFailed,
  recordRelayUse,
  refreshLearnedRelayHosts,
  relayFallbackCoolingDown,
  relayReason,
  type RelayRoute,
} from "./relay-registry.ts";

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

/**
 * The server refused the From address itself: this login may not send as it.
 *
 * Raised for a Send As alias the provider does not recognise for the account,
 * for example iCloud refusing an address that is not an alias of the Apple ID,
 * or Exchange's SendAsDenied. Not sent, and not retryable: every attempt from
 * this address fails the same way until the user changes the provider's alias
 * settings or sends from another address.
 *
 * Covers two points in the exchange. A refused MAIL FROM is before DATA, so
 * nothing was transmitted. A 5xx answer to the end of DATA is a permanent
 * refusal of the message (RFC 5321 4.2.5), so it was not accepted for delivery
 * either; iCloud and Exchange check the From header there, after the body.
 * Only replies whose wording names sender ownership are classified this way
 * (see isSenderOwnershipRefusal), so IP and reputation blocks keep their
 * existing handling.
 */
export class SmtpSenderRefusedError extends SmtpNotSentError {
  constructor(message: string) {
    super(message, false);
    this.name = "SmtpSenderRefusedError";
  }
}

const SENDER_OWNERSHIP_RE = new RegExp(
  [
    String.raw`not (?:one of )?your (?:own )?address`,
    String.raw`not owned by`,
    String.raw`send ?as ?denied`,
    String.raw`not (?:allowed|authori[sz]ed|permitted) to send (?:as|from|on behalf)`,
    String.raw`sender address (?:is )?(?:not allowed|not owned|does not belong|not authori[sz]ed)`,
    String.raw`from address (?:is )?(?:not (?:allowed|owned|authori[sz]ed|verified|permitted)|does not belong)`,
    String.raw`(?:from|sender) (?:address )?(?:does not|doesn't) match`,
    String.raw`does not match (?:the )?(?:authenticated|login|logged[- ]in)`,
    String.raw`\b5\.7\.60\b`,
  ].join("|"),
  "i",
);

/** True for a 5xx reply that blames the From address's ownership. */
export function isSenderOwnershipRefusal(reply: Pick<SmtpReply, "code" | "text">): boolean {
  return reply.code >= 500 && reply.code < 600 && SENDER_OWNERSHIP_RE.test(reply.text);
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
  /**
   * Full RFC 5322 message. A string is UTF-8 encoded on the wire (every body
   * our builder writes is base64, so that is ASCII in practice). Bytes are
   * written exactly as given, which is what a byte-for-byte forward relies on:
   * see forward-relay.ts.
   */
  rawMessage: string | Uint8Array;
}

const EHLO_DOMAIN = "mcpemails.com";
const SMTP_TIMEOUT_MS = 20_000;

/**
 * Ceiling on one socket write, matching {@link SMTP_TIMEOUT_MS} in spirit.
 *
 * Writes had no timeout at all while they were single-shot: a `write` that the
 * kernel accepted into the send buffer returns immediately whether or not the
 * peer ever reads it. {@link writeAllBytes} now loops, and the second and later
 * iterations of that loop are exactly where a stalled peer parks forever, so
 * the loop needs its own bound. Larger than the read timeout because a full
 * DATA payload can legitimately take several round trips to drain.
 */
const SMTP_WRITE_TIMEOUT_MS = 60_000;

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
  // Before any connection: an address that could break its command line is
  // refused here, deterministically and with nothing written to a socket.
  assertEnvelopeSafe(msg);

  // So a host the web app learned a minute ago is relayed here too.
  if (relayConfigured()) await refreshLearnedRelayHosts();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= SMTP_SUBMIT_ATTEMPTS; attempt++) {
    // The second attempt goes through the relay when the first one failed in a
    // way a different egress address can fix (see shouldRetrySmtpThroughRelay).
    // Otherwise it is the plain fresh-connection retry it always was.
    const viaFallback = attempt > 1 && shouldRetrySmtpThroughRelay(cfg.host, lastErr);
    try {
      await submitOnce(cfg, msg, viaFallback ? "fallback" : "auto");
      if (viaFallback) learnRelayHost(cfg.host, "smtp", relayReason(lastErr));
      return;
    } catch (err) {
      if (viaFallback) {
        noteRelayFallbackFailed(cfg.host, "smtp");
        // The relay could not help and nothing was sent either way. The direct
        // attempt's error is the one that describes this mailbox, so it is the
        // one reported. A refusal the relayed attempt got further than that
        // (a real wrong password) is reported as itself.
        if (err instanceof SmtpNotSentError && lastErr !== undefined) throw lastErr;
      }
      lastErr = err;
      // Anything else (an auth failure, or a failure after the message bytes
      // went out) is either deterministic or indeterminate. Neither may be
      // retried here. The last attempt rethrows for the same reason. The one
      // exception is an auth refusal whose own words blame our address, which
      // earns the relay retry and nothing else.
      const last = attempt === SMTP_SUBMIT_ATTEMPTS;
      const retryable = (err instanceof SmtpNotSentError && err.retryable) ||
        (err instanceof SmtpAuthError && shouldRetrySmtpThroughRelay(cfg.host, err));
      if (last || !retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, SMTP_RETRY_DELAY_MS));
    }
  }
}

/**
 * Refuse an envelope whose MAIL FROM or RCPT TO address could break out of its
 * SMTP command line (2026-10-16).
 *
 * The addresses are interpolated into `MAIL FROM:<...>` / `RCPT TO:<...>`, so a
 * CR or LF in one is a second SMTP command in the user's authenticated session
 * (an extra RCPT, a whole extra DATA), and `<`, `>` or whitespace rewrite the
 * command's own syntax. No real address holds any of them. Thrown as a
 * non-retryable {@link SmtpNotSentError}: nothing was sent, and trying again
 * cannot help.
 */
export function assertEnvelopeSafe(msg: Pick<SmtpMessage, "from" | "recipients">): void {
  const bad = [msg.from, ...msg.recipients].find((address) =>
    // deno-lint-ignore no-control-regex
    typeof address !== "string" || address.length === 0 || /[\x00-\x20\x7F<>]/.test(address)
  );
  if (bad !== undefined) {
    // deno-lint-ignore no-control-regex
    const shown = String(bad).replace(/[\x00-\x1F\x7F]/g, "?").slice(0, 200);
    throw new SmtpNotSentError(
      `SMTP envelope refused: "${shown}" is not a valid email address (it contains whitespace, a control character or an angle bracket). Nothing was sent.`,
      false,
    );
  }
}

/**
 * Should a failed submission be tried once more through the relay?
 *
 * Only for a host that is not relayed already (otherwise the failure came
 * through the relay and a second trip changes nothing), only while the relay is
 * up, never for a host whose relay retry failed in the last few minutes, and
 * only for failures a different egress address can fix:
 *
 *   - nothing was sent and the server never got as far as judging the
 *     envelope: a connect that did not open, a greeting that turned us away;
 *   - an envelope or AUTH refusal whose own words blame where we connect from
 *     (relay-registry.ts, isOriginRefusalText). A recipient that does not exist
 *     or a wrong password is the same from any address, so those are left alone.
 *
 * A certificate the host cannot present correctly is its own problem and is
 * never retried: the tunnel would reach the same certificate.
 */
export function shouldRetrySmtpThroughRelay(host: string, err: unknown): boolean {
  if (!relayForFallback()) return false;
  if (relayRouteFor(host, "smtp") !== null) return false;
  if (relayFallbackCoolingDown(host, "smtp")) return false;
  // The relay's filter refuses IP literals, so the retry could only fail.
  if (isIpLiteralHost(host)) return false;
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/certificate|UnknownIssuer|NotValidForName|InvalidCertificate/i.test(text)) return false;
  if (err instanceof SmtpAuthError) return isOriginRefusalText(text);
  if (!(err instanceof SmtpNotSentError) || !err.retryable) return false;
  // The server judged the envelope. Only its own words can say it was about us.
  if (/\b(RCPT TO|MAIL FROM)\b/.test(text)) return isOriginRefusalText(text);
  return true;
}

/**
 * The transport a host reached through the relay is submitted on.
 *
 * The relay's own host blocks outbound 465 (docs/smtp-relay.md), so a row
 * stored as 465 is submitted on 587 with STARTTLS instead. Used for learned
 * hosts and the one-off retry; see {@link relayOnlyTransport} for the
 * relay-only list, which has always had the same rule.
 */
export function relayedTransport(cfg: SmtpConfig): SmtpConfig {
  if (cfg.port !== 465 || cfg.security !== "tls") return cfg;
  return { ...cfg, port: 587, security: "starttls" };
}

/**
 * The transport a relay-only host is actually reached on.
 *
 * The relay's own host blocks outbound 465 (docs/smtp-relay.md), so implicit
 * TLS can never be carried for a host that may only be reached through it. A
 * row stored as 465 is therefore submitted on 587 with STARTTLS instead of
 * being left to time out in the tunnel. Connecting an Orange mailbox stores
 * 587 to begin with; this covers a row that says otherwise. Every other host,
 * and every other port, is returned untouched.
 */
export function relayOnlyTransport(
  cfg: SmtpConfig,
  isRelayOnly: (host: string) => boolean = relayOnlyHost,
): SmtpConfig {
  if (cfg.port !== 465 || cfg.security !== "tls") return cfg;
  if (!isRelayOnly(cfg.host)) return cfg;
  return { ...cfg, port: 587, security: "starttls" };
}

/**
 * One connection, one submission attempt.
 *
 * Every failure raised before the server accepts DATA is re-thrown as
 * {@link SmtpNotSentError}; failures after that point pass through unchanged,
 * because from there on we genuinely cannot tell whether the message landed.
 */
async function submitOnce(
  storedCfg: SmtpConfig,
  msg: SmtpMessage,
  mode: SmtpConnectMode = "auto",
): Promise<void> {
  // Checked again at the line that writes the envelope (defence in depth: a
  // future caller of submitOnce must not be able to skip it).
  assertEnvelopeSafe(msg);
  // Flipped the instant the server answers DATA with 354: the next byte we
  // write is the message itself, and no failure past here is safe to retry.
  let dataAccepted = false;
  const startedMs = Date.now();

  let opened: OpenedSmtpConn;
  try {
    opened = await connectWithTimeout(relayOnlyTransport(storedCfg), mode);
  } catch (err) {
    // Not one byte of the message existed on the wire.
    throw new SmtpNotSentError(errorText(err), true);
  }
  let conn = opened.conn;
  // The transport actually spoken: a relayed 465 row is submitted on 587.
  const cfg = opened.cfg;
  const relayedRoute = opened.route;

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

    // RFC 6152: declare an 8-bit body when the server can take one. A relayed
    // original with `Content-Transfer-Encoding: 8bit` parts is exactly that;
    // everything our own builder writes is base64 and stays 7-bit.
    const eightBit = messageHasEightBit(msg.rawMessage) && advertises8BitMime(capabilities.lines);
    const mailFromLine = `MAIL FROM:<${msg.from}>${eightBit ? " BODY=8BITMIME" : ""}`;
    const mailFrom = await session.commandRaw(mailFromLine);
    if (mailFrom.code !== 250) {
      if (isSenderOwnershipRefusal(mailFrom)) {
        throw new SmtpSenderRefusedError(`SMTP MAIL FROM <${msg.from}> refused: ${mailFrom.code} ${mailFrom.text}`);
      }
      throw mailFromRefusal(msg.from, mailFrom);
    }
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
    const accepted = await session.readReplyRaw();
    if (accepted.code !== 250) {
      if (isSenderOwnershipRefusal(accepted)) {
        throw new SmtpSenderRefusedError(`SMTP message from <${msg.from}> refused: ${accepted.code} ${accepted.text}`);
      }
      throw new Error(`SMTP: expected 250, got ${accepted.code} ${accepted.text}`);
    }

    await session.commandRaw("QUIT");
    if (relayedRoute) {
      recordRelayUse({ protocol: "smtp", host: cfg.host, route: relayedRoute, outcome: "ok", ms: Date.now() - startedMs });
    }
  } catch (err) {
    if (relayedRoute) {
      recordRelayUse({
        protocol: "smtp",
        host: cfg.host,
        route: relayedRoute,
        outcome: "host_refused",
        ms: Date.now() - startedMs,
        detail: relayReason(err),
      });
    }
    if (err instanceof SmtpAuthError || err instanceof SmtpNotSentError) throw err;
    // Already classified, or past the point of no return.
    if (dataAccepted) throw err;
    throw new SmtpNotSentError(errorText(err), true);
  } finally {
    session.close();
  }
}

/**
 * A MAIL FROM answer other than 250, as a not-sent envelope verdict.
 *
 * Worded like the RCPT TO refusal so shouldRetrySmtpThroughRelay can tell the
 * server judged the envelope and only sends it through the relay when the
 * reply blames where we connect from (an ACR04, a listed IP). A plain policy
 * refusal (`550 5.7.1 ... Command rejected`) fails the same from any address.
 * Before 2026-10-21 this was a bare Error that submitOnce wrapped as a
 * retryable not-sent error without the "MAIL FROM" words, so every MAIL-stage
 * refusal earned a relay retry.
 *
 * Retryable unless the reply carries a 5.1.x address-status class: at MAIL
 * that names the sender address itself (5.1.7, 5.1.8), which repeats on every
 * attempt. Everything else keeps the one direct retry it had before.
 */
export function mailFromRefusal(from: string, reply: SmtpReply): SmtpNotSentError {
  return new SmtpNotSentError(
    `SMTP MAIL FROM <${from}> refused: ${reply.code} ${reply.text}`,
    !isRecipientAddressRejection(reply),
  );
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

/**
 * A `Deno.Conn`, reduced to the one method the writer below needs so a test can
 * stand in a socket that accepts short writes the way a real one does.
 */
export interface SmtpByteSink {
  write(bytes: Uint8Array): Promise<number>;
}

/**
 * Write every byte, however many calls that takes.
 *
 * ── THE BUG THIS EXISTS TO PREVENT ─────────────────────────────────────────
 * `Deno.Conn.write` is a THIN wrapper over the platform write syscall and is
 * explicitly allowed to accept only part of the buffer, returning how much it
 * took. Until 2026-09-07 both callers here ignored that number. For a command
 * line ("MAIL FROM:<...>") the buffer is tens of bytes and always fits, so the
 * bug was invisible. For the DATA payload it is the whole message, and once the
 * message grew past the socket's send buffer the write returned short and the
 * tail — including the terminating `<CRLF>.<CRLF>` — was never sent.
 *
 * The server then sat waiting for an end-of-data marker that would never come,
 * `expect(250)` hit the 20-second read timeout, and because that happens AFTER
 * the 354 the failure surfaced as the deliberately conservative "the message
 * may or may not have been delivered. Do not retry automatically." A forward
 * carrying one ~60 KB PDF was enough to cross the line; the same forward with
 * `include_attachments: false` was a few kilobytes and always worked. That is
 * the entire "undocumented size ceiling roughly an order of magnitude below the
 * documented 10 MB budget" reported on 2026-09-07.
 *
 * A short write is not an error and must not be retried as one: the accepted
 * prefix IS on the wire. The only correct response is to advance and write the
 * rest, which is what this does.
 */
export async function writeAllBytes(
  conn: SmtpByteSink,
  bytes: Uint8Array,
  timeoutMs: number = SMTP_WRITE_TIMEOUT_MS,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await withTimeout(
      conn.write(bytes.subarray(offset)),
      timeoutMs,
      "write",
    );
    // Zero would spin this loop forever against a socket that is going nowhere.
    if (written <= 0) throw new Error("SMTP socket accepted no bytes of the message");
    offset += written;
  }
}

/** True when the EHLO reply listed the 8BITMIME extension. */
export function advertises8BitMime(lines: readonly string[]): boolean {
  return lines.some((line) => line.trim().toUpperCase() === "8BITMIME");
}

/** True when the message has an octet (or, for a string, a character) above 0x7F. */
export function messageHasEightBit(rawMessage: string | Uint8Array): boolean {
  if (typeof rawMessage === "string") {
    // deno-lint-ignore no-control-regex
    return /[^\x00-\x7f]/.test(rawMessage);
  }
  for (let i = 0; i < rawMessage.length; i++) if (rawMessage[i] > 0x7f) return true;
  return false;
}

/**
 * The exact bytes that follow a 354: CRLF-normalised, dot-stuffed, terminated.
 *
 * Split out of {@link SmtpSession.writeData} so the byte count the socket has
 * to carry is something a test can assert on directly.
 *
 * The byte form does the same three things without ever decoding the message:
 * a relayed original may carry 8-bit octets that no text round trip could be
 * trusted to preserve, and the only transformations SMTP is owed are line
 * endings, dot-stuffing and the terminator.
 */
export function smtpDataPayload(rawMessage: string | Uint8Array): Uint8Array {
  if (typeof rawMessage === "string") {
    const normalized = rawMessage.replace(/\r?\n/g, "\r\n");
    // Dot-stuffing: any line starting with '.' gets an extra leading '.'.
    const stuffed = normalized.replace(/^\./gm, "..");
    return new TextEncoder().encode(stuffed + "\r\n.\r\n");
  }
  const CR = 0x0d, LF = 0x0a, DOT = 0x2e;
  // Worst case every byte is a stuffed dot or a bare LF, plus the terminator.
  const out = new Uint8Array(rawMessage.length * 2 + 5);
  let o = 0;
  let lineStart = true;
  for (let i = 0; i < rawMessage.length; i++) {
    const b = rawMessage[i];
    if (b === CR && rawMessage[i + 1] === LF) {
      out[o++] = CR;
      out[o++] = LF;
      i++;
      lineStart = true;
      continue;
    }
    if (b === LF) {
      out[o++] = CR;
      out[o++] = LF;
      lineStart = true;
      continue;
    }
    if (lineStart && b === DOT) out[o++] = DOT;
    out[o++] = b;
    lineStart = false;
  }
  out[o++] = CR;
  out[o++] = LF;
  out[o++] = DOT;
  out[o++] = CR;
  out[o++] = LF;
  return out.subarray(0, o);
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
    // One command is one line. A CR or LF inside it would be a second command.
    if (/[\r\n]/.test(line)) {
      throw new Error(`SMTP: refused to write a command containing a line break ("${line.split(" ")[0]}")`);
    }
    await writeAllBytes(this.conn, this.encoder.encode(line + "\r\n"));
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

  /** Read a reply (no command) without asserting the code. */
  async readReplyRaw(): Promise<SmtpReply> {
    return await this.readReply();
  }

  /** Write the DATA payload with dot-stuffing and the terminating <CRLF>.<CRLF>. */
  async writeData(rawMessage: string | Uint8Array): Promise<void> {
    await writeAllBytes(this.conn, smtpDataPayload(rawMessage));
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
 * A few hosts are reached through a relay instead (see smtp-relay.ts); the
 * guard runs identically on that path, and a relay that cannot carry the
 * connection falls back to the direct dial below rather than failing the send.
 *
 * See host-guard.ts, a mirror of apps/web/src/lib/email/host-guard.ts. A change
 * to either must be made to the other.
 */
async function openGuardedSmtpConn(cfg: SmtpConfig, mode: SmtpConnectMode): Promise<OpenedSmtpConn> {
  const relayed = mode === "fallback" ? await openFallbackSmtpConn(cfg) : await openRelayedSmtpConn(cfg);
  if (relayed) return relayed;

  const tcp = await connectGuardedTcp({ host: cfg.host, port: cfg.port, protocol: "smtp" });
  return { conn: await upgradeImplicitTls(tcp, cfg), cfg, route: null };
}

/**
 * "auto" relays exactly the hosts the lists and the registry name; "fallback"
 * is the one retry through the relay after a direct attempt failed (see
 * shouldRetrySmtpThroughRelay), and never dials directly.
 */
type SmtpConnectMode = "auto" | "fallback";

/** An open submission socket, the transport it speaks, and how it was reached. */
interface OpenedSmtpConn {
  conn: Deno.Conn;
  cfg: SmtpConfig;
  /** Null for a direct dial. */
  route: RelayRoute | null;
}

/**
 * The relayed half of {@link openGuardedSmtpConn}, or null to dial directly.
 *
 * Null is the answer for almost every send: no relay configured, this host not
 * on its list and not learned, the relay suspended after an earlier failure, or
 * the relay having just failed here. That last case is the fallback the
 * operator asked for, and it is safe for one reason worth stating plainly:
 * everything this function does happens before SMTP DATA, so a connection that
 * dies here has transmitted nothing and cannot be duplicated by the direct
 * attempt that follows.
 *
 * The TLS handshake is deliberately inside the fallback. A tunnel that opens
 * and then cannot complete a handshake is a broken relay like any other, and
 * the direct path deserves its chance at it.
 *
 * What does NOT fall back is a refusal from the mail host itself, including the
 * guard refusing the host: those verdicts are about the destination, and the
 * direct dial would reach exactly the same one, slower.
 */
async function openRelayedSmtpConn(storedCfg: SmtpConfig): Promise<OpenedSmtpConn | null> {
  const relay = relayFor(storedCfg.host);
  if (!relay) return null;
  const route = relayRouteFor(storedCfg.host, "smtp") ?? "listed";
  // A learned host is submitted on a transport the relay can carry. A listed
  // one keeps its row as it always has (a relay-only row was already rewritten
  // by relayOnlyTransport), so this change cannot move an existing inbox.
  const cfg = route === "learned" ? relayedTransport(storedCfg) : storedCfg;
  const startedMs = Date.now();

  try {
    const conn = await tunnelSmtp(relay, cfg);
    return { conn, cfg, route };
  } catch (err) {
    if (!(err instanceof RelayUnavailableError)) throw err;
    // A relay that refused this one target is healthy; see RelayTargetRefusedError.
    const relayDown = relayFailureIsRelayDown(err);
    if (relayDown) noteRelayFailure();
    recordRelayUse({
      protocol: "smtp",
      host: cfg.host,
      route,
      outcome: relayDown ? "relay_down" : "host_refused",
      ms: Date.now() - startedMs,
      detail: err.message,
    });
    // No direct fallback for a relay-only host: the direct dial is the one path
    // known to be refused there, and its refusal reads as a bad password. The
    // caller reports this as a submission that was not sent and may be retried.
    if (relayOnlyHost(cfg.host)) {
      console.warn("[mcp-server] smtp_relay: unavailable for a relay-only host, not dialling directly", {
        relay: `${relay.host}:${relay.port}`,
        host: cfg.host,
        port: cfg.port,
        error: err.message,
      });
      throw new Error(`Mail relay unavailable for ${cfg.host}: ${err.message}`);
    }
    console.warn("[mcp-server] smtp_relay: falling back to direct egress", {
      relay: `${relay.host}:${relay.port}`,
      host: cfg.host,
      port: cfg.port,
      error: err.message,
    });
    return null;
  }
}

/**
 * The one relayed retry after a direct attempt failed. A relay that cannot
 * carry it is reported as it is, never answered with a direct dial: the direct
 * dial is what just failed.
 */
async function openFallbackSmtpConn(storedCfg: SmtpConfig): Promise<OpenedSmtpConn> {
  const relay = relayForFallback();
  if (!relay) throw new RelayUnavailableError("relay not configured or suspended");
  const cfg = relayedTransport(storedCfg);
  const startedMs = Date.now();
  try {
    const conn = await tunnelSmtp(relay, cfg);
    return { conn, cfg, route: "fallback" };
  } catch (err) {
    if (err instanceof RelayUnavailableError) {
      const relayDown = relayFailureIsRelayDown(err);
      if (relayDown) noteRelayFailure();
      recordRelayUse({
        protocol: "smtp",
        host: cfg.host,
        route: "fallback",
        outcome: relayDown ? "relay_down" : "host_refused",
        ms: Date.now() - startedMs,
        detail: err.message,
      });
    }
    throw err;
  }
}

/** Guard, tunnel and (for implicit TLS) handshake. Relay failures are RelayUnavailableError. */
async function tunnelSmtp(relay: RelayConfig, cfg: SmtpConfig): Promise<Deno.Conn> {
  const target = { host: cfg.host, port: cfg.port };
  await guardRelayTarget(target);
  const tunnel = await connectThroughRelay(relay, target);
  let conn: Deno.Conn;
  try {
    conn = await upgradeImplicitTls(tunnel, cfg);
  } catch (err) {
    throw new RelayUnavailableError(`TLS handshake through relay failed: ${errorText(err)}`);
  }
  noteRelaySuccess();
  console.log("[mcp-server] smtp_relay: connected", {
    relay: `${relay.host}:${relay.port}`,
    host: cfg.host,
    port: cfg.port,
  });
  return conn;
}

/**
 * Turn a raw TCP connection into the connection the session speaks on: an
 * implicit-TLS port is upgraded here, a STARTTLS port later by the session.
 * Shared by both the direct and the relayed path so the certificate is checked
 * against the real hostname either way.
 */
async function upgradeImplicitTls(tcp: Deno.TcpConn, cfg: SmtpConfig): Promise<Deno.Conn> {
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
 *
 * A relay attempt and the direct dial that may follow it share this one budget
 * rather than each getting their own, so adding the relay cannot push a single
 * submission past the window the tool call was already sized for. The relay's
 * own handshake timeout is a small fraction of it, which is what leaves the
 * fallback something to work with.
 */
async function connectWithTimeout(cfg: SmtpConfig, mode: SmtpConnectMode): Promise<OpenedSmtpConn> {
  const connectPromise = openGuardedSmtpConn(cfg, mode);
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
    connectPromise.then((c) => c.conn.close()).catch(() => {});
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, what = "read"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SMTP ${what} timeout`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

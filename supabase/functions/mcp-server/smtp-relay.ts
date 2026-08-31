/**
 * smtp-relay.ts — optional non-AWS egress for SMTP submission.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * This function runs on Supabase Edge Functions, whose outbound traffic leaves
 * from EC2 us-east-1 addresses with `*.compute-1.amazonaws.com` reverse names.
 * Some mail hosts refuse submission from cloud ranges as a matter of policy,
 * not reputation: `smtp.domeneshop.no` answers RCPT TO with
 * `550 [ACR04] Amazon AWS IP <addr> may not use this server`, and Domeneshop's
 * own FAQ says the host is for personal mail clients and not for sending from
 * cloud services. No retry schedule fixes a policy. Only a different egress
 * address does.
 *
 * So for a NAMED, SHORT list of hosts we tunnel the submission through a relay
 * that lives outside AWS. Everything else keeps dialling directly, because the
 * relay is a single point of failure we do not want in the path of the ~200
 * inboxes that have never had a problem.
 *
 * ── What the relay is ──────────────────────────────────────────────────────
 *
 * A plain HTTP CONNECT proxy (stock squid or tinyproxy will do) on a non-AWS
 * host with a clean PTR. We open a tunnel to the real submission host and then
 * run the ordinary SMTP session inside it, so:
 *
 *   - TLS stays END TO END between this function and the mail host. The relay
 *     forwards ciphertext and never sees the mailbox password. That is the
 *     whole reason for CONNECT rather than an SMTP-speaking proxy.
 *   - The certificate is still checked against the real hostname, because the
 *     caller upgrades the tunnel with `Deno.startTls(conn, { hostname })`.
 *
 * The proxy hop itself is plain HTTP, which is a deliberate trade rather than
 * an oversight: `Deno.startTls` upgrades a TCP connection, so a TLS hop to the
 * relay would require TLS inside TLS, which the runtime cannot do, and paying
 * for it would mean giving the relay the cleartext SMTP session (and the
 * password) instead. What an on-path observer can therefore see is the proxy
 * credential and the name of the mail host, not the session. Keep the relay
 * credential rotatable and give the relay a destination allowlist; both are in
 * docs/smtp-relay.md.
 *
 * ── Failure is always allowed to fall back ─────────────────────────────────
 *
 * Every failure up to and including the TLS handshake through the tunnel is
 * reported as {@link RelayUnavailableError}, and the caller answers it by
 * dialling directly instead. That is safe without any further reasoning: all
 * of it happens before SMTP DATA, so nothing can have been transmitted twice.
 * A relay that is down, misconfigured, or removed can therefore only cost a
 * few seconds; it can never cost a message. Once a connect fails, the relay is
 * skipped entirely for {@link RELAY_SUSPEND_MS} so a dead relay is paid for
 * once rather than on every send.
 *
 * A rejection from the MAIL HOST (an ACR04, a bad password) is not a relay
 * failure and must not fall back: the tunnel did its job, and a direct retry
 * would only reach the address that is blocked in the first place.
 */

import { guardMailHostCached, isAllowedAddress, MailHostBlockedError, normalizeMailHost } from "./host-guard.ts";

/** The relay could not carry this connection. The caller should dial directly. */
export class RelayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayUnavailableError";
  }
}

export interface RelayConfig {
  host: string;
  port: number;
  /** Ready-to-send `Proxy-Authorization` value, or null for an open relay. */
  authorization: string | null;
  /** Lower-case host suffixes whose submission goes through the relay. */
  hostSuffixes: string[];
}

export interface RelayTarget {
  host: string;
  port: number;
}

/**
 * Hosts relayed when `SMTP_RELAY_HOSTS` is not set.
 *
 * Deliberately just the one host we have proof about. A relay in front of a
 * provider that does not need it adds a hop, a timeout budget and a second
 * thing to page about, and buys nothing.
 */
export const DEFAULT_RELAY_HOST_SUFFIXES = ["domeneshop.no"];

/** Squid's default. Explicit ports in `SMTP_RELAY_URL` win. */
const DEFAULT_RELAY_PORT = 3128;

/**
 * Budget for the whole relay handshake: TCP connect plus CONNECT round trip.
 *
 * Short on purpose. This is time spent BEFORE the direct attempt that will
 * still be made if it fails, so it is pure added latency on the unhappy path,
 * and it is inside a tool call with roughly 25 seconds end to end. Five
 * seconds is many times a healthy proxy round trip and still leaves the direct
 * connect its full 20-second window.
 */
export const RELAY_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * How long a failed relay is skipped for.
 *
 * Without this, an outage of the relay would add its timeout to every single
 * send for as long as the isolate lives. One minute is long enough that a warm
 * isolate stops paying, short enough that a relay coming back is picked up
 * without a deploy. Per-isolate state, so a fleet-wide recovery costs at most
 * one probe per isolate.
 */
export const RELAY_SUSPEND_MS = 60_000;

/** Cap on the CONNECT response head we are willing to buffer. */
const MAX_CONNECT_HEAD_BYTES = 2_048;

/**
 * True when `host` is the relayed host or a subdomain of it.
 *
 * Matched on label boundaries, never as a bare substring: `notdomeneshop.no`
 * is a different registration from `domeneshop.no` and an attacker who could
 * point an inbox at it must not be able to borrow our relay by naming it.
 */
export function shouldRelayHost(host: string, suffixes: readonly string[]): boolean {
  const target = normalizeMailHost(host);
  if (!target) return false;
  return suffixes.some((suffix) => target === suffix || target.endsWith(`.${suffix}`));
}

/**
 * Read the relay settings out of the environment.
 *
 * Returns null (relaying off, everything dials directly) when
 * `SMTP_RELAY_URL` is unset, unparseable, not `http:`, or when the host list is
 * empty. A bad value must never break sending, so every rejection is logged and
 * degrades to the behaviour we had before this file existed.
 */
export function parseRelayConfig(env: {
  SMTP_RELAY_URL?: string | null;
  SMTP_RELAY_HOSTS?: string | null;
}): RelayConfig | null {
  const raw = (env.SMTP_RELAY_URL ?? "").trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error("[mcp-server] smtp_relay: SMTP_RELAY_URL is not a URL, relaying disabled");
    return null;
  }

  // See the header: the hop to the relay is plain HTTP because the runtime
  // cannot start TLS inside TLS, and the session inside the tunnel is already
  // encrypted end to end.
  if (url.protocol !== "http:") {
    console.error(
      `[mcp-server] smtp_relay: SMTP_RELAY_URL must be http:// (got ${url.protocol}), relaying disabled`,
    );
    return null;
  }

  const host = normalizeMailHost(url.hostname);
  if (!host) {
    console.error("[mcp-server] smtp_relay: SMTP_RELAY_URL has no host, relaying disabled");
    return null;
  }

  const port = url.port ? Number(url.port) : DEFAULT_RELAY_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("[mcp-server] smtp_relay: SMTP_RELAY_URL has an invalid port, relaying disabled");
    return null;
  }

  const hostSuffixes = parseHostSuffixes(env.SMTP_RELAY_HOSTS);
  if (hostSuffixes.length === 0) {
    console.error("[mcp-server] smtp_relay: SMTP_RELAY_HOSTS is empty, relaying disabled");
    return null;
  }

  return { host, port, authorization: basicAuthorization(url), hostSuffixes };
}

function parseHostSuffixes(raw: string | null | undefined): string[] {
  if (raw === undefined || raw === null || raw.trim() === "") return [...DEFAULT_RELAY_HOST_SUFFIXES];
  return raw
    .split(",")
    .map((entry) => normalizeMailHost(entry.trim().replace(/^\.+/, "")))
    .filter((entry) => entry.length > 0);
}

/**
 * `Proxy-Authorization` for the credentials in the URL, or null when there are
 * none. Percent-decoded first: a generated password containing `@` or `:` can
 * only be written into a URL escaped, and would otherwise authenticate as a
 * different, wrong string.
 */
function basicAuthorization(url: URL): string | null {
  if (!url.username && !url.password) return null;
  const user = safeDecode(url.username);
  const password = safeDecode(url.password);
  return `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${password}`)))}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The CONNECT request head, terminated by the blank line that ends it. */
export function buildConnectRequest(target: RelayTarget, authorization: string | null): string {
  const authority = `${target.host}:${target.port}`;
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Proxy-Connection: keep-alive",
  ];
  if (authorization) lines.push(`Proxy-Authorization: ${authorization}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export interface ConnectStatus {
  code: number;
  reason: string;
}

/**
 * The status line of a CONNECT response, or null if this is not one.
 *
 * Only the code matters, since any 2xx means the tunnel is open, but the reason is
 * carried so the log says `407 Proxy Authentication Required` rather than
 * "relay failed", which is the difference between a five-minute fix and an
 * afternoon.
 */
export function parseConnectStatus(head: string): ConnectStatus | null {
  const statusLine = head.split(/\r?\n/, 1)[0] ?? "";
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine.trim());
  if (!match) return null;
  return { code: Number(match[1]), reason: match[2].trim() };
}

export interface RelaySeams {
  connect?: (options: { hostname: string; port: number }) => Promise<Deno.TcpConn>;
  timeoutMs?: number;
}

/**
 * Open a tunnel to `target` through `relay` and hand back the raw socket.
 *
 * The returned connection is a plain TCP connection whose far end is the mail
 * host, which is exactly what the direct path returns, so the caller upgrades
 * and speaks SMTP over it without knowing which one it got.
 *
 * Every failure here is a {@link RelayUnavailableError}: none of them tells us
 * anything about the mail host, and all of them are answered by dialling it
 * directly.
 */
export async function connectThroughRelay(
  relay: RelayConfig,
  target: RelayTarget,
  seams: RelaySeams = {},
): Promise<Deno.TcpConn> {
  const connect = seams.connect ?? ((options) => Deno.connect(options));
  const budget = seams.timeoutMs ?? RELAY_HANDSHAKE_TIMEOUT_MS;
  const started = Date.now();
  const remaining = () => Math.max(1, budget - (Date.now() - started));

  const dial = connect({ hostname: relay.host, port: relay.port });
  let conn: Deno.TcpConn;
  try {
    conn = await withTimeout(dial, remaining(), "connect");
  } catch (err) {
    // A connect that lands after the timeout rejected still owns a socket.
    dial.then(closeQuietly).catch(() => {});
    throw new RelayUnavailableError(`relay ${relay.host}:${relay.port} unreachable: ${errorText(err)}`);
  }

  // The relay is operator configuration rather than user data, so this is not
  // the SSRF check that guardMailHost performs on the mail host; it is the same
  // cheap backstop connectGuardedTcp keeps, and it means a typo or a hijacked
  // DNS answer cannot turn the relay setting into a probe of the private
  // network the function sits in.
  const peer = (conn.remoteAddr as Deno.NetAddr).hostname;
  if (!isAllowedAddress(peer)) {
    closeQuietly(conn);
    throw new RelayUnavailableError(`relay ${relay.host} resolved to a non-public address`);
  }

  try {
    await withTimeout(writeAll(conn, buildConnectRequest(target, relay.authorization)), remaining(), "request");
    const head = await withTimeout(readConnectHead(conn), remaining(), "response");
    const status = parseConnectStatus(head);
    if (status === null) {
      throw new RelayUnavailableError(`relay ${relay.host} did not answer CONNECT with an HTTP status line`);
    }
    if (status.code < 200 || status.code > 299) {
      throw new RelayUnavailableError(
        `relay ${relay.host} refused CONNECT ${target.host}:${target.port}: ${status.code} ${status.reason}`,
      );
    }
  } catch (err) {
    closeQuietly(conn);
    throw err instanceof RelayUnavailableError
      ? err
      : new RelayUnavailableError(`relay ${relay.host} handshake failed: ${errorText(err)}`);
  }

  return conn;
}

/**
 * Read exactly the response head, one byte at a time, stopping on the blank
 * line that ends it.
 *
 * Byte at a time is not timidity. The mail host's TLS ClientHello response (or
 * its SMTP greeting) can arrive in the same TCP segment as the proxy's
 * `200 Connection established`, and anything we over-read here is consumed
 * from a stream we then hand to `startTls`, which would fail the handshake with
 * an error naming neither the relay nor the cause.
 */
async function readConnectHead(conn: Deno.TcpConn): Promise<string> {
  const byte = new Uint8Array(1);
  let head = "";
  while (head.length < MAX_CONNECT_HEAD_BYTES) {
    const read = await conn.read(byte);
    if (read === null) throw new RelayUnavailableError("relay closed the connection during CONNECT");
    if (read === 0) continue;
    head += String.fromCharCode(byte[0]);
    if (head.endsWith("\r\n\r\n") || head.endsWith("\n\n")) return head;
  }
  throw new RelayUnavailableError("relay sent an oversized CONNECT response");
}

async function writeAll(conn: Deno.TcpConn, text: string): Promise<void> {
  let buffer = new TextEncoder().encode(text);
  while (buffer.length > 0) {
    const written = await conn.write(buffer);
    buffer = buffer.subarray(written);
  }
}

// ---------------------------------------------------------------------------
// Per-isolate state: the parsed config, and the breaker that skips a dead relay.
// ---------------------------------------------------------------------------

let cachedConfig: RelayConfig | null | undefined;
let suspendedUntil = 0;

function currentConfig(): RelayConfig | null {
  if (cachedConfig === undefined) {
    cachedConfig = parseRelayConfig({
      SMTP_RELAY_URL: Deno.env.get("SMTP_RELAY_URL"),
      SMTP_RELAY_HOSTS: Deno.env.get("SMTP_RELAY_HOSTS"),
    });
    if (cachedConfig) {
      console.log("[mcp-server] smtp_relay: enabled", {
        relay: `${cachedConfig.host}:${cachedConfig.port}`,
        hosts: cachedConfig.hostSuffixes.join(","),
        authenticated: cachedConfig.authorization !== null,
      });
    }
  }
  return cachedConfig;
}

/** True while the relay is being skipped after a failure. */
export function relaySuspended(now: number = Date.now()): boolean {
  return now < suspendedUntil;
}

export function noteRelayFailure(now: number = Date.now()): void {
  suspendedUntil = now + RELAY_SUSPEND_MS;
}

export function noteRelaySuccess(): void {
  suspendedUntil = 0;
}

/** Test-only: forget the parsed config and the breaker. */
export function resetRelayStateForTests(): void {
  cachedConfig = undefined;
  suspendedUntil = 0;
}

/**
 * The relay to use for this SMTP host, or null to dial it directly.
 *
 * Null covers every ordinary case: relaying not configured, this host not on
 * the list, or the relay currently suspended after a failure.
 */
export function relayFor(host: string, now: number = Date.now()): RelayConfig | null {
  const config = currentConfig();
  if (!config) return null;
  if (!shouldRelayHost(host, config.hostSuffixes)) return null;
  if (relaySuspended(now)) return null;
  return config;
}

/**
 * Validate the mail host exactly as the direct path does, before handing its
 * name to the relay.
 *
 * The relay resolves the name itself, so the address pinning that
 * `connectGuardedTcp` performs cannot apply to this hop. The policy still does:
 * a host that the guard refuses is refused here too, with the same error, and
 * that refusal is NOT a relay failure: falling back to a direct dial would
 * only reach the same verdict.
 */
export async function guardRelayTarget(target: RelayTarget): Promise<void> {
  const verdict = await guardMailHostCached(target.host, { protocol: "smtp", port: target.port });
  if (verdict.ok) return;
  throw new MailHostBlockedError(
    verdict.code,
    normalizeMailHost(target.host) || String(target.host),
    target.port,
    "smtp",
  );
}

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Nothing was spoken on it that anyone needs to hear about.
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RelayUnavailableError(`relay ${stage} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

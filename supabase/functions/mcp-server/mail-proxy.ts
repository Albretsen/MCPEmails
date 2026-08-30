// ---------------------------------------------------------------------------
// Getting a message out from an address the mail host will accept.
//
// ── Why this exists ────────────────────────────────────────────────────────
// These functions run on Supabase, which runs on AWS, so every connection we
// make leaves from an address in Amazon's pool. A growing number of mail hosts
// refuse submission from those ranges outright. Domeneshop is the one that
// forced this: proved on 2026-08-30 by running the identical unauthenticated
// SMTP sequence from two places, where the only difference was the source
// address.
//
//   from a Norwegian consumer line:  550 relay not permitted
//   from AWS (both 465 and 587):     550 [ACR04] Amazon AWS IP <addr> may not
//                                        use this server
//
// No credential is involved in that refusal and no retry can route around it,
// because the whole pool is blocked and both address families with it. The
// message has to physically leave from somewhere else.
//
// ── Why a byte tunnel and not a relay ──────────────────────────────────────
// The obvious build is a small SMTP relay: hand it the message and let it do
// the submission. That would mean the user's mailbox password and the body of
// every email in plaintext on a box that has no business seeing either.
//
// This is a dumb TCP forwarder instead. We ask it to open a socket to the mail
// host, and then run `Deno.startTls` over that socket ourselves, so the TLS
// session terminates at the mail host exactly as it does on a direct
// connection. The proxy shuffles ciphertext and can read none of it.
//
// That property is not a promise, it is enforced by certificate validation: a
// proxy (or anyone who intercepted the first hop) that answered the connection
// itself would have to present a certificate for the mail host's name, and
// `startTls` checks that name. Such an attacker can deny service. It cannot
// read a password.
//
// ── What the first hop does expose ─────────────────────────────────────────
// The control line is plaintext: the destination address, the port, and an
// authenticator. It carries no mailbox credential. The authenticator is an
// HMAC over the destination and an expiry rather than a bare shared token, so
// a captured line cannot be replayed against a different destination, and
// cannot be replayed at all beyond its window.
// ---------------------------------------------------------------------------

import { guardMailHostCached, MailHostBlockedError, normalizeMailHost } from "./host-guard.ts";
import type { MailProtocol } from "./host-guard.ts";

/** How long a signed control line stays valid. Seconds. */
export const MAIL_PROXY_AUTH_TTL_S = 120;

/** Wire format version, so a future change can be rolled out either-order. */
export const MAIL_PROXY_PROTOCOL = "MCPEPROXY/1";

export interface MailProxyConfig {
  host: string;
  port: number;
  secret: string;
}

/**
 * The proxy is opt-in: with nothing configured every send goes direct, exactly
 * as before. That is deliberate. Most hosts accept us fine, the proxy is one
 * more thing that can be down, and a deployment that has not been given a
 * proxy must keep working rather than fail closed.
 */
export function readMailProxyConfig(
  env: { get(key: string): string | undefined } = Deno.env,
): MailProxyConfig | null {
  const host = env.get("MAIL_PROXY_HOST")?.trim();
  const secret = env.get("MAIL_PROXY_SECRET")?.trim();
  const portRaw = env.get("MAIL_PROXY_PORT")?.trim();
  if (!host || !secret) return null;
  const port = portRaw ? Number(portRaw) : 8443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, secret };
}

/** Hex HMAC-SHA256, the one primitive both ends of the control line share. */
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The exact bytes sent to open a tunnel.
 *
 * KEEP IN SYNC with mail-proxy/proxy.ts, which parses this. The format is
 * pinned by mail-proxy.test.ts so a change here fails loudly rather than
 * silently locking the fleet out of its own proxy.
 */
export async function buildProxyControlLine(
  address: string,
  port: number,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const expiry = Math.floor(nowMs / 1000) + MAIL_PROXY_AUTH_TTL_S;
  const payload = `${address} ${port} ${expiry}`;
  return `${MAIL_PROXY_PROTOCOL} CONNECT ${payload} ${await hmacHex(secret, payload)}\n`;
}

/** A refusal from the proxy itself, distinct from one from the mail host. */
export class MailProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailProxyError";
  }
}

/**
 * Open a TCP connection to `host:port` by way of the proxy.
 *
 * The SSRF guard runs HERE, on our side, before the destination is named to
 * anyone: the same resolve-and-pin that a direct dial gets, so routing through
 * the proxy cannot become a way around it. The proxy is handed the pinned
 * ADDRESS rather than the name, so it never repeats the lookup and cannot land
 * somewhere the guard did not approve. It refuses non-public addresses itself
 * as well, which protects its own network rather than ours.
 *
 * The returned socket is the one to the proxy. Callers upgrade it with
 * `Deno.startTls(conn, { hostname })` against the REAL mail host name, which
 * is what keeps the session end to end.
 */
export async function connectViaMailProxy(options: {
  host: string;
  port: number;
  protocol: MailProtocol;
  config: MailProxyConfig;
  /** Test seam. Defaults to Deno.connect. */
  connect?: (o: { hostname: string; port: number }) => Promise<Deno.TcpConn>;
  now?: () => number;
}): Promise<Deno.TcpConn> {
  const { host, port, protocol, config } = options;
  const connect = options.connect ?? ((o) => Deno.connect(o));

  const verdict = await guardMailHostCached(host, { protocol, port });
  if (!verdict.ok) {
    throw new MailHostBlockedError(verdict.code, normalizeMailHost(host) || String(host), port, protocol);
  }

  const conn = await connect({ hostname: config.host, port: config.port });
  try {
    const line = await buildProxyControlLine(
      verdict.address,
      port,
      config.secret,
      (options.now ?? Date.now)(),
    );
    await conn.write(new TextEncoder().encode(line));

    // One short line, then the socket becomes an opaque pipe. Read exactly the
    // reply and no further: anything after it belongs to the mail host, and
    // swallowing a byte of it here would corrupt the SMTP greeting.
    const reply = await readControlReply(conn);
    if (reply !== "OK") {
      throw new MailProxyError(`mail proxy refused the tunnel: ${reply}`);
    }
  } catch (err) {
    try {
      conn.close();
    } catch { /* nothing was spoken on it */ }
    throw err;
  }
  return conn;
}

/**
 * Read the proxy's single-line answer one byte at a time.
 *
 * Byte-at-a-time is not an oversight. A buffered read would take whatever
 * happened to be in the socket, and the very next bytes after the newline are
 * the mail host's 220 greeting; consuming them here would strand the SMTP
 * client waiting for a greeting that had already arrived and been discarded.
 */
async function readControlReply(conn: Deno.Conn): Promise<string> {
  const byte = new Uint8Array(1);
  let out = "";
  while (out.length < 256) {
    const n = await conn.read(byte);
    if (n === null) break;
    const ch = String.fromCharCode(byte[0]);
    if (ch === "\n") break;
    if (ch !== "\r") out += ch;
  }
  return out.trim();
}

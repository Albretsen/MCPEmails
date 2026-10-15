import * as net from 'net';

/**
 * lib/email/mail-relay.ts — a second egress for hosts that refuse ours.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Orange (`imap.orange.fr`, `smtp.orange.fr`) refuses sign-ins that come from
 * this app's own servers. Not the credential: measured 2026-10-12 with one
 * customer login, the same password got `NO [ALERT] Authentication failed.`
 * from our AWS egress and was accepted through the relay, on IMAP and on SMTP,
 * and direct SMTP was turned away at the greeting. A made-up address gets the
 * ordinary `NO [AUTHENTICATIONFAILED]` everywhere, so it is not a blanket block
 * either: Orange refuses real accounts from where we connect.
 *
 * So for those hosts every connection this app opens goes through the relay
 * instead, and is never attempted directly: a direct attempt is known to be
 * refused, reads as a wrong password, and counts as a failed sign-in against
 * the customer's account. The edge function makes the same decision for reads
 * and sends (supabase/functions/mcp-server/smtp-relay.ts, "relay-only hosts").
 * The two lists must name the same hosts.
 *
 * ── What the relay is ──────────────────────────────────────────────────────
 *
 * The same plain HTTP CONNECT proxy the edge function uses
 * (docs/smtp-relay.md). TLS is end to end between this process and the mail
 * host: the relay forwards ciphertext and never sees the mailbox password, and
 * the certificate is still checked against the real hostname by the caller.
 *
 * This module decides WHICH hosts are relayed and opens the tunnel. It knows
 * nothing about IMAP or SMTP.
 */

export interface MailRelayConfig {
  host: string;
  port: number;
  /** Ready-to-send `Proxy-Authorization` value, or null for an open relay. */
  authorization: string | null;
}

/** The relay could not carry this connection. Says nothing about the mail host. */
export class MailRelayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailRelayUnavailableError';
  }
}

/** Squid's default, and what the existing relay listens on. */
const DEFAULT_RELAY_PORT = 3128;

/** TCP connect plus the CONNECT round trip. A healthy relay needs a fraction. */
export const MAIL_RELAY_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Cap on the CONNECT response head we are willing to buffer. */
const MAX_CONNECT_HEAD_BYTES = 2_048;

/**
 * Read the relay from `MAIL_RELAY_URL` (`http://user:password@host:port`).
 * Null when it is unset or unusable, which callers treat as "no relay": the
 * feature is optional and its absence must never fail a connection.
 */
export function mailRelayConfigFromEnv(env: Record<string, string | undefined> = process.env): MailRelayConfig | null {
  const raw = (env.MAIL_RELAY_URL ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // See the header of smtp-relay.ts for why the proxy hop is plain HTTP.
  if (url.protocol !== 'http:' || !url.hostname) return null;
  const port = url.port ? Number(url.port) : DEFAULT_RELAY_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const authorization = user || password
    ? `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
    : null;
  return { host: url.hostname, port, authorization };
}

/**
 * Hosts reached only through the relay. Mirrors
 * `DEFAULT_RELAY_ONLY_HOST_SUFFIXES` in the edge function; change one, change
 * both, or a mailbox will connect here and fail to read there.
 */
export const RELAY_ONLY_MAIL_HOST_SUFFIXES: readonly string[] = ['orange.fr'];

/**
 * The transport a relay-only host is validated and stored on.
 *
 * IMAP is the host's ordinary implicit-TLS port. SMTP is 587 with STARTTLS
 * whatever the user typed, because the relay's own host blocks outbound 465
 * (docs/smtp-relay.md) and Orange offers both.
 */
export const RELAY_ONLY_IMAP_TRANSPORT = { port: 993, security: 'tls' } as const;
export const RELAY_ONLY_SMTP_TRANSPORT = { port: 587, security: 'starttls' } as const;

/** True for a relay-only host or a subdomain of one. Label-boundary match. */
export function isRelayOnlyMailHost(host: string | null | undefined): boolean {
  const target = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!target) return false;
  return RELAY_ONLY_MAIL_HOST_SUFFIXES.some((suffix) => target === suffix || target.endsWith(`.${suffix}`));
}

/**
 * The relay to reach `host` through, or null to dial it directly.
 *
 * Null for every host that is not relay-only, and also when no relay is
 * configured in this environment: the feature must never be the reason a
 * connection cannot be attempted at all.
 */
export function relayForMailHost(
  host: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): MailRelayConfig | null {
  if (!isRelayOnlyMailHost(host)) return null;
  return mailRelayConfigFromEnv(env);
}

/** A mail host name is letters, digits, dots and hyphens. Nothing else may reach the request line. */
const SAFE_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;

/**
 * Open a tunnel to `targetHost:targetPort` through the relay and hand back the
 * raw socket, ready for the caller's TLS handshake.
 *
 * The target is sent BY NAME, not as the address the host guard pinned, because
 * the relay's destination allowlist is a list of names. That is safe here for
 * the reason pinning exists at all: the relay can only ever be asked for a host
 * on its own allowlist, and the caller's TLS handshake still has to present a
 * certificate for that name.
 */
export function openMailRelayTunnel(
  config: MailRelayConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number = MAIL_RELAY_HANDSHAKE_TIMEOUT_MS
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (!SAFE_HOST.test(targetHost) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
      reject(new MailRelayUnavailableError('Relay target is not a plain host and port.'));
      return;
    }
    const socket = net.connect({ host: config.host, port: config.port });
    let head = Buffer.alloc(0);
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new MailRelayUnavailableError(message));
    };
    const timer = setTimeout(() => fail('Relay handshake timed out.'), timeoutMs);

    socket.once('error', (error) => fail(`Relay connection failed: ${error.message}`));
    socket.once('close', () => fail('Relay closed the connection during the handshake.'));
    socket.once('connect', () => {
      const authority = `${targetHost}:${targetPort}`;
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
          (config.authorization ? `Proxy-Authorization: ${config.authorization}\r\n` : '') +
          '\r\n'
      );
    });
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_CONNECT_HEAD_BYTES) fail('Relay sent an oversized response.');
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'));
      if (!status || status[1] !== '200') {
        // The status code only: a proxy's error page is not ours to repeat.
        fail(`Relay refused the tunnel (${status ? status[1] : 'malformed response'}).`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      // Implicit-TLS servers wait for the client's handshake, so nothing should
      // follow the head. If something did, put it back for the caller.
      const rest = head.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

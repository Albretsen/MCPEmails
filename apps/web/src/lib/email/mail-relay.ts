import * as net from 'net';

/**
 * lib/email/mail-relay.ts — a second egress for the connect-time IMAP check.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `imap.orange.fr` answers some logins from this app with
 * `NO [ALERT] Authentication failed.`. That is not Dovecot's wrong-password
 * answer, which is `NO [AUTHENTICATIONFAILED] Authentication failed.` and is
 * what the same server gives a made-up address from AWS, from Hetzner and from
 * a residential line. Dovecot only sends `[ALERT]` when its auth backend
 * attached a refusal reason of its own (imap-login/client-authenticate.c), so
 * the mailbox's provider turned the sign-in down on purpose, and the customers
 * it happens to report that the same password works from their own mail client.
 *
 * What we cannot tell from here is WHAT Orange objects to, because nobody
 * outside France can get an Orange mailbox to test with. So the question is put
 * to the one login that can answer it: when a real sign-in is refused that way,
 * the same check is repeated once from an address that is not this app's, and
 * the outcome is recorded. A relay login that succeeds proves the refusal is
 * about where we connect from; one that is refused the same way proves it is
 * not.
 *
 * ── What the relay is ──────────────────────────────────────────────────────
 *
 * The same plain HTTP CONNECT proxy the edge function already uses for SMTP
 * submission (supabase/functions/mcp-server/smtp-relay.ts, docs/smtp-relay.md).
 * TLS is end to end between this process and the mail host: the relay forwards
 * ciphertext and never sees the mailbox password, and the certificate is still
 * checked against the real hostname by the caller.
 *
 * This module only opens the tunnel. It knows nothing about IMAP.
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

/**
 * lib/email/validate-imap.ts
 *
 * Connect-time IMAP credential validation. Opens a real TLS IMAP connection to
 * the given host and attempts SASL PLAIN authentication, returning the first
 * definitive answer (auth success or failure) and always closing the socket.
 *
 * This is the shared validator behind every app-password / generic-IMAP connect
 * route (Fastmail, iCloud, Yahoo, Zoho, Yandex, generic). It validates IMAP
 * only. SMTP is exercised at serve-time by the edge function, not here.
 *
 * Implicit TLS (port 993) only; no STARTTLS on the IMAP side. All current
 * presets use 993.
 */

import * as tls from 'tls';

/** Hard connection + auth timeout in milliseconds. */
export const IMAP_VALIDATION_TIMEOUT_MS = 10_000;

export type ImapValidationErrorCode =
  | 'AUTH_FAILED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'TLS_HANDSHAKE_FAILED'
  | 'IMAP_PROTOCOL_ERROR';

export interface ImapValidationOk {
  ok: true;
}

export interface ImapValidationError {
  ok: false;
  code: ImapValidationErrorCode;
  message: string;
}

export type ImapValidationResult = ImapValidationOk | ImapValidationError;

export interface ImapCredential {
  /** IMAP server hostname, e.g. "imap.mail.me.com". */
  host: string;
  /** IMAP server port (993 for implicit TLS). */
  port: number;
  /** Full email address (the sender identity). */
  email: string;
  /**
   * SASL login username. Most providers use the email address, but some
   * independent hosts issue a distinct username. When omitted, `email` is used.
   */
  username?: string;
  /** Mailbox password (an app password where the provider requires one). */
  password: string;
}

/** Provider-neutral user-facing messages, keyed by error code. */
export const IMAP_VALIDATION_MESSAGES: Record<ImapValidationErrorCode, string> = {
  AUTH_FAILED:
    'The mail server rejected these credentials. Check the username and ' +
    'password — some hosts use a separate login username (not your email ' +
    'address), and providers with 2-step verification require an app password.',
  CONNECTION_REFUSED:
    'Could not connect to the mail server. Please check the host and try again.',
  CONNECTION_TIMEOUT:
    'The connection to the mail server timed out. Please try again.',
  TLS_HANDSHAKE_FAILED:
    'Could not establish a secure connection to the mail server. Please try again.',
  IMAP_PROTOCOL_ERROR:
    'An unexpected IMAP error occurred. Please try again.',
};

/**
 * Builds the base64-encoded SASL PLAIN token.
 *
 * Structure before encoding: \x00<username>\x00<password>
 * Safe to transmit because the socket is TLS-encrypted.
 */
function buildPlainAuthToken(username: string, password: string): string {
  return Buffer.from(`\x00${username}\x00${password}`, 'utf8').toString('base64');
}

/** Reads the initial server greeting line. Resolves with the first full line. */
function readGreeting(socket: tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    function onData(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\r\n');
      if (newline !== -1) {
        cleanup();
        resolve(buffer.slice(0, newline));
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/**
 * Reads lines until one begins with `tag`, returning the tagged status.
 * Rejects on socket error; the overall timeout is enforced by the caller.
 */
function readTaggedResponse(
  socket: tls.TLSSocket,
  tag: string
): Promise<{ status: 'OK' | 'NO' | 'BAD'; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines: string[] = [];

    function onData(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      let newline: number;

      while ((newline = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        lines.push(line);

        if (line.startsWith(`${tag} OK`)) {
          cleanup();
          resolve({ status: 'OK', lines });
          return;
        }
        if (line.startsWith(`${tag} NO`)) {
          cleanup();
          resolve({ status: 'NO', lines });
          return;
        }
        if (line.startsWith(`${tag} BAD`)) {
          cleanup();
          resolve({ status: 'BAD', lines });
          return;
        }
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/**
 * Validates an IMAP credential by opening a real connection and attempting
 * AUTH PLAIN against `host:port`. Returns on the first definitive answer and
 * always closes the socket. The whole operation is bounded by
 * IMAP_VALIDATION_TIMEOUT_MS.
 */
export async function validateImapCredential(
  cred: ImapCredential
): Promise<ImapValidationResult> {
  const timeout = new Promise<ImapValidationError>((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: false,
          code: 'CONNECTION_TIMEOUT',
          message: IMAP_VALIDATION_MESSAGES.CONNECTION_TIMEOUT,
        }),
      IMAP_VALIDATION_TIMEOUT_MS
    )
  );

  const attempt = (async (): Promise<ImapValidationResult> => {
    let socket: tls.TLSSocket | null = null;

    try {
      // 1. Open TLS socket: implicit TLS (no STARTTLS).
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect(
          { host: cred.host, port: cred.port, servername: cred.host },
          () => resolve(s)
        );
        s.once('error', reject);
      });

      // 2. Read and validate the server greeting.
      const greeting = await readGreeting(socket);
      if (!greeting.startsWith('* OK')) {
        return {
          ok: false,
          code: 'IMAP_PROTOCOL_ERROR',
          message: IMAP_VALIDATION_MESSAGES.IMAP_PROTOCOL_ERROR,
        };
      }

      // 3. Authenticate using SASL PLAIN. The login username defaults to the
      //    email address but may be overridden for hosts that issue a separate
      //    username (e.g. domeneshop).
      const plainToken = buildPlainAuthToken(cred.username || cred.email, cred.password);
      socket.write(`A0001 AUTHENTICATE PLAIN ${plainToken}\r\n`);

      const authResult = await readTaggedResponse(socket, 'A0001');
      if (authResult.status !== 'OK') {
        return {
          ok: false,
          code: 'AUTH_FAILED',
          message: IMAP_VALIDATION_MESSAGES.AUTH_FAILED,
        };
      }

      // 4. Auth succeeded: issue LOGOUT before closing (no need to await it).
      socket.write('A0002 LOGOUT\r\n');
      return { ok: true };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;

      if (error.code === 'ECONNREFUSED') {
        return {
          ok: false,
          code: 'CONNECTION_REFUSED',
          message: IMAP_VALIDATION_MESSAGES.CONNECTION_REFUSED,
        };
      }

      if (
        error.code === 'CERT_HAS_EXPIRED' ||
        error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        (error.message && error.message.toLowerCase().includes('tls'))
      ) {
        return {
          ok: false,
          code: 'TLS_HANDSHAKE_FAILED',
          message: IMAP_VALIDATION_MESSAGES.TLS_HANDSHAKE_FAILED,
        };
      }

      return {
        ok: false,
        code: 'IMAP_PROTOCOL_ERROR',
        message: IMAP_VALIDATION_MESSAGES.IMAP_PROTOCOL_ERROR,
      };
    } finally {
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
    }
  })();

  return Promise.race([attempt, timeout]);
}

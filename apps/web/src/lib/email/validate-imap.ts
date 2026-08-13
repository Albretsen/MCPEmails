import * as net from 'net';
import * as tls from 'tls';
import { sanitizeAuthDiagnostic } from './connection-config';

export const IMAP_VALIDATION_TIMEOUT_MS = 10_000;
export type MailSecurity = 'tls' | 'starttls';
export type ConnectionPhase = 'tcp' | 'tls' | 'greeting' | 'authentication';
export type ImapValidationErrorCode =
  | 'AUTH_FAILED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'TLS_HANDSHAKE_FAILED'
  | 'IMAP_PROTOCOL_ERROR';

export type ImapValidationResult =
  | { ok: true; phase: 'authentication' }
  | {
      ok: false;
      code: ImapValidationErrorCode;
      message: string;
      phase: ConnectionPhase;
      /**
       * Sanitized, bounded server rejection text (see `sanitizeAuthDiagnostic`).
       * Present only for AUTH_FAILED, where the server actually answered; never
       * contains the credential or the address, and is safe to persist.
       */
      detail?: string;
    };

export interface ImapCredential {
  host: string;
  port: number;
  email: string;
  username?: string;
  password: string;
  /** Defaults to implicit TLS so every existing preset keeps its behavior. */
  security?: MailSecurity;
}

export const IMAP_VALIDATION_MESSAGES: Record<ImapValidationErrorCode, string> = {
  AUTH_FAILED: 'The mail server rejected these credentials. Check the username and password — some hosts use a separate login username (not your email address), and providers with 2-step verification require an app password.',
  CONNECTION_REFUSED: 'Could not connect to the mail server. Please check the host and try again.',
  CONNECTION_TIMEOUT: 'The connection to the mail server timed out. Please try again.',
  TLS_HANDSHAKE_FAILED: 'Could not establish a secure connection to the mail server. Check that the selected security mode matches the port.',
  IMAP_PROTOCOL_ERROR: 'An unexpected IMAP error occurred. Please try again.',
};

function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\r\n');
      if (newline >= 0) { cleanup(); resolve(buffer.slice(0, newline)); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Socket closed before a complete response.')); };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

interface TaggedResponse {
  status: 'OK' | 'NO' | 'BAD';
  /** Everything after the status word, e.g. "[AUTHENTICATIONFAILED] invalid credentials". */
  text: string;
}

function readTaggedResponse(socket: net.Socket, tag: string): Promise<TaggedResponse> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\r\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const match = new RegExp(`^${tag} (OK|NO|BAD)(?: |$)`, 'i').exec(line);
        if (match) {
          cleanup();
          resolve({
            status: match[1].toUpperCase() as 'OK' | 'NO' | 'BAD',
            text: line.slice(match[0].length).trim(),
          });
          return;
        }
        newline = buffer.indexOf('\r\n');
      }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Socket closed before a tagged response.')); };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Wait for a SASL continuation line. Servers send a bare "+" or "+ <base64>";
 * Yandex sends the bare form, so the space must not be required.
 */
function readContinuation(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\r\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (line.startsWith('+')) { cleanup(); resolve(); return; }
        newline = buffer.indexOf('\r\n');
      }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Socket closed before a SASL continuation.')); };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Perform SASL PLAIN, tolerating servers that do not implement RFC 4959.
 *
 * RFC 4959 (SASL-IR) lets the base64 initial response ride along on the
 * AUTHENTICATE line, and iCloud, Yahoo and Zoho all accept that form. Yandex
 * does not advertise SASL-IR and answers the inline form with a tagged
 * `BAD AUTHENTICATE Command syntax error`, a rejection of the *command*, not
 * of the credentials, which made every Yandex connection fail identically no
 * matter what the user typed.
 *
 * A `BAD` therefore means "this server wants the RFC 3501 two-step form", so the
 * exchange is retried on the same connection: send `AUTHENTICATE PLAIN`, wait
 * for the continuation, then send the token on its own line. A `NO` is a genuine
 * credential rejection and is never retried.
 */
async function authenticatePlain(
  socket: net.Socket,
  username: string,
  password: string
): Promise<TaggedResponse & { token: string }> {
  const token = Buffer.from(`\x00${username}\x00${password}`, 'utf8').toString('base64');

  await socketWrite(socket, `A0001 AUTHENTICATE PLAIN ${token}\r\n`);
  const inline = await readTaggedResponse(socket, 'A0001');
  if (inline.status !== 'BAD') return { ...inline, token };

  await socketWrite(socket, 'A0002 AUTHENTICATE PLAIN\r\n');
  await readContinuation(socket);
  await socketWrite(socket, `${token}\r\n`);
  return { ...(await readTaggedResponse(socket, 'A0002')), token };
}

function socketWrite(socket: net.Socket, data: string): Promise<void> {
  return new Promise((resolve) => { socket.write(data, () => resolve()); });
}

function connectTcp(host: string, port: number, onSocket: (socket: net.Socket) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    onSocket(socket);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}

function connectTls(host: string, port: number, onSocket: (socket: net.Socket) => void): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    onSocket(socket);
    socket.once('secureConnect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}

function upgradeTls(host: string, plain: net.Socket, onSocket: (socket: net.Socket) => void): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true });
    onSocket(socket);
    socket.once('secureConnect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}

export async function validateImapCredential(cred: ImapCredential): Promise<ImapValidationResult> {
  let activeSocket: net.Socket | null = null;
  let phase: ConnectionPhase = 'tcp';
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<ImapValidationResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      activeSocket?.destroy();
      resolve({ ok: false, code: 'CONNECTION_TIMEOUT', message: IMAP_VALIDATION_MESSAGES.CONNECTION_TIMEOUT, phase });
    }, IMAP_VALIDATION_TIMEOUT_MS);
  });

  const attempt = (async (): Promise<ImapValidationResult> => {
    try {
      const security = cred.security ?? 'tls';
      let socket: net.Socket;
      if (security === 'tls') {
        phase = 'tls';
        socket = await connectTls(cred.host, cred.port, (value) => { activeSocket = value; });
        phase = 'greeting';
        if (!(await readLine(socket)).startsWith('* OK')) {
          return { ok: false, code: 'IMAP_PROTOCOL_ERROR', message: IMAP_VALIDATION_MESSAGES.IMAP_PROTOCOL_ERROR, phase };
        }
      } else {
        phase = 'tcp';
        socket = await connectTcp(cred.host, cred.port, (value) => { activeSocket = value; });
        phase = 'greeting';
        if (!(await readLine(socket)).startsWith('* OK')) {
          return { ok: false, code: 'IMAP_PROTOCOL_ERROR', message: IMAP_VALIDATION_MESSAGES.IMAP_PROTOCOL_ERROR, phase };
        }
        socket.write('A0000 STARTTLS\r\n');
        phase = 'tls';
        if ((await readTaggedResponse(socket, 'A0000')).status !== 'OK') {
          return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: IMAP_VALIDATION_MESSAGES.TLS_HANDSHAKE_FAILED, phase };
        }
        socket = await upgradeTls(cred.host, socket, (value) => { activeSocket = value; });
      }

      phase = 'authentication';
      const username = cred.username || cred.email;
      const auth = await authenticatePlain(socket, username, cred.password);
      if (auth.status !== 'OK') {
        return {
          ok: false,
          code: 'AUTH_FAILED',
          message: IMAP_VALIDATION_MESSAGES.AUTH_FAILED,
          phase,
          // The SASL token must be listed: it encodes the username and password
          // together, and a server echoing the rejected command would otherwise
          // persist the credential in reversible form.
          detail: sanitizeAuthDiagnostic(auth.status, auth.text, [
            auth.token,
            username,
            cred.email,
            cred.password,
          ]),
        };
      }
      socket.write('A0003 LOGOUT\r\n');
      return { ok: true, phase: 'authentication' };
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code === 'ECONNREFUSED') return { ok: false, code: 'CONNECTION_REFUSED', message: IMAP_VALIDATION_MESSAGES.CONNECTION_REFUSED, phase };
      const tlsError = phase === 'tls' || error.code?.startsWith('ERR_TLS') || error.code?.includes('CERT');
      return tlsError
        ? { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: IMAP_VALIDATION_MESSAGES.TLS_HANDSHAKE_FAILED, phase }
        : { ok: false, code: 'IMAP_PROTOCOL_ERROR', message: IMAP_VALIDATION_MESSAGES.IMAP_PROTOCOL_ERROR, phase };
    }
  })();

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (activeSocket) (activeSocket as net.Socket).destroy();
  }
}

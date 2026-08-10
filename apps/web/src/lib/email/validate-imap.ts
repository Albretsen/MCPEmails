import * as net from 'net';
import * as tls from 'tls';

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
  | { ok: false; code: ImapValidationErrorCode; message: string; phase: ConnectionPhase };

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

function readTaggedResponse(socket: net.Socket, tag: string): Promise<'OK' | 'NO' | 'BAD'> {
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
        if (match) { cleanup(); resolve(match[1].toUpperCase() as 'OK' | 'NO' | 'BAD'); return; }
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
        if ((await readTaggedResponse(socket, 'A0000')) !== 'OK') {
          return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: IMAP_VALIDATION_MESSAGES.TLS_HANDSHAKE_FAILED, phase };
        }
        socket = await upgradeTls(cred.host, socket, (value) => { activeSocket = value; });
      }

      phase = 'authentication';
      const username = cred.username || cred.email;
      const token = Buffer.from(`\x00${username}\x00${cred.password}`, 'utf8').toString('base64');
      socket.write(`A0001 AUTHENTICATE PLAIN ${token}\r\n`);
      if ((await readTaggedResponse(socket, 'A0001')) !== 'OK') {
        return { ok: false, code: 'AUTH_FAILED', message: IMAP_VALIDATION_MESSAGES.AUTH_FAILED, phase };
      }
      socket.write('A0002 LOGOUT\r\n');
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

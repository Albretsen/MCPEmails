import * as net from 'net';
import * as tls from 'tls';
import type { ConnectionPhase, MailSecurity } from './validate-imap';
import { sanitizeAuthDiagnostic } from './connection-config';

export const SMTP_VALIDATION_TIMEOUT_MS = 10_000;
export type SmtpValidationResult =
  | { ok: true; phase: 'authentication' }
  | {
      ok: false;
      code: 'AUTH_FAILED' | 'CONNECTION_REFUSED' | 'CONNECTION_TIMEOUT' | 'TLS_HANDSHAKE_FAILED' | 'SMTP_PROTOCOL_ERROR';
      message: string;
      phase: ConnectionPhase;
      /**
       * Sanitized, bounded server rejection text, mirroring the IMAP validator.
       * Present only for AUTH_FAILED, where the server actually answered.
       * Never contains the credential, the address or the SASL token.
       */
      detail?: string;
    };

export interface SmtpCredential {
  host: string;
  port: number;
  email: string;
  username?: string;
  password: string;
  security: MailSecurity;
}

function readReply(socket: net.Socket): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines: string[] = [];
    const cleanup = () => { socket.removeListener('data', onData); socket.removeListener('error', onError); socket.removeListener('close', onClose); };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\r\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        lines.push(line);
        const match = /^(\d{3})([ -])/.exec(line);
        if (match?.[2] === ' ') { cleanup(); resolve({ code: Number(match[1]), lines }); return; }
        newline = buffer.indexOf('\r\n');
      }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('SMTP socket closed before a complete reply.')); };
    socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose);
  });
}

function tcp(host: string, port: number, setSocket: (s: net.Socket) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }); setSocket(socket);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); }); socket.once('error', reject);
  });
}
function secure(host: string, port: number, setSocket: (s: net.Socket) => void): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }); setSocket(socket);
    socket.once('secureConnect', () => { socket.removeListener('error', reject); resolve(socket); }); socket.once('error', reject);
  });
}
function upgrade(host: string, plain: net.Socket, setSocket: (s: net.Socket) => void): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true }); setSocket(socket);
    socket.once('secureConnect', () => { socket.removeListener('error', reject); resolve(socket); }); socket.once('error', reject);
  });
}

/** Authenticates only; it never submits MAIL FROM, recipients, or message data. */
export async function validateSmtpCredential(cred: SmtpCredential): Promise<SmtpValidationResult> {
  let active: net.Socket | null = null;
  let phase: ConnectionPhase = 'tcp';
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SmtpValidationResult>((resolve) => {
    timer = setTimeout(() => { active?.destroy(); resolve({ ok: false, code: 'CONNECTION_TIMEOUT', message: 'The SMTP connection timed out.', phase }); }, SMTP_VALIDATION_TIMEOUT_MS);
  });
  const attempt = (async (): Promise<SmtpValidationResult> => {
    try {
      let socket: net.Socket;
      if (cred.security === 'tls') { phase = 'tls'; socket = await secure(cred.host, cred.port, (s) => { active = s; }); }
      else { phase = 'tcp'; socket = await tcp(cred.host, cred.port, (s) => { active = s; }); }
      phase = 'greeting';
      if ((await readReply(socket)).code !== 220) return { ok: false, code: 'SMTP_PROTOCOL_ERROR', message: 'The SMTP server returned an unexpected greeting.', phase };
      socket.write('EHLO mcpemails.com\r\n');
      const capabilities = await readReply(socket);
      if (capabilities.code !== 250) return { ok: false, code: 'SMTP_PROTOCOL_ERROR', message: 'The SMTP server rejected the connection greeting.', phase };
      if (cred.security === 'starttls') {
        if (!capabilities.lines.some((line) => /^250[ -]STARTTLS\b/i.test(line))) return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: 'This SMTP server does not advertise STARTTLS on the selected port.', phase: 'tls' };
        socket.write('STARTTLS\r\n'); phase = 'tls';
        if ((await readReply(socket)).code !== 220) return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: 'The SMTP server refused STARTTLS.', phase };
        socket = await upgrade(cred.host, socket, (s) => { active = s; });
        socket.write('EHLO mcpemails.com\r\n');
        if ((await readReply(socket)).code !== 250) return { ok: false, code: 'SMTP_PROTOCOL_ERROR', message: 'The SMTP server rejected the secure connection greeting.', phase: 'greeting' };
      }
      phase = 'authentication';
      const token = Buffer.from(`\x00${cred.username || cred.email}\x00${cred.password}`, 'utf8').toString('base64');
      socket.write(`AUTH PLAIN ${token}\r\n`);
      const auth = await readReply(socket);
      if (auth.code < 200 || auth.code >= 300) {
        return {
          ok: false,
          code: 'AUTH_FAILED',
          message: 'The SMTP server rejected these credentials. Check the username and app password.',
          phase,
          // The SASL token must be in the secrets list: it is base64 of
          // "\0user\0password", so a server echoing the rejected AUTH command
          // would otherwise persist the credential in reversible form.
          detail: sanitizeAuthDiagnostic(String(auth.code), auth.lines.join(' '), [
            token,
            cred.username || cred.email,
            cred.email,
            cred.password,
          ]),
        };
      }
      socket.write('QUIT\r\n');
      return { ok: true, phase: 'authentication' };
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code === 'ECONNREFUSED') return { ok: false, code: 'CONNECTION_REFUSED', message: 'Could not connect to the SMTP server.', phase };
      if (phase === 'tls' || error.code?.startsWith('ERR_TLS') || error.code?.includes('CERT')) return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: 'Could not establish a secure SMTP connection.', phase };
      return { ok: false, code: 'SMTP_PROTOCOL_ERROR', message: 'An unexpected SMTP error occurred.', phase };
    }
  })();
  try { return await Promise.race([attempt, timeout]); }
  finally { if (timer) clearTimeout(timer); if (active) (active as net.Socket).destroy(); }
}

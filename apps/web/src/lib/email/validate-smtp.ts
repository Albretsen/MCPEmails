import * as net from 'net';
import * as tls from 'tls';
import type { ConnectionPhase, MailSecurity } from './validate-imap';
import { sanitizeAuthDiagnostic } from './connection-config';

export const SMTP_VALIDATION_TIMEOUT_MS = 10_000;
export type SmtpValidationResult =
  | { ok: true; phase: 'authentication' }
  | {
      ok: false;
      code:
        | 'AUTH_FAILED'
        | 'AUTH_MECHANISM_UNSUPPORTED'
        | 'CONNECTION_REFUSED'
        | 'CONNECTION_TIMEOUT'
        | 'HOST_NOT_FOUND'
        | 'TLS_HANDSHAKE_FAILED'
        | 'SMTP_PROTOCOL_ERROR';
      message: string;
      phase: ConnectionPhase;
      /**
       * Sanitized, bounded server rejection text, mirroring the IMAP validator.
       * Present only for AUTH_FAILED and AUTH_MECHANISM_UNSUPPORTED, where the
       * server actually answered. Never contains the credential, the address or
       * the SASL token.
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
  /** See ImapCredential.timeoutMs: shorter for an autodetection retry. */
  timeoutMs?: number;
}

export const SMTP_AUTH_FAILED_MESSAGE =
  'Reading this mailbox works, but the outgoing server rejected the same login. ' +
  'Some hosts issue a separate SMTP username, and some require the mailbox to be authorised for sending before it will accept one.';

/**
 * Distinct from AUTH_FAILED on purpose: the server refused the *mechanism*, so
 * telling the user to re-check a password that is very probably correct sends
 * them down the wrong path.
 */
export const SMTP_MECHANISM_UNSUPPORTED_MESSAGE =
  'This SMTP server does not offer a password-based login method we support (it wants GSSAPI, NTLM or OAuth). ' +
  'Ask the mail host to enable SMTP AUTH LOGIN on the mailbox.';

/**
 * A submission port that never answers is almost always the wrong port rather
 * than a broken host: Microsoft Exchange (OVH Hosted Exchange, Microsoft 365)
 * serves STARTTLS on 587 and does not listen on 465 at all, so an implicit-TLS
 * attempt there hangs until it times out.
 */
/**
 * Every standard submission port has already been tried by the time this text
 * is shown (see email/transport-autodetect.ts), so the old advice to "try 587
 * with STARTTLS instead" would now be asking the user to repeat what we just
 * did. What is left is genuinely outside the app.
 */
export const SMTP_TIMEOUT_MESSAGE =
  'The outgoing server never answered, on 465, 587 or 25. That is usually a wrong host name, or a network that blocks outgoing mail.';

export const SMTP_HOST_NOT_FOUND_MESSAGE =
  'That outgoing server name does not exist. Check it for a typo: it is the SMTP host from your provider.';

/**
 * SASL mechanisms this client can perform. Both carry the password over the
 * connection, so both are attempted only once the session is under TLS.
 */
type SaslMechanism = 'PLAIN' | 'LOGIN';

/**
 * Mechanisms named on the EHLO `AUTH` line, upper-cased.
 *
 * Two syntaxes are in the wild and some servers emit both: the RFC 4954
 * `250-AUTH LOGIN PLAIN` and the pre-standard `250-AUTH=LOGIN PLAIN` that
 * old Outlook builds required (OVH's MX Plan hosts still send the pair).
 */
function advertisedMechanisms(lines: readonly string[]): Set<string> {
  const mechanisms = new Set<string>();
  for (const line of lines) {
    const match = /^250[ -]AUTH[ =](.*)$/i.exec(line);
    if (!match) continue;
    for (const mechanism of match[1].trim().split(/\s+/)) {
      if (mechanism) mechanisms.add(mechanism.toUpperCase());
    }
  }
  return mechanisms;
}

/**
 * PLAIN first when a server offers both: it authenticates in one round trip,
 * which keeps every provider that works today on exactly the exchange it works
 * with now. A server that advertises no AUTH line at all still gets both tried,
 * since the capability list is advisory and some hosts omit it.
 */
function mechanismOrder(advertised: Set<string>): SaslMechanism[] {
  const usable = (['PLAIN', 'LOGIN'] as const).filter((mechanism) => advertised.has(mechanism));
  return usable.length > 0 ? [...usable] : ['PLAIN', 'LOGIN'];
}

/**
 * True when the reply refused the mechanism rather than the credential.
 *
 * 504 5.7.4 "Unrecognized authentication type" is what Microsoft Exchange
 * answers to AUTH PLAIN, which advertises only GSSAPI/NTLM/LOGIN. 534 and the
 * 5.5.1/5.7.4 enhanced codes are the same refusal from other servers. A wrong
 * password is 535, which is deliberately excluded here so a real credential
 * failure stops the loop instead of burning the next mechanism on it.
 */
function isMechanismRejection(reply: { code: number; lines: readonly string[] }): boolean {
  if (reply.code === 504 || reply.code === 534) return true;
  return reply.code === 535 && /\b5\.7\.4\b/.test(reply.lines.join(' '));
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

/** SASL PLAIN in one command: base64("\0" + user + "\0" + pass). */
async function authPlain(socket: net.Socket, username: string, password: string) {
  const token = Buffer.from(`\x00${username}\x00${password}`, 'utf8').toString('base64');
  socket.write(`AUTH PLAIN ${token}\r\n`);
  return { ...(await readReply(socket)), secrets: [token] };
}

/**
 * SASL LOGIN: a three-step challenge (`AUTH LOGIN` → base64 user → base64 pass).
 * The username is sent as its own line rather than as an initial response,
 * because the initial-response form is the part Exchange is inconsistent about.
 */
async function authLogin(socket: net.Socket, username: string, password: string) {
  const encodedUser = Buffer.from(username, 'utf8').toString('base64');
  const encodedPassword = Buffer.from(password, 'utf8').toString('base64');
  const secrets = [encodedUser, encodedPassword];

  socket.write('AUTH LOGIN\r\n');
  const challenge = await readReply(socket);
  if (challenge.code !== 334) return { ...challenge, secrets };

  socket.write(`${encodedUser}\r\n`);
  const passwordPrompt = await readReply(socket);
  if (passwordPrompt.code !== 334) return { ...passwordPrompt, secrets };

  socket.write(`${encodedPassword}\r\n`);
  return { ...(await readReply(socket)), secrets };
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
    timer = setTimeout(() => { active?.destroy(); resolve({ ok: false, code: 'CONNECTION_TIMEOUT', message: SMTP_TIMEOUT_MESSAGE, phase }); }, cred.timeoutMs ?? SMTP_VALIDATION_TIMEOUT_MS);
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
      // The capability list that decides the mechanism must be the one read
      // under TLS: servers routinely withhold password mechanisms until the
      // session is encrypted (Exchange adds LOGIN only after STARTTLS).
      let authCapabilities = capabilities.lines;
      if (cred.security === 'starttls') {
        if (!capabilities.lines.some((line) => /^250[ -]STARTTLS\b/i.test(line))) return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: 'This SMTP server does not advertise STARTTLS on the selected port.', phase: 'tls' };
        socket.write('STARTTLS\r\n'); phase = 'tls';
        if ((await readReply(socket)).code !== 220) return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: 'The SMTP server refused STARTTLS.', phase };
        socket = await upgrade(cred.host, socket, (s) => { active = s; });
        socket.write('EHLO mcpemails.com\r\n');
        const secureCapabilities = await readReply(socket);
        if (secureCapabilities.code !== 250) return { ok: false, code: 'SMTP_PROTOCOL_ERROR', message: 'The SMTP server rejected the secure connection greeting.', phase: 'greeting' };
        authCapabilities = secureCapabilities.lines;
      }
      phase = 'authentication';
      const username = cred.username || cred.email;

      // Try each mechanism the server will actually take. A 504 costs one round
      // trip and leaves the session usable, so falling back in place is cheaper
      // than reconnecting and is what every mainstream mail client does.
      let last: { code: number; lines: string[]; secrets: string[] } | null = null;
      for (const mechanism of mechanismOrder(advertisedMechanisms(authCapabilities))) {
        const reply = mechanism === 'PLAIN'
          ? await authPlain(socket, username, cred.password)
          : await authLogin(socket, username, cred.password);
        if (reply.code >= 200 && reply.code < 300) {
          socket.write('QUIT\r\n');
          return { ok: true, phase: 'authentication' };
        }
        last = reply;
        // Only a refused mechanism is worth retrying differently. A rejected
        // password (535 without 5.7.4) is final: retrying would just spend a
        // second failed login against the provider's lockout counter.
        if (!isMechanismRejection(reply)) break;
      }

      const mechanismRefused = last !== null && isMechanismRejection(last);
      return {
        ok: false,
        code: mechanismRefused ? 'AUTH_MECHANISM_UNSUPPORTED' : 'AUTH_FAILED',
        message: mechanismRefused ? SMTP_MECHANISM_UNSUPPORTED_MESSAGE : SMTP_AUTH_FAILED_MESSAGE,
        phase,
        // The SASL tokens must be in the secrets list: PLAIN's is base64 of
        // "\0user\0password" and LOGIN's second line is base64 of the password
        // on its own, so a server echoing the rejected AUTH exchange would
        // otherwise persist the credential in reversible form.
        detail: last
          ? sanitizeAuthDiagnostic(String(last.code), last.lines.join(' '), [
              ...last.secrets,
              username,
              cred.email,
              cred.password,
            ])
          : undefined,
      };
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code === 'ECONNREFUSED') return { ok: false, code: 'CONNECTION_REFUSED', message: 'Nothing is listening for outgoing mail on that server. Check the SMTP host.', phase };
      // Not retryable on another port: DNS has no answer regardless of port.
      if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return { ok: false, code: 'HOST_NOT_FOUND', message: SMTP_HOST_NOT_FOUND_MESSAGE, phase };
      if (phase === 'tls' || error.code?.startsWith('ERR_TLS') || error.code?.includes('CERT')) return { ok: false, code: 'TLS_HANDSHAKE_FAILED', message: 'The outgoing server would not start an encrypted session on any standard submission port. If your provider gave you a non-standard port, enter it under Advanced settings.', phase };
      return { ok: false, code: 'SMTP_PROTOCOL_ERROR', message: 'The outgoing server answered with something that is not SMTP. Check that the host is the SMTP host rather than a webmail or website address.', phase };
    }
  })();
  try { return await Promise.race([attempt, timeout]); }
  finally { if (timer) clearTimeout(timer); if (active) (active as net.Socket).destroy(); }
}

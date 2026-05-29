/**
 * smtp-client.ts — minimal SMTP submission client for the MCP edge function.
 *
 * Sends mail for IMAP inboxes (iCloud, Yahoo, Zoho, Yandex, generic) that have
 * no send API. Supports both implicit TLS (port 465) and STARTTLS (port 587),
 * with SASL PLAIN auth using the stored app password.
 *
 * Delivery flow: greeting → EHLO → [STARTTLS → EHLO] → AUTH PLAIN → MAIL FROM →
 * RCPT TO (each recipient) → DATA → message → QUIT.
 *
 * Auth failures throw SmtpAuthError so callers can surface a reconnect prompt.
 */

export class SmtpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpAuthError";
  }
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
  /** Full RFC 5322 message with CRLF line endings. */
  rawMessage: string;
}

const EHLO_DOMAIN = "mcpemails.com";
const SMTP_TIMEOUT_MS = 20_000;

/** Establish a connection, authenticate, and submit one message. */
export async function sendViaSmtp(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  if (msg.recipients.length === 0) {
    throw new Error("SMTP send: no recipients");
  }

  let conn: Deno.Conn = cfg.security === "tls"
    ? await Deno.connectTls({ hostname: cfg.host, port: cfg.port })
    : await Deno.connect({ hostname: cfg.host, port: cfg.port });

  const session = new SmtpSession(conn);
  try {
    await session.expect(220);
    await session.ehlo(EHLO_DOMAIN);

    if (cfg.security === "starttls") {
      await session.command("STARTTLS", 220);
      // In this branch `conn` is the plain TCP connection from Deno.connect.
      conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: cfg.host });
      session.upgrade(conn);
      await session.ehlo(EHLO_DOMAIN);
    }

    // SASL PLAIN: base64("\0" + user + "\0" + pass).
    const token = btoa(`\x00${cfg.email}\x00${cfg.password}`);
    const auth = await session.commandRaw(`AUTH PLAIN ${token}`);
    if (auth.code !== 235) {
      throw new SmtpAuthError(`SMTP authentication failed: ${auth.code} ${auth.text}`);
    }

    await session.command(`MAIL FROM:<${msg.from}>`, 250);
    for (const rcpt of msg.recipients) {
      // 250 = accepted, 251 = forwarded.
      const r = await session.commandRaw(`RCPT TO:<${rcpt}>`);
      if (r.code !== 250 && r.code !== 251) {
        throw new Error(`SMTP RCPT TO <${rcpt}> rejected: ${r.code} ${r.text}`);
      }
    }

    await session.command("DATA", 354);
    await session.writeData(msg.rawMessage);
    await session.expect(250);

    await session.commandRaw("QUIT");
  } finally {
    session.close();
  }
}

interface SmtpReply {
  code: number;
  text: string;
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

  async ehlo(domain: string): Promise<void> {
    await this.command(`EHLO ${domain}`, 250);
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
    await this.conn.write(this.encoder.encode(line + "\r\n"));
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

  /** Write the DATA payload with dot-stuffing and the terminating <CRLF>.<CRLF>. */
  async writeData(rawMessage: string): Promise<void> {
    const normalized = rawMessage.replace(/\r?\n/g, "\r\n");
    // Dot-stuffing: any line starting with '.' gets an extra leading '.'.
    const stuffed = normalized.replace(/^\./gm, "..");
    await this.conn.write(this.encoder.encode(stuffed + "\r\n.\r\n"));
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
        return { code: Number(m[1]), text: lines.join(" ") };
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

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("SMTP read timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

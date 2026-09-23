/**
 * imap-auth.ts — password-mechanism choice for IMAP, and the wire pieces of
 * the two mechanisms that are not SASL PLAIN (RFC 3501 LOGIN, RFC 2195
 * CRAM-MD5).
 *
 * A DELIBERATE, VERBATIM COPY lives at apps/web/src/lib/email/imap-auth.ts.
 * Everything from the declaration of the ImapPasswordMechanism type to the end
 * of the file is byte-identical, and "the two copies of the IMAP auth module agree"
 * (imap-auth.test.ts here, and imap-auth.test.ts over there) fails the build the
 * moment it stops being true. Same reason as utf7.ts: this function is deployed
 * on its own and bundles only what lives under supabase/functions/.
 *
 * Why this exists. Every IMAP password login used to be `AUTHENTICATE PLAIN`,
 * without ever reading what the server advertised. That is fine for the large
 * majority of hosts, and it stays the default. It is not fine for servers that
 * advertise a mechanism list without PLAIN, which probed on 2026-09-22 as:
 *
 *   imap.earthlink.net  AUTH=CRAM-MD5 AUTH=EL-TAC AUTH=EL-VOICE
 *                       PLAIN   -> "NO Server(s) unavailable to complete operation"
 *                       LOGIN   -> "NO Login failed Login incorrect"   (a real check)
 *   imap.online.no      AUTH=LOGIN
 *                       PLAIN   -> "NO AUTHENTICATE does not support PLAIN"
 *                       LOGIN   -> "NO [AUTHENTICATIONFAILED] Authentication failed"
 *   imap.163.com        AUTH=XOAUTH2          PLAIN -> BAD, LOGIN -> a real check
 *   imap.aliyun.com     AUTH=XOAUTH AUTH=XOAUTH2 AUTH=EXTERNAL
 *                                             PLAIN -> BAD, LOGIN -> a real check
 *
 * (all with a made-up account, one attempt per mechanism). On every one of them
 * PLAIN could never have worked, and the plain IMAP LOGIN command reaches the
 * real credential check.
 *
 * No function here does I/O, logs, or keeps state. Credentials pass through
 * only as arguments and return values.
 */

export type ImapPasswordMechanism = "PLAIN" | "LOGIN" | "CRAM-MD5";

/**
 * Collect the capability list from server lines: an untagged
 * `* CAPABILITY ...` or a `[CAPABILITY ...]` response code (which servers put
 * on the greeting or on a tagged OK). Upper-cased. Null when no line carries
 * one, which the chooser reads as "we know nothing".
 */
export function parseImapCapabilities(lines: readonly string[]): Set<string> | null {
  let found: Set<string> | null = null;
  for (const line of lines) {
    const untagged = /^\*\s+CAPABILITY\s+(.*)$/i.exec(line);
    const code = untagged ? null : /\[CAPABILITY\s+([^\]]*)\]/i.exec(line);
    const list = untagged?.[1] ?? code?.[1];
    if (list === undefined) continue;
    found ??= new Set<string>();
    for (const token of list.trim().split(/\s+/)) {
      if (token) found.add(token.toUpperCase());
    }
  }
  return found;
}

/**
 * Pick the password mechanism for a server whose capabilities we have read.
 *
 * The rule is built so that nothing that works today changes:
 *
 *   1. Nothing known, or no `AUTH=` entry at all: PLAIN, exactly as before.
 *      Plenty of servers (sina, t-online and most self-hosted presets in the
 *      registry) list no mechanisms and take PLAIN.
 *   2. `AUTH=PLAIN` advertised: PLAIN, exactly as before.
 *   3. Mechanisms advertised, PLAIN not among them, and no `LOGINDISABLED`:
 *      the RFC 3501 LOGIN command. It is part of base IMAP, so a server only
 *      turns it off by saying LOGINDISABLED; and it is what EarthLink, online.no,
 *      163.com and aliyun.com actually check (see the header).
 *   4. LOGIN disabled but `AUTH=CRAM-MD5` offered: CRAM-MD5.
 *   5. Otherwise: PLAIN, i.e. the old behaviour, and the server's answer is the
 *      error the user sees.
 *
 * LOGIN is preferred over CRAM-MD5 on purpose. Every connection this is used
 * on is already TLS (implicit or STARTTLS), so CRAM-MD5 protects nothing extra,
 * and it only works where the provider stores a plaintext-equivalent secret.
 * EarthLink advertises it, yet answered our CRAM-MD5 exchange with the same
 * "Server(s) unavailable" it gives PLAIN, while LOGIN reached a real check.
 */
export function chooseImapPasswordMechanism(
  caps: ReadonlySet<string> | null,
): ImapPasswordMechanism {
  if (!caps) return "PLAIN";
  let advertisesAny = false;
  for (const cap of caps) {
    if (cap.startsWith("AUTH=")) {
      advertisesAny = true;
      break;
    }
  }
  if (!advertisesAny) return "PLAIN";
  if (caps.has("AUTH=PLAIN")) return "PLAIN";
  if (!caps.has("LOGINDISABLED")) return "LOGIN";
  if (caps.has("AUTH=CRAM-MD5")) return "CRAM-MD5";
  return "PLAIN";
}

/** One argument of the LOGIN command: a quoted string, or a literal's octets. */
export type ImapLoginArgument =
  | { kind: "quoted"; text: string }
  | { kind: "literal"; bytes: Uint8Array };

/**
 * Encode a LOGIN argument (RFC 3501 astring). Printable ASCII goes as a quoted
 * string with `\` and `"` escaped; anything else (non-ASCII, control
 * characters) goes as a literal of its UTF-8 octets, because a quoted string
 * cannot carry CR, LF or 8-bit data. The caller sends `{n}` and waits for the
 * server's "+" before writing a literal's bytes.
 */
export function imapLoginArgument(value: string): ImapLoginArgument {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return { kind: "quoted", text: `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"` };
  }
  return { kind: "literal", bytes: new TextEncoder().encode(value) };
}

/**
 * The client's answer to a CRAM-MD5 challenge (RFC 2195): base64 of
 * `username SP lowercase-hex(HMAC-MD5(password, challenge))`.
 *
 * `challengeLine` is the server's continuation line, with or without the
 * leading "+". The password never appears in the result; only the digest does.
 */
export function cramMd5Response(username: string, password: string, challengeLine: string): string {
  const encoded = challengeLine.replace(/^\+\s?/, "").trim();
  const challenge = binaryToBytes(atob(encoded));
  const encoder = new TextEncoder();
  const digest = toHex(hmacMd5(encoder.encode(password), challenge));
  return btoa(bytesToBinary(encoder.encode(`${username} ${digest}`)));
}

/**
 * Strip credentials from server text before it goes into an error message or
 * a log. The exact submitted values go first, then anything shaped like a
 * base64 token (a server that echoes the rejected AUTHENTICATE line hands back
 * the SASL token, and CenturyLink's server does exactly that for PLAIN).
 */
export function redactImapAuthText(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let out = typeof text === "string" ? text : "";
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 3) {
      out = out.split(secret).join("<redacted>");
    }
  }
  return out
    .replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (run) =>
      /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) ? "<token>" : run)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .slice(0, 200);
}

/** HMAC-MD5 (RFC 2104 over RFC 1321). Exported for its test vectors. */
export function hmacMd5(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key.length > 64 ? md5(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  k = block;
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 16);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(md5(inner), 64);
  return md5(outer);
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: Int32Array = (() => {
  const table = new Int32Array(64);
  for (let i = 0; i < 64; i++) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
  return table;
})();

/**
 * MD5 (RFC 1321). Implemented here rather than borrowed from a crypto library
 * so both copies run unchanged in Node and in the edge runtime: WebCrypto has
 * no MD5, and CRAM-MD5 needs nothing else from one.
 */
export function md5(message: Uint8Array): Uint8Array {
  const length = message.length;
  const padded = new Uint8Array((((length + 8) >>> 6) + 1) * 64);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;
  const words = new Int32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j++) words[j] = view.getInt32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (f + a + MD5_K[i] + words[g]) | 0;
      a = d;
      d = c;
      c = b;
      const s = MD5_SHIFTS[i];
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, a0, true);
  outView.setInt32(4, b0, true);
  outView.setInt32(8, c0, true);
  outView.setInt32(12, d0, true);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

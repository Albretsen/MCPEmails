// ---------------------------------------------------------------------------
// email_forward with include_attachments: the 2026-09-07 defect.
//
// SYMPTOM. Forwarding a message with `include_attachments: true` failed for
// every attachment above roughly 60 KB, always with the same sentence:
//
//     An error occurred while forwarding the message via imap.
//     The message may or may not have been delivered.
//     Do not retry automatically to avoid duplicate delivery.
//
// The same message forwarded fine with `include_attachments: false`, a
// sequential retry failed identically (so it was not the IMAP socket
// contention fixed by runExclusive), and every failing file was one to two
// orders of magnitude below both documented budgets (10 MB per call, 2 MB per
// file on the bulk path).
//
// CAUSE. `SmtpSession.writeData` handed the whole DATA payload to
// `Deno.Conn.write` in one call and threw the return value away. That return
// value is how many bytes the socket ACCEPTED, and a socket is entitled to
// accept fewer than it was offered. Below the send buffer it always took all of
// them, which is why a bare forward (a few KB of quoted text) never failed and
// a forward carrying a ~60 KB PDF (~82 KB once base64-encoded) did. Past that
// point the tail was dropped, including the terminating <CRLF>.<CRLF>, so the
// server sat waiting for an end of message that never came, `expect(250)` hit
// the 20-second read timeout, and because a 354 had already gone by the failure
// was reported with the conservative "may or may not have been delivered".
//
// The same defect sat one layer over in `ImapClient.append`, which files the
// Sent copy: it wrote the APPEND literal with a bare `conn.write` while the
// class's own `writeAll` existed a few hundred lines up, documented with
// exactly why an octet-counted literal must not be short-written.
//
// The tests below pin both. (The third thing the report asked for, refusing
// rather than dropping an attachment the reader could not carry, is moot since
// 2026-09-17: a forward relays the original's bytes and never re-reads its
// attachments at all. See forward-relay.ts.)
//
// Run: deno test supabase/functions/mcp-server/forward-attachments.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { smtpDataPayload, writeAllBytes } from "./smtp-client.ts";
import { ImapClient } from "./imap-client.ts";
import { buildMimeMessage } from "./mime-build.ts";

const LATIN1 = new TextDecoder("latin1");
const UTF8 = new TextEncoder();

/**
 * A socket that behaves like a real one: it accepts at most `chunkBytes` per
 * write and reports how much it took. Every previous version of this code
 * passed against a fake that always accepted everything, which is precisely the
 * assumption that shipped the bug.
 */
class ShortWriteConn {
  readonly writes: number[] = [];
  #received: number[] = [];
  constructor(private readonly chunkBytes: number) {}

  write(p: Uint8Array): Promise<number> {
    const n = Math.min(p.length, this.chunkBytes);
    this.writes.push(n);
    for (let i = 0; i < n; i++) this.#received.push(p[i]);
    return Promise.resolve(n);
  }

  received(): Uint8Array {
    return new Uint8Array(this.#received);
  }

  text(): string {
    return LATIN1.decode(this.received());
  }
}

/** A deterministic stand-in for a scanned PDF of a given size. */
function pdfBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(UTF8.encode("%PDF-1.4\n"), 0);
  for (let i = 9; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// -- the SMTP DATA write ------------------------------------------------------

Deno.test("a forwarded 152 KB PDF reaches the socket in full", async () => {
  // Domeneshop's invoice, the largest file in the 2026-09-07 report.
  const pdf = pdfBytes(152_666);
  const mime = buildMimeMessage({
    from: "MCP Emails <hello@mcpemails.com>",
    to: ["bilag@example.com"],
    subject: "Fwd: Faktura",
    textBody: "---------- Forwarded message ----------\nFrom: Domeneshop\n",
    attachments: [{
      filename: "faktura.pdf",
      mimeType: "application/pdf",
      data: toBase64(pdf),
    }],
    messageId: "test-forward-1",
  });

  const payload = smtpDataPayload(mime);
  assert(
    payload.length > 200_000,
    `the base64 body should be well past any socket buffer, got ${payload.length}`,
  );

  // 64 KB is the send buffer size that made the bug visible in production.
  const conn = new ShortWriteConn(64 * 1024);
  await writeAllBytes(conn, payload);

  assertEquals(conn.received().length, payload.length, "every byte was written");
  assert(conn.writes.length > 1, "the test socket really did short-write");
  assert(
    conn.writes[0] < payload.length,
    "the first write took less than the whole payload, as a real socket does",
  );
  assert(
    conn.text().endsWith("\r\n.\r\n"),
    "the end-of-data marker arrived; without it the server waits until the read timeout",
  );
  // The MIME writer folds base64 at 76 columns, so compare without the folds.
  assert(
    conn.text().replace(/\r\n/g, "").includes(toBase64(pdf).slice(-64)),
    "the tail of the attachment arrived, not just its first 64 KB",
  );
});

Deno.test("the attachment survives the round trip byte for byte", async () => {
  const pdf = pdfBytes(116_911); // one of the two Supabase invoices
  const b64 = toBase64(pdf);
  const mime = buildMimeMessage({
    from: "MCP Emails <hello@mcpemails.com>",
    to: ["bilag@example.com"],
    subject: "Fwd: Invoice",
    textBody: "see attached",
    attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", data: b64 }],
    messageId: "test-forward-2",
  });

  const conn = new ShortWriteConn(8 * 1024);
  await writeAllBytes(conn, smtpDataPayload(mime));

  // Recover the attachment part from what the socket actually received and
  // decode it: an assertion on length alone would pass on a truncated tail
  // that happened to land on a part boundary.
  const wire = conn.text();
  const marker = 'filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
  const start = wire.indexOf(marker) + marker.length;
  assert(start > marker.length - 1, "the attachment part is on the wire");
  const end = wire.indexOf("\r\n--", start);
  const receivedB64 = wire.slice(start, end === -1 ? undefined : end).replace(/\r\n/g, "");
  const decoded = Uint8Array.from(atob(receivedB64), (c) => c.charCodeAt(0));

  assertEquals(decoded.length, pdf.length, "same byte count");
  assertEquals(
    await sha256Hex(decoded),
    await sha256Hex(pdf),
    "byte-identical, which is what email_read action: original would confirm",
  );
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("a socket that accepts nothing fails instead of spinning", async () => {
  const stuck = { write: (_p: Uint8Array) => Promise.resolve(0) };
  await assertRejects(
    () => writeAllBytes(stuck, UTF8.encode("x".repeat(10))),
    Error,
    "accepted no bytes",
  );
});

Deno.test("smtpDataPayload dot-stuffs and terminates", () => {
  const payload = LATIN1.decode(smtpDataPayload("a\n.hidden\nb"));
  assertEquals(payload, "a\r\n..hidden\r\nb\r\n.\r\n");
});

// -- the IMAP APPEND literal (the Sent copy) ---------------------------------

/** A socket that short-writes and answers an APPEND with "+" then OK. */
class ShortWriteImapConn {
  readonly written: number[] = [];
  #inbound: number[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  constructor(private readonly chunkBytes: number) {}

  write(p: Uint8Array): Promise<number> {
    const n = Math.min(p.length, this.chunkBytes);
    for (let i = 0; i < n; i++) this.written.push(p[i]);
    const text = LATIN1.decode(p.subarray(0, n));
    if (/APPEND .* \{\d+\}\r\n$/.test(text)) this.send("+ Ready for literal data\r\n");
    else if (/^A\d{5} /.test(text) && text.endsWith("\r\n") && !text.includes("APPEND")) {
      this.send(text.slice(0, 6) + "OK done\r\n");
    }
    return Promise.resolve(n);
  }

  /** Everything the client wrote, as text. */
  text(): string {
    return LATIN1.decode(new Uint8Array(this.written));
  }

  send(text: string): void {
    for (const b of UTF8.encode(text)) this.#inbound.push(b);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** Answer the pending APPEND tag once the literal and its CRLF have landed. */
  finish(tag: string): void {
    this.send(`${tag} OK [APPENDUID 1 42] APPEND completed\r\n`);
  }

  async read(p: Uint8Array): Promise<number | null> {
    while (this.#inbound.length === 0) {
      if (this.#closed) return null;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    const n = Math.min(p.length, this.#inbound.length);
    for (let i = 0; i < n; i++) p[i] = this.#inbound[i];
    this.#inbound.splice(0, n);
    return n;
  }

  close(): void {
    this.#closed = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

function clientOn(conn: ShortWriteImapConn): ImapClient {
  const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
  return new ctor(conn);
}

Deno.test("APPEND writes the whole Sent copy, not one socket buffer of it", async () => {
  // A short-written literal is worse than a truncated Sent copy: the server is
  // counting octets, so the bytes it never got are read as the next command and
  // the connection is desynchronised for the rest of its life.
  const conn = new ShortWriteImapConn(4096);
  const client = clientOn(conn);

  const message = "Subject: Fwd: Faktura\r\n\r\n" + "X".repeat(180_000);
  const appended = client.append("Sent", message);
  // Let the literal drain, then answer the tag.
  await new Promise((r) => setTimeout(r, 0));
  conn.finish("A00001");

  assertEquals(await appended, true);
  const wire = conn.text();
  assert(
    wire.includes(`{${UTF8.encode(message).length}}`),
    "the octet count the server was promised",
  );
  assert(wire.endsWith("X".repeat(64) + "\r\n"), "the literal's tail and its CRLF went out");
  assertEquals(
    wire.length,
    `A00001 APPEND "Sent" (\\Seen) {${message.length}}\r\n`.length + message.length + 2,
    "command line + every literal octet + the trailing CRLF",
  );
});

// -- a Sent copy that is bytes, not text -------------------------------------

Deno.test("APPEND writes a byte message exactly, without a UTF-8 round trip", async () => {
  // forward-relay.ts files the octets it transmitted as the Sent copy. Those
  // may include 8-bit bodies (0x80-0xFF) that a string path would re-encode as
  // two bytes each, making the Sent copy differ from what went out.
  const conn = new ShortWriteImapConn(4096);
  const client = clientOn(conn);
  const message = new Uint8Array(70_000);
  for (let i = 0; i < message.length; i++) message[i] = i % 256;
  const appended = client.append("Sent", message);
  await new Promise((r) => setTimeout(r, 0));
  conn.finish("A00001");

  assertEquals(await appended, true);
  const command = `A00001 APPEND "Sent" (\\Seen) {${message.length}}\r\n`;
  assertEquals(conn.written.length, command.length + message.length + 2);
  assertEquals(
    new Uint8Array(conn.written.slice(command.length, command.length + message.length)),
    message,
    "every octet, in order, unchanged",
  );
});

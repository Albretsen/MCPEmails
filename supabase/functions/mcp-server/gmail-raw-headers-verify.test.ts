// ---------------------------------------------------------------------------
// gmail-raw-headers-verify.test.ts — independent checks of the streaming
// Gmail format=raw header reader and of plain (non reply-all) Gmail replies
// (u05 follow-up, 2026-10-16). Every mailbox and address here is invented.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { rawHeaderBlockFromGmailJson } from "./gmail-raw-headers.ts";
import { API_KEY, executeCreateReplyDraft, inboxRow, json, runTool } from "./provider-call-harness.ts";
import { parseAddressHeader } from "./address-header.ts";
import { getHeader, parseEmail } from "./mime.ts";

const enc = new TextEncoder();
const byteString = (s: string) => Array.from(enc.encode(s), (b) => String.fromCharCode(b)).join("");
const b64url = (bytes: string) => btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A stream of `text` cut into chunks of the given sizes (cycled). */
function streamOf(text: string, sizes: number[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const bytes = enc.encode(text);
  let pos = 0, i = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pos >= bytes.length) return c.close();
      const n = sizes[i++ % sizes.length];
      c.enqueue(bytes.slice(pos, pos + n));
      pos += n;
    },
    cancel() { cancelled = true; },
  });
  return { stream, cancelled: () => cancelled };
}

function envelopeJson(rawMessageBytes: string, pretty = false, snippet = "hi"): string {
  const obj = { id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet, raw: b64url(rawMessageBytes), sizeEstimate: 9 };
  return pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
}

const HEADERS_CRLF = [
  "From: =?UTF-8?B?w4VzZQ==?= <aase@x.no>",
  "To: \"Doe, Jane\" <j@x.example>,\r\n\tBob <b@x.example>", // folded
  "Cc: Ødegård <o@x.no>", // raw 8-bit UTF-8
  "Subject: s",
].join("\r\n");

Deno.test("verify reader: every chunk size 1..13 yields the same header block (CRLF)", async () => {
  const msg = byteString(HEADERS_CRLF + "\r\n\r\nbody\r\n" + "x".repeat(5000));
  const expected = byteString(HEADERS_CRLF);
  for (let n = 1; n <= 13; n++) {
    const { stream } = streamOf(envelopeJson(msg), [n, n + 2, 1]);
    assertEquals(await rawHeaderBlockFromGmailJson(stream), expected, `chunk ${n}`);
  }
});

Deno.test("verify reader: LF-only terminator, pretty JSON, and an escaped \"raw\" in the snippet", async () => {
  const lfHeaders = HEADERS_CRLF.replace(/\r\n/g, "\n");
  const msg = byteString(lfHeaders + "\n\nbody\r\n\r\nmore");
  const snippet = 'say "raw": "QUFB" now';
  const { stream } = streamOf(envelopeJson(msg, true, snippet), [7]);
  assertEquals(await rawHeaderBlockFromGmailJson(stream), byteString(lfHeaders));
});

Deno.test("verify reader: parsed result keeps structure, folding and 8-bit names", async () => {
  const msg = byteString(HEADERS_CRLF + "\r\n\r\nbody");
  const block = await rawHeaderBlockFromGmailJson(streamOf(envelopeJson(msg), [5]).stream);
  const h = parseEmail(`${block}\r\n\r\n`).headers;
  assertEquals(parseAddressHeader(getHeader(h, "from")), [{ name: "Åse", email: "aase@x.no" }]);
  assertEquals(parseAddressHeader(getHeader(h, "to")), [
    { name: "Doe, Jane", email: "j@x.example" },
    { name: "Bob", email: "b@x.example" },
  ]);
  assertEquals(parseAddressHeader(getHeader(h, "cc")), [{ name: "Ødegård", email: "o@x.no" }]);
});

Deno.test("verify reader: headers-only message, no raw field, cap exceeded, and early cancel", async () => {
  assertEquals(await rawHeaderBlockFromGmailJson(streamOf(envelopeJson("From: a@x.example\r\n"), [3]).stream),
    "From: a@x.example\r\n");
  assertEquals(await rawHeaderBlockFromGmailJson(streamOf(JSON.stringify({ id: "m", payload: {} }), [4]).stream), null);
  const huge = byteString("X-Pad: " + "a".repeat(200_000) + "\r\n\r\nbody");
  assertEquals(await rawHeaderBlockFromGmailJson(streamOf(envelopeJson(huge), [4096]).stream, 64 * 1024), null);
  const big = streamOf(envelopeJson(byteString("From: a@x.example\r\n\r\n" + "b".repeat(2_000_000))), [1024]);
  assertEquals(await rawHeaderBlockFromGmailJson(big.stream), "From: a@x.example");
  assert(big.cancelled(), "stream must be cancelled once the headers are read");
});

Deno.test("verify: plain Gmail draft_reply (no reply_all) makes no format=raw call and answers From", async () => {
  const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
  const inbox = await inboxRow("gmail");
  const { value, world } = await runTool(inbox, (call) => {
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1?format=metadata`)) {
      return json({ id: "orig1", threadId: "t9", payload: { headers: [
        { name: "From", value: "Åse Ødegård <aase@x.no>" },
        { name: "To", value: "owner@gmail-harness.example, c@x.example" },
        { name: "Subject", value: "hi" },
        { name: "Message-ID", value: "<o@x.no>" },
      ] } });
    }
    if (call.method === "GET" && call.url.includes("format=raw")) return json({ error: {} }, 500);
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1`)) {
      return json({ id: "orig1", threadId: "t9", payload: { mimeType: "text/plain", headers: [], body: { data: "aGVsbG8" } } });
    }
    if (call.method === "POST" && call.url === `${GMAIL}/drafts`) return json({ id: "d7", message: { id: "m7" } });
    return json({ error: { message: `unexpected ${call.method} ${call.url}` } }, 500);
  }, () => executeCreateReplyDraft({ message_id: "orig1", body: "ok" }, {
    ...API_KEY, scopes: [...API_KEY.scopes, "manage:drafts"],
  }) as Promise<{ result: unknown; logStatus: string }>);
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  assertFalse(world.calls.some((c) => c.url.includes("format=raw")));
  const create = world.calls.find((c) => c.method === "POST" && c.url === `${GMAIL}/drafts`)!;
  const raw = (JSON.parse(create.body!) as { message: { raw: string } }).message.raw;
  const stored = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  assertEquals(parseAddressHeader(getHeader(parseEmail(stored).headers, "to")), [{ name: "Åse Ødegård", email: "aase@x.no" }]);
});

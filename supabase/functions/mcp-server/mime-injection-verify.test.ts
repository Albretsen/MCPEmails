// ---------------------------------------------------------------------------
// mime-injection-verify.test.ts — independent adversarial checks for the
// RFC 2047 / MIME / SMTP injection fix (u05, 2026-10-16).
//
// Bypass attempts the fixer's suite does not cover: repeated draft_update
// round trips of a nested encoding, payloads in comments, group syntax and
// Gmail-style already-decoded header values, msg-id / Message-ID / Reply-To
// with raw CR/LF, and the SMTP command writer itself.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env --allow-run=git \
//        supabase/functions/mcp-server/mime-injection-verify.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import { parseAddressHeader, parseAddressList, parseMailbox } from "./address-header.ts";
import { buildDraftMime, headerAddressList } from "./mime-build.ts";
import { parseEmail } from "./mime.ts";
import { assertEnvelopeSafe, SmtpNotSentError } from "./smtp-client.ts";
import { invalidRecipientIn, rewriteRecipientHeaders } from "./draft-recipients.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { draftContentFromRaw, draftMimeFor, draftEnvelopeRecipients, formatAddressEntry } =
  await import("./index.ts");
const isValid = (a: string) => /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(a);

function b64(text: string): string {
  return btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));
}
const ew = (text: string) => `=?UTF-8?B?${b64(text)}?=`;

const ALLOWED = new Set([
  "from", "to", "cc", "bcc", "subject", "date", "message-id", "reply-to",
  "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding",
]);
function headerBlock(mime: string): string {
  return mime.split(/\r?\n\r?\n/)[0];
}
function assertClean(mime: string): void {
  const lines = headerBlock(mime).split(/\r?\n/);
  for (const l of lines) {
    if (/^[ \t]/.test(l)) continue;
    const name = l.slice(0, l.indexOf(":")).toLowerCase();
    assert(ALLOWED.has(name), `unexpected header "${name}" in:\n${headerBlock(mime)}`);
    // deno-lint-ignore no-control-regex
    assertFalse(/[\x00-\x08\x0A-\x1F\x7F]/.test(l), l);
  }
}
const envelope = (raw: string) => draftEnvelopeRecipients(parseEmail(raw).headers);

function rebuild(raw: string): string {
  const c = draftContentFromRaw(raw);
  return draftMimeFor("Me <me@corp.example>", {
    to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, body: "edited",
    inReplyTo: c.inReplyTo, references: c.references, replyTo: c.replyTo,
  }, "draft-x");
}

Deno.test("verify: a 4-deep nested encoding stays inert across repeated draft_update rebuilds", () => {
  const payload = "x@evil.com>, exfil@evil.com\r\nBcc: spy@evil.com\r\nRCPT TO:<y@evil.com";
  let name = payload;
  for (let i = 0; i < 4; i++) name = ew(name);
  const to = parseAddressHeader(`${name} <attacker@evil.com>`).map(formatAddressEntry);
  let stored = draftMimeFor("Me <me@corp.example>", { to, cc: [], bcc: [], subject: "Re: x", body: "b" }, "d1");
  for (let round = 0; round < 6; round++) {
    assertClean(stored);
    assertEquals(envelope(stored), ["attacker@evil.com"], `round ${round}`);
    stored = rebuild(stored);
  }
});

Deno.test("verify: payload in a trailing comment or a group name never adds a recipient", () => {
  const evil = ew("\r\nBcc: spy@evil.com, x@evil.com");
  const comment = parseAddressHeader(`attacker@evil.com (${evil})`);
  assertEquals(comment.map((m) => m.email), ["attacker@evil.com"]);
  assertFalse(/[\r\n]/.test(comment[0].name));
  const group = parseAddressHeader(`${ew("a@evil.com, b@evil.com")}: real@x.example;`);
  assertEquals(group.map((m) => m.email), ["real@x.example"]);
  const stored = draftMimeFor("Me <me@corp.example>", {
    to: comment.map(formatAddressEntry), cc: [], bcc: [], subject: "s", body: "b",
  }, "d2");
  assertClean(stored);
  assertEquals(envelope(stored), ["attacker@evil.com"]);
});

Deno.test("verify: raw CR/LF in msg-ids, Reply-To, From and messageId cannot add a header", () => {
  const mime = buildDraftMime({
    from: "Me\r\nBcc: spy1@evil.com <me@corp.example>",
    to: ["a@x.example"],
    subject: "s",
    textBody: "b",
    messageId: "id\r\nBcc: spy2@evil.com",
    replyTo: "r@x.example\r\nBcc: spy3@evil.com",
    inReplyTo: "<m@x>\r\nBcc: spy4@evil.com",
    references: "<a@x>\n<b@x>\rBcc: spy5@evil.com",
    includeBccHeader: true,
  });
  assertClean(mime);
  assertFalse(/^Bcc:/im.test(headerBlock(mime)));
});

Deno.test("verify: Gmail-style decoded values (no raw form) keep structure where quoted", () => {
  // Gmail hands the decoded value; a quoted name with an angle-addr in it is one mailbox.
  const one = parseAddressList(`"Eve <x@evil.com>, y@evil.com" <a@b.example>`);
  assertEquals(one.map((m) => m.email), ["a@b.example"]);
  // An unquoted angle-addr inside a single From value: the LAST angle-addr wins.
  assertEquals(parseMailbox("Eve <x@evil.com> <a@b.example>").email, "a@b.example");
  // Re-serialized for the header, the decoded name is encoded/quoted, never structure.
  const out = headerAddressList([formatAddressEntry(one[0])]);
  assertEquals(out.length, 1);
  assertEquals(parseAddressHeader(out[0]).map((m) => m.email), ["a@b.example"]);
});

Deno.test("verify: SMTP envelope guard covers every control char and angle/space variant", () => {
  for (const bad of ["a@x.example\r", "a@x.example\n", "a@x\u0000.example", "a@x.example>", "<a@x.example",
    "a @x.example", "a@x.example\t", "a@x.example\u007f", ""]) {
    const err = assertThrows(() => assertEnvelopeSafe({ from: "me@corp.example", recipients: [bad] }));
    assert(err instanceof SmtpNotSentError, JSON.stringify(bad));
  }
  assertThrows(() => assertEnvelopeSafe({ from: "me@corp.example\r\nRSET", recipients: ["a@x.example"] }));
  // Legitimate addresses, including UTF-8 (SMTPUTF8) and plus tags, pass the guard.
  assertEnvelopeSafe({ from: "me@corp.example", recipients: ["a+tag@x.example", "åse@ærø.dk", "O'Brien@x.ie"] });
});

Deno.test("verify: draft_send override refuses a bare CR or a NUL in a display name", () => {
  assert(invalidRecipientIn({ to: ["Eve\r <a@x.example>"] }, isValid));
  assert(invalidRecipientIn({ cc: ["Eve\u0000 <a@x.example>"] }, isValid));
  assert(invalidRecipientIn({ bcc: ["a@x.example\nb@x.example"] }, isValid));
  assertEquals(invalidRecipientIn({ to: ['"Doe, Jane" <j@x.example>', "Åse Ødegård <a@x.example>"] }, isValid), null);
  const raw = "From: me@corp.example\r\nTo: old@x.example\r\nSubject: s\r\n\r\nbody";
  const rewritten = rewriteRecipientHeaders(raw, { to: ['"Doe, Jane" <j@x.example>'] }) ?? "";
  assertEquals(parseAddressHeader(parseEmail(rewritten).headers.get("to")?.[0] ?? "").map((m) => m.email), [
    "j@x.example",
  ]);
});

Deno.test("verify: round trip keeps names for æøå, CJK, emoji, RTL and a quoted comma across two rebuilds", () => {
  const people = [
    { name: "Åse Ødegård-Bø", email: "aase@x.no" },
    { name: "山田 太郎", email: "taro@x.jp" },
    { name: "Ana 🎉 Silva", email: "ana@x.br" },
    { name: "محمد علي", email: "m@x.eg" },
    { name: "שרה כהן", email: "s@x.il" },
    { name: "Doe, Jane", email: "j@x.example" },
    { name: "O'Brien (Sales)", email: "ob@x.ie" },
  ];
  let stored = draftMimeFor("Me <me@corp.example>", {
    to: people.map(formatAddressEntry), cc: [], bcc: [], subject: "s", body: "b",
  }, "d3");
  for (let round = 0; round < 2; round++) {
    assertClean(stored);
    const parsed = parseAddressHeader(parseEmail(stored).headers.get("to")?.[0] ?? "");
    assertEquals(parsed, people, `round ${round}`);
    assertEquals(envelope(stored), people.map((p) => p.email));
    stored = rebuild(stored);
  }
});

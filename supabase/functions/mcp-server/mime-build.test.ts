// ---------------------------------------------------------------------------
// BCC, in the two places it can fail silently.
//
// The production defect these tests were written for, 2026-08-30: Gmail drafts
// and Gmail sends were built with no `Bcc:` header at all. Gmail's `raw`-only
// APIs take their recipient list from that header and from nowhere else, so
// every BCC address on a Gmail send or draft was simply never addressed — while
// the tool answered `status: "sent"` with the BCC list echoed back. Nothing
// reported the loss, which is what made it survive.
//
// The opposite failure is worse and this file guards it too: a `Bcc:` header
// that reaches a To/Cc recipient stops BCC being blind and leaks the list. On
// the SMTP path the removal is ours (`stripBccHeader`, before the bytes go out);
// on the Gmail path it is Google's, performed by their submission agent exactly
// as it is for drafts composed in Gmail's own web client.
//
// So the two halves asserted below are:
//   * the header IS there in what we STORE and in what we hand Gmail, and
//   * the header is NOT there in what we ourselves put on the wire.
//
// PRECONDITION these tests rely on, enforced by the callers rather than here:
// every address reaching buildMimeMessage has already passed
// isValidEmailAddress, whose pattern is anchored and admits no CR or LF. The
// To/Cc/Bcc header lines interpolate their addresses directly, so that gate is
// what stands between a recipient list and header injection.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildDraftMime,
  buildMimeMessage,
  encodeMimeDisplayName,
  formatMailbox,
  mimeMessageToBase64url,
  stripBccHeader,
} from "./mime-build.ts";

/** The header block of a raw message: everything before the first blank line. */
function headerBlock(mime: string): string {
  const sep = mime.search(/\r?\n\r?\n/);
  return sep === -1 ? mime : mime.slice(0, sep);
}

/** Every header line whose name matches, unfolded to one line each. */
function headerLines(mime: string, name: string): string[] {
  const lines = headerBlock(mime).split(/\r\n/);
  const out: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (current !== null) current += " " + line.trim();
      continue;
    }
    if (current !== null) {
      out.push(current);
      current = null;
    }
    if (new RegExp(`^${name}[ \\t]*:`, "i").test(line)) current = line;
  }
  if (current !== null) out.push(current);
  return out;
}

const BASE = {
  from: "Owner <owner@example.com>",
  subject: "Q3 numbers",
  textBody: "Attached.",
  messageId: "11111111-2222-3333-4444-555555555555",
};

// ── What we STORE / hand to Gmail: the header must be present ───────────────

Deno.test("stored draft keeps the Bcc address in its MIME", () => {
  const mime = buildDraftMime({
    ...BASE,
    to: ["visible@example.com"],
    bcc: ["hidden@example.com"],
    includeBccHeader: true,
  });
  assertEquals(headerLines(mime, "Bcc"), ["Bcc: hidden@example.com"]);
  // In the header block, not lost in the body.
  assertStringIncludes(headerBlock(mime), "Bcc: hidden@example.com");
});

Deno.test("the production defect: no includeBccHeader means the Bcc vanishes", () => {
  // This is exactly the shape gmailCreateDraft/gmailUpdateDraft/sendGmailMessage
  // used to build. The addresses are handed in and never appear anywhere.
  const mime = buildDraftMime({
    ...BASE,
    to: ["visible@example.com"],
    bcc: ["hidden@example.com"],
  });
  assertEquals(headerLines(mime, "Bcc"), []);
  assert(!mime.includes("hidden@example.com"));
});

Deno.test("multiple Bcc addresses share one header line", () => {
  const mime = buildDraftMime({
    ...BASE,
    to: ["visible@example.com"],
    bcc: ["one@example.com", "two@example.com"],
    includeBccHeader: true,
  });
  assertEquals(headerLines(mime, "Bcc"), [
    "Bcc: one@example.com, two@example.com",
  ]);
});

Deno.test("a Bcc-only draft has no To header but does carry its Bcc", () => {
  // The recipientless-draft fix drops an empty To line rather than addressing
  // the draft to the account owner. A draft that is BCC-only must still be a
  // draft with a recipient, which is what lets draft_send accept it instead of
  // refusing it as having nobody to send to.
  const mime = buildDraftMime({
    ...BASE,
    to: [],
    bcc: ["hidden@example.com"],
    includeBccHeader: true,
  });
  assertEquals(headerLines(mime, "To"), []);
  assertEquals(headerLines(mime, "Bcc"), ["Bcc: hidden@example.com"]);
});

Deno.test("Gmail receives the Bcc: it survives base64url encoding of the raw", () => {
  // Gmail's drafts.create / drafts.send / messages.send take `raw` and nothing
  // else, so this encoded string IS the entire recipient list Google gets.
  const mime = buildMimeMessage({
    ...BASE,
    to: ["visible@example.com"],
    cc: ["copied@example.com"],
    bcc: ["hidden@example.com"],
    includeBccHeader: true,
  });
  const raw = mimeMessageToBase64url(mime);
  const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  assertStringIncludes(decoded, "Bcc: hidden@example.com");
  assertStringIncludes(decoded, "Cc: copied@example.com");
  assertStringIncludes(decoded, "To: visible@example.com");
});

Deno.test("Bcc rides alongside an HTML body and attachments", () => {
  // The header block is built once, before the structure branch picks
  // text/plain vs multipart — assert that for the branch most likely to be
  // rebuilt later.
  const mime = buildMimeMessage({
    ...BASE,
    to: ["visible@example.com"],
    bcc: ["hidden@example.com"],
    includeBccHeader: true,
    htmlBody: "<p>Attached.</p>",
    attachments: [{ filename: "q3.csv", mimeType: "text/csv", data: btoa("a,b") }],
  });
  assertEquals(headerLines(mime, "Bcc"), ["Bcc: hidden@example.com"]);
  assertStringIncludes(mime, "multipart/mixed");
});

// ── What WE put on the wire: the header must be gone ────────────────────────

Deno.test("the transmitted SMTP copy has no Bcc header", () => {
  const stored = buildDraftMime({
    ...BASE,
    to: ["visible@example.com"],
    cc: ["copied@example.com"],
    bcc: ["hidden@example.com"],
    includeBccHeader: true,
  });
  const sent = stripBccHeader(stored);

  assertEquals(headerLines(sent, "Bcc"), []);
  assert(
    !sent.includes("hidden@example.com"),
    "the BCC address must not survive anywhere in the transmitted message",
  );
  // Everything else is untouched: the strip is surgical.
  assertEquals(headerLines(sent, "To"), ["To: visible@example.com"]);
  assertEquals(headerLines(sent, "Cc"), ["Cc: copied@example.com"]);
  assertStringIncludes(sent, btoa("Attached."));
});

Deno.test("stripBccHeader drops folded Bcc continuation lines too", () => {
  const raw = [
    "From: owner@example.com",
    "To: visible@example.com",
    "Bcc: one@example.com,",
    " two@example.com,",
    "\tthree@example.com",
    "Subject: Q3 numbers",
    "",
    "body",
  ].join("\r\n");
  const sent = stripBccHeader(raw);
  assertEquals(headerLines(sent, "Bcc"), []);
  for (const leaked of ["one@example.com", "two@example.com", "three@example.com"]) {
    assert(!sent.includes(leaked), `${leaked} leaked into the transmitted copy`);
  }
  assertEquals(headerLines(sent, "Subject"), ["Subject: Q3 numbers"]);
  assertStringIncludes(sent, "\r\n\r\nbody");
});

Deno.test("stripBccHeader matches the header name case-insensitively", () => {
  const raw = "From: a@example.com\r\nBCC: hidden@example.com\r\nbcc: other@example.com\r\n\r\nbody";
  const sent = stripBccHeader(raw);
  assertEquals(headerLines(sent, "Bcc"), []);
  assert(!sent.includes("hidden@example.com"));
  assert(!sent.includes("other@example.com"));
});

Deno.test("stripBccHeader leaves a message with no Bcc alone", () => {
  const stored = buildDraftMime({
    ...BASE,
    to: ["visible@example.com"],
    includeBccHeader: true,
  });
  assertEquals(stripBccHeader(stored), stored);
});

Deno.test("stripBccHeader does not touch a body line that looks like a header", () => {
  const raw = "From: a@example.com\r\nTo: b@example.com\r\n\r\nBcc: notaheader@example.com\r\n";
  assertEquals(stripBccHeader(raw), raw);
});

// ---------------------------------------------------------------------------
// From display names.
//
// `inboxes.display_name` is written into the From header of every outgoing
// message. encodeMimeHeaderValue passes ASCII through verbatim, so a name with
// a comma ("Albretsen, Asgeir") was emitted as an unquoted phrase, which a
// strict parser reads as two mailboxes. encodeMimeDisplayName is the encoder
// for that position: bare atoms stay bare, ASCII specials get a quoted-string,
// non-ASCII gets RFC 2047 encoded-words.
// ---------------------------------------------------------------------------

Deno.test("plain ASCII atoms stay bare in a display name", () => {
  assertEquals(encodeMimeDisplayName("Evancoe Bot"), "Evancoe Bot");
  assertEquals(formatMailbox("Evancoe Bot", "bot@evancoe.com"), "Evancoe Bot <bot@evancoe.com>");
});

Deno.test("ASCII specials force a quoted-string", () => {
  assertEquals(encodeMimeDisplayName("Albretsen, Asgeir"), '"Albretsen, Asgeir"');
  assertEquals(encodeMimeDisplayName("Bot (Prod)"), '"Bot (Prod)"');
  assertEquals(encodeMimeDisplayName("Asgeir B. Albretsen"), '"Asgeir B. Albretsen"');
  assertEquals(encodeMimeDisplayName("Ops: Alerts"), '"Ops: Alerts"');
  assertEquals(encodeMimeDisplayName("support@example.com"), '"support@example.com"');
  assertEquals(
    formatMailbox("Albretsen, Asgeir", "asgeir@example.com"),
    '"Albretsen, Asgeir" <asgeir@example.com>',
  );
});

Deno.test("quotes and backslashes inside a quoted-string are escaped", () => {
  assertEquals(encodeMimeDisplayName('The "Bot"'), '"The \\"Bot\\""');
  assertEquals(encodeMimeDisplayName("A\\B"), '"A\\\\B"');
});

Deno.test("a bare name can never look like an encoded-word", () => {
  assertEquals(encodeMimeDisplayName("=?UTF-8?B?x?="), '"=?UTF-8?B?x?="');
});

Deno.test("non-ASCII becomes one RFC 2047 encoded-word", () => {
  const encoded = encodeMimeDisplayName("Åsgeir Bjelland");
  assertEquals(encoded, "=?UTF-8?B?w4VzZ2VpciBCamVsbGFuZA==?=");
  assertEquals(
    formatMailbox("Åsgeir Bjelland", "asgeir@example.com"),
    "=?UTF-8?B?w4VzZ2VpciBCamVsbGFuZA==?= <asgeir@example.com>",
  );
  // Round trip: the base64 decodes back to the UTF-8 bytes of the name.
  const b64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  assertEquals(new TextDecoder().decode(bytes), "Åsgeir Bjelland");
});

Deno.test("a long non-ASCII name is split into 75-char encoded-words on character boundaries", () => {
  const name = "Ærlig Ørn Åsgeir ".repeat(6).trim(); // 101 chars, many 2-byte sequences
  const encoded = encodeMimeDisplayName(name);
  const words = encoded.split(" ");
  assert(words.length > 1, "expected more than one encoded-word");
  let decoded = "";
  for (const word of words) {
    assert(word.length <= 75, `encoded-word exceeds 75 chars: ${word}`);
    assert(word.startsWith("=?UTF-8?B?") && word.endsWith("?="), word);
    const b64 = word.slice("=?UTF-8?B?".length, -"?=".length);
    // Each word must decode on its own, i.e. no UTF-8 sequence was split.
    decoded += new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
  }
  assertEquals(decoded, name);
});

Deno.test("control characters in a display name cannot inject a header", () => {
  assertEquals(
    encodeMimeDisplayName("Bot\r\nBcc: attacker@example.com"),
    '"Bot Bcc: attacker@example.com"',
  );
});

Deno.test("an empty or null name yields the bare address", () => {
  assertEquals(formatMailbox(null, "bot@evancoe.com"), "bot@evancoe.com");
  assertEquals(formatMailbox("", "bot@evancoe.com"), "bot@evancoe.com");
  assertEquals(formatMailbox("  \r\n ", "bot@evancoe.com"), "bot@evancoe.com");
});

Deno.test("buildMimeMessage writes the quoted display name into From", () => {
  const mime = buildMimeMessage({
    from: formatMailbox("Albretsen, Asgeir", "asgeir@example.com"),
    to: ["to@example.com"],
    subject: "Hi",
    textBody: "hello",
    messageId: "test-message-id",
  });
  assertStringIncludes(mime, 'From: "Albretsen, Asgeir" <asgeir@example.com>\r\n');
});

// ---------------------------------------------------------------------------
// sender_name normalisation for signature_set.
//
// The stored value goes straight into the From header of every outgoing
// message, so this is where a name is made safe to store: no bare CR or LF
// (header injection), no non-printable control characters, no angle brackets
// (mailbox smuggling), no stray whitespace, and a hard character cap. Empty
// after cleaning means "clear", which the tool writes as NULL.
//
// CHANGED 2026-09-21. These tests used to pin the opposite of what the schema
// advertised: a tab or newline was deleted rather than collapsed, so
// "Bot\ttab\nnewline" stored as "Bottabnewline" and two words silently became
// one. Tab, newline and carriage return are now folded to a space with the
// whitespace around them. The security property is UNCHANGED and is asserted
// below as a property rather than a string: a space cannot start a header line
// any more than a deleted character can, and RFC 5322 makes CRLF + whitespace
// a fold rather than a new header, so the substitution is safe in both
// directions. See the header of sender-name.ts for the full argument.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import { normaliseSenderName, SENDER_NAME_MAX_CHARS } from "./sender-name.ts";

Deno.test("a plain name passes through unchanged", () => {
  assertEquals(normaliseSenderName("Evancoe Bot"), { ok: true, value: "Evancoe Bot" });
});

Deno.test("unicode is kept as-is", () => {
  assertEquals(normaliseSenderName("Åsgeir Bjelland"), { ok: true, value: "Åsgeir Bjelland" });
  assertEquals(normaliseSenderName("支持团队"), { ok: true, value: "支持团队" });
});

Deno.test("whitespace is trimmed and runs collapse to one space", () => {
  assertEquals(normaliseSenderName("  Evancoe   Bot \t"), { ok: true, value: "Evancoe Bot" });
});

Deno.test("tab, newline and CR collapse to one space instead of vanishing", () => {
  // The regression this file used to enshrine: these joined the words around
  // them, so a pasted two-line name came back as one word.
  assertEquals(normaliseSenderName("Bot\ttab\nnewline"), {
    ok: true,
    value: "Bot tab newline",
  });
  assertEquals(
    normaliseSenderName("Evancoe Bot\r\nBcc: attacker@example.com"),
    // The CRLF is gone as a line break — what is left is a space, which cannot
    // end a header line — and the words either side stay words.
    { ok: true, value: "Evancoe Bot Bcc: attacker@example.com" },
  );
  // A run of mixed whitespace is still ONE space, not one per character.
  assertEquals(normaliseSenderName("A \t\r\n B"), { ok: true, value: "A B" });
});

Deno.test("non-printable control characters are still removed outright", () => {
  // NUL, DEL and the rest of C0 have no width to stand in for, so deleting
  // them is right where folding tab/newline is right.
  assertEquals(normaliseSenderName("A\x00B\x7FC"), { ok: true, value: "ABC" });
  assertEquals(normaliseSenderName("A\x0BB\x0CC\x1BD"), { ok: true, value: "ABCD" });
});

Deno.test("no header-injection payload can carry a bare CR or LF through", () => {
  // THE property, asserted as a property. Every one of these is a real From
  // header injection shape; what makes them harmless is that the stored value
  // contains no character that can end a header line. Collapsing to a space
  // satisfies that as completely as deleting did — a space cannot start a
  // header, and RFC 5322 §2.2.3 makes CRLF followed by whitespace a FOLD of
  // the same header rather than a new one, so even a downstream encoder that
  // wrapped this line could not turn it into a second header.
  const payloads = [
    "Evancoe Bot\r\nBcc: attacker@example.com",
    "Evancoe Bot\nBcc: attacker@example.com",
    "Evancoe Bot\rBcc: attacker@example.com",
    "Evancoe Bot\r\n\tBcc: attacker@example.com",
    "Evancoe Bot\r\n\r\nSubject: injected",
    "Bot\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>",
    "\r\nFrom: ceo@example.com",
    "Bot Bcc: attacker@example.com",
    "Bot Bcc: attacker@example.com",
  ];
  for (const raw of payloads) {
    const result = normaliseSenderName(raw);
    assertEquals(result.ok, true, JSON.stringify(raw));
    if (!result.ok) continue;
    const value = result.value ?? "";
    assert(!/[\r\n]/.test(value), `bare CR/LF survived: ${JSON.stringify(value)}`);
    // And nothing non-printable survived either, so there is no second path to
    // a line break through an encoder that treats C0 loosely.
    // deno-lint-ignore no-control-regex
    assert(!/[\x00-\x1F\x7F]/.test(value), `control char survived: ${JSON.stringify(value)}`);
    // The angle-bracket guard is independent of all of this and still holds.
    assert(!/[<>]/.test(value), `angle bracket survived: ${JSON.stringify(value)}`);
  }
});

Deno.test("angle brackets are stripped so a name cannot carry an address", () => {
  assertEquals(
    normaliseSenderName("Bot <spoof@example.com>"),
    { ok: true, value: "Bot spoof@example.com" },
  );
});

Deno.test("empty, whitespace-only and bracket-only names mean clear (null)", () => {
  for (const raw of ["", "   ", "\r\n", "<>", " < > "]) {
    assertEquals(normaliseSenderName(raw), { ok: true, value: null }, JSON.stringify(raw));
  }
});

Deno.test("exactly the cap is accepted, one over is refused", () => {
  const atCap = "a".repeat(SENDER_NAME_MAX_CHARS);
  assertEquals(normaliseSenderName(atCap), { ok: true, value: atCap });
  const over = normaliseSenderName("a".repeat(SENDER_NAME_MAX_CHARS + 1));
  assertEquals(over.ok, false);
  if (!over.ok) {
    assertEquals(over.message.startsWith("signature_set: sender_name"), true);
    assertEquals(over.message.includes(String(SENDER_NAME_MAX_CHARS)), true);
  }
});

Deno.test("the cap counts characters, not UTF-16 code units", () => {
  // 100 emoji are 200 code units and 100 characters: inside the limit.
  const emoji = "\u{1F600}".repeat(SENDER_NAME_MAX_CHARS);
  assertEquals(normaliseSenderName(emoji), { ok: true, value: emoji });
});

Deno.test("the cap is measured after normalisation", () => {
  // 101 characters raw, 100 after the surrounding space is trimmed.
  const padded = " " + "a".repeat(SENDER_NAME_MAX_CHARS);
  assertEquals(normaliseSenderName(padded), { ok: true, value: "a".repeat(SENDER_NAME_MAX_CHARS) });
});

Deno.test("a non-string is refused with the tool-facing message", () => {
  for (const raw of [42, null, true, ["x"], { name: "x" }]) {
    const result = normaliseSenderName(raw);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.message.startsWith("signature_set: sender_name"), true);
  }
});

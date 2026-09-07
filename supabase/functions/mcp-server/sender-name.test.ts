// ---------------------------------------------------------------------------
// sender_name normalisation for signature_set.
//
// The stored value goes straight into the From header of every outgoing
// message, so this is where a name is made safe to store: no control
// characters (header injection), no angle brackets (mailbox smuggling), no
// stray whitespace, and a hard character cap. Empty after cleaning means
// "clear", which the tool writes as NULL.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assertEquals } from "jsr:@std/assert@1";
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

Deno.test("CRLF and other control characters are removed (header injection)", () => {
  assertEquals(
    normaliseSenderName("Evancoe Bot\r\nBcc: attacker@example.com"),
    // The CRLF is gone, the run of whitespace collapses, the text remains
    // (harmless once it cannot start a new header line).
    { ok: true, value: "Evancoe BotBcc: attacker@example.com" },
  );
  assertEquals(normaliseSenderName("A\x00B\x7FC"), { ok: true, value: "ABC" });
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

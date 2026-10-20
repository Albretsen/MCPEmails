// envelope-address.ts: stored-draft recipients that sent before #126 send
// again, and nothing that #126 refused for safety gets through.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { envelopeAddress } from "./envelope-address.ts";
import { parseEmail } from "./mime.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { draftEnvelopeRecipients, validateInputSchema } = await import("./index.ts") as unknown as {
  draftEnvelopeRecipients: (headers: Map<string, string[]>) => string[];
  validateInputSchema: (schema: Record<string, unknown>, value: unknown) => unknown[];
};

Deno.test("email_send's address check takes a punycode TLD and still refuses Unicode and quotes", () => {
  // The schema check is isValidEmailAddress. It widened only to ASCII A-label
  // TLDs; the MIME builder writes these addresses into headers as they are.
  const check = (v: string) => validateInputSchema({ type: "string", format: "email" }, v).length === 0;
  assertEquals(check("user@example.xn--p1ai"), true);
  assertEquals(check("user@example.com"), true);
  assertEquals(check("user@münchen.de"), false);
  assertEquals(check('"q"@example.com'), false);
  assertEquals(check("a@evil.com\r\nRCPT TO:<x@evil.com>"), false);
});

Deno.test("plain addresses are unchanged", () => {
  assertEquals(envelopeAddress("someone@example.com"), "someone@example.com");
  assertEquals(envelopeAddress(" first.last+tag@sub.example.co.uk "), "first.last+tag@sub.example.co.uk");
});

Deno.test("an IDN domain is given to SMTP as punycode", () => {
  assertEquals(envelopeAddress("user@münchen.de"), "user@xn--mnchen-3ya.de");
  assertEquals(envelopeAddress("info@пример.рф"), "info@xn--e1afmkfd.xn--p1ai");
  assertEquals(envelopeAddress("a@例え.テスト"), "a@xn--r8jz45g.xn--zckzah");
});

Deno.test("a punycode TLD is accepted as written", () => {
  assertEquals(envelopeAddress("user@xn--e1afmkfd.xn--p1ai"), "user@xn--e1afmkfd.xn--p1ai");
  assertEquals(envelopeAddress("user@example.xn--p1ai"), "user@example.xn--p1ai");
});

Deno.test("a quoted local part is accepted when it fits in an SMTP command", () => {
  assertEquals(envelopeAddress('"john.doe."@example.com'), '"john.doe."@example.com');
  assertEquals(envelopeAddress('"a@b"@example.com'), '"a@b"@example.com');
  assertEquals(envelopeAddress('"x\\"y"@example.com'), '"x\\"y"@example.com');
});

Deno.test("anything that could change the SMTP session is still refused", () => {
  for (
    const bad of [
      "",
      "no-at-sign",
      "@example.com",
      "user@",
      "user@example",
      "user@example.c",
      "a@evil.com\r\nRCPT TO:<x@evil.com>",
      "a@evil.com\nDATA",
      "a@evil.com>",
      "<a@evil.com",
      "a b@example.com",
      '"a b"@example.com',
      '"a>"@example.com',
      '"a<"@example.com',
      '"unterminated@example.com',
      "user@münchen\r\n.de",
      "user@münchen.de\r\nRCPT TO:<x@evil.com>",
      "user@exa mple.com",
      "user@exa<mple.com",
      "user@[127.0.0.1]",
      "user@1.2.3.4",
      "user@ex/ample.com",
      "user@ex:25",
      "user@exämple.com/x",
      "üser@example.com",
      "user@-bad.com",
      "a,b@example.com",
      "x".repeat(321) + "@example.com",
    ]
  ) {
    assertEquals(envelopeAddress(bad), null, JSON.stringify(bad));
  }
});

function envelopeOf(raw: string): string[] {
  return draftEnvelopeRecipients(parseEmail(raw).headers);
}

/** A stored draft as an 8-bit client writes it: raw UTF-8 octets, one per char. */
function octets(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("");
}

Deno.test("a Thunderbird-style draft to IDN, punycode and quoted recipients sends", () => {
  const raw = octets(
    "From: me@example.com\r\n" +
      "To: Jürgen <user@münchen.de>, info@xn--e1afmkfd.xn--p1ai\r\n" +
      'Cc: "Doe, John" <"john.doe."@example.com>\r\n' +
      "Bcc: hidden@example.org\r\n" +
      "Subject: x\r\n\r\nbody",
  );
  assertEquals(envelopeOf(raw), [
    "user@xn--mnchen-3ya.de",
    "info@xn--e1afmkfd.xn--p1ai",
    '"john.doe."@example.com',
    "hidden@example.org",
  ]);
});

Deno.test("a stored draft with a broken recipient is still refused before SMTP", () => {
  const raw = "From: me@example.com\r\nTo: <a@evil.com\r\n RCPT TO:<x@evil.com>>\r\nSubject: x\r\n\r\nbody";
  assertThrows(() => envelopeOf(raw), Error, "draft_has_invalid_recipient");
});

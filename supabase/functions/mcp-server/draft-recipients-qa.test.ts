// QA 2026-10-13: recipients that were dropped or misread without a word.
import { assertEquals } from "jsr:@std/assert@1";
import { gmailHeaderValue, invalidRecipientIn } from "./draft-recipients.ts";

// index.ts#isValidEmailAddress, restated: it cannot be imported by a test.
const isValid = (email: string) =>
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/
    .test(email.trim());

Deno.test("draft send: a mistyped recipient is named, not written or dropped", () => {
  assertEquals(invalidRecipientIn({ to: ["a@b"] }, isValid), { field: "to", entry: "a@b" });
  assertEquals(invalidRecipientIn({ to: ["ok@x.com"], cc: ["ok@x.com", "nope"] }, isValid), {
    field: "cc",
    entry: "nope",
  });
  assertEquals(invalidRecipientIn({ bcc: ["ok@x.com", 7] }, isValid), { field: "bcc", entry: 7 });
  assertEquals(invalidRecipientIn({ to: ["Anna <anna@x>"] }, isValid), {
    field: "to",
    entry: "Anna <anna@x>",
  });
});

Deno.test("draft send: what worked before still works", () => {
  assertEquals(invalidRecipientIn({ draft_id: "Drafts:1" }, isValid), null);
  assertEquals(invalidRecipientIn({ to: ["a@x.com", " b@x.com "], cc: [], bcc: [""] }, isValid), null);
  assertEquals(invalidRecipientIn({ to: ["Anna Berg <anna@x.com>"] }, isValid), null);
  // Not a list: `recipientOverrideFrom` ignores it too, and the argument
  // normaliser has already turned a single string into a list by then.
  assertEquals(invalidRecipientIn({ to: "a@x.com" }, isValid), null);
});

Deno.test("draft_list on Gmail: Cc is found however the header is spelled", () => {
  for (const name of ["Cc", "CC", "cc"]) {
    const headers = [
      { name: "To", value: "a@x.com" },
      { name, value: "hello@mcpemails.com" },
    ];
    assertEquals(gmailHeaderValue(headers, "Cc"), "hello@mcpemails.com", name);
  }
  assertEquals(gmailHeaderValue([{ name: "To", value: "a@x.com" }], "Cc"), null);
  assertEquals(gmailHeaderValue(undefined, "Cc"), null);
});

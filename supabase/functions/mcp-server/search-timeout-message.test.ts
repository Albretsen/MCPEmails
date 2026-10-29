import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { emailSearchTimeoutText } from "./search-timeout-message.ts";

Deno.test("an IMAP search timeout names the list operation and a cheaper search", () => {
  const text = emailSearchTimeoutText("imap", 30);
  assertStringIncludes(text, "Search timed out after 30 seconds.");
  assertStringIncludes(text, "The list operation reads the newest messages without a search");
  assertStringIncludes(text, "unread true");
  assertStringIncludes(text, "from or subject with a since a few days back");
});

Deno.test("API providers keep the short sentence", () => {
  for (const provider of ["gmail", "outlook"]) {
    assertEquals(
      emailSearchTimeoutText(provider, 30),
      "Search timed out after 30 seconds. Try a simpler or more specific query.",
    );
  }
});

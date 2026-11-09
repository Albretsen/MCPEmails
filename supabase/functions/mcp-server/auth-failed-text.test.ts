import { assert, assertEquals } from "jsr:@std/assert@1";
import { authFailedText } from "./auth-failed-text.ts";

const URL = "https://mcpemails.com/dashboard/inboxes";

Deno.test("OAuth providers keep their text byte for byte", () => {
  assertEquals(
    authFailedText("gmail", "access", "https://mcpemails.com/auth/gmail?inbox=x"),
    "Unable to access the gmail inbox: its OAuth token has been revoked or expired, so the inbox has been marked 'error'. " +
      "Ask the user to reconnect it by opening this link in their browser (they may need to sign in to MCPEmails first): " +
      "https://mcpemails.com/auth/gmail?inbox=x",
  );
});

for (const provider of ["imap", "fastmail"]) {
  Deno.test(`a ${provider} refusal names the password, never OAuth or 'error'`, () => {
    const text = authFailedText(provider, "send reply via", URL);
    assert(text.startsWith(`Unable to send reply via the ${provider} inbox: its mail server refused the saved password.`));
    assert(text.includes("not OAuth"));
    assert(!/OAuth token|marked 'error'/.test(text));
    assert(text.includes(URL));
    assert(!text.includes("—"), "no em dashes in customer-facing text");
  });
}

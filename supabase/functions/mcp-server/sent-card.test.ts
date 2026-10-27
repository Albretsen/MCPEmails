// Run: deno test supabase/functions/mcp-server/sent-card.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { SENT_CARD_BODY_MAX, sentCardForError, sentCardForSuccess } from "./sent-card.ts";

Deno.test("sent card: success carries from, body, attachment sizes and the Sent copy", () => {
  const card = sentCardForSuccess({
    from: "a@example.com",
    text: "Hi\r\nthere",
    cc: ["c@example.com"],
    attachments: [{ filename: "q3.pdf", data: "AAAA" }],
  }, false);
  assertEquals(card, {
    outcome: "sent",
    from: "a@example.com",
    cc: ["c@example.com"],
    bcc: [],
    body_text: "Hi\nthere",
    truncated: false,
    attachments: [{ filename: "q3.pdf", size_bytes: 3 }],
    sent_copy: true,
  });
});

Deno.test("sent card: an HTML-only body becomes text, a long one is clipped, a refused Sent copy is reported", () => {
  const html = sentCardForSuccess({ from: null, text: "", html: "<p>Hello &amp; <b>bye</b></p><p>Two</p>" }, true);
  assertEquals(html.outcome === "sent" && html.body_text, "Hello & bye Two");
  assertEquals(html.outcome === "sent" && html.sent_copy, false);
  const long = sentCardForSuccess({ from: null, text: "x".repeat(SENT_CARD_BODY_MAX + 5) }, false);
  assertEquals(long.outcome === "sent" && [long.body_text.length, long.truncated], [SENT_CARD_BODY_MAX, true]);
});

Deno.test("sent card: failures say not sent, unknown delivery says check Sent, unmapped codes say nothing", () => {
  assertEquals(sentCardForError("provider_not_sent", "The mail server refused this message")?.outcome, "not_sent");
  assertEquals(
    sentCardForError("provider_not_sent", "email_send failed while building the message")?.outcome === "not_sent",
    true,
  );
  assertEquals(sentCardForError("provider_error")?.outcome, "unknown");
  assertEquals(sentCardForError("invalid_arguments")?.outcome, "not_sent");
  assertEquals(sentCardForError("chat_confirmation_required")?.outcome, "waiting");
  // Never a plan-limit sentence: customer copy does not mention action caps.
  assertEquals(sentCardForError("usage_limit_reached"), null);
  assertEquals(sentCardForError(null), null);
});

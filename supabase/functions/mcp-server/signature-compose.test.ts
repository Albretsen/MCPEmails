// ---------------------------------------------------------------------------
// Signature composition, and the seam where a held send is signed twice.
//
// Two production bugs live in this file's subject matter, and neither was
// coverable while the code sat in index.ts (which no test can import):
//
//   1. `email_send` signs BEFORE `queueSendApproval`, so an approval snapshot
//      is a fully-composed message. On approval the dispatcher re-runs
//      `executeSendEmail` over that snapshot, which signed it AGAIN. The tests
//      under "the approved re-run" below reconstruct that exact sequence out of
//      the same functions index.ts calls: sign → snapshot → re-run.
//   2. A `body_text`-only edit left the HTML part stale. Its regression test
//      lives with the edit path in mcp-app-approvals.test.ts; what belongs here
//      is that both parts come out of ONE synthesis, so a regenerated part is
//      byte-identical to the part it replaces.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assertEquals } from "jsr:@std/assert@1";
import {
  applySignature,
  composeSignatureBlocks,
  heldSendSnapshot,
  includeSignatureForSend,
  plainTextBodyToHtml,
  SIGNATURE_HTML_CLASS,
  SIGNATURE_TEXT_DELIMITER,
  type SignatureInbox,
} from "./signature-compose.ts";

const TEXT_SIG_INBOX: SignatureInbox = {
  signature_enabled: true,
  signature_text: "Asgeir Albretsen\nMCP Emails",
  signature_html: null,
};

const RICH_SIG_INBOX: SignatureInbox = {
  signature_enabled: true,
  signature_text: null,
  signature_html: '<p><strong>Asgeir</strong> · <a href="https://mcpemails.com">MCP Emails</a></p>',
};

/** How many times our own signature appears in each half of a message. */
function signatureCounts(textBody: string, htmlBody?: string): { text: number; html: number } {
  return {
    text: textBody.split(SIGNATURE_TEXT_DELIMITER).length - 1,
    html: (htmlBody ?? "").split(`class="${SIGNATURE_HTML_CLASS}"`).length - 1,
  };
}

// ---------------------------------------------------------------------------
// The one text-to-HTML synthesis
// ---------------------------------------------------------------------------

Deno.test("plain text becomes HTML by escaping, never by being trusted", () => {
  assertEquals(
    plainTextBodyToHtml(`<script>alert("x")</script> & 'quotes'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;",
  );
  // Newlines are the only thing that becomes markup, and it is markup we wrote.
  assertEquals(plainTextBodyToHtml("one\ntwo"), "one<br>\ntwo");
});

Deno.test("the HTML part a text-only send synthesizes IS plainTextBodyToHtml", () => {
  // The property the approval-edit path depends on: regenerating the HTML part
  // from the text through `plainTextBodyToHtml` reproduces exactly what the
  // send path produced, rather than approximating it.
  const params = applySignature({ textBody: "Hello & goodbye\nline two", htmlBody: undefined }, TEXT_SIG_INBOX);
  const sig = composeSignatureBlocks(TEXT_SIG_INBOX)!;
  assertEquals(
    params.htmlBody,
    `${plainTextBodyToHtml("Hello & goodbye\nline two")}\n` +
      `<div class="${SIGNATURE_HTML_CLASS}">${sig.html}</div>`,
  );
});

Deno.test("a signature lands exactly once in each part of a fresh send", () => {
  const params = applySignature({ textBody: "Hello", htmlBody: undefined }, RICH_SIG_INBOX);
  assertEquals(signatureCounts(params.textBody, params.htmlBody), { text: 1, html: 1 });
});

// ---------------------------------------------------------------------------
// The approved re-run: enqueue → snapshot → dispatch
// ---------------------------------------------------------------------------

/**
 * The sequence index.ts runs for a held `email_send`, with the provider call
 * and the database left out: sign the composed message, store it as the
 * approval snapshot, then (on approval) re-enter the send handler over that
 * snapshot under the dispatcher's internal key.
 */
function heldSendRoundTrip(inbox: SignatureInbox, callerArgs: Record<string, unknown> = {}) {
  const composed = applySignature(
    { textBody: String(callerArgs["body"] ?? "Hello"), htmlBody: callerArgs["html_body"] as string | undefined },
    inbox,
    { include_signature: includeSignatureForSend(callerArgs, false) },
  );
  const snapshot = heldSendSnapshot({
    inbox_id: "inbox-1",
    to: ["someone@example.com"],
    cc: [],
    bcc: [],
    subject: "Subject",
    textBody: composed.textBody,
    htmlBody: composed.htmlBody,
    attachments: [],
  });
  // The dispatcher's re-run: `executeSendEmail(original, internalKey)`.
  const redispatched = applySignature(
    {
      textBody: String(snapshot["body"] ?? ""),
      htmlBody: typeof snapshot["html_body"] === "string" ? snapshot["html_body"] : undefined,
    },
    inbox,
    { include_signature: includeSignatureForSend(snapshot, true) },
  );
  return { composed, snapshot, redispatched };
}

Deno.test("an approved send is signed once, not twice", () => {
  // THE BUG (fixed 2026-09-09): the snapshot is already signed, and the
  // dispatcher re-runs the same handler over it. Both halves are checked,
  // because the HTML half is the one a recipient actually sees.
  for (const inbox of [TEXT_SIG_INBOX, RICH_SIG_INBOX]) {
    const { redispatched } = heldSendRoundTrip(inbox);
    assertEquals(
      signatureCounts(redispatched.textBody, redispatched.htmlBody),
      { text: 1, html: 1 },
      "an approved send must carry the signature exactly once",
    );
  }
});

Deno.test("the approved re-run changes NOTHING about the reviewed body", () => {
  // Stronger than counting: what a human approved is what goes out, byte for
  // byte. Anything appended at dispatch was never on the review card.
  const { snapshot, redispatched } = heldSendRoundTrip(RICH_SIG_INBOX);
  assertEquals(redispatched.textBody, snapshot["body"], "text part unchanged");
  assertEquals(redispatched.htmlBody, snapshot["html_body"], "html part unchanged");
});

Deno.test("the mechanism the fix defends against is real", () => {
  // Pin the reason the flag has to exist: applySignature is not idempotent, so
  // an unguarded second pass over a stored body doubles the signature in both
  // parts. If this test ever fails because applySignature learned to detect its
  // own output, delete the flag rather than leaving two mechanisms.
  const once = applySignature({ textBody: "Hello", htmlBody: undefined }, TEXT_SIG_INBOX);
  const twice = applySignature({ textBody: once.textBody, htmlBody: once.htmlBody }, TEXT_SIG_INBOX);
  assertEquals(signatureCounts(twice.textBody, twice.htmlBody), { text: 2, html: 2 });
});

Deno.test("a caller's include_signature: false survives approval", () => {
  // The quieter half of the same bug: the snapshot is built from the composed
  // send params, not from the raw arguments, so an explicit refusal used to be
  // dropped and the approved send appended a signature anyway.
  const { composed, redispatched } = heldSendRoundTrip(TEXT_SIG_INBOX, {
    body: "Hello",
    include_signature: false,
  });
  assertEquals(signatureCounts(composed.textBody, composed.htmlBody), { text: 0, html: 0 });
  assertEquals(signatureCounts(redispatched.textBody, redispatched.htmlBody), { text: 0, html: 0 });
});

Deno.test("an unsigned send is still text-only after the round trip", () => {
  // No signature configured means no synthesized HTML part, at enqueue and at
  // dispatch alike: a text-only message must not gain an HTML alternative just
  // by being held for approval.
  const noSig: SignatureInbox = { signature_enabled: false, signature_text: "x", signature_html: null };
  const { snapshot, redispatched } = heldSendRoundTrip(noSig);
  assertEquals("html_body" in snapshot, false, "no HTML part is stored");
  assertEquals(redispatched.htmlBody, undefined, "and none is invented at dispatch");
});

Deno.test("the stored snapshot declares the body final", () => {
  const snapshot = heldSendSnapshot({
    inbox_id: "inbox-1",
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    subject: "S",
    textBody: "B",
    attachments: [],
  });
  // Read by the dispatcher (do not sign again) AND by the review card (do not
  // promise the reviewer a signature that is already in the body they see).
  assertEquals(snapshot["include_signature"], false);
  // Empty optional keys stay absent, as they always have: the snapshot is
  // decrypted straight into the send handler's argument object.
  assertEquals("html_body" in snapshot, false);
  assertEquals("attachments" in snapshot, false);
  assertEquals("reply_to" in snapshot, false);
});

Deno.test("only the trusted dispatcher can suppress signing", () => {
  // `internalApprovalDispatch` is set by index.ts on a key it builds itself; an
  // MCP caller cannot reach this argument. Anything else signs as usual.
  assertEquals(includeSignatureForSend({}, false), undefined);
  assertEquals(includeSignatureForSend({}, undefined), undefined);
  assertEquals(includeSignatureForSend({ include_signature: true }, false), undefined);
  assertEquals(includeSignatureForSend({ include_signature: "false" }, false), undefined);
  assertEquals(includeSignatureForSend({ include_signature: false }, false), false);
  assertEquals(includeSignatureForSend({}, true), false);
});

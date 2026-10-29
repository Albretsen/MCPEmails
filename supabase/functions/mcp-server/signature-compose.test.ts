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
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applySignature,
  applySignatureOnce,
  composeSignatureBlocks,
  heldSendSnapshot,
  includeSignatureForSend,
  plainTextBodyToHtml,
  rebuildHtmlKeepingSignature,
  SIGNATURE_HTML_CLASS,
  SIGNATURE_TEXT_DELIMITER,
  type SignatureInbox,
  signatureOutcome,
  storedSignatureBlockOf,
  textCarriesOwnSignature,
} from "./signature-compose.ts";

const TEXT_SIG_INBOX: SignatureInbox = {
  signature_enabled: true,
  signature_text: "Asgeir Albretsen\nMCPEmails",
  signature_html: null,
};

const RICH_SIG_INBOX: SignatureInbox = {
  signature_enabled: true,
  signature_text: null,
  signature_html: '<p><strong>Asgeir</strong> · <a href="https://mcpemails.com">MCPEmails</a></p>',
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
    `${plainTextBodyToHtml("Hello & goodbye\nline two")}\n<div><br></div>\n` +
      `<div class="${SIGNATURE_HTML_CLASS}">${sig.html}</div>`,
  );
});

Deno.test("the HTML signature sits one empty line below the message, like the text part", () => {
  // Found on a real reply 2026-10-29: the text part had "Asgeir\n\n-- \n", the
  // HTML part ran the signature straight under "Asgeir".
  const params = applySignature<{ textBody: string; htmlBody?: string }>({ textBody: "Best,\nAsgeir" }, RICH_SIG_INBOX);
  assert(params.textBody.includes("Asgeir\n\n-- \n"));
  assert(params.htmlBody!.includes(`Asgeir\n<div><br></div>\n<div class="${SIGNATURE_HTML_CLASS}">`));
  // Still found by the code that keeps a stored signature on edit.
  assertEquals(storedSignatureBlockOf(params.htmlBody), composeSignatureBlocks(RICH_SIG_INBOX)!.html);
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

// ---------------------------------------------------------------------------
// Editing a signed body as plain text (draft editor, QA 2026-10-13)
// ---------------------------------------------------------------------------

Deno.test("storedSignatureBlockOf: the last block, nested divs included, or null", () => {
  const inner = '<div><b>Asgeir</b></div><div><a href="https://x.com">x</a></div>';
  const html = `<p>Hi</p>\n<div class="${SIGNATURE_HTML_CLASS}">${inner}</div>\n<br>\n&gt; quoted`;
  assertEquals(storedSignatureBlockOf(html), inner);
  assertEquals(storedSignatureBlockOf("<p>no signature here</p>"), null);
  assertEquals(storedSignatureBlockOf(null), null);
  // Unbalanced markup is not guessed at.
  assertEquals(storedSignatureBlockOf(`<div class="${SIGNATURE_HTML_CLASS}"><div>open`), null);
});

Deno.test("rebuildHtmlKeepingSignature: a body edit is what applySignature builds for the new text", () => {
  for (const inbox of [TEXT_SIG_INBOX, RICH_SIG_INBOX]) {
    const before = applySignature({ textBody: "Old words." } as { textBody: string; htmlBody?: string }, inbox);
    const after = applySignature({ textBody: "New <words> & more." } as { textBody: string; htmlBody?: string }, inbox);
    const rebuilt = rebuildHtmlKeepingSignature(after.textBody, inbox, before.htmlBody);
    assertEquals(rebuilt, after.htmlBody);
    assertEquals(rebuilt!.includes("-- "), false, "the text delimiter never reaches the HTML");
  }
});

Deno.test("rebuildHtmlKeepingSignature: an edited signature line cannot be kept", () => {
  const signed = applySignature({ textBody: "Hi." } as { textBody: string; htmlBody?: string }, RICH_SIG_INBOX);
  assertEquals(rebuildHtmlKeepingSignature(`${signed.textBody}xx`, RICH_SIG_INBOX, signed.htmlBody), null);
  assertEquals(rebuildHtmlKeepingSignature(signed.textBody.replace("Asgeir", "Asgeir A."), RICH_SIG_INBOX, signed.htmlBody), null);
});

Deno.test("rebuildHtmlKeepingSignature: the draft's own block wins over a signature changed since", () => {
  const signed = applySignature({ textBody: "Hi." } as { textBody: string; htmlBody?: string }, RICH_SIG_INBOX);
  const changedInbox: SignatureInbox = { signature_enabled: true, signature_text: "Someone else", signature_html: null };
  const rebuilt = rebuildHtmlKeepingSignature(signed.textBody.replace("Hi.", "Hello."), changedInbox, signed.htmlBody);
  assertEquals(rebuilt, applySignature({ textBody: "Hello." } as { textBody: string; htmlBody?: string }, RICH_SIG_INBOX).htmlBody);
});

Deno.test("rebuildHtmlKeepingSignature: a reply quoting the same signature splits at the person's own", () => {
  const signed = applySignature({ textBody: "Thanks." } as { textBody: string; htmlBody?: string }, RICH_SIG_INBOX);
  const sigPart = signed.textBody.slice(signed.textBody.indexOf(SIGNATURE_TEXT_DELIMITER));
  // Quoted the way other clients quote: no ">" prefix, so the quoted
  // signature lines are whole lines too, and the LAST match is in the quote.
  for (
    const quote of [
      `-----Original Message-----\nFrom: Asgeir\nSent: Monday\n\nEarlier words.\n\n${sigPart}`,
      `From: Asgeir <a@x.com>\nDate: Monday\n\nEarlier words.\n\n${sigPart}`,
    ]
  ) {
    const stored = `${signed.textBody}\n\n${quote}`;
    const storedHtml = applySignature({ textBody: "Thanks." } as { textBody: string; htmlBody?: string }, RICH_SIG_INBOX).htmlBody;
    const rebuilt = rebuildHtmlKeepingSignature(stored.replace("Thanks.", "Thanks a lot."), RICH_SIG_INBOX, storedHtml)!;
    const block = rebuilt.indexOf(`class="${SIGNATURE_HTML_CLASS}"`);
    assertEquals(block > rebuilt.indexOf("Thanks a lot."), true);
    assertEquals(block < rebuilt.indexOf("Earlier words."), true, "the signature block sits before the quote");
    assertEquals(rebuilt.split(`class="${SIGNATURE_HTML_CLASS}"`).length - 1, 1);
  }
});

// ---------------------------------------------------------------------------
// A match without the delimiter line (review 2 of 2026-10-13)
// ---------------------------------------------------------------------------

const ONE_LINE_RICH: SignatureInbox = {
  signature_enabled: true,
  signature_text: "Asgeir",
  signature_html: '<b>Asgeir</b> <img src="https://mcpemails.com/logo.png" alt="logo">',
};

Deno.test("one-line signature: deleting it and signing off with the same word does not bring the rich block back", () => {
  const signed = applySignature({ textBody: "Hi" } as { textBody: string; htmlBody?: string }, ONE_LINE_RICH);
  assertEquals(signed.textBody, `Hi${SIGNATURE_TEXT_DELIMITER}Asgeir`);
  // The person removes "-- \nAsgeir" and writes their own sign-off.
  const edited = "Hi there\n\nThanks,\nAsgeir";
  // Through the editor's call (stored text known, with a delimiter): no block.
  assertEquals(rebuildHtmlKeepingSignature(edited, ONE_LINE_RICH, signed.htmlBody, signed.textBody), null);
  // Stored text unknown: a one-line signature never matches bare either.
  assertEquals(rebuildHtmlKeepingSignature(edited, ONE_LINE_RICH, signed.htmlBody), null);
  // Kept with its delimiter, it is the signature as before.
  const kept = rebuildHtmlKeepingSignature(
    signed.textBody.replace("Hi", "Hi there"),
    ONE_LINE_RICH,
    signed.htmlBody,
    signed.textBody,
  );
  assertEquals(kept, applySignature({ textBody: "Hi there" } as { textBody: string; htmlBody?: string }, ONE_LINE_RICH).htmlBody);
});

Deno.test("Outlook shape: a stored text with no delimiter line still keeps a one-line signature's block", () => {
  const signed = applySignature({ textBody: "Hi" } as { textBody: string; htmlBody?: string }, ONE_LINE_RICH);
  // Graph hands the text part back derived from the HTML: no "-- " line.
  const storedText = "Hi\n\nAsgeir";
  const rebuilt = rebuildHtmlKeepingSignature("Hello\n\nAsgeir", ONE_LINE_RICH, signed.htmlBody, storedText);
  assertEquals(rebuilt !== null && rebuilt.includes(`class="${SIGNATURE_HTML_CLASS}"`), true);
  assertEquals(rebuilt!.includes("Hello"), true);
});

Deno.test("a stored text WITH a delimiter never lets a multi-line signature match bare", () => {
  const signed = applySignature({ textBody: "Hi" } as { textBody: string; htmlBody?: string }, TEXT_SIG_INBOX);
  // Delimiter removed, signature lines left: the person took the signature
  // apart, so the formatting is not claimed.
  const edited = signed.textBody.replace(SIGNATURE_TEXT_DELIMITER, "\n\n");
  assertEquals(rebuildHtmlKeepingSignature(edited, TEXT_SIG_INBOX, signed.htmlBody, signed.textBody), null);
  // Stored text unknown: two whole lines repeated verbatim still count.
  assertEquals(rebuildHtmlKeepingSignature(edited, TEXT_SIG_INBOX, signed.htmlBody) !== null, true);
});

// ---------------------------------------------------------------------------
// What a write result says about the signature (2026-10-17 re-test: Claude told
// users "your signature was added" on inboxes that had none)
// ---------------------------------------------------------------------------

Deno.test("signatureOutcome reports what applySignature did, for every case", () => {
  const cases: [SignatureInbox, boolean | undefined, string][] = [
    [TEXT_SIG_INBOX, undefined, "appended"],
    [RICH_SIG_INBOX, true, "appended"],
    [TEXT_SIG_INBOX, false, "skipped"],
    // signature_get's answer on both inboxes in the re-test: enabled, nothing stored.
    [{ signature_enabled: true, signature_text: null, signature_html: null }, undefined, "none_configured"],
    // The dashboard editor's untouched field: a non-empty string that is no signature.
    [{ signature_enabled: true, signature_text: "", signature_html: "<p></p>" }, undefined, "none_configured"],
    [{ ...TEXT_SIG_INBOX, signature_enabled: false }, undefined, "disabled"],
    [{ signature_enabled: false, signature_text: null, signature_html: null }, false, "skipped"],
  ];
  for (const [inbox, include, expected] of cases) {
    const outcome = signatureOutcome(inbox, { include_signature: include });
    assertEquals(outcome, expected, JSON.stringify([inbox, include]));
    // And it agrees with what applySignature actually does to a body.
    const signed = applySignature({ textBody: "Hi." } as { textBody: string; htmlBody?: string }, inbox, {
      include_signature: include,
    });
    assertEquals(signed.textBody !== "Hi.", outcome === "appended", `${expected}: body matches`);
  }
});

Deno.test("draft and send results carry the signature outcome", () => {
  // index.ts cannot be imported by a test; pin that each write that signs a
  // new body reports it.
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  for (const marker of [
    "draftResult.signature = signatureOutcome(inbox, { include_signature: includeSignature });",
    "updateResult.signature = signatureOutcome(inbox, { include_signature: includeSignature });",
    "sendResult.signature = signatureOutcome(senderInbox, { include_signature: includeSignature });",
  ]) {
    assertEquals(source.split(marker).length, 2, marker);
  }
  // draft_reply: the Outlook branch and the Gmail/IMAP branch.
  assertEquals(
    source.split("signature: signatureOutcome(inbox, { include_signature: includeSignature })").length - 1,
    2,
  );
});

// ---------------------------------------------------------------------------
// A draft body the model signed itself (live claude.ai test, 2026-10-19)
// ---------------------------------------------------------------------------

type Body = { textBody: string; htmlBody?: string };

Deno.test("applySignatureOnce: a body that already carries the signature is not signed twice", () => {
  const pasted = "See you Friday.\n\n-- \nAsgeir Albretsen\nMCPEmails";
  const out = applySignatureOnce({ textBody: pasted } as Body, TEXT_SIG_INBOX);
  assertEquals(out.textBody, pasted);
  assertEquals(signatureCounts(out.textBody, out.htmlBody), { text: 1, html: 1 });
  // The HTML part is the one applySignature builds for the unsigned text.
  const fresh = applySignature({ textBody: "See you Friday." } as Body, TEXT_SIG_INBOX);
  assertEquals(out.htmlBody, fresh.htmlBody);
  // A multi-line signature pasted without the delimiter line counts too.
  const bare = applySignatureOnce({ textBody: "See you Friday.\n\nAsgeir Albretsen\nMCPEmails" } as Body, TEXT_SIG_INBOX);
  assertEquals(bare.textBody, "See you Friday.\n\nAsgeir Albretsen\nMCPEmails");
  // Caller HTML is left alone.
  const withHtml = applySignatureOnce({ textBody: pasted, htmlBody: "<p>See you Friday.</p>" } as Body, TEXT_SIG_INBOX);
  assertEquals(withHtml.htmlBody, "<p>See you Friday.</p>");
});

Deno.test("applySignatureOnce: anything short of the signature is signed as before", () => {
  const one: SignatureInbox = { signature_enabled: true, signature_text: "Asgeir", signature_html: null };
  // A one-line sign-off is not the signature.
  const signoff = applySignatureOnce({ textBody: "Thanks,\nAsgeir" } as Body, one);
  assertEquals(signoff.textBody, "Thanks,\nAsgeir\n\n-- \nAsgeir");
  // The signature inside a quoted original is the quoted message's, not this one.
  const quoted = "Sure.\n\nOn Mon, 7 Sep 2026, Asgeir <a@x.example> wrote:\n> Hi\n> -- \n> Asgeir";
  assertEquals(textCarriesOwnSignature(quoted, one), false);
  const plain = applySignatureOnce({ textBody: "Sure." } as Body, TEXT_SIG_INBOX);
  assertEquals(signatureCounts(plain.textBody, plain.htmlBody), { text: 1, html: 1 });
  // include_signature: false still means no signature, pasted one or not.
  const off = applySignatureOnce({ textBody: "Hi." } as Body, TEXT_SIG_INBOX, { include_signature: false });
  assertEquals(off, { textBody: "Hi." });
  // No signature configured: nothing to detect, nothing appended.
  assertEquals(textCarriesOwnSignature("Hi.\n\n-- \nAsgeir", { signature_enabled: true }), false);
});

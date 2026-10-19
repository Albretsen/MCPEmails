// ---------------------------------------------------------------------------
// The quoted original of a reply draft (draft card release review, 2026-10-17):
// where it starts in the text and in the HTML, the `body.quoted` the envelope
// carries for the card, and that a body edit keeps it byte for byte.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read quoted-reply.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bodyKeepingQuote,
  offsetOfLine,
  quotedHtmlStart,
  quotedTextLine,
  splitQuotedText,
} from "./quoted-reply.ts";
import { applySignature, plainTextBodyToHtml } from "./signature-compose.ts";
import {
  applyDraftPatch,
  buildDraftEditorEnvelope,
  DRAFT_BODY_META_KEY,
  draftCardToolResult,
  type DraftEditorProviderInbox,
  htmlKeepingQuote,
  type NormalizedDraft,
  type ProviderDraft,
  type ProviderDraftParams,
} from "./mcp-app-drafts.ts";

const INBOX: DraftEditorProviderInbox = {
  id: "8f1f2a3c-0000-4000-8000-000000000001",
  email_address: "you@example.com",
  display_name: "Asgeir",
  provider: "imap",
  service: null,
  signature_enabled: true,
  signature_text: "Asgeir Albretsen\nFounder, MCP Emails\nmcpemails.com",
};

/** The shape QA found: message, signature, then our own attribution and quote. */
const REPLY_TEXT = "Thanks, that works for me.\n\n-- \nAsgeir Albretsen\nFounder, MCP Emails\nmcpemails.com" +
  "\n\nOn Mon, 7 Sep 2026 17:32:55 +0000, Asgeir Albretsen <a@example.com> wrote:\n" +
  "> Can we move the call to Friday?\n>\n> -- \n> Dana\n> Unsubscribe: https://x.example/u";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Detection in text
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("text: our own reply attribution starts the quote, not the signature", () => {
  const split = splitQuotedText(REPLY_TEXT);
  assert(split);
  assertEquals(split.head, "Thanks, that works for me.\n\n-- \nAsgeir Albretsen\nFounder, MCP Emails\nmcpemails.com");
  assert(split.quote.startsWith("\n\nOn Mon, 7 Sep 2026"));
  assertEquals(split.head + split.quote, REPLY_TEXT, "byte for byte");
  // The line is counted in "\n", which is what survives the card's boundary.
  const line = quotedTextLine(REPLY_TEXT);
  assertEquals(REPLY_TEXT.slice(offsetOfLine(REPLY_TEXT, line)).split("\n")[0].startsWith("On Mon"), true);
});

Deno.test("text: the common client forms are recognised", () => {
  const cases: [string, string][] = [
    ["gmail wrapped attribution", "Sure.\n\nOn Mon, Sep 7, 2026 at 5:32 PM Dana Example <\ndana@x.example> wrote:\n\n> Hi\n> there"],
    ["norwegian", "Ja.\n\nDen man. 7. sep. 2026 kl. 17:32 skrev Dana <dana@x.example>:\n> Hei"],
    ["german", "Ja.\n\nAm 07.09.2026 um 17:32 schrieb Dana <dana@x.example>:\n> Hallo"],
    ["original message", "Fine.\n\n-----Original Message-----\nFrom: Dana\nSent: Monday\nSubject: Call\n\nHi"],
    ["outlook header block", "Fine.\r\n\r\n________________________________\r\nFrom: Dana <dana@x.example>\r\nSent: Monday, 7 September 2026 17:32\r\nTo: You\r\nSubject: Call\r\n\r\nHi"],
    ["bare > block", "Agreed.\n\n> Can we move it?\n> Thanks"],
  ];
  for (const [label, text] of cases) {
    const split = splitQuotedText(text);
    assert(split, label);
    assertEquals(split.head + split.quote, text, `${label}: round trip`);
    assert(!/\n$/.test(split.head), `${label}: the head ends at the person's words`);
    assert(split.head.length > 0 && !/wrote|skrev|schrieb|From:|>/.test(split.head), `${label}: ${JSON.stringify(split.head)}`);
  }
  // The underscore rule above Outlook's block belongs to the quote.
  const outlook = splitQuotedText(cases[4][1]);
  assertEquals(outlook?.head, "Fine.");
});

Deno.test("text: nothing a person wrote themselves is called a quote", () => {
  for (
    const text of [
      "No quote here.\n\n-- \nAsgeir",
      // Inline answers between quoted lines: the quote does not run to the end.
      "On Mon, Dana wrote:\n> Friday?\nYes, Friday.\n> 3pm?\nFine.",
      "> a quoted line\nmy answer below it",
      // An attribution with no quoted lines after it.
      "On Monday I wrote:\nthe plan.",
      "",
    ]
  ) {
    assertEquals(quotedTextLine(text), -1, JSON.stringify(text));
    assertEquals(splitQuotedText(text), null);
  }
  assertEquals(quotedTextLine(null), -1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Detection in HTML
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("html: client quote wrappers are found, a bare blockquote is not", () => {
  const gmail = '<div dir="ltr">Sure.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon ... wrote:<br></div><blockquote class="gmail_quote">Hi</blockquote></div>';
  assertEquals(quotedHtmlStart(gmail), gmail.indexOf('<div class="gmail_quote'));
  const apple = "<div>Sure.</div><div><br><blockquote type=\"cite\">Hi</blockquote></div>";
  assertEquals(quotedHtmlStart(apple), apple.indexOf("<blockquote"));
  const outlook = '<p>Fine.</p><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: Dana</div>';
  assertEquals(quotedHtmlStart(outlook), outlook.indexOf('<div id="appendonsend"'));
  assertEquals(quotedHtmlStart("<p>As they say:</p><blockquote>Less is more.</blockquote>"), -1);
  assertEquals(quotedHtmlStart(null), -1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The envelope
// ═══════════════════════════════════════════════════════════════════════════

function normalized(overrides: Partial<NormalizedDraft> = {}): NormalizedDraft {
  return {
    draft_id: "Drafts:2",
    to: ["dana@x.example"],
    cc: [],
    bcc: [],
    subject: "Re: Call",
    body_text: REPLY_TEXT,
    body_html: null,
    attachments: [],
    in_reply_to: null,
    signature_embedded: true,
    last_saved_at: "2026-10-17T10:00:00Z",
    ...overrides,
  };
}

function envelopeOf(draft: NormalizedDraft, inbox: DraftEditorProviderInbox = INBOX) {
  return buildDraftEditorEnvelope({
    appUrl: "https://mcpemails.com",
    draft,
    inbox,
    origin: "reply",
    lastSavedBy: "agent",
    canSend: true,
  }) as { draft: { body: Record<string, unknown>; signature: Record<string, unknown> } };
}

Deno.test("envelope: body.quoted names the line, additively; text is unchanged", () => {
  const env = envelopeOf(normalized());
  assertEquals(env.draft.body.text, REPLY_TEXT, "old cards still get the whole text");
  assertEquals(env.draft.body.quoted, { line: quotedTextLine(REPLY_TEXT) });
  // No quote, no key: an envelope without one is exactly what it was.
  const plain = envelopeOf(normalized({ body_text: "Hi.\n\n-- \nAsgeir" }));
  assertEquals("quoted" in plain.draft.body, false);
});

Deno.test("envelope: a deferred body carries quoted in _meta, never on the placeholder", () => {
  const env = buildDraftEditorEnvelope({
    appUrl: "https://mcpemails.com",
    draft: normalized(),
    inbox: INBOX,
    origin: "reply",
    lastSavedBy: "agent",
    canSend: true,
  });
  const result = draftCardToolResult({ draft_id: "Drafts:2" }, env);
  const sc = result.structuredContent as { draft: { body: Record<string, unknown> } };
  assertEquals(sc.draft.body, { text: null, html: null, truncated: false, deferred: true });
  const meta = result._meta?.[DRAFT_BODY_META_KEY] as Record<string, unknown>;
  assertEquals(meta.quoted, { line: quotedTextLine(REPLY_TEXT) });
  assertEquals(meta.text, REPLY_TEXT);
});

Deno.test("envelope: signature.first_line only when the draft lacks the inbox's signature", () => {
  assertEquals(envelopeOf(normalized()).draft.signature, { embedded: true });
  assertEquals(
    envelopeOf(normalized({ body_text: "Hi.", signature_embedded: false })).draft.signature,
    { embedded: false, first_line: "Asgeir Albretsen" },
  );
  // No signature on the inbox: nothing to name, and the card says nothing.
  const none = { ...INBOX, signature_enabled: false };
  assertEquals(
    envelopeOf(normalized({ body_text: "Hi.", signature_embedded: false }), none).draft.signature,
    { embedded: false },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. A body edit keeps the quote, text and HTML, byte for byte
// ═══════════════════════════════════════════════════════════════════════════

const GMAIL_QUOTE_HTML =
  '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 7 Sep 2026, Dana &lt;dana@x.example&gt; wrote:<br></div>' +
  '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">Can we move the call to <b>Friday</b>?</blockquote></div>';

const GMAIL_REPLY: ProviderDraft = {
  subject: "Re: Call",
  to: ["dana@x.example"],
  cc: [],
  bcc: [],
  threadId: "t-1",
  inReplyTo: "<m1@x.example>",
  references: "<m1@x.example>",
  bodyText: "Sure.\r\n\r\nOn Mon, 7 Sep 2026, Dana <dana@x.example> wrote:\r\n\r\n> Can we move the call to *Friday*?\r\n",
  bodyHtml: `<div dir="ltr">Sure.</div><br>${GMAIL_QUOTE_HTML}`,
  attachments: [],
};

function deps(stored: ProviderDraft) {
  const writes: ProviderDraftParams[] = [];
  return {
    writes,
    deps: {
      getDraft: () => Promise.resolve(stored),
      updateDraft: (_i: unknown, _id: string, params: ProviderDraftParams) => {
        writes.push(params);
        return Promise.resolve({ draft_id: "Drafts:3" });
      },
      now: () => Date.parse("2026-10-17T10:00:00Z"),
    },
  };
}

const NO_SIG_INBOX: DraftEditorProviderInbox = { ...INBOX, signature_enabled: false, signature_text: null };

Deno.test("save: editing the message keeps the quoted HTML byte for byte", async () => {
  // What the card sends: the edited head (LF, from a textarea) + the stored
  // quote, verbatim.
  const split = splitQuotedText(GMAIL_REPLY.bodyText as string)!;
  const edited = "Sure, Friday at 3 works." + split.quote;
  const { deps: d, writes } = deps(GMAIL_REPLY);
  const out = await applyDraftPatch(d, NO_SIG_INBOX, "Drafts:2", { bodyText: edited });
  assert(out.ok);
  assertEquals(writes[0].body, edited, "the text part is what the card sent");
  assert(writes[0].body.endsWith(split.quote), "text quote byte for byte");
  // A one-line edit is made inside the stored HTML (html-text-merge.ts), which
  // keeps the head's own markup too; either way the quote must survive whole.
  assertEquals(
    writes[0].htmlBody,
    `<div dir="ltr">Sure, Friday at 3 works.</div><br>${GMAIL_QUOTE_HTML}`,
  );
  assert(writes[0].htmlBody!.endsWith(GMAIL_QUOTE_HTML), "html quote byte for byte");
});

Deno.test("save: round trip twice is stable", async () => {
  const split = splitQuotedText(GMAIL_REPLY.bodyText as string)!;
  const first = deps(GMAIL_REPLY);
  const once = await applyDraftPatch(first.deps, NO_SIG_INBOX, "Drafts:2", { bodyText: "One." + split.quote });
  assert(once.ok);
  const second = deps({ ...GMAIL_REPLY, bodyText: first.writes[0].body, bodyHtml: first.writes[0].htmlBody });
  const twice = await applyDraftPatch(second.deps, NO_SIG_INBOX, "Drafts:3", { bodyText: "Two." + split.quote });
  assert(twice.ok);
  assert(second.writes[0].htmlBody!.endsWith(GMAIL_QUOTE_HTML));
  assertEquals(second.writes[0].body, "Two." + split.quote);
});

Deno.test("save: a changed quote, or HTML without a quote block, keeps the old rule", () => {
  const split = splitQuotedText(GMAIL_REPLY.bodyText as string)!;
  // Quote edited: no keeping.
  assertEquals(
    htmlKeepingQuote("Sure.\n\nOn Mon, 7 Sep 2026, Dana <dana@x.example> wrote:\n> Something else", GMAIL_REPLY.bodyText!, GMAIL_REPLY.bodyHtml!),
    null,
  );
  // Line endings alone are not an edit.
  assert(htmlKeepingQuote("New." + split.quote.replace(/\r\n/g, "\n"), GMAIL_REPLY.bodyText!, GMAIL_REPLY.bodyHtml!));
  // Our own reply draft: the HTML part has no quote block to keep.
  assertEquals(htmlKeepingQuote("New." + split.quote, GMAIL_REPLY.bodyText!, "<p>Sure.</p>"), null);
});

Deno.test("save: with a rich signature above the quote, the signature block and the quote are both kept", async () => {
  const inbox: DraftEditorProviderInbox = {
    ...INBOX,
    signature_text: null,
    signature_html: "<p><b>Asgeir Albretsen</b></p>",
  };
  const stored: ProviderDraft = {
    ...GMAIL_REPLY,
    bodyText: "Sure.\n\n-- \nAsgeir Albretsen\n\nOn Mon, 7 Sep 2026, Dana <dana@x.example> wrote:\n> Friday?",
    bodyHtml: `Sure.\n<div class="mcpemails-signature"><p><b>Asgeir Albretsen</b></p></div>\n${GMAIL_QUOTE_HTML}`,
  };
  const split = splitQuotedText(stored.bodyText as string)!;
  const head = split.head.replace("Sure.", "Sure, Friday.");
  const { deps: d, writes } = deps(stored);
  const out = await applyDraftPatch(d, inbox, "Drafts:2", { bodyText: head + split.quote });
  assert(out.ok);
  const html = writes[0].htmlBody!;
  assert(html.startsWith("Sure, Friday."), html);
  assert(html.includes('<div class="mcpemails-signature"><p><b>Asgeir Albretsen</b></p></div>'), html);
  assert(html.endsWith(GMAIL_QUOTE_HTML), html);
  assertEquals(html.split("mcpemails-signature").length, 2, "one signature block");
});

// ═══════════════════════════════════════════════════════════════════════════
// draft{action:"update"} with a new body keeps the quote (live re-test 2026-10-17)
// ═══════════════════════════════════════════════════════════════════════════

const SIGN_INBOX = { signature_enabled: true, signature_text: "Asgeir Albretsen" };
const sign = (on = true) => (p: { textBody: string; htmlBody?: string }) =>
  applySignature({ ...p }, SIGN_INBOX, on ? {} : { include_signature: false });
const STORED_REPLY = {
  text: "Old words.\n\n-- \nAsgeir Albretsen\n\nOn Mon, 7 Sep 2026 17:32:55 +0000, Dana <dana@example.com> wrote:\n> Friday?\n> Dana",
  html: '<p>Old words.</p>\n<div class="mcpemails-signature">Asgeir Albretsen</div>\n' +
    '<div class="gmail_quote">On Mon, 7 Sep 2026, Dana &lt;dana@example.com&gt; wrote:<blockquote class="gmail_quote">Friday?</blockquote></div>',
};
const STORED_QUOTE = splitQuotedText(STORED_REPLY.text)!.quote;

Deno.test("update: a new body without the quote keeps the stored quote under the new signature", () => {
  const out = bodyKeepingQuote("New words.", undefined, STORED_REPLY, sign(), plainTextBodyToHtml);
  assert(out.quoteKept);
  assert(out.signed);
  assertEquals(out.textBody, "New words.\n\n-- \nAsgeir Albretsen" + STORED_QUOTE);
  assert(quotedTextLine(out.textBody) > 0, "the card is told where it starts");
  // The stored HTML quote block follows the new HTML part byte for byte.
  assert(out.htmlBody!.endsWith(STORED_REPLY.html.slice(quotedHtmlStart(STORED_REPLY.html))), out.htmlBody);
  assertEquals(out.htmlBody!.split("<blockquote").length, 2, "one quote block");
});

Deno.test("update: a body that already carries the quote is not doubled, and the signature goes above it", () => {
  const resent = "New words." + STORED_QUOTE;
  const out = bodyKeepingQuote(resent, undefined, STORED_REPLY, sign(), plainTextBodyToHtml);
  assertEquals(out.quoteKept, false);
  assertEquals(out.textBody, "New words.\n\n-- \nAsgeir Albretsen" + STORED_QUOTE);
  assertEquals(out.textBody.split("wrote:").length, 2, "one attribution");
  assertEquals(out.htmlBody!.split("<blockquote").length, 2, "one quote in the HTML too");
  // Claude's workaround (quote and signature sent back, signature off) is unchanged.
  const workaround = "New words.\n\n-- \nAsgeir Albretsen" + STORED_QUOTE;
  const same = bodyKeepingQuote(workaround, undefined, STORED_REPLY, sign(false), plainTextBodyToHtml);
  assertEquals(same.textBody, workaround);
  assertEquals(same.quoteKept, false);
});

Deno.test("update: a re-sent quote the detector misses is still not doubled", () => {
  // The attribution kept, but an inline answer between quoted lines.
  const body = "New words.\n\nOn Mon, 7 Sep 2026 17:32:55 +0000, Dana <dana@example.com> wrote:\n> Friday?\nYes, Friday.";
  const out = bodyKeepingQuote(body, undefined, STORED_REPLY, sign(false), plainTextBodyToHtml);
  assertEquals(out.quoteKept, false);
  assertEquals(out.textBody, body);
  // Caller HTML with a quote block of its own: nothing is carried either.
  const html = bodyKeepingQuote("New.", '<p>New.</p><blockquote type="cite">x</blockquote>', STORED_REPLY, sign(false), plainTextBodyToHtml);
  assertEquals(html.quoteKept, false);
  assertEquals(html.textBody, "New.");
});

Deno.test("update: no stored quote, or no signature, behaves as before", () => {
  const plain = bodyKeepingQuote("New.", undefined, { text: "Old.", html: null }, sign(), plainTextBodyToHtml);
  assertEquals(plain.quoteKept, false);
  assertEquals(plain.textBody, "New.\n\n-- \nAsgeir Albretsen");
  const none = bodyKeepingQuote("New.", undefined, null, sign(false), plainTextBodyToHtml);
  assertEquals(none, { textBody: "New.", quoteKept: false, signed: false });
  // Signature off, stored quote kept: the HTML part keeps the client's quote block.
  const off = bodyKeepingQuote("New.", undefined, STORED_REPLY, sign(false), plainTextBodyToHtml);
  assert(off.quoteKept);
  assertEquals(off.textBody, "New." + STORED_QUOTE);
  assert(off.htmlBody!.includes('<div class="gmail_quote">'), off.htmlBody);
  // A CRLF stored text (raw IMAP) does not leave mixed line endings.
  const crlf = bodyKeepingQuote("New.", undefined, { text: STORED_REPLY.text.replace(/\n/g, "\r\n") }, sign(false), plainTextBodyToHtml);
  assert(!crlf.textBody.includes("\r"), JSON.stringify(crlf.textBody));
});

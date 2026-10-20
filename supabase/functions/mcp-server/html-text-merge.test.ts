// The pure half of the 2026-10-17 formatting fix. The save path that uses it is
// pinned in mcp-app-drafts.test.ts, section 11; the card's warning, which runs
// these same functions, in apps/mcp-app/harness/draft-formatting.test.mjs.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { htmlHasFormatting, mergeTextEditIntoHtml, textPartMatchingHtml } from "./html-text-merge.ts";
import {
  applyDraftPatch,
  type DraftEditorProviderInbox,
  type ProviderDraft,
  type ProviderDraftParams,
} from "./mcp-app-drafts.ts";
import { applySignature } from "./signature-compose.ts";

const HTML = '<h1>Hello</h1>\n<p>Thanks for <b>the notes</b>, Dana.\n  See you soon.</p>\n<ul><li>One item</li><li>Two items</li></ul>';
const TEXT = "Hello\n\nThanks for the notes, Dana. See you soon.\n\n- One item\n- Two items";

Deno.test("merge: a word typed inside a run keeps every tag", () => {
  assertEquals(
    mergeTextEditIntoHtml(HTML, TEXT, TEXT.replace("See you soon", "See you very soon")),
    HTML.replace("See you soon", "See you very soon"),
  );
});

Deno.test("merge: a list item edit lands inside its <li>", () => {
  assertEquals(
    mergeTextEditIntoHtml(HTML, TEXT, TEXT.replace("- Two items", "- Three items")),
    HTML.replace("<li>Two items</li>", "<li>Three items</li>"),
  );
});

Deno.test("merge: a deleted word, and a CRLF textarea value", () => {
  const out = mergeTextEditIntoHtml(HTML, TEXT, TEXT.replace(" soon", "").replace(/\n/g, "\r\n"));
  assertEquals(out, HTML.replace(" soon", ""));
});

Deno.test("merge: typed markup is escaped, never markup", () => {
  const out = mergeTextEditIntoHtml(HTML, TEXT, TEXT.replace("Dana.", "Dana <script>&."))!;
  assert(out.includes("Dana &lt;script&gt;&amp;."));
  assert(!out.includes("<script>"));
});

Deno.test("merge: entities in the source are matched and kept around the edit", () => {
  const html = "<p>Fish &amp; chips&nbsp;for two.</p>";
  const text = "Fish & chips for two.";
  assertEquals(
    mergeTextEditIntoHtml(html, text, "Fish & chips for three."),
    "<p>Fish &amp; chips&nbsp;for three.</p>",
  );
});

Deno.test("merge refuses: a new line, an ambiguous change, a change across tags", () => {
  assertEquals(mergeTextEditIntoHtml(HTML, TEXT, TEXT + "\nMore."), null, "a new line");
  const twice = "<p><b>yes</b> yes</p>";
  assertEquals(mergeTextEditIntoHtml(twice, "yes yes", "yes no"), null, "the same word twice");
  // "notes," spans </b>: no single run holds the changed characters.
  assertEquals(
    mergeTextEditIntoHtml(HTML, TEXT, TEXT.replace("notes, Dana", "list for Dana")),
    null,
  );
  // A change on one side of a tag is fine, even one that ends at the tag.
  assertEquals(
    mergeTextEditIntoHtml(HTML, TEXT, TEXT.replace("notes, Dana", "notesDana")),
    HTML.replace("</b>, Dana", "</b>Dana"),
  );
});

Deno.test("merge refuses: link text, and parts that say different words", () => {
  const html = '<p>Read <a href="https://x.example">the guide</a> first.</p>';
  assertEquals(mergeTextEditIntoHtml(html, "Read the guide first.", "Read the new guide first."), null);
  assertEquals(
    mergeTextEditIntoHtml("<p><b>Hi</b> there</p>", "Hi there\n> quoted", "Hi you there\n> quoted"),
    null,
    "the text has a quote the HTML lacks",
  );
});

Deno.test("merge leaves our signature block to its own path", () => {
  const html = '<p>Hello <b>Dana</b></p>\n<div class="mcpemails-signature">Asgeir<br>Founder</div>';
  const text = "Hello Dana\n\n-- \nAsgeir\nFounder";
  assertEquals(mergeTextEditIntoHtml(html, text, text.replace("Founder", "CEO")), null);
  assertEquals(
    mergeTextEditIntoHtml(html, text, text.replace("Hello Dana", "Hello there Dana")),
    html.replace("Hello <b>", "Hello there <b>"),
  );
});

Deno.test("htmlHasFormatting: tags a person would lose, outside our signature", () => {
  assertEquals(htmlHasFormatting(HTML), true);
  assertEquals(htmlHasFormatting('<p>See <a href="https://x.example">this</a></p>'), true);
  assertEquals(htmlHasFormatting("Hi,<br>\nsee you."), false);
  assertEquals(htmlHasFormatting('<div dir="ltr"><p>Hi</p><p>Bye</p></div>'), false);
  assertEquals(
    htmlHasFormatting('Hi<br>\n<div class="mcpemails-signature"><table><tr><td><img src="x"></td></tr></table></div>'),
    false,
    "a rich signature alone is signature.rich's business",
  );
  assertEquals(htmlHasFormatting("<style>b{}</style><p>Hi</p>"), false);
  assertEquals(htmlHasFormatting(null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// A text part Claude wrote apart from its HTML (live claude.ai re-test, 2026-10-17)
//
// `draft{action:"create"}` requires a text `body`, and Claude writes its own:
// "Learn more: <url>" next to a linked "Learn more at …", so `sameWords` never
// held and one changed word in the card dropped every tag. The stored text is
// now the HTML's own text when the two disagree (`textPartMatchingHtml`).
// ═══════════════════════════════════════════════════════════════════════════

const CLAUDE_HTML = "<h2>Quick update</h2>\n<p>We moved the launch to <b>Friday</b>.</p>\n" +
  "<ul>\n  <li>Footer fixed</li>\n  <li>Docs updated</li>\n</ul>\n" +
  '<p>Read <a href="https://example.com/plan">the plan</a>. Learn more at ' +
  '<a href="https://example.com">example.com</a>.</p>';
const CLAUDE_TEXT = "Quick update\n\nWe moved the launch to Friday.\n\n* Footer fixed\n* Docs updated\n\n" +
  "Plan: https://example.com/plan\nLearn more: https://example.com";
const OWN_TEXT = "Quick update\n\nWe moved the launch to Friday.\n\n- Footer fixed\n- Docs updated\n\n" +
  "Read the plan (https://example.com/plan). Learn more at example.com.";

Deno.test("divergent text: the merge refused it before, which was the live bug", () => {
  assertEquals(
    mergeTextEditIntoHtml(CLAUDE_HTML, CLAUDE_TEXT, CLAUDE_TEXT.replace("moved", "pushed")),
    null,
  );
});

Deno.test("textPartMatchingHtml: a formatted HTML part with other words gets its own text", () => {
  assertEquals(textPartMatchingHtml(CLAUDE_TEXT, CLAUDE_HTML), OWN_TEXT);
  // Ordered lists count, a <p> inside an <li> stays on the marker's line, and
  // a mailto link whose words are the address is not repeated.
  assertEquals(
    textPartMatchingHtml(
      "Steps: one, two. Mail me.",
      '<ol><li><p>One</p></li><li>Two</li></ol><p>Write to <a href="mailto:a@example.com">a@example.com</a></p>',
    ),
    "1. One\n2. Two\n\nWrite to a@example.com",
  );
  // The item's number is the list's, not words the HTML lacks: an edit merges.
  const ol = "<ol><li>First step</li><li>Second step</li></ol>";
  assertEquals(
    mergeTextEditIntoHtml(ol, "1. First step\n2. Second step", "1. First step\n2. Second small step"),
    "<ol><li>First step</li><li>Second small step</li></ol>",
  );
});

Deno.test("textPartMatchingHtml: leaves the agent's text alone whenever there is doubt", () => {
  // Already the same words: untouched, byte for byte.
  assertEquals(textPartMatchingHtml(TEXT, HTML), TEXT);
  // No formatting: a body edit regenerates it without loss, so nothing to do.
  assertEquals(textPartMatchingHtml("Hi there", "<p>Hello</p><p>Bye</p>"), "Hi there");
  assertEquals(textPartMatchingHtml("Hi there", undefined), "Hi there");
  assertEquals(textPartMatchingHtml("Hi there", "   "), "Hi there");
  // Nothing visible to read off the HTML.
  assertEquals(textPartMatchingHtml("Hi there", '<p><img src="https://example.com/x.png"></p>'), "Hi there");
});

Deno.test("divergent text: once stored as the HTML's own text, a one-word edit keeps every tag", () => {
  const stored = textPartMatchingHtml(CLAUDE_TEXT, CLAUDE_HTML);
  assertEquals(
    mergeTextEditIntoHtml(CLAUDE_HTML, stored, stored.replace("moved", "pushed")),
    CLAUDE_HTML.replace("moved", "pushed"),
  );
  assertEquals(
    mergeTextEditIntoHtml(CLAUDE_HTML, stored, stored.replace("- Docs updated", "- Docs rewritten")),
    CLAUDE_HTML.replace("<li>Docs updated</li>", "<li>Docs rewritten</li>"),
  );
  // A paragraph added at the end becomes a new <p> (2026-10-19)...
  assertEquals(
    mergeTextEditIntoHtml(CLAUDE_HTML, stored, stored + "\n\nOne more thing."),
    CLAUDE_HTML + "<p>One more thing.</p>",
  );
  // ...but one added in the middle still cannot be placed: the caller falls back and warns.
  assertEquals(
    mergeTextEditIntoHtml(CLAUDE_HTML, stored, stored.replace("Friday.", "Friday.\n\nOne more thing.")),
    null,
  );
  // And the address written after a link's words is not the link's words.
  assertEquals(
    mergeTextEditIntoHtml(CLAUDE_HTML, stored, stored.replace("example.com/plan)", "example.com/other)")),
    null,
  );
});

// The save path end to end, on a draft stored the way `draft{action:"create"}`
// now stores it: the agent's parts, the text matched to the HTML, then signed.

const SIGNED_INBOX: DraftEditorProviderInbox = {
  id: "8f1f2a3c-0000-4000-8000-000000000001",
  email_address: "you@example.com",
  display_name: "Sam",
  provider: "imap",
  service: null,
  signature_enabled: true,
  signature_text: "Sam Example\nexample.com",
};

function createdDraft(): { stored: ProviderDraft; deps: Parameters<typeof applyDraftPatch>[0]; writes: ProviderDraftParams[] } {
  const signed = applySignature(
    { textBody: textPartMatchingHtml(CLAUDE_TEXT, CLAUDE_HTML), htmlBody: CLAUDE_HTML as string | undefined },
    SIGNED_INBOX,
  );
  const stored: ProviderDraft = {
    subject: "Update",
    to: ["dana@example.com"],
    cc: [],
    bcc: [],
    bodyText: signed.textBody,
    bodyHtml: signed.htmlBody ?? null,
    attachments: [],
  };
  const writes: ProviderDraftParams[] = [];
  return {
    stored,
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

Deno.test("save: a created draft with divergent text keeps its formatting on a one-word edit", async () => {
  const { stored, deps, writes } = createdDraft();
  const edited = stored.bodyText!.replace("moved", "pushed");
  const out = await applyDraftPatch(deps, SIGNED_INBOX, "Drafts:2", { bodyText: edited });
  assert(out.ok);
  assertEquals(writes[0].body, edited);
  assertEquals(writes[0].htmlBody, stored.bodyHtml!.replace("moved", "pushed"));
  assert(writes[0].htmlBody!.includes('<div class="mcpemails-signature">'), "the signature block stays");
  assert(!out.saved.formatting_removed);
});

Deno.test("save: an added paragraph on such a draft still drops the HTML and says so", async () => {
  const { stored, deps, writes } = createdDraft();
  const edited = stored.bodyText!.replace("Docs updated", "Docs updated\n\nOne more thing.");
  const out = await applyDraftPatch(deps, SIGNED_INBOX, "Drafts:2", { bodyText: edited });
  assert(out.ok);
  assertEquals(writes[0].htmlBody, undefined);
  assertEquals(out.saved.formatting_removed, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Words and lines added at the edge (live claude.ai test, 2026-10-19)
//
// A word typed mid-sentence merged, but one typed at the END of the last line
// did not: "Learn more at mcpemails.com." ends in a one-character run (".")
// after a link, so no single run held enough context, and the card warned
// "Saving this edit turns the whole message into plain text". A new trailing
// line or paragraph always fell back the same way.
// ═══════════════════════════════════════════════════════════════════════════

const EDGE_HTML = "<h2>Quick update</h2>\n<p>We moved the launch to <b>Friday</b>.</p>\n" +
  '<p>Learn more at <a href="https://mcpemails.com">mcpemails.com</a>.</p>';
const EDGE_TEXT = "Quick update\n\nWe moved the launch to Friday.\n\nLearn more at mcpemails.com.";

Deno.test("edge: a word typed at the end of the last line lands after the period, outside the link", () => {
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT + " Pineapple"),
    EDGE_HTML.replace("</a>.</p>", "</a>. Pineapple</p>"),
  );
  // The same after bold text that ends a sentence.
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT.replace("Friday.", "Friday. Or Monday.")),
    EDGE_HTML.replace("</b>.</p>", "</b>. Or Monday.</p>"),
  );
});

Deno.test("edge: a word typed right after a link, before the period, goes outside the link", () => {
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT.replace("mcpemails.com.", "mcpemails.com today.")),
    EDGE_HTML.replace("</a>.</p>", "</a> today.</p>"),
  );
});

Deno.test("edge: a link that ends or starts the line keeps its words; the new ones go beside it", () => {
  const end = '<p>Docs: <a href="https://x.example">x.example</a></p>';
  assertEquals(
    mergeTextEditIntoHtml(end, "Docs: x.example", "Docs: x.example today"),
    end.replace("</a></p>", "</a> today</p>"),
  );
  const start = '<p><a href="https://x.example">x.example</a> has the docs.</p>';
  assertEquals(
    mergeTextEditIntoHtml(start, "x.example has the docs.", "See x.example has the docs."),
    start.replace("<p><a", "<p>See <a"),
  );
  const item = '<ul><li>One</li><li>See <a href="https://x.example">x.example</a></li></ul>';
  assertEquals(
    mergeTextEditIntoHtml(item, "- One\n- See x.example", "- One\n- See x.example now"),
    item.replace("</a></li>", "</a> now</li>"),
  );
  // Link words that are not the address: the word still goes after the link.
  const words = '<p>Read <a href="https://x.example">the guide</a></p>';
  assertEquals(
    mergeTextEditIntoHtml(words, "Read the guide", "Read the guide now"),
    words.replace("</a></p>", "</a> now</p>"),
  );
});

Deno.test("edge: a new trailing paragraph becomes a new <p> after the last one", () => {
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT + "\n\nPineapple & <you>."),
    EDGE_HTML + "<p>Pineapple &amp; &lt;you&gt;.</p>",
  );
  // A trailing newline from the textarea is no edit.
  assertEquals(mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT + "\n"), EDGE_HTML);
  // Two paragraphs, one with a line break in it.
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT + "\n\nBest,\nSam\n\nP.S. Bring cake.\n"),
    EDGE_HTML + "<p>Best,<br>Sam</p><p>P.S. Bring cake.</p>",
  );
  // Inside a wrapper and a full document, it stays inside them.
  const doc = '<html><body><div style="font-family:Arial"><p>Hi <b>Dana</b>.</p></div></body></html>';
  assertEquals(
    mergeTextEditIntoHtml(doc, "Hi Dana.", "Hi Dana.\n\nBye."),
    doc.replace("</p></div>", "</p><p>Bye.</p></div>"),
  );
});

Deno.test("edge: a new trailing line in Gmail-style divs is a <div>; after a list, an item or a <p>", () => {
  const gmail = '<div dir="ltr"><div>Hi <b>Dana</b>,</div><div><br></div><div>Thanks</div></div>';
  assertEquals(
    mergeTextEditIntoHtml(gmail, "Hi Dana,\n\nThanks", "Hi Dana,\n\nThanks\nSam"),
    gmail.replace("<div>Thanks</div>", "<div>Thanks</div><div>Sam</div>"),
  );
  const list = "<p>To do:</p><ul><li>One</li><li>Two</li></ul>";
  const listText = "To do:\n\n- One\n- Two";
  assertEquals(
    mergeTextEditIntoHtml(list, listText, listText + "\n- Three & four"),
    list.replace("</ul>", "<li>Three &amp; four</li></ul>"),
  );
  assertEquals(
    mergeTextEditIntoHtml(list, listText, listText + "\n\nThanks."),
    list + "<p>Thanks.</p>",
  );
  const ol = "<ol><li>First</li><li>Second</li></ol>";
  assertEquals(
    mergeTextEditIntoHtml(ol, "1. First\n2. Second", "1. First\n2. Second\n3. Third"),
    ol.replace("</ol>", "<li>Third</li></ol>"),
  );
});

Deno.test("edge: a new first line becomes a new <p> before the first block", () => {
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, "Hi Dana,\n\n" + EDGE_TEXT),
    "<p>Hi Dana,</p>" + EDGE_HTML,
  );
  const gmail = '<div dir="ltr"><div>Thanks <b>a lot</b></div></div>';
  assertEquals(
    mergeTextEditIntoHtml(gmail, "Thanks a lot", "Hi,\nThanks a lot"),
    '<div dir="ltr"><div>Hi,</div><div>Thanks <b>a lot</b></div></div>',
  );
});

Deno.test("edge still refuses: where a placement would be a guess", () => {
  // A line added in the middle: which block it belongs to is not knowable.
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT.replace("Friday.", "Friday.\n\nNew middle.")),
    null,
  );
  // A line added AND another line edited: the alignment is not certain.
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT.replace("moved", "pushed") + "\n\nMore."),
    null,
  );
  // A line after our signature block: that block keeps its own path.
  const signed = '<p>Hello <b>Dana</b></p>\n<div class="mcpemails-signature">Asgeir<br>Founder</div>';
  const signedText = "Hello Dana\n\n-- \nAsgeir\nFounder";
  assertEquals(mergeTextEditIntoHtml(signed, signedText, signedText + "\n\nP.S."), null);
  // Something after the last text that is not a closing tag (an empty paragraph).
  const trailing = "<p>Hi <b>Dana</b>.</p><p>&nbsp;</p>";
  assertEquals(mergeTextEditIntoHtml(trailing, "Hi Dana.", "Hi Dana.\n\nBye."), null);
  // A plain line under a list with no blank line: an item, or a paragraph?
  const list = "<ul><li>One</li><li>Two</li></ul>";
  assertEquals(mergeTextEditIntoHtml(list, "- One\n- Two", "- One\n- Two\nThanks."), null);
  // The last line is in a quote: no new element guessed.
  assertEquals(
    mergeTextEditIntoHtml(
      "<p>Hi</p><blockquote>Old <b>words</b></blockquote>",
      "Hi\n\n> Old words",
      "Hi\n\n> Old words\n\nNew.",
    ),
    null,
  );
  // Between two links there is no text of our own to carry the words.
  const links = '<p><a href="https://a.example">a.example</a><a href="https://b.example">b.example</a></p>';
  assertEquals(mergeTextEditIntoHtml(links, "a.exampleb.example", "a.example and b.example"), null);
  // A word typed INTO link text is still never merged.
  assertEquals(mergeTextEditIntoHtml(EDGE_HTML, EDGE_TEXT, EDGE_TEXT.replace("mcpemails.com.", "mcpemails.comX.")), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// A link written out as "label (url)" in Claude's text (live claude.ai, v264)
//
// Claude's own text said "Learn more at mcpemails.com (https://mcpemails.com)."
// next to `Learn more at <a href="https://mcpemails.com">mcpemails.com</a>.`.
// `sameWords` ignores addresses, so that text was stored as is, and " Pineapple"
// typed at the end of the line found no place in the HTML: the card warned
// "Saving this edit turns the whole message into plain text". Now the stored
// text is the HTML's own, and drafts stored before still merge: an address
// right after a link's words that is that link's address belongs to the link.
// ═══════════════════════════════════════════════════════════════════════════

const URL_HTML = '<p>Learn more at <a href="https://mcpemails.com">mcpemails.com</a>.</p>';
const URL_TEXT = "Learn more at mcpemails.com (https://mcpemails.com).";
const URL_ANGLE = "Learn more at mcpemails.com <https://mcpemails.com>.";

Deno.test("link url: textPartMatchingHtml stores the HTML's own text when Claude only adds the address", () => {
  assertEquals(textPartMatchingHtml(URL_TEXT, URL_HTML), "Learn more at mcpemails.com.");
  assertEquals(textPartMatchingHtml(URL_ANGLE, URL_HTML), "Learn more at mcpemails.com.");
  assertEquals(textPartMatchingHtml("Learn more at mcpemails.com [https://mcpemails.com].", URL_HTML), "Learn more at mcpemails.com.");
  assertEquals(textPartMatchingHtml("Learn more at mcpemails.com https://mcpemails.com.", URL_HTML), "Learn more at mcpemails.com.");
  const full = EDGE_HTML;
  assertEquals(
    textPartMatchingHtml(EDGE_TEXT.replace("mcpemails.com.", "mcpemails.com (https://mcpemails.com)."), full),
    EDGE_TEXT,
  );
  // Another address than the link's is not the link's: the text stays.
  const other = "Learn more at mcpemails.com (https://other.example).";
  assertEquals(textPartMatchingHtml(other, URL_HTML), other);
});

Deno.test("link url: a draft stored with the address still merges a word typed at the end", () => {
  assertEquals(
    mergeTextEditIntoHtml(URL_HTML, URL_TEXT, URL_TEXT + " Pineapple"),
    URL_HTML.replace("</a>.</p>", "</a>. Pineapple</p>"),
  );
  assertEquals(
    mergeTextEditIntoHtml(URL_HTML, URL_ANGLE, URL_ANGLE + " Pineapple"),
    URL_HTML.replace("</a>.</p>", "</a>. Pineapple</p>"),
  );
  // In a full message, at the end of the line, and as before a new paragraph.
  const text = EDGE_TEXT.replace("mcpemails.com.", "mcpemails.com (https://mcpemails.com).");
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, text, text + " Pineapple"),
    EDGE_HTML.replace("</a>.</p>", "</a>. Pineapple</p>"),
  );
  assertEquals(mergeTextEditIntoHtml(EDGE_HTML, text, text + "\n\nNew."), EDGE_HTML + "<p>New.</p>");
  assertEquals(
    mergeTextEditIntoHtml(EDGE_HTML, text, text.replace("moved", "pushed")),
    EDGE_HTML.replace("moved", "pushed"),
  );
});

Deno.test("link url: a link mid-sentence, written with its address", () => {
  const html = '<p>See <a href="https://x.example/docs">the docs</a> for details.</p>';
  const text = "See the docs (https://x.example/docs) for details.";
  assertEquals(
    mergeTextEditIntoHtml(html, text, text.replace("for details", "for all details")),
    html.replace("for details", "for all details"),
  );
  assertEquals(
    mergeTextEditIntoHtml(html, text, text.replace("docs) for", "docs) now for")),
    html.replace("</a> for", "</a> now for"),
  );
  // Claude's text without the address already says what the HTML says: kept.
  assertEquals(textPartMatchingHtml("See the docs for details.", html), "See the docs for details.");
  // With it, the HTML's own text is stored, which writes it the same way.
  assertEquals(textPartMatchingHtml("See the docs <https://x.example/docs> for details.", html), text);
});

Deno.test("link url: edits inside the address are still refused, never shown as text", () => {
  assertEquals(
    mergeTextEditIntoHtml(URL_HTML, URL_TEXT, URL_TEXT.replace("(https://mcpemails.com)", "(https://mcpemails.com/x)")),
    null,
  );
  assertEquals(
    mergeTextEditIntoHtml(URL_HTML, URL_TEXT, URL_TEXT.replace("(https://mcpemails.com)", "(https://mcpemails.com today)")),
    null,
  );
  // Deleting the address is an edit inside it too: not guessed at.
  assertEquals(mergeTextEditIntoHtml(URL_HTML, URL_TEXT, "Learn more at mcpemails.com."), null);
  // An address the person types elsewhere is their own words: shown as typed.
  assertEquals(
    mergeTextEditIntoHtml(URL_HTML, URL_TEXT, "Hi (https://mcpemails.com). " + URL_TEXT),
    "<p>Hi (https://mcpemails.com). " + URL_HTML.slice(3),
  );
});

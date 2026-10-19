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
  // An added paragraph still cannot be placed: the caller falls back and warns.
  assertEquals(mergeTextEditIntoHtml(CLAUDE_HTML, stored, stored + "\n\nOne more thing."), null);
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

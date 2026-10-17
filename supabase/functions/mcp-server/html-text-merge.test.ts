// The pure half of the 2026-10-17 formatting fix. The save path that uses it is
// pinned in mcp-app-drafts.test.ts, section 11; the card's warning, which runs
// these same functions, in apps/mcp-app/harness/draft-formatting.test.mjs.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { htmlHasFormatting, mergeTextEditIntoHtml } from "./html-text-merge.ts";

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

// ---------------------------------------------------------------------------
// include_folders means "these folders and no others" — on all three providers.
//
// ── What went wrong ────────────────────────────────────────────────────────
// `searchGmailMessages` and `searchOutlookMessages` both scoped the search when
// `include_folders` held exactly ONE entry and both fell through to the whole
// mailbox for two or more:
//
//   if (includeFolders.length === 1) { …scope… } else { …everything… }
//
// So zero entries and five entries ran identical code. A caller who narrowed
// the search to {Receipts, Invoices} got their inbox, spam and trash back with
// no error and no note, and every Outlook row said `folder: "INBOX"` whether or
// not that was where the message lived. `searchImapMessages` had it right the
// whole time — select each mailbox, merge, sort by date — which is the shape
// both fixes are measured against here.
//
// ── Why half of this is a source scan ──────────────────────────────────────
// index.ts calls `Deno.serve` at module load and exports nothing, so a test
// cannot import either search function and run it. That is a standing
// constraint in this directory, not a choice made for this change; see the same
// note at the top of search-phase-wiring.test.ts.
//
// So the split is the usual one. The DECISIONS — which query Gmail sends, which
// folders Outlook fans out over, how the legs merge into one page — are pure
// functions in search-folder-scope.ts and are run for real below, against
// fixtures that include messages from folders the caller did not list. The
// source scan then pins that each provider function wires those decisions up,
// and in particular that neither `else` branch can widen a scoped search back
// to the whole mailbox again.
//
// Run: deno test --allow-all supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  applyGmailFolderScope,
  gmailFolderScopeQuery,
  gmailLabelIdsNeedingNames,
  gmailLabelQueryTerm,
  gmailResultFolder,
  mergeOutlookFolderPages,
  OUTLOOK_FOLDER_FANOUT_CAP,
  type OutlookFolderPage,
  planOutlookFolderFanout,
} from "./search-folder-scope.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/**
 * The body of one top-level `async function name(` in index.ts, from its
 * signature to the first line that closes it at column zero.
 *
 * Crude on purpose: the scans below ask only whether a particular call or
 * branch is present inside one function, and a brace-matching parser would be
 * more machinery than that question is worth.
 */
function functionBody(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert(start !== -1, `index.ts no longer declares ${name}`);
  const end = SOURCE.indexOf("\n}\n", start);
  assert(end !== -1, `could not find the end of ${name}`);
  return SOURCE.slice(start, end);
}

// ---------------------------------------------------------------------------
// Gmail — the constraint goes into the query, because labelIds is an AND.
// ---------------------------------------------------------------------------

Deno.test("no include_folders leaves the Gmail query exactly as the translator built it", () => {
  assertEquals(gmailFolderScopeQuery([]), null);
  assertEquals(
    applyGmailFolderScope("from:alice subject:invoice", null),
    "from:alice subject:invoice",
  );
});

Deno.test("one include_folders entry scopes Gmail to that label and to nothing else", () => {
  assertEquals(gmailFolderScopeQuery(["INBOX"]), "in:inbox");
  assertEquals(
    gmailFolderScopeQuery(["Label_7"], { Label_7: "Receipts" }),
    "label:Receipts",
  );
});

Deno.test("several include_folders entries become Gmail's brace-OR over exactly those labels", () => {
  const scope = gmailFolderScopeQuery(["INBOX", "SENT", "Label_7"], {
    Label_7: "Receipts",
  });
  assertEquals(scope, "{in:inbox in:sent label:Receipts}");
});

Deno.test("a Gmail label set names every requested label and no unrequested one", () => {
  const scope = gmailFolderScopeQuery(["Label_7", "Label_9"], {
    Label_7: "Receipts",
    Label_9: "Invoices",
    Label_11: "Personal",
  }) ?? "";
  assertStringIncludes(scope, "label:Receipts");
  assertStringIncludes(scope, "label:Invoices");
  assert(!scope.includes("Personal"), "an unlisted label leaked into the query");
  assert(!scope.includes("in:inbox"), "the inbox was added to a search that never asked for it");
});

Deno.test("a Gmail label name with spaces or a slash is quoted rather than left to split the query", () => {
  assertEquals(
    gmailLabelQueryTerm("Label_7", { Label_7: "Q3 Receipts" }),
    'label:"Q3 Receipts"',
  );
  assertEquals(
    gmailLabelQueryTerm("Label_8", { Label_8: "Work/2026" }),
    'label:"Work/2026"',
  );
  // Gmail's search box has no escape inside a quoted phrase, so a quote in the
  // name is dropped. That narrows the match; it can never widen it.
  assertEquals(
    gmailLabelQueryTerm("Label_9", { Label_9: 'The "Best" Clients' }),
    'label:"The Best Clients"',
  );
});

Deno.test("a Gmail label set reaching Trash or Spam asks for in:anywhere, which Gmail otherwise omits", () => {
  assertEquals(gmailFolderScopeQuery(["INBOX", "TRASH"]), "{in:inbox in:trash} in:anywhere");
  assertEquals(gmailFolderScopeQuery(["SPAM", "SENT"]), "{in:spam in:sent} in:anywhere");
  // Nothing hidden in the set, nothing added: in:anywhere would be noise.
  assertEquals(gmailFolderScopeQuery(["INBOX", "SENT"]), "{in:inbox in:sent}");
});

Deno.test("Gmail drafts and the inbox categories use the operators Gmail actually publishes", () => {
  assertEquals(gmailLabelQueryTerm("DRAFT"), "in:drafts");
  assertEquals(gmailLabelQueryTerm("STARRED"), "is:starred");
  assertEquals(gmailLabelQueryTerm("CATEGORY_PROMOTIONS"), "category:promotions");
});

Deno.test("the Gmail folder scope binds to the whole query, not to the last OR alternative", () => {
  // `raw` is appended to the translated query verbatim and may carry a
  // top-level OR. Joined with a bare space the brace group would attach to
  // "from:david" alone and the search would return other folders' mail.
  assertEquals(
    applyGmailFolderScope("from:amy OR from:david", "{in:inbox in:sent}"),
    "(from:amy OR from:david) {in:inbox in:sent}",
  );
  // An empty query needs no parentheses around nothing.
  assertEquals(applyGmailFolderScope("", "{in:inbox in:sent}"), "{in:inbox in:sent}");
});

Deno.test("a Gmail label set of system labels alone costs no labels.list round trip", () => {
  assertEquals(gmailLabelIdsNeedingNames(["INBOX", "SENT", "TRASH"]), []);
  assertEquals(gmailLabelIdsNeedingNames(["INBOX", "Label_7"]), ["Label_7"]);
});

Deno.test("a Gmail result is reported under a folder the caller asked for", () => {
  // The message carries three labels; two of them were requested. The first
  // requested one wins, so the answer is stable in the caller's own order.
  assertEquals(
    gmailResultFolder(["UNREAD", "Label_9", "Label_7"], ["Label_7", "Label_9"], "INBOX"),
    "Label_7",
  );
  // Nothing intersects (an unscoped search): fall back, never invent.
  assertEquals(gmailResultFolder(["SENT"], [], "SENT"), "SENT");
});

// ---------------------------------------------------------------------------
// Outlook — one request per folder, merged, with the cap reported.
// ---------------------------------------------------------------------------

Deno.test("an Outlook search under the fan-out cap covers every listed folder and says nothing", () => {
  const plan = planOutlookFolderFanout(["inbox", "sentitems", "archive"]);
  assertEquals(plan.searched, ["inbox", "sentitems", "archive"]);
  assertEquals(plan.skipped, []);
  assertEquals(plan.note, null);
});

Deno.test("no include_folders leaves the Outlook fan-out empty, which is the whole-mailbox case", () => {
  const plan = planOutlookFolderFanout([]);
  assertEquals(plan.searched, []);
  assertEquals(plan.note, null);
});

Deno.test("an Outlook folder list over the cap is narrowed, never widened, and names both halves", () => {
  const folders = ["a", "b", "c", "d", "e", "f", "g"];
  const plan = planOutlookFolderFanout(folders, OUTLOOK_FOLDER_FANOUT_CAP);
  assertEquals(plan.searched.length, OUTLOOK_FOLDER_FANOUT_CAP);
  assertEquals(plan.searched, folders.slice(0, OUTLOOK_FOLDER_FANOUT_CAP));
  assertEquals(plan.skipped, folders.slice(OUTLOOK_FOLDER_FANOUT_CAP));

  const note = plan.note ?? "";
  assert(note !== "", "going over the cap has to be reported");
  for (const f of plan.skipped) {
    assertStringIncludes(note, f);
  }
  for (const f of plan.searched) {
    assertStringIncludes(note, f);
  }
  assertStringIncludes(note, "NOT searched");
  // The caller has to be able to tell that the coverage is short, not wrong.
  assertStringIncludes(note, "narrower");
});

/** A Graph page fixture: `folder` is the leg, `messages` what it returned. */
function page(
  folder: string,
  dates: string[],
  opts: { count?: number | null; hasNextPage?: boolean } = {},
): OutlookFolderPage<{ id: string; receivedDateTime: string }> {
  return {
    folder,
    messages: dates.map((d, i) => ({ id: `${folder}-${i}`, receivedDateTime: d })),
    count: opts.count ?? null,
    hasNextPage: opts.hasNextPage ?? false,
  };
}

const dateOf = (m: { receivedDateTime: string }) => m.receivedDateTime;

Deno.test("an Outlook fan-out returns the folders' messages interleaved newest first", () => {
  const merged = mergeOutlookFolderPages(
    [
      page("inbox", ["2026-09-10T00:00:00Z", "2026-09-06T00:00:00Z"]),
      page("archive", ["2026-09-12T00:00:00Z", "2026-09-08T00:00:00Z"]),
    ],
    0,
    10,
    dateOf,
  );
  assertEquals(
    merged.page.map((r) => r.message.id),
    ["archive-0", "inbox-0", "archive-1", "inbox-1"],
  );
  // Each row keeps the folder its leg asked for, so the caller can see the mix.
  assertEquals(merged.page.map((r) => r.folder), ["archive", "inbox", "archive", "inbox"]);
});

Deno.test("no Outlook result comes from a folder outside include_folders", () => {
  const requested = ["inbox", "archive"];
  const merged = mergeOutlookFolderPages(
    [
      page("inbox", ["2026-09-10T00:00:00Z"]),
      page("archive", ["2026-09-11T00:00:00Z"]),
    ],
    0,
    10,
    dateOf,
  );
  for (const row of merged.page) {
    assert(
      requested.includes(row.folder),
      `a message surfaced under ${row.folder}, which was never requested`,
    );
  }
});

Deno.test("Outlook pagination still walks the merged order rather than one folder at a time", () => {
  const pages = [
    page("inbox", ["2026-09-10T00:00:00Z", "2026-09-06T00:00:00Z"]),
    page("archive", ["2026-09-12T00:00:00Z", "2026-09-08T00:00:00Z"]),
  ];
  const first = mergeOutlookFolderPages(pages, 0, 2, dateOf);
  const second = mergeOutlookFolderPages(pages, 2, 2, dateOf);
  assertEquals(first.page.map((r) => r.message.id), ["archive-0", "inbox-0"]);
  assertEquals(second.page.map((r) => r.message.id), ["archive-1", "inbox-1"]);
  // The first window is short of the pool, so there is demonstrably more.
  assertEquals(first.hasMore, true);
  assertEquals(second.hasMore, false);
});

Deno.test("Outlook reports a total only when every leg supplied an exact count", () => {
  // $filter legs carry @odata.count, and Outlook folders are disjoint, so the
  // sum is exact rather than an estimate.
  const counted = mergeOutlookFolderPages(
    [
      page("inbox", ["2026-09-10T00:00:00Z"], { count: 12 }),
      page("archive", ["2026-09-11T00:00:00Z"], { count: 30 }),
    ],
    0,
    10,
    dateOf,
  );
  assertEquals(counted.total, 42);

  // A $search leg cannot ask for a count, and a partial sum would read as a
  // whole one. Null stays null — the deliberate behaviour this provider has
  // always had rather than a fabricated number.
  const searched = mergeOutlookFolderPages(
    [
      page("inbox", ["2026-09-10T00:00:00Z"], { count: 12 }),
      page("archive", ["2026-09-11T00:00:00Z"], { count: null }),
    ],
    0,
    10,
    dateOf,
  );
  assertEquals(searched.total, null);
});

Deno.test("an Outlook leg with more mail behind it keeps has_more true", () => {
  const merged = mergeOutlookFolderPages(
    [
      page("inbox", ["2026-09-10T00:00:00Z"], { hasNextPage: true }),
      page("archive", ["2026-09-11T00:00:00Z"]),
    ],
    0,
    10,
    dateOf,
  );
  assertEquals(merged.page.length, 2);
  assertEquals(merged.hasMore, true);
});

Deno.test("an Outlook message with no usable date sorts last instead of jumping the page", () => {
  const merged = mergeOutlookFolderPages(
    [
      page("inbox", ["", "2026-09-06T00:00:00Z"]),
      page("archive", ["2026-09-12T00:00:00Z"]),
    ],
    0,
    10,
    dateOf,
  );
  assertEquals(
    merged.page.map((r) => r.message.id),
    ["archive-0", "inbox-1", "inbox-0"],
  );
});

// ---------------------------------------------------------------------------
// The wiring in index.ts, which a test cannot import and run.
// ---------------------------------------------------------------------------

Deno.test("searchGmailMessages sends labelIds for one folder only and puts the rest in the query", () => {
  const body = functionBody("searchGmailMessages");
  assertStringIncludes(body, "gmailFolderScopeQuery(includeFolders");
  assertStringIncludes(body, "applyGmailFolderScope(");
  // labelIds ANDs its values, so it may never carry a multi-folder scope.
  assert(
    /if \(includeFolders\.length === 1\)\s*\{\s*params\.set\("labelIds"/.test(body),
    "labelIds is no longer guarded by the single-folder check",
  );
  assertEquals(
    body.match(/params\.set\("labelIds"/g)?.length,
    1,
    "labelIds is set on more than one branch",
  );
});

Deno.test("searchGmailMessages has no branch left that drops the folder scope", () => {
  const body = functionBody("searchGmailMessages");
  // The scope is computed for every list > 1 and applied unconditionally; there
  // is no `else` that quietly hands Gmail an unscoped `q`.
  assertStringIncludes(body, "const scopeInQuery = includeFolders.length > 1;");
  assert(
    !/fall back to full-inbox search/.test(body),
    "the widening fallback comment is back, which means the branch probably is too",
  );
});

Deno.test("searchOutlookMessages reaches /me/messages only when no folder was listed", () => {
  const body = functionBody("searchOutlookMessages");
  assertStringIncludes(body, "planOutlookFolderFanout(includeFolders");
  assertStringIncludes(body, "fanout.searched.length === 0");
  assertStringIncludes(body, "/me/mailFolders/");
  assertEquals(
    // graphFetch takes paths relative to the v1.0 root since 2026-09-25, so the
    // whole-mailbox endpoint is the bare string literal "/me/messages".
    body.match(/"\/me\/messages"/g)?.length,
    1,
    "the whole-mailbox URL appears on more than the unscoped branch",
  );
  assert(
    !/includeFolders\.length === 1/.test(body),
    "the single-folder special case is back, which is what the fan-out replaced",
  );
});

Deno.test("searchOutlookMessages issues one request per folder and merges them", () => {
  const body = functionBody("searchOutlookMessages");
  assertStringIncludes(body, "legs.map(");
  assertStringIncludes(body, "await Promise.all(");
  assertStringIncludes(body, "mergeOutlookFolderPages(");
  // Each row is reported under the leg it came from, not a hardcoded INBOX.
  assert(
    !/const folder = includeFolders\.length === 1 \? includeFolders\[0\] : "INBOX"/.test(body),
    "every row is being stamped INBOX again",
  );
});

Deno.test("searchOutlookMessages publishes the capped fan-out on the standard notes key", () => {
  const body = functionBody("searchOutlookMessages");
  assertStringIncludes(body, "fanout.note ? { notes: [fanout.note] } : {}");
});

// ---------------------------------------------------------------------------
// The advertised schema — what a caller is told `include_folders` covers.
//
// The behaviour above is only half of this argument. The other half is the one
// sentence in tools/list that says what happens when the list is omitted, and
// that sentence is how the public docs came to claim an omitted list searches
// every folder: email_search stated the default, email_search_and_move stated
// half of it, and email_search_and_delete said "Folder names to search." and
// nothing else. Three tools, one resolver (resolveIncludeFolders), three
// different stories. They now share INCLUDE_FOLDERS_DESCRIPTION, and these
// tests fail the moment one of them grows a private copy again.
// ---------------------------------------------------------------------------

/**
 * The concatenated string literal of a top-level `const NAME = "..." + ...;`.
 *
 * Ends on the first `";` that closes a line, not on the first semicolon: this
 * particular constant has one inside the sentence it declares.
 */
function sourceStringConstant(name: string): string {
  const start = SOURCE.indexOf(`const ${name} =`);
  assert(start !== -1, `index.ts no longer declares ${name}`);
  const end = SOURCE.indexOf('";\n', start);
  assert(end !== -1, `could not find the end of ${name}`);
  return [...SOURCE.slice(start, end + 1).matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
}

/**
 * The advertised `include_folders` description of one registry tool.
 *
 * Resolves the shared constant when the tool uses it, and falls back to reading
 * a literal — so a tool that stops sharing is measured on what it actually
 * says rather than failing to be found.
 */
function includeFoldersDescription(tool: string): string {
  const start = SOURCE.indexOf(`\n    name: "${tool}",`);
  assert(start !== -1, `index.ts no longer registers ${tool}`);
  const next = SOURCE.indexOf('\n    name: "', start + 1);
  const entry = SOURCE.slice(start, next === -1 ? SOURCE.length : next);
  const block = /include_folders: \{[\s\S]*?description:\s*([\s\S]*?),\n/.exec(entry);
  assert(block, `${tool} no longer advertises include_folders`);
  const expr = block[1].trim();
  if (expr === "INCLUDE_FOLDERS_DESCRIPTION") return sourceStringConstant("INCLUDE_FOLDERS_DESCRIPTION");
  return [...expr.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
}

/**
 * Every tool that advertises the argument. email_read is absent on purpose: it
 * is a consolidated tool, and buildConsolidatedSchema copies the property
 * object straight off the legacy email_search entry, so it publishes this exact
 * text without a second copy to check.
 */
const INCLUDE_FOLDERS_TOOLS = [
  "email_search",
  "email_search_and_move",
  "email_search_and_delete",
];

Deno.test("every tool that takes include_folders says what an omitted list covers", () => {
  for (const tool of INCLUDE_FOLDERS_TOOLS) {
    const description = includeFoldersDescription(tool);
    // The default IS the fact that went missing: on generic IMAP an omitted
    // list is INBOX and nothing else, which narrows every sweep silently.
    assertStringIncludes(description, "INBOX only");
    assertStringIncludes(description, "archive or sent");
    // And the two providers where that is not true, both of them. Naming only
    // Gmail is what the text said until 2026-09-14; Outlook searches every
    // folder as well, and a caller who reads "IMAP only" of an Outlook inbox
    // adds folders they never needed to name.
    assertStringIncludes(description, "Gmail");
    assertStringIncludes(description, "Outlook");
  }
});

Deno.test("the three include_folders descriptions are one sentence, not three variants", () => {
  const [first, ...rest] = INCLUDE_FOLDERS_TOOLS.map(includeFoldersDescription);
  for (const other of rest) {
    assertEquals(other, first, "a tool has grown its own copy of the folder-scope text");
  }
  // Shared by reference, not by coincidence: every advertised block names the
  // constant, so there is no literal left to drift.
  const blocks = [...SOURCE.matchAll(/\n\s+include_folders: \{([\s\S]*?)\n\s+\},/g)];
  assertEquals(blocks.length, INCLUDE_FOLDERS_TOOLS.length, "an include_folders schema appeared or vanished");
  for (const block of blocks) {
    assertStringIncludes(block[1], "description: INCLUDE_FOLDERS_DESCRIPTION");
  }
});

// ---------------------------------------------------------------------------
// The cap note has to reach the two tools that rebuild their own result.
// ---------------------------------------------------------------------------

Deno.test("executeSearchAndMove carries the search phase's notes onto the move result", () => {
  const body = functionBody("executeSearchAndMove");
  // Both success paths: the sweep that moved mail, and the one that matched
  // nothing — which is the path where an unreported cap reads as "your mailbox
  // does not contain that" rather than "three folders were not looked at".
  assertStringIncludes(body, "attachResultNotes(moveResult, searchResult.notes)");
  assertStringIncludes(body, "attachResultNotes(emptyResult, searchResult.notes)");
  assert(
    !body.includes("\n    return formatBulkResult("),
    "the bulk result is returned directly again, so the search's notes are dropped",
  );
});

Deno.test("executeSearchAndDelete carries the search phase's notes onto the delete result", () => {
  const body = functionBody("executeSearchAndDelete");
  assertStringIncludes(body, "attachResultNotes(deleteResult, searchResult.notes)");
  assertStringIncludes(body, "attachResultNotes(emptyResult, searchResult.notes)");
  assert(
    !body.includes("\n    return formatBulkResult("),
    "the bulk result is returned directly again, so the search's notes are dropped",
  );
});

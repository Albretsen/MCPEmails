// ---------------------------------------------------------------------------
// Folder addressing tests.
//
// The bug these exist to hold shut, reproduced in production on 2026-08-30:
// `folder action: create` made a Gmail label named "MCPE_HC_20260830_1344",
// `email_organize action: move` accepted that NAME as a destination, and
// `email_read action: list` then refused the same name with
//
//   Provider error while listing inbox: Gmail API error:
//   Invalid label: MCPE_HC_20260830_1344. Please try again in a moment.
//
// Two failures in one line: the read path did not resolve names the write path
// resolved, and it told the agent to wait for a mismatch that would never heal.
// So the assertions below are about the two properties, not the wording: every
// documented spelling resolves the same way for every caller, and a value that
// cannot resolve fails as a NAMED, permanent, structured refusal.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  FOLDER_ALIAS_TOKENS,
  type FolderReference,
  folderNotFoundMessage,
  resolveFolderReference,
} from "./label-target.ts";

/** A Gmail account's labels.list, ids and names as the API reports them. */
const GMAIL_LABELS: FolderReference[] = [
  { id: "INBOX", name: "INBOX" },
  { id: "SENT", name: "SENT" },
  { id: "DRAFT", name: "DRAFT" },
  { id: "TRASH", name: "TRASH" },
  { id: "SPAM", name: "SPAM" },
  { id: "Label_10", name: "MCPE_HC_20260830_1344" },
  { id: "Label_11", name: "Receipts" },
];

/** A generic IMAP account, where the mailbox name IS the id. */
const IMAP_MAILBOXES: FolderReference[] = [
  { id: "INBOX", name: "INBOX" },
  { id: "Sent", name: "Sent" },
  { id: "Drafts", name: "Drafts" },
  { id: "Trash", name: "Trash" },
  { id: "Archive", name: "Archive" },
  { id: "Junk", name: "Junk" },
  { id: "Receipts", name: "Receipts" },
];

/**
 * What index.ts hands the resolver for a matched alias: the canonical IMAP-
 * style name plus every accepted token, mirroring CANONICAL_FOLDER_ALIASES.
 */
const ALIAS_NAMES: Record<string, string[]> = {
  inbox: ["INBOX", "inbox"],
  sent: ["Sent", "sent"],
  drafts: ["Drafts", "drafts", "draft"],
  draft: ["Drafts", "drafts", "draft"],
  trash: ["Trash", "trash", "deleted"],
  deleted: ["Trash", "trash", "deleted"],
  archive: ["Archive", "archive"],
  spam: ["Junk", "spam", "junk"],
  junk: ["Junk", "spam", "junk"],
};

Deno.test("an exact provider id resolves to itself", () => {
  const r = resolveFolderReference("Label_10", GMAIL_LABELS, { provider: "gmail" });
  assert(r.ok);
  assertEquals(r.id, "Label_10");
  assertEquals(r.matched, "id");
});

Deno.test("the label NAME resolves to its id — the call that used to fail", () => {
  const r = resolveFolderReference("MCPE_HC_20260830_1344", GMAIL_LABELS, {
    provider: "gmail",
  });
  assert(r.ok);
  assertEquals(r.id, "Label_10");
  assertEquals(r.matched, "name");
});

Deno.test("names match case-insensitively, as the move path has always done", () => {
  for (const spelling of ["receipts", "RECEIPTS", "ReCeIpTs"]) {
    const r = resolveFolderReference(spelling, GMAIL_LABELS, { provider: "gmail" });
    assert(r.ok, `${spelling} should resolve`);
    assertEquals(r.id, "Label_11");
  }
});

Deno.test("every documented alias resolves on an IMAP-shaped listing", () => {
  const expected: Record<string, string> = {
    inbox: "INBOX",
    sent: "Sent",
    drafts: "Drafts",
    trash: "Trash",
    archive: "Archive",
    spam: "Junk",
  };
  for (const token of FOLDER_ALIAS_TOKENS) {
    const r = resolveFolderReference(token, IMAP_MAILBOXES, {
      aliasNames: ALIAS_NAMES[token],
      provider: "imap",
    });
    assert(r.ok, `alias ${token} should resolve`);
    assertEquals(r.id, expected[token], `alias ${token}`);
  }
});

Deno.test("alias synonyms (draft, deleted, junk) resolve to the same mailbox", () => {
  const pairs: [string, string][] = [
    ["draft", "Drafts"],
    ["deleted", "Trash"],
    ["junk", "Junk"],
  ];
  for (const [token, want] of pairs) {
    const r = resolveFolderReference(token, IMAP_MAILBOXES, {
      aliasNames: ALIAS_NAMES[token],
      provider: "imap",
    });
    assert(r.ok, `alias ${token} should resolve`);
    assertEquals(r.id, want);
  }
});

Deno.test("aliases resolve on Gmail's listing through the same name match", () => {
  const r = resolveFolderReference("inbox", GMAIL_LABELS, {
    aliasNames: ALIAS_NAMES["inbox"],
    provider: "gmail",
  });
  assert(r.ok);
  assertEquals(r.id, "INBOX");
});

Deno.test("surrounding whitespace is trimmed, not treated as part of the name", () => {
  const r = resolveFolderReference("  Receipts  ", GMAIL_LABELS, { provider: "gmail" });
  assert(r.ok);
  assertEquals(r.id, "Label_11");
});

Deno.test("an unresolvable value is a structured failure, not a throw", () => {
  const r = resolveFolderReference("MCPE_HC_typo", GMAIL_LABELS, { provider: "gmail" });
  assert(!r.ok);
  assertEquals(r.code, "folder_not_found");
  // Names the value that failed…
  assertStringIncludes(r.error, "MCPE_HC_typo");
  // …says which inbox…
  assertStringIncludes(r.error, "gmail");
  // …and points at the call that lists valid ids and names.
  assertStringIncludes(r.error, "folder action: list");
});

Deno.test("the failure message never suggests waiting and retrying", () => {
  const messages = [
    (resolveFolderReference("nope", GMAIL_LABELS, { provider: "gmail" }) as {
      error: string;
    }).error,
    folderNotFoundMessage("nope", { provider: "imap" }),
    folderNotFoundMessage("nope", {}),
  ];
  for (const m of messages) {
    const lower = m.toLowerCase();
    assert(!lower.includes("try again"), `must not say "try again": ${m}`);
    assert(!lower.includes("in a moment"), `must not say "in a moment": ${m}`);
    assert(!lower.includes("retry"), `must not tell the agent to retry: ${m}`);
    // It must say the opposite, in so many words.
    assertStringIncludes(lower, "permanent");
  }
});

Deno.test("the failure message lists every accepted spelling", () => {
  const m = folderNotFoundMessage("nope", { provider: "gmail" });
  for (const token of FOLDER_ALIAS_TOKENS) {
    assertStringIncludes(m, token);
  }
  assertStringIncludes(m, "label id"); // Gmail's noun, not "folder id".
});

Deno.test("an empty value asks for one instead of reporting a missing folder", () => {
  const r = resolveFolderReference("   ", GMAIL_LABELS, { provider: "gmail" });
  assert(!r.ok);
  assertEquals(r.code, "folder_required");
});

Deno.test("an empty listing still fails as not-found rather than passing through", () => {
  const r = resolveFolderReference("Receipts", [], { provider: "gmail" });
  assert(!r.ok);
  assertEquals(r.code, "folder_not_found");
});

Deno.test("an id match wins over a same-string name on another folder", () => {
  const folders: FolderReference[] = [
    { id: "Receipts", name: "Old receipts" },
    { id: "Label_9", name: "Receipts" },
  ];
  const r = resolveFolderReference("Receipts", folders, { provider: "imap" });
  assert(r.ok);
  assertEquals(r.id, "Receipts");
  assertEquals(r.matched, "id");
});

Deno.test("a not-found message names the folders the mailbox actually has", () => {
  // The listing was already searched at the point of failure; throwing it away
  // cost a round trip on every guessed name. See availableClause.
  const result = resolveFolderReference("Junk", [
    { id: "1", name: "INBOX" },
    { id: "2", name: "Spam" },
    { id: "3", name: "Archive" },
  ]);
  assert(!result.ok);
  assertStringIncludes(result.error, '"INBOX"');
  assertStringIncludes(result.error, '"Spam"');
  assertStringIncludes(result.error, '"Archive"');
  assertStringIncludes(result.error, "3 folders");
  // And still says the thing that stops a retry loop.
  assertStringIncludes(result.error, "permanent");
});

Deno.test("a long listing is truncated with its remainder counted", () => {
  const folders = Array.from({ length: 60 }, (_, i) => ({ id: `${i}`, name: `Folder${i}` }));
  const result = resolveFolderReference("Nope", folders);
  assert(!result.ok);
  assertStringIncludes(result.error, "60 folders");
  assertStringIncludes(result.error, "and 20 more");
  // A truncated list must never read as the whole mailbox.
  assert(!result.error.includes('"Folder59"'));
});

Deno.test("an empty listing adds no sentence about what is there", () => {
  const result = resolveFolderReference("Junk", []);
  assert(!result.ok);
  assert(
    !/This inbox has/.test(result.error),
    "an empty mailbox listing should not announce a count",
  );
});

Deno.test("Gmail's not-found message counts labels, not folders", () => {
  const result = resolveFolderReference("Junk", [{ id: "1", name: "INBOX" }], {
    provider: "gmail",
  });
  assert(!result.ok);
  assertStringIncludes(result.error, "1 label");
});

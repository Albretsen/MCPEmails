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
  folderArgumentValue,
  folderNameRequest,
  folderNameTrimNote,
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

// ---------------------------------------------------------------------------
// Whitespace-padded mailbox names (2026-09-14).
//
// Reported by a user and then found in the code: a mailbox created in a
// provider's own web UI as " LM1921 & LM1935 " keeps its spaces in LIST, and on
// IMAP that padded string IS its id. The resolver trimmed the CALLER's value
// and compared it against UNTRIMMED candidates, so `f.id === trimmed` and
// `f.name.toLowerCase() === lower` were both structurally incapable of
// matching. Every folder argument returned folder_not_found, for every possible
// spelling, forever. The user could not even move mail out of the folder.
//
// The assertions below are about the property, not the implementation: a value
// and a candidate are trimmed TOGETHER or not at all, an exact match always
// beats a whitespace-insensitive one, and a relaxed match that is not unique is
// refused rather than guessed.
// ---------------------------------------------------------------------------

/** The user's real mailbox, as the provider's LIST reports it. */
const PADDED_MAILBOXES: FolderReference[] = [
  { id: "INBOX", name: "INBOX" },
  { id: "Archive", name: "Archive" },
  { id: " LM1921 & LM1935 ", name: " LM1921 & LM1935 " },
];

Deno.test("a mailbox whose name is padded with spaces resolves by its exact name", () => {
  const r = resolveFolderReference(" LM1921 & LM1935 ", PADDED_MAILBOXES, {
    provider: "imap",
  });
  assert(r.ok, "the exact padded name must reach the mailbox that carries it");
  assertEquals(r.id, " LM1921 & LM1935 ");
  assertEquals(r.matched, "id");
});

Deno.test("the trimmed spelling of a padded mailbox resolves when nothing else could be meant", () => {
  const r = resolveFolderReference("LM1921 & LM1935", PADDED_MAILBOXES, {
    provider: "imap",
  });
  assert(r.ok, "an unambiguous trimmed spelling must resolve, not dead-end");
  assertEquals(r.id, " LM1921 & LM1935 ");
  assertEquals(r.matched, "whitespace");
});

Deno.test("a padded mailbox resolves whatever padding the caller happens to send", () => {
  for (const spelling of ["  LM1921 & LM1935", "LM1921 & LM1935   ", "\tLM1921 & LM1935\n"]) {
    const r = resolveFolderReference(spelling, PADDED_MAILBOXES, { provider: "imap" });
    assert(r.ok, `${JSON.stringify(spelling)} should resolve`);
    assertEquals(r.id, " LM1921 & LM1935 ");
  }
});

Deno.test("a padded mailbox is matched case-insensitively too, like every other name", () => {
  const r = resolveFolderReference("lm1921 & lm1935", PADDED_MAILBOXES, {
    provider: "imap",
  });
  assert(r.ok);
  assertEquals(r.id, " LM1921 & LM1935 ");
});

/** The ambiguous shape: two mailboxes that differ only in their padding. */
const TWO_WORKS: FolderReference[] = [
  { id: "INBOX", name: "INBOX" },
  { id: "Work", name: "Work" },
  { id: " Work ", name: " Work " },
];

Deno.test("an exact name beats a whitespace-insensitive match on another folder", () => {
  const bare = resolveFolderReference("Work", TWO_WORKS, { provider: "imap" });
  assert(bare.ok);
  assertEquals(bare.id, "Work", "the unpadded spelling must reach the unpadded mailbox");
  assertEquals(bare.matched, "id");

  const padded = resolveFolderReference(" Work ", TWO_WORKS, { provider: "imap" });
  assert(padded.ok);
  assertEquals(padded.id, " Work ", "the padded spelling must reach the padded mailbox");
  assertEquals(padded.matched, "id");
});

Deno.test("a spelling exact for neither of two padding-twins is refused, never guessed", () => {
  // "  Work  " is a third padding: it is not either mailbox's name, and relaxing
  // the whitespace matches both. Choosing one would move mail into the wrong
  // mailbox and report success, which is the failure nobody goes looking for.
  const r = resolveFolderReference("  Work  ", TWO_WORKS, { provider: "imap" });
  assert(!r.ok);
  assertEquals(r.code, "folder_ambiguous");
  // The message must make the two distinguishable, which means showing padding.
  assertStringIncludes(r.error, '"Work"');
  assertStringIncludes(r.error, '" Work "');
  // …and must say that nothing happened, so the agent does not re-issue blind.
  assertStringIncludes(r.error, "Nothing was changed");
});

Deno.test("the ambiguous refusal does not fire when only one padding-twin exists", () => {
  const r = resolveFolderReference("  Work  ", [
    { id: "INBOX", name: "INBOX" },
    { id: " Work ", name: " Work " },
  ], { provider: "imap" });
  assert(r.ok, "one candidate is not an ambiguity");
  assertEquals(r.id, " Work ");
});

Deno.test("a mailbox matched by both its id and its name counts once, not twice", () => {
  // On IMAP the name IS the id, so every candidate satisfies both comparisons.
  // If the relaxed pass counted them separately, every IMAP folder would look
  // ambiguous with itself.
  const r = resolveFolderReference(" Receipts ", [{ id: "Receipts", name: "Receipts" }], {
    provider: "imap",
  });
  assert(r.ok);
  assertEquals(r.id, "Receipts");
});

Deno.test("stray whitespace around an ordinary name still resolves, as it always has", () => {
  // The reason the trim was there in the first place. It must not regress.
  for (const spelling of ["  Receipts  ", " Receipts", "Receipts\t"]) {
    const r = resolveFolderReference(spelling, GMAIL_LABELS, { provider: "gmail" });
    assert(r.ok, `${JSON.stringify(spelling)} should resolve`);
    assertEquals(r.id, "Label_11");
  }
});

Deno.test("an alias still wins over a user folder named like it with padding", () => {
  // "trash" asks for a ROLE. A folder someone happened to call " trash " is not
  // that role, so the alias pass must run BEFORE the whitespace pass. This
  // mailbox spells its real trash "Deleted", which the alias table knows and
  // exact-name matching does not, so only the alias pass can find it.
  const r = resolveFolderReference("trash", [
    { id: "INBOX", name: "INBOX" },
    { id: " trash ", name: " trash " },
    { id: "Deleted", name: "Deleted" },
  ], { aliasNames: ALIAS_NAMES["trash"], provider: "imap" });
  assert(r.ok);
  assertEquals(r.id, "Deleted", "the role, not the lookalike");
  assertEquals(r.matched, "alias");
});

Deno.test("every documented alias still resolves with the whitespace pass in place", () => {
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

Deno.test("a genuine miss is still folder_not_found with the message that stops a retry", () => {
  const r = resolveFolderReference("LM1921 and LM1935", PADDED_MAILBOXES, {
    provider: "imap",
  });
  assert(!r.ok);
  assertEquals(r.code, "folder_not_found");
  assertStringIncludes(r.error, "LM1921 and LM1935");
  assertStringIncludes(r.error, "folder action: list");
  assertStringIncludes(r.error, "permanent");
  // The padded name is listed WITH its padding, which is how the caller finds it.
  assertStringIncludes(r.error, '" LM1921 & LM1935 "');
  assert(!r.error.toLowerCase().includes("try again"));
});

Deno.test("a value that is only whitespace is still folder_required, not a match", () => {
  const r = resolveFolderReference("   ", PADDED_MAILBOXES, { provider: "imap" });
  assert(!r.ok);
  assertEquals(r.code, "folder_required");
});

// ---------------------------------------------------------------------------
// The argument layer: folderArgumentValue.
// ---------------------------------------------------------------------------

Deno.test("a folder argument is present-checked by its trim and passed on untouched", () => {
  assertEquals(folderArgumentValue(" LM1921 & LM1935 "), " LM1921 & LM1935 ");
  assertEquals(folderArgumentValue("Archive"), "Archive");
  assertEquals(folderArgumentValue("  Archive  "), "  Archive  ");
});

Deno.test("a blank or absent folder argument is still absent", () => {
  for (const raw of ["", "   ", "\t\n", undefined, null, 7, {}]) {
    assertEquals(folderArgumentValue(raw), "", `${JSON.stringify(raw ?? null)} is absent`);
  }
});

// ---------------------------------------------------------------------------
// The user's scenario, end to end at the level this is testable.
//
// resolveFolderId in index.ts is not importable (index.ts is the Deno.serve
// entry point), so the two things it contributes are reproduced here exactly:
// it lists the folders once, and it hands the matcher the value AS TYPED. The
// regression this guards is the one the user reported - a padded mailbox as the
// SOURCE of a move (email_read action:list `folder`, email_read action:search
// `include_folders`) and as its DESTINATION (email_organize
// `destination_folder_id`, which now reaches the matcher through
// folderArgumentValue rather than through a .trim()).
// ---------------------------------------------------------------------------

/** What resolveFolderId does with a folder argument, minus the network. */
function resolveAsFolderId(
  raw: unknown,
  folders: readonly FolderReference[],
): { ok: true; id: string } | { ok: false; code: string } {
  const value = folderArgumentValue(raw);
  if (!value) return { ok: false, code: "folder_required" };
  const match = resolveFolderReference(value, folders, { provider: "imap" });
  return match.ok ? { ok: true, id: match.id } : { ok: false, code: match.code };
}

Deno.test("mail can be moved OUT of a space-padded folder: it resolves as a move SOURCE", () => {
  // The complaint verbatim: every folder argument returned folder_not_found.
  for (const spelling of [" LM1921 & LM1935 ", "LM1921 & LM1935"]) {
    const source = resolveAsFolderId(spelling, PADDED_MAILBOXES);
    assert(source.ok, `source ${JSON.stringify(spelling)} must resolve`);
    assertEquals(source.id, " LM1921 & LM1935 ");
  }
  // …and the destination of that same move is an ordinary folder.
  const dest = resolveAsFolderId("Archive", PADDED_MAILBOXES);
  assert(dest.ok);
  assertEquals(dest.id, "Archive");
});

Deno.test("mail can be moved INTO a space-padded folder: it resolves as a move DESTINATION", () => {
  for (const spelling of [" LM1921 & LM1935 ", "LM1921 & LM1935"]) {
    const dest = resolveAsFolderId(spelling, PADDED_MAILBOXES);
    assert(dest.ok, `destination ${JSON.stringify(spelling)} must resolve`);
    assertEquals(dest.id, " LM1921 & LM1935 ");
  }
  const source = resolveAsFolderId("INBOX", PADDED_MAILBOXES);
  assert(source.ok);
  assertEquals(source.id, "INBOX");
});

Deno.test("the destination argument survives the presence check with its padding intact", () => {
  // The specific line that used to eat it: `args["destination_folder_id"].trim()`
  // in all five move/copy handlers. If the padding is lost HERE, no fix in the
  // matcher can bring it back.
  const args: Record<string, unknown> = { destination_folder_id: " LM1921 & LM1935 " };
  assertEquals(folderArgumentValue(args["destination_folder_id"]), " LM1921 & LM1935 ");
  const dest = resolveAsFolderId(args["destination_folder_id"], PADDED_MAILBOXES);
  assert(dest.ok);
  assertEquals(dest.id, " LM1921 & LM1935 ");
});

// ---------------------------------------------------------------------------
// Creating and renaming: the trim stays, the silence does not.
// ---------------------------------------------------------------------------

Deno.test("a create/rename name is still trimmed, so no unaddressable mailbox is built", () => {
  const req = folderNameRequest(" ZZ SPACE TEST ");
  assertEquals(req.name, "ZZ SPACE TEST");
});

Deno.test("a trimmed create/rename name is reported, never applied silently", () => {
  const req = folderNameRequest(" ZZ SPACE TEST ");
  assert(req.trimmed, "the caller must be told the name changed");
  assertEquals(req.requested, " ZZ SPACE TEST ", "and what they actually asked for");
  const note = folderNameTrimNote(req);
  assert(note, "a changed name must carry a sentence saying so");
  // Both spellings, so the agent can tell what it typed from what it got…
  assertStringIncludes(note, '"ZZ SPACE TEST"');
  assertStringIncludes(note, '" ZZ SPACE TEST "');
  // …and which of the two to use next, which is the actionable half.
  assertStringIncludes(note, "Address it by that name");
});

Deno.test("a name that needed no trimming reports nothing at all", () => {
  const req = folderNameRequest("Receipts");
  assertEquals(req.name, "Receipts");
  assertEquals(req.trimmed, false);
  assertEquals(folderNameTrimNote(req), null);
});

Deno.test("the trim note calls a Gmail label a label", () => {
  const note = folderNameTrimNote(folderNameRequest("  Receipts  "), "label");
  assert(note);
  assertStringIncludes(note, "this label is called");
});

Deno.test("a blank or non-string create/rename name is empty, and carries no note", () => {
  for (const raw of ["", "   ", "\t", undefined, null, 7]) {
    const req = folderNameRequest(raw);
    assertEquals(req.name, "", `${JSON.stringify(raw ?? null)} is blank`);
    assertEquals(folderNameTrimNote(req), null, "nothing was created, so nothing to report");
  }
});

Deno.test("a created folder can be addressed by the name the create call reported", () => {
  // The loop the silent trim used to open: create " ZZ SPACE TEST ", get a
  // folder, keep addressing it by the padded spelling, and see folder_not_found
  // forever. With the note, the agent knows which spelling to hold — and both
  // spellings reach it anyway, because the whitespace pass is unambiguous here.
  const req = folderNameRequest(" ZZ SPACE TEST ");
  const listing: FolderReference[] = [
    { id: "INBOX", name: "INBOX" },
    { id: req.name, name: req.name },
  ];
  for (const spelling of [req.name, req.requested]) {
    const r = resolveFolderReference(spelling, listing, { provider: "imap" });
    assert(r.ok, `${JSON.stringify(spelling)} should reach the created folder`);
    assertEquals(r.id, "ZZ SPACE TEST");
  }
});

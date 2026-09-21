// ---------------------------------------------------------------------------
// The folder half of an IMAP message id is the server's answer, not a guess.
//
// ── What went wrong ────────────────────────────────────────────────────────
// A customer on Yandex could list their spam and then do nothing else with it.
// Every read, reply, flag, move, copy and delete of a message in that mailbox
// came back "Mailbox not found: Junk" — a mailbox the account does not have.
//
// The cause was one line. `imapFolderName(folder)` was a static alias-table
// lookup (`lookupCanonicalAlias(folder)?.imap ?? folder`), so it answered "what
// is this role USUALLY called?": Spam→Junk, Draft→Drafts, Deleted→Trash. It was
// then used at thirteen SELECT sites to answer a different question, "which
// mailbox is this?", about a name the server ITSELF had reported and that we
// had minted an id from. Yandex names its spam mailbox "Spam" and has no
// "Junk", so listing worked and everything downstream of the id did not.
//
// The same second mapping had already been removed from the search path (see
// search-phase-wiring.test.ts, "must not alias-map folder names a second time")
// and, before that, from the draft path (see imapUpdateDraft's comment in
// index.ts). It is now one rule in one module, applied everywhere.
//
// ── The other half: where soft delete sends mail ───────────────────────────
// Both soft-delete paths moved messages to `imapFolderName("TRASH")`, which
// evaluates to the literal string "Trash", above a comment claiming it
// "handles namespaced/localized trash like INBOX.Trash". It never did. So
// email_delete could not soft-delete anything on Gmail-over-IMAP
// ("[Gmail]/Trash"), on Dovecot/cPanel ("INBOX.Trash"), or on any localized
// account. Trash is now resolved the way Archive already was: the server's own
// \\Trash SPECIAL-USE mailbox, else a mailbox whose WHOLE name is "Trash".
//
// ── The third place, and the only silent one ───────────────────────────────
// The same alias table also outranked the folder LISTING inside
// `resolveFolderId`, so a folder whose real name is "Spam" could not be
// addressed at all on an account that also has a \\Junk mailbox — and a move,
// copy or delete destination was silently rewritten while reporting success.
// That fix, its measurement and its tests are the last section of this file.
//
// ── Why half of this is a source scan ──────────────────────────────────────
// index.ts calls `Deno.serve` at module load and exports nothing, so a test
// cannot import a provider function and run it — the standing constraint in
// this directory, not a choice made here. So the DECISIONS (which mailbox a
// folder token names, which mailbox on a given layout is the trash can) are
// pure functions in imap-folder-target.ts and are run for real below, against
// layout fixtures taken from the providers that broke. The source scan then
// pins that all thirteen call sites are wired to them, so a reviewer cannot
// reintroduce the old shape and have it look deliberate.
//
// Run: deno test --allow-all supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type CanonicalFolderAlias,
  imapMailboxForServerFolder,
  lookupCanonicalAlias,
  type MailboxListEntry,
  matchImapAliasMailbox,
} from "./imap-folder-target.ts";
import {
  type FolderReference,
  matchFolderExactly,
  resolveFolderReference,
} from "./label-target.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/**
 * `src` with whole-line comments dropped.
 *
 * The scans below are mostly "this token must NOT appear", and index.ts now
 * talks about `imapFolderName` at length precisely because it is the thing
 * being warned against — a tombstone where it used to be defined, and the
 * comments above the two delete paths saying what they no longer do. Scanning
 * raw text would make those explanations trip the assertion that the code is
 * gone, which is the wrong incentive: it would push the reasoning out of the
 * file. Line-based is enough here, since every comment in the passages
 * involved is on its own line.
 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

const CODE = codeOnly(SOURCE);

/**
 * The body of one top-level `function name(` / `async function name(` in
 * index.ts, from its signature to the first line that closes it at column zero.
 *
 * Crude on purpose, and deliberately the same crude helper
 * search-folder-scope.test.ts uses: the scans below ask only whether a
 * particular call is present inside one function, and a brace-matching parser
 * would be more machinery than that question is worth.
 */
function functionBody(name: string): string {
  let start = SOURCE.indexOf(`\nasync function ${name}(`);
  if (start === -1) start = SOURCE.indexOf(`\nfunction ${name}(`);
  assert(start !== -1, `index.ts no longer declares ${name}`);
  const end = SOURCE.indexOf("\n}\n", start);
  assert(end !== -1, `could not find the end of ${name}`);
  return SOURCE.slice(start, end);
}

const TRASH: CanonicalFolderAlias = lookupCanonicalAlias("trash")!;

/** A LIST reply, in the two fields the matcher reads. */
function mailbox(name: string, ...flags: string[]): MailboxListEntry {
  return { name, flags };
}

// ---------------------------------------------------------------------------
// A folder name that came from the server is used exactly as the server spelled
// it.
// ---------------------------------------------------------------------------

Deno.test("a message decoded out of Yandex's Spam folder selects Spam, never Junk", () => {
  // The reported bug, in one line. This account has a mailbox named "Spam" and
  // no "Junk" at all, so the old alias lookup turned a listable message into
  // "Mailbox not found: Junk" on every subsequent operation.
  assertEquals(imapMailboxForServerFolder("Spam"), "Spam");
});

Deno.test("the other three alias rewrites are gone too: Draft, Deleted and trash stay themselves", () => {
  // Each of these was a real rewrite of a real server-reported name:
  //   Draft → Drafts, Deleted → Trash, trash → Trash (a case change alone is
  //   enough to miss, since IMAP mailbox names are case-sensitive except INBOX).
  assertEquals(imapMailboxForServerFolder("Draft"), "Draft");
  assertEquals(imapMailboxForServerFolder("Deleted"), "Deleted");
  assertEquals(imapMailboxForServerFolder("trash"), "trash");
});

Deno.test("namespaced and prefixed mailbox names survive verbatim", () => {
  // Dovecot/cPanel put everything under INBOX; Gmail-over-IMAP puts its system
  // mailboxes under "[Gmail]". Both spellings are the server's, and both used
  // to be safe only because they failed to match the alias table by accident.
  assertEquals(imapMailboxForServerFolder("INBOX.Spam"), "INBOX.Spam");
  assertEquals(imapMailboxForServerFolder("[Gmail]/Spam"), "[Gmail]/Spam");
  assertEquals(imapMailboxForServerFolder("INBOX.Trash"), "INBOX.Trash");
  assertEquals(imapMailboxForServerFolder("Papierkorb"), "Papierkorb");
  assertEquals(imapMailboxForServerFolder("Archive/2019"), "Archive/2019");
});

Deno.test("a hand-crafted alias-shaped id is taken literally and is allowed to fail", () => {
  // The decision this test exists to pin. A model that builds "spam:5" from the
  // word "spam" rather than from folder_list output gets a SELECT of "spam",
  // and on a server with no such mailbox a clean "Mailbox not found: spam".
  //
  // It is not resolved to "Junk", not even as a fallback after the literal
  // fails, because a UID is unique only WITHIN a mailbox: selecting some other
  // mailbox does not find the caller's message, it re-points their UID at an
  // unrelated one — and email_delete and email_move would then destroy or
  // relocate mail nobody named. The accident was never dependable anyway; it
  // worked only when the account happened to use the alias table's English
  // default, which is the exact coin flip that broke Yandex.
  //
  // Alias WORDS still work where they are a user-facing argument: email_list's
  // `folder` and a move destination go through resolveFolderId, which matches
  // against the account's real layout.
  assertEquals(imapMailboxForServerFolder("spam"), "spam");
  assertEquals(imapMailboxForServerFolder("junk"), "junk");
  assertEquals(imapMailboxForServerFolder("SPAM"), "SPAM");
});

Deno.test("INBOX, the one reserved name, is unaffected", () => {
  assertEquals(imapMailboxForServerFolder("INBOX"), "INBOX");
});

// ---------------------------------------------------------------------------
// Where soft delete sends mail, on the layouts that broke.
// ---------------------------------------------------------------------------

Deno.test("Gmail-over-IMAP soft delete lands in [Gmail]/Trash, the mailbox flagged \\Trash", () => {
  const layout = [
    mailbox("INBOX"),
    mailbox("[Gmail]/All Mail", "\\HasNoChildren", "\\All"),
    mailbox("[Gmail]/Drafts", "\\HasNoChildren", "\\Drafts"),
    mailbox("[Gmail]/Sent Mail", "\\HasNoChildren", "\\Sent"),
    mailbox("[Gmail]/Spam", "\\HasNoChildren", "\\Junk"),
    mailbox("[Gmail]/Trash", "\\HasNoChildren", "\\Trash"),
  ];
  assertEquals(matchImapAliasMailbox(layout, TRASH), "[Gmail]/Trash");
});

Deno.test("a Dovecot/cPanel account soft-deletes into INBOX.Trash", () => {
  const layout = [
    mailbox("INBOX", "\\HasChildren"),
    mailbox("INBOX.Drafts", "\\HasNoChildren", "\\Drafts"),
    mailbox("INBOX.Sent", "\\HasNoChildren", "\\Sent"),
    mailbox("INBOX.spam", "\\HasNoChildren", "\\Junk"),
    mailbox("INBOX.Trash", "\\HasNoChildren", "\\Trash"),
  ];
  assertEquals(matchImapAliasMailbox(layout, TRASH), "INBOX.Trash");
});

Deno.test("a localized trash is found by its flag, not by its name", () => {
  const layout = [
    mailbox("INBOX"),
    mailbox("Gesendet", "\\Sent"),
    mailbox("Papierkorb", "\\Trash"),
  ];
  assertEquals(matchImapAliasMailbox(layout, TRASH), "Papierkorb");
});

Deno.test("an account with no SPECIAL-USE still finds a mailbox literally named Trash", () => {
  const layout = [mailbox("INBOX"), mailbox("Sent"), mailbox("Trash")];
  assertEquals(matchImapAliasMailbox(layout, TRASH), "Trash");
  // Case-insensitively, since servers disagree about capitalisation.
  assertEquals(
    matchImapAliasMailbox([mailbox("INBOX"), mailbox("trash")], TRASH),
    "trash",
  );
});

Deno.test("a user's own folder is never mistaken for the account's trash can", () => {
  // The guard that matters most here, because this function picks the
  // destination of a DELETE. None of these is the trash: matching is on the
  // whole name, never on a path segment or a suffix. Nothing matches, so the
  // caller creates the canonical mailbox instead of quietly filing the user's
  // deleted mail inside one of their own project folders.
  const layout = [
    mailbox("INBOX"),
    mailbox("Projects/Trash", "\\HasNoChildren"),
    mailbox("Archive/2019/Trash", "\\HasNoChildren"),
    mailbox("Trash Talk", "\\HasNoChildren"),
    mailbox("Old Trash", "\\HasNoChildren"),
    mailbox("INBOX.Trashcan", "\\HasNoChildren"),
  ];
  assertEquals(matchImapAliasMailbox(layout, TRASH), null);
});

Deno.test("the server's flagged trash wins over a same-named user folder", () => {
  const layout = [
    mailbox("INBOX"),
    mailbox("Trash", "\\HasNoChildren"), // a user folder that happens to be called Trash
    mailbox("[Gmail]/Trash", "\\HasNoChildren", "\\Trash"),
  ];
  assertEquals(matchImapAliasMailbox(layout, TRASH), "[Gmail]/Trash");
});

Deno.test("the trash alias is the same table entry the delete paths ask for", () => {
  // resolveImapTrashMailbox calls lookupCanonicalAlias("trash")!, so a rename
  // of that token would turn into a runtime null-assertion in a delete.
  assert(TRASH, 'CANONICAL_FOLDER_ALIASES no longer has a "trash" entry');
  assertEquals(TRASH.imap, "Trash");
  assert(TRASH.aliases.includes("deleted"));
});

// ---------------------------------------------------------------------------
// Source scan — the thirteen call sites.
// ---------------------------------------------------------------------------

/** Every function that SELECTs a mailbox named by an id or a resolved folder. */
const SELECT_SITES = [
  "listImapMessages",
  "readImapMessage",
  "replyImapMessage",
  "readOriginalMessage",
  "imapArchiveEmail",
  "imapAddKeyword",
  "imapMoveEmail",
  "imapCopyEmail",
  "imapDeleteEmail",
  "imapGetDraft",
  "executeCreateReplyDraft",
];

Deno.test("no IMAP SELECT re-maps a folder name through the alias table", () => {
  assert(
    !CODE.includes("selectMailbox(imapFolderName("),
    "a SELECT is alias-mapping a server-reported folder name again",
  );
  assert(
    !CODE.includes("session.select(imapFolderName("),
    "a session SELECT is alias-mapping a server-reported folder name again",
  );
  // And the function that made it possible is gone, not merely unused: the old
  // shape read as deliberate at every one of its call sites.
  assert(
    !/\bfunction imapFolderName\s*\(/.test(CODE),
    "index.ts declares imapFolderName again; see the tombstone comment there",
  );
});

Deno.test("every IMAP select site takes the folder name the server gave it", () => {
  for (const name of SELECT_SITES) {
    assertStringIncludes(
      functionBody(name),
      "imapMailboxForServerFolder(folder)",
      `${name} must SELECT the folder verbatim`,
    );
  }
});

Deno.test("there is no single-message IMAP flag helper to keep in step", () => {
  // `imapUpdateFlags` was in the list above until 2026-09-21, and had had no
  // caller since 2026-06-03: the four single-message flag handlers became one
  // bulk `email_flag` whose schema requires `message_ids`, so the shape it
  // served stopped existing at the tool boundary. It went on collecting
  // maintenance it could not repay — the F-09 probe (2026-09-20) was added to a
  // function nothing could call. Flagging goes through imapBulkFlag, which gets
  // the SELECT and the presence probe from imapBulkByFolderGroup; see the
  // tombstone above imapArchiveEmail in index.ts before adding a second path.
  assert(
    !/\bfunction imapUpdateFlags\s*\(/.test(CODE),
    "index.ts declares imapUpdateFlags again; see the tombstone comment there",
  );
});

Deno.test("email_list does not map a folder resolveFolderId already resolved", () => {
  // executeListInbox resolves the caller's `folder` strictly before dispatch,
  // so listImapMessages received a real mailbox name and mapped it a SECOND
  // time.
  // That is how "Spam" became "Junk" before a single message was even listed.
  const body = codeOnly(functionBody("listImapMessages"));
  assert(
    !body.includes("imapFolderName("),
    "listImapMessages must not map an already-resolved folder a second time",
  );
  assertStringIncludes(
    functionBody("executeListInbox"),
    "listFolder = await resolveFolderId(",
  );
  assertStringIncludes(
    functionBody("executeListInbox"),
    "listImapMessages(\n          inbox,\n          listFolder,",
  );
});

Deno.test("the bulk loop selects each source group's own mailbox", () => {
  // runImapFolderGroups takes the mapping as `folderName`, so one wrong
  // argument here re-broke every bulk move/copy/delete/flag at once.
  assertStringIncludes(
    functionBody("imapBulkByFolderGroup"),
    "folderName: imapMailboxForServerFolder,",
  );
});

Deno.test("neither soft-delete path moves mail to the literal string Trash", () => {
  assert(
    !CODE.includes('imapFolderName("TRASH")'),
    "a delete path is moving mail to a hard-coded Trash again",
  );
  for (const name of ["imapDeleteEmail", "imapBulkDelete"]) {
    assertStringIncludes(
      functionBody(name),
      "resolveImapTrashMailbox(client)",
      `${name} must resolve trash against the server's real layout`,
    );
  }
});

Deno.test("trash is resolved the same way archive already was", () => {
  const body = functionBody("resolveImapTrashMailbox");
  assertStringIncludes(body, 'lookupCanonicalAlias("trash")');
  assertStringIncludes(body, "listMailboxes()");
  assertStringIncludes(body, "matchImapAliasMailbox(mailboxes, trashAlias)");
  // Mirrors imapArchiveEmail's fallback: create the canonical mailbox rather
  // than dead-ending the operation with a raw "[TRYCREATE]" leak.
  assertStringIncludes(body, "createMailbox(trashAlias.imap)");
});

Deno.test("the trash destination exists before the source message is touched", () => {
  // uidMove COPYs before it STOREs \\Deleted and EXPUNGEs, but a destination
  // that cannot be found or created must fail while the message is still
  // sitting safely in its own folder — so the LIST/CREATE comes first, the way
  // imapArchiveEmail orders it.
  const body = functionBody("imapDeleteEmail");
  const resolved = body.indexOf("resolveImapTrashMailbox(client)");
  // Anchored on the two commands themselves rather than on their adjacency:
  // the F-09 fix (2026-09-20) put an `assertUidPresent` probe between the
  // SELECT and the MOVE, and an anchor that spelled out the exact intervening
  // bytes made an unrelated, correct insertion look like this ordering had
  // been broken. The property under test is which of the two happens FIRST.
  const moved = body.indexOf("uidMove([uid], trash)");
  assert(resolved !== -1 && moved !== -1, "imapDeleteEmail changed shape");
  assert(
    resolved < moved,
    "imapDeleteEmail must resolve trash before selecting the source mailbox",
  );
});

// ---------------------------------------------------------------------------
// THE THIRD PLACE: a folder NAME the caller typed outranks the same word read
// as a role.
//
// ── What went wrong ────────────────────────────────────────────────────────
// The two defects above are the read side of one alias table; this is its
// write side, and it is the dangerous one because it never said anything.
// `resolveFolderId` matched `lookupCanonicalAlias(trimmed)` FIRST and returned
// on a hit, so its "list once and match by id / name" step was unreachable for
// any value that happened to be an alias token. Measured against production on
// a Migadu mailbox holding both a "Junk" mailbox and a newly created "Spam":
//
//   email_read     action: list folder: "Spam"                → Junk's messages,
//                                                               byte for byte
//   email_organize action: copy destination_folder_id: "Spam" → success: true,
//                                                               message in Junk
//
// uidCopy takes the destination verbatim, so the swap happened inside
// resolveFolderId. A move, copy or delete that files mail in a mailbox nobody
// named and reports success is worse than the loud "Mailbox not found: Junk"
// the other two produced: nothing in the response says it happened, and the
// customers who reported the read failures could not see this one at all
// because their Yandex account has no "Junk" for it to land in.
//
// ── The rule ───────────────────────────────────────────────────────────────
// Exact beats role, which is the order resolveFolderReference has always used
// internally (id, then name case-insensitively, then the alias's names, then a
// whitespace-relaxed pass). The alias branch simply used to jump the queue.
// So resolveFolderId now lists first, asks matchFolderExactly, and only then
// reads the value as a ROLE. An alias no folder answers to still resolves the
// way it always did: "spam" → the \\Junk mailbox, "trash" → "[Gmail]/Trash",
// "archive" → whatever advertises \\Archive, created on the move path when it
// is missing and never on a strict read.
// ---------------------------------------------------------------------------

/**
 * What `resolveFolderId` does with an IMAP folder argument, minus the network.
 *
 * It is a harness, not a second implementation: every decision below is made by
 * the same exported function index.ts calls, in the same order, and the source
 * scans further down pin that the order in index.ts is this one. The only
 * things dropped are the listing (supplied here as `layout`) and the CREATE,
 * which is reported as `created` rather than performed.
 */
function resolveAsFolderId(
  value: string,
  layout: MailboxListEntry[],
  opts: { strict?: boolean } = {},
): { mailbox: string | null; how: string } {
  const folders: FolderReference[] = layout.map((mb) => ({ id: mb.name, name: mb.name }));
  const alias = lookupCanonicalAlias(value.trim());

  // 0: the reserved name, which no listing can disagree with.
  if (alias?.aliases[0] === "inbox") return { mailbox: "INBOX", how: "reserved" };

  // 1-2: exact id / exact name, on the value as typed.
  const exact = matchFolderExactly(value, folders);
  if (exact) return { mailbox: exact.id, how: "exact" };

  // 3: the alias as a ROLE.
  if (alias) {
    const role = matchImapAliasMailbox(layout, alias);
    if (role) return { mailbox: role, how: "role" };
    const isArchive = alias.aliases[0] === "archive";
    if (isArchive && !opts.strict) return { mailbox: alias.imap, how: "created" };
    if (opts.strict) return { mailbox: null, how: "folder_not_found" };
    return { mailbox: alias.imap, how: "static_fallback" };
  }

  // 4: the rest of the matching rule.
  const match = resolveFolderReference(value, folders, { provider: "imap" });
  return match.ok ? { mailbox: match.id, how: match.matched } : { mailbox: null, how: match.code };
}

/** The account the defect was measured on: a real Junk, and the user's own Spam. */
const SPAM_AND_JUNK: MailboxListEntry[] = [
  mailbox("INBOX"),
  mailbox("Drafts", "\\HasNoChildren", "\\Drafts"),
  mailbox("Sent", "\\HasNoChildren", "\\Sent"),
  mailbox("Junk", "\\HasNoChildren", "\\Junk"),
  mailbox("Trash", "\\HasNoChildren", "\\Trash"),
  mailbox("Spam", "\\HasNoChildren"),
];

Deno.test("REGRESSION (Migadu, 2026-09-14): a mailbox named Spam is Spam, not Junk", () => {
  // The measured defect, in the two calls that showed it. Both used to answer
  // with Junk: the list silently, the copy while reporting success.
  assertEquals(resolveAsFolderId("Spam", SPAM_AND_JUNK), { mailbox: "Spam", how: "exact" });
  assertEquals(resolveAsFolderId("Junk", SPAM_AND_JUNK), { mailbox: "Junk", how: "exact" });
  // And the role reading is still there for the word that names no mailbox
  // here — "junk" is the \\Junk mailbox's own name, case aside.
  assertEquals(resolveAsFolderId("junk", SPAM_AND_JUNK), { mailbox: "Junk", how: "exact" });
});

Deno.test("an account with only Junk still resolves the spam ROLE to it", () => {
  // The other half of the rule, and the constraint that makes the fix safe to
  // ship: nothing about a caller who means the role changes.
  const onlyJunk = SPAM_AND_JUNK.filter((mb) => mb.name !== "Spam");
  assertEquals(resolveAsFolderId("spam", onlyJunk), { mailbox: "Junk", how: "role" });
  assertEquals(resolveAsFolderId("Spam", onlyJunk), { mailbox: "Junk", how: "role" });
});

Deno.test("a localized spam mailbox is still found by its flag when nothing is named Spam", () => {
  const layout = [mailbox("INBOX"), mailbox("Uerwünscht", "\\Junk")];
  assertEquals(resolveAsFolderId("spam", layout), { mailbox: "Uerwünscht", how: "role" });
  assertEquals(resolveAsFolderId("junk", layout), { mailbox: "Uerwünscht", how: "role" });
});

Deno.test("the Trash/Deleted pair behaves the same way", () => {
  // "Deleted" is an alias token for trash, so a user folder wearing that name
  // used to be unaddressable: every spelling of it resolved to Trash.
  const layout = [
    mailbox("INBOX"),
    mailbox("Trash", "\\HasNoChildren", "\\Trash"),
    mailbox("Deleted", "\\HasNoChildren"),
  ];
  assertEquals(resolveAsFolderId("Deleted", layout), { mailbox: "Deleted", how: "exact" });
  assertEquals(resolveAsFolderId("deleted", layout), { mailbox: "Deleted", how: "exact" });
  assertEquals(resolveAsFolderId("Trash", layout), { mailbox: "Trash", how: "exact" });
  // With no folder of that name, "deleted" is a role again.
  const noDeleted = layout.filter((mb) => mb.name !== "Deleted");
  assertEquals(resolveAsFolderId("deleted", noDeleted), { mailbox: "Trash", how: "role" });
});

Deno.test("the Drafts/Draft pair behaves the same way", () => {
  const layout = [
    mailbox("INBOX"),
    mailbox("Drafts", "\\HasNoChildren", "\\Drafts"),
    mailbox("Draft", "\\HasNoChildren"),
  ];
  assertEquals(resolveAsFolderId("Draft", layout), { mailbox: "Draft", how: "exact" });
  assertEquals(resolveAsFolderId("Drafts", layout), { mailbox: "Drafts", how: "exact" });
  const noDraft = layout.filter((mb) => mb.name !== "Draft");
  assertEquals(resolveAsFolderId("draft", noDraft), { mailbox: "Drafts", how: "role" });
});

Deno.test("a move/copy/delete destination never lands in a mailbox that is not the one named", () => {
  // The property, stated once over every token the alias table accepts: if a
  // mailbox is literally called this, that mailbox is the destination. The
  // layout deliberately gives each token a same-named user folder AND a
  // differently-named flagged mailbox that the old code would have chosen.
  const layout = [
    mailbox("INBOX"),
    mailbox("[Gmail]/Drafts", "\\Drafts"),
    mailbox("[Gmail]/Sent Mail", "\\Sent"),
    mailbox("[Gmail]/Spam", "\\Junk"),
    mailbox("[Gmail]/Trash", "\\Trash"),
    mailbox("[Gmail]/All Mail", "\\All"),
    ...["Sent", "Drafts", "Draft", "Trash", "Deleted", "Archive", "Spam", "Junk"]
      .map((name) => mailbox(name)),
  ];
  for (const token of ["Sent", "Drafts", "Draft", "Trash", "Deleted", "Archive", "Spam", "Junk"]) {
    const dest = resolveAsFolderId(token, layout);
    assertEquals(
      dest.mailbox,
      token,
      `a destination of "${token}" must be the mailbox called "${token}"`,
    );
  }
  // INBOX is the one reserved name, and resolves to itself without a listing.
  assertEquals(resolveAsFolderId("inbox", layout), { mailbox: "INBOX", how: "reserved" });
});

Deno.test("archive still auto-creates on the move path when the account has none", () => {
  const layout = [mailbox("INBOX"), mailbox("Sent", "\\Sent")];
  assertEquals(resolveAsFolderId("archive", layout), { mailbox: "Archive", how: "created" });
});

Deno.test("archive NEVER auto-creates on a strict (read-side) resolution", () => {
  // `email_read action: list folder: "archive"` must not leave a mailbox behind
  // as a side effect of a read. It fails instead, permanently and by name.
  const layout = [mailbox("INBOX"), mailbox("Sent", "\\Sent")];
  assertEquals(resolveAsFolderId("archive", layout, { strict: true }), {
    mailbox: null,
    how: "folder_not_found",
  });
});

Deno.test("an existing archive is used as-is, created or flagged or merely named", () => {
  const flagged = [mailbox("INBOX"), mailbox("Archiv", "\\Archive")];
  assertEquals(resolveAsFolderId("archive", flagged), { mailbox: "Archiv", how: "role" });
  const named = [mailbox("INBOX"), mailbox("Archive")];
  assertEquals(resolveAsFolderId("archive", named), { mailbox: "Archive", how: "exact" });
  // …including under strict, where only the CREATE is forbidden.
  assertEquals(resolveAsFolderId("archive", flagged, { strict: true }), {
    mailbox: "Archiv",
    how: "role",
  });
});

Deno.test("a padded mailbox is still reachable, and an alias token does not shadow it", () => {
  // The 2026-09-14 whitespace fix, re-checked through the new ordering: the
  // exact pass runs on the value AS TYPED, so neither spelling is lost.
  const layout = [mailbox("INBOX"), mailbox(" Spam "), mailbox("Junk", "\\Junk")];
  assertEquals(resolveAsFolderId(" Spam ", layout), { mailbox: " Spam ", how: "exact" });
  // "Spam" is exact for nothing here, so it is a role again — the \\Junk
  // mailbox, not the user's padded folder.
  assertEquals(resolveAsFolderId("Spam", layout), { mailbox: "Junk", how: "role" });
});

// ---------------------------------------------------------------------------
// Source scan — the ORDER in resolveFolderId, which is the whole fix.
// ---------------------------------------------------------------------------

Deno.test("resolveFolderId asks for an exact folder BEFORE it reads a value as a role", () => {
  const body = codeOnly(functionBody("resolveFolderId"));
  assertStringIncludes(body, "return nameOrId;", "functionBody did not capture the whole function");

  const exactAt = body.indexOf("matchFolderExactly(nameOrId, folders)");
  const aliasAt = body.indexOf("if (alias) {");
  assert(exactAt !== -1, "resolveFolderId no longer asks for an exact folder match");
  assert(aliasAt !== -1, "resolveFolderId no longer has an alias branch");
  assert(
    exactAt < aliasAt,
    "the alias branch is jumping the queue again: an exact folder name must win first",
  );
  // And every provider's role reading is behind that one gate, not just IMAP's.
  // Searched from the alias branch onwards, because the reserved-inbox short
  // circuit above legitimately answers with a provider-native value too.
  for (const roleRead of [
    "if (alias.gmail) return alias.gmail;",
    "return alias.outlook;",
    "resolveImapAliasMailbox(",
  ]) {
    assert(
      body.indexOf(roleRead, aliasAt) !== -1,
      `${roleRead} must live in the alias branch, which runs after the exact match`,
    );
  }
});

Deno.test("the reordering costs no extra IMAP round trip", () => {
  // The exact match needs the names, the role match needs the SPECIAL-USE
  // flags, and one LIST carries both. If these two ever come apart, every
  // alias resolution on every IMAP account pays a second LIST.
  const body = codeOnly(functionBody("resolveFolderId"));
  assertStringIncludes(body, "await imapMailboxListing(inbox, opts.session)");
  assertStringIncludes(
    body,
    "mailboxes: imapMailboxes,",
    "resolveImapAliasMailbox must match the listing resolveFolderId already has",
  );
});

Deno.test("the archive create is still gated on the move path alone", () => {
  assertStringIncludes(
    codeOnly(functionBody("resolveFolderId")),
    "createIfMissing: isArchive && !opts.strict",
  );
});

Deno.test("inbox resolves without a listing, because no mailbox can outvote INBOX", () => {
  // RFC 3501 §5.1: INBOX is reserved and case-insensitive, so a mailbox whose
  // whole name is "inbox" IS the inbox. The exact pass would answer the same
  // thing, which is exactly why it is worth skipping: `email_read action: list`
  // defaults its folder here, and this value must not start costing a LIST.
  for (const spelling of ["inbox", "INBOX", "Inbox"]) {
    assertEquals(resolveAsFolderId(spelling, SPAM_AND_JUNK), {
      mailbox: "INBOX",
      how: "reserved",
    });
  }
  const body = codeOnly(functionBody("resolveFolderId"));
  const shortCircuitAt = body.indexOf('if (alias?.aliases[0] === "inbox")');
  const listAt = body.indexOf("await imapMailboxListing(inbox, opts.session)");
  assert(shortCircuitAt !== -1, "the reserved-name short circuit is gone");
  assert(
    shortCircuitAt < listAt,
    "the inbox short circuit must come BEFORE the listing or it saves nothing",
  );
});

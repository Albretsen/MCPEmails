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
  resolveImapAlias,
} from "./imap-folder-target.ts";
import {
  folderAliasAmbiguousMessage,
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
const SENT: CanonicalFolderAlias = lookupCanonicalAlias("sent")!;
const ARCHIVE: CanonicalFolderAlias = lookupCanonicalAlias("archive")!;

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
  opts: { strict?: boolean; forRead?: boolean } = {},
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
    const forRead = opts.forRead === true && opts.strict === true;
    const match = resolveImapAlias(layout, alias, { forRead });
    if (match.kind === "ambiguous") return { mailbox: null, how: "folder_ambiguous" };
    const role = match.kind === "matched" ? match.name : null;
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

// ---------------------------------------------------------------------------
// THE FOURTH PLACE: a role the mailbox HAS, under a name the matcher did not
// know.
//
// ── What went wrong ────────────────────────────────────────────────────────
// Models pass `sent`, `trash`, `junk`, `drafts` and `archive` as a folder, or
// in include_folders, without calling folder_list first (87% of these errors
// had no prior listing). The matcher resolved a role only from a SPECIAL-USE
// flag or from a mailbox named exactly the one English word. Measured over the
// 14 days to 2026-10-02: about 239 folder_not_found errors across 61
// workspaces. Yahoo and iCloud, which flag roles, failed 0.02 to 0.05% of
// searches; generic IMAP 1.2%; Gmail over IMAP 3.4%, where `archive` has no
// mailbox at all.
//
// ── The rule ───────────────────────────────────────────────────────────────
// Exact name first (unchanged), then the flag, then the canonical name, and
// only then the new tiers: the role's other common whole names, the same names
// under "INBOX" + the server's delimiter, and, for READS of `archive` alone,
// the mailbox flagged \\All. Whole names only. Two equal candidates refuse.
// ---------------------------------------------------------------------------

/** A LIST reply entry with the hierarchy delimiter the server reported. */
function listed(name: string, delimiter: string, ...flags: string[]): MailboxListEntry {
  return { name, delimiter, flags };
}

const READ = { strict: true, forRead: true };

/** Gmail over IMAP: every role flagged, and no archive mailbox at all. */
const GMAIL_IMAP: MailboxListEntry[] = [
  listed("INBOX", "/", "\\HasNoChildren"),
  listed("[Gmail]", "/", "\\HasChildren", "\\Noselect"),
  listed("[Gmail]/All Mail", "/", "\\All", "\\HasNoChildren"),
  listed("[Gmail]/Drafts", "/", "\\Drafts", "\\HasNoChildren"),
  listed("[Gmail]/Important", "/", "\\HasNoChildren", "\\Important"),
  listed("[Gmail]/Sent Mail", "/", "\\HasNoChildren", "\\Sent"),
  listed("[Gmail]/Spam", "/", "\\HasNoChildren", "\\Junk"),
  listed("[Gmail]/Starred", "/", "\\Flagged", "\\HasNoChildren"),
  listed("[Gmail]/Trash", "/", "\\HasNoChildren", "\\Trash"),
  listed("Receipts", "/", "\\HasNoChildren"),
];

/** Exchange-style names over IMAP, with no SPECIAL-USE flags at all. */
const OUTLOOK_STYLE: MailboxListEntry[] = [
  listed("INBOX", "/"),
  listed("Drafts", "/"),
  listed("Sent Items", "/"),
  listed("Deleted Items", "/"),
  listed("Junk E-mail", "/"),
  listed("Receipts", "/"),
];

/** Courier / older Dovecot: everything lives under INBOX, "." is the delimiter. */
const COURIER_NAMESPACED: MailboxListEntry[] = [
  listed("INBOX", ".", "\\HasChildren"),
  listed("INBOX.Drafts", "."),
  listed("INBOX.Sent", "."),
  listed("INBOX.Trash", "."),
  listed("INBOX.Junk", "."),
  listed("INBOX.Receipts", "."),
];

Deno.test("table: role aliases resolve on the common unflagged layouts", () => {
  const cases: [string, MailboxListEntry[], string, string][] = [
    // Gmail over IMAP: the flags already did this; pinned so the new tiers
    // cannot outvote a flag.
    ["Gmail IMAP", GMAIL_IMAP, "sent", "[Gmail]/Sent Mail"],
    ["Gmail IMAP", GMAIL_IMAP, "trash", "[Gmail]/Trash"],
    ["Gmail IMAP", GMAIL_IMAP, "spam", "[Gmail]/Spam"],
    ["Gmail IMAP", GMAIL_IMAP, "junk", "[Gmail]/Spam"],
    ["Gmail IMAP", GMAIL_IMAP, "drafts", "[Gmail]/Drafts"],
    // Outlook-style names.
    ["Outlook-style", OUTLOOK_STYLE, "sent", "Sent Items"],
    ["Outlook-style", OUTLOOK_STYLE, "SENT", "Sent Items"],
    ["Outlook-style", OUTLOOK_STYLE, "trash", "Deleted Items"],
    ["Outlook-style", OUTLOOK_STYLE, "deleted", "Deleted Items"],
    ["Outlook-style", OUTLOOK_STYLE, "spam", "Junk E-mail"],
    ["Outlook-style", OUTLOOK_STYLE, "junk", "Junk E-mail"],
    // Namespaced under INBOX with the server's own delimiter.
    ["Courier", COURIER_NAMESPACED, "sent", "INBOX.Sent"],
    ["Courier", COURIER_NAMESPACED, "trash", "INBOX.Trash"],
    ["Courier", COURIER_NAMESPACED, "drafts", "INBOX.Drafts"],
    ["Courier", COURIER_NAMESPACED, "draft", "INBOX.Drafts"],
    ["Courier", COURIER_NAMESPACED, "spam", "INBOX.Junk"],
    ["Courier", COURIER_NAMESPACED, "junk", "INBOX.Junk"],
  ];
  for (const [label, layout, value, want] of cases) {
    // On a read and on a write alike: these tiers are not read-only.
    for (const opts of [READ, { strict: true }, {}]) {
      assertEquals(
        resolveAsFolderId(value, layout, opts),
        { mailbox: want, how: "role" },
        `${label}: "${value}" with ${JSON.stringify(opts)}`,
      );
    }
  }
});

Deno.test("a namespaced alternate name resolves with whichever delimiter LIST reported", () => {
  const slash = [listed("INBOX", "/"), listed("INBOX/Sent Items", "/"), listed("INBOX/Bin", "/")];
  assertEquals(resolveAsFolderId("sent", slash, READ), { mailbox: "INBOX/Sent Items", how: "role" });
  assertEquals(resolveAsFolderId("trash", slash, READ), { mailbox: "INBOX/Bin", how: "role" });
  // The delimiter is the mailbox's own. "INBOX.Sent" on a "/" server is one
  // top-level mailbox whose name happens to contain a dot, not a child of INBOX.
  const wrongDelimiter = [listed("INBOX", "/"), listed("INBOX.Sent", "/")];
  assertEquals(resolveAsFolderId("sent", wrongDelimiter, READ), {
    mailbox: null,
    how: "folder_not_found",
  });
  // And with no delimiter reported at all, the namespaced tiers do not run.
  assertEquals(matchImapAliasMailbox([mailbox("INBOX"), mailbox("INBOX.Sent")], SENT), null);
});

Deno.test("the canonical name still beats an alternate, and the flag still beats both", () => {
  const both = [listed("INBOX", "/"), listed("Sent", "/"), listed("Sent Items", "/")];
  assertEquals(resolveAsFolderId("sent", both, READ), { mailbox: "Sent", how: "exact" });
  assertEquals(resolveImapAlias(both, SENT), { kind: "matched", name: "Sent", how: "canonical_name" });
  const flagged = [...both, listed("Outbox Copies", "/", "\\Sent")];
  assertEquals(resolveImapAlias(flagged, SENT), {
    kind: "matched",
    name: "Outbox Copies",
    how: "special_use",
  });
  // A top-level alternate beats a namespaced canonical: tiers run in order.
  const mixed = [listed("INBOX", "."), listed("Sent Items", "."), listed("INBOX.Sent", ".")];
  assertEquals(resolveImapAlias(mixed, SENT), {
    kind: "matched",
    name: "Sent Items",
    how: "alternate_name",
  });
});

Deno.test("German and French role names resolve, in either Unicode normalization", () => {
  const german = [
    listed("INBOX", "/"),
    listed("Gesendet", "/"),
    listed("Papierkorb", "/"),
    listed("Entwürfe", "/"),
  ];
  assertEquals(resolveAsFolderId("sent", german, READ), { mailbox: "Gesendet", how: "role" });
  assertEquals(resolveAsFolderId("trash", german, READ), { mailbox: "Papierkorb", how: "role" });
  assertEquals(resolveAsFolderId("drafts", german, READ), { mailbox: "Entwürfe", how: "role" });
  // A server (or the client that created the folder) may hand the name back
  // decomposed: "u" + U+0308 instead of the single code point. Same mailbox,
  // and the answer is the server's own spelling, untouched.
  const nfd = "Entwürfe".normalize("NFD");
  assert(nfd !== "Entwürfe", "the fixture must really be decomposed");
  assertEquals(
    resolveAsFolderId("drafts", [listed("INBOX", "/"), listed(nfd, "/")], READ),
    { mailbox: nfd, how: "role" },
  );
  const french = [
    listed("INBOX", "."),
    listed("INBOX.Envoyés", "."),
    listed("INBOX.Corbeille", "."),
    listed("INBOX.Brouillons", "."),
  ];
  assertEquals(resolveAsFolderId("sent", french, READ), { mailbox: "INBOX.Envoyés", how: "role" });
  assertEquals(resolveAsFolderId("trash", french, READ), { mailbox: "INBOX.Corbeille", how: "role" });
  assertEquals(resolveAsFolderId("drafts", french, READ), {
    mailbox: "INBOX.Brouillons",
    how: "role",
  });
});

Deno.test("a mailbox with both Spam and Junk: each name is itself, on every path", () => {
  // The 2026-09-14 Migadu fix, re-run against the new tiers, flagged and
  // unflagged. "Spam" is now also an alternate name for the spam ROLE, and
  // that must never let it stand in for, or be replaced by, "Junk".
  const unflagged = [listed("INBOX", "/"), listed("Junk", "/"), listed("Spam", "/")];
  for (const layout of [SPAM_AND_JUNK, unflagged]) {
    for (const opts of [READ, { strict: true }, {}]) {
      assertEquals(resolveAsFolderId("Spam", layout, opts), { mailbox: "Spam", how: "exact" });
      assertEquals(resolveAsFolderId("spam", layout, opts), { mailbox: "Spam", how: "exact" });
      assertEquals(resolveAsFolderId("Junk", layout, opts), { mailbox: "Junk", how: "exact" });
      assertEquals(resolveAsFolderId("junk", layout, opts), { mailbox: "Junk", how: "exact" });
    }
  }
  // An account with ONLY "Spam" (the Yandex shape) answers both words with it.
  const onlySpam = [listed("INBOX", "/"), listed("Spam", "/")];
  assertEquals(resolveAsFolderId("spam", onlySpam), { mailbox: "Spam", how: "exact" });
  assertEquals(resolveAsFolderId("junk", onlySpam), { mailbox: "Spam", how: "role" });
});

Deno.test("a user folder literally named Archive wins over every role reading, All Mail included", () => {
  const layout = [...GMAIL_IMAP, listed("Archive", "/", "\\HasNoChildren")];
  for (const opts of [READ, { strict: true }, {}]) {
    assertEquals(resolveAsFolderId("archive", layout, opts), { mailbox: "Archive", how: "exact" });
    assertEquals(resolveAsFolderId("Archive", layout, opts), { mailbox: "Archive", how: "exact" });
  }
});

Deno.test("READ: archive on Gmail over IMAP is the mailbox flagged \\All", () => {
  assertEquals(resolveAsFolderId("archive", GMAIL_IMAP, READ), {
    mailbox: "[Gmail]/All Mail",
    how: "role",
  });
  assertEquals(resolveImapAlias(GMAIL_IMAP, ARCHIVE, { forRead: true }), {
    kind: "matched",
    name: "[Gmail]/All Mail",
    how: "all_mail",
  });
  // Found by the FLAG, so a localized account ("[Google Mail]/Alle Nachrichten")
  // works the same way and nothing depends on the English name.
  const localized = [
    listed("INBOX", "/"),
    listed("[Google Mail]/Alle Nachrichten", "/", "\\All"),
  ];
  assertEquals(resolveAsFolderId("archive", localized, READ), {
    mailbox: "[Google Mail]/Alle Nachrichten",
    how: "role",
  });
  // A real archive, flagged or named, is still preferred over All Mail.
  const withArchive = [...GMAIL_IMAP, listed("Old Mail", "/", "\\Archive")];
  assertEquals(resolveAsFolderId("archive", withArchive, READ), { mailbox: "Old Mail", how: "role" });
  const withArchives = [...GMAIL_IMAP, listed("Archives", "/")];
  assertEquals(resolveAsFolderId("archive", withArchives, READ), {
    mailbox: "Archives",
    how: "role",
  });
});

Deno.test("WRITE PROOF: a move to archive on that same mailbox behaves exactly as before", () => {
  // Moving a message into All Mail is not archiving on Gmail (archiving there
  // is removing it from INBOX), so the \\All fallback must be unreachable from
  // every destination path. Each line below is the pre-existing answer.
  //
  // The move/copy path (non-strict): no archive, so one is created.
  assertEquals(resolveAsFolderId("archive", GMAIL_IMAP), { mailbox: "Archive", how: "created" });
  assertEquals(resolveAsFolderId("archive", GMAIL_IMAP, {}), { mailbox: "Archive", how: "created" });
  // The automation runner's destination resolve: strict, and NOT a read. It
  // must still report that the listing has no such folder.
  assertEquals(resolveAsFolderId("archive", GMAIL_IMAP, { strict: true }), {
    mailbox: null,
    how: "folder_not_found",
  });
  // forRead without strict is not a read either: nothing may half-opt in.
  assertEquals(resolveAsFolderId("archive", GMAIL_IMAP, { forRead: true }), {
    mailbox: "Archive",
    how: "created",
  });
  // The callers that pick a destination on their own connection
  // (imapArchiveEmail, resolveImapTrashMailbox, the drafts paths).
  assertEquals(matchImapAliasMailbox(GMAIL_IMAP, ARCHIVE), null);
  assertEquals(resolveImapAlias(GMAIL_IMAP, ARCHIVE), { kind: "none" });
  assertEquals(resolveImapAlias(GMAIL_IMAP, ARCHIVE, { forRead: false }), { kind: "none" });
  // And no OTHER role ever reads as All Mail, even on a read.
  const onlyAll = [listed("INBOX", "/"), listed("Everything", "/", "\\All")];
  for (const token of ["sent", "trash", "spam", "drafts"]) {
    assertEquals(resolveAsFolderId(token, onlyAll, READ), {
      mailbox: null,
      how: "folder_not_found",
    });
  }
});

Deno.test("WRITE PROOF, wiring: only the two read call sites ask for the read-only fallback", () => {
  // The harness above mirrors resolveFolderId; this pins that index.ts is the
  // same shape, and that no destination resolve can reach All Mail.
  const resolver = codeOnly(functionBody("resolveFolderId"));
  assertStringIncludes(
    resolver,
    "const forRead = opts.forRead === true && opts.strict === true;",
    "the fallback must need BOTH an explicit read and a strict resolve",
  );
  assertStringIncludes(resolver, "resolveImapAlias(imapMailboxes ?? [], alias, { forRead })");

  const optIns = CODE.split("forRead: true").length - 1;
  assertEquals(optIns, 2, "exactly two call sites may opt in to the read-only fallback");
  assertStringIncludes(codeOnly(functionBody("executeListInbox")), "forRead: true");
  assertStringIncludes(codeOnly(functionBody("resolveIncludeFolders")), "forRead: true");

  // Every function that resolves a DESTINATION, by name, and the runner's
  // resolveFolder, which is strict but writes.
  for (
    const name of [
      "executeMoveEmail",
      "executeCopyEmail",
      "imapArchiveEmail",
      "resolveImapTrashMailbox",
      "imapMoveEmail",
      "imapCopyEmail",
    ]
  ) {
    assert(
      !codeOnly(functionBody(name)).includes("forRead"),
      `${name} picks a destination and must never ask for the read-only fallback`,
    );
  }
  const runnerResolve = CODE.slice(CODE.indexOf("async resolveFolder(inbox, nameOrId, session)"));
  const runnerBody = runnerResolve.slice(0, runnerResolve.indexOf("applyAction: applyTriageAction"));
  assert(runnerBody.length > 0, "the runner's resolveFolder moved; re-anchor this scan");
  assert(
    !runnerBody.includes("forRead"),
    "an automation's move destination must never resolve to All Mail",
  );
});

Deno.test("two equal candidates are refused, never guessed, on reads and writes alike", () => {
  const twoSent = [
    listed("INBOX", "/"),
    listed("Sent Items", "/"),
    listed("Sent Messages", "/"),
  ];
  assertEquals(resolveImapAlias(twoSent, SENT), {
    kind: "ambiguous",
    candidates: ["Sent Items", "Sent Messages"],
  });
  for (const opts of [READ, { strict: true }, {}]) {
    assertEquals(resolveAsFolderId("sent", twoSent, opts), {
      mailbox: null,
      how: "folder_ambiguous",
    });
  }
  // The destination pickers answer "no match" and create the canonical
  // mailbox, as they did before these names were known at all.
  assertEquals(matchImapAliasMailbox(twoSent, SENT), null);
  // Either name, typed exactly, is still that mailbox.
  assertEquals(resolveAsFolderId("Sent Items", twoSent), { mailbox: "Sent Items", how: "exact" });

  // The same at the namespaced tier.
  const twoTrash = [
    listed("INBOX", "."),
    listed("INBOX.Deleted Items", "."),
    listed("INBOX.Bin", "."),
  ];
  assertEquals(resolveAsFolderId("trash", twoTrash, READ), {
    mailbox: null,
    how: "folder_ambiguous",
  });

  // And the refusal names both, so the next call can pass one of them.
  const message = folderAliasAmbiguousMessage("sent", ["Sent Items", "Sent Messages"], {
    provider: "imap",
  });
  assertStringIncludes(message, '"Sent Items" and "Sent Messages"');
  assertStringIncludes(message, "Nothing was changed.");
});

Deno.test("a \\Noselect or \\NonExistent name is never the answer", () => {
  // A hierarchy parent is a NAME, not a mailbox: it cannot be selected,
  // searched or written to. Resolving to it only moves the failure later.
  const parents = [
    listed("INBOX", "/"),
    listed("Sent Items", "/", "\\Noselect", "\\HasChildren"),
    listed("Sent Items/2024", "/", "\\HasNoChildren"),
    listed("Deleted Items", "/", "\\NonExistent"),
    listed("Junk", "/", "\\Noselect"),
    listed("Old", "/", "\\Noselect", "\\Trash"),
    listed("Everything", "/", "\\Noselect", "\\All"),
  ];
  assertEquals(resolveImapAlias(parents, SENT), { kind: "none" });
  assertEquals(resolveImapAlias(parents, TRASH), { kind: "none" });
  assertEquals(resolveImapAlias(parents, lookupCanonicalAlias("spam")!), { kind: "none" });
  assertEquals(resolveImapAlias(parents, ARCHIVE, { forRead: true }), { kind: "none" });
  // And it does not count as a second candidate either: one selectable
  // "Sent Messages" beside an unselectable "Sent Items" is not ambiguous.
  const one = [...parents, listed("Sent Messages", "/")];
  assertEquals(resolveImapAlias(one, SENT), {
    kind: "matched",
    name: "Sent Messages",
    how: "alternate_name",
  });
});

Deno.test("the new tiers match WHOLE names: no suffix, no segment, no substring", () => {
  // The soft-delete guard, restated for every name the matcher now knows.
  // None of these is the account's trash or sent folder.
  const layout = [
    listed("INBOX", "."),
    listed("Projects.Deleted Items", "."),
    listed("Projects.Bin", "."),
    listed("INBOX.Projects.Trash", "."),
    listed("INBOX.Projects.Sent Items", "."),
    listed("INBOX.Trashcan", "."),
    listed("INBOX.Binders", "."),
    listed("Old Sent Items", "."),
    listed("Sent Items (2019)", "."),
    listed("Recycle Bin", "."),
    listed("NOTINBOX.Trash", "."),
    listed("INBOX.", "."),
  ];
  assertEquals(resolveImapAlias(layout, TRASH), { kind: "none" });
  assertEquals(resolveImapAlias(layout, SENT), { kind: "none" });
  assertEquals(matchImapAliasMailbox(layout, TRASH), null);
});

Deno.test("an unmatched alias still fails exactly as it did", () => {
  const bare = [listed("INBOX", "/"), listed("Receipts", "/")];
  assertEquals(resolveAsFolderId("sent", bare, READ), { mailbox: null, how: "folder_not_found" });
  assertEquals(resolveAsFolderId("sent", bare), { mailbox: "Sent", how: "static_fallback" });
  assertEquals(resolveAsFolderId("archive", bare, READ), { mailbox: null, how: "folder_not_found" });
});

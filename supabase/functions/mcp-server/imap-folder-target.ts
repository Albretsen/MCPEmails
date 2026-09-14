// ---------------------------------------------------------------------------
// imap-folder-target.ts - which mailbox an IMAP operation actually opens.
//
// ── The bug this exists to fix ─────────────────────────────────────────────
// An IMAP message id is "<folder>:<uid>" and the folder half is MINTED BY US
// from a name the server itself reported (encodeImapId is only ever called with
// a mailbox that came back from LIST, from resolveFolderId, or from the SELECT
// that produced the UID). Thirteen call sites nonetheless pushed that name back
// through `imapFolderName`, a static alias-table lookup, before SELECTing it:
//
//   imapFolderName("Spam")    === "Junk"     ← the reported bug
//   imapFolderName("Draft")   === "Drafts"
//   imapFolderName("Deleted") === "Trash"
//   imapFolderName("trash")   === "Trash"
//
// So a Yandex account, whose spam mailbox is literally named "Spam" and which
// has no "Junk" at all, could list its spam fine and then fail every read,
// reply, flag, move, copy and delete of those messages with
// "Mailbox not found: Junk". The server told us the name; we overwrote it with
// a guess about what the name ought to be.
//
// The same second mapping was removed from the search path earlier (see the
// "must not alias-map folder names a second time" scan in
// search-phase-wiring.test.ts) and from the draft path before that (see
// imapUpdateDraft's comment in index.ts). This module is where that rule now
// lives once, for every caller.
//
// ── Why the folder half of an id is treated as OPAQUE ──────────────────────
// {@link imapMailboxForServerFolder} returns the name VERBATIM and never
// consults the alias table. The cost of that is a hand-crafted id like
// "spam:5", built from an alias word instead of from folder_list output: it
// used to work by accident on a server whose mailbox happens to be named
// "Junk", and now it fails with "Mailbox not found: spam". That trade is
// deliberate, and the reasons are in priority order:
//
//   1. A UID is unique only WITHIN a mailbox. Resolving an unmatched folder
//      token to some other mailbox does not find the caller's message — it
//      re-points their UID at a different, unrelated message. On email_delete
//      and email_move that silently destroys or relocates mail nobody asked
//      about. Refusing is not a worse outcome than that; it is the only safe
//      one.
//   2. The accident was never dependable anyway. "spam:5" only ever resolved
//      when the account's mailbox happened to carry the alias table's English
//      default, which is exactly the coin flip that broke Yandex. Keeping it as
//      a fallback would enshrine the coin flip instead of removing it.
//   3. The failure is already legible and already recoverable: ImapClient
//      raises "Mailbox not found: <the literal we tried>", and folder_list
//      returns the server's real names to build a correct id from. Alias words
//      still work everywhere they are a user-facing ARGUMENT (email_list's
//      `folder`, a move destination): those go through resolveFolderId, which
//      resolves against the account's REAL layout rather than a fixed name.
//   4. The "just retry with the alias on failure" variant is not free either.
//      A command that failed mid-exchange may have left the socket
//      desynchronised — the reason resolveImapAliasMailbox invalidates a
//      borrowed session after a throw — so a second SELECT on that same
//      connection is precisely what that rule warns against.
//
// Everything here is PURE (no I/O, no client), which is the usual reason for a
// module in this directory: index.ts calls `Deno.serve` at load and cannot be
// imported by a test, so a decision that only lives there can be pinned by a
// source scan and nothing more. The decisions below are run for real in
// imap-folder-target.test.ts; the source scan only pins the wiring.
// ---------------------------------------------------------------------------

/**
 * Single source of truth mapping a canonical folder alias to each provider's
 * native value. Every provider-specific folder map (`outlookWellKnownFolder`,
 * `imapFolderName`) and the cross-provider `resolveFolderId` helper derive from
 * this table — keep this the only place provider folder vocabulary lives.
 *
 * - `gmail`: system label ID (e.g. "INBOX", "TRASH"). Gmail has no system
 *   "archive" label — archiving means removing the INBOX label — so the
 *   `archive` alias has no Gmail value (`null`); resolveFolderId falls through
 *   to listing / pass-through, and email_archive handles the real archive op.
 * - `outlook`: Graph well-known folder name (e.g. "inbox", "deleteditems").
 * - `fastmail`: JMAP mailbox `role`; resolved to a concrete mailbox id at
 *   runtime via the folder list (no static id exists).
 * - `imap`: common mailbox name; for IMAP the name *is* the id.
 *
 * `aliases` lists every accepted user-facing token (case-insensitive) for the
 * canonical entry, including the legacy UPPER canonical names used by callers.
 */
export interface CanonicalFolderAlias {
  /** Accepted user-facing tokens (matched case-insensitively). */
  aliases: string[];
  /** Gmail system label ID, or null when no system label exists (archive). */
  gmail: string | null;
  /** Microsoft Graph well-known folder name. */
  outlook: string;
  /** Common IMAP mailbox name (the name is the id). */
  imap: string;
}

export const CANONICAL_FOLDER_ALIASES: CanonicalFolderAlias[] = [
  { aliases: ["inbox"], gmail: "INBOX", outlook: "inbox", imap: "INBOX" },
  { aliases: ["sent"], gmail: "SENT", outlook: "sentitems", imap: "Sent" },
  { aliases: ["drafts", "draft"], gmail: "DRAFT", outlook: "drafts", imap: "Drafts" },
  { aliases: ["trash", "deleted"], gmail: "TRASH", outlook: "deleteditems", imap: "Trash" },
  { aliases: ["archive"], gmail: null, outlook: "archive", imap: "Archive" },
  { aliases: ["spam", "junk"], gmail: "SPAM", outlook: "junkemail", imap: "Junk" },
];

/** Case-insensitive lookup of a canonical alias entry by any of its tokens. */
export function lookupCanonicalAlias(
  token: string,
): CanonicalFolderAlias | undefined {
  const lower = token.trim().toLowerCase();
  return CANONICAL_FOLDER_ALIASES.find((e) => e.aliases.includes(lower));
}

/**
 * Maps a canonical folder alias (matched by its first token) to the IMAP
 * SPECIAL-USE attribute flag a mailbox advertises for that role (RFC 6154),
 * lower-cased for case-insensitive comparison against LIST flags.
 *
 * Used to resolve aliases ("archive", "trash", …) against the server's ACTUAL
 * mailbox layout instead of assuming a fixed English name like "Archive" — the
 * generic-IMAP move bug where "archive" hard-resolved to a non-existent
 * "Archive" mailbox. "inbox" has no SPECIAL-USE flag (it is always the reserved
 * name "INBOX"), so it is intentionally absent.
 */
export const IMAP_ALIAS_SPECIAL_USE: Record<string, string> = {
  archive: "\\archive",
  sent: "\\sent",
  drafts: "\\drafts",
  trash: "\\trash",
  spam: "\\junk",
};

/**
 * The part of an `ImapMailboxInfo` this module needs. Structural on purpose, so
 * the matcher stays free of any dependency on the client (and so a test can
 * hand it a two-field layout fixture).
 */
export interface MailboxListEntry {
  name: string;
  flags: string[];
}

/**
 * Match a canonical folder alias against an already-fetched IMAP mailbox list.
 * Pure (no I/O) so it can be shared by callers that own a connection. Matches:
 *   1. "inbox" → always the reserved name "INBOX".
 *   2. SPECIAL-USE flag match (\\Archive, \\Trash, \\Sent, \\Drafts, \\Junk).
 *   3. Case-insensitive match against the canonical English name (e.g.
 *      a mailbox literally named "Archive").
 * Returns null when nothing matches.
 *
 * Step (3) is a match on the WHOLE name, never on a path segment or a suffix,
 * and that is load-bearing rather than incidental: this matcher chooses the
 * destination of a soft DELETE. A user's own "Projects/Trash" or
 * "Archive/2019/Trash" must not become the account's trash can because its last
 * segment reads "Trash". Only a mailbox the SERVER flags \\Trash, or one whose
 * entire name is "Trash", may win. Do not loosen this to endsWith().
 */
export function matchImapAliasMailbox(
  mailboxes: MailboxListEntry[],
  alias: CanonicalFolderAlias,
): string | null {
  const canonicalToken = alias.aliases[0];
  if (canonicalToken === "inbox") return "INBOX";

  // (2) SPECIAL-USE flag match.
  const wantFlag = IMAP_ALIAS_SPECIAL_USE[canonicalToken];
  if (wantFlag) {
    const bySpecialUse = mailboxes.find((mb) =>
      mb.flags.some((f) => f.toLowerCase() === wantFlag)
    );
    if (bySpecialUse) return bySpecialUse.name;
  }

  // (3) Case-insensitive match against the canonical English name.
  const wantName = alias.imap.toLowerCase();
  const byName = mailboxes.find((mb) => mb.name.toLowerCase() === wantName);
  if (byName) return byName.name;

  return null;
}

/**
 * The mailbox to SELECT for a folder name that ALREADY CAME FROM THE SERVER:
 * the folder half of an id decoded by `decodeImapId`, or a name resolveFolderId
 * has already matched against the account's real layout.
 *
 * It returns the name verbatim. The whole point is that it does NOT re-run the
 * alias table over a name the server gave us — see this file's header for why
 * "Spam" must stay "Spam" and why a hand-crafted "spam:5" is allowed to fail
 * instead of being quietly aimed at some other mailbox's UID 5.
 *
 * It exists as a named function rather than as nothing at all so the rule has
 * one place to be read, one place to be tested, and one token
 * ("imapMailboxForServerFolder") that a source scan can pin at every call site
 * — the previous shape of this code, `selectMailbox(imapFolderName(folder))`,
 * looked deliberate at all thirteen of them.
 */
export function imapMailboxForServerFolder(folder: string): string {
  return folder;
}

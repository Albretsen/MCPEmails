// ---------------------------------------------------------------------------
// email_search latency fixes, 2026-10-15.
//
// From the tools/call log line that day: IMAP searches of roughly 5 to 10
// folders were 27% of email_search calls and 54% of its wall time, and every
// IMAP call spent about 1.75s connecting before its first command. Four
// changes, each pinned here:
//
//   1. include_folders is resolved with ONE LIST, not one per entry.
//   2. Folder resolution runs inside email_search's 30-second race, not before
//      it, and still answers its failures exactly as it did.
//   3. A multi-folder email_search checks the clock between folders and returns
//      the folders it covered, with a note naming the rest, instead of running
//      into the timer. search_and_move / search_and_delete never do: they act
//      on the result set and a partial one is not theirs to act on.
//   4. (Removed.) An MCP IMAP connection pool shipped with these and was taken
//      out the same night: nearly one isolate per call meant 5.8% reuse, and
//      idle pooled connections tripped Yahoo's 5-connection cap. The last test
//      below pins that it stays out.
//
// The handlers live in index.ts, which calls `Deno.serve` at load and exports
// nothing, so their wiring is pinned by source scan, as search-phase-wiring.ts
// does. The budget rule is run for real.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  hasTimeForNextFolder,
  IMAP_FOLDER_ESTIMATE_PADDING,
  IMAP_SEARCH_FINISH_RESERVE_MS,
  imapSearchStoppedEarlyNote,
} from "./imap-search-budget.ts";

const INDEX_SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const CLIENT_SOURCE = await Deno.readTextFile(new URL("./imap-client.ts", import.meta.url));

function functionSource(name: string): string {
  const start = INDEX_SOURCE.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found in index.ts`);
  const end = INDEX_SOURCE.indexOf("\n}\n", start);
  assert(end > start, `${name} has no closing brace in index.ts`);
  return INDEX_SOURCE.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. One LIST for the whole include_folders list.
// ---------------------------------------------------------------------------

Deno.test("include_folders: one LIST for every entry, handed to each resolve", () => {
  const body = functionSource("resolveIncludeFolders");
  assertEquals(body.split("imapMailboxListing(").length - 1, 1, "exactly one LIST call site");
  assert(
    body.indexOf("imapMailboxes === undefined") < body.indexOf("imapMailboxListing("),
    "the LIST is taken once, on the first entry that needs it",
  );
  assertStringIncludes(body, "{ strict: true, session, forRead: true, imapMailboxes }");
  // resolveFolderId uses the listing it is handed instead of making its own.
  assertStringIncludes(
    functionSource("resolveFolderId"),
    "opts.imapMailboxes ?? await imapMailboxListing(inbox, opts.session)",
  );
});

// ---------------------------------------------------------------------------
// 2. Resolution inside the race, failures answered as before.
// ---------------------------------------------------------------------------

Deno.test("email_search resolves include_folders inside the timeout race", () => {
  const body = functionSource("executeSearchEmails");
  const thunkAt = body.indexOf("const startSearch = async ()");
  const resolveAt = body.indexOf("resolveIncludeFolders(inbox, includeFolders, session)");
  const raceAt = body.indexOf("raceSearchWithTimeout(");
  assert(thunkAt > 0 && resolveAt > thunkAt, "resolution happens inside the thunk the race starts");
  assert(raceAt > resolveAt, "the race starts that thunk");
  assertStringIncludes(body, "throw new IncludeFoldersFailure(err)");
});

Deno.test("a resolution failure is answered exactly as it was before it moved", () => {
  const body = functionSource("executeSearchEmails");
  const failureAt = body.indexOf("if (err instanceof IncludeFoldersFailure)");
  const timeoutAt = body.indexOf('if (message === "search_timeout")');
  assert(failureAt > 0 && failureAt < timeoutAt, "checked first, before any provider classification");
  const branch = body.slice(failureAt, timeoutAt);
  assertStringIncludes(branch, "if (cause instanceof FolderTargetError) return folderTargetErrorResult(cause);");
  assertStringIncludes(branch, "return authFailedResult(inbox.provider, inbox.id, \"access\");");
  assertStringIncludes(branch, "throw cause;");
  for (const sentinel of ["gmail_auth_failed", "outlook_auth_failed", "fastmail_auth_failed", "imap_auth_failed"]) {
    assertStringIncludes(branch, `"${sentinel}"`);
  }
});

// ---------------------------------------------------------------------------
// 3. The budget between folders.
// ---------------------------------------------------------------------------

Deno.test("budget: the first folder always runs", () => {
  assert(hasTimeForNextFolder(0, []));
  assert(hasTimeForNextFolder(-5_000, []));
});

Deno.test("budget: another folder runs only if the slowest so far, padded, still fits", () => {
  const slowest = 4_000;
  const needed = slowest * IMAP_FOLDER_ESTIMATE_PADDING + IMAP_SEARCH_FINISH_RESERVE_MS;
  assert(hasTimeForNextFolder(needed, [1_000, slowest, 2_000]));
  assert(!hasTimeForNextFolder(needed - 1, [1_000, slowest, 2_000]));
  // Fast folders and plenty of time: never stops, so a quick search is untouched.
  assert(hasTimeForNextFolder(25_000, [300, 450, 200, 380, 410, 290, 330, 360]));
});

Deno.test("budget: the note names what was searched AND what was not", () => {
  const note = imapSearchStoppedEarlyNote(["INBOX", "Archive"], ["Sent", "Receipts"]);
  assertStringIncludes(note, "include_folders listed 4 folders");
  assertStringIncludes(note, "covered 2 of them: INBOX, Archive");
  assertStringIncludes(note, "NOT searched: Sent, Receipts");
  assertStringIncludes(note, "`total` counts only the folders searched");
});

Deno.test("only email_search hands the IMAP search a deadline", () => {
  const search = functionSource("searchImapMessages");
  assertStringIncludes(search, "deadlineAtMs?: number,");
  assertStringIncludes(search, "deadlineAtMs !== undefined &&");
  assertStringIncludes(search, "notes: [imapSearchStoppedEarlyNote(searchedFolders, skippedFolders)]");
  // The note appears only when something was skipped.
  assertStringIncludes(search, "skippedFolders.length > 0");

  assertStringIncludes(functionSource("executeSearchEmails"), "deadlineAtMs,\n          );");
  // The mutating tools act on the result set: no deadline, so never partial.
  for (const name of ["executeSearchAndMove", "executeSearchAndDelete"]) {
    const body = functionSource(name);
    assert(!body.includes("deadlineAtMs"), `${name} must not get a partial result set`);
  }
});

// ---------------------------------------------------------------------------
// 4. No MCP connection pool.
// ---------------------------------------------------------------------------

Deno.test("no MCP pool: ImapClient.connect only ever takes client-api's hook", () => {
  assertStringIncludes(CLIENT_SOURCE, "const pooled = firstPartyContext.getStore()?.imapConnect;");
  for (const source of [CLIENT_SOURCE, INDEX_SOURCE]) {
    assert(!source.includes("mcp-imap-pool"), "the MCP pool module must not come back");
    assert(!source.includes("mcpImapPoolStore"), "no pool scope around the MCP executor");
  }
});

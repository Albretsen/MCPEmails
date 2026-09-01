// ---------------------------------------------------------------------------
// Search-phase wiring: cancellation, connection reuse, and the second FETCH.
//
// ── What went wrong ────────────────────────────────────────────────────────
// Thirty days of production said email_search_and_move timed out on 13.4% of
// its Yahoo calls (31 of 232) and email_search_and_delete on 24.1% (7 of 29),
// while plain email_search over the SAME accounts, running the same search
// function, timed out on 0.80% (11 of 1380). Three causes, all of them in the
// wiring rather than in the search:
//
//   1. The two mutating tools gave the search 17 seconds and the read tool gave
//      it 30, because `budget.searchPhaseMs(SEARCH_TIMEOUT_MS)` never once let
//      that 30s ceiling bind. Fixed in bulk-budget.ts, asserted there.
//   2. The timeout did not cancel anything. `Promise.race` abandons the loser,
//      so the socket carried on with a UID SEARCH or UID FETCH nobody would
//      read, and every polite way out of the session queues behind it. Plain
//      email_search timeouts cluster at 30137 to 30166 ms; search_and_move
//      against a 17000 ms budget spread out to 36175 ms.
//   3. The single-folder case, which is what both mutating tools run every
//      time, fetched the same envelopes twice and downloaded a 2 KB body
//      prefix per message for a `preview` field neither of them reads.
//
// ── Why half of this is a source scan ──────────────────────────────────────
// index.ts calls `Deno.serve` at module load and exports nothing, so a test
// cannot import a handler and run it. That is a standing constraint here, not a
// choice made for this change; see the notes at the top of
// mcp-app-approvals.test.ts and the source-scanning guards in
// provider-error.test.ts, which pin the error taxonomy the same way.
//
// So the split is deliberate. The BEHAVIOUR of the cancellation primitive is
// tested for real below, on the real ImapSession with a client that hangs
// exactly the way a timed-out UID FETCH hangs. The source scan then pins that
// each handler wires up those same pieces, in the right order, with the right
// arguments. Neither half is worth much alone.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { ImapSession } from "./imap-session.ts";
import { raceSearchWithTimeout } from "./bulk-budget.ts";

// ---------------------------------------------------------------------------
// Behaviour: the three pieces a handler wires together.
// ---------------------------------------------------------------------------

/**
 * A client whose FETCH never answers, which is the state a timed-out search
 * leaves a real connection in.
 *
 * `logout()` models the property that made the polite path useless: a LOGOUT is
 * an ordinary IMAP command, so on a socket that already owes an answer it
 * queues behind that answer and resolves when it does, which here is never.
 * A test that ends up calling it therefore HANGS rather than quietly passing,
 * which is the correct outcome for a regression that reintroduces it.
 */
class HangingImapClient {
  destroyCount = 0;
  logoutCount = 0;
  selected: string | null = null;
  #pending = 0;

  get busy(): boolean {
    return this.#pending > 0;
  }

  selectMailbox(mailbox: string): Promise<void> {
    this.selected = mailbox;
    return Promise.resolve();
  }

  /** Issued, never answered. */
  fetchSummaries(): Promise<never> {
    this.#pending++;
    return new Promise<never>(() => {});
  }

  logout(): Promise<void> {
    this.logoutCount++;
    if (this.busy) return new Promise<void>(() => {});
    return Promise.resolve();
  }

  destroy(): void {
    this.destroyCount++;
    // A destroyed socket owes nothing to anyone.
    this.#pending = 0;
  }
}

Deno.test("a hung search is cut off by abort, not left waiting on a LOGOUT", async () => {
  // This is the handler's shape, with nothing stubbed but the socket: open a
  // session, run the search inside raceSearchWithTimeout with abort as the
  // cancel, and close the session in the finally.
  const client = new HangingImapClient();
  const session = new ImapSession(() => Promise.resolve(client));
  const startedAt = Date.now();

  try {
    await assertRejects(
      () =>
        raceSearchWithTimeout(
          async () => {
            const c = await session.select("INBOX");
            return await c.fetchSummaries();
          },
          50,
          () => session.abort(),
        ),
      Error,
      "search_timeout",
    );
  } finally {
    await session.close();
  }

  const elapsed = Date.now() - startedAt;
  assertEquals(client.destroyCount, 1, "the socket must be destroyed");
  assertEquals(
    client.logoutCount,
    0,
    "a LOGOUT here queues behind the abandoned FETCH, which is the 19 seconds this change removes",
  );
  assert(elapsed < 550, `the handler returned ${elapsed}ms after a 50ms deadline`);
});

Deno.test("abort leaves the session usable and the dead client unreachable", async () => {
  // `abort()` is non-terminal on purpose: the act phase of a search_and_* call
  // may still have work to do, and it must never be handed the socket that was
  // just killed. A session that returned the destroyed client would move mail
  // over a dead connection.
  const first = new HangingImapClient();
  const second = new HangingImapClient();
  const clients = [first, second];
  const session = new ImapSession(() => Promise.resolve(clients.shift()!));

  await session.select("INBOX");
  session.abort();

  assertEquals(first.destroyCount, 1);
  const next = await session.client();
  assert(next === second, "the aborted client must never be handed out again");
  assertEquals(session.connectCount, 2, "a fresh connection, because the first was killed");
  await session.close();
  assertEquals(second.logoutCount, 1, "an idle connection is still returned politely");
});

Deno.test("aborting twice, and closing after an abort, are both no-ops", async () => {
  // The handler's finally runs after the timeout branch has already aborted, so
  // this is the ordinary path, not an edge case.
  const client = new HangingImapClient();
  const session = new ImapSession(() => Promise.resolve(client));
  await session.select("INBOX");

  session.abort();
  session.abort();
  await session.close();

  assertEquals(client.destroyCount, 1);
  assertEquals(client.logoutCount, 0);
});

// ---------------------------------------------------------------------------
// Source scan: the handlers wire up exactly those pieces.
// ---------------------------------------------------------------------------

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

/** The body of one top-level `async function`, up to its column-0 brace. */
function functionSource(name: string): string {
  const start = INDEX_SOURCE.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found in index.ts`);
  const end = INDEX_SOURCE.indexOf("\n}\n", start);
  assert(end > start, `${name} has no closing brace in index.ts`);
  return INDEX_SOURCE.slice(start, end);
}

const SEARCH_HANDLERS = [
  "executeSearchEmails",
  "executeSearchAndMove",
  "executeSearchAndDelete",
] as const;

Deno.test("every search timeout cancels the connection it stopped waiting on", () => {
  for (const name of SEARCH_HANDLERS) {
    const body = functionSource(name);
    assertStringIncludes(
      body,
      "raceSearchWithTimeout(",
      `${name} must bound its search through the cancelling helper`,
    );
    assertStringIncludes(
      body,
      "session ? () => session.abort() : null",
      `${name} must hand the helper something to cancel on IMAP`,
    );
    assert(
      !body.includes("await Promise.race("),
      `${name} still races its search, which abandons the loser instead of cancelling it`,
    );
  }
});

Deno.test("every search handler owns the session it aborts, and closes it", () => {
  // The email_search leak was precisely this: searchImapMessages created the
  // session, so the handler had no handle on it, returned on timeout, and left
  // the connection to be reclaimed by the provider's idle timeout, or by the
  // isolate being recycled with the socket still open.
  for (const name of SEARCH_HANDLERS) {
    const body = functionSource(name);
    assertStringIncludes(body, "const session = imapSessionFor(inbox);", name);
    assertStringIncludes(body, "if (session) await session.close();", name);
    assert(
      body.indexOf("} finally {") > body.indexOf("const session = imapSessionFor(inbox);"),
      `${name} must close its session from a finally that covers every return`,
    );
  }
});

Deno.test("the session is opened BEFORE any folder is resolved, not after", () => {
  // resolveFolderId on IMAP is a LIST, and a LIST used to cost its own connect,
  // AUTH and LOGOUT. In executeSearchAndMove it ran ahead of the session
  // entirely, so the call paid two handshakes and held two of Yahoo's five
  // per-account slots while claiming, in a comment, to have removed the second.
  const move = functionSource("executeSearchAndMove");
  const sessionAt = move.indexOf("const session = imapSessionFor(inbox);");
  const destinationAt = move.indexOf("await resolveFolderId(inbox, destinationFolderId");
  assert(destinationAt > 0, "the destination resolve moved or was renamed");
  assert(
    sessionAt < destinationAt,
    "the destination resolve must run on the session, so the session must exist first",
  );
  assertStringIncludes(
    move,
    "await resolveFolderId(inbox, destinationFolderId, { session })",
    "the destination resolve must borrow the connection rather than open one",
  );

  for (const name of SEARCH_HANDLERS) {
    const body = functionSource(name);
    const includeAt = body.indexOf("resolveIncludeFolders(inbox, includeFolders, session)");
    assert(includeAt > 0, `${name} must resolve include_folders through the shared helper`);
    assert(
      body.indexOf("const session = imapSessionFor(inbox);") < includeAt,
      `${name} resolves include_folders before it has a connection to do it on`,
    );
  }
});

Deno.test("include_folders means the same thing in all three tools", () => {
  // It did not. email_search resolved every entry strictly and the two mutating
  // tools passed the raw token to the provider, so the same typo was a named
  // `folder_not_found` in one and an opaque provider line in the others. The
  // strict resolution is the one worth keeping, and it is now the only one.
  assertStringIncludes(
    functionSource("resolveIncludeFolders"),
    "{ strict: true, session }",
  );
  for (const name of SEARCH_HANDLERS) {
    assertStringIncludes(
      functionSource(name),
      "if (err instanceof FolderTargetError) return folderTargetErrorResult(err);",
      `${name} must render an unmatched folder as folder_not_found`,
    );
  }
  // And the second mapping is gone: searchImapMessages takes resolved mailbox
  // names now, so a mailbox literally called "Archive" cannot be alias-remapped
  // onto whichever other mailbox carries the \\Archive special-use flag.
  const search = functionSource("searchImapMessages");
  assert(
    // The call, not the parameter doc that explains why it is gone.
    !search.includes("imapFolderName("),
    "searchImapMessages must not alias-map folder names a second time",
  );
});

Deno.test("only the tool that returns a preview pays for one", () => {
  // search_and_move and search_and_delete reduce the result to
  // `messages.map((m) => m.id)`, and the MCP Apps plan sample reads only from,
  // subject and date. At their default limit of 500 the discarded body prefixes
  // were roughly a megabyte, fetched inside the phase that was timing out.
  const imapCall = /searchImapMessages\(\s*inbox,\s*search,\s*limit,\s*([^,]+),\s*(\w+),\s*(true|false),/g;
  const found = new Map<string, string>();
  for (const name of SEARCH_HANDLERS) {
    const body = functionSource(name);
    const match = imapCall.exec(body) ?? new RegExp(imapCall.source).exec(body);
    imapCall.lastIndex = 0;
    assert(match, `${name} no longer calls searchImapMessages in the expected shape`);
    found.set(name, match[3]);
  }
  assertEquals(found.get("executeSearchEmails"), "true", "email_search declares preview");
  assertEquals(found.get("executeSearchAndMove"), "false");
  assertEquals(found.get("executeSearchAndDelete"), "false");
});

Deno.test("a single-folder search issues ONE FETCH, and skips the preview pass", () => {
  // With one folder and the offset of 0 that both mutating tools hardcode, the
  // ranking pass and the preview pass ask for byte-identical sets of messages.
  const body = functionSource("searchImapMessages");
  assertStringIncludes(body, "const singlePass = searchFolders.length === 1;");
  assertStringIncludes(body, "includePreview: singlePass && needPreview,");

  const guardAt = body.indexOf("if (!singlePass && needPreview) {");
  assert(guardAt > 0, "the preview pass is no longer guarded");

  const fetches = [...body.matchAll(/client\.fetchSummaries\(/g)].map((m) => m.index ?? -1);
  assertEquals(fetches.length, 2, "searchImapMessages should have exactly two FETCH sites");
  assert(fetches[0] < guardAt, "the ranking FETCH must run unconditionally");
  assert(fetches[1] > guardAt, "the second FETCH must sit inside the multi-folder guard");
});

Deno.test("the search phase no longer claims a ceiling it does not have", () => {
  for (const name of ["executeSearchAndMove", "executeSearchAndDelete"] as const) {
    const body = functionSource(name);
    assertStringIncludes(body, "budget.searchPhaseMs()");
    assert(
      !body.includes("searchPhaseMs(SEARCH_TIMEOUT_MS)"),
      `${name} still passes a per-search ceiling that can never bind`,
    );
  }
});

Deno.test("REGRESSION GUARD: the search phase of a mutating tool logs what it logged before", () => {
  // This change is about timing and connection handling. It must not move a
  // single logged error code on these two paths, because both accept an
  // idempotency_key and the code IS what settles the outbound ledger:
  // `provider_error` means "unknown" and a retry replays, anything else means
  // "failed" and it does not. The read-timeout narrowing applied to
  // email_search is deliberately still absent here.
  for (
    const [name, tool] of [
      ["executeSearchAndMove", "email_search_and_move"],
      ["executeSearchAndDelete", "email_search_and_delete"],
    ] as const
  ) {
    const body = functionSource(name);

    const timeoutAt = body.indexOf('logErrorCode: "search_timeout"');
    assert(timeoutAt > 0, `${name} no longer logs search_timeout for its own deadline`);

    const searchFailure = body.slice(timeoutAt);
    assertStringIncludes(searchFailure, `tool: "${tool}"`);
    assertStringIncludes(searchFailure, 'boundary: "ledger"');
    assertStringIncludes(searchFailure, 'phase: "search"');

    assert(
      !body.includes("classifyProviderError"),
      `${name} must not narrow a provider failure: it would move the ledger from unknown to failed`,
    );
  }
});

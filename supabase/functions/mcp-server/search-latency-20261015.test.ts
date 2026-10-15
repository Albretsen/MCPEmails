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
//   4. MCP tool calls take a warm IMAP connection from a pool configured to
//      change no answer and add no wait (mcp-imap-pool.ts).
//
// The handlers live in index.ts, which calls `Deno.serve` at load and exports
// nothing, so their wiring is pinned by source scan, as search-phase-wiring.ts
// does. The budget rule and the pool are run for real.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertNotStrictEquals, assertStrictEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeImapServer, fakeTextMessage } from "./imap-fake-server.ts";
import type { ImapClient } from "./imap-client.ts";
import {
  hasTimeForNextFolder,
  IMAP_FOLDER_ESTIMATE_PADDING,
  IMAP_SEARCH_FINISH_RESERVE_MS,
  imapSearchStoppedEarlyNote,
} from "./imap-search-budget.ts";
import {
  MCP_IMAP_POOL_OPTIONS,
  mcpImapPoolStore,
  mcpPooledConnect,
  resetMcpImapPoolForTests,
} from "./mcp-imap-pool.ts";
import { ImapCallTimings, imapTimingStore } from "./imap-timing.ts";

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
// 4. The MCP connection pool.
// ---------------------------------------------------------------------------

function server(): FakeImapServer {
  return new FakeImapServer({
    mailboxes: [
      { name: "INBOX", messages: [fakeTextMessage(1), fakeTextMessage(2, { seen: true })] },
      { name: "Archive", messages: [fakeTextMessage(7)] },
    ],
  });
}

const CFG = { host: "imap.example.test", port: 993, email: "a@example.test", password: "pw" };

function counter() {
  const servers: FakeImapServer[] = [];
  return {
    servers,
    dial: () => {
      const s = server();
      servers.push(s);
      return Promise.resolve(s.client());
    },
  };
}

function call<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return mcpImapPoolStore.run({ workspaceId, flow: {} }, fn);
}

async function connectInCall(workspaceId: string, d: ReturnType<typeof counter>, cfg = CFG): Promise<ImapClient> {
  return await call(workspaceId, async () => {
    const hook = mcpPooledConnect();
    assert(hook, "inside a tool call the hook is on");
    return await hook(cfg, d.dial);
  });
}

Deno.test("pool: no hook outside an MCP tool call", () => {
  assertStrictEquals(mcpPooledConnect(), null);
});

Deno.test("pool: the settings that keep answers and waits as they were", () => {
  assertEquals(MCP_IMAP_POOL_OPTIONS.waitMs, 0);
  assertEquals(MCP_IMAP_POOL_OPTIONS.listTtlMs, 0);
  assertEquals(MCP_IMAP_POOL_OPTIONS.authBackoffMs, 0);
  assert(MCP_IMAP_POOL_OPTIONS.maxLeaseMs >= 10 * 60_000, "no running call is presumed leaked");
});

Deno.test("pool: the next call on the same inbox reuses the connection, without a dial", async () => {
  await resetMcpImapPoolForTests();
  const d = counter();
  const first = await connectInCall("ws1", d);
  await first.selectMailbox("INBOX");
  await first.logout();
  const timings = new ImapCallTimings();
  const second = await imapTimingStore.run(timings, () => connectInCall("ws1", d));
  assertEquals(d.servers.length, 1, "one dial for two calls");
  assertEquals(timings.pooledReuses, 1);
  assert(timings.logFields() !== null, "a reused call still writes its mailbox phases");
  await second.logout();
  await resetMcpImapPoolForTests();
});

Deno.test("pool: a call never waits for another call's connection", async () => {
  await resetMcpImapPoolForTests();
  const d = counter();
  const held = await connectInCall("ws1", d);
  const started = performance.now();
  const second = await connectInCall("ws1", d);
  assert(performance.now() - started < 1_000, "the second call dialled at once");
  assertEquals(d.servers.length, 2);
  assertNotStrictEquals(second, held);
  await second.logout();
  await held.logout();
  await resetMcpImapPoolForTests();
});

Deno.test("pool: past every slot it dials as before, never refuses", async () => {
  await resetMcpImapPoolForTests();
  const d = counter();
  const held: ImapClient[] = [];
  for (let i = 0; i < MCP_IMAP_POOL_OPTIONS.maxPerKey + 2; i++) held.push(await connectInCall("ws1", d));
  assertEquals(d.servers.length, MCP_IMAP_POOL_OPTIONS.maxPerKey + 2);
  for (const c of held) await c.logout();
  await resetMcpImapPoolForTests();
});

Deno.test("pool: two workspaces never share a connection", async () => {
  await resetMcpImapPoolForTests();
  const d = counter();
  const a = await connectInCall("ws1", d);
  await a.logout();
  const b = await connectInCall("ws2", d);
  assertEquals(d.servers.length, 2);
  await b.logout();
  await resetMcpImapPoolForTests();
});

Deno.test("pool: folder lists always come from the server", async () => {
  await resetMcpImapPoolForTests();
  const d = counter();
  const a = await connectInCall("ws1", d);
  await a.listMailboxes();
  await a.logout();
  const b = await connectInCall("ws1", d);
  await b.listMailboxes();
  await b.logout();
  assertEquals(d.servers.length, 1);
  const lists = d.servers[0].commands.filter((c) => /\bLIST\b/i.test(c));
  assertEquals(lists.length, 2, "the second LIST went to the server");
  await resetMcpImapPoolForTests();
});

Deno.test("pool: a failed command drops the connection rather than reusing it", async () => {
  await resetMcpImapPoolForTests();
  const d = counter();
  const a = await connectInCall("ws1", d);
  await a.selectMailbox("NoSuchMailbox").catch(() => {});
  await a.logout();
  const b = await connectInCall("ws1", d);
  assertEquals(d.servers.length, 2, "a fresh connection after a failure");
  await b.logout();
  await resetMcpImapPoolForTests();
});

Deno.test("pool: MCP_IMAP_POOL=off dials per call, exactly as before", async () => {
  Deno.env.set("MCP_IMAP_POOL", "off");
  try {
    await call("ws1", () => Promise.resolve(assertStrictEquals(mcpPooledConnect(), null)));
  } finally {
    Deno.env.delete("MCP_IMAP_POOL");
  }
});

Deno.test("wiring: ImapClient.connect asks the MCP pool only when there is no first-party hook", () => {
  assertStringIncludes(CLIENT_SOURCE, "firstPartyContext.getStore()?.imapConnect ?? mcpPooledConnect()");
});

Deno.test("wiring: the pool scope is opened around the MCP executor, per call and per workspace", () => {
  assertStringIncludes(
    INDEX_SOURCE,
    "mcpImapPoolStore.run(\n      { workspaceId: apiKey.workspace_id, flow: {} },\n      () => dispatchExecutor(dispatchName, rawArgs, apiKey),",
  );
  // And nowhere else: automations and client-api dial as before.
  assertEquals(INDEX_SOURCE.split("mcpImapPoolStore.run(").length - 1, 1);
});

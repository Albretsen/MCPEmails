// The seam is behaviour-neutral for MCP traffic.
//
// Three angles on one claim, "an MCP request cannot tell client-api exists":
//
//   1. BYTES. A real `tools/call` (through `handleToolsCall`, the function the
//      MCP server answers with) for a listing whose messages ARE starred
//      returns no `is_flagged` anywhere, and its rows are byte-identical to
//      the client-api rows with that one key removed. So the option adds a
//      key and changes nothing else; the pre-existing bytes themselves are
//      pinned by mcp-server's own provider-call-baseline tests, which still
//      pass unchanged.
//   2. REQUESTS. The provider requests an MCP listing issues are the same
//      URLs as before (no `flag` in a Graph $select; see mail-gmail.test.ts
//      for the Outlook half).
//   3. STRUCTURE. Nothing in mcp-server opens the first-party context or
//      assigns the human-sender marker. Those are the only two ways the new
//      behaviour can be switched on, and both live in client-api.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { firstPartyContext } from "../../mcp-server/first-party.ts";
import { fakeTextMessage } from "../../mcp-server/imap-fake-server.ts";
import { FakeDialPool, gmailHandler, type GmailWorld, harness, imapInbox, imapServer, INBOX_ID, mcp, realApp } from "./real-seam.ts";

function starredWorld(): GmailWorld {
  return {
    historyId: "1",
    sent: [],
    modified: [],
    messages: [
      { id: "s1", from: "A <a@x.example>", to: "owner@gmail-harness.example", subject: "Starred", snippet: "one", labelIds: ["INBOX", "STARRED"] },
      { id: "s2", from: "B <b@x.example>", to: "owner@gmail-harness.example", subject: "Plain", snippet: "two", labelIds: ["INBOX", "UNREAD"] },
    ],
  };
}

interface ToolsCallResult {
  result?: { content: { type: string; text: string }[]; structuredContent?: { messages: Record<string, unknown>[] }; isError?: boolean };
  error?: unknown;
}

async function mcpToolsCall(name: string, args: Record<string, unknown>, world: GmailWorld) {
  return await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(world), () =>
    mcp.handleToolsCall(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      1,
      { ...harness.API_KEY, scopes: ["read:email", "search:email"] },
      { ipAddress: null, userAgent: "mcp-neutral-test" },
    ) as Promise<ToolsCallResult>);
}

function withoutFlag(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const copy = { ...row };
    delete copy["is_flagged"];
    return copy;
  });
}

Deno.test("MCP tools/call list: no is_flagged on the wire, and byte-identical to the client-api rows minus that key", async () => {
  const viaMcp = await mcpToolsCall("email_read", { action: "list", inbox_id: INBOX_ID, folder: "inbox", limit: 10 }, starredWorld());
  const response = viaMcp.value;
  assert(response.result && !response.error, JSON.stringify(response));
  assertEquals(response.result.isError ?? false, false);

  const wire = JSON.stringify(response);
  assert(!wire.includes("is_flagged"), "the serialised JSON-RPC response has no is_flagged");
  assert(!wire.includes("STARRED"), "nor any trace of the label it would be derived from");
  const mcpRows = response.result.structuredContent!.messages;
  assertEquals(mcpRows.length, 2);
  assertEquals(Object.keys(mcpRows[0]), ["id", "from", "to", "subject", "date", "preview", "is_read", "has_attachments", "folder", "thread_id"]);

  const app = await realApp();
  const viaClient = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(starredWorld()), () =>
    app.mail("list", { folder: "inbox", limit: 10 }));
  const clientRows = viaClient.value.body.messages as Record<string, unknown>[];
  assertEquals(clientRows.map((r) => r["is_flagged"]), [true, false]);
  assertEquals(JSON.stringify(withoutFlag(clientRows)), JSON.stringify(mcpRows), "identical bytes once is_flagged is removed");

  // And the provider saw the same requests either way.
  assertEquals(harness.requestMultiset(viaClient.world), harness.requestMultiset(viaMcp.world));
});

Deno.test("MCP tools/call search: no is_flagged on the wire either", async () => {
  const viaMcp = await mcpToolsCall("email_read", { action: "search", inbox_id: INBOX_ID, flagged: true, limit: 10 }, starredWorld());
  assert(viaMcp.value.result, JSON.stringify(viaMcp.value));
  assert(!JSON.stringify(viaMcp.value).includes("is_flagged"));
  assertEquals(viaMcp.value.result.structuredContent!.messages.map((m) => m["id"]), ["s1"]);
});

Deno.test("the MCP path writes its activity_log row; client-api writes none for the same operation", async () => {
  const viaMcp = await mcpToolsCall("email_read", { action: "list", inbox_id: INBOX_ID, folder: "inbox", limit: 10 }, starredWorld());
  assert(viaMcp.world.db.some((c) => c.target === "activity_log" && c.method === "POST"), "MCP accounting is untouched");
  const app = await realApp();
  const viaClient = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(starredWorld()), () =>
    app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(viaClient.world.db.filter((c) => c.target === "activity_log").length, 0);
});

Deno.test("IMAP list without the option: no is_flagged, same rows as with it", async () => {
  const flagged = fakeTextMessage(2);
  flagged.flags = ["\\Flagged", "\\Seen"];
  const boxes = [{ name: "INBOX", messages: [fakeTextMessage(1), flagged] }];
  const inbox = await imapInbox();
  const none: harness.ProviderHandler = () => harness.json({}, 500);

  // The executor exactly as `handleToolsCall` runs it, with the ONLY first-party
  // hook being the one that swaps the socket for the fake server.
  const plainPool = new FakeDialPool(imapServer(boxes));
  const plain = await harness.runTool(inbox, none, () =>
    firstPartyContext.run(
      { imapConnect: <C>() => plainPool.dial() as unknown as Promise<C> },
      () => mcp.dispatchExecutor("email_list", { inbox_id: INBOX_ID, folder: "INBOX", limit: 10 }, harness.API_KEY),
    ));
  const plainRows = (plain.value!.result as { structuredContent: { messages: Record<string, unknown>[] } }).structuredContent.messages;
  assert(!JSON.stringify(plain.value).includes("is_flagged"));

  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const viaClient = await harness.runTool(inbox, none, () => app.mail("list", { folder: "INBOX", limit: 10 }));
  const clientRows = viaClient.value.body.messages as Record<string, unknown>[];
  assertEquals(clientRows.map((r) => r["is_flagged"]), [true, false]);
  assertEquals(JSON.stringify(withoutFlag(clientRows)), JSON.stringify(plainRows));
  // Without the pool, the tool layer logs the connection out as it always has.
  assertEquals(plainPool.servers[0].logoutReceived, true);
  await pool.closeAll();
});

Deno.test("structure: nothing in mcp-server opens the first-party context or sets the human-sender marker", async () => {
  const dir = new URL("../../mcp-server/", import.meta.url);
  const offenders: string[] = [];
  let humanReads = 0;
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const source = await Deno.readTextFile(new URL(entry.name, dir));
    // Comments explain the mechanism by name; only code can switch it on.
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    if (/firstPartyContext\s*\.\s*(run|enterWith)\s*\(/.test(code)) offenders.push(`${entry.name}: opens firstPartyContext`);
    if (/firstPartyHuman\s*[:=]\s*true/.test(code)) offenders.push(`${entry.name}: assigns firstPartyHuman`);
    if (/includeFlagged\s*:\s*true/.test(code)) offenders.push(`${entry.name}: sets includeFlagged`);
    // The three options added for the web client's reply, bulk move and delete.
    if (/(replyRecipients|humanBulk|trashIds)\s*:\s*(true|options|[a-z])/.test(code) && entry.name !== "first-party.ts") {
      offenders.push(`${entry.name}: sets a first-party option`);
    }
    humanReads += (code.match(/firstPartyHuman/g) ?? []).length;
  }
  assertEquals(offenders, []);
  // The type declaration and the one read in queueSendApproval.
  assertEquals(humanReads, 2, "firstPartyHuman is declared once and read once in mcp-server");
});

Deno.test("structure: an authenticated MCP key row can never carry the marker", async () => {
  const source = await Deno.readTextFile(new URL("../../mcp-server/index.ts", import.meta.url));
  const start = source.indexOf("async function authenticateRequest(");
  const end = source.indexOf("\nasync function ", start + 10);
  assert(start !== -1 && end > start);
  const body = source.slice(start, end);
  assert(!body.includes("firstPartyHuman"), "authenticateRequest does not mention the marker");
  assert(!/select\(\s*["'`]\*["'`]\s*\)/.test(body), "the key row is selected by named columns, not *");
});

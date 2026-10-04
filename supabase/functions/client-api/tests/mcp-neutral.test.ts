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
    // Everything client-api adds to a row: the star, and the conversation
    // threading fields (thread.test.ts).
    for (const key of ["is_flagged", "message_id_header", "in_reply_to", "references", "thread_key"]) delete copy[key];
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
  // And the provider saw the same requests either way, but for the three
  // header names client-api adds to each metadata get it was already making.
  const threadHeaders = "&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&metadataHeaders=References";
  const clientRequests = harness.requestMultiset(viaClient.world);
  assert(clientRequests.some((r) => r.includes(threadHeaders)));
  assertEquals(clientRequests.map((r) => r.replace(threadHeaders, "")).sort(), harness.requestMultiset(viaMcp.world));
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

// ── What differs for MCP after the integration, and what does not ───────────
//
// Two changes meet in a row. The read fixes (one byte-exact IMAP reader, one
// preview generator, raw 8-bit headers decoded) apply to EVERY caller, MCP
// included. Conversation threading (`message_id_header`, `in_reply_to`,
// `references`, `thread_key`, and the References item of the FETCH) is
// first-party only. This pins exactly that split on one mailbox.

const THREAD_KEYS = ["message_id_header", "in_reply_to", "references", "thread_key"];

Deno.test("MCP IMAP list: the read fixes apply (decoded subject, clean preview); the threading fields and FETCH item do not", async () => {
  const utf8 = (text: string) => {
    let out = "";
    for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
    return out;
  };
  const message = (uid: number, subject: string, type: string, body: string, extra: string[] = []) => ({
    uid,
    flags: [] as string[],
    raw: [
      "Date: 01 Oct 2026 10:00:00 +0000",
      'From: "Maya" <maya@example.com>',
      "To: <owner@example.com>",
      `Subject: ${subject}`,
      `Message-ID: <m${uid}@example.com>`,
      ...extra,
      `Content-Type: ${type}`,
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
    ].join("\r\n"),
  });
  const boxes = [{
    name: "INBOX",
    messages: [
      // A raw 8-bit UTF-8 subject and body: the octets C3 98 must read as "Ø".
      message(1, utf8("Faktura – Ødegård"), "text/plain; charset=utf-8", utf8("Hei Åse – “velkommen”")),
      // A reply with thread headers, HTML whose first bytes are CSS and nested markup.
      message(2, "Re: plain", "text/html; charset=utf-8", "<style>p{color:red}</style><scr<script>ipt>x()</script><p>Visible <b>text</b>.</p>", [
        "In-Reply-To: <m1@example.com>",
        "References: <root@example.com>\r\n <m1@example.com>",
      ]),
    ],
  }];
  const inbox = await imapInbox();
  const none: harness.ProviderHandler = () => harness.json({}, 500);

  const plainPool = new FakeDialPool(imapServer(boxes));
  const plain = await harness.runTool(inbox, none, () =>
    firstPartyContext.run(
      { imapConnect: <C>() => plainPool.dial() as unknown as Promise<C> },
      () => mcp.dispatchExecutor("email_list", { inbox_id: INBOX_ID, folder: "INBOX", limit: 10 }, harness.API_KEY),
    ));
  const wireJson = JSON.stringify(plain.value);
  const mcpRows = (plain.value!.result as { structuredContent: { messages: Record<string, unknown>[] } }).structuredContent.messages;

  // The read fixes DO apply to MCP.
  const byId = new Map(mcpRows.map((r) => [r["id"], r]));
  assertEquals([byId.get("INBOX:1")!["subject"], byId.get("INBOX:1")!["preview"]], ["Faktura – Ødegård", "Hei Åse – “velkommen”"]);
  assertEquals(byId.get("INBOX:2")!["preview"], "ipt>x() Visible text.");
  assert(!wireJson.includes("�") && !/Ã|â€/.test(wireJson), "no replacement character and no octets read as characters");
  assert(!wireJson.includes("color:red"), "no CSS in a preview");

  // The threading fields do NOT: not a key, not a value, not a FETCH item.
  assertEquals(Object.keys(mcpRows[0]), ["id", "from", "to", "subject", "date", "preview", "is_read", "has_attachments", "folder", "thread_id"]);
  for (const key of [...THREAD_KEYS, "is_flagged"]) assert(!wireJson.includes(`"${key}"`), `${key} on the MCP wire`);
  assert(!wireJson.includes("root@example.com"), "nothing read from References reaches an MCP result");
  const mcpFetches = plainPool.servers[0].commands.filter((c) => /FETCH/.test(c));
  assertEquals(mcpFetches, ["FETCH 1:2 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)"], "the FETCH MCP has always sent");

  // client-api: the same rows, byte for byte, plus exactly its own keys.
  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const viaClient = await harness.runTool(inbox, none, () => app.mail("list", { folder: "INBOX", limit: 10 }));
  const clientRows = viaClient.value.body.messages as Record<string, unknown>[];
  assertEquals(Object.keys(clientRows[0]).slice(-5), ["is_flagged", ...THREAD_KEYS]);
  assertEquals(JSON.stringify(withoutFlag(clientRows)), JSON.stringify(mcpRows), "identical bytes once the first-party keys are removed");
  const reply = clientRows.find((r) => r["id"] === "INBOX:2")!;
  assertEquals([reply["in_reply_to"], reply["references"], reply["thread_key"]], ["m1@example.com", ["root@example.com", "m1@example.com"], "m:root@example.com"]);
  assert(pool.servers[0].commands.some((c) => c.includes("BODY.PEEK[HEADER.FIELDS (REFERENCES)]")));
  await pool.closeAll();
});

Deno.test("MCP IMAP read: body and headers take the read fixes; message_id_header and thread_key stay first-party", async () => {
  const boxes = [{
    name: "INBOX",
    messages: [{
      uid: 1,
      flags: [] as string[],
      raw: [
        "Date: 01 Oct 2026 10:00:00 +0000",
        'From: "Maya" <maya@example.com>',
        "To: <owner@example.com>",
        "Subject: Caf\xe9",
        "Message-ID: <r1@example.com>",
        "In-Reply-To: <r0@example.com>",
        "References: <r0@example.com>",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Bl\xc3\xa5b\xc3\xa6r \xe2\x80\x93 ok",
      ].join("\r\n"),
    }],
  }];
  const inbox = await imapInbox();
  const none: harness.ProviderHandler = () => harness.json({}, 500);
  const plainPool = new FakeDialPool(imapServer(boxes));
  const plain = await harness.runTool(inbox, none, () =>
    firstPartyContext.run(
      { imapConnect: <C>() => plainPool.dial() as unknown as Promise<C> },
      () => mcp.dispatchExecutor("email_read", { inbox_id: INBOX_ID, message_id: "INBOX:1" }, harness.API_KEY),
    ));
  const result = (plain.value!.result as { structuredContent: Record<string, unknown> }).structuredContent;
  const wireJson = JSON.stringify(plain.value);
  assertEquals(result["subject"], "Café");
  assert(String(result["body_text"]).includes("Blåbær – ok"), String(result["body_text"]));
  // `in_reply_to` and `references` have always been part of an MCP read.
  assertEquals([result["in_reply_to"], result["references"]], ["r0@example.com", ["r0@example.com"]]);
  for (const key of ["message_id_header", "thread_key", "is_flagged"]) assert(!wireJson.includes(`"${key}"`), `${key} on the MCP wire`);

  const pool = new FakeDialPool(imapServer(boxes));
  const app = await realApp({ pool });
  const viaClient = await harness.runTool(inbox, none, () => app.mail("read", { message_id: "INBOX:1", include_html: false }));
  const body = viaClient.value.body as Record<string, unknown>;
  assertEquals([body["message_id_header"], body["thread_key"], body["subject"]], ["r1@example.com", "m:r0@example.com", "Café"]);
  assertEquals(body["body_text"], result["body_text"], "one decode path for both callers");
  await pool.closeAll();
});

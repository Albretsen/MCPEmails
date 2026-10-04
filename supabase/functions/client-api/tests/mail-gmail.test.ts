// Mail ops against the REAL tool layer, Gmail and Outlook, over the provider
// harness's fake fetch. No network.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { decodeRaw, gmailHandler, type GmailWorld, harness, INBOX_ID, mcp, realApp } from "./real-seam.ts";

function world(): GmailWorld {
  return {
    historyId: "9001",
    sent: [],
    modified: [],
    messages: [
      { id: "g1", from: "Maya <maya@north.example>", to: "owner@gmail-harness.example", subject: "Starred one", snippet: "first", labelIds: ["INBOX", "STARRED", "UNREAD"] },
      { id: "g2", from: "Odd <odd@fjord.example>", to: "owner@gmail-harness.example", subject: "Plain one", snippet: "second", labelIds: ["INBOX"] },
      { id: "g3", from: "Ida <ida@fjell.example>", to: "owner@gmail-harness.example", subject: "Another star", snippet: "third", labelIds: ["INBOX", "STARRED"], text: "Body of g3" },
    ],
  };
}

Deno.test("list (gmail): rows are the MCP rows plus is_flagged from the STARRED label", async () => {
  const w = world();
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () => app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(value.status, 200);
  assertEquals(value.body.messages.map((m: { id: string; is_flagged: boolean }) => [m.id, m.is_flagged]), [
    ["g1", true],
    ["g2", false],
    ["g3", true],
  ]);
  assertEquals(value.body.messages[0].is_read, false);
  assertEquals(Object.keys(value.body.messages[0]), [
    "id",
    "from",
    "to",
    "subject",
    "date",
    "preview",
    "is_read",
    "has_attachments",
    "folder",
    "thread_id",
    "is_flagged",
    // Conversation threading (thread.test.ts).
    "message_id_header",
    "in_reply_to",
    "references",
    "thread_key",
  ]);
});

Deno.test("search (gmail): rows carry is_flagged too", async () => {
  const w = world();
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () => app.mail("search", { flagged: true, limit: 10 }));
  assertEquals(value.status, 200);
  assertEquals(value.body.messages.map((m: { id: string; is_flagged: boolean }) => [m.id, m.is_flagged]), [["g1", true], ["g3", true]]);
});

Deno.test("read (gmail): the executor's result, unchanged", async () => {
  const w = world();
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () => app.mail("read", { message_id: "g3", include_html: false }));
  assertEquals(value.status, 200);
  assertEquals([value.body.id, value.body.subject, value.body.body_text], ["g3", "Another star", "Body of g3"]);
});

Deno.test("read (gmail): a message that does not exist is the error envelope, not a 200", async () => {
  const app = await realApp();
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(world()), () => app.mail("read", { message_id: "missing" }));
  assert(value.status >= 400);
  assertEquals(typeof value.body.error.code, "string");
  assertEquals(typeof value.body.error.message, "string");
});

Deno.test("flag (gmail): read and starred are two executor calls, one result each", async () => {
  const w = world();
  const app = await realApp();
  const { value, world: run } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () =>
    app.mail("flag", { message_ids: ["g1", "g2"], read: true, starred: true }));
  assertEquals(value.status, 200);
  assertEquals(Object.keys(value.body).sort(), ["read", "starred"]);
  const bodies = run.calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body ?? "{}"));
  assert(bodies.length >= 2, "at least one provider write per flag change");
  assert(bodies.some((b) => JSON.stringify(b).includes("UNREAD")), "one call removes UNREAD");
  assert(bodies.some((b) => JSON.stringify(b).includes("STARRED")), "one call adds STARRED");
});

Deno.test("status (gmail): counters per folder and a fingerprint that follows the mailbox historyId", async () => {
  const w = world();
  const app = await realApp();
  const inbox = await harness.inboxRow("gmail");
  const first = (await harness.runTool(inbox, gmailHandler(w), () => app.mail("status", { folders: ["inbox"] }))).value;
  assertEquals(first.status, 200);
  assertEquals(first.body.provider, "gmail");
  assertEquals(first.body.folders, [{ folder: "inbox", id: "INBOX", total: 3, unread: 1, fingerprint: "g:9001" }]);
  const again = (await harness.runTool(inbox, gmailHandler(w), () => app.mail("status", { folders: ["inbox"] }))).value;
  assertEquals(again.body.folders[0].fingerprint, "g:9001", "nothing changed: same fingerprint");
  w.historyId = "9002";
  w.messages[1].labelIds = ["INBOX", "STARRED"];
  const changed = (await harness.runTool(inbox, gmailHandler(w), () => app.mail("status", { folders: ["inbox"] }))).value;
  assertEquals(changed.body.folders[0].fingerprint, "g:9002", "a star set elsewhere moves the fingerprint");
});

// ── the human sender ────────────────────────────────────────────────────────

const SIGNATURE = "Kind regards from the signature block";

async function approvalInbox() {
  return await harness.inboxRow("gmail", {
    send_approval_required: true,
    signature_enabled: true,
    signature_text: SIGNATURE,
    signature_html: `<p>${SIGNATURE}</p>`,
  });
}

const sendArgs = { to: ["reader@north.example"], subject: "From the web client", body: "Hello from a human.", idempotency_key: "send-key-0001" };

Deno.test("send: the human sender is NOT held for approval on an approval-required inbox, and the signature is applied", async () => {
  const w = world();
  const app = await realApp();
  const { value, world: run } = await harness.runTool(await approvalInbox(), gmailHandler(w), () => app.mail("send", sendArgs));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(w.sent.length, 1, "the message went to the provider");
  assertEquals(run.db.filter((c) => c.target === "send_approvals").length, 0, "no approval row was written or read");
  assertEquals("approval_id" in value.body, false);
  const raw = decodeRaw(w.sent[0].raw);
  assertStringIncludes(raw, "Hello from a human.");
  assertStringIncludes(raw, SIGNATURE, "the inbox signature is appended, as for any other send");
  assertStringIncludes(raw, "reader@north.example");
  // The idempotency ledger was claimed and settled under the hidden key.
  const ledger = run.db.filter((c) => c.target === "outbound_idempotency").map((c) => c.method);
  assert(ledger.includes("POST") && ledger.includes("PATCH"), `claimed and settled: ${ledger.join(",")}`);
});

Deno.test("send: the SAME call without the human marker is held (the gate itself is unchanged)", async () => {
  const w = world();
  const key = { ...harness.API_KEY, scopes: ["send:email", "read:email"] };
  const { value, world: run } = await harness.runTool(await approvalInbox(), gmailHandler(w), () =>
    mcp.dispatchExecutor("email_send", { inbox_id: INBOX_ID, to: sendArgs.to, subject: sendArgs.subject, body: sendArgs.body }, key));
  assertEquals(w.sent.length, 0, "nothing was sent");
  assert(run.db.some((c) => c.target === "send_approvals" && c.method === "POST"), "an approval was queued instead");
  assert(value !== null);
});

Deno.test("send: internalApprovalDispatch still skips the signature; the human marker does not", async () => {
  const w = world();
  const dispatchKey = { ...harness.API_KEY, scopes: ["send:email"], internalApprovalDispatch: true };
  await harness.runTool(await approvalInbox(), gmailHandler(w), () =>
    mcp.dispatchExecutor("email_send", { inbox_id: INBOX_ID, to: sendArgs.to, subject: "s", body: "Approved body." }, dispatchKey));
  assertEquals(w.sent.length, 1);
  assert(!decodeRaw(w.sent[0].raw).includes(SIGNATURE), "the approval dispatcher's marker suppresses the signature");

  const humanKey = { ...harness.API_KEY, scopes: ["send:email"], firstPartyHuman: true as const };
  await harness.runTool(await approvalInbox(), gmailHandler(w), () =>
    mcp.dispatchExecutor("email_send", { inbox_id: INBOX_ID, to: sendArgs.to, subject: "s", body: "Human body." }, humanKey));
  assertEquals(w.sent.length, 2);
  assertStringIncludes(decodeRaw(w.sent[1].raw), SIGNATURE);
});

Deno.test("send: a viewer cannot send, and nothing reaches the provider or the ledger", async () => {
  const w = world();
  const app = await realApp({ role: "viewer" });
  const { value, world: run } = await harness.runTool(await approvalInbox(), gmailHandler(w), () => app.mail("send", sendArgs));
  assertEquals([value.status, value.body.error.code], [403, "forbidden"]);
  assertEquals(w.sent.length, 0);
  assertEquals(run.calls.length, 0);
  assertEquals(run.db.length, 0);
});

Deno.test("manual operations write no activity_log and no action_usage rows", async () => {
  const w = world();
  const app = await realApp();
  const { world: run } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), async () => {
    await app.mail("list", { folder: "inbox" });
    await app.mail("read", { message_id: "g3" });
    await app.mail("flag", { message_ids: ["g2"], read: true });
    await app.mail("send", { ...sendArgs, idempotency_key: "send-key-0002" });
  });
  const targets = new Set(run.db.map((c) => c.target));
  for (const forbidden of ["activity_log", "action_usage", "action_usage_reservations", "rpc/reserve_action_usage", "rpc/workspace_action_allowance"]) {
    assert(!targets.has(forbidden), `client-api must not touch ${forbidden}`);
  }
  assert(![...targets].some((t) => t.startsWith("rpc/") && /action|rate|quota/.test(t)), [...targets].join(","));
});

Deno.test("warm path: the inbox row is read once and reused; a send always re-reads it", async () => {
  const w = world();
  const app = await realApp();
  const { world: run } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), async () => {
    await app.mail("list", { folder: "inbox" });
    await app.mail("list", { folder: "inbox" });
    await app.mail("read", { message_id: "g3" });
  });
  const inboxReads = () => run.db.filter((c) => c.target === "inboxes" && c.method === "GET").length;
  assertEquals(inboxReads(), 1, "three operations, one inboxes query");
  const after = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(w), () => app.mail("send", { ...sendArgs, idempotency_key: "send-key-0003" }));
  assert(after.world.db.filter((c) => c.target === "inboxes" && c.method === "GET").length >= 1, "send read the row fresh");
});

// ── Outlook ─────────────────────────────────────────────────────────────────

function graphHandler(selects: string[]): harness.ProviderHandler {
  return (call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith("/messages")) {
      selects.push(url.searchParams.get("$select") ?? "");
      return harness.json({
        value: [
          { id: "o1", conversationId: "c1", subject: "Flagged", receivedDateTime: "2026-09-01T10:00:00Z", isRead: false, hasAttachments: false, bodyPreview: "p1", flag: { flagStatus: "flagged" }, from: { emailAddress: { name: "A", address: "a@x.example" } }, toRecipients: [] },
          { id: "o2", conversationId: "c2", subject: "Not flagged", receivedDateTime: "2026-09-01T09:00:00Z", isRead: true, hasAttachments: false, bodyPreview: "p2", flag: { flagStatus: "notFlagged" }, from: { emailAddress: { name: "B", address: "b@x.example" } }, toRecipients: [] },
        ],
      });
    }
    if (/\/mailFolders\/[^/]+$/.test(url.pathname)) {
      return harness.json({ id: "folder-inbox-id", displayName: "Inbox", totalItemCount: 2, unreadItemCount: 1 });
    }
    return harness.json({ value: [] });
  };
}

Deno.test("list (outlook): is_flagged from flag.flagStatus, and `flag` is selected only for client-api", async () => {
  const app = await realApp();
  const selects: string[] = [];
  const viaClient = await harness.runTool(await harness.inboxRow("outlook"), graphHandler(selects), () => app.mail("list", { folder: "inbox", limit: 10 }));
  assertEquals(viaClient.value.status, 200, JSON.stringify(viaClient.value.body));
  assertEquals(viaClient.value.body.messages.map((m: { id: string; is_flagged: boolean }) => [m.id, m.is_flagged]), [["o1", true], ["o2", false]]);
  assert(selects.every((s) => s.endsWith(",flag,internetMessageId")), selects.join(" | "));

  const mcpSelects: string[] = [];
  const viaMcp = await harness.runTool(await harness.inboxRow("outlook"), graphHandler(mcpSelects), () =>
    mcp.dispatchExecutor("email_list", { inbox_id: INBOX_ID, folder: "inbox", limit: 10 }, harness.API_KEY));
  assertEquals(mcpSelects, ["id,conversationId,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,hasAttachments"],
    "the MCP request URL is exactly what it was");
  assert(!JSON.stringify(viaMcp.value).includes("is_flagged"));
});

// The assistant's policy and the REAL tool runner, run against each other.
//
// `assistant/policy.ts` rebuilds the arguments of every model tool call;
// `assistant-wiring.ts` validates them against the MCP tool's advertised
// schema and dispatches the real executor. This file sends every allow-listed
// tool/action, with every optional argument the policy accepts, through both
// and against the IMAP, Gmail and Outlook fakes. A schema rejection or a
// refusal anywhere fails the test with the tool, action and message.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { executeCall, RunMemory } from "../assistant/mailbox.ts";
import { DEFAULT_LIMITS, sanitizeToolCall } from "../assistant/policy.ts";
import { assistantToolRunner } from "../assistant-wiring.ts";
import { InboxRowCache, type MailEnv, type OpTimings } from "../mail/run.ts";
import {
  gmailHandler,
  gmailMailbox,
  graphHandler,
  graphMailbox,
  imapMessage,
  imapWorld,
  scriptedImap,
} from "./assistant-tools-fakes.ts";
import { FakeDialPool, harness, imapInbox, INBOX_ID, mcp } from "./real-seam.ts";

const KEY = { ...harness.API_KEY, scopes: ["read:email", "search:email", "write:email", "send:email", "delete:email", "manage:folders", "read:contacts"] };

function runner(pool: FakeDialPool | null, canWrite = true) {
  const timings: OpTimings = { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
  const env: MailEnv = {
    mcp,
    // deno-lint-ignore no-explicit-any
    pool: (pool ?? new FakeDialPool(() => { throw new Error("no imap here"); })) as any,
    imapDial: pool?.dial,
    inboxes: new InboxRowCache(),
    apiKey: KEY,
    canWrite,
  };
  return assistantToolRunner(mcp, env, KEY, canWrite, timings);
}

interface Case {
  name: string;
  args: Record<string, unknown>;
}

/** Every allow-listed tool/action, with every optional argument the policy keeps. */
function cases(ids: { a: string; b: string; c: string; d: string; e: string }, folder: string, dest: string): Case[] {
  return [
    { name: "folder_list", args: {} },
    { name: "draft_list", args: { limit: 5 } },
    { name: "contact_search", args: { query: "maya", limit: 5 } },
    { name: "email_read", args: { action: "list", folder, limit: 5, offset: 0, unread: true } },
    { name: "email_read", args: { action: "list" } },
    {
      name: "email_read",
      args: {
        action: "search",
        query: "renewal",
        from: "maya",
        to: "owner",
        subject: "renewal",
        body: "seats",
        since: "2026-09-01",
        before: "2026-12-01",
        unread: false,
        has_attachment: false,
        flagged: false,
        include_folders: [folder],
        limit: 5,
        offset: 0,
      },
    },
    { name: "email_read", args: { action: "search", flagged: true } },
    { name: "email_read", args: { action: "read", message_id: ids.a, body_offset: 0 } },
    { name: "email_read", args: { action: "read_batch", message_ids: [ids.a, ids.b] } },
    { name: "email_organize", args: { action: "flag", message_ids: [ids.a], flag_action: "read" } },
    { name: "email_organize", args: { action: "flag", message_ids: [ids.a], flag_action: "unread" } },
    { name: "email_organize", args: { action: "flag", message_ids: [ids.a, ids.b], flag_action: "flag" } },
    { name: "email_organize", args: { action: "flag", message_ids: [ids.a], flag_action: "unflag" } },
    { name: "email_organize", args: { action: "move", message_id: ids.a, destination_folder_id: dest } },
    { name: "email_organize", args: { action: "move_batch", message_ids: [ids.b], destination_folder_id: dest } },
    { name: "email_organize", args: { action: "archive", message_id: ids.c } },
    { name: "email_organize", args: { action: "archive", message_ids: [ids.d] } },
    { name: "email_delete", args: { action: "delete", message_id: ids.e, permanent: true } },
  ];
}

async function runAll(run: ReturnType<typeof runner>, list: Case[]): Promise<{ problems: string[]; contents: string[] }> {
  const mem = new RunMemory();
  const problems: string[] = [];
  const contents: string[] = [];
  for (const c of list) {
    const label = `${c.name}.${String(c.args.action ?? "")}`;
    const checked = sanitizeToolCall(c.name, { inbox_id: INBOX_ID, ...c.args }, {
      inboxIds: new Set([INBOX_ID]),
      defaultInboxId: INBOX_ID,
      limits: DEFAULT_LIMITS,
      bodiesRead: 0,
      mutated: 0,
    });
    if (!checked.ok) {
      problems.push(`${label}: policy rejected: ${checked.message}`);
      continue;
    }
    // The runner directly, to see the raw refusal if there is one.
    const outcome = await executeCall(checked, async (name, args) => {
      const res = await run(name, args);
      const err = (res.result as { error?: string; message?: string; errors?: unknown } | null);
      if (res.isError && (err?.error === "invalid_arguments" || err?.error === "not_allowed")) {
        problems.push(`${label}: ${err.error}: ${err.message} ${JSON.stringify(err.errors ?? "")} args=${JSON.stringify(args)}`);
      } else if (res.isError) {
        problems.push(`${label}: executor error: ${JSON.stringify(res.result)} args=${JSON.stringify(args)}`);
      }
      return res;
    }, mem, DEFAULT_LIMITS);
    contents.push(`${label} => ${outcome.content.slice(0, 300)}`);
  }
  return { problems, contents };
}

Deno.test("assistant tools (imap): every sanitized call passes the real schema and reaches the mailbox", async () => {
  const world = imapWorld([
    {
      name: "INBOX",
      attrs: ["\\HasNoChildren"],
      messages: [1, 2, 3, 4, 5].map((uid) =>
        imapMessage(uid, { from: "Maya Chen <maya@north.example>", to: "owner@example.com", subject: "Q4 renewal terms", body: "40 seats renewal", date: "15 Sep 2026 10:00:00 +0000" })
      ),
    },
    { name: "Receipts", attrs: ["\\HasNoChildren"], messages: [] },
    { name: "Archive", attrs: ["\\HasNoChildren", "\\Archive"], messages: [] },
    { name: "Trash", attrs: ["\\HasNoChildren", "\\Trash"], messages: [] },
    { name: "Drafts", attrs: ["\\HasNoChildren", "\\Drafts"], messages: [] },
    { name: "Sent", attrs: ["\\HasNoChildren", "\\Sent"], messages: [] },
  ]);
  const pool = new FakeDialPool(scriptedImap(world));
  const run = runner(pool);
  const none: harness.ProviderHandler = (call) => harness.json({ error: `unexpected ${call.url}` }, 500);
  const { value } = await harness.runTool(await imapInbox(), none, () =>
    runAll(run, cases({ a: "INBOX:1", b: "INBOX:2", c: "INBOX:3", d: "INBOX:4", e: "INBOX:5" }, "INBOX", "Receipts")));
  // contact_search scans Sent with header searches the scripted server does
  // not evaluate: it passed the schema and reached the executor, which is
  // what this file checks. Gmail and Outlook run it for real below.
  const problems = value.problems.filter((p) => !/^contact_search\.: executor error: \{"error":"provider_error"/.test(p));
  assertEquals(problems, [], value.contents.join("\n"));

  const box = (name: string) => world.mailboxes.find((m) => m.name === name)!;
  assertEquals(box("Receipts").messages.length, 2, "move and move_batch reached the destination");
  assertEquals(box("Archive").messages.length, 2, "archive (single and fanned out) reached Archive");
  assertEquals(box("Trash").messages.length, 1, "delete went to Trash");
  assertEquals(world.expunged, [], "permanent: true from the model never reached the mailbox");
  assert(world.stores.some((s) => s.flags.includes("\\Flagged") && s.mode === "+"), "flag stored \\Flagged");
  assert(world.stores.some((s) => s.flags.includes("\\Seen") && s.mode === "-"), "unread cleared \\Seen");
  assert(world.searches.some((s) => /FROM/i.test(s.criteria) && /SINCE/i.test(s.criteria) && /BEFORE/i.test(s.criteria)), JSON.stringify(world.searches));
  assert(world.searches.some((s) => /\bFLAGGED\b/i.test(s.criteria)), "flagged reached the search");
  await pool.closeAll();
});

Deno.test("assistant tools (gmail): every sanitized call passes the real schema and reaches the mailbox", async () => {
  const at = String(Date.parse("2026-09-15T10:00:00Z"));
  const box = gmailMailbox(["g1", "g2", "g3", "g4", "g5"].map((id) => ({
    id,
    from: "Maya Chen <maya@north.example>",
    to: "owner@gmail-harness.example",
    subject: "Q4 renewal terms",
    text: "40 seats renewal",
    snippet: "40 seats renewal",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: at,
  })));
  const run = runner(null);
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(box), () =>
    runAll(run, cases({ a: "g1", b: "g2", c: "g3", d: "g4", e: "g5" }, "INBOX", "Label_7")));
  assertEquals(value.problems, [], value.contents.join("\n"));
  assertEquals(box.unscripted, []);
  assertEquals(box.deleted, [], "no permanent delete");
  assertEquals(box.trashed, ["g5"]);
  assert(box.modified.some((m) => m.add.includes("Label_7")), "move added the destination label");
  assert(box.modified.some((m) => m.add.includes("STARRED")), "flag starred");
  assert(box.modified.some((m) => m.remove.includes("INBOX") && (m.id === "g3" || m.id === "g4")), "archive removed INBOX");
  assert(box.queries.some((q) => /from:/.test(q) && /after:/.test(q) && /before:/.test(q)), box.queries.join(" | "));
  assert(box.queries.some((q) => /is:starred/.test(q)), box.queries.join(" | "));
});

Deno.test("assistant tools (outlook): every sanitized call passes the real schema and reaches the mailbox", async () => {
  const box = graphMailbox(["o1", "o2", "o3", "o4", "o5"].map((id) => ({
    id,
    folder: "fid-inbox",
    subject: "Q4 renewal terms",
    from: { name: "Maya Chen", address: "maya@north.example" },
    isRead: false,
    flagged: false,
    receivedDateTime: "2026-09-15T10:00:00Z",
    text: "40 seats renewal",
  })));
  const run = runner(null);
  const { value } = await harness.runTool(await harness.inboxRow("outlook"), graphHandler(box), () =>
    runAll(run, cases({ a: "o1", b: "o2", c: "o3", d: "o4", e: "o5" }, "inbox", "fid-projects")));
  assertEquals(value.problems, [], value.contents.join("\n"));
  assertEquals(box.unscripted, []);
  assertEquals(box.deleted, [], "no permanent delete");
  assertEquals(box.items.filter((i) => i.folder === "fid-projects").length, 2);
  assertEquals(box.items.filter((i) => i.folder === "fid-archive").length, 2);
  assertEquals(box.items.filter((i) => i.folder === "fid-trash").length, 1);
  assert(box.patches.some((p) => JSON.stringify(p.body).includes("flagged")), "flag reached Graph");
});

Deno.test("assistant tools: the closed cases stay closed through the real runner", async () => {
  const box = gmailMailbox([{ id: "g1", from: "A <a@x.example>", to: "owner@gmail-harness.example", subject: "s", text: "t", labelIds: ["INBOX"] }]);
  const { value } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(box), async () => {
    const run = runner(null);
    const readOnly = runner(null, false);
    return {
      permanent: await run("email_delete", { action: "delete", inbox_id: INBOX_ID, message_id: "g1", permanent: true }),
      unknownTool: await run("email_compose", { action: "send", inbox_id: INBOX_ID, to: ["x@y.example"], subject: "s", body: "b" }),
      unknownAction: await run("email_organize", { action: "copy", inbox_id: INBOX_ID, message_id: "g1", destination_folder_id: "Label_7" }),
      searchAndDelete: await run("email_delete", { action: "search_and_delete", inbox_id: INBOX_ID, query: "x" }),
      viewerWrite: await readOnly("email_organize", { action: "archive", inbox_id: INBOX_ID, message_id: "g1" }),
      viewerRead: await readOnly("email_read", { action: "read", inbox_id: INBOX_ID, message_id: "g1", include_html: false, include_attachments: false }),
      keyed: await run("email_organize", { action: "flag", inbox_id: INBOX_ID, message_ids: ["g1"], flag_action: "read", idempotency_key: "model-chosen" }),
    };
  });
  for (const name of ["permanent", "unknownTool", "unknownAction", "searchAndDelete", "viewerWrite"] as const) {
    assertEquals([name, value[name].isError, (value[name].result as { error: string }).error], [name, true, "not_allowed"]);
  }
  assertEquals(value.viewerRead.isError, false, JSON.stringify(value.viewerRead.result));
  assertEquals(value.keyed.isError, false, JSON.stringify(value.keyed.result));
  assertEquals(box.deleted, []);
  assertEquals(box.trashed, []);
  assertEquals(box.modified.length, 1, "only the keyed flag call changed anything");
});

Deno.test("assistant tools: a model-chosen idempotency_key never reaches the ledger", async () => {
  const box = gmailMailbox([{ id: "g1", from: "A <a@x.example>", to: "owner@gmail-harness.example", subject: "s", text: "t", labelIds: ["INBOX"] }]);
  const { world } = await harness.runTool(await harness.inboxRow("gmail"), gmailHandler(box), () =>
    runner(null)("email_organize", { action: "archive", inbox_id: INBOX_ID, message_id: "g1", idempotency_key: "model-chosen" }));
  assertEquals(world.db.filter((c) => c.target === "outbound_idempotency").length, 0);
});

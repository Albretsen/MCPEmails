// ---------------------------------------------------------------------------
// Per-inbox instructions, through the real executors and the real gate read.
//
// inbox-instructions.test.ts pins the rules; this pins the wiring:
//
//   - inbox_list carries `owner_instructions` only when the Pro gate ALLOWS
//     inbox_instructions, and is byte for byte unchanged otherwise (not
//     visible, or visible on a lower plan), without even reading the column;
//   - the drafting/sending note is appended on an allowed workspace's
//     successful result, and nowhere else.
//
// No socket is opened: the harness fakes PostgREST, including the
// workspace_pro_features RPC (answered from dbRows["rpc/workspace_pro_features"]).
// Each test uses its own API key object, because the gate is memoised per key
// object (one read per request).
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };

const server = await import("./index.ts") as unknown as {
  dispatchExecutor: (
    name: string,
    args: unknown,
    apiKey: unknown,
  ) => Promise<{ result: ToolResult; logStatus: string } | null>;
  attachInboxInstructionsNote: (
    response: { jsonrpc: "2.0"; id: number; result: ToolResult },
    dispatchName: string,
    apiKey: unknown,
    inboxId: string | null,
  ) => Promise<void>;
};

const INSTRUCTIONS = "This is the support inbox. Sign as the Support Team. Never reply to invoices; move them to Finance.";

async function imapInbox(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return await harness.inboxRow("gmail", {
    provider: "imap",
    service: "generic",
    email_address: "support@example.com",
    oauth_access_token: null,
    oauth_refresh_token: null,
    oauth_token_expires_at: null,
    imap_host: "imap.fake-server.example",
    imap_port: 993,
    imap_security: "tls",
    imap_password: await harness.encryptToken("app-password-invented"),
    smtp_host: "smtp.fake-server.example",
    smtp_port: 465,
    smtp_security: "tls",
    ...overrides,
  });
}

const noProvider: harness.ProviderHandler = (call) => {
  throw new Error(`no provider call expected, got ${call.method} ${call.url}`);
};

type Gate = "closed" | "visible_free" | "allowed_pro" | "allowed_business";

function gateRows(gate: Gate): Record<string, unknown[]> {
  if (gate === "closed") return {};
  const plan = gate === "visible_free" ? "free" : gate === "allowed_pro" ? "solo" : "pro";
  return {
    "rpc/workspace_pro_features": [{ plan, comped_scale: false, rollout_enabled: true, public_launch: false }],
  };
}

function freshKey(): Record<string, unknown> {
  return { ...harness.API_KEY };
}

async function listInboxes(gate: Gate, inbox: Record<string, unknown>) {
  const key = freshKey();
  const { value, world } = await harness.runToolWithInboxes(
    [inbox],
    noProvider,
    () => server.dispatchExecutor("inbox_list", {}, key),
    gateRows(gate),
  );
  assert(value, "inbox_list should have an executor");
  return { outcome: value, world };
}

function instructionReads(world: { db: { method: string; target: string; query: string }[] }): number {
  return world.db.filter((c) => c.method === "GET" && c.target === "inboxes" && c.query.includes("ai_instructions")).length;
}

Deno.test("inbox_list on an allowed workspace returns each inbox's instructions", async () => {
  for (const gate of ["allowed_pro", "allowed_business"] as const) {
    const { outcome, world } = await listInboxes(gate, await imapInbox({ ai_instructions: `  ${INSTRUCTIONS}\n` }));
    assertEquals(outcome.logStatus, "success");
    const inboxes = (outcome.result.structuredContent as { inboxes: Record<string, unknown>[] }).inboxes;
    assertEquals(inboxes[0].owner_instructions, INSTRUCTIONS, gate);
    // The serialized mirror says the same.
    assert(outcome.result.content[0].text.includes('"owner_instructions"'));
    assertEquals(instructionReads(world), 1);
  }
});

Deno.test("inbox_list is byte for byte unchanged when not visible or not allowed", async () => {
  const baseline = await listInboxes("closed", await imapInbox());
  for (const gate of ["closed", "visible_free"] as const) {
    const { outcome, world } = await listInboxes(gate, await imapInbox({ ai_instructions: INSTRUCTIONS }));
    assertEquals(outcome.result.content[0].text, baseline.outcome.result.content[0].text, gate);
    assertEquals(JSON.stringify(outcome.result), JSON.stringify(baseline.outcome.result), gate);
    assert(!outcome.result.content[0].text.includes("owner_instructions"), gate);
    // The column is never read for a workspace that may not use it.
    assertEquals(instructionReads(world), 0, gate);
  }
});

Deno.test("inbox_list on an allowed workspace with no instructions adds nothing", async () => {
  const baseline = await listInboxes("closed", await imapInbox());
  const { outcome } = await listInboxes("allowed_pro", await imapInbox({ ai_instructions: null }));
  assertEquals(JSON.stringify(outcome.result), JSON.stringify(baseline.outcome.result));
});

function draftResult(): { jsonrpc: "2.0"; id: number; result: ToolResult } {
  const structured = { draft_id: "d1", subject: "Hi", created_at: "2026-10-24T00:00:00.000Z" };
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured },
  };
}

async function attach(gate: Gate, tool: string, response = draftResult(), inboxId: string | null = harness.INBOX_ID) {
  const key = freshKey();
  const inbox = await imapInbox({ ai_instructions: INSTRUCTIONS });
  const { world } = await harness.runToolWithInboxes(
    [inbox],
    noProvider,
    () => server.attachInboxInstructionsNote(response, tool, key, inboxId),
    gateRows(gate),
  );
  return { response, world };
}

Deno.test("drafting and sending results carry the labelled note when allowed", async () => {
  for (const tool of ["draft_create", "draft_reply", "email_send", "email_reply", "email_forward"]) {
    const { response } = await attach("allowed_pro", tool);
    const note = `Inbox instructions from the owner:\n${INSTRUCTIONS}`;
    assertEquals(response.result.structuredContent?.notes, [note], tool);
    assertEquals(response.result.content.at(-1)?.text, note, tool);
    // The JSON mirror stays the serialization of structuredContent.
    assertEquals(response.result.content[0].text, JSON.stringify(response.result.structuredContent), tool);
  }
});

Deno.test("no note when not visible, not allowed, on reads, on errors or without an inbox", async () => {
  const untouched = JSON.stringify(draftResult());
  const cases: Array<[Gate, string, ReturnType<typeof draftResult>, string | null]> = [
    ["closed", "draft_create", draftResult(), harness.INBOX_ID],
    ["visible_free", "draft_create", draftResult(), harness.INBOX_ID],
    ["allowed_pro", "email_read", draftResult(), harness.INBOX_ID],
    ["allowed_pro", "email_search", draftResult(), harness.INBOX_ID],
    ["allowed_pro", "draft_create", draftResult(), null],
  ];
  for (const [gate, tool, response, inboxId] of cases) {
    const { world } = await attach(gate, tool, response, inboxId);
    assertEquals(JSON.stringify(response), untouched, `${gate} ${tool} ${inboxId}`);
    assertEquals(instructionReads(world), 0, `${gate} ${tool}`);
  }
  const failed = draftResult();
  failed.result.isError = true;
  const before = JSON.stringify(failed);
  await attach("allowed_pro", "draft_create", failed);
  assertEquals(JSON.stringify(failed), before);
});

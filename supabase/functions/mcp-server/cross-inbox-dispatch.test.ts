// ---------------------------------------------------------------------------
// `inbox_id: "all"` (Pro, cross_inbox_search) through the real executors.
//
// The harness fakes PostgREST and Gmail; every inbox, address and message here
// is invented. Each inbox gets its own access token, so a Gmail request says
// which inbox it is for. The Pro gate is the workspace_pro_features RPC row.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";
import { PRO_FEATURE_ERROR_CODE, PRO_FEATURE_META_KEY } from "./pro-features.ts";

type Outcome = {
  result: {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  logStatus: string;
  logErrorCode: string | null;
};

const server = await import("./index.ts") as unknown as {
  dispatchExecutor: (name: string, args: unknown, apiKey: unknown) => Promise<Outcome | null>;
  // deno-lint-ignore no-explicit-any
  handleToolsList: (req: unknown, id: number, apiKey: unknown) => Promise<any>;
};

const IDS = {
  a: "aaaaaaaa-1111-4111-8111-111111111111",
  b: "bbbbbbbb-2222-4222-8222-222222222222",
  c: "cccccccc-3333-4333-8333-333333333333",
};

async function gmailInbox(tag: "a" | "b" | "c"): Promise<Record<string, unknown>> {
  return await harness.inboxRow("gmail", {
    id: IDS[tag],
    email_address: `${tag}@gmail-harness.example`,
    oauth_access_token: await harness.encryptToken(`token-${tag}`),
  });
}

/** Per inbox, newest first: [message id, day of October 2026]. */
type Mailboxes = Record<string, Array<[string, number]>>;

const MAIL: Mailboxes = {
  "token-a": [["a1", 20], ["a2", 12], ["a3", 3]],
  "token-b": [["b1", 22], ["b2", 11]],
  "token-c": [["c1", 15]],
};

const dayMs = (day: number) => String(Date.UTC(2026, 9, day, 10, 0, 0));

function gmail(mail: Mailboxes, fail: Record<string, number> = {}): harness.ProviderHandler {
  const byId = new Map<string, number>();
  for (const rows of Object.values(mail)) for (const [id, day] of rows) byId.set(id, day);
  return (call) => {
    const token = call.bearer ?? "";
    if (call.url.includes("/messages?")) {
      if (fail[token]) return harness.json({ error: { message: "Backend Error" } }, fail[token]);
      const max = Number(new URL(call.url).searchParams.get("maxResults") ?? "100");
      const rows = (mail[token] ?? []).slice(0, max);
      return harness.json({
        ...(rows.length ? { messages: rows.map(([id]) => ({ id, threadId: `t-${id}` })) } : {}),
        resultSizeEstimate: rows.length,
      });
    }
    if (call.url.includes("/messages/")) {
      const id = harness.messageIdOf(call);
      return harness.json(harness.gmailMeta({
        id,
        from: `Sender ${id} <sender-${id}@mail.example>`,
        to: "owner@gmail-harness.example",
        subject: `Subject ${id}`,
        internalDate: dayMs(byId.get(id) ?? 1),
      }));
    }
    return harness.json({ error: { message: `unexpected ${call.url}` } }, 418);
  };
}

const gate = (plan: string, rollout = true) => ({
  "rpc/workspace_pro_features": [{ plan, comped_scale: false, rollout_enabled: rollout, public_launch: false }],
});

/** A fresh key object per call: the gate is memoised on it. */
const key = (overrides: Record<string, unknown> = {}) => ({ ...harness.API_KEY, ...overrides });

async function run(
  tool: string,
  args: Record<string, unknown>,
  opts: {
    rows?: Record<string, unknown[]>;
    mail?: Mailboxes;
    fail?: Record<string, number>;
    apiKey?: unknown;
    connected?: ("a" | "b" | "c")[];
  } = {},
) {
  const inboxes = await Promise.all((opts.connected ?? ["a", "b", "c"]).map(gmailInbox));
  const { value, world } = await harness.runToolWithInboxes(
    inboxes,
    gmail(opts.mail ?? MAIL, opts.fail),
    () => server.dispatchExecutor(tool, args, opts.apiKey ?? key()),
    opts.rows ?? gate("solo"),
  );
  assert(value, `${tool} should have an executor`);
  return { outcome: value, world };
}

const tokensAsked = (world: harness.World) => new Set(world.calls.map((c) => c.bearer));

Deno.test("all on Pro: every inbox listed, merged newest first, each row tagged", async () => {
  const { outcome, world } = await run("email_list", { inbox_id: "all", limit: 4 });
  assertEquals(outcome.logStatus, "success", outcome.result.content[0].text);
  assertEquals(outcome.result.isError, false);
  const body = outcome.result.structuredContent!;
  const messages = body.messages as Record<string, unknown>[];
  assertEquals(messages.map((m) => m.id), ["b1", "a1", "c1", "a2"]);
  assertEquals(messages[0].inbox_id, IDS.b);
  assertEquals(messages[0].inbox_address, "b@gmail-harness.example");
  assertEquals(messages[1].inbox_address, "a@gmail-harness.example");
  assertEquals(body.untrusted_content, true);
  assertEquals(body.total, 6);
  assertEquals(body.has_more, true);
  assertEquals(body.next_offset, 4);
  assertEquals(body.inbox_errors, []);
  assertEquals((body.inboxes as unknown[]).length, 3);
  // Each inbox was asked for offset + limit results.
  for (const call of world.calls.filter((c) => c.url.includes("/messages?"))) {
    assertEquals(new URL(call.url).searchParams.get("maxResults"), "4");
  }
  assertEquals(tokensAsked(world), new Set(["token-a", "token-b", "token-c"]));
  // The text block is the same payload.
  assertEquals(JSON.parse(outcome.result.content[0].text), body);
});

Deno.test("all on Pro: the second page continues the merged list", async () => {
  const { outcome } = await run("email_list", { inbox_id: "all", limit: 4, offset: 4 });
  const body = outcome.result.structuredContent!;
  assertEquals((body.messages as Record<string, unknown>[]).map((m) => m.id), ["b2", "a3"]);
  assertEquals(body.has_more, false);
  assertEquals(body.next_offset, null);
});

Deno.test("all on Pro, search: the same fan-out over email_search", async () => {
  const { outcome, world } = await run("email_search", { inbox_id: "ALL", from: "sender", limit: 2 });
  assertEquals(outcome.logStatus, "success");
  const messages = outcome.result.structuredContent!.messages as Record<string, unknown>[];
  assertEquals(messages.map((m) => m.id), ["b1", "a1"]);
  assert(world.calls.some((c) => c.url.includes("/messages?") && c.url.includes("q=")));
});

Deno.test("search with no criterion is refused once, before any inbox is asked", async () => {
  const { outcome, world } = await run("email_search", { inbox_id: "all" });
  assertEquals(outcome.result.isError, true);
  assertEquals(outcome.logErrorCode, "-32602");
  assertEquals(world.calls.length, 0);
});

Deno.test("one inbox failing is an entry in inbox_errors; the others still answer", async () => {
  const { outcome } = await run("email_list", { inbox_id: "all" }, { fail: { "token-b": 500 } });
  assertEquals(outcome.logStatus, "success");
  const body = outcome.result.structuredContent!;
  assertEquals((body.messages as Record<string, unknown>[]).map((m) => m.id), ["a1", "c1", "a2", "a3"]);
  const errors = body.inbox_errors as Record<string, unknown>[];
  assertEquals(errors.length, 1);
  assertEquals(errors[0].inbox_id, IDS.b);
  assertEquals(errors[0].inbox_address, "b@gmail-harness.example");
  assertStringIncludes(String(errors[0].message), "Backend Error");
  assertEquals(body.total_is_estimate, true);
  assertStringIncludes((body.notes as string[]).join(" "), "1 of 3 inboxes did not answer");
});

Deno.test("every inbox failing is an error result naming each inbox", async () => {
  const { outcome } = await run("email_list", { inbox_id: "all" }, {
    fail: { "token-a": 500, "token-b": 500, "token-c": 500 },
  });
  assertEquals(outcome.result.isError, true);
  assertEquals(outcome.logStatus, "error");
  const text = outcome.result.content[0].text;
  for (const tag of ["a", "b", "c"]) assertStringIncludes(text, `${tag}@gmail-harness.example`);
});

Deno.test("a key restricted to some inboxes: all means those inboxes and no others", async () => {
  const { outcome, world } = await run("email_list", { inbox_id: "all" }, {
    apiKey: key({ inbox_ids: [IDS.a, IDS.c] }),
  });
  const body = outcome.result.structuredContent!;
  assertEquals((body.messages as Record<string, unknown>[]).map((m) => m.inbox_id).includes(IDS.b), false);
  assertEquals((body.inboxes as Record<string, unknown>[]).map((i) => i.inbox_id), [IDS.a, IDS.c]);
  assertEquals(tokensAsked(world).has("token-b"), false);
});

Deno.test("visible but not on Pro or Business: the standard Pro refusal, no mailbox touched", async () => {
  for (const plan of ["free", "personal"]) {
    const { outcome, world } = await run("email_list", { inbox_id: "all" }, { rows: gate(plan) });
    assertEquals(outcome.result.isError, true);
    assertEquals(outcome.logErrorCode, PRO_FEATURE_ERROR_CODE);
    assertEquals((outcome.result._meta![PRO_FEATURE_META_KEY] as Record<string, unknown>).feature, "cross_inbox_search");
    assertStringIncludes(outcome.result.content[0].text, "Search across all inboxes is part of the Pro and Business plans.");
    assertEquals(world.calls.length, 0, plan);
  }
});

Deno.test("not on Pro with one inbox connected: all reads that inbox, no refusal", async () => {
  for (const plan of ["free", "personal"]) {
    for (const [tool, args] of [
      ["email_list", { inbox_id: "all" }],
      ["email_search", { inbox_id: "all", subject: "hello" }],
    ] as const) {
      const { outcome, world } = await run(tool, args, { rows: gate(plan), connected: ["a"] });
      assertEquals(outcome.logStatus, "success", `${plan} ${tool}`);
      assertEquals(outcome.logErrorCode, null);
      assertEquals(outcome.result.isError, false);
      const body = outcome.result.structuredContent!;
      assertEquals((body.messages as Record<string, unknown>[]).map((m) => m.inbox_id), [IDS.a, IDS.a, IDS.a]);
      assertEquals([...tokensAsked(world)], ["token-a"]);
    }
  }
});

Deno.test("not on Pro with a key limited to one of several inboxes: all reads that one", async () => {
  const { outcome, world } = await run("email_list", { inbox_id: "all" }, {
    rows: gate("personal"),
    apiKey: key({ inbox_ids: [IDS.b] }),
  });
  assertEquals(outcome.logErrorCode, null);
  assertEquals((outcome.result.structuredContent!.inboxes as Record<string, unknown>[]).map((i) => i.inbox_id), [IDS.b]);
  assertEquals(tokensAsked(world).has("token-a"), false);
});

Deno.test("not on Pro with a key limited to two inboxes: still the Pro refusal", async () => {
  const { outcome, world } = await run("email_list", { inbox_id: "all" }, {
    rows: gate("personal"),
    apiKey: key({ inbox_ids: [IDS.a, IDS.b] }),
  });
  assertEquals(outcome.logErrorCode, PRO_FEATURE_ERROR_CODE);
  assertEquals(world.calls.length, 0);
});

Deno.test("not visible: all is answered exactly as before the feature existed", async () => {
  const closed = await run("email_list", { inbox_id: "all" }, { rows: {} });
  const notRolledOut = await run("email_list", { inbox_id: "all" }, { rows: gate("solo", false) });
  for (const { outcome, world } of [closed, notRolledOut]) {
    assertEquals(outcome.result.isError, true);
    assertEquals(outcome.logErrorCode, "inbox_not_found");
    assertStringIncludes(outcome.result.content[0].text, "No inbox matches the given inbox_id/inbox.");
    assert(!outcome.result.content[0].text.includes("Pro"));
    assertEquals(world.calls.length, 0);
  }
  assertEquals(closed.outcome, notRolledOut.outcome);
});

Deno.test("one named inbox is byte-for-byte unchanged whether or not the feature is on", async () => {
  for (const tool of ["email_list", "email_search"]) {
    const args = tool === "email_list" ? { inbox_id: IDS.a, limit: 2 } : { inbox_id: IDS.a, from: "sender", limit: 2 };
    const on = await run(tool, { ...args }, { rows: gate("solo") });
    const off = await run(tool, { ...args }, { rows: {} });
    assertEquals(on.outcome, off.outcome, tool);
    assertEquals(on.outcome.result.content[0].text, off.outcome.result.content[0].text, tool);
    const rows = on.outcome.result.structuredContent!.messages as Record<string, unknown>[];
    assert(rows.every((m) => !("inbox_address" in m)), tool);
  }
});

Deno.test("inbox with all is refused rather than guessed at", async () => {
  const { outcome, world } = await run("email_list", { inbox_id: "all", inbox: "a@gmail-harness.example" });
  assertEquals(outcome.result.isError, true);
  assertEquals(outcome.logErrorCode, "-32602");
  assertEquals(world.calls.length, 0);
});

Deno.test("tools/list: visible, inbox_id says it takes all; not visible, unchanged", async () => {
  const inbox = await gmailInbox("a");
  const list = async (rows: Record<string, unknown[]>) => {
    const { value } = await harness.runToolWithInboxes(
      [inbox],
      gmail(MAIL),
      () => server.handleToolsList({ jsonrpc: "2.0", id: 1, method: "tools/list" }, 1, key()),
      rows,
    );
    return value.result.tools as { name: string; inputSchema: { properties: Record<string, Record<string, unknown>> } }[];
  };
  const visible = await list(gate("free"));
  const hidden = await list({});
  const readVisible = visible.find((t) => t.name === "email_read")!;
  const readHidden = hidden.find((t) => t.name === "email_read")!;
  assertStringIncludes(String(readVisible.inputSchema.properties.inbox_id.description), `"all"`);
  assertEquals(readVisible.inputSchema.properties.inbox_id.format, undefined);
  assertEquals(readHidden.inputSchema.properties.inbox_id.format, "uuid");
  assert(!String(readHidden.inputSchema.properties.inbox_id.description).includes(`"all"`));
  // Only inbox_id on the list/search tools differs.
  const folderVisible = visible.find((t) => t.name === "folder_list");
  const folderHidden = hidden.find((t) => t.name === "folder_list");
  assertEquals(folderVisible, folderHidden);
});

Deno.test("tools/call: visible, email_read list with all passes validation and fans out", async () => {
  const inboxes = [await gmailInbox("a"), await gmailInbox("b"), await gmailInbox("c")];
  const callServer = server as unknown as {
    // deno-lint-ignore no-explicit-any
    handleToolsCall: (req: unknown, id: number, apiKey: unknown, ctx: unknown) => Promise<any>;
  };
  const call = (rows: Record<string, unknown[]>) =>
    harness.runToolWithInboxes(
      inboxes,
      gmail(MAIL),
      () =>
        callServer.handleToolsCall(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "email_read", arguments: { action: "list", inbox_id: "all", limit: 3 } },
          },
          1,
          key(),
          { userAgent: null },
        ),
      rows,
    );
  const open = await call(gate("pro"));
  const body = open.value.result.structuredContent;
  assertEquals(open.value.result.isError, false, JSON.stringify(open.value).slice(0, 300));
  assertEquals(body.messages.map((m: Record<string, unknown>) => m.id), ["b1", "a1", "c1"]);
  // The activity row names no inbox: "all" is not an inbox id.
  const logRow = open.world.db.find((d) => d.target === "activity_log" && d.method === "POST");
  assert(logRow, "an activity_log row is written");
  assertEquals((logRow.body as Record<string, unknown>).inbox_id, null);

  const closed = await call({});
  assertStringIncludes(JSON.stringify(closed.value), "must be a UUID");
});

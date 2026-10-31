// ---------------------------------------------------------------------------
// No-approval rules, the mcp-server's half. The migration's own test
// (supabase/tests/no_approval_rules.sql) proves who the database lets write.
//
//   1. Nothing here can write one: no key, no tool, no argument.
//   2. Everything still goes through the approval row and the dispatcher.
//   3. A row a rule decided is checked again before it goes, and goes back to
//      waiting when it is no longer covered.
//   4. The automation tool says what is true, and only that.
//
// Run: HOST_GUARD_SKIP_NETWORK_TESTS=1 deno test --node-modules-dir=none \
//        --allow-read --allow-env --allow-run=git \
//        supabase/functions/mcp-server/no-approval.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";

const server = await import("./index.ts");
const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

type Row = Record<string, unknown>;

/** Every non-test .ts file under supabase/functions. */
async function functionSources(): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = async (dir: URL) => {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules") continue;
      const next = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(next);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push({ path: next.pathname, text: await Deno.readTextFile(next) });
      }
    }
  };
  await walk(new URL("../", import.meta.url));
  return out;
}

Deno.test("no edge function touches the tables or the write functions", async () => {
  const forbidden = [
    /from\(\s*["'`]no_approval_(rules|rule_automations|workspace_state|usage)["'`]/,
    /no_approval_rule_save|no_approval_rule_delete|no_approval_rule_confirm|no_approval_pause_all/,
  ];
  for (const { path, text } of await functionSources()) {
    for (const pattern of forbidden) assert(!pattern.test(text), `${path} matches ${pattern}`);
  }
});

Deno.test("only the database can mark a row as decided by a rule", async () => {
  for (const { path, text } of await functionSources()) {
    assert(!/decided_via:\s*["'`]?NO_APPROVAL|decided_via:\s*["'`]no_approval_rule/.test(text), `${path} writes it`);
  }
});

Deno.test("the approval path has no bypass: every forward still writes its row first", () => {
  const signature = SOURCE.slice(SOURCE.indexOf("async function queueSendApproval("));
  const params = signature.slice(0, signature.indexOf("): Promise<QueuedApproval | null>"));
  assert(!/no_?approval|unattended|bypass|skip/i.test(params.replace(/\/\/.*$/gm, "")), "queueSendApproval takes no such argument");
  const forward = SOURCE.slice(SOURCE.indexOf('case "forward": {\n      // ALWAYS written'));
  const queued = forward.indexOf("await queueSendApproval(");
  const decided = forward.indexOf("await forwardWithoutApproval(");
  assert(queued > 0 && decided > queued, "the row is written, then a rule may decide it");
  assert(
    !/internalApprovalDispatch\s*:\s*true/.test(forward.slice(0, decided)),
    "the runner never marks itself as the dispatcher",
  );
  assertStringIncludes(forward.slice(0, queued), "send_approval_required: true");
});

Deno.test("what a forward passes the decision is the send's addresses, the date and one word", () => {
  const start = SOURCE.indexOf("async function forwardWithoutApproval(");
  const body = SOURCE.slice(start, SOURCE.indexOf("/** Assembles the dependency bundle", start));
  assertStringIncludes(body, '"no_approval_auto_decide"');
  for (const name of ["filter", "subject", "body", "rule.action", "note"]) {
    assert(!body.includes(`p_${name}`), `the decision does not read ${name}`);
  }
  assert(!/subject|snippet|from_name/.test(body), "no mail text reaches it, so prompt-style text can change nothing");
});

Deno.test("a tool can not pass an argument that sets coverage", async () => {
  const { runAutomationTool } = await import("./triage-engine.ts");
  const inserted: Row[] = [];
  const updated: Row[] = [];
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: [], error: null }),
    insert: (row: Row) => (inserted.push(row), chain),
    update: (row: Row) => (updated.push(row), chain),
    maybeSingle: () => Promise.resolve({ data: { id: "rule-new", ...inserted[0] }, error: null }),
  };
  const result = await runAutomationTool("create", {
    inbox_id: "inbox-1",
    name: "Forward",
    filter: { subject: "invoice" },
    rule_action: { type: "forward", to: ["ap@example.com"], unattended: true, no_approval: true },
    interval_minutes: 60,
    no_approval: true,
    runs_without_approval: true,
    decided_via: "no_approval_rule",
  // deno-lint-ignore no-explicit-any
  }, deps(chain) as any);
  assertEquals(result.logStatus, "success");
  assertEquals(inserted.length, 1, "only the rule row is written");
  const text = JSON.stringify(inserted[0]);
  assert(!/no_approval|runs_without_approval|unattended|decided_via/.test(text), `nothing of it is stored: ${text}`);
  // deno-lint-ignore no-explicit-any
  const payload = result.result.structuredContent as any;
  assertEquals(payload.held_for_approval, true);
  assertEquals(payload.runs_without_approval, false, "and it still says held");
});

function deps(chain: unknown, covered: string[] = []) {
  return {
    db: { from: () => chain },
    caller: {
      id: "key-1",
      workspace_id: "ws-1",
      scopes: ["read:email", "send:email", "manage:automations"],
      inbox_ids: null,
    },
    resolveInbox: () =>
      Promise.resolve({
        ok: true,
        inbox: { id: "inbox-1", workspace_id: "ws-1", email_address: "a@example.com", provider: "gmail" },
      }),
    preview: () => Promise.resolve([]),
    noApprovalCoverage: () => Promise.resolve(new Set(covered)),
    now: () => 1_000_000,
  };
}

Deno.test("the create reply says when a new rule runs without approval", async () => {
  const { runAutomationTool } = await import("./triage-engine.ts");
  let row: Row = {};
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    insert: (r: Row) => (row = r, chain),
    maybeSingle: () => Promise.resolve({ data: { id: "rule-new", ...row }, error: null }),
  };
  const result = await runAutomationTool("create", {
    inbox_id: "inbox-1",
    name: "Forward",
    filter: { subject: "invoice" },
    rule_action: { type: "forward", to: ["ap@example.com"] },
    interval_minutes: 60,
  // deno-lint-ignore no-explicit-any
  }, deps(chain, ["rule-new"]) as any);
  // deno-lint-ignore no-explicit-any
  const payload = result.result.structuredContent as any;
  assertEquals(payload.runs_without_approval, true);
  assertEquals(payload.held_for_approval, false);
  assertEquals(payload.automation.runs_without_approval, true);
  assertStringIncludes(payload.message, "run without approval");
  assertStringIncludes(payload.message, "ap@example.com");
  assert(!/held for human approval/.test(payload.message));
});

Deno.test("automation_read says yes or no, and names nothing", async () => {
  const { runAutomationTool } = await import("./triage-engine.ts");
  const rows = [
    { id: "r1", inbox_id: "inbox-1", action: { type: "forward", to: ["a@example.com"] } },
    { id: "r2", inbox_id: "inbox-1", action: { type: "forward", to: ["b@example.com"] } },
    { id: "r3", inbox_id: "inbox-1", action: { type: "move", folder: "X" } },
  ];
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  // deno-lint-ignore no-explicit-any
  const result = await runAutomationTool("list", {}, deps(chain, ["r1"]) as any);
  // deno-lint-ignore no-explicit-any
  const list = (result.result.structuredContent as any).automations;
  assertEquals(list[0].runs_without_approval, true);
  assertEquals(list[1].runs_without_approval, false);
  assert(!("runs_without_approval" in list[2]), "a rule that does not forward says nothing");
  assertEquals(Object.keys(list[0]).sort(), ["action", "id", "inbox_id", "runs_without_approval"]);
});

Deno.test("coverage that can not be read says held", async () => {
  const { runAutomationTool } = await import("./triage-engine.ts");
  let row: Row = {};
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    insert: (r: Row) => (row = r, chain),
    maybeSingle: () => Promise.resolve({ data: { id: "rule-new", ...row }, error: null }),
  };
  const result = await runAutomationTool("create", {
    inbox_id: "inbox-1",
    name: "Forward",
    filter: { subject: "invoice" },
    rule_action: { type: "forward", to: ["ap@example.com"] },
    interval_minutes: 60,
  // deno-lint-ignore no-explicit-any
  }, { ...deps(chain), noApprovalCoverage: () => Promise.reject(new Error("db down")) } as any);
  // deno-lint-ignore no-explicit-any
  assertEquals((result.result.structuredContent as any).held_for_approval, true);
});

// ── The dispatcher ──────────────────────────────────────────────────────────

const APPROVAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba";

function recordingClient(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const eq: Array<[string, unknown]> = [];
    const is: Array<[string, unknown]> = [];
    const lte: Array<[string, unknown]> = [];
    let patch: Row | null = null;
    const settle = () => {
      const rows = (tables[table] ?? []).filter((row) =>
        eq.every(([c, v]) => row[c] === v) && is.every(([c, v]) => (row[c] ?? null) === v) &&
        lte.every(([c, v]) => String(row[c]) <= String(v))
      );
      if (patch) for (const row of rows) Object.assign(row, patch);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const builder = {
      select: () => builder,
      update: (p: Row) => (patch = p, builder),
      eq: (c: string, v: unknown) => (eq.push([c, v]), builder),
      is: (c: string, v: unknown) => (is.push([c, v]), builder),
      lt: () => builder,
      lte: (c: string, v: unknown) => (lte.push([c, v]), builder),
      order: () => builder,
      limit: () => builder,
      single: () => {
        const { data } = settle();
        return Promise.resolve(data.length ? { data: data[0], error: null } : { data: null, error: { message: "none" } });
      },
      maybeSingle: () => Promise.resolve({ data: settle().data[0] ?? null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(settle()).then(resolve, reject),
    };
    return builder;
  };
  return { from };
}

async function world() {
  const inbox = await harness.inboxRow("gmail", {});
  const now = new Date(Date.now() - 1000).toISOString();
  const tables: Record<string, Row[]> = {
    inboxes: [{ ...inbox, deleted_at: null }],
    api_keys: [{ ...harness.API_KEY, deleted_at: null }],
    send_approvals: [{
      id: APPROVAL,
      workspace_id: harness.WORKSPACE,
      inbox_id: harness.INBOX_ID,
      api_key_id: harness.API_KEY.id,
      operation: "email_forward",
      status: "approved",
      decided_at: now,
      decided_by: null,
      decided_via: "no_approval_rule",
      triage_rule_id: "rule-1",
      triage_rule_name: "Invoices",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      dispatch_scheduled_send_id: null,
      payload: { to: ["ap@example.com"], message_id: "m1", inbox_id: harness.INBOX_ID },
      payload_encrypted: false,
    }],
    scheduled_sends: [{
      id: SEND,
      workspace_id: harness.WORKSPACE,
      inbox_id: harness.INBOX_ID,
      payload: { approval_id: APPROVAL },
      payload_encrypted: false,
      send_at: now,
      status: "pending",
      created_at: now,
      updated_at: now,
      sent_at: null,
      error_detail: null,
    }],
  };
  return { inbox, tables };
}

interface Seen {
  sent: number;
  returned: Array<[string, string, string]>;
  noted: Array<[string, boolean]>;
  rechecked: number;
}

async function dispatch(
  tables: Record<string, Row[]>,
  inbox: Row,
  options: {
    recheck?: { ok: true } | { ok: false; reason: string } | null;
    outcome?: { logStatus: "success" | "error"; logErrorCode: string | null };
    throws?: Error;
    allowance?: boolean;
  },
) {
  const seen: Seen = { sent: 0, returned: [], noted: [], rechecked: 0 };
  const deps = {
    runApprovedOperation() {
      seen.sent += 1;
      if (options.throws) return Promise.reject(options.throws);
      return Promise.resolve(options.outcome ?? { logStatus: "success" as const, logErrorCode: null });
    },
    completeApprovedIdempotency: () => Promise.resolve(),
    sendViaProvider: () => Promise.reject(new Error("not used")),
    ...(options.allowance === false
      ? { reserveRuleForward: () => Promise.resolve({ allowed: false, reservationId: null }) }
      : {}),
    ...(options.recheck === null ? {} : {
      recheckNoApproval: () => {
        seen.rechecked += 1;
        return Promise.resolve(options.recheck ?? { ok: true as const });
      },
      returnNoApprovalToWaiting: (id: string, send: string, reason: string) => {
        seen.returned.push([id, send, reason]);
        const row = tables.send_approvals[0];
        Object.assign(row, { status: "pending", decided_via: null, no_approval_wait_reason: reason, dispatch_scheduled_send_id: null });
        tables.scheduled_sends[0].status = "cancelled";
        return Promise.resolve();
      },
      noteNoApprovalResult: (id: string, ok: boolean) => {
        seen.noted.push([id, ok]);
        return Promise.resolve();
      },
    }),
  };
  await harness.runTool(inbox, () => harness.json({}, 404), async () => {
    // deno-lint-ignore no-explicit-any
    const response = await server.handleScheduledDispatch(recordingClient(tables) as any, deps as any);
    return await response.json();
  });
  return seen;
}

Deno.test("a covered row goes out, once, through the dispatcher", async () => {
  const { inbox, tables } = await world();
  const seen = await dispatch(tables, inbox, {});
  assertEquals(seen.rechecked, 1, "it is checked first");
  assertEquals(seen.sent, 1);
  assertEquals(tables.scheduled_sends[0].status, "sent");
  assertEquals(tables.send_approvals[0].dispatch_scheduled_send_id, SEND, "with the same single-use binding");
  assertEquals(seen.noted, [[APPROVAL, true]]);
});

Deno.test("a key's edit of `to` puts the row back to waiting, and nothing is sent", async () => {
  const { inbox, tables } = await world();
  const seen = await dispatch(tables, inbox, { recheck: { ok: false, reason: "recipients_changed" } });
  assertEquals(seen.sent, 0, "nothing goes out");
  assertEquals(seen.returned, [[APPROVAL, SEND, "recipients_changed"]]);
  assertEquals(tables.send_approvals[0].status, "pending");
  assertEquals(tables.send_approvals[0].dispatch_scheduled_send_id, null, "and a person can still approve it");
  assertEquals(tables.scheduled_sends[0].status, "cancelled", "it is not left as a failure");
  assertEquals(seen.noted, [], "not counted as a send failure");
});

Deno.test("a brake's refusal puts it back to waiting, saying why", async () => {
  for (const code of ["daily_send_limit", "sends_frozen", "sends_paused_provider_refusals"]) {
    const { inbox, tables } = await world();
    const seen = await dispatch(tables, inbox, { outcome: { logStatus: "error", logErrorCode: code } });
    assertEquals(seen.returned, [[APPROVAL, SEND, code]], code);
    assertEquals(tables.send_approvals[0].status, "pending", code);
    assertEquals(seen.noted, [], code);
  }
});

Deno.test("the allowance running out puts it back to waiting, not to failed", async () => {
  const { inbox, tables } = await world();
  const seen = await dispatch(tables, inbox, { allowance: false });
  assertEquals(seen.sent, 0);
  assertEquals(seen.returned, [[APPROVAL, SEND, "usage_limit"]]);
});

Deno.test("a send that fails counts against the rule", async () => {
  const { inbox, tables } = await world();
  const seen = await dispatch(tables, inbox, { throws: new Error("connection reset after DATA") });
  assertEquals(tables.scheduled_sends[0].status, "error");
  assertEquals(seen.noted, [[APPROVAL, false]]);
});

Deno.test("a row a rule decided does not go without its re-check", async () => {
  const { inbox, tables } = await world();
  const seen = await dispatch(tables, inbox, { recheck: null });
  assertEquals(seen.sent, 0);
  assertEquals(tables.scheduled_sends[0].status, "pending", "held for the next tick, never sent");
});

Deno.test("a person's approval does not go through the rule's check", async () => {
  const { inbox, tables } = await world();
  Object.assign(tables.send_approvals[0], { decided_via: "dashboard", decided_by: "user-1" });
  const seen = await dispatch(tables, inbox, { recheck: { ok: false, reason: "address_not_covered" } });
  assertEquals(seen.rechecked, 0);
  assertEquals(seen.sent, 1);
  assertEquals(seen.noted, []);
});

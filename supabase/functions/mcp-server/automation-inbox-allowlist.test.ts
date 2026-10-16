// deno-lint-ignore-file no-explicit-any
/**
 * The automation tool honours the calling key's inbox allow-list, and a rule
 * runs as the key that last edited or enabled it (u07, 2026-10-16).
 *
 * The hole: loadAutomation and `list` filtered by workspace only, so a key
 * restricted to inbox X could list, read, rewrite, re-enable, disable or delete
 * a rule on inbox Y. And because the unattended runner executes a rule as its
 * stored `api_key_id`, the rewritten rule then ran with the CREATOR's authority
 * (often an unrestricted key), never the editor's.
 *
 * The fake database below applies `eq` / `is` / `in` filters for real, so a
 * row that the handler does not ask for cannot come back by accident and a
 * write that names the wrong row changes nothing. That is the whole question
 * this file asks, so the fake has to be honest about it.
 */

import {
  AUTOMATION_LOAD_COLUMNS,
  AUTOMATION_PUBLIC_COLUMNS,
  type AutomationCaller,
  type AutomationDeps,
  automationVisibleToCaller,
  checkTriageAuthority,
  runAutomationTool,
  type TriageApiKey,
} from "./triage-engine.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const WS = "ws-1";
const INBOX_X = "aaaaaaaa-0000-4000-8000-000000000001"; // work@
const INBOX_Y = "aaaaaaaa-0000-4000-8000-000000000002"; // personal@
const KEY_OWNER = "kkkkkkkk-0000-4000-8000-00000000000a"; // unrestricted, made rule on Y
const KEY_RESTRICTED = "kkkkkkkk-0000-4000-8000-00000000000b"; // only inbox X
const KEY_DASHBOARD = "kkkkkkkk-0000-4000-8000-00000000000c"; // chosen in the dashboard

const RULE_ON_Y = "11111111-1111-4111-8111-111111111111";
const RULE_ON_X = "22222222-2222-4222-8222-222222222222";
const RULE_ON_X_BY_OWNER = "33333333-3333-4333-8333-333333333333";

const ALL_SCOPES = [
  "read:email",
  "manage:folders",
  "manage:drafts",
  "send:email",
  "delete:email",
  "manage:automations",
];

const INBOXES: Record<string, { id: string; email_address: string; provider: string }> = {
  [INBOX_X]: { id: INBOX_X, email_address: "work@example.com", provider: "gmail" },
  [INBOX_Y]: { id: INBOX_Y, email_address: "personal@example.com", provider: "gmail" },
};

function seedRules(): Record<string, any[]> {
  const base = {
    workspace_id: WS,
    enabled: false,
    filter: { from: "news@example.com" },
    interval_minutes: 15,
    max_messages_per_run: 50,
    next_run_at: null,
    last_run_at: null,
    consecutive_failures: 0,
    disabled_reason: null,
    paused_reason: null,
    paused_until: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
  };
  return {
    triage_rules: [
      {
        ...base,
        id: RULE_ON_Y,
        name: "Personal newsletters",
        inbox_id: INBOX_Y,
        api_key_id: KEY_OWNER,
        action: { type: "mark_read" },
      },
      {
        ...base,
        id: RULE_ON_X,
        name: "Work newsletters",
        inbox_id: INBOX_X,
        api_key_id: KEY_RESTRICTED,
        action: { type: "mark_read" },
      },
      {
        ...base,
        id: RULE_ON_X_BY_OWNER,
        name: "Work archive",
        inbox_id: INBOX_X,
        api_key_id: KEY_OWNER,
        action: { type: "move", folder: "Archive" },
      },
    ],
    triage_runs: [
      { id: "run-y", rule_id: RULE_ON_Y, workspace_id: WS, status: "completed", started_at: "2026-10-02T00:00:00Z" },
      { id: "run-x", rule_id: RULE_ON_X, workspace_id: WS, status: "completed", started_at: "2026-10-02T00:00:00Z" },
    ],
  };
}

interface Write {
  table: string;
  op: "insert" | "update";
  patch: any;
  matched: number;
}

/** A PostgREST-shaped fake that really applies its filters. */
function filteringDb(tables: Record<string, any[]>, writes: Write[]): any {
  return {
    from(table: string) {
      const filters: Array<(row: any) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let patch: any = null;
      const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      const project = (row: any, cols: string | undefined) => {
        if (!cols || cols === "*") return { ...row };
        const out: any = {};
        for (const c of cols.split(",").map((x) => x.trim()).filter(Boolean)) out[c] = row[c];
        return out;
      };
      let columns: string | undefined;
      const apply = () => {
        if (op === "update") {
          const hit = rows();
          for (const row of hit) Object.assign(row, patch);
          writes.push({ table, op, patch, matched: hit.length });
          return hit;
        }
        return rows();
      };
      const chain: any = {
        select(cols?: string) {
          columns = cols;
          return chain;
        },
        eq(col: string, value: unknown) {
          filters.push((row) => row[col] === value);
          return chain;
        },
        is(col: string, value: unknown) {
          filters.push((row) => (row[col] ?? null) === value);
          return chain;
        },
        in(col: string, values: unknown[]) {
          filters.push((row) => values.includes(row[col]));
          return chain;
        },
        order: () => chain,
        update(p: any) {
          op = "update";
          patch = p;
          return chain;
        },
        insert(p: any) {
          op = "insert";
          patch = p;
          return chain;
        },
        limit(n: number) {
          return Promise.resolve({ data: apply().slice(0, n).map((r) => project(r, columns)), error: null });
        },
        maybeSingle() {
          if (op === "insert") {
            const row = { id: "rule-new", ...patch };
            (tables[table] ??= []).push(row);
            writes.push({ table, op, patch, matched: 1 });
            return Promise.resolve({ data: project(row, columns), error: null });
          }
          const hit = apply();
          return Promise.resolve({ data: hit[0] ? project(hit[0], columns) : null, error: null });
        },
      };
      return chain;
    },
  };
}

function callerFor(id: string, inboxIds: string[] | null, scopes = ALL_SCOPES): AutomationCaller {
  return { id, workspace_id: WS, scopes, inbox_ids: inboxIds };
}

/** resolveInbox mirroring resolveInboxArg: honours the allow-list, refuses the rest. */
function depsFor(caller: AutomationCaller, tables: Record<string, any[]>, writes: Write[]): AutomationDeps & {
  previewed: any[];
} {
  const previewed: any[] = [];
  return {
    db: filteringDb(tables, writes),
    caller,
    resolveInbox(args: Record<string, unknown>) {
      const id = typeof args["inbox_id"] === "string" ? args["inbox_id"].trim() : "";
      const inbox = INBOXES[id];
      if (!inbox || (caller.inbox_ids !== null && !caller.inbox_ids.includes(id))) {
        return Promise.resolve({ ok: false as const, message: "no inbox matches the given inbox_id/inbox." });
      }
      return Promise.resolve({ ok: true as const, inbox: { ...inbox, workspace_id: WS } as any });
    },
    preview(inbox: any, filter: any, limit: number) {
      previewed.push({ inbox, filter, limit });
      return Promise.resolve([]);
    },
    now: () => Date.parse("2026-10-16T12:00:00.000Z"),
    previewed,
  };
}

function payload(result: any): any {
  return result.result.structuredContent;
}

function rule(tables: Record<string, any[]>, id: string): any {
  return tables.triage_rules.find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

Deno.test("the load projection is exactly the public one plus api_key_id", () => {
  assertEquals(AUTOMATION_LOAD_COLUMNS, `${AUTOMATION_PUBLIC_COLUMNS}, api_key_id`, "kept in sync");
  assert(!AUTOMATION_PUBLIC_COLUMNS.includes("api_key_id"), "the public projection never names the key");
});

Deno.test("automationVisibleToCaller: null allow-list sees all, empty sees none", () => {
  assert(automationVisibleToCaller(callerFor("k", null), INBOX_Y), "unrestricted sees Y");
  assert(automationVisibleToCaller(callerFor("k", null), null), "unrestricted sees an inbox-less rule");
  assert(automationVisibleToCaller(callerFor("k", [INBOX_X]), INBOX_X), "restricted sees its own inbox");
  assert(!automationVisibleToCaller(callerFor("k", [INBOX_X]), INBOX_Y), "restricted does not see Y");
  assert(!automationVisibleToCaller(callerFor("k", [INBOX_X]), null), "nor an inbox-less rule");
  assert(!automationVisibleToCaller(callerFor("k", []), INBOX_X), "an empty allow-list sees nothing");
});

Deno.test("list returns only rules on the key's inboxes", async () => {
  const tables = seedRules();
  const writes: Write[] = [];

  const restricted = await runAutomationTool("list", {}, depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes));
  const ids = payload(restricted).automations.map((r: any) => r.id).sort();
  assertEquals(ids, [RULE_ON_X, RULE_ON_X_BY_OWNER].sort(), "restricted key sees inbox X rules only");
  assertEquals(payload(restricted).count, 2, "and the count agrees");

  const unrestricted = await runAutomationTool("list", {}, depsFor(callerFor(KEY_OWNER, null), tables, writes));
  assertEquals(payload(unrestricted).count, 3, "an unrestricted key still sees every rule");

  const empty = await runAutomationTool("list", {}, depsFor(callerFor(KEY_RESTRICTED, []), tables, writes));
  assertEquals(payload(empty).count, 0, "an empty allow-list lists nothing");
  assertEquals(writes.length, 0, "listing writes nothing");
});

Deno.test("list output never carries the key a rule runs as", async () => {
  const tables = seedRules();
  const result = await runAutomationTool("list", {}, depsFor(callerFor(KEY_OWNER, null), tables, []));
  for (const row of payload(result).automations) {
    assert(!("api_key_id" in row), "api_key_id is internal");
  }
});

// ---------------------------------------------------------------------------
// Every by-id action refuses a rule outside the allow-list, and writes nothing
// ---------------------------------------------------------------------------

const BY_ID_ACTIONS: Array<[string, Record<string, unknown>]> = [
  ["get", {}],
  ["update", { filter: { from: "x@example.com" }, rule_action: { type: "move", folder: "Junk" } }],
  ["update", { name: "renamed" }],
  ["enable", {}],
  ["disable", {}],
  ["delete", {}],
  ["runs", {}],
  ["preview", {}],
];

for (const [action, extra] of BY_ID_ACTIONS) {
  Deno.test(`${action} on a rule outside the key's allow-list is "not found" and changes nothing`, async () => {
    const tables = seedRules();
    const before = JSON.stringify(tables);
    const writes: Write[] = [];
    const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes);

    const result = await runAutomationTool(action, { automation_id: RULE_ON_Y, ...extra }, deps);

    assertEquals(result.result.isError, true, `${action} is refused`);
    assertEquals(result.logErrorCode, "not_found", `${action} answers not_found, like a missing rule`);
    const text = (result.result.content[0] as any).text as string;
    assert(!text.includes("Personal newsletters"), "the rule's name is not disclosed");
    assertEquals(writes.length, 0, `${action} writes nothing`);
    assertEquals(JSON.stringify(tables), before, `${action} leaves every row untouched`);
    assertEquals(deps.previewed.length, 0, "no mailbox is searched");
  });
}

Deno.test("the refusal is indistinguishable from a rule that does not exist", async () => {
  const tables = seedRules();
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, []);
  for (const action of ["get", "enable", "disable", "delete", "runs"]) {
    const hidden = await runAutomationTool(action, { automation_id: RULE_ON_Y }, deps);
    const missing = await runAutomationTool(action, { automation_id: "99999999-9999-4999-8999-999999999999" }, deps);
    assertEquals(JSON.stringify(hidden.result), JSON.stringify(missing.result), `${action}: same answer`);
  }
});

Deno.test("disable/delete without an inbox selector still apply the allow-list", async () => {
  // These used to skip the load entirely unless the caller passed inbox_id.
  const tables = seedRules();
  rule(tables, RULE_ON_Y).enabled = true;
  const writes: Write[] = [];
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes);

  await runAutomationTool("disable", { automation_id: RULE_ON_Y }, deps);
  await runAutomationTool("delete", { automation_id: RULE_ON_Y }, deps);

  assertEquals(rule(tables, RULE_ON_Y).enabled, true, "still enabled");
  assertEquals(rule(tables, RULE_ON_Y).deleted_at, null, "not deleted");
  assertEquals(writes.length, 0, "nothing written");
});

// ---------------------------------------------------------------------------
// update refuses when the rule's own inbox will not resolve for the caller
// ---------------------------------------------------------------------------

for (const [label, inboxRow, code, phrase] of [
  ["disconnected", { status: "error", deleted_at: null }, "inbox_disconnected", "disconnected"],
  ["revoked", { status: "revoked", deleted_at: null }, "inbox_disconnected", "disconnected"],
  ["removed", { status: "active", deleted_at: "2026-10-10T00:00:00Z" }, "inbox_removed", "removed"],
] as const) {
  Deno.test(`update on a rule whose inbox is ${label} says so, and writes nothing`, async () => {
    const tables = seedRules();
    tables.inboxes = [{ id: INBOX_Y, workspace_id: WS, ...inboxRow }];
    const writes: Write[] = [];
    const deps = depsFor(callerFor(KEY_OWNER, null), tables, writes);
    // The real resolver only accepts active, non-deleted inboxes.
    deps.resolveInbox = () => Promise.resolve({ ok: false, message: "no inbox matches the given inbox_id/inbox." });

    const result = await runAutomationTool("update", { automation_id: RULE_ON_Y, name: "renamed" }, deps);

    assertEquals(result.result.isError, true, "refused");
    assertEquals(result.logErrorCode, code, `coded ${code}`);
    const text = (result.result.content[0] as any).text as string;
    assert(text.includes(phrase), `the message says the inbox is ${phrase}`);
    assert(!text.includes("not available to this key"), "and does not blame the key");
    assertEquals(writes.length, 0, "nothing written");
    assertEquals(rule(tables, RULE_ON_Y).name, "Personal newsletters", "name unchanged");
  });
}

Deno.test("an inactive inbox outside the allow-list is still just 'not found'", async () => {
  const tables = seedRules();
  tables.inboxes = [{ id: INBOX_Y, workspace_id: WS, status: "error", deleted_at: null }];
  const writes: Write[] = [];
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes);
  const result = await runAutomationTool("update", { automation_id: RULE_ON_Y, name: "renamed" }, deps);
  assertEquals(result.logErrorCode, "not_found", "no hint that the inbox exists or is disconnected");
  const text = (result.result.content[0] as any).text as string;
  assert(!text.includes("disconnected"), "nothing about its state");
  assertEquals(writes.length, 0, "nothing written");
});

// ---------------------------------------------------------------------------
// A rule runs as the key that last edited or enabled it
// ---------------------------------------------------------------------------

Deno.test("update by a different key re-binds the rule to the editor", async () => {
  const tables = seedRules();
  const writes: Write[] = [];
  // KEY_RESTRICTED may see RULE_ON_X_BY_OWNER (inbox X), which KEY_OWNER made.
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes);

  const result = await runAutomationTool("update", { automation_id: RULE_ON_X_BY_OWNER, name: "Work archive v2" }, deps);

  assertEquals(result.result.isError, false, "the edit is allowed: the inbox is the key's own");
  assertEquals(rule(tables, RULE_ON_X_BY_OWNER).api_key_id, KEY_RESTRICTED, "the rule now runs as the editor");
  assertEquals(rule(tables, RULE_ON_X_BY_OWNER).name, "Work archive v2", "and the edit landed");
  assert(String(payload(result).message).includes("now runs as this key"), "the result says so");
  assert(!("api_key_id" in payload(result).automation), "without exposing the key id");
});

Deno.test("enable by a different key re-binds the rule to the enabler", async () => {
  const tables = seedRules();
  const writes: Write[] = [];
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes);

  const result = await runAutomationTool("enable", { automation_id: RULE_ON_X_BY_OWNER }, deps);

  assertEquals(result.result.isError, false, "enabled");
  assertEquals(rule(tables, RULE_ON_X_BY_OWNER).enabled, true, "the rule is on");
  assertEquals(rule(tables, RULE_ON_X_BY_OWNER).api_key_id, KEY_RESTRICTED, "and runs as the enabler");
  assert(String(payload(result).message).includes("now runs as this key"), "the result says so");
});

Deno.test("after a re-bind the runner checks the EDITOR's authority, not the creator's", async () => {
  const tables = seedRules();
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X], ["read:email", "manage:automations", "manage:folders"]), tables, []);
  await runAutomationTool("enable", { automation_id: RULE_ON_X_BY_OWNER }, deps);
  const stored = rule(tables, RULE_ON_X_BY_OWNER);

  const keys: Record<string, TriageApiKey> = {
    [KEY_OWNER]: { id: KEY_OWNER, scopes: ALL_SCOPES, inbox_ids: null, deleted_at: null, expires_at: null } as any,
    [KEY_RESTRICTED]: {
      id: KEY_RESTRICTED,
      scopes: ["read:email", "manage:automations"], // lost manage:folders since
      inbox_ids: [INBOX_X],
      deleted_at: null,
      expires_at: null,
    } as any,
  };
  const verdict = checkTriageAuthority(keys[stored.api_key_id], stored.inbox_id, stored.action, Date.now());
  assertEquals(verdict.ok, false, "the editor's reduced authority is what the run gets");
  assertEquals((verdict as any).error_code, "scope_denied", "the editor lost manage:folders");

  // And the editor's allow-list binds too: the same key cannot run on inbox Y.
  const elsewhere = checkTriageAuthority(
    { ...keys[KEY_RESTRICTED], scopes: ALL_SCOPES } as any,
    INBOX_Y,
    stored.action,
    Date.now(),
  );
  assertEquals((elsewhere as any).error_code, "inbox_not_permitted", "outside its allow-list it never runs");
});

Deno.test("a different key lacking the stored action's scope cannot re-bind (rename refused)", async () => {
  const tables = seedRules();
  const writes: Write[] = [];
  // Inbox X, no manage:folders: it could not run the owner's move rule itself.
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X], ["read:email", "manage:automations"]), tables, writes);

  for (const [action, extra] of [["update", { name: "hijacked" }], ["enable", {}]] as const) {
    const result = await runAutomationTool(action, { automation_id: RULE_ON_X_BY_OWNER, ...extra }, deps);
    assertEquals(result.result.isError, true, `${action} refused`);
    assertEquals(result.logErrorCode, "scope_denied", `${action}: scope_denied`);
  }
  assertEquals(writes.length, 0, "nothing written");
  assertEquals(rule(tables, RULE_ON_X_BY_OWNER).api_key_id, KEY_OWNER, "still runs as its owner");
  assertEquals(rule(tables, RULE_ON_X_BY_OWNER).name, "Work archive", "name unchanged");
});

// ---------------------------------------------------------------------------
// Legitimate flows are unchanged
// ---------------------------------------------------------------------------

Deno.test("restricted key on its own inbox: get, update, enable, runs, disable, delete all work", async () => {
  const tables = seedRules();
  const writes: Write[] = [];
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes);

  const got = await runAutomationTool("get", { automation_id: RULE_ON_X }, deps);
  assertEquals(payload(got).automation.id, RULE_ON_X, "get");
  assert(!("api_key_id" in payload(got).automation), "get never exposes the key id");

  const updated = await runAutomationTool("update", { automation_id: RULE_ON_X, name: "Work v2" }, deps);
  assertEquals(updated.result.isError, false, "update");
  assertEquals(payload(updated).message, undefined, "no re-bind note for the owning key");
  assert(!("api_key_id" in writes[writes.length - 1].patch), "the owning key's update does not touch api_key_id");

  const enabled = await runAutomationTool("enable", { automation_id: RULE_ON_X }, deps);
  assertEquals(payload(enabled).enabled, true, "enable");
  assert(!("api_key_id" in writes[writes.length - 1].patch), "nor does its enable");
  assertEquals(rule(tables, RULE_ON_X).api_key_id, KEY_RESTRICTED, "still its own key");

  const runs = await runAutomationTool("runs", { automation_id: RULE_ON_X }, deps);
  assertEquals(payload(runs).runs.map((r: any) => r.id), ["run-x"], "runs: only this rule's history");

  const preview = await runAutomationTool("preview", { automation_id: RULE_ON_X }, deps);
  assertEquals(preview.result.isError, false, "preview");
  assertEquals(deps.previewed[0].inbox.id, INBOX_X, "previewed against the rule's inbox");

  const disabled = await runAutomationTool("disable", { automation_id: RULE_ON_X }, deps);
  assertEquals(payload(disabled).enabled, false, "disable");

  const deleted = await runAutomationTool("delete", { automation_id: RULE_ON_X }, deps);
  assertEquals(payload(deleted).deleted, true, "delete");
});

Deno.test("an unrestricted key still manages every rule; same-key edits never re-bind", async () => {
  const tables = seedRules();
  const writes: Write[] = [];
  const deps = depsFor(callerFor(KEY_OWNER, null), tables, writes);

  const updated = await runAutomationTool("update", { automation_id: RULE_ON_Y, name: "Personal v2" }, deps);
  assertEquals(updated.result.isError, false, "update on Y");
  assertEquals(rule(tables, RULE_ON_Y).api_key_id, KEY_OWNER, "still its creator");
  const enabled = await runAutomationTool("enable", { automation_id: RULE_ON_Y }, deps);
  assertEquals(payload(enabled).enabled, true, "enable on Y");
  assertEquals(payload(enabled).message, undefined, "no re-bind note");
  const got = await runAutomationTool("get", { automation_id: RULE_ON_X }, deps);
  assertEquals(payload(got).automation.id, RULE_ON_X, "get on X");
});

Deno.test("create still binds the rule to the creating key and its inbox", async () => {
  const tables = seedRules();
  const writes: Write[] = [];
  const deps = depsFor(callerFor(KEY_RESTRICTED, [INBOX_X]), tables, writes);
  const created = await runAutomationTool("create", {
    inbox_id: INBOX_X,
    name: "New",
    filter: { from: "a@example.com" },
    rule_action: { type: "mark_read" },
    interval_minutes: 15,
  }, deps);
  assertEquals(created.result.isError, false, "created");
  assertEquals(writes[0].patch.api_key_id, KEY_RESTRICTED, "runs as its creator");
  assertEquals(writes[0].patch.inbox_id, INBOX_X, "on the named inbox");

  const outside = await runAutomationTool("create", {
    inbox_id: INBOX_Y,
    name: "Sneaky",
    filter: { from: "a@example.com" },
    rule_action: { type: "mark_read" },
    interval_minutes: 15,
  }, deps);
  assertEquals(outside.logErrorCode, "inbox_not_found", "create on an inbox outside the allow-list was, and is, refused");
});

Deno.test("a dashboard-made rule managed by the key the dashboard chose does not re-bind", async () => {
  // The dashboard (apps/web/app/api/automations) writes triage_rules directly
  // with an explicit api_key_id. Managing that rule over MCP with that same key
  // leaves it exactly as the dashboard set it.
  const tables = seedRules();
  tables.triage_rules.push({
    ...rule(tables, RULE_ON_X),
    id: "44444444-4444-4444-8444-444444444444",
    name: "From the dashboard",
    api_key_id: KEY_DASHBOARD,
  });
  const writes: Write[] = [];
  const deps = depsFor(callerFor(KEY_DASHBOARD, [INBOX_X]), tables, writes);
  const enabled = await runAutomationTool("enable", { automation_id: "44444444-4444-4444-8444-444444444444" }, deps);
  assertEquals(payload(enabled).enabled, true, "enabled");
  assertEquals(rule(tables, "44444444-4444-4444-8444-444444444444").api_key_id, KEY_DASHBOARD, "still the dashboard's key");
});

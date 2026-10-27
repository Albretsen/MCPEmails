// deno-lint-ignore-file no-explicit-any
/**
 * The automation card's tool, `card_automation` (mcp-app-automation.ts).
 *
 * Called by the card, assumed called by a hostile agent: it may only do what
 * `automation` get / preview / enable / disable already let the same key do,
 * on the one rule it names, idempotently. The fake database applies its
 * filters for real (the same idea as automation-inbox-allowlist.test.ts), so a
 * row the handler does not ask for cannot come back by accident.
 */

import {
  AUTOMATION_CARD,
  AUTOMATION_CARD_TOOL,
  AUTOMATION_CARD_TOOL_DEFINITION,
  automationSentence,
  describeFilter,
  runAutomationCard,
} from "./mcp-app-automation.ts";
import type { AutomationCaller, AutomationDeps } from "./triage-engine.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const WS = "ws-1";
const INBOX_X = "aaaaaaaa-0000-4000-8000-000000000001";
const INBOX_Y = "aaaaaaaa-0000-4000-8000-000000000002";
const KEY = "kkkkkkkk-0000-4000-8000-00000000000a";
const OTHER_KEY = "kkkkkkkk-0000-4000-8000-00000000000b";
const RULE = "11111111-1111-4111-8111-111111111111";
const RULE_ON_Y = "22222222-2222-4222-8222-222222222222";
const FOREIGN_RULE = "33333333-3333-4333-8333-333333333333";
const SCOPES = ["read:email", "manage:folders", "manage:automations"];

function seed(): Record<string, any[]> {
  const base = {
    workspace_id: WS,
    enabled: false,
    filter: { from: "news@example.com" },
    action: { type: "move", folder: "Newsletters" },
    interval_minutes: 60,
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
    api_key_id: KEY,
  };
  return {
    triage_rules: [
      { ...base, id: RULE, name: "Newsletters", inbox_id: INBOX_X },
      { ...base, id: RULE_ON_Y, name: "Other inbox", inbox_id: INBOX_Y },
      { ...base, id: FOREIGN_RULE, name: "Not yours", inbox_id: INBOX_X, workspace_id: "ws-2" },
    ],
  };
}

interface Write {
  table: string;
  patch: any;
  matched: number;
}

function filteringDb(tables: Record<string, any[]>, writes: Write[]): any {
  return {
    from(table: string) {
      const filters: Array<(row: any) => boolean> = [];
      let patch: any = null;
      let columns: string | undefined;
      const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      const project = (row: any) => {
        if (!columns) return { ...row };
        const out: any = {};
        for (const c of columns.split(",").map((x) => x.trim()).filter(Boolean)) out[c] = row[c];
        return out;
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
        update(p: any) {
          patch = p;
          return chain;
        },
        maybeSingle() {
          const hit = rows();
          if (patch) {
            for (const row of hit) Object.assign(row, patch);
            writes.push({ table, patch, matched: hit.length });
          }
          return Promise.resolve({ data: hit[0] ? project(hit[0]) : null, error: null });
        },
      };
      return chain;
    },
  };
}

function depsFor(
  tables: Record<string, any[]>,
  writes: Write[],
  opts: { caller?: Partial<AutomationCaller>; matches?: number; failSearch?: boolean } = {},
): AutomationDeps & { searches: number } {
  const caller: AutomationCaller = {
    id: KEY,
    workspace_id: WS,
    scopes: SCOPES,
    inbox_ids: null,
    ...opts.caller,
  };
  const deps = {
    db: filteringDb(tables, writes),
    caller,
    searches: 0,
    resolveInbox(args: Record<string, unknown>) {
      const id = String(args["inbox_id"] ?? "");
      if ((id !== INBOX_X && id !== INBOX_Y) || (caller.inbox_ids && !caller.inbox_ids.includes(id))) {
        return Promise.resolve({ ok: false as const, message: "no inbox" });
      }
      return Promise.resolve({
        ok: true as const,
        inbox: { id, workspace_id: WS, email_address: "me@example.com", provider: "imap" },
      });
    },
    preview(_inbox: unknown, _filter: unknown, limit: number) {
      deps.searches++;
      if (opts.failSearch) return Promise.reject(new Error("timeout"));
      const n = Math.min(opts.matches ?? 0, limit);
      return Promise.resolve(
        Array.from({ length: n }, (_, i) => ({
          id: `m${i}`,
          subject: `Issue ${i}`,
          from_name: "News",
          from_email: "news@example.com",
          date: "2026-10-20T00:00:00Z",
        })),
      );
    },
    now: () => Date.parse("2026-10-27T12:00:00.000Z"),
  };
  return deps;
}

const sc = (r: any) => r.result.structuredContent;

Deno.test("card_automation: name avoids the automation_ prefix route", () => {
  assert(!AUTOMATION_CARD_TOOL.startsWith("automation_"), "index.ts routes automation_* by prefix");
  assertEquals(AUTOMATION_CARD_TOOL_DEFINITION.requiredScope, "manage:automations", "scope");
  assertEquals(
    (AUTOMATION_CARD_TOOL_DEFINITION.inputSchema as any).additionalProperties,
    false,
    "unknown arguments are refused by the schema too",
  );
});

Deno.test("the rule in one sentence", () => {
  assertEquals(
    automationSentence({
      filter: { from: "news@example.com" },
      action: { type: "move", folder: "Newsletters" },
      interval_minutes: 60,
    }),
    "Move mail from news@example.com to Newsletters, every hour.",
    "move",
  );
  assertEquals(
    automationSentence({
      filter: { unread: true, subject: "Invoice", has_attachment: true },
      action: { type: "label", label: "Bills" },
      interval_minutes: 180,
    }),
    'Label unread mail with "Invoice" in the subject with attachments as "Bills", every 3 hours.',
    "label",
  );
  assertEquals(
    automationSentence({ filter: { to: "x@example.com" }, action: { type: "mark_read" }, interval_minutes: 15 }),
    "Mark mail to x@example.com as read, every 15 minutes.",
    "mark_read",
  );
  assertEquals(
    automationSentence({
      filter: { from: "a@example.com" },
      action: { type: "forward", to: ["b@example.com"] },
      interval_minutes: 1440,
    }),
    "Forward mail from a@example.com to b@example.com, each one held for approval, every day.",
    "forward says it waits for approval",
  );
  assert(describeFilter({ from: "a‮b" }).indexOf("‮") === -1, "bidi overrides are neutralised");
});

Deno.test("read: rule, sentence, inbox and a dry run", async () => {
  const tables = seed();
  const writes: Write[] = [];
  const deps = depsFor(tables, writes, { matches: 7 });
  const r = await runAutomationCard({ automation_id: RULE }, deps);
  assert(!r.result.isError, "ok");
  const env = sc(r);
  assertEquals(env.card, AUTOMATION_CARD, "card kind");
  assertEquals(env.automation.enabled, false, "off");
  assertEquals(env.automation.sentence, "Move mail from news@example.com to Newsletters, every hour.", "sentence");
  assertEquals(env.automation.inbox, "me@example.com", "inbox");
  assertEquals(env.automation.matched, 7, "count");
  assertEquals(env.automation.capped, false, "not capped");
  assertEquals(env.automation.matches.length, 5, "five listed");
  assertEquals(env.automation.matches[0], { from: "news@example.com", subject: "Issue 0" }, "sender + subject only");
  assertEquals(writes.length, 0, "a read writes nothing");
  assertEquals(deps.searches, 1, "one search");
});

Deno.test("read: nothing matches is a real answer, not an error", async () => {
  const r = await runAutomationCard({ automation_id: RULE }, depsFor(seed(), [], { matches: 0 }));
  assertEquals(sc(r).automation.matched, 0, "zero");
  assertEquals(sc(r).automation.matches, [], "empty list");
});

Deno.test("read: preview false skips the search, a failed search still shows the rule", async () => {
  const deps = depsFor(seed(), [], { matches: 3 });
  const r = await runAutomationCard({ automation_id: RULE, preview: false }, deps);
  assertEquals(deps.searches, 0, "no search");
  assert(!("matched" in sc(r).automation), "no count, the card keeps its own");
  const failed = await runAutomationCard({ automation_id: RULE }, depsFor(seed(), [], { failSearch: true }));
  assert(!failed.result.isError, "the rule still renders");
  assertEquals(sc(failed).automation.preview_failed, true, "flagged");
  assert(!("matched" in sc(failed).automation), "and no count is claimed");
});

Deno.test("switch on, then on again (idempotent), then off", async () => {
  const tables = seed();
  const writes: Write[] = [];
  const deps = depsFor(tables, writes, { matches: 2 });
  const on = await runAutomationCard({ automation_id: RULE, enabled: true }, deps);
  assertEquals(sc(on).automation.enabled, true, "on");
  assertEquals(deps.searches, 0, "a switch does not search");
  assertEquals(writes.length, 1, "one write");
  assertEquals(writes[0].matched, 1, "on that one rule");
  assertEquals(tables.triage_rules.find((r) => r.id === RULE).enabled, true, "stored");
  assertEquals(tables.triage_rules.find((r) => r.id === RULE_ON_Y).enabled, false, "the other rule untouched");

  const again = await runAutomationCard({ automation_id: RULE, enabled: true }, deps);
  assertEquals(sc(again).automation.enabled, true, "still on");
  assertEquals(writes.length, 1, "no second write");

  const off = await runAutomationCard({ automation_id: RULE, enabled: false }, deps);
  assertEquals(sc(off).automation.enabled, false, "off");
  assertEquals(sc(off).automation.note, null, "switched off by hand has no note");
  assertEquals(writes.length, 2, "one more write");
});

Deno.test("hostile: foreign workspace and allow-list both read as not found", async () => {
  const tables = seed();
  const writes: Write[] = [];
  const foreign = await runAutomationCard({ automation_id: FOREIGN_RULE, enabled: true }, depsFor(tables, writes));
  assert(foreign.result.isError === true, "refused");
  assertEquals(foreign.logErrorCode, "not_found", "not found");
  const hidden = await runAutomationCard(
    { automation_id: RULE_ON_Y, enabled: true },
    depsFor(tables, writes, { caller: { inbox_ids: [INBOX_X] } }),
  );
  assertEquals(hidden.logErrorCode, "not_found", "a rule on another inbox is invisible");
  const missing = await runAutomationCard(
    { automation_id: "44444444-4444-4444-8444-444444444444" },
    depsFor(tables, writes),
  );
  assertEquals(missing.result.content, foreign.result.content, "same words, so no existence oracle");
  assertEquals(writes.length, 0, "nothing written");
});

Deno.test("hostile: the stored action's scope is still required to switch on", async () => {
  const tables = seed();
  const writes: Write[] = [];
  const r = await runAutomationCard(
    { automation_id: RULE, enabled: true },
    depsFor(tables, writes, { caller: { scopes: ["manage:automations"] } }),
  );
  assertEquals(r.logErrorCode, "scope_denied", "a move rule needs manage:folders");
  assertEquals(writes.length, 0, "nothing written");
});

Deno.test("hostile: bad arguments are refused before any read", async () => {
  const deps = depsFor(seed(), []);
  for (
    const args of [
      null,
      [],
      {},
      { automation_id: "nope" },
      { automation_id: RULE, enabled: "yes" },
      { automation_id: RULE, filter: { from: "x" } },
      { automation_id: RULE, action: "delete" },
    ]
  ) {
    const r = await runAutomationCard(args, deps);
    assert(r.result.isError === true, `refused: ${JSON.stringify(args)}`);
    assertEquals(r.logErrorCode, "-32602", "as invalid params");
  }
  assertEquals(deps.searches, 0, "nothing searched");
});

Deno.test("an auto-disabled rule says why", async () => {
  const tables = seed();
  tables.triage_rules[0].disabled_reason = "5 consecutive failures.";
  const r = await runAutomationCard({ automation_id: RULE, preview: false }, depsFor(tables, []));
  assertEquals(sc(r).automation.note, "Turned off: 5 consecutive failures.", "note");
});

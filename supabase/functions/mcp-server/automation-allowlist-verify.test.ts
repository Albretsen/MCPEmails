// deno-lint-ignore-file no-explicit-any
/**
 * Independent verifier tests for u07 (automation inbox allow-list + re-bind).
 *
 * Each test drives the exploit from F-02-01 through a path the fixer's own
 * suite does not exercise directly: a selector naming an ALLOWED inbox on a
 * rule bound to a FORBIDDEN one, the full list -> update -> enable chain, a
 * preview by id that would leak the stored filter's matches, and the
 * draft_reply read:email half of the re-bind check. All of these fail on
 * origin/main (cec1fdee) and pass on the fix.
 */

import {
  type AutomationCaller,
  type AutomationDeps,
  runAutomationTool,
} from "./triage-engine.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

const WS = "ws-v";
const INBOX_X = "bbbbbbbb-0000-4000-8000-000000000001";
const INBOX_Y = "bbbbbbbb-0000-4000-8000-000000000002";
const KEY_OWNER = "cccccccc-0000-4000-8000-00000000000a";
const KEY_B = "cccccccc-0000-4000-8000-00000000000b";
const RULE_Y = "44444444-4444-4444-8444-444444444444";
const RULE_X_DRAFT = "55555555-5555-4555-8555-555555555555";

const INBOXES: Record<string, any> = {
  [INBOX_X]: {
    id: INBOX_X,
    email_address: "work@example.com",
    provider: "imap",
    workspace_id: WS,
  },
  [INBOX_Y]: {
    id: INBOX_Y,
    email_address: "personal@example.com",
    provider: "imap",
    workspace_id: WS,
  },
};

function seed(): Record<string, any[]> {
  const base = {
    workspace_id: WS,
    enabled: false,
    filter: { from: "bank@example.com" },
    interval_minutes: 15,
    max_messages_per_run: 25,
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
        id: RULE_Y,
        name: "Bank alerts",
        inbox_id: INBOX_Y,
        api_key_id: KEY_OWNER,
        action: { type: "mark_read" },
      },
      {
        ...base,
        id: RULE_X_DRAFT,
        name: "Auto ack",
        inbox_id: INBOX_X,
        api_key_id: KEY_OWNER,
        action: { type: "draft_reply", template: "Thanks, received." },
      },
    ],
    triage_runs: [
      {
        id: "r1",
        rule_id: RULE_Y,
        workspace_id: WS,
        status: "completed",
        started_at: "2026-10-02T00:00:00Z",
      },
    ],
  };
}

function db(tables: Record<string, any[]>, writes: any[]): any {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let patch: any = null;
      let cols: string | undefined;
      const rows = () =>
        (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const proj = (r: any) => {
        if (!cols) return { ...r };
        const o: any = {};
        for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) {
          o[c] = r[c];
        }
        return o;
      };
      const apply = () => {
        if (op === "update") {
          const hit = rows();
          for (const r of hit) Object.assign(r, patch);
          writes.push({ table, patch, matched: hit.length });
          return hit;
        }
        return rows();
      };
      const chain: any = {
        select(c?: string) {
          cols = c;
          return chain;
        },
        eq(c: string, v: unknown) {
          filters.push((r) => r[c] === v);
          return chain;
        },
        is(c: string, v: unknown) {
          filters.push((r) => (r[c] ?? null) === v);
          return chain;
        },
        in(c: string, vs: unknown[]) {
          filters.push((r) => vs.includes(r[c]));
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
          return Promise.resolve({
            data: apply().slice(0, n).map(proj),
            error: null,
          });
        },
        maybeSingle() {
          const hit = apply();
          return Promise.resolve({
            data: hit[0] ? proj(hit[0]) : null,
            error: null,
          });
        },
      };
      return chain;
    },
  };
}

function deps(
  caller: AutomationCaller,
  tables: Record<string, any[]>,
  writes: any[],
  previewed: any[],
): AutomationDeps {
  return {
    db: db(tables, writes),
    caller,
    resolveInbox(args) {
      const byId = typeof args["inbox_id"] === "string"
        ? INBOXES[args["inbox_id"] as string]
        : undefined;
      const byAddr = typeof args["inbox"] === "string"
        ? Object.values(INBOXES).find((i) => i.email_address === args["inbox"])
        : undefined;
      const inbox = byId ?? byAddr;
      if (
        !inbox ||
        (caller.inbox_ids !== null && !caller.inbox_ids.includes(inbox.id))
      ) {
        return Promise.resolve({
          ok: false as const,
          message: "no inbox matches the given inbox_id/inbox.",
        });
      }
      return Promise.resolve({ ok: true as const, inbox });
    },
    preview(inbox, filter, limit) {
      previewed.push({ inbox, filter, limit });
      return Promise.resolve([{
        id: "m1",
        subject: "Your balance",
        from_name: "Bank",
        from_email: "bank@example.com",
        date: "2026-10-10",
      }]);
    },
    now: () => Date.parse("2026-10-16T12:00:00.000Z"),
  };
}

const RESTRICTED_FULL: AutomationCaller = {
  id: KEY_B,
  workspace_id: WS,
  scopes: [
    "read:email",
    "manage:folders",
    "manage:automations",
    "delete:email",
    "send:email",
    "manage:drafts",
  ],
  inbox_ids: [INBOX_X],
};

Deno.test("verify: a selector naming the key's OWN inbox does not unlock a rule on another inbox", async () => {
  for (
    const selector of [{ inbox_id: INBOX_X }, { inbox: "work@example.com" }]
  ) {
    for (
      const [action, extra] of [
        ["get", {}],
        ["update", { name: "x" }],
        ["enable", {}],
        ["disable", {}],
        ["delete", {}],
        ["runs", {}],
      ] as const
    ) {
      const tables = seed();
      tables.triage_rules[0].enabled = true;
      const before = JSON.stringify(tables);
      const writes: any[] = [];
      const previewed: any[] = [];
      const res = await runAutomationTool(
        action,
        { automation_id: RULE_Y, ...selector, ...extra },
        deps(RESTRICTED_FULL, tables, writes, previewed),
      );
      assertEquals(
        res.result.isError,
        true,
        `${action} with ${JSON.stringify(selector)} refused`,
      );
      assertEquals(
        res.logErrorCode,
        "not_found",
        `${action}: not_found, not inbox_mismatch`,
      );
      assertEquals(writes.length, 0, `${action}: no write`);
      assertEquals(JSON.stringify(tables), before, `${action}: rows untouched`);
    }
  }
});

Deno.test("verify: preview by id with the key's own inbox as selector never runs the forbidden rule's filter", async () => {
  const tables = seed();
  const previewed: any[] = [];
  const res = await runAutomationTool(
    "preview",
    { automation_id: RULE_Y, inbox_id: INBOX_X },
    deps(RESTRICTED_FULL, tables, [], previewed),
  );
  assertEquals(res.result.isError, true, "refused");
  assertEquals(res.logErrorCode, "not_found", "as not_found");
  assertEquals(
    previewed.length,
    0,
    "the stored filter is never evaluated against any mailbox",
  );
});

Deno.test("verify: the full F-02-01 chain (list -> update to move-to-Trash -> enable) is dead", async () => {
  const tables = seed();
  const writes: any[] = [];
  const d = deps(RESTRICTED_FULL, tables, writes, []);

  const listed = await runAutomationTool("list", {}, d);
  const ids = (listed.result.structuredContent as any).automations.map((
    r: any,
  ) => r.id);
  assert(!ids.includes(RULE_Y), "step 1: the rule on personal@ is not listed");

  const upd = await runAutomationTool("update", {
    automation_id: RULE_Y,
    filter: { from: "*" },
    rule_action: { type: "move", folder: "Trash" },
  }, d);
  assertEquals(upd.result.isError, true, "step 2: rewrite refused");

  const en = await runAutomationTool("enable", { automation_id: RULE_Y }, d);
  assertEquals(en.result.isError, true, "step 3: enable refused");

  const r = tables.triage_rules[0];
  assertEquals(r.enabled, false, "rule still off");
  assertEquals(r.action, { type: "mark_read" }, "action unchanged");
  assertEquals(r.api_key_id, KEY_OWNER, "still bound to its owner");
  assertEquals(writes.length, 0, "no writes at all");
});

Deno.test("verify: re-bind of a draft_reply rule needs read:email on the editing key", async () => {
  const tables = seed();
  const writes: any[] = [];
  const noRead: AutomationCaller = {
    id: KEY_B,
    workspace_id: WS,
    scopes: ["manage:drafts", "manage:automations"],
    inbox_ids: [INBOX_X],
  };
  const res = await runAutomationTool("update", {
    automation_id: RULE_X_DRAFT,
    name: "renamed",
  }, deps(noRead, tables, writes, []));
  assertEquals(res.result.isError, true, "refused");
  assertEquals(res.logErrorCode, "scope_denied", "scope_denied");
  assert(
    String((res.result.content[0] as any).text).includes("read:email"),
    "names the missing read:email scope",
  );
  assertEquals(tables.triage_rules[1].api_key_id, KEY_OWNER, "not re-bound");
  assertEquals(writes.length, 0, "no write");
});

Deno.test("verify: disable by a different key never re-binds (switching a rule off cannot grant it new authority)", async () => {
  const tables = seed();
  tables.triage_rules[1].enabled = true;
  const res = await runAutomationTool("disable", {
    automation_id: RULE_X_DRAFT,
  }, deps(RESTRICTED_FULL, tables, [], []));
  assertEquals(res.result.isError, false, "disabled");
  assertEquals(tables.triage_rules[1].enabled, false, "off");
  assertEquals(
    tables.triage_rules[1].api_key_id,
    KEY_OWNER,
    "still bound to the owner",
  );
});

Deno.test("verify: an unrestricted owner key still sees and edits every rule without re-binding its own", async () => {
  const tables = seed();
  const owner: AutomationCaller = {
    ...RESTRICTED_FULL,
    id: KEY_OWNER,
    inbox_ids: null,
  };
  const listed = await runAutomationTool(
    "list",
    {},
    deps(owner, tables, [], []),
  );
  assertEquals(
    (listed.result.structuredContent as any).count,
    2,
    "both rules listed",
  );
  const upd = await runAutomationTool("update", {
    automation_id: RULE_Y,
    name: "Bank alerts v2",
  }, deps(owner, tables, [], []));
  assertEquals(upd.result.isError, false, "edit ok");
  assertEquals(
    tables.triage_rules[0].api_key_id,
    KEY_OWNER,
    "own rule not re-bound",
  );
  assert(
    !("message" in (upd.result.structuredContent as any)),
    "no re-bind notice for the owner's own rule",
  );
});

// ---------------------------------------------------------------------------
// Delta 8e474b4c: update names a disconnected / removed inbox
// ---------------------------------------------------------------------------

function trackingDeps(
  caller: AutomationCaller,
  tables: Record<string, any[]>,
  writes: any[],
  read: string[],
) {
  const d = deps(caller, tables, writes, []);
  const inner = d.db as any;
  (d as any).db = {
    from(t: string) {
      read.push(t);
      return inner.from(t);
    },
  };
  d.resolveInbox = () =>
    Promise.resolve({
      ok: false as const,
      message: "no inbox matches the given inbox_id/inbox.",
    });
  return d;
}

Deno.test("verify(delta): out-of-list rule never triggers an inboxes read, whatever that inbox's state", async () => {
  for (
    const state of [{ status: "error", deleted_at: null }, {
      status: "active",
      deleted_at: "2026-10-01T00:00:00Z",
    }]
  ) {
    const tables = seed();
    tables.inboxes = [{ id: INBOX_Y, workspace_id: WS, ...state }];
    const read: string[] = [];
    const res = await runAutomationTool(
      "update",
      { automation_id: RULE_Y, name: "x" },
      trackingDeps(RESTRICTED_FULL, tables, [], read),
    );
    assertEquals(res.logErrorCode, "not_found", "plain not_found");
    assert(!read.includes("inboxes"), "the inbox row is never consulted");
  }
});

Deno.test("verify(delta): restricted key, rule on its own disconnected inbox, gets inbox_disconnected and no write", async () => {
  const tables = seed();
  tables.inboxes = [{
    id: INBOX_X,
    workspace_id: WS,
    status: "error",
    deleted_at: null,
  }];
  const writes: any[] = [];
  const res = await runAutomationTool(
    "update",
    { automation_id: RULE_X_DRAFT, name: "x" },
    trackingDeps(RESTRICTED_FULL, tables, writes, []),
  );
  assertEquals(res.logErrorCode, "inbox_disconnected", "names the cause");
  assertEquals(writes.length, 0, "no write");
});

Deno.test("verify(delta): an inbox row in ANOTHER workspace is never described (reads as removed)", async () => {
  const tables = seed();
  tables.inboxes = [{
    id: INBOX_X,
    workspace_id: "other-ws",
    status: "error",
    deleted_at: null,
  }];
  const res = await runAutomationTool(
    "update",
    { automation_id: RULE_X_DRAFT, name: "x" },
    trackingDeps(RESTRICTED_FULL, tables, [], []),
  );
  assertEquals(
    res.logErrorCode,
    "inbox_removed",
    "workspace-scoped read: foreign row looks absent",
  );
});

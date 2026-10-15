// ---------------------------------------------------------------------------
// A workspace capped by its own automations, end to end through index.ts.
//
// ── Why this file exists next to allowance-gate.test.ts ────────────────────
// That file proves the DECISION against a ledger. This one proves what
// index.ts actually asks the database for when the dispatcher parks a rule
// and when a tool call is refused, in both orders: the real `handleRequest`,
// the real supabase-js client and the real query builders, against a fake
// PostgREST installed at `fetch` (the request-pipeline.test.ts method). It is
// what would catch the gate being wired to a different query on one of its
// two callers, the `period_start` filter being built wrong, or a 23505 from
// the queue's unique index being treated as a failure.
//
// The fake keeps the same three promises the tables make: the unique index on
// (workspace_id, template, period_start) answers a duplicate insert with 409
// / 23505, `record_usage_limit_event` appends an event every time and answers
// true only on the call that wrote the period's funnel row, and a paused rule
// is not due.
//
// Nothing here opens a socket (the suite runs without --allow-net), and the
// rules never reach a mailbox: a parked rule is parked before one is opened.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read automation-cap-wiring.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";

const SUPABASE_URL = "http://postgrest.example.test";
const WORKSPACE = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const INBOX = "77777777-7777-4777-8777-777777777777";
const TOKEN = `mcpe_${"a".repeat(64)}`;
const DISPATCH_SECRET = "dispatch-secret-placeholder";
// As Postgres serialises a timestamptz: the "+" is the part a hand-built
// query string would turn into a space.
const PERIOD_START = "2026-10-01T00:00:00+00:00";
const PERIOD_END = "2026-11-01T00:00:00+00:00";

type Row = Record<string, unknown>;

interface Call {
  label: string;
  method: string;
  target: string;
  query: URLSearchParams;
  body: Row | null;
}

interface World {
  allowance: Row;
  rules: Row[];
  /** `usage_limit_events` rows. */
  limitEvents: Row[];
  /** True once the period's `paywall_reached` funnel row exists. */
  paywallReached: boolean;
  /** `billing_email_sends` rows the unique index accepted. */
  emails: Row[];
  /** Inserts it refused with 23505. */
  duplicateEmailInserts: number;
  calls: Call[];
  inserted: Record<string, Row[]>;
}

function freeAllowance(overrides: Row = {}): Row {
  return {
    plan: "free",
    owner_id: OWNER,
    exempt: false,
    exempt_reason: null,
    cap: 150,
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    grace_ends_at: "2026-09-20T00:00:00+00:00",
    in_grace: false,
    used: 150,
    remaining: 0,
    ...overrides,
  };
}

function dueRule(id: string): Row {
  return {
    id,
    workspace_id: WORKSPACE,
    inbox_id: INBOX,
    api_key_id: KEY_ID,
    name: `Rule ${id}`,
    enabled: true,
    filter: { from: "news@example.com" },
    action: { type: "move", folder: "Newsletters" },
    interval_minutes: 15,
    max_messages_per_run: 25,
    next_run_at: "2026-10-02T00:00:00+00:00",
    running_since: null,
    consecutive_failures: 0,
    paused_reason: null,
    paused_until: null,
  };
}

function world(overrides: Partial<World> = {}): World {
  return {
    allowance: freeAllowance(),
    rules: [dueRule("aaaaaaaa-0000-4000-8000-000000000001")],
    limitEvents: [],
    paywallReached: false,
    emails: [],
    duplicateEmailInserts: 0,
    calls: [],
    inserted: {},
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The fake PostgREST
// ═══════════════════════════════════════════════════════════════════════════

let current: World = world();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** PostgREST filter value: `eq.abc` -> `abc`. */
function filterValue(query: URLSearchParams, column: string, operator: string): string | null {
  const raw = query.get(column);
  return raw?.startsWith(`${operator}.`) ? raw.slice(operator.length + 1) : null;
}

function answer(w: World, call: Call, wantsObject: boolean): Response {
  const { method, target, query, body } = call;
  const one = (row: Row | null) => {
    if (!wantsObject) return json(row ? [row] : []);
    return row ? json(row) : json(
      { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "no rows" },
      406,
    );
  };

  // ── The allowance ────────────────────────────────────────────────────────
  if (target === "rpc/workspace_action_allowance") return one(w.allowance);
  if (target === "rpc/reserve_action_usage") {
    const used = w.allowance.used as number;
    const cap = body?.p_cap as number;
    return one(used >= cap
      ? { reservation_id: null, allowed: false, used_actions: used }
      : { reservation_id: "88888888-8888-4888-8888-888888888888", allowed: true, used_actions: used + 1 });
  }
  if (target === "rpc/record_usage_limit_event") {
    w.limitEvents.push({ ...body, occurred_at: PERIOD_START });
    const first = !w.paywallReached;
    w.paywallReached = true;
    return json(first);
  }
  if (target === "usage_limit_events" && method === "GET") {
    const since = filterValue(query, "occurred_at", "gte");
    // An unparseable bound is what a mangled "+" would produce; answer as
    // PostgREST would, with an error, so the test fails loudly.
    if (!since || Number.isNaN(Date.parse(since)) || since.includes(" ")) {
      return json({ code: "22007", message: `invalid input syntax for type timestamp: "${since}"` }, 400);
    }
    const rows = w.limitEvents.filter((row) =>
      row.p_workspace_id === filterValue(query, "workspace_id", "eq") &&
      Date.parse(row.occurred_at as string) >= Date.parse(since)
    );
    return json(rows.slice(0, 1).map(() => ({ id: "event" })));
  }
  if (target === "billing_email_sends" && method === "GET") {
    const period = filterValue(query, "period_start", "eq");
    if (!period || period.includes(" ")) {
      return json({ code: "22007", message: `invalid input syntax for type timestamp: "${period}"` }, 400);
    }
    const rows = w.emails.filter((row) =>
      row.workspace_id === filterValue(query, "workspace_id", "eq") &&
      row.template === filterValue(query, "template", "eq") &&
      Date.parse(row.period_start as string) === Date.parse(period) &&
      query.get("cancelled_at") === "is.null"
    );
    return json(rows.slice(0, 1).map(() => ({ id: 1 })));
  }
  if (target === "billing_email_sends" && method === "POST") {
    const taken = w.emails.some((row) =>
      row.workspace_id === body?.workspace_id && row.template === body?.template &&
      row.period_start === body?.period_start
    );
    if (taken) {
      w.duplicateEmailInserts++;
      return json({
        code: "23505",
        details: null,
        hint: null,
        message: 'duplicate key value violates unique constraint "billing_email_sends_workspace_template_period_idx"',
      }, 409);
    }
    w.emails.push(body ?? {});
    return new Response(null, { status: 201 });
  }
  if (target === "users" && method === "GET") return one({ email: "owner@example.com" });

  // ── The dispatcher's own tables ──────────────────────────────────────────
  if (target === "triage_rules" && method === "GET") {
    // The stale-lease sweep asks for leased rules; nothing here is stale.
    if (query.get("running_since") !== "is.null") return json([]);
    return json(w.rules.filter((rule) => rule.enabled && !rule.running_since && !rule.paused_until));
  }
  if (target === "triage_rules" && method === "PATCH") {
    const rule = w.rules.find((row) => row.id === filterValue(query, "id", "eq"));
    if (!rule) return json([]);
    const claiming = typeof body?.running_since === "string";
    if (claiming && (rule.running_since || rule.paused_until)) return json([]);
    Object.assign(rule, body ?? {});
    return claiming ? json([{ id: rule.id }]) : new Response(null, { status: 204 });
  }
  if (target === "triage_runs" && method === "POST") return one({ id: "99999999-9999-4999-8999-999999999999" });

  // ── What an interactive tools/call reads before its handler ──────────────
  if (target === "api_keys" && method === "GET") {
    // Authentication looks a key up by hash. The runner's own lookup is by id,
    // and answers nothing: no test here lets a rule get as far as a mailbox.
    const hash = filterValue(query, "key_hash", "eq");
    return one(hash
      ? {
        id: KEY_ID,
        workspace_id: WORKSPACE,
        created_by: OWNER,
        name: "Wiring test key",
        key_prefix: "mcpe_aaa",
        key_hash: hash,
        scopes: ["read:email", "manage:automations"],
        inbox_ids: null,
        expires_at: null,
        last_used_at: "2026-09-01T00:00:00.000Z",
        deleted_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
      }
      : null);
  }
  if (target === "activity_log" && (method === "HEAD" || method === "GET")) {
    if (query.has("order")) return json([{ created_at: new Date(Date.now() - 30_000).toISOString() }]);
    return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
  }
  if (target === "workspaces" && method === "GET") {
    return one({
      id: WORKSPACE,
      plan: w.allowance.plan,
      grandfathered: false,
      owner_id: OWNER,
      analytics_first_tool_used_at: "2026-09-02T00:00:00.000Z",
      onboarding_value_activated_at: "2026-09-02T00:05:00.000Z",
    });
  }
  if (target.startsWith("rpc/")) return new Response(null, { status: 204 });
  if (method === "POST") {
    (w.inserted[target] ??= []).push(body ?? {});
    return new Response(null, { status: 201 });
  }
  if (method === "GET") return wantsObject ? one(null) : json([]);
  return new Response(null, { status: 204 });
}

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const w = current;
  const url = new URL(input instanceof Request ? input.url : String(input));
  const prefix = `${SUPABASE_URL}/rest/v1/`;
  if (!url.href.startsWith(prefix)) {
    return Promise.reject(new Error(`automation-cap-wiring.test: unexpected network call to ${url.origin}`));
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const target = url.pathname.slice("/rest/v1/".length);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const call: Call = {
    label: target.startsWith("rpc/") ? `RPC ${target.slice(4)}` : `${method} ${target}`,
    method,
    target,
    query: url.searchParams,
    body: typeof init?.body === "string" ? JSON.parse(init.body) as Row : null,
  };
  w.calls.push(call);
  // An answer never arrives in the turn that asked for it; no network does.
  return sleep(0).then(() => answer(w, call, (headers.get("accept") ?? "").includes("vnd.pgrst.object")));
}

// ── Boot the real server against the fake ──────────────────────────────────
// Same sequence, for the same reasons, as request-pipeline.test.ts.
globalThis.fetch = fakeFetch as typeof fetch;

const ENV_FOR_IMPORT: Record<string, string | null> = {
  MCP_INTROSPECTION_ONLY: null,
  MCP_SERVER_NO_LISTEN: "1",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
};
function applyEnv(values: Record<string, string | null>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === null) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
}
function envSnapshot(names: string[]): Record<string, string | null> {
  return Object.fromEntries(names.map((name) => [name, Deno.env.get(name) ?? null]));
}
const envBefore = envSnapshot(Object.keys(ENV_FOR_IMPORT));
applyEnv(ENV_FOR_IMPORT);
const { handleRequest } = await import("./index.ts");
applyEnv(envBefore);

// ═══════════════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════════════

/** Run `body` with the server's logging silenced and the environment set. */
async function withServer<T>(w: World, env: Record<string, string | null>, body: () => Promise<T>): Promise<T> {
  current = w;
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const errors: unknown[][] = [];
  console.log = console.info = console.warn = () => {};
  console.error = (...args: unknown[]) => void errors.push(args);
  const names = ["DISPATCH_SECRET", "USAGE_ENFORCEMENT_DISABLED", ...Object.keys(env)];
  const before = envSnapshot(names);
  applyEnv({ DISPATCH_SECRET, USAGE_ENFORCEMENT_DISABLED: null, ...env });
  try {
    const result = await body();
    // Fire-and-forget writes (the key's last_used_at) land with their request.
    await sleep(10);
    const allowanceErrors = errors.filter((args) =>
      typeof args[0] === "string" && /usage_|allowance|reservation/.test(args[0])
    );
    assertEquals(allowanceErrors, [], "nothing on the allowance path may log an error in these scenarios");
    return result;
  } finally {
    Object.assign(console, original);
    applyEnv(before);
  }
}

/** One dispatcher invocation, as pg_cron's net.http_post makes it. */
function dispatch(w: World, env: Record<string, string | null> = {}): Promise<Row> {
  return withServer(w, env, async () => {
    const response = await handleRequest(
      new Request("http://edge.example.test/mcp-server/triage-dispatch", {
        method: "POST",
        headers: { "x-dispatch-secret": DISPATCH_SECRET, "content-type": "application/json" },
        body: "{}",
      }),
    );
    assertEquals(response.status, 200);
    return await response.json() as Row;
  });
}

/** One billable tool call from a connected client. */
function toolCall(w: World, env: Record<string, string | null> = {}): Promise<Row> {
  return withServer(w, env, async () => {
    const response = await handleRequest(
      new Request("http://edge.example.test/mcp-server", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "user-agent": "wiring-test/1.0",
          "x-forwarded-for": "203.0.113.7",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "signature_get", arguments: { inbox_id: INBOX } },
        }),
      }),
    );
    return await response.json() as Row;
  });
}

const labels = (w: World) => w.calls.map((call) => call.label);
const count = (w: World, label: string) => labels(w).filter((l) => l === label).length;
const emailsOf = (w: World, template: string) => w.emails.filter((row) => row.template === template);
// deno-lint-ignore no-explicit-any
const refused = (body: any) => body?.result?._meta?.["com.mcpemails/usage_limit"]?.error_code === "usage_limit_reached";

// ═══════════════════════════════════════════════════════════════════════════
// The pre-run pause
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a parked rule writes the cap event, the funnel row and the limit notice, and no per-rule notice", async () => {
  const w = world();

  const body = await dispatch(w);

  assertEquals(body.paused, 1);
  assertEquals(body.ran, 0);

  // The event, through the SAME RPC a refused tool call uses, with the row's numbers.
  assertEquals(count(w, "RPC record_usage_limit_event"), 1);
  const event = w.calls.find((call) => call.label === "RPC record_usage_limit_event")!;
  assertEquals(event.body, {
    p_workspace_id: WORKSPACE,
    p_plan: "free",
    p_used_actions: 150,
    p_cap: 150,
    p_meter_version: 1,
    p_period_start: PERIOD_START,
  });

  // The notice, through the same queue insert, to the owner resolved at queue time.
  assertEquals(w.emails.length, 1, "one row in billing_email_sends");
  const notice = w.emails[0];
  assertEquals(notice.template, "usage_limit_reached");
  assertEquals(notice.workspace_id, WORKSPACE);
  assertEquals(notice.user_id, OWNER);
  assertEquals(notice.recipient, "owner@example.com");
  assertEquals(notice.scope_key, PERIOD_START);
  assertEquals(notice.period_start, PERIOD_START);
  assertEquals(notice.payload, {
    used: 150, cap: 150, period_start: PERIOD_START, period_end: PERIOD_END, plan: "free",
  }, "what the template needs for its numbers and its reset date");

  // The rule itself is parked exactly as before.
  assertEquals(w.rules[0].paused_reason, "plan_limit");
  assertEquals(w.rules[0].paused_until, PERIOD_END);
  assertEquals(w.rules[0].running_since, null, "the lease is handed back");
  assertEquals(count(w, "POST triage_runs"), 0, "no run was started, no mailbox opened");

  // Order: the cap is recorded before the rule is paused, so the per-rule
  // notice finds the limit notice already queued and stands down.
  const order = labels(w);
  assert(
    order.indexOf("RPC record_usage_limit_event") < order.lastIndexOf("PATCH triage_rules"),
    "recorded before the pause is written",
  );
  assertEquals(emailsOf(w, "automation_paused_limit").length, 0);
  assertEquals(w.duplicateEmailInserts, 0);
});

Deno.test("three rules parked in one cycle: one event, one funnel row, one notice", async () => {
  const w = world({
    rules: [
      dueRule("aaaaaaaa-0000-4000-8000-000000000001"),
      dueRule("aaaaaaaa-0000-4000-8000-000000000002"),
      dueRule("aaaaaaaa-0000-4000-8000-000000000003"),
    ],
  });

  const body = await dispatch(w);

  assertEquals(body.paused, 3);
  assertEquals(count(w, "RPC record_usage_limit_event"), 1, "the second and third rule find the event and skip");
  assertEquals(count(w, "GET usage_limit_events"), 3, "each one asks");
  assertEquals(w.emails.map((row) => row.template), ["usage_limit_reached"]);
  assertEquals(count(w, "POST billing_email_sends"), 1, "not even a refused insert for the others");

  // A second cycle a minute later has nothing due and writes nothing.
  const before = w.calls.length;
  const again = await dispatch(w);
  assertEquals(again.due, 0, "paused rules are not due");
  assertEquals(count(w, "RPC record_usage_limit_event"), 1);
  assert(w.calls.length > before, "the cycle did run");
});

Deno.test("last period's cap does not stand in for this one", async () => {
  // Capped in September too. The once-per-period guard reads events since
  // THIS period's start, so October is recorded and notified afresh.
  const w = world({
    limitEvents: [{ p_workspace_id: WORKSPACE, occurred_at: "2026-09-25T10:00:00+00:00" }],
    emails: [{
      workspace_id: WORKSPACE,
      template: "usage_limit_reached",
      period_start: "2026-09-01T00:00:00+00:00",
      cancelled_at: null,
    }],
  });

  await dispatch(w);

  assertEquals(count(w, "RPC record_usage_limit_event"), 1, "October's cap is its own event");
  const lookup = w.calls.find((call) => call.label === "GET usage_limit_events")!;
  assertEquals(lookup.query.get("occurred_at"), `gte.${PERIOD_START}`, "bounded by the allowance row's period_start");
  assertEquals(lookup.query.get("workspace_id"), `eq.${WORKSPACE}`);
  assertEquals(
    w.emails.map((row) => [row.template, row.period_start]),
    [["usage_limit_reached", "2026-09-01T00:00:00+00:00"], ["usage_limit_reached", PERIOD_START]],
    "and its own notice",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Either order
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("automations first, then a refused tool call: still one notice", async () => {
  const w = world();
  await dispatch(w);
  assertEquals(emailsOf(w, "usage_limit_reached").length, 1);

  const body = await toolCall(w);

  assert(refused(body), "the tool call is refused with the usual result");
  assertEquals(count(w, "RPC record_usage_limit_event"), 2, "a refused call is always an event");
  assertEquals(emailsOf(w, "usage_limit_reached").length, 1, "the owner was already told");
  assertEquals(count(w, "POST billing_email_sends"), 1, "and no second insert is attempted");
});

Deno.test("a refused tool call first, then automations: nothing more is written", async () => {
  const w = world();
  const body = await toolCall(w);
  assert(refused(body));
  assertEquals(count(w, "RPC record_usage_limit_event"), 1);
  assertEquals(emailsOf(w, "usage_limit_reached").length, 1, "queued by the interactive path");
  assertEquals(w.emails[0].payload, {
    used: 150, cap: 150, period_start: PERIOD_START, period_end: PERIOD_END, plan: "free",
  }, "the payload the automation path must match");

  const dispatched = await dispatch(w);

  assertEquals(dispatched.paused, 1, "the rule is parked");
  assertEquals(count(w, "RPC record_usage_limit_event"), 1, "the workspace was already counted this period");
  assertEquals(w.emails.length, 1, "no second limit notice and no per-rule notice");
  assertEquals(count(w, "POST billing_email_sends"), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// The fallback, and the unique index doing its job
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("with the period's funnel row already taken, the per-rule notice goes once and the 23505 is quiet", async () => {
  // E.g. the inbox paywall wrote `paywall_reached` earlier in the period: the
  // RPC answers false, so no limit notice is due from this event.
  const w = world({
    paywallReached: true,
    rules: [dueRule("aaaaaaaa-0000-4000-8000-000000000001"), dueRule("aaaaaaaa-0000-4000-8000-000000000002")],
  });

  await dispatch(w);

  assertEquals(count(w, "RPC record_usage_limit_event"), 1, "the cap is recorded all the same");
  assertEquals(w.emails.map((row) => row.template), ["automation_paused_limit"]);
  assertEquals(w.emails[0].scope_key, "aaaaaaaa-0000-4000-8000-000000000001");
  assertEquals(w.emails[0].period_start, PERIOD_START);
  assertEquals((w.emails[0].payload as Row).rule_name, "Rule aaaaaaaa-0000-4000-8000-000000000001");
  assertEquals(w.duplicateEmailInserts, 1, "the second rule's insert is refused by the unique index");
  // withServer already asserted that the refused insert logged no error.
});

// ═══════════════════════════════════════════════════════════════════════════
// Who gets nothing
// ═══════════════════════════════════════════════════════════════════════════

const QUIET: Array<[string, Row]> = [
  ["a Free workspace under the cap", freeAllowance({ used: 40, remaining: 110 })],
  ["an early member", freeAllowance({ exempt: true, exempt_reason: "early_member", cap: null, remaining: null })],
  ["a Free workspace in its first week", freeAllowance({ in_grace: true, used: 0, remaining: 150 })],
  ["a paid workspace under its ceiling", freeAllowance({ plan: "personal", cap: 25_000, used: 300, remaining: 24_700 })],
];

for (const [name, allowance] of QUIET) {
  Deno.test(`${name}: the dispatcher records no cap and queues no email`, async () => {
    const w = world({ allowance });

    const body = await dispatch(w);

    assertEquals(body.paused, 0, "the rule is not parked");
    assertEquals(count(w, "RPC workspace_action_allowance"), 1, "the allowance was consulted");
    assertEquals(count(w, "GET usage_limit_events"), 0);
    assertEquals(count(w, "RPC record_usage_limit_event"), 0);
    assertEquals(count(w, "POST billing_email_sends"), 0);
    assertEquals(w.rules[0].paused_reason, null);
  });
}

Deno.test("the kill switch covers the unattended path: no pause, no event, no email, no allowance read", async () => {
  const w = world();

  const body = await dispatch(w, { USAGE_ENFORCEMENT_DISABLED: "true" });

  assertEquals(body.paused, 0, "an exhausted allowance parks nothing while enforcement is off");
  assertEquals(count(w, "RPC workspace_action_allowance"), 0);
  assertEquals(count(w, "GET usage_limit_events"), 0);
  assertEquals(count(w, "RPC record_usage_limit_event"), 0);
  assertEquals(count(w, "POST billing_email_sends"), 0);
  assertEquals(w.rules[0].paused_reason, null);

  // And the same switch on the interactive side, for symmetry.
  const call = await toolCall(w, { USAGE_ENFORCEMENT_DISABLED: "true" });
  assert(!refused(call), "the tool call is not refused either");
  assertEquals(count(w, "RPC record_usage_limit_event"), 0);
});

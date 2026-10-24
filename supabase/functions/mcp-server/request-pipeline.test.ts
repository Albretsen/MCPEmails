// ---------------------------------------------------------------------------
// What a tools/call costs around its handler, and the order it pays in.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// Measured 2026-10-02: every tools/call spent about 2.1 s outside the logged
// `duration_ms`, in roughly 15 database round trips issued one after another
// (the function runs in us-east-1, the database in Europe, about 124 ms each).
// The fix overlaps the reads in front of the handler and settles the writes
// behind the response. Both are exactly the kind of change that can quietly
// reorder a security check, so this file pins the ORDER as hard as the count:
//
//   * nothing at all happens before authentication has answered;
//   * a tools/call asks for the key and every gate read in ONE round trip
//     (mcp_tools_call_preflight, 2026-10-20), and when that RPC fails the
//     per-query path runs instead and decides exactly the same;
//   * on that path the per-key limiter, the plan quota and the allowance READ
//     overlap, and no tool work and no reservation starts until both gates
//     have passed;
//   * a rate-limited call reserves nothing and meters nothing;
//   * a capped call records its refusal and never reaches the handler;
//   * the idempotency ledger is claimed and settled in front of the response,
//     never behind it;
//   * every call that ran leaves exactly one activity_log row, with or
//     without a background hook, and a failed write is logged, not thrown;
//   * an activated workspace costs zero first-use round trips.
//
// ── HOW ────────────────────────────────────────────────────────────────────
// The real `handleRequest`, the real supabase-js client and the real query
// builders, against a fake PostgREST installed at `fetch`. One fetch is one
// round trip, so the counts below are the counts production pays. The fake can
// WITHHOLD its answers: with every response held back, the set of requests in
// flight is exactly what the code issued without waiting for anything, and
// releasing them wave by wave reads the pipeline's serial depth directly.
// Nothing here opens a socket (the suite runs without --allow-net).
//
// index.ts is imported WITHOUT MCP_INTROSPECTION_ONLY, because introspection
// mode skips authentication and all three checks, which is the whole subject.
// The environment is put back the moment the import has run.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read request-pipeline.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { firstUseAlreadyRecorded, settleAfterResponse } from "./request-pipeline.ts";
import { preflightAvailability } from "./tools-call-preflight.ts";

const SUPABASE_URL = "http://postgrest.example.test";
const WORKSPACE = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const INBOX = "77777777-7777-4777-8777-777777777777";
const RESERVATION = "88888888-8888-4888-8888-888888888888";
/** The id of a reservation the gate RPC made, distinct so a test can tell the two apart. */
const GATE_RESERVATION = "99999999-9999-4999-8999-999999999999";
const TOKEN = `mcpe_${"a".repeat(64)}`;

type Row = Record<string, unknown>;

/** One round trip, as the code under test issued it. */
interface Call {
  /** `GET inboxes`, `HEAD activity_log[api_key_id]`, `RPC reserve_action_usage`, ... */
  label: string;
  method: string;
  target: string;
  query: URLSearchParams;
  body: Row | null;
  /** Positions on one shared clock, so overlap is a comparison, not a guess. */
  startedAt: number;
  finishedAt: number | null;
}

/** The database the fake answers from, and everything written to it. */
interface World {
  /** null answers the key lookup with no row: unknown, revoked or expired. */
  key: Row | null;
  workspace: Row;
  /** The workspace row is gone: both plan-quota paths fail open on it. */
  workspaceMissing: boolean;
  /** The owner's user_usage_entitlements row, if any. */
  entitlement: Row | null;
  allowance: Row;
  inboxes: Row[];
  /** activity_log rows per key in the trailing minute / hour / day. */
  keyCounts: { minute: number; hour: number; day: number };
  /** activity_log rows for the workspace in the trailing minute. */
  workspaceCount: number;
  reserve: { allowed: boolean; used_actions: number };
  /**
   * Every reservation made, by the gate RPC or by reserve_action_usage, and
   * what became of it. A call must end with nothing `held`.
   */
  ledger: Array<{ id: string; tool: string; via: "gate" | "rpc"; state: "held" | "finalized" | "released" }>;
  /** Make the gate reserve under different terms than the allowance row says (SQL/TS drift). */
  gateTerms: Row | null;
  /** Make reserve_action_usage raise inside the gate. */
  gateReserveError: boolean;
  /** Cheap-method buckets (`min`, `hr`) whose rate_limit_check answers false. */
  bucketsOver: string[];
  /** Withhold every answer until the test opens it. */
  hold: boolean;
  /** Withhold only these round trips, by label; everything else answers at once. */
  holdOnly: string[];
  /**
   * Make one target's round trip fail: an HTTP 500, a rejected fetch, a
   * PostgREST "no such function" (the migration is not applied), or a 200
   * whose body is not the shape the caller expects.
   */
  fail: Record<string, "http_500" | "reject" | "missing" | "malformed">;
  calls: Call[];
  held: Array<{ call: Call; open: () => void }>;
  inserted: Record<string, Row[]>;
  clock: number;
}

function world(overrides: Partial<World> = {}): World {
  return {
    key: {
      id: KEY_ID,
      workspace_id: WORKSPACE,
      created_by: OWNER,
      name: "Pipeline test key",
      key_prefix: "mcpe_aaa",
      scopes: [
        "read:email", "send:email", "delete:email", "schedule:email",
        "manage:drafts", "manage:folders", "manage:contacts", "manage:automations",
      ],
      inbox_ids: null,
      expires_at: null,
      last_used_at: "2026-09-01T00:00:00.000Z",
      deleted_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
    },
    workspace: activatedWorkspace(),
    workspaceMissing: false,
    entitlement: null,
    allowance: meteredAllowance(),
    inboxes: [{
      id: INBOX,
      workspace_id: WORKSPACE,
      provider: "imap",
      service: "generic",
      email_address: "someone@example.com",
      display_name: "Someone",
      status: "active",
      deleted_at: null,
      signature_html: null,
      signature_text: null,
      signature_enabled: false,
      signature_reply_mode: "always",
      signature_source: null,
      signature_updated_at: null,
      send_approval_required: false,
    }],
    keyCounts: { minute: 0, hour: 0, day: 0 },
    workspaceCount: 0,
    reserve: { allowed: true, used_actions: 12 },
    ledger: [],
    gateTerms: null,
    gateReserveError: false,
    bucketsOver: [],
    hold: false,
    holdOnly: [],
    fail: {},
    calls: [],
    held: [],
    inserted: {},
    clock: 0,
    ...overrides,
  };
}

/** A workspace that made its first tool call, and its first mailbox call, long ago. */
function activatedWorkspace(overrides: Row = {}): Row {
  return {
    id: WORKSPACE,
    plan: "personal",
    grandfathered: false,
    owner_id: OWNER,
    analytics_first_tool_used_at: "2026-09-02T00:00:00.000Z",
    onboarding_value_activated_at: "2026-09-02T00:05:00.000Z",
    ...overrides,
  };
}

/** `workspace_action_allowance()` for a workspace that IS metered. */
function meteredAllowance(overrides: Row = {}): Row {
  return {
    plan: "personal",
    owner_id: OWNER,
    exempt: false,
    exempt_reason: null,
    cap: 25_000,
    period_start: "2026-10-01T00:00:00.000Z",
    period_end: "2026-11-01T00:00:00.000Z",
    grace_ends_at: null,
    in_grace: false,
    used: 11,
    remaining: 24_989,
    ...overrides,
  };
}

/** The same row for an early member: never metered, never reserved against. */
function exemptAllowance(): Row {
  return meteredAllowance({ exempt: true, exempt_reason: "early_member", cap: null, remaining: null });
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
function eqValue(query: URLSearchParams, column: string): string | null {
  const raw = query.get(column);
  return raw?.startsWith("eq.") ? raw.slice(3) : null;
}

function labelOf(method: string, target: string, query: URLSearchParams): string {
  if (target.startsWith("rpc/")) return `RPC ${target.slice(4)}`;
  if (target === "activity_log" && method !== "POST") {
    return `${method} activity_log[${query.has("api_key_id") ? "api_key_id" : "workspace_id"}]`;
  }
  return `${method} ${target}`;
}

/** activity_log rows for the key since `since`, bucketed the way World holds them. */
function keyCountSince(w: World, since: string): number {
  const age = Date.now() - Date.parse(since);
  return age < 120_000 ? w.keyCounts.minute : age < 7_200_000 ? w.keyCounts.hour : w.keyCounts.day;
}

/** What PostgREST would answer. Applies the filters the pipeline depends on. */
function answer(w: World, call: Call, wantsObject: boolean): Response {
  const { method, target, query, body } = call;
  const one = (row: Row | null) => {
    if (!wantsObject) return json(row ? [row] : []);
    return row ? json(row) : json(
      { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "no rows" },
      406,
    );
  };

  if (target === "api_keys" && method === "GET") {
    // The row carries the hash it was looked up by, as the real table does.
    return one(w.key ? { ...w.key, key_hash: eqValue(query, "key_hash") } : null);
  }
  if (target === "activity_log" && (method === "HEAD" || method === "GET")) {
    if (query.has("order")) return json([{ created_at: new Date(Date.now() - 30_000).toISOString() }]);
    let count = w.workspaceCount;
    if (query.has("api_key_id")) {
      count = keyCountSince(w, (query.get("created_at") ?? "").replace(/^gte\./, ""));
    }
    return new Response(null, { status: 200, headers: { "content-range": `*/${count}` } });
  }
  if (target === "workspaces" && method === "GET") return one(w.workspaceMissing ? null : w.workspace);
  if (target === "user_usage_entitlements" && method === "GET") return one(w.entitlement);
  if (target === "rpc/mcp_tools_call_gate") {
    // Migration 20261020214737: the same rows and counts the per-query path
    // reads, from the same World, so the two paths answer identically; plus
    // the reservation, made by the same rule the SQL applies.
    const params = body ?? {};
    if (!w.key) return json({ key: null });
    const workspace = w.workspaceMissing ? null : {
      plan: w.workspace.plan,
      grandfathered: w.workspace.grandfathered,
      owner_id: w.workspace.owner_id,
      analytics_first_tool_used_at: w.workspace.analytics_first_tool_used_at,
      onboarding_value_activated_at: w.workspace.onboarding_value_activated_at,
      card_diagnostics: w.workspace.card_diagnostics ?? false,
    };
    // The terms only: the gate does not count usage.
    const allowance = params.p_include_allowance ? { ...w.allowance, used: null, remaining: null } : null;
    let reservation: Row | null = null;
    const a = w.allowance;
    const metered = !a.exempt && !a.in_grace && a.cap !== null &&
      Date.parse(a.period_start as string) < Date.parse(a.period_end as string);
    if (params.p_include_allowance && typeof params.p_reserve_tool_name === "string" && metered) {
      const terms = { cap: a.cap, period_start: a.period_start, period_end: a.period_end, ...(w.gateTerms ?? {}) };
      if (w.gateReserveError) {
        reservation = { tool_name: params.p_reserve_tool_name, meter_version: params.p_meter_version, ...terms, error: "boom", error_code: "XX000" };
      } else {
        if (w.reserve.allowed) {
          w.ledger.push({ id: GATE_RESERVATION, tool: params.p_reserve_tool_name, via: "gate", state: "held" });
        }
        reservation = {
          tool_name: params.p_reserve_tool_name,
          meter_version: params.p_meter_version,
          ...terms,
          row: {
            reservation_id: w.reserve.allowed ? GATE_RESERVATION : null,
            allowed: w.reserve.allowed,
            used_actions: w.reserve.used_actions,
          },
        };
      }
    }
    const lastUsed = w.key.last_used_at as string | null;
    const stamp = !lastUsed || Date.now() - Date.parse(lastUsed) >= 60_000;
    return json({
      key: { ...w.key, key_hash: params.p_key_hash },
      key_counts: (params.p_key_window_starts as string[]).map((since) => keyCountSince(w, since)),
      workspace,
      entitlement: workspace ? w.entitlement : null,
      workspace_count: workspace ? w.workspaceCount : null,
      allowance,
      reservation,
      last_used_stamped: stamp,
    });
  }
  if (target === "rpc/finalize_action_usage_reservation") {
    const entry = w.ledger.find((row) => row.id === body?.p_reservation_id && row.state === "held");
    if (!entry) return json(false);
    entry.state = body?.p_succeeded ? "finalized" : "released";
    return json(true);
  }
  if (target === "workspaces" && method === "PATCH") {
    // The two marker claims are `... IS NULL` updates; honour the guard so a
    // second claim really is the no-op production sees.
    const guard = ["analytics_first_tool_used_at", "onboarding_value_activated_at"]
      .find((column) => query.get(column) === "is.null");
    if (guard && w.workspace[guard] != null) return json([]);
    Object.assign(w.workspace, body ?? {});
    return json([{ id: WORKSPACE }]);
  }
  if (target === "inboxes" && method === "GET") {
    const id = eqValue(query, "id");
    const rows = id ? w.inboxes.filter((row) => row.id === id) : w.inboxes;
    return wantsObject ? one(rows[0] ?? null) : json(rows);
  }
  if (target === "users" && method === "GET") return one({ email: "owner@example.com" });
  if (target === "rpc/workspace_action_allowance") return one(w.allowance);
  if (target === "rpc/reserve_action_usage") {
    if (w.reserve.allowed) {
      w.ledger.push({ id: RESERVATION, tool: String(body?.p_tool_name), via: "rpc", state: "held" });
    }
    return one({
      reservation_id: w.reserve.allowed ? RESERVATION : null,
      allowed: w.reserve.allowed,
      used_actions: w.reserve.used_actions,
    });
  }
  if (target === "rpc/record_usage_limit_event") return json(true);
  if (target === "rpc/rate_limit_check") {
    // p_key is `mcp:<namespace>:<bucket>:<key id>`.
    const bucket = String(body?.p_key ?? "").split(":")[2];
    return json(!w.bucketsOver.includes(bucket));
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
    return Promise.reject(new Error(`request-pipeline.test: unexpected network call to ${url.origin}`));
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const target = url.pathname.slice("/rest/v1/".length);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const call: Call = {
    label: labelOf(method, target, url.searchParams),
    method,
    target,
    query: url.searchParams,
    body: typeof init?.body === "string" ? JSON.parse(init.body) as Row : null,
    startedAt: ++w.clock,
    finishedAt: null,
  };
  w.calls.push(call);

  const respond = (): Promise<Response> => {
    call.finishedAt = ++w.clock;
    const failure = w.fail[call.label];
    if (failure === "reject") return Promise.reject(new TypeError("connection reset"));
    if (failure === "http_500") {
      return Promise.resolve(json({ code: "XX000", message: "the database is on fire" }, 500));
    }
    if (failure === "missing") {
      return Promise.resolve(json({ code: "PGRST202", message: "Could not find the function" }, 404));
    }
    if (failure === "malformed") return Promise.resolve(json({ unexpected: true }));
    return Promise.resolve(
      answer(w, call, (headers.get("accept") ?? "").includes("vnd.pgrst.object")),
    );
  };

  // An answer never arrives in the turn that asked for it. Without this the
  // fake would resolve inside the same microtask run as the request, which no
  // network does, and the order in which unrelated requests are ISSUED would
  // depend on promise bookkeeping instead of on the code under test.
  if (!w.hold && !w.holdOnly.includes(call.label)) return sleep(0).then(respond);
  return new Promise<void>((open) => w.held.push({ call, open })).then(respond);
}

// ── Boot the real server against the fake ──────────────────────────────────
// supabase-js may capture `fetch` when the client is created, which is at
// module load, so the fake has to be in place before the import. It stays in
// place: deno runs each test file in its own worker, so no other suite sees it.
globalThis.fetch = fakeFetch as typeof fetch;

const ENV_FOR_IMPORT: Record<string, string | null> = {
  MCP_INTROSPECTION_ONLY: null,
  MCP_SERVER_NO_LISTEN: "1",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
};
const envBefore = Object.fromEntries(
  Object.keys(ENV_FOR_IMPORT).map((name) => [name, Deno.env.get(name) ?? null]),
);
function applyEnv(values: Record<string, string | null>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === null) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
}
applyEnv(ENV_FOR_IMPORT);
const { handleRequest } = await import("./index.ts");
// Every other suite that imports index.ts sets its own environment first, but
// none of them should inherit a database URL that points at this file's fake.
applyEnv(envBefore);

// ═══════════════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════════════

interface Captured {
  lines: Array<{ level: string; args: unknown[] }>;
  restore: () => void;
}

/** Silence the server's logging and keep it for assertions. */
function captureConsole(): Captured {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const lines: Captured["lines"] = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => void lines.push({ level, args });
  }
  return { lines, restore: () => Object.assign(console, original) };
}

function logged(captured: Captured, message: string): Array<Record<string, unknown>> {
  return captured.lines
    .filter((line) => line.args[0] === message)
    .map((line) => (line.args[1] ?? {}) as Record<string, unknown>);
}

function rpcRequest(method: string, params?: Row, token = TOKEN): Request {
  return new Request("http://edge.example.test/mcp-server", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "pipeline-test/1.0",
      "x-forwarded-for": "203.0.113.7",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

/** A billable, DB-only tool: one `inboxes` read is its whole handler. */
const SIGNATURE_GET = { name: "signature_get", arguments: { inbox_id: INBOX } };
const HANDLER_READ = "GET inboxes";

interface Outcome {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
  calls: Call[];
  labels: string[];
  logs: Captured;
  w: World;
}

/** Drive one request to completion with the fake answering at once. */
async function run(w: World, request: Request): Promise<Outcome> {
  current = w;
  preflightAvailability.missingUntil = 0;
  const logs = captureConsole();
  try {
    const response = await handleRequest(request);
    const text = await response.text();
    // The key's `last_used_at` write and the row for a rate-limited call are
    // fire-and-forget by design; let them land so they are counted with the
    // request that issued them.
    await sleep(10);
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      calls: w.calls,
      labels: w.calls.map((call) => call.label),
      logs,
      w,
    };
  } finally {
    logs.restore();
  }
}

/**
 * Drive one request with every answer withheld, releasing one wave at a time.
 *
 * A wave is the set of round trips in flight once the code has stopped issuing
 * new ones, i.e. everything it started without waiting for any of them. The
 * number of waves is the pipeline's serial depth: each costs the client one
 * round-trip time however many requests are in it.
 */
async function runInWaves(w: World, request: Request): Promise<Outcome & { waves: string[][] }> {
  w.hold = true;
  current = w;
  preflightAvailability.missingUntil = 0;
  const logs = captureConsole();
  const waves: string[][] = [];
  let finished = false;
  try {
    const pending = handleRequest(request).finally(() => {
      finished = true;
    });
    for (let guard = 0; guard < 40; guard++) {
      let seen = -1;
      let stable = 0;
      // Quiet for 20 ms with something in flight, or with the request over. The
      // code between two waves is synchronous work and microtasks, which no
      // timer can interleave with, so this is a margin and not a race.
      for (let poll = 0; poll < 500 && stable < 10; poll++) {
        await sleep(2);
        if (w.held.length === seen && (seen > 0 || finished)) stable++;
        else stable = 0;
        seen = w.held.length;
      }
      if (w.held.length === 0) break;
      const wave = w.held.splice(0);
      waves.push(wave.map((entry) => entry.call.label).sort());
      for (const entry of wave) entry.open();
    }
    const response = await pending;
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      calls: w.calls,
      labels: w.calls.map((call) => call.label),
      logs,
      w,
      waves,
    };
  } finally {
    logs.restore();
    w.hold = false;
  }
}

const count = (labels: string[], label: string) => labels.filter((l) => l === label).length;
const firstStart = (calls: Call[], label: string) =>
  calls.find((call) => call.label === label)?.startedAt ?? Infinity;
const lastFinish = (calls: Call[], label: string) =>
  Math.max(-Infinity, ...calls.filter((c) => c.label === label).map((c) => c.finishedAt ?? Infinity));

/** The reads behind the two gates, plus the allowance read that rides along. */
const KEY_COUNT = "HEAD activity_log[api_key_id]";
const WORKSPACE_COUNT = "HEAD activity_log[workspace_id]";
const ALLOWANCE = "RPC workspace_action_allowance";
const RESERVE = "RPC reserve_action_usage";
const FINALIZE = "RPC finalize_action_usage_reservation";
const FIRST_USE_ROUND_TRIPS = ["GET oauth_refresh_tokens", "PATCH workspaces", "POST product_funnel_events"];
/**
 * Migration 20261020214737: the key, every gate read and (when metered) the
 * reservation, in one round trip. Named PREFLIGHT for its predecessor
 * (20261020100000), which answered the reads only.
 */
const PREFLIGHT = "RPC mcp_tools_call_gate";

/** Nothing is left reserved once a call is over, by either path. */
function assertNothingHeld(w: World): void {
  assertEquals(w.ledger.filter((row) => row.state === "held"), [], "a reservation was left held");
}

/** The reservations that turned into a counted action. */
const finalized = (w: World) => w.ledger.filter((row) => row.state === "finalized");

/**
 * The same world with the preflight RPC failing, so the call takes the
 * per-query path. Every gate decision must come out the same either way.
 */
function perQuery(w: World): World {
  w.fail = { [PREFLIGHT]: "http_500", ...w.fail };
  return w;
}
const MODES = [["preflight", (w: World) => w], ["per-query fallback", perQuery]] as const;

/** Install `EdgeRuntime.waitUntil` for one test and hand back what it was given. */
function withBackgroundHook(): { handed: Promise<unknown>[]; remove: () => void } {
  const handed: Promise<unknown>[] = [];
  const host = globalThis as { EdgeRuntime?: unknown };
  const before = host.EdgeRuntime;
  host.EdgeRuntime = { waitUntil: (promise: Promise<unknown>) => void handed.push(promise) };
  return {
    handed,
    remove: () => {
      if (before === undefined) delete host.EdgeRuntime;
      else host.EdgeRuntime = before;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Authentication comes first, alone
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("an unknown or revoked key is refused after ONE lookup and nothing else", async () => {
  const { status, body, labels, w } = await run(
    world({ key: null }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(status, 401);
  assertEquals(body.error.code, -32001);
  // No limiter read, no allowance read, no reservation, no tool work, no log row.
  assertEquals(labels, [PREFLIGHT]);
  assertEquals(w.inserted, {});
});

Deno.test("the preflight refuses a dead key with the per-query path's exact 401", async () => {
  const viaPreflight = await run(world({ key: null }), rpcRequest("tools/call", SIGNATURE_GET));
  const viaQuery = await run(perQuery(world({ key: null })), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(viaQuery.labels, [PREFLIGHT, "GET api_keys"]);
  assertEquals(viaPreflight.status, viaQuery.status);
  assertEquals(viaPreflight.body, viaQuery.body);
});

Deno.test("a malformed key is refused without touching the database at all", async () => {
  const { status, labels } = await run(world(), rpcRequest("tools/call", SIGNATURE_GET, "mcpe_short"));
  assertEquals(status, 401);
  assertEquals(labels, []);
});

Deno.test("nothing is issued alongside the key lookup: authentication is its own wave", async () => {
  const { waves } = await runInWaves(world(), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(waves[0], [PREFLIGHT], "the checks must not start before the key is known good");
  const fallback = await runInWaves(perQuery(world()), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(fallback.waves[0], [PREFLIGHT]);
  assertEquals(fallback.waves[1], ["GET api_keys"], "the fallback still authenticates alone");
});

// ═══════════════════════════════════════════════════════════════════════════
// The pre-checks overlap, and gate the handler
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the key, the limiter counts, the plan row, the entitlement and the allowance are one round trip", async () => {
  const { waves, status, body, calls, labels } = await runInWaves(world(), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(status, 200);
  assert(!body.result.isError, JSON.stringify(body));
  assertEquals(waves[0], [PREFLIGHT]);
  for (const label of [KEY_COUNT, WORKSPACE_COUNT, "GET workspaces", "GET user_usage_entitlements", ALLOWANCE, "GET api_keys"]) {
    assertEquals(count(labels, label), 0, `${label} is answered by the preflight`);
  }

  // The windows are the ones checkRateLimit and checkPlanQuota use, from the
  // caller's clock, and the allowance is asked for because the tool is billable.
  const params = calls.find((call) => call.label === PREFLIGHT)!.body!;
  assertEquals(typeof params.p_key_hash, "string");
  assertEquals((params.p_key_hash as string).length, 64);
  const ages = (params.p_key_window_starts as string[]).map((start) => Date.now() - Date.parse(start));
  assertEquals(ages.length, 3);
  assert(Math.abs(ages[0] - 60_000) < 5_000, `per-minute window start ${ages[0]}`);
  assert(Math.abs(ages[1] - 3_600_000) < 5_000, `per-hour window start ${ages[1]}`);
  assert(Math.abs(ages[2] - 86_400_000) < 5_000, `per-day window start ${ages[2]}`);
  const workspaceAge = Date.now() - Date.parse(params.p_workspace_window_start as string);
  assert(Math.abs(workspaceAge - 60_000) < 5_000);
  assertEquals(params.p_include_allowance, true);
});

Deno.test("on the per-query fallback the limiter counts, the plan read and the allowance read are issued together", async () => {
  const { waves, status, body } = await runInWaves(perQuery(world()), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(status, 200);
  assert(!body.result.isError, JSON.stringify(body));

  assertEquals(waves[2], [
    "GET workspaces",
    KEY_COUNT,
    KEY_COUNT,
    KEY_COUNT,
    WORKSPACE_COUNT,
    // The key's fire-and-forget `last_used_at` stamp, issued by authentication.
    "PATCH api_keys",
    ALLOWANCE,
  ], "one wave: three per-key windows, the workspace window, the plan row, the allowance row");
  // The entitlement is keyed by the owner id the workspace row carries, so it
  // is the one read that has to wait for another.
  assertEquals(waves[3], ["GET user_usage_entitlements"]);
});

Deno.test("a metered call is one round trip deep before its handler, and none after", async () => {
  const { waves, w } = await runInWaves(world(), rpcRequest("tools/call", SIGNATURE_GET));
  // The gate RPC, reservation included. It was two (the preflight, then the
  // reservation) on 2026-10-20 morning, four before that, and nine in
  // sequence before 2026-10-02.
  assertEquals(waves.findIndex((wave) => wave.includes(HANDLER_READ)), 1);
  assertEquals(waves[1], [HANDLER_READ], "no reservation, no last_used_at write of its own");
  // No background hook in the test runner, so the writes are awaited: one
  // wave, both at once, and no first-use work for an activated workspace.
  assertEquals(waves[2], ["POST activity_log", FINALIZE]);
  assertEquals(waves.length, 3);
  assertEquals(w.ledger.map((row) => [row.via, row.state]), [["gate", "finalized"]]);
});

Deno.test("an unmetered call is one round trip deep before its handler", async () => {
  const { waves } = await runInWaves(
    world({ allowance: exemptAllowance() }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(waves.findIndex((wave) => wave.includes(HANDLER_READ)), 1);
  assertEquals(waves[2], ["POST action_usage", "POST activity_log"]);
  assertEquals(waves.length, 3);
});

Deno.test("the per-query fallback keeps its old depth behind the failed preflight", async () => {
  const { waves } = await runInWaves(perQuery(world()), rpcRequest("tools/call", SIGNATURE_GET));
  // The failed preflight, auth, the overlapped checks, the entitlement, the reservation.
  assertEquals(waves.findIndex((wave) => wave.includes(HANDLER_READ)), 5);
  assertEquals(waves[4], [RESERVE]);
});

for (const [mode, prepare] of MODES) {
  Deno.test(`no tool work and no reservation starts until every gate read has answered (${mode})`, async () => {
    const { calls } = await runInWaves(prepare(world()), rpcRequest("tools/call", SIGNATURE_GET));
    const gatesAnswered = Math.max(
      lastFinish(calls, PREFLIGHT),
      lastFinish(calls, KEY_COUNT),
      lastFinish(calls, WORKSPACE_COUNT),
      lastFinish(calls, "GET workspaces"),
      lastFinish(calls, "GET user_usage_entitlements"),
    );
    assert(Number.isFinite(gatesAnswered));
    assert(firstStart(calls, HANDLER_READ) > gatesAnswered, "the handler ran before the gates answered");
    if (mode === "preflight") {
      // Reserved inside the gate RPC itself; no separate reservation at all.
      assertEquals(count(calls.map((call) => call.label), RESERVE), 0);
    } else {
      assert(firstStart(calls, RESERVE) > gatesAnswered, "reserved before the limiters answered");
      assert(firstStart(calls, HANDLER_READ) > lastFinish(calls, RESERVE), "the handler ran before the cap check");
      assert(firstStart(calls, PREFLIGHT) < firstStart(calls, RESERVE));
      assert(firstStart(calls, "GET api_keys") < firstStart(calls, KEY_COUNT));
    }
  });
}

Deno.test("round trips for one successful call on an activated workspace", async () => {
  const metered = await run(world(), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(metered.labels.slice().sort(), [
    "GET inboxes",
    "POST activity_log",
    FINALIZE,
    PREFLIGHT,
  ]);
  const unmetered = await run(
    world({ allowance: exemptAllowance() }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(count(unmetered.labels, RESERVE), 0);
  assertEquals(count(unmetered.labels, FINALIZE), 0);
  assertEquals(count(unmetered.labels, "POST action_usage"), 1);
  assertEquals(unmetered.labels.length, 4);
  assertEquals(unmetered.w.ledger, []);

  // The fallback pays exactly what it always did, plus the failed attempt.
  const fallback = await run(perQuery(world()), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(fallback.labels.slice().sort(), [
    "GET api_keys",
    "GET inboxes",
    "GET user_usage_entitlements",
    "GET workspaces",
    KEY_COUNT,
    KEY_COUNT,
    KEY_COUNT,
    WORKSPACE_COUNT,
    "PATCH api_keys",
    "POST activity_log",
    FINALIZE,
    PREFLIGHT,
    RESERVE,
    ALLOWANCE,
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// The preflight can only change latency: every failure is the per-query path
// ═══════════════════════════════════════════════════════════════════════════

for (const failure of ["http_500", "reject", "missing", "malformed"] as const) {
  Deno.test(`a preflight that fails (${failure}) falls back to the per-query path with the same answer`, async () => {
    const viaPreflight = await run(world(), rpcRequest("tools/call", SIGNATURE_GET));
    const fallback = await run(
      world({ fail: { [PREFLIGHT]: failure } }),
      rpcRequest("tools/call", SIGNATURE_GET),
    );
    assertEquals(fallback.status, 200);
    assertEquals(fallback.body, viaPreflight.body);
    assertEquals(count(fallback.labels, "GET api_keys"), 1);
    assertEquals(count(fallback.labels, KEY_COUNT), 3);
    assertEquals(count(fallback.labels, ALLOWANCE), 1);
    assertEquals(count(fallback.labels, RESERVE), 1);
    const warned = [
      "[mcp-server] tools_call_preflight_failed",
      "[mcp-server] tools_call_preflight_threw",
      "[mcp-server] tools_call_preflight_malformed",
    ].flatMap((message) => logged(fallback.logs, message));
    assertEquals(warned.length, 1);
  });
}

Deno.test("a missing preflight function is skipped for a while; any other error is retried next call", async () => {
  // Not applied yet: the first call learns that and the next does not ask.
  const w = world({ fail: { [PREFLIGHT]: "missing" } });
  await run(w, rpcRequest("tools/call", SIGNATURE_GET));
  current = w;
  const logs = captureConsole();
  try {
    const before = w.calls.length;
    const second = await handleRequest(rpcRequest("tools/call", SIGNATURE_GET));
    assertEquals(second.status, 200);
    const after = w.calls.slice(before).map((call) => call.label);
    assertEquals(count(after, PREFLIGHT), 0, "skipped while it is known missing");
    assertEquals(count(after, "GET api_keys"), 1);
  } finally {
    logs.restore();
  }
  assert(preflightAvailability.missingUntil > Date.now());
  assert(preflightAvailability.missingUntil <= Date.now() + 60_000);

  // A transient failure does not switch it off.
  const transient = world({ fail: { [PREFLIGHT]: "http_500" } });
  await run(transient, rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(preflightAvailability.missingUntil, 0);
});

Deno.test("methods other than tools/call never use the preflight", async () => {
  for (const method of ["ping", "tools/list", "initialize", "resources/list"]) {
    const { labels } = await run(world(), rpcRequest(method));
    assertEquals(count(labels, PREFLIGHT), 0, method);
    assertEquals(count(labels, "GET api_keys"), 1, method);
  }
});

/**
 * One World per gate outcome. Each must give the same status and body down
 * both paths: the preflight moves reads, never decisions.
 */
const PARITY_WORLDS: Array<[string, () => World]> = [
  ["a plain metered call", () => world()],
  ["an exempt workspace", () => world({ allowance: exemptAllowance() })],
  ["a revoked key", () => world({ key: null })],
  ["per-minute saturated", () => world({ keyCounts: { minute: 100, hour: 100, day: 100 } })],
  ["per-hour saturated", () => world({ keyCounts: { minute: 3, hour: 1_000, day: 1_000 } })],
  ["per-day saturated", () => world({ keyCounts: { minute: 3, hour: 40, day: 10_000 } })],
  ["just under every window", () => world({ keyCounts: { minute: 99, hour: 999, day: 9_999 } })],
  ["the plan ceiling", () => world({ workspaceCount: 120 })],
  ["just under the plan ceiling", () => world({ workspaceCount: 119 })],
  ["both saturated", () => world({ keyCounts: { minute: 100, hour: 100, day: 100 }, workspaceCount: 500 })],
  ["a comped owner at 999", () => world({ workspaceCount: 999, entitlement: { kind: "comped_scale", expires_at: null } })],
  ["a comped owner at 1000", () => world({ workspaceCount: 1_000, entitlement: { kind: "comped_scale", expires_at: null } })],
  ["an expired comp", () => world({ workspaceCount: 120, entitlement: { kind: "comped_scale", expires_at: "2026-01-01T00:00:00.000Z" } })],
  ["a grandfathered free workspace", () => world({ workspace: activatedWorkspace({ plan: "free", grandfathered: true }), workspaceCount: 60 })],
  // Referral month (20261025090000): Personal's 120 a minute, so 60 passes.
  ["a free workspace in a referral month at 60", () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    entitlement: { kind: "referral_personal", expires_at: "2099-01-01T00:00:00.000Z" },
    workspaceCount: 60,
  })],
  ["an older standard row in a referral month at 60", () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    entitlement: { kind: "standard", expires_at: null, referral_personal_until: "2099-01-01T00:00:00.000Z" },
    workspaceCount: 60,
  })],
  ["a missing workspace row", () => world({ workspaceMissing: true, workspaceCount: 10_000 })],
  ["a capped workspace", () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    allowance: meteredAllowance({ plan: "free", cap: 150, used: 150, remaining: 0 }),
    reserve: { allowed: false, used_actions: 150 },
  })],
  ["a free workspace one under its cap", () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    allowance: meteredAllowance({ plan: "free", cap: 150, used: 149, remaining: 1 }),
    reserve: { allowed: true, used_actions: 150 },
  })],
  ["a free workspace crossing 80%", () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    allowance: meteredAllowance({ plan: "free", cap: 150, used: 119, remaining: 31 }),
    reserve: { allowed: true, used_actions: 120 },
  })],
  ["a free workspace in its grace days", () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    allowance: meteredAllowance({
      plan: "free", cap: 150, in_grace: true, grace_ends_at: "2099-01-01T00:00:00.000Z",
      period_start: "2026-11-01T00:00:00.000Z", period_end: "2026-11-01T00:00:00.000Z",
    }),
  })],
  ["a comped (exempt) allowance", () => world({
    allowance: meteredAllowance({ exempt: true, exempt_reason: "comped", cap: null, remaining: null }),
    entitlement: { kind: "comped_scale", expires_at: null },
  })],
  ["an empty window", () => world({
    allowance: meteredAllowance({ period_start: "2026-11-01T00:00:00.000Z", period_end: "2026-11-01T00:00:00.000Z" }),
  })],
  ["the gate reserving under other terms than the row says", () => world({ gateTerms: { cap: 999 } })],
];

/** The response with the one field that depends on the wall clock removed. */
// deno-lint-ignore no-explicit-any
function comparable(body: any): unknown {
  const copy = structuredClone(body);
  if (copy?.error?.data) delete copy.error.data.retry_after;
  if (typeof copy?.error?.data?.human_message === "string") {
    copy.error.data.human_message = copy.error.data.human_message.replace(/\d+ seconds/, "N seconds");
  }
  return copy;
}

for (const [name, make] of PARITY_WORLDS) {
  Deno.test(`the preflight and the per-query path decide the same: ${name}`, async () => {
    const viaPreflight = await run(make(), rpcRequest("tools/call", SIGNATURE_GET));
    const viaQuery = await run(perQuery(make()), rpcRequest("tools/call", SIGNATURE_GET));
    assertEquals(viaPreflight.status, viaQuery.status);
    assertEquals(comparable(viaPreflight.body), comparable(viaQuery.body));
    assertEquals(
      (viaPreflight.w.inserted.activity_log ?? []).map((row) => [row.status, row.error_code]),
      (viaQuery.w.inserted.activity_log ?? []).map((row) => [row.status, row.error_code]),
    );
    assertEquals(count(viaPreflight.labels, HANDLER_READ), count(viaQuery.labels, HANDLER_READ));
    assertEquals(viaPreflight.w.inserted.action_usage, viaQuery.w.inserted.action_usage);
    // The meter: the same number of counted actions, under the same tool, and
    // nothing left holding a unit of the cap, whichever path reserved it.
    assertEquals(finalized(viaPreflight.w).map((row) => row.tool), finalized(viaQuery.w).map((row) => row.tool));
    assertNothingHeld(viaPreflight.w);
    assertNothingHeld(viaQuery.w);
    // The cap record and the notices: same calls, same arguments.
    const events = (o: Outcome) =>
      o.calls.filter((call) => call.label === "RPC record_usage_limit_event").map((call) => call.body);
    assertEquals(events(viaPreflight), events(viaQuery));
    const notices = (o: Outcome) =>
      (o.w.inserted.billing_email_sends ?? []).map(({ send_after: _clock, ...row }) => row);
    assertEquals(notices(viaPreflight), notices(viaQuery));
  });
}

Deno.test("a referral month bursts at Personal's ceiling on both paths; plain Free does not", async () => {
  const referral = () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    entitlement: { kind: "referral_personal", expires_at: "2099-01-01T00:00:00.000Z" },
    workspaceCount: 60,
  });
  const ended = () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    entitlement: { kind: "referral_personal", expires_at: "2020-01-01T00:00:00.000Z" },
    workspaceCount: 60,
  });
  const standardRow = () => world({
    workspace: activatedWorkspace({ plan: "free" }),
    entitlement: { kind: "standard", expires_at: null, referral_personal_until: "2099-01-01T00:00:00.000Z" },
    workspaceCount: 60,
  });
  for (const w of [referral(), perQuery(referral()), standardRow(), perQuery(standardRow())]) {
    assertEquals((await run(w, rpcRequest("tools/call", SIGNATURE_GET))).status, 200);
  }
  for (const w of [ended(), perQuery(ended())]) {
    assertEquals((await run(w, rpcRequest("tools/call", SIGNATURE_GET))).status, 429);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Rate limiting still comes before the tool, and costs no allowance
// ═══════════════════════════════════════════════════════════════════════════

for (const [mode, prepare] of MODES) {
  // The test workspace is on Personal (120 a minute), so the per-key windows
  // are the base 100 / 1000 / 10000 lifted by 1.2 (perKeyWindows).
  for (const [name, saturated, window, limit] of [
    ["per-minute", { minute: 120, hour: 120, day: 120 }, "per_minute", 120],
    ["per-hour", { minute: 3, hour: 1_200, day: 1_200 }, "per_hour", 1_200],
    ["per-day", { minute: 3, hour: 40, day: 12_000 }, "per_day", 12_000],
  ] as const) {
    Deno.test(`a ${name} rate-limited call is refused before any tool work or reservation (${mode})`, async () => {
      const { status, body, labels, w } = await run(
        prepare(world({ keyCounts: saturated })),
        rpcRequest("tools/call", SIGNATURE_GET),
      );
      assertEquals(status, 429);
      assertEquals(body.error.data.window, window);
      assertEquals(body.error.data.limit, limit);
      assertEquals(count(labels, RESERVE), 0, "a rate-limited call must not reserve allowance");
      // The gate may have reserved in its own round trip; if so it was given
      // back, unused, before the 429 left. Either way nothing is counted.
      if (mode === "preflight") {
        assertEquals(w.ledger.map((row) => [row.via, row.state]), [["gate", "released"]]);
        assertEquals(
          w.calls.filter((call) => call.label === FINALIZE).map((call) => call.body),
          [{ p_reservation_id: GATE_RESERVATION, p_succeeded: false }],
        );
      } else {
        assertEquals(count(labels, FINALIZE), 0);
      }
      assertEquals(finalized(w), []);
      assertNothingHeld(w);
      assertEquals(count(labels, HANDLER_READ), 0, "the tool must not run");
      assertEquals(w.inserted.action_usage, undefined, "and must not be metered");
      // Counted by the limiter it tripped: one row, status rate_limited.
      assertEquals(w.inserted.activity_log?.length, 1);
      assertEquals(w.inserted.activity_log[0].status, "rate_limited");
      assertEquals(w.inserted.activity_log[0].tool_name, "signature_get");
    });
  }
}

Deno.test("the narrowest saturated window still decides, with all three counted at once", async () => {
  const { body } = await run(
    world({ keyCounts: { minute: 120, hour: 1_200, day: 12_000 } }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(body.error.data.window, "per_minute");
});

Deno.test("under the plan-scaled windows, 99 / 999 / 9999 passes", async () => {
  const { status, body } = await run(
    world({ keyCounts: { minute: 99, hour: 999, day: 9_999 } }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(status, 200);
  assert(!body.result.isError);
});

Deno.test("a failed count fails open for that window only, as before", async () => {
  const { status, logs } = await run(
    perQuery(world({ fail: { [KEY_COUNT]: "http_500" } })),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(status, 200);
  assertEquals(logged(logs, "[mcp-server] rate_limit_db_error").length, 3);
});

for (const [mode, prepare] of MODES) {
  Deno.test(`the plan's per-minute ceiling is still enforced before the tool, with no reservation (${mode})`, async () => {
    const { status, body, labels, w } = await run(
      // Personal allows 120 a minute across the workspace.
      prepare(world({ workspaceCount: 120 })),
      rpcRequest("tools/call", SIGNATURE_GET),
    );
    assertEquals(status, 429);
    assertEquals(body.error.data.plan, "personal");
    assertEquals(body.error.data.limit, 120);
    assertEquals(count(labels, RESERVE), 0);
    assertEquals(count(labels, HANDLER_READ), 0);
    assertEquals(w.inserted.action_usage, undefined);
    assertEquals(finalized(w), []);
    assertNothingHeld(w);
    const under = await run(prepare(world({ workspaceCount: 119 })), rpcRequest("tools/call", SIGNATURE_GET));
    assertEquals(under.status, 200);
  });
}

Deno.test("a comped owner gets the pro ceiling through the preflight's entitlement", async () => {
  const comped = { kind: "comped_scale", expires_at: null };
  const under = await run(world({ workspaceCount: 999, entitlement: comped }), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(under.status, 200);
  const at = await run(world({ workspaceCount: 1_000, entitlement: comped }), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(at.status, 429);
  assertEquals(at.body.error.data.plan, "pro");
  assertEquals(at.body.error.data.limit, 1_000);
});

Deno.test("a missing workspace row still fails the plan ceiling open, and says so", async () => {
  const { status, logs } = await run(
    world({ workspaceMissing: true, workspaceCount: 10_000 }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(status, 200);
  assertEquals(logged(logs, "[mcp-server] plan_quota_workspace_lookup_failed").length, 1);
});

Deno.test("the per-key limiter outranks the plan ceiling when both are saturated", async () => {
  const { body } = await run(
    world({ keyCounts: { minute: 120, hour: 120, day: 120 }, workspaceCount: 500 }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  // The per-key refusal carries no `plan`; the plan refusal does.
  assertEquals(body.error.data.plan, undefined);
  assertEquals(body.error.data.limit, 120);
});

// ═══════════════════════════════════════════════════════════════════════════
// The action cap still comes before the tool
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a capped call records its refusal, logs one row and never reaches the handler", async () => {
  const { status, body, labels, calls, w } = await run(
    world({
      workspace: activatedWorkspace({ plan: "free" }),
      allowance: meteredAllowance({ plan: "free", cap: 150, used: 150, remaining: 0 }),
      reserve: { allowed: false, used_actions: 150 },
    }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(status, 200);
  assertEquals(body.result.isError, true);
  const meta = body.result._meta["com.mcpemails/usage_limit"];
  assertEquals(meta.error_code, "usage_limit_reached");
  assertEquals(meta.used_actions, 150);
  assertEquals(meta.cap, 150);

  // Refused by the reservation inside the gate RPC: no separate attempt.
  assertEquals(count(labels, RESERVE), 0);
  assertEquals(calls.find((call) => call.label === PREFLIGHT)!.body!.p_reserve_tool_name, "signature_get");
  assertEquals(w.ledger, []);
  assertEquals(count(labels, "RPC record_usage_limit_event"), 1);
  const event = calls.find((call) => call.label === "RPC record_usage_limit_event")!;
  assertEquals(event.body?.p_used_actions, 150);
  assertEquals(event.body?.p_cap, 150);
  assertEquals(count(labels, HANDLER_READ), 0, "a capped call must not run the tool");
  assertEquals(count(labels, FINALIZE), 0, "there is no reservation to settle");
  assertEquals(w.inserted.action_usage, undefined);
  assertEquals(w.inserted.activity_log?.length, 1);
  assertEquals(w.inserted.activity_log[0].status, "rate_limited");
  assertEquals(w.inserted.activity_log[0].error_code, "usage_limit_reached");
});

Deno.test("the reservation is made with the cap and window from the allowance row read early", async () => {
  const { calls } = await run(
    world({ allowance: meteredAllowance({ plan: "free", cap: 150 }) }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  // The gate is told which tool to reserve against and under which meter; the
  // cap and window come from the same terms the edge function then checks.
  const gate = calls.find((call) => call.label === PREFLIGHT)!;
  assertEquals(gate.body?.p_reserve_tool_name, "signature_get");
  assertEquals(gate.body?.p_meter_version, 1);
  assertEquals(gate.body?.p_include_allowance, true);
  assertEquals(count(calls.map((call) => call.label), RESERVE), 0);
  // Read once, by the gate, and not again by the reservation.
  assertEquals(count(calls.map((call) => call.label), ALLOWANCE), 0);
  assertEquals(count(calls.map((call) => call.label), PREFLIGHT), 1);

  const fallback = await run(
    perQuery(world({ allowance: meteredAllowance({ plan: "free", cap: 150 }) })),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  const fallbackReserve = fallback.calls.find((call) => call.label === RESERVE)!;
  assertEquals(fallbackReserve.body, {
    p_workspace_id: WORKSPACE,
    p_tool_name: "signature_get",
    p_meter_version: 1,
    p_cap: 150,
    p_period_start: "2026-10-01T00:00:00.000Z",
    p_period_end: "2026-11-01T00:00:00.000Z",
  });
  assertEquals(count(fallback.labels, ALLOWANCE), 1, "read once, not once early and once late");
});

Deno.test("a reserved call that fails releases its reservation and still logs one row", async () => {
  const { body, calls, w } = await run(
    // The key can reach no such inbox, so the handler answers with an error.
    world({ inboxes: [] }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(body.result.isError, true);
  const finalize = calls.find((call) => call.label === FINALIZE)!;
  assertEquals(finalize.body, { p_reservation_id: GATE_RESERVATION, p_succeeded: false });
  assertEquals(count(calls.map((call) => call.label), FINALIZE), 1, "settled once, not again at request end");
  assertEquals(w.inserted.activity_log?.length, 1);
  assertEquals(w.inserted.activity_log[0].status, "error");
  assertNothingHeld(w);
});

// ═══════════════════════════════════════════════════════════════════════════
// The gate's reservation is used only when it is exactly the one owed
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a call refused before the cap check gives the gate's reservation back", async () => {
  // Schema validation refuses a signature_get with no inbox and a stray type.
  const invalid = await run(world(), rpcRequest("tools/call", { name: "signature_get", arguments: { inbox_id: 42 } }));
  assertEquals(invalid.body.result.isError, true, JSON.stringify(invalid.body));
  assertEquals(invalid.w.ledger.map((row) => [row.via, row.state]), [["gate", "released"]]);
  assertEquals(count(invalid.labels, HANDLER_READ), 0);
  assertEquals(invalid.w.inserted.action_usage, undefined);

  // A consolidated tool whose action does not resolve exactly: no guess at
  // all, and the ordinary reservation is never reached either.
  const unknownAction = await run(world(), rpcRequest("tools/call", {
    name: "email_read", arguments: { action: "nonsense", inbox_id: INBOX },
  }));
  assertEquals(unknownAction.calls.find((call) => call.label === PREFLIGHT)!.body!.p_reserve_tool_name, null);
  assertEquals(unknownAction.w.ledger, []);
});

Deno.test("a consolidated call is reserved up front under the operation it dispatches to", async () => {
  const { calls, labels, w } = await run(world({ inboxes: [] }), rpcRequest("tools/call", {
    name: "email_read", arguments: { action: "list", inbox_id: INBOX },
  }));
  assertEquals(calls.find((call) => call.label === PREFLIGHT)!.body!.p_reserve_tool_name, "email_list");
  assertEquals(count(labels, RESERVE), 0, "the gate's reservation was the right one");
  assertEquals(w.ledger.map((row) => [row.tool, row.via]), [["email_list", "gate"]]);
  assertNothingHeld(w);
});

Deno.test("a reservation under other terms than the edge function derives is released BEFORE it reserves again", async () => {
  const { calls, w, body } = await run(world({ gateTerms: { cap: 999 } }), rpcRequest("tools/call", SIGNATURE_GET));
  assert(!body.result.isError, JSON.stringify(body));
  const release = calls.findIndex((call) => call.label === FINALIZE && call.body?.p_reservation_id === GATE_RESERVATION);
  const reserve = calls.findIndex((call) => call.label === RESERVE);
  assert(release >= 0 && reserve > release, "the stale reservation must be gone before the real one is made");
  assert(calls[release].finishedAt! < calls[reserve].startedAt, "and answered, not merely sent");
  assertEquals(w.ledger.map((row) => [row.via, row.state]), [["gate", "released"], ["rpc", "finalized"]]);
  assertEquals(calls[reserve].body?.p_cap, 25_000);
});

Deno.test("a reservation error inside the gate fails open exactly like the separate call did", async () => {
  const viaGate = await run(world({ gateReserveError: true }), rpcRequest("tools/call", SIGNATURE_GET));
  const viaQuery = await run(perQuery(world({ fail: { [RESERVE]: "http_500" } })), rpcRequest("tools/call", SIGNATURE_GET));
  for (const outcome of [viaGate, viaQuery]) {
    assert(!outcome.body.result.isError, JSON.stringify(outcome.body));
    assertEquals(logged(outcome.logs, "[mcp-server] action_usage_reservation_failed").length, 1);
    // Unmetered fallback: the bare insert books the action after the fact.
    assertEquals(outcome.w.inserted.action_usage?.length, 1);
  }
  assertEquals(count(viaGate.labels, RESERVE), 0);
});

Deno.test("an answer the edge function cannot use still has its reservation released", async () => {
  const w = world();
  current = w;
  // A gate answer with a reservation in it but an unusable key row: the
  // per-query path runs, and the stray reservation must not count alongside
  // the one it makes.
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/rpc/mcp_tools_call_gate")) {
      w.ledger.push({ id: GATE_RESERVATION, tool: "signature_get", via: "gate", state: "held" });
      w.calls.push({
        label: PREFLIGHT, method: "POST", target: "rpc/mcp_tools_call_gate", query: new URLSearchParams(),
        body: null, startedAt: ++w.clock, finishedAt: ++w.clock,
      });
      return Promise.resolve(json({
        key: { id: 7 },
        reservation: { tool_name: "signature_get", row: { reservation_id: GATE_RESERVATION, allowed: true, used_actions: 1 } },
      }));
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const { body, calls, logs } = await run(w, rpcRequest("tools/call", SIGNATURE_GET));
    assert(!body.result.isError, JSON.stringify(body));
    assertEquals(logged(logs, "[mcp-server] tools_call_preflight_malformed").length, 1);
    const release = calls.findIndex((call) => call.label === FINALIZE && call.body?.p_reservation_id === GATE_RESERVATION);
    const reserve = calls.findIndex((call) => call.label === RESERVE);
    assert(release >= 0 && reserve > release, "released before the per-query path reserved");
    assertEquals(w.ledger.map((row) => [row.via, row.state]), [["gate", "released"], ["rpc", "finalized"]]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a call in its grace days or exempt is never reserved, by either path", async () => {
  for (const allowance of [
    meteredAllowance({ plan: "free", cap: 150, in_grace: true, grace_ends_at: "2099-01-01T00:00:00.000Z" }),
    exemptAllowance(),
    meteredAllowance({ exempt: true, exempt_reason: "comped", cap: null, remaining: null }),
  ]) {
    for (const [, prepare] of MODES) {
      const { w, labels } = await run(prepare(world({ allowance })), rpcRequest("tools/call", SIGNATURE_GET));
      assertEquals(w.ledger, []);
      assertEquals(count(labels, RESERVE), 0);
      assertEquals(w.inserted.action_usage?.length, 1, "booked after the fact, unmetered");
    }
  }
});

Deno.test("last_used_at is written at most once a minute per key", async () => {
  const stamps = (o: Outcome) =>
    o.calls.filter((call) => call.label === "PATCH api_keys" && call.body && "last_used_at" in call.body).length;
  // The gate path never writes it from the edge function: the RPC does.
  const viaGate = await run(world(), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(stamps(viaGate), 0);
  // Every other method, and the fallback, still stamps a stale key...
  assertEquals(stamps(await run(world(), rpcRequest("ping"))), 1);
  assertEquals(stamps(await run(perQuery(world()), rpcRequest("tools/call", SIGNATURE_GET))), 1);
  // ...but not one stamped in the last minute.
  const recently = () => {
    const w = world();
    w.key!.last_used_at = new Date(Date.now() - 30_000).toISOString();
    return w;
  };
  assertEquals(stamps(await run(recently(), rpcRequest("ping"))), 0);
  assertEquals(stamps(await run(perQuery(recently()), rpcRequest("tools/call", SIGNATURE_GET))), 0);
  // A never-used key is stamped on its first request either way.
  const never = world();
  never.key!.last_used_at = null;
  assertEquals(stamps(await run(never, rpcRequest("ping"))), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Exactly one activity_log row, same fields, with or without a background hook
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("without EdgeRuntime the writes are awaited: the row exists when the response does", async () => {
  assertEquals((globalThis as { EdgeRuntime?: unknown }).EdgeRuntime, undefined);
  const { w, calls } = await run(world(), rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(w.inserted.activity_log?.length, 1);
  const row = w.inserted.activity_log[0];
  assertEquals(typeof row.duration_ms, "number");
  assertEquals({ ...row, duration_ms: 0 }, {
    workspace_id: WORKSPACE,
    api_key_id: KEY_ID,
    inbox_id: INBOX,
    tool_name: "signature_get",
    status: "success",
    error_code: null,
    duration_ms: 0,
    // The request carried x-forwarded-for 203.0.113.7 and a User-Agent;
    // neither is stored (2026-10-20).
    ip_address: null,
    user_agent: null,
  });
  const finalize = calls.find((call) => call.label === FINALIZE)!;
  assertEquals(finalize.body, { p_reservation_id: GATE_RESERVATION, p_succeeded: true });
});

Deno.test("with EdgeRuntime.waitUntil the writes are handed to the runtime as one promise", async () => {
  const hook = withBackgroundHook();
  try {
    const { body, w, labels } = await run(world(), rpcRequest("tools/call", SIGNATURE_GET));
    assert(!body.result.isError, JSON.stringify(body));
    assertEquals(hook.handed.length, 1, "exactly one promise is handed to the runtime");
    await hook.handed[0];
    assertEquals(w.inserted.activity_log?.length, 1);
    assertEquals(count(labels, FINALIZE), 1);
  } finally {
    hook.remove();
  }
});

Deno.test("with EdgeRuntime.waitUntil a response does not wait for withheld writes", async () => {
  const hook = withBackgroundHook();
  // Only the bookkeeping is withheld, so the response can arrive first only if
  // the code has genuinely stopped waiting for it.
  const w = world({
    allowance: exemptAllowance(),
    holdOnly: ["POST activity_log", "POST action_usage"],
  });
  current = w;
  const logs = captureConsole();
  try {
    const pending = handleRequest(rpcRequest("tools/call", SIGNATURE_GET));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      pending,
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 500))),
    ]);
    clearTimeout(timer);
    if (response === null) {
      // Let the request finish, so this fails as an assertion and not as a
      // run that never ends.
      w.holdOnly = [];
      for (const entry of w.held.splice(0)) entry.open();
      await pending;
    }
    assert(response !== null, "the response waited for a write that had not been answered");
    const body = await response.json();
    assert(!body.result.isError, JSON.stringify(body));

    // The client has its answer; both writes are in flight and unanswered.
    // (One turn of the event loop: they are started in the same tick the
    // result is returned in, a few microtasks behind it.)
    await sleep(0);
    assertEquals(w.held.map((entry) => entry.call.label).sort(), ["POST action_usage", "POST activity_log"]);
    assertEquals(w.inserted.activity_log, undefined);
    assertEquals(hook.handed.length, 1);

    for (const entry of w.held.splice(0)) entry.open();
    await hook.handed[0];
    assertEquals(w.inserted.activity_log?.length, 1);
    assertEquals(w.inserted.activity_log[0].status, "success");
    assertEquals(w.inserted.action_usage, [{
      workspace_id: WORKSPACE,
      tool_name: "signature_get",
      billable: true,
      quantity: 1,
      meter_version: 1,
    }]);
  } finally {
    logs.restore();
    hook.remove();
  }
});

for (const mode of ["http_500", "reject"] as const) {
  Deno.test(`a deferred activity_log write that fails (${mode}) is logged, never thrown, and does not cancel the meter`, async () => {
    const hook = withBackgroundHook();
    try {
      const { status, body, logs, w } = await run(
        world({ fail: { "POST activity_log": mode } }),
        rpcRequest("tools/call", SIGNATURE_GET),
      );
      assertEquals(status, 200);
      assert(!body.result.isError, "the tool's answer is unaffected");
      // Resolves, never rejects: an unhandled rejection would take the isolate down.
      await hook.handed[0];
      const failures = logged(logs, "[mcp-server] activity_log_insert_failed");
      assertEquals(failures.length, 1);
      assertEquals(failures[0].tool_name, "signature_get");
      assertEquals(failures[0].status, "success");
      assertEquals(count(w.calls.map((call) => call.label), FINALIZE), 1, "the reservation is still settled");
    } finally {
      hook.remove();
    }
  });
}

Deno.test("a failed write is logged the same way when there is no background hook", async () => {
  const { status, logs } = await run(
    world({ fail: { "POST activity_log": "http_500", [FINALIZE]: "http_500" } }),
    rpcRequest("tools/call", SIGNATURE_GET),
  );
  assertEquals(status, 200);
  assertEquals(logged(logs, "[mcp-server] activity_log_insert_failed").length, 1);
  assertEquals(logged(logs, "[mcp-server] action_usage_reservation_finalize_failed").length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// The idempotency ledger is not bookkeeping: it stays in front of the response
// ═══════════════════════════════════════════════════════════════════════════

/** A send that carries a retry key and fails before any provider is reached. */
const SEND_WITH_KEY = {
  name: "email_compose",
  arguments: {
    action: "send",
    inbox_id: INBOX,
    to: ["someone-else@example.com"],
    subject: "hi",
    body: "there",
    idempotency_key: "pipeline-test-key-1",
  },
};
const LEDGER_CLAIM = "POST outbound_idempotency";
const LEDGER_SETTLE = "PATCH outbound_idempotency";

/**
 * The ledger keys its rows with an HMAC under ENCRYPTION_KEY, read at call
 * time. A throwaway key for the length of one test, then the variable is put
 * back the way it was so no other suite inherits it.
 */
async function withLedgerKey<T>(body: () => Promise<T>): Promise<T> {
  const before = Deno.env.get("ENCRYPTION_KEY");
  Deno.env.set("ENCRYPTION_KEY", "0".repeat(64));
  try {
    return await body();
  } finally {
    if (before === undefined) Deno.env.delete("ENCRYPTION_KEY");
    else Deno.env.set("ENCRYPTION_KEY", before);
  }
}

Deno.test("the ledger is claimed after the cap check and before the handler", async () => {
  // No reachable inbox: the handler refuses before it could open a socket.
  const { body, calls, labels } = await withLedgerKey(() =>
    run(world({ inboxes: [] }), rpcRequest("tools/call", SEND_WITH_KEY))
  );
  assertEquals(body.result?.isError, true, JSON.stringify(body));
  assertEquals(count(labels, LEDGER_CLAIM), 1);
  assertEquals(count(labels, LEDGER_SETTLE), 1);
  assert(firstStart(calls, LEDGER_CLAIM) > lastFinish(calls, RESERVE), "claimed before the cap check");
  assert(firstStart(calls, HANDLER_READ) > lastFinish(calls, LEDGER_CLAIM), "the handler ran unclaimed");
  assert(
    firstStart(calls, "POST activity_log") > lastFinish(calls, LEDGER_SETTLE),
    "the ledger is settled before the deferred bookkeeping starts",
  );
  const claim = calls.find((call) => call.label === LEDGER_CLAIM)!;
  assertEquals(claim.body?.operation, "email_send");
  assertEquals(claim.body?.status, "processing");
  // The refusal happened before any provider was reached, and the row says so.
  const settle = calls.find((call) => call.label === LEDGER_SETTLE)!;
  assertEquals(settle.body?.status, "failed");
});

Deno.test("with EdgeRuntime.waitUntil the response still waits for the ledger to be settled", async () => {
  const hook = withBackgroundHook();
  const w = world({ inboxes: [], holdOnly: [LEDGER_SETTLE] });
  current = w;
  const logs = captureConsole();
  try {
    await withLedgerKey(async () => {
      let answered = false;
      const pending = handleRequest(rpcRequest("tools/call", SEND_WITH_KEY)).then((response) => {
        answered = true;
        return response;
      });
      for (let poll = 0; poll < 500 && w.held.length === 0; poll++) await sleep(2);
      await sleep(20);
      assertEquals(w.held.map((entry) => entry.call.label), [LEDGER_SETTLE]);
      assertEquals(answered, false, "a retry must never be able to race an unsettled ledger row");
      assertEquals(hook.handed.length, 0, "nothing is handed to the background before the ledger is settled");
      for (const entry of w.held.splice(0)) entry.open();
      const response = await pending;
      await response.text();
      await Promise.all(hook.handed);
      assertEquals(w.inserted.activity_log?.length, 1);
    });
  } finally {
    logs.restore();
    hook.remove();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// First-use marking
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("an activated workspace costs zero first-use round trips", async () => {
  const { labels } = await run(world(), rpcRequest("tools/call", SIGNATURE_GET));
  for (const label of FIRST_USE_ROUND_TRIPS) assertEquals(count(labels, label), 0, label);
  // The handler's own inbox read is the only one; the marker's provider lookup is gone.
  assertEquals(count(labels, "GET inboxes"), 1);
  assertEquals(count(labels, "GET workspaces"), 0, "the markers ride on the preflight's workspace row");
  const fallback = await run(perQuery(world()), rpcRequest("tools/call", SIGNATURE_GET));
  for (const label of FIRST_USE_ROUND_TRIPS) assertEquals(count(fallback.labels, label), 0, label);
  assertEquals(count(fallback.labels, "GET workspaces"), 1, "the markers ride on the plan check's read");
});

Deno.test("a brand new workspace is still marked, once, with both funnel stages", async () => {
  const w = world({
    workspace: activatedWorkspace({ analytics_first_tool_used_at: null, onboarding_value_activated_at: null }),
  });
  const first = await run(w, rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals(count(first.labels, "PATCH workspaces"), 2);
  assertEquals(count(first.labels, "GET oauth_refresh_tokens"), 1);
  assertEquals(
    (w.inserted.product_funnel_events ?? []).map((event) => event.stage),
    ["first_tool_call", "technical_activation", "value_activation"],
  );
  assertEquals(w.workspace.analytics_first_tool_name, "signature_get");
  assertEquals(w.workspace.analytics_first_tool_provider, "generic_imap");
  assertEquals(w.workspace.onboarding_stage, "value_activation");
  assert(w.workspace.onboarding_value_activated_at);

  // The very next call reads the markers it just wrote and does none of it.
  const calls = w.calls.length;
  const second = await run(w, rpcRequest("tools/call", SIGNATURE_GET));
  const after = second.labels.slice(calls);
  for (const label of FIRST_USE_ROUND_TRIPS) assertEquals(count(after, label), 0, label);
  assertEquals(w.inserted.product_funnel_events.length, 3);
});

Deno.test("a workspace that only ever listed inboxes is value-activated by its first mailbox call", async () => {
  const w = world({ workspace: activatedWorkspace({ onboarding_value_activated_at: null }) });
  const listed = await run(w, rpcRequest("tools/call", { name: "inbox_list", arguments: {} }));
  assert(!listed.body.result.isError, JSON.stringify(listed.body));
  // inbox_list cannot value-activate, so there is nothing for it to mark.
  for (const label of FIRST_USE_ROUND_TRIPS) assertEquals(count(listed.labels, label), 0, label);

  await run(w, rpcRequest("tools/call", SIGNATURE_GET));
  assertEquals((w.inserted.product_funnel_events ?? []).map((event) => event.stage), ["value_activation"]);
  assert(w.workspace.onboarding_value_activated_at);
});

Deno.test("a failed call marks nothing", async () => {
  const w = world({
    inboxes: [],
    workspace: activatedWorkspace({ analytics_first_tool_used_at: null, onboarding_value_activated_at: null }),
  });
  const { labels } = await run(w, rpcRequest("tools/call", SIGNATURE_GET));
  for (const label of FIRST_USE_ROUND_TRIPS) assertEquals(count(labels, label), 0, label);
  assertEquals(w.workspace.analytics_first_tool_used_at, null);
});

Deno.test("firstUseAlreadyRecorded only ever skips work that is provably done", () => {
  const both = { analytics_first_tool_used_at: "2026-09-02T00:00:00Z", onboarding_value_activated_at: "2026-09-02T00:05:00Z" };
  const toolOnly = { analytics_first_tool_used_at: "2026-09-02T00:00:00Z", onboarding_value_activated_at: null };
  assert(firstUseAlreadyRecorded(both, INBOX, "email_read"));
  assert(firstUseAlreadyRecorded(both, null, "inbox_list"));
  // Value activation outstanding: skip only the calls that could not supply it.
  assert(!firstUseAlreadyRecorded(toolOnly, INBOX, "email_read"));
  assert(firstUseAlreadyRecorded(toolOnly, INBOX, "inbox_list"));
  assert(firstUseAlreadyRecorded(toolOnly, null, "email_read"));
  // First tool call outstanding: never skip.
  assert(!firstUseAlreadyRecorded({ analytics_first_tool_used_at: null, onboarding_value_activated_at: null }, null, "inbox_list"));
  // Unknown is not "done". The plan check failed open, the caller bypassed it,
  // or the projection lost a column: all of them run the marker as before.
  assert(!firstUseAlreadyRecorded(undefined, INBOX, "email_read"));
  assert(!firstUseAlreadyRecorded(null, INBOX, "email_read"));
  assert(!firstUseAlreadyRecorded({}, null, "inbox_list"));
  assert(!firstUseAlreadyRecorded({ analytics_first_tool_used_at: "2026-09-02T00:00:00Z" }, INBOX, "email_read"));
});

// ═══════════════════════════════════════════════════════════════════════════
// settleAfterResponse
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("settleAfterResponse without a hook resolves only once every task has", async () => {
  const order: string[] = [];
  let openSlow!: () => void;
  const slow = new Promise<void>((resolve) => (openSlow = resolve));
  const settled = settleAfterResponse([
    ["slow", async () => {
      order.push("slow started");
      await slow;
      order.push("slow done");
    }],
    ["fast", () => {
      order.push("fast started");
      return Promise.resolve();
    }],
  ], () => order.push("failure"), null);
  // Both started before either was waited for.
  assertEquals(order, ["slow started", "fast started"]);
  let resolved = false;
  void settled.then(() => (resolved = true));
  await sleep(5);
  assertEquals(resolved, false, "must not resolve while a task is outstanding");
  openSlow();
  await settled;
  assertEquals(order, ["slow started", "fast started", "slow done"]);
});

Deno.test("settleAfterResponse with a hook returns at once and hands the hook the work", async () => {
  let openSlow!: () => void;
  const slow = new Promise<void>((resolve) => (openSlow = resolve));
  const handed: Promise<unknown>[] = [];
  let finished = false;
  await settleAfterResponse(
    [["slow", async () => {
      await slow;
      finished = true;
    }]],
    () => {},
    { waitUntil: (promise) => void handed.push(promise) },
  );
  assertEquals(finished, false, "the caller was released before the task finished");
  assertEquals(handed.length, 1);
  openSlow();
  await handed[0];
  assertEquals(finished, true);
});

Deno.test("a task that throws or rejects is reported by name and does not stop the others", async () => {
  const failures: Array<[string, string]> = [];
  const ran: string[] = [];
  for (const runtime of [null, { waitUntil: (promise: Promise<unknown>) => promise }]) {
    failures.length = 0;
    ran.length = 0;
    const handed: Promise<unknown>[] = [];
    await settleAfterResponse(
      [
        ["throws", () => {
          throw new Error("sync boom");
        }],
        ["rejects", () => Promise.reject(new Error("async boom"))],
        ["fine", () => {
          ran.push("fine");
          return Promise.resolve();
        }],
      ],
      (name, error) => failures.push([name, (error as Error).message]),
      runtime && { waitUntil: (promise) => void handed.push(promise) },
    );
    // Never a rejection, in either mode.
    await Promise.all(handed);
    assertEquals(failures, [["throws", "sync boom"], ["rejects", "async boom"]]);
    assertEquals(ran, ["fine"]);
  }
});

Deno.test("a hook that refuses the work does not lose it: the caller waits instead", async () => {
  const failures: string[] = [];
  let done = false;
  await settleAfterResponse(
    [["write", async () => {
      await sleep(1);
      done = true;
    }]],
    (name) => failures.push(name),
    {
      waitUntil: () => {
        throw new Error("not available in this worker");
      },
    },
  );
  assertEquals(done, true);
  assertEquals(failures, ["wait_until"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// The timing fields that stop this hiding again
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the tools/call log line carries pre_ms, total_ms and the round-trip counts", async () => {
  const { logs, w } = await run(world(), rpcRequest("tools/call", SIGNATURE_GET));
  const lines = logged(logs, "[mcp-server] tools/call");
  assertEquals(lines.length, 1);
  const line = lines[0];
  assertEquals(typeof line.pre_ms, "number");
  assertEquals(typeof line.total_ms, "number");
  assertEquals(typeof line.duration_ms, "number");
  assert((line.total_ms as number) >= (line.pre_ms as number));
  // The gate RPC alone, then the handler's one read. It was 3 and 4 with the
  // preflight (preflight + last_used_at + reservation), and 10 and 11 before
  // that (auth + last_used_at + 3 key windows + workspace window + plan row +
  // entitlement + allowance + reservation).
  assertEquals(line.pre_db_calls, 1);
  assertEquals(line.db_calls, 2);
  // activity_log.duration_ms is still the handler's clock and nothing else.
  assertEquals(w.inserted.activity_log[0].duration_ms, line.duration_ms);
  // Value-free: ids, names, numbers. No argument, address or token.
  assertEquals(Object.keys(line).sort(), [
    "db_calls", "dispatch_name", "duration_ms", "inbox_id", "key_id",
    "pre_db_calls", "pre_ms", "status", "tool_name", "total_ms",
  ]);
});

Deno.test("round trips are counted per request, not per isolate", async () => {
  const w = world();
  current = w;
  const logs = captureConsole();
  try {
    await Promise.all([
      handleRequest(rpcRequest("tools/call", SIGNATURE_GET)),
      handleRequest(rpcRequest("tools/call", SIGNATURE_GET)),
      handleRequest(rpcRequest("tools/call", SIGNATURE_GET)),
    ]);
  } finally {
    logs.restore();
  }
  assertEquals(logged(logs, "[mcp-server] tools/call").map((line) => line.db_calls), [2, 2, 2]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Methods other than tools/call keep the checks they had
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("ping is still checked against both limiters, and reads no allowance", async () => {
  const { status, labels } = await run(world(), rpcRequest("ping"));
  assertEquals(status, 200);
  assertEquals(labels.slice().sort(), [
    "GET api_keys",
    "GET user_usage_entitlements",
    "GET workspaces",
    KEY_COUNT,
    KEY_COUNT,
    KEY_COUNT,
    WORKSPACE_COUNT,
    "PATCH api_keys",
  ]);
  const limited = await run(world({ keyCounts: { minute: 120, hour: 120, day: 120 } }), rpcRequest("ping"));
  assertEquals(limited.status, 429);
  // Only tools/call leaves a rate_limited row.
  assertEquals(limited.w.inserted.activity_log, undefined);
});

Deno.test("tools/list keeps its discovery bucket alongside the same two limiters", async () => {
  const { status, calls, labels } = await run(world(), rpcRequest("tools/list"));
  assertEquals(status, 200);
  // Since 2026-10-20 the bucket is asked alongside the activity_log limiters
  // (it still DECIDES first; see the handshake tests at the end of the file).
  assert(
    firstStart(calls, "RPC rate_limit_check") < lastFinish(calls, KEY_COUNT),
    "the discovery bucket and the activity_log limiters overlap",
  );
  assertEquals(count(labels, "RPC rate_limit_check"), 2);
  assertEquals(count(labels, KEY_COUNT), 3);
  assertEquals(count(labels, WORKSPACE_COUNT), 1);
  assertEquals(count(labels, ALLOWANCE), 0);
  assertEquals(count(labels, "POST activity_log"), 0);
});

Deno.test("resources/* is still exempt from both activity_log limiters", async () => {
  const { labels } = await run(world(), rpcRequest("resources/list"));
  assertEquals(count(labels, KEY_COUNT), 0);
  assertEquals(count(labels, WORKSPACE_COUNT), 0);
  assertEquals(count(labels, "GET workspaces"), 0);
});

Deno.test("a non-billable tool reads no allowance row and reserves nothing", async () => {
  const { labels, body, calls } = await run(world(), rpcRequest("tools/call", { name: "inbox_list", arguments: {} }));
  assert(!body.result.isError, JSON.stringify(body));
  assertEquals(count(labels, ALLOWANCE), 0);
  assertEquals(count(labels, RESERVE), 0);
  assertEquals(calls.find((call) => call.label === PREFLIGHT)!.body!.p_include_allowance, false);
  const fallback = await run(perQuery(world()), rpcRequest("tools/call", { name: "inbox_list", arguments: {} }));
  assertEquals(count(fallback.labels, ALLOWANCE), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// The handshake: initialize, notifications, tools/list (2026-10-20)
//
// Before this date each was, in round trips before the handler:
//   initialize / tools/list  5  api_keys, discovery minute, discovery hour,
//                               the three key counts + workspace count + plan
//                               row, then the entitlement
//   a notification           1  api_keys (plus a last_used_at write), for a 202
// tools/list then read its card gates and its client identity one after the
// other. Every round trip is ~124 ms (us-east-1 to eu-north-1).
// ═══════════════════════════════════════════════════════════════════════════

const RATE_LIMIT_CHECK = "RPC rate_limit_check";
const CAPABILITIES = "GET mcp_client_capabilities";

function notification(method: string, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "pipeline-test/1.0",
  };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request("http://edge.example.test/mcp-server", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method }),
  });
}

Deno.test("a notification with a well-formed key is a 202 with no database round trip", async () => {
  for (const method of ["notifications/initialized", "notifications/cancelled"]) {
    const { status, body, labels, logs } = await run(world(), notification(method));
    assertEquals(status, 202);
    assertEquals(body, null);
    assertEquals(labels, [], `${method}: no key lookup and no last_used_at write`);
    assertEquals(
      logs.lines.filter((line) => line.args[0] === `[mcp-server] notification received: ${method}`).length,
      1,
    );
  }
});

Deno.test("a notification without a usable bearer token is still the same 401", async () => {
  for (const token of [null, "mcpe_short", `sk_${"a".repeat(66)}`]) {
    const { status, body, labels } = await run(world(), notification("notifications/initialized", token));
    assertEquals(status, 401, String(token));
    assertEquals(body.error.code, -32001);
    assertEquals(labels, []);
  }
  // A query-string credential is refused before anything else, as on every method.
  const viaQuery = await run(
    world(),
    new Request(`http://edge.example.test/mcp-server?key=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
  );
  assertEquals(viaQuery.status, 401);
});

Deno.test("an unknown or revoked key is still refused with a 401 on initialize and tools/list", async () => {
  for (const method of ["initialize", "tools/list"]) {
    const { status, body, labels } = await run(world({ key: null }), rpcRequest(method));
    assertEquals(status, 401, method);
    assertEquals(body.error.code, -32001);
    assertEquals(labels, ["GET api_keys"], `${method}: refused after the lookup and nothing else`);
  }
});

Deno.test("initialize and tools/list ask every gate read in one wave after authentication", async () => {
  for (const method of ["initialize", "tools/list"]) {
    const { waves, status } = await runInWaves(world(), rpcRequest(method));
    assertEquals(status, 200, method);
    assertEquals(waves[0], ["GET api_keys"], `${method}: authentication is still its own wave`);
    assertEquals(waves[1], [
      "GET workspaces",
      KEY_COUNT,
      KEY_COUNT,
      KEY_COUNT,
      WORKSPACE_COUNT,
      "PATCH api_keys",
      RATE_LIMIT_CHECK,
      RATE_LIMIT_CHECK,
    ].sort(), `${method}: both discovery windows and both gates' reads overlap`);
    assertEquals(waves[2], ["GET user_usage_entitlements"], method);
  }
});

Deno.test("tools/list reads its card gates and its client identity in the same wave", async () => {
  const { waves, status, body } = await runInWaves(world(), rpcRequest("tools/list"));
  assertEquals(status, 200);
  assert(body.result.tools.length > 0);
  // Wave 3 holds the entitlement (the plan quota's second read); the handler
  // starts once it has answered, and its reads all go out together: the card
  // gates (inboxes, the draft-editor workspace flag), the subscription
  // cleanup workspace flag and the client identity. The wave after it
  // is the card-build bookkeeping write, which is not the handler's.
  assertEquals(waves.length, 5, JSON.stringify(waves));
  assertEquals(waves[3], ["GET inboxes", "GET inboxes", CAPABILITIES, "GET workspaces", "GET workspaces"].sort());
  assertEquals(waves[4], ["PATCH api_keys"]);
});

Deno.test("initialize still waits for its capabilities upsert before answering", async () => {
  const { waves, status } = await runInWaves(
    world(),
    rpcRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pipeline-test", version: "1.0" },
    }),
  );
  assertEquals(status, 200);
  assertEquals(waves.length, 4, JSON.stringify(waves));
  assert(waves[3].some((label) => label.includes("mcp_client_capabilities")), JSON.stringify(waves));
});

for (const bucket of ["min", "hr"]) {
  Deno.test(`a refused discovery ${bucket} window is still the cheap-method 429, ahead of both gates`, async () => {
    // The per-key limiter and the plan ceiling are saturated too: the
    // discovery bucket must still be the one that answers.
    const { status, body, labels, logs, w } = await run(
      world({ bucketsOver: [bucket], keyCounts: { minute: 100, hour: 100, day: 100 }, workspaceCount: 500 }),
      rpcRequest("tools/list"),
    );
    assertEquals(status, 429);
    assertEquals(body.error.data.window, bucket === "min" ? "per_minute" : "per_hour");
    // The discovery ceilings, not the per-key limiter's: the base 250 / 2500
    // lifted by Personal's 1.2 (checkCheapMethodRateLimit).
    assertEquals(body.error.data.limit, bucket === "min" ? 300 : 3_000);
    assertEquals(logged(logs, "[mcp-server] cheap_method_rate_limit_exceeded").length, 1);
    assertEquals(logged(logs, "[mcp-server] rate_limit_exceeded").length, 0);
    assertEquals(logged(logs, "[mcp-server] plan_rate_limit_exceeded").length, 0);
    // Nothing written for a refused discovery call, and the handler never ran.
    assertEquals(w.inserted, {});
    assertEquals(count(labels, CAPABILITIES), 0);
    assertEquals(count(labels, "GET inboxes"), 0);
  });
}

Deno.test("both discovery windows refused: the minute window decides, as before", async () => {
  const { status, body } = await run(world({ bucketsOver: ["min", "hr"] }), rpcRequest("initialize"));
  assertEquals(status, 429);
  assertEquals(body.error.data.window, "per_minute");
});

Deno.test("a failed discovery window fails open for that window only", async () => {
  const w = world({ bucketsOver: ["hr"], fail: { [RATE_LIMIT_CHECK]: "http_500" } });
  const { status } = await run(w, rpcRequest("tools/list"));
  // Both answers are the 500, so both windows fail open.
  assertEquals(status, 200);
});

Deno.test("resources/* keeps its own bucket and is still refused by it", async () => {
  const { status, calls } = await run(world({ bucketsOver: ["min"] }), rpcRequest("resources/list"));
  assertEquals(status, 429);
  const keys = calls.filter((call) => call.label === RATE_LIMIT_CHECK).map((call) => call.body!.p_key);
  assertEquals(keys, [`mcp:resources:min:${KEY_ID}`, `mcp:resources:hr:${KEY_ID}`]);
});

Deno.test("ping still skips the discovery bucket", async () => {
  const { status, labels } = await run(world({ bucketsOver: ["min", "hr"] }), rpcRequest("ping"));
  assertEquals(status, 200);
  assertEquals(count(labels, RATE_LIMIT_CHECK), 0);
});

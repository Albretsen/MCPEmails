// supabaseStore against a recording stand-in for the Supabase client.

import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { planSlug, supabaseStore, toAssistantAllowance, unusableKeyHash, WEB_CLIENT_KEY_KIND } from "../store.ts";
import { keyRow, USER_ID, WORKSPACE_ID } from "./helpers.ts";

interface Recorded {
  table?: string;
  rpc?: string;
  ops: Array<[string, unknown[]]>;
}

type Answer = { data: unknown; error: { code?: string } | null };

/** A chainable, awaitable query builder that records what was asked. */
function fakeDb(answers: Answer[]) {
  const recorded: Recorded[] = [];
  const builder = (record: Recorded): unknown =>
    new Proxy(() => {}, {
      get(_target, prop) {
        if (prop === "then") {
          const answer = answers.shift() ?? { data: null, error: null };
          return (resolve: (value: Answer) => void) => resolve(answer);
        }
        return (...args: unknown[]) => {
          record.ops.push([String(prop), args]);
          return builder(record);
        };
      },
    });
  return {
    recorded,
    from(table: string) {
      const record: Recorded = { table, ops: [] };
      recorded.push(record);
      return builder(record);
    },
    rpc(name: string, args: unknown) {
      const record: Recorded = { rpc: name, ops: [["args", [args]]] };
      recorded.push(record);
      return builder(record);
    },
  };
}

Deno.test("ensureWebClientKey: an existing live key is returned without a write", async () => {
  const db = fakeDb([{ data: keyRow(), error: null }]);
  const row = await supabaseStore(db).ensureWebClientKey(WORKSPACE_ID);
  assertEquals(row.id, keyRow().id);
  assertEquals(db.recorded.length, 1);
  const filters = db.recorded[0].ops;
  assert(filters.some(([op, args]) => op === "eq" && args[0] === "workspace_id" && args[1] === WORKSPACE_ID));
  assert(filters.some(([op, args]) => op === "eq" && args[0] === "kind" && args[1] === WEB_CLIENT_KEY_KIND));
  assert(filters.some(([op, args]) => op === "is" && args[0] === "deleted_at" && args[1] === null));
});

Deno.test("ensureWebClientKey: a missing key is created hidden, ownerless and unusable as a credential", async () => {
  const db = fakeDb([{ data: null, error: null }, { data: keyRow(), error: null }]);
  await supabaseStore(db).ensureWebClientKey(WORKSPACE_ID);
  const insert = db.recorded[1].ops.find(([op]) => op === "insert")![1][0] as Record<string, unknown>;
  assertEquals(insert["workspace_id"], WORKSPACE_ID);
  assertEquals(insert["kind"], "web_client");
  assertEquals(insert["created_by"], null);
  assertEquals(insert["inbox_ids"], null);
  assertEquals(insert["name"], "__web_client__");
  // A presented key is matched by its SHA-256 hex digest: 64 hex characters.
  assertMatch(String(insert["key_hash"]), /^!web-client:[0-9a-f]{64}$/);
  assert(!/^[0-9a-f]{64}$/.test(String(insert["key_hash"])), "can never equal a digest");
});

Deno.test("ensureWebClientKey: losing the create race re-reads the winner's row", async () => {
  const db = fakeDb([
    { data: null, error: null },
    { data: null, error: { code: "23505" } },
    { data: { ...keyRow(), id: "77777777-7777-4777-8777-777777777777" }, error: null },
  ]);
  const row = await supabaseStore(db).ensureWebClientKey(WORKSPACE_ID);
  assertEquals(row.id, "77777777-7777-4777-8777-777777777777");
  assertEquals(db.recorded.length, 3);
});

Deno.test("ensureWebClientKey: a failed create with no winner is an error, never a made-up key", async () => {
  const db = fakeDb([{ data: null, error: null }, { data: null, error: { code: "42703" } }, { data: null, error: null }]);
  await assertRejects(() => supabaseStore(db).ensureWebClientKey(WORKSPACE_ID), Error, "web_client_key_create_failed:42703");
});

Deno.test("unusable key hashes are random", () => {
  assert(unusableKeyHash() !== unusableKeyHash());
});

Deno.test("memberships: joined workspace rows are flattened, soft-deleted workspaces filtered in the query", async () => {
  const db = fakeDb([{
    data: [
      { workspace_id: WORKSPACE_ID, role: "admin", joined_at: "2026-01-01T00:00:00Z", workspaces: { display_name: "One", plan: "solo", web_client_enabled: true } },
      { workspace_id: "x", role: "viewer", joined_at: "2026-02-01T00:00:00Z", workspaces: [{ display_name: "Two", plan: "free", web_client_enabled: null }] },
      { workspace_id: "y", role: "member", joined_at: "2026-03-01T00:00:00Z", workspaces: null },
    ],
    error: null,
  }]);
  const rows = await supabaseStore(db).memberships(USER_ID);
  assertEquals(rows, [
    { workspace_id: WORKSPACE_ID, role: "admin", joined_at: "2026-01-01T00:00:00Z", display_name: "One", plan: "solo", web_client_enabled: true },
    { workspace_id: "x", role: "viewer", joined_at: "2026-02-01T00:00:00Z", display_name: "Two", plan: "free", web_client_enabled: false },
  ]);
  const ops = db.recorded[0].ops;
  assert(ops.some(([op, args]) => op === "eq" && args[0] === "user_id" && args[1] === USER_ID));
  assert(ops.some(([op, args]) => op === "is" && args[0] === "workspaces.deleted_at" && args[1] === null));
});

Deno.test("memberships: a query failure throws rather than reading as 'no workspaces'", async () => {
  const db = fakeDb([{ data: null, error: { code: "PGRST301" } }]);
  await assertRejects(() => supabaseStore(db).memberships(USER_ID), Error, "memberships_failed");
});

Deno.test("allowance RPCs: argument names match the SQL functions, and usage is rounded and clamped", async () => {
  const row = { plan: "solo", cap: 1000, used: 12, remaining: 988, period_start: "2026-10-01T00:00:00+00:00", period_end: "2026-11-01T00:00:00+00:00", max_tokens_per_run: 120000 };
  const db = fakeDb([
    { data: [row], error: null },
    { data: [{ ...row, reservation_id: "r-1", allowed: true }], error: null },
    { data: true, error: null },
  ]);
  const store = supabaseStore(db);
  assertEquals(toAssistantAllowance((await store.allowance(WORKSPACE_ID))!), {
    plan: "solo",
    used: 12,
    cap: 1000,
    remaining: 988,
    period_start: "2026-10-01T00:00:00.000Z",
    resets_at: "2026-11-01T00:00:00.000Z",
    max_tokens_per_run: 120000,
  });
  assertEquals((await store.reserveRun(WORKSPACE_ID, USER_ID))!.reservation_id, "r-1");
  await store.finalizeRun("r-1", { input_tokens: 10.6, output_tokens: -3, cost_micro_usd: 99.2, model: "m" });
  assertEquals(db.recorded.map((r) => [r.rpc, r.ops[0][1][0]]), [
    ["workspace_assistant_allowance", { p_workspace_id: WORKSPACE_ID }],
    ["reserve_assistant_run", { p_workspace_id: WORKSPACE_ID, p_user_id: USER_ID }],
    ["finalize_assistant_run", { p_reservation_id: "r-1", p_input_tokens: 11, p_output_tokens: 0, p_cost_micro_usd: 99, p_model: "m" }],
  ]);
});

Deno.test("plan slugs: enterprise reads as the top plan, unknown as free", () => {
  assertEquals(["free", "personal", "solo", "pro", "enterprise", "weird", null].map((p) => planSlug(p)), [
    "free",
    "personal",
    "solo",
    "pro",
    "pro",
    "free",
    "free",
  ]);
});

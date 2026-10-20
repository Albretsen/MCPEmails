// parsePreflight: anything that is not the exact shape migration 20261020100000
// returns must come back null, which sends the call down the per-query path.
// A wrong shape may cost a round trip; it must never become a gate decision.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test tools-call-preflight.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  notePreflightError,
  parsePreflight,
  preflightAvailability,
  preflightParams,
  preflightSkipped,
} from "./tools-call-preflight.ts";

const KEY = { id: "k1", workspace_id: "w1", key_hash: "h".repeat(64), scopes: ["read:email"] };
const GOOD = {
  key: KEY,
  key_counts: [1, 2, 3],
  workspace: { plan: "free", grandfathered: false, owner_id: "u1" },
  entitlement: null,
  workspace_count: 4,
  allowance: { plan: "free", cap: 150 },
};

Deno.test("a well-formed answer is passed through unchanged", () => {
  const parsed = parsePreflight(GOOD, 3, true);
  assert(parsed !== null && parsed.kind === "key");
  assertEquals(parsed.key, KEY);
  assertEquals(parsed.keyCounts, [1, 2, 3]);
  assertEquals(parsed.workspaceCount, 4);
  assertEquals(parsed.allowance, { plan: "free", cap: 150 });
});

Deno.test("key: null is the dead-key answer, not a malformed one", () => {
  assertEquals(parsePreflight({ key: null }, 3, true), { kind: "no_key" });
});

Deno.test("an allowance the caller did not ask for is ignored", () => {
  const parsed = parsePreflight(GOOD, 3, false);
  assert(parsed !== null && parsed.kind === "key");
  assertEquals(parsed.allowance, null);
  assertEquals(parsed.allowanceRequested, false);
});

Deno.test("a missing workspace keeps a null count", () => {
  const parsed = parsePreflight({ ...GOOD, workspace: null, workspace_count: null }, 3, true);
  assert(parsed !== null && parsed.kind === "key");
  assertEquals(parsed.workspace, null);
  assertEquals(parsed.workspaceCount, null);
});

Deno.test("every other shape is refused", () => {
  const bad: unknown[] = [
    null,
    [],
    "x",
    {},
    { ...GOOD, key: "k1" },
    { ...GOOD, key: { ...KEY, id: 1 } },
    { ...GOOD, key: { ...KEY, workspace_id: undefined } },
    { ...GOOD, key: { ...KEY, key_hash: null } },
    { ...GOOD, key_counts: [1, 2] },
    { ...GOOD, key_counts: [1, 2, "3"] },
    { ...GOOD, key_counts: [1, 2, -1] },
    { ...GOOD, key_counts: [1, 2, 1.5] },
    { ...GOOD, key_counts: null },
    { ...GOOD, workspace: [] },
    { ...GOOD, workspace_count: null },
    { ...GOOD, workspace_count: "4" },
    { ...GOOD, entitlement: "comped_scale" },
    { ...GOOD, allowance: [GOOD.allowance] },
  ];
  for (const data of bad) assertEquals(parsePreflight(data, 3, true), null, JSON.stringify(data));
});

Deno.test("params carry the caller's windows and the allowance flag", () => {
  assertEquals(preflightParams("h", ["a", "b", "c"], "d", true), {
    p_key_hash: "h",
    p_key_window_starts: ["a", "b", "c"],
    p_workspace_window_start: "d",
    p_include_allowance: true,
  });
});

Deno.test("only 'no such function' starts the backoff, and it ends", () => {
  preflightAvailability.missingUntil = 0;
  notePreflightError("XX000", 1_000);
  notePreflightError(undefined, 1_000);
  assertEquals(preflightSkipped(1_000), false);
  notePreflightError("PGRST202", 1_000);
  assertEquals(preflightSkipped(1_001), true);
  assertEquals(preflightSkipped(61_000), false);
  preflightAvailability.missingUntil = 0;
});

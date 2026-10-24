// ---------------------------------------------------------------------------
// parked-inbox.ts: the words an assistant reads about a parked inbox, the
// scheduled-send parking rule, and the lookup that turns "not found" into
// "parked" without widening what a key can see.
//
// Run: HOST_GUARD_SKIP_NETWORK_TESTS=1 deno test --node-modules-dir=none \
//        --allow-read --allow-env supabase/functions/mcp-server/parked-inbox.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  billingPageUrl,
  findParkedInbox,
  inboxIsParked,
  listParkedInboxes,
  parkedInboxErrorText,
  parkedInboxHint,
  SCHEDULED_SEND_PARKED_DETAIL,
  scheduledSendBlockedByParking,
} from "./parked-inbox.ts";

const APP = "https://mcpemails.com";
const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const PARKED = "33333333-3333-4333-8333-333333333333";
const ACTIVE = "44444444-4444-4444-8444-444444444444";
const ELSEWHERE = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;

/** Applies eq / is / not-is / in / ilike (exact, case-insensitive) like PostgREST. */
function fakeDb(rows: Row[]) {
  return {
    from(table: string) {
      assertEquals(table, "inboxes");
      const filters: Array<(row: Row) => boolean> = [];
      const run = () => rows.filter((row) => filters.every((f) => f(row)));
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder),
        not: (c: string, op: string, v: unknown) => {
          assertEquals(op, "is");
          filters.push((r) => (r[c] ?? null) !== v);
          return builder;
        },
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), builder),
        // PostgREST rewrites `*` to `%`, and `%` / `_` are wildcards; an escaped
        // pattern only matches itself, which is all this double models.
        ilike: (c: string, pattern: string) => {
          const unescaped = pattern.replace(/\\(.)/g, "$1").toLowerCase();
          const hasWildcard = /(^|[^\\])[%_*]/.test(pattern);
          filters.push((r) => !hasWildcard && String(r[c]).toLowerCase() === unescaped);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
      };
      return builder;
    },
  };
}

const ROWS: Row[] = [
  { id: PARKED, workspace_id: WS, email_address: "Parked@Example.com", deleted_at: null, parked_at: "2026-11-01T00:00:00Z" },
  { id: ACTIVE, workspace_id: WS, email_address: "active@example.com", deleted_at: null, parked_at: null },
  { id: ELSEWHERE, workspace_id: OTHER_WS, email_address: "other@example.com", deleted_at: null, parked_at: "2026-11-01T00:00:00Z" },
];
const KEY = { workspace_id: WS, inbox_ids: null };

Deno.test("the hint names MCPEmails and the billing page, and no plan slug or em dash", () => {
  for (const text of [parkedInboxHint(APP), parkedInboxErrorText(["a@example.com"], APP), SCHEDULED_SEND_PARKED_DETAIL]) {
    assert(!text.includes("\u2014"), "no em dash");
    for (const slug of ["solo", "pro_month", "personal", "free plan"]) {
      assert(!text.toLowerCase().includes(slug), `no plan slug: ${slug}`);
    }
  }
  assertStringIncludes(parkedInboxHint(APP), "MCPEmails");
  assertStringIncludes(parkedInboxHint(APP), `${APP}/dashboard/settings`);
  assertEquals(billingPageUrl(`${APP}/`), `${APP}/dashboard/settings`);
});

Deno.test("the error text names the inbox and says nothing was done", () => {
  const one = parkedInboxErrorText(["a@example.com"], APP);
  assertStringIncludes(one, "The inbox a@example.com is parked");
  assertStringIncludes(one, "Nothing was deleted and nothing was done");
  assertStringIncludes(parkedInboxErrorText(["a@example.com", "b@example.com"], APP), "are parked");
  assertStringIncludes(parkedInboxErrorText([], APP), "Every inbox this key can use is parked");
});

Deno.test("parked means a non-null parked_at; an absent column is not parked", () => {
  assert(inboxIsParked({ parked_at: "2026-11-01T00:00:00Z" }));
  assert(!inboxIsParked({ parked_at: null }));
  assert(!inboxIsParked({}));
  assert(!inboxIsParked(null));
});

Deno.test("scheduled sends: before parking delivers, at or after parking is refused", () => {
  const inbox = { parked_at: "2026-11-01T00:00:00.000Z" };
  assert(!scheduledSendBlockedByParking({ created_at: "2026-10-31T23:59:59.000Z" }, inbox));
  assert(scheduledSendBlockedByParking({ created_at: "2026-11-01T00:00:00.000Z" }, inbox));
  assert(scheduledSendBlockedByParking({ created_at: "2026-11-05T00:00:00.000Z" }, inbox));
  assert(!scheduledSendBlockedByParking({ created_at: "2026-11-05T00:00:00.000Z" }, { parked_at: null }));
  // Unreadable timestamps deliver: sending what the customer asked for is the safe side.
  assert(!scheduledSendBlockedByParking({ created_at: "garbage" }, inbox));
});

Deno.test("findParkedInbox: by id and by exact address, in the key's workspace only", async () => {
  const db = fakeDb(ROWS);
  assertEquals((await findParkedInbox(db, KEY, { inboxId: PARKED }))?.id, PARKED);
  assertEquals((await findParkedInbox(db, KEY, { email: "parked@example.com" }))?.id, PARKED);
  assertEquals(await findParkedInbox(db, KEY, { inboxId: ACTIVE }), null, "an active inbox is not parked");
  assertEquals(await findParkedInbox(db, KEY, { inboxId: ELSEWHERE }), null, "another workspace stays invisible");
  assertEquals(await findParkedInbox(db, KEY, { email: "other@example.com" }), null);
  assertEquals(await findParkedInbox(db, KEY, { email: "%@example.com" }), null, "a pattern is not an address");
  assertEquals(await findParkedInbox(db, KEY, { email: "not-an-address" }), null);
});

Deno.test("findParkedInbox honours the key's inbox allowlist", async () => {
  const db = fakeDb(ROWS);
  const narrow = { workspace_id: WS, inbox_ids: [ACTIVE] };
  assertEquals(await findParkedInbox(db, narrow, { inboxId: PARKED }), null);
  assertEquals(await findParkedInbox(db, narrow, { email: "parked@example.com" }), null);
  assertEquals((await findParkedInbox(db, { workspace_id: WS, inbox_ids: [PARKED] }, { inboxId: PARKED }))?.id, PARKED);
});

Deno.test("listParkedInboxes lists this workspace's parked inboxes only", async () => {
  const parked = await listParkedInboxes(fakeDb(ROWS), KEY);
  assertEquals(parked.map((p) => p.id), [PARKED]);
});

Deno.test("a failing database never throws out of the lookups", async () => {
  const broken = {
    from: () => {
      throw new Error("boom");
    },
  };
  assertEquals(await findParkedInbox(broken, KEY, { inboxId: PARKED }), null);
  assertEquals(await listParkedInboxes(broken, KEY), []);
});

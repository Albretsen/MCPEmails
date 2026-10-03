// ---------------------------------------------------------------------------
// provider-call-scheduling.test.ts — HOW the provider requests are issued:
// how many at once, and how many round trips deep a call is.
//
// provider-call-baseline.test.ts pins WHAT these tools return and which
// requests they make, and was green before any of this existed. This file is
// the other half: each test here fails if the path it covers goes back to one
// request at a time, and fails if it stops being bounded.
//
// "Rounds" is the measure. The harness holds every Gmail / Graph request and
// answers all the outstanding ones together each time the code under test goes
// quiet; the number of times it had to do that is the call's serial depth. At
// roughly 200 ms per Gmail round trip and 250 ms per Graph one, a round is
// what the user waits for.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env \
//        supabase/functions/mcp-server/provider-call-scheduling.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  API_KEY,
  executeListDrafts,
  gmailMeta,
  INBOX_ID,
  inboxRow,
  json,
  messageIdOf,
  type ProviderCall,
  runRounds,
  runTool,
} from "./provider-call-harness.ts";

interface ToolOutcome {
  result: {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  logStatus: string;
  logErrorCode: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pad(i: number): string {
  return String(i + 1).padStart(2, "0");
}

// ═══════════════════════════════════════════════════════════════════════════
// draft_list — Gmail
// ═══════════════════════════════════════════════════════════════════════════

/** The cap this suite holds draft_list to. Five is what index.ts ships. */
const DRAFT_CAP = 5;

function draftListing(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `draft-${pad(i)}`, message: { id: `dm${pad(i)}` } }));
}

function draftAnswer(call: ProviderCall, count: number): Response {
  if (call.url.includes("/drafts?")) return json({ drafts: draftListing(count) });
  const id = messageIdOf(call);
  return json(gmailMeta({ id, subject: `Draft ${id}`, to: `reader-${id}@drafts.example`, internalDate: "1767225600000" }));
}

function draftIds(outcome: ToolOutcome): string[] {
  return (outcome.result.structuredContent!.drafts as { draft_id: string }[]).map((d) => d.draft_id);
}

Deno.test("draft_list (gmail): 20 drafts are fetched five at a time, in 5 rounds instead of 21", async () => {
  const inbox = await inboxRow("gmail");
  const run = await runRounds(
    inbox,
    (call) => draftAnswer(call, 20),
    () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
  );
  assertEquals(draftIds(run.value), draftListing(20).map((d) => d.id));
  assertEquals(run.world.maxInFlight, DRAFT_CAP, "exactly the cap in flight: not one at a time, not all twenty");
  // The listing, then four waves of five. One at a time this was 21.
  assertEquals(run.roundSizes, [1, 5, 5, 5, 5]);
  assertEquals(run.rounds, 5);
});

Deno.test("draft_list (gmail): the maximum page of 50 is 11 rounds, never more than five in flight", async () => {
  const inbox = await inboxRow("gmail");
  const run = await runRounds(
    inbox,
    (call) => draftAnswer(call, 50),
    () => executeListDrafts({ inbox_id: INBOX_ID, limit: 50 }, API_KEY) as Promise<ToolOutcome>,
  );
  assertEquals(draftIds(run.value), draftListing(50).map((d) => d.id));
  assertEquals(run.world.maxInFlight, DRAFT_CAP);
  assertEquals(run.rounds, 11);
  assert(run.roundSizes.every((size) => size <= DRAFT_CAP));
});

Deno.test("draft_list (gmail): fewer drafts than the cap is two rounds, and a single draft is not held back", async () => {
  for (const count of [1, 3]) {
    const inbox = await inboxRow("gmail");
    const run = await runRounds(
      inbox,
      (call) => draftAnswer(call, count),
      () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
    );
    assertEquals(draftIds(run.value), draftListing(count).map((d) => d.id));
    assertEquals(run.roundSizes, [1, count]);
  }
});

Deno.test("draft_list (gmail): the order is drafts.list order even when later gets answer first", async () => {
  // Real latency, arranged so that within every wave the LAST request issued
  // is the first to answer. A result assembled in completion order would come
  // back scrambled.
  const inbox = await inboxRow("gmail");
  const completed: string[] = [];
  const run = await runTool(
    inbox,
    async (call) => {
      if (call.url.includes("/drafts?")) return json({ drafts: draftListing(20) });
      const id = messageIdOf(call);
      const n = Number(id.slice(2));
      await sleep(4 * (DRAFT_CAP - ((n - 1) % DRAFT_CAP)));
      completed.push(id);
      return draftAnswer(call, 20);
    },
    () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
  );
  assertEquals(draftIds(run.value), draftListing(20).map((d) => d.id));
  assert(
    completed.join() !== draftListing(20).map((d) => d.message.id).join(),
    "the gets really did finish out of order, or this test proves nothing",
  );
  assert(run.world.maxInFlight <= DRAFT_CAP, `never above the cap, saw ${run.world.maxInFlight}`);
  assert(run.world.maxInFlight > 1);
});

Deno.test("draft_list (gmail): failed gets do not disturb the cap or the order of the rest", async () => {
  const inbox = await inboxRow("gmail");
  const failing = new Set(["dm01", "dm07", "dm08", "dm20"]);
  const run = await runRounds(
    inbox,
    (call) => {
      if (!call.url.includes("/drafts?") && failing.has(messageIdOf(call))) {
        if (messageIdOf(call) === "dm07") throw new TypeError("connection reset");
        return json({ error: { message: "Too many concurrent requests for user" } }, 429);
      }
      return draftAnswer(call, 20);
    },
    () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
  );
  assertEquals(
    draftIds(run.value),
    draftListing(20).filter((d) => !failing.has(d.message.id)).map((d) => d.id),
  );
  assertEquals(run.world.maxInFlight, DRAFT_CAP);
  assertEquals(run.rounds, 5, "a failure does not stop the fan-out or serialise it");
  assertEquals(run.world.calls.length, 21, "every draft is still asked for exactly once");
});

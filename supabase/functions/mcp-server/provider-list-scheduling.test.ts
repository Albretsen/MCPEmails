// ---------------------------------------------------------------------------
// provider-list-scheduling.test.ts — email_list on Gmail asks labels.get for
// the exact total WHILE the per-row messages.get calls are in flight, instead
// of before them.
//
// provider-call-baseline.test.ts pins what the listing returns in every
// combination of the two succeeding and failing. This file pins the overlap:
// it fails if labels.get goes back to being a round trip of its own.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env \
//        supabase/functions/mcp-server/provider-list-scheduling.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  API_KEY,
  executeListInbox,
  gmailMeta,
  INBOX_ID,
  inboxRow,
  json,
  messageIdOf,
  type ProviderCall,
  type ProviderHandler,
  requestSequence,
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
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);
}

const isList = (c: ProviderCall) => c.url.includes("/messages?");
const isLabel = (c: ProviderCall) => c.url.includes("/labels/");

function answer(call: ProviderCall, refs: string[], more = true): Response {
  if (isList(call)) {
    return json({
      messages: refs.map((id) => ({ id, threadId: `t-${id}` })),
      ...(more ? { nextPageToken: "page-2" } : {}),
      resultSizeEstimate: 201,
    });
  }
  if (isLabel(call)) return json({ messagesTotal: 5700, messagesUnread: 4 });
  const id = messageIdOf(call);
  return json(gmailMeta({
    id,
    from: `Sender ${id} <sender-${id}@mail.example>`,
    to: "owner@gmail-harness.example",
    subject: `Subject ${id}`,
    snippet: `Preview of ${id}`,
    internalDate: "1767225600000",
  }));
}

function summary(outcome: ToolOutcome) {
  const s = outcome.result.structuredContent as {
    messages: { id: string }[];
    total: number;
    total_is_estimate: boolean;
  };
  return { ids: s.messages.map((m) => m.id), total: s.total, estimate: s.total_is_estimate };
}

async function list(handler: ProviderHandler, limit: number, held: boolean) {
  const inbox = await inboxRow("gmail");
  const body = () => executeListInbox({ inbox_id: INBOX_ID, limit }, API_KEY) as Promise<ToolOutcome>;
  return held ? await runRounds(inbox, handler, body) : { ...(await runTool(inbox, handler, body)), roundSizes: [] as number[], rounds: 0 };
}

Deno.test("email_list (gmail): labels.get shares a round with the row gets: 2 rounds instead of 3", async () => {
  for (const limit of [1, 20, 100]) {
    const refs = ids(limit);
    const run = await list((call) => answer(call, refs), limit, true);
    assertEquals(summary(run.value), { ids: refs, total: 5700, estimate: false });
    // The listing, then labels.get and every row together. Before, labels.get
    // was a round of its own between the two.
    assertEquals(run.roundSizes, [1, limit + 1], `limit ${limit}`);
    assertEquals(run.rounds, 2);
    assertEquals(run.world.calls.length, limit + 2, "the same requests, none added");
    // Still issued in the order it always was: the listing, the label, the rows.
    assertEquals(requestSequence(run.world).slice(0, 2), [
      `GET ${GMAIL}/messages?labelIds=INBOX&maxResults=${limit}`,
      `GET ${GMAIL}/labels/INBOX`,
    ]);
  }
});

Deno.test("email_list (gmail): a label that fits the page still makes no labels.get", async () => {
  const refs = ids(6);
  const run = await list((call) => answer(call, refs, false), 20, true);
  assertEquals(summary(run.value), { ids: refs, total: 6, estimate: false });
  assertEquals(run.roundSizes, [1, 6]);
  assert(run.world.calls.every((c) => !isLabel(c)));
});

Deno.test("email_list (gmail): the result is the same whichever of labels.get and the rows answers last", async () => {
  const refs = ids(8);
  for (const slow of ["label", "rows"] as const) {
    const finished: string[] = [];
    const run = await list(async (call) => {
      if (isLabel(call)) {
        await sleep(slow === "label" ? 25 : 1);
        finished.push("label");
      } else if (!isList(call)) {
        await sleep(slow === "rows" ? 25 : 1);
        finished.push("row");
      }
      return answer(call, refs);
    }, 8, false);
    assertEquals(summary(run.value), { ids: refs, total: 5700, estimate: false }, `slow ${slow}`);
    assertEquals(finished[slow === "label" ? finished.length - 1 : 0], "label", "the timing really was as arranged");
  }
});

Deno.test("email_list (gmail): labels.get failing while the rows are in flight keeps the estimate and every row", async () => {
  const refs = ids(8);
  for (const failure of ["500", "reject", "late reject"] as const) {
    const run = await list(async (call) => {
      if (isLabel(call)) {
        if (failure === "late reject") await sleep(20);
        if (failure === "500") return json({ error: { message: "Backend Error" } }, 500);
        throw new TypeError("connection reset");
      }
      return answer(call, refs);
    }, 8, false);
    assertEquals(summary(run.value), { ids: refs, total: 201, estimate: true }, failure);
    assertEquals(run.value.result.isError, false);
  }
});

Deno.test("email_list (gmail): a row failing while labels.get is still out fails the listing, and labels.get is not left running", async () => {
  const refs = ids(6);
  for (const labelMs of [1, 30]) {
    const inbox = await inboxRow("gmail");
    let labelOutstanding = false;
    let outstandingAtReturn: boolean | null = null;
    const run = await runTool(
      inbox,
      async (call) => {
        if (isLabel(call)) {
          labelOutstanding = true;
          await sleep(labelMs);
          labelOutstanding = false;
          return answer(call, refs);
        }
        if (!isList(call) && messageIdOf(call) === "l03") {
          await sleep(8);
          throw new TypeError("connection reset");
        }
        return answer(call, refs);
      },
      async () => {
        const outcome = await executeListInbox({ inbox_id: INBOX_ID, limit: 6 }, API_KEY) as ToolOutcome;
        // Read at the instant the tool returns, before the harness lets
        // anything else settle.
        outstandingAtReturn = labelOutstanding;
        return outcome;
      },
    );
    assertEquals(run.value.result.isError, true);
    assertEquals(
      run.value.result.content[0].text,
      "Provider error while listing inbox: connection reset. Please try again in a moment.",
    );
    assertEquals(outstandingAtReturn, false, `labels.get (${labelMs} ms) had answered before the call returned`);
    assertEquals(run.world.calls.length, 8);
  }
});

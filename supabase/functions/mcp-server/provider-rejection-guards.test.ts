// ---------------------------------------------------------------------------
// provider-rejection-guards.test.ts — two invariants of the draft_list fan-out
// and the labels.get overlap that were, until this file, enforced only by the
// test PROCESS dying ("uncaught error", or a promise left pending) when they
// were broken. Each now has an assertion with a name.
//
//   1. mapWithConcurrency starts nothing after a failure and settles; a draft
//      get that throws is left out of draft_list and never becomes an
//      unhandled rejection.
//   2. In email_list, a row get that fails while labels.get is still out (and
//      labels.get then fails too) surfaces exactly the error it always did,
//      and the row's rejection is never reported as unhandled while the
//      listing waits for labels.get. That is what `metaLookup.catch(() => {})`
//      in listGmailMessages is for.
//
// Unhandled rejections are recorded through the `unhandledrejection` event
// and its default (ending the process) is prevented, so a missing guard fails
// an assertion here instead of aborting the run.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env \
//        supabase/functions/mcp-server/provider-rejection-guards.test.ts
// ---------------------------------------------------------------------------

import { assertEquals } from "jsr:@std/assert@1";
import { mapWithConcurrency } from "./provider-concurrency.ts";
import {
  API_KEY,
  executeListDrafts,
  executeListInbox,
  gmailMeta,
  INBOX_ID,
  inboxRow,
  json,
  messageIdOf,
  type ProviderCall,
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

/** Run `body`, returning the reasons of every rejection nobody handled. */
async function recordingUnhandled<T>(body: () => Promise<T>): Promise<{ value: T; unhandled: string[] }> {
  const unhandled: string[] = [];
  const listener = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    unhandled.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
  };
  globalThis.addEventListener("unhandledrejection", listener);
  try {
    const value = await body();
    // The event is dispatched after the microtask queue drains.
    await sleep(5);
    return { value, unhandled };
  } finally {
    globalThis.removeEventListener("unhandledrejection", listener);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The bounded map, and draft_list on top of it
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("mapWithConcurrency: after failures it starts nothing more, settles, and leaves no rejection unhandled", async () => {
  const gates = Array.from({ length: 8 }, () => deferred<string>());
  const started: number[] = [];
  const { value, unhandled } = await recordingUnhandled(async () => {
    const pending = mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 4, (_item, index) => {
      started.push(index);
      return gates[index].promise;
    });
    await sleep(0);
    gates[3].reject(new Error("failure at 3"));
    await sleep(0);
    gates[1].reject(new Error("failure at 1"));
    await sleep(0);
    gates[2].reject(new Error("failure at 2"));
    await sleep(0);
    gates[0].resolve("r0");
    // A bounded wait, so a map that kept starting work (whose gates nobody
    // will ever open) fails the assertion below instead of hanging the run.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(() => "resolved", (e: Error) => `rejected: ${e.message}`),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
    clearTimeout(timer);
    // Release anything a broken map started, so nothing outlives the test.
    for (const gate of gates) gate.resolve("late");
    await sleep(0);
    return outcome;
  });
  assertEquals(started, [0, 1, 2, 3], "indexes 4 to 7 must never be started once a task has failed");
  assertEquals(value, "rejected: failure at 1", "it settles, with the lowest-index failure");
  assertEquals(unhandled, [], "the other two failures are consumed, not left unhandled");
});

function draftListing(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return { id: `draft-${n}`, message: { id: `dm${n}` } };
  });
}

Deno.test("draft_list (gmail): gets that throw are left out, in any timing, with no unhandled rejection", async () => {
  // Failing gets spread across waves, some answering before and some after
  // the successes around them. The fan-out of five means several of these are
  // in flight together.
  const failing: Record<string, number> = { dm01: 12, dm02: 1, dm05: 6, dm06: 1, dm12: 9 };
  const inbox = await inboxRow("gmail");
  const { value: run, unhandled } = await recordingUnhandled(() =>
    runTool(
      inbox,
      async (call) => {
        if (call.url.includes("/drafts?")) return json({ drafts: draftListing(12) });
        const id = messageIdOf(call);
        if (id in failing) {
          await sleep(failing[id]);
          throw new TypeError(`connection reset reading ${id}`);
        }
        await sleep(3);
        return json(gmailMeta({ id, subject: `Draft ${id}`, to: `reader-${id}@drafts.example`, internalDate: "1767225600000" }));
      },
      () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
    )
  );
  assertEquals(run.value.result.isError, undefined, "a failed get never fails the listing");
  assertEquals(run.value.logStatus, "success");
  assertEquals(
    (run.value.result.structuredContent!.drafts as { draft_id: string }[]).map((d) => d.draft_id),
    ["draft-03", "draft-04", "draft-07", "draft-08", "draft-09", "draft-10", "draft-11"],
  );
  assertEquals(run.world.calls.length, 13, "every draft was still asked for once");
  assertEquals(unhandled, [], "no draft get's rejection escaped");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. email_list: a row failing while labels.get is still out
// ═══════════════════════════════════════════════════════════════════════════

const isList = (c: ProviderCall) => c.url.includes("/messages?");
const isLabel = (c: ProviderCall) => c.url.includes("/labels/");
const ROW_ERROR = "Provider error while listing inbox: connection reset. Please try again in a moment.";

function listAnswer(call: ProviderCall, refs: string[]): Response {
  if (isList(call)) {
    return json({ messages: refs.map((id) => ({ id, threadId: `t-${id}` })), nextPageToken: "page-2", resultSizeEstimate: 201 });
  }
  const id = messageIdOf(call);
  return json(gmailMeta({ id, from: "sender@mail.example", subject: `Subject ${id}`, internalDate: "1767225600000" }));
}

Deno.test("email_list (gmail): a row failing while labels.get is still out surfaces the old error and nothing unhandled", async () => {
  const refs = ["l01", "l02", "l03", "l04", "l05"];
  // What labels.get does, well after the row has already failed.
  const labelOutcomes: Record<string, () => Response> = {
    "answers": () => json({ messagesTotal: 5700, messagesUnread: 4 }),
    "answers 500": () => json({ error: { message: "Backend Error" } }, 500),
    "drops the connection": () => {
      throw new TypeError("labels connection reset");
    },
  };
  for (const [name, labelOutcome] of Object.entries(labelOutcomes)) {
    const inbox = await inboxRow("gmail");
    let labelOutstanding = false;
    let outstandingAtReturn: boolean | null = null;
    const { value: run, unhandled } = await recordingUnhandled(() =>
      runTool(
        inbox,
        async (call) => {
          if (isLabel(call)) {
            labelOutstanding = true;
            await sleep(30);
            labelOutstanding = false;
            return labelOutcome();
          }
          if (!isList(call) && messageIdOf(call) === "l02") {
            await sleep(2);
            throw new TypeError("connection reset");
          }
          return listAnswer(call, refs);
        },
        async () => {
          const outcome = await executeListInbox({ inbox_id: INBOX_ID, limit: 5 }, API_KEY) as ToolOutcome;
          outstandingAtReturn = labelOutstanding;
          return outcome;
        },
      )
    );
    assertEquals(run.value.result.content, [{ type: "text", text: ROW_ERROR }], `labels.get ${name}`);
    assertEquals(run.value.result.isError, true);
    assertEquals(run.value.logErrorCode, "provider_error");
    assertEquals(outstandingAtReturn, false, `labels.get ${name}: it had settled before the listing returned`);
    assertEquals(
      unhandled,
      [],
      `labels.get ${name}: the row's rejection must be held, not reported unhandled, while labels.get is awaited`,
    );
    assertEquals(run.world.calls.length, 7, "listing, label and five rows: nothing added, nothing dropped");
  }
});

Deno.test("email_list (gmail): two rows failing while labels.get is out report the first one's error once", async () => {
  const refs = ["l01", "l02", "l03", "l04"];
  const inbox = await inboxRow("gmail");
  const { value: run, unhandled } = await recordingUnhandled(() =>
    runTool(
      inbox,
      async (call) => {
        if (isLabel(call)) {
          await sleep(25);
          return json({ error: { message: "Backend Error" } }, 500);
        }
        if (!isList(call) && messageIdOf(call) === "l03") {
          await sleep(2);
          throw new TypeError("connection reset");
        }
        if (!isList(call) && messageIdOf(call) === "l01") {
          await sleep(10);
          throw new TypeError("a later, different failure");
        }
        return listAnswer(call, refs);
      },
      () => executeListInbox({ inbox_id: INBOX_ID, limit: 4 }, API_KEY) as Promise<ToolOutcome>,
    )
  );
  // Promise.all over the rows rejects with whichever row failed first in
  // time, exactly as it did when labels.get ran before them.
  assertEquals(run.value.result.content, [{ type: "text", text: ROW_ERROR }]);
  assertEquals(unhandled, []);
});

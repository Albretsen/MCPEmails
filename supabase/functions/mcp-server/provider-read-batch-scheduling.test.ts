// ---------------------------------------------------------------------------
// provider-read-batch-scheduling.test.ts — email_read_batch on Gmail and
// Outlook reads up to four messages ahead, and everything it returns is still
// decided in the order the ids were asked for.
//
// provider-call-baseline.test.ts pins the results. This file pins the
// scheduling: each test fails if the batch goes back to one read at a time,
// and fails if it stops being bounded at four. "Rounds" is explained in
// provider-call-harness.ts.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env \
//        supabase/functions/mcp-server/provider-read-batch-scheduling.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  API_KEY,
  executeReadEmails,
  gmailFull,
  graphMessage,
  INBOX_ID,
  inboxRow,
  json,
  messageIdOf,
  type ProviderCall,
  type ProviderHandler,
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

const READ_AHEAD = 4;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
}

function gmailAnswer(call: ProviderCall, text: (id: string) => string = (id) => `Body of ${id}`): Response {
  const id = messageIdOf(call);
  return json(gmailFull({
    id,
    from: `Sender ${id} <sender-${id}@mail.example>`,
    to: "owner@gmail-harness.example",
    subject: `Subject ${id}`,
    text: text(id),
    internalDate: "1767225600000",
  }));
}

function graphAnswer(call: ProviderCall): Response {
  const id = messageIdOf(call);
  return json(graphMessage({
    id,
    subject: `Subject ${id}`,
    from: { name: `Sender ${id}`, address: `sender-${id}@mail.example` },
    contentType: "text",
    content: `Body of ${id}`,
  }));
}

function readIds(outcome: ToolOutcome): string[] {
  return (outcome.result.structuredContent!.messages as { id: string }[]).map((m) => m.id);
}

async function rounds(provider: "gmail" | "outlook", handler: ProviderHandler, args: Record<string, unknown>) {
  const inbox = await inboxRow(provider);
  return await runRounds(
    inbox,
    handler,
    () => executeReadEmails({ inbox_id: INBOX_ID, ...args }, API_KEY) as Promise<ToolOutcome>,
  );
}

Deno.test("email_read_batch: 20 messages are 6 rounds instead of 20, never more than four in flight", async () => {
  for (const provider of ["gmail", "outlook"] as const) {
    const order = ids("m", 20);
    const run = await rounds(provider, provider === "gmail" ? (c) => gmailAnswer(c) : graphAnswer, { message_ids: order });
    assertEquals(readIds(run.value), order);
    assertEquals(run.world.maxInFlight, READ_AHEAD, `${provider}: exactly four, not one and not twenty`);
    // The first read alone, then the other nineteen four at a time.
    assertEquals(run.roundSizes, [1, 4, 4, 4, 4, 3], provider);
    assertEquals(run.world.calls.length, 20, "each message is still requested exactly once");
  }
});

Deno.test("email_read_batch: the maximum batch of 50 is 14 rounds instead of 50", async () => {
  for (const provider of ["gmail", "outlook"] as const) {
    const order = ids("m", 50);
    const run = await rounds(provider, provider === "gmail" ? (c) => gmailAnswer(c) : graphAnswer, { message_ids: order });
    assertEquals(readIds(run.value), order);
    assertEquals(run.world.maxInFlight, READ_AHEAD);
    assertEquals(run.rounds, 14, provider);
    assert(run.roundSizes.every((size) => size <= READ_AHEAD));
    assertEquals(run.world.calls.length, 50);
  }
});

Deno.test("email_read_batch: one or two messages are not held back, and a single message is one round", async () => {
  const one = await rounds("gmail", (c) => gmailAnswer(c), { message_ids: ["m01"] });
  assertEquals(one.roundSizes, [1]);
  const three = await rounds("gmail", (c) => gmailAnswer(c), { message_ids: ids("m", 3) });
  assertEquals(three.roundSizes, [1, 2]);
});

Deno.test("email_read_batch (gmail): the body budget is spent in the order asked even when later reads answer first", async () => {
  // The baseline's budget batch, with real latency arranged so that within
  // every group of four the LAST read issued answers first. The emitted
  // lengths below are the ones the serial code produced (copied from
  // provider-call-baseline.test.ts): a budget charged in completion order
  // gives different numbers.
  const order = ids("b", 20);
  const sizes = [5000, 40, 3000, 0, 2600, 9, 2600, 2600, 700, 2600, 2600, 2600, 15, 2600, 2600, 2600, 2600, 2600, 2600, 2600];
  const bodies: Record<string, string> = {};
  order.forEach((id, i) => {
    const unit = i % 4 === 2 ? "\u{1F4EC}" : String.fromCharCode(97 + (i % 26));
    bodies[id] = unit.repeat(Math.ceil(sizes[i] / unit.length)) + (i % 5 === 0 ? "!" : "");
  });
  const inbox = await inboxRow("gmail");
  const completed: string[] = [];
  const run = await runTool(
    inbox,
    async (call) => {
      const id = messageIdOf(call);
      const n = Number(id.slice(1));
      await sleep(4 * (READ_AHEAD - (n % READ_AHEAD)));
      completed.push(id);
      if (id === "b04") return json({ error: { message: "Backend Error" } }, 500);
      return gmailAnswer(call, (m) => bodies[m]);
    },
    () => executeReadEmails({ inbox_id: INBOX_ID, message_ids: order }, API_KEY) as Promise<ToolOutcome>,
  );
  assert(completed.join() !== order.join(), "the reads really did finish out of order, or this proves nothing");
  const messages = run.value.result.structuredContent!.messages as { id: string; body_text: string }[];
  assertEquals(messages.map((m) => m.id), order.filter((id) => id !== "b04"));
  assertEquals(
    messages.map((m) => m.body_text.length),
    [1200, 40, 1264, 1343, 10, 1438, 1438, 700, 1506, 1506, 1506, 15, 1719, 1718, 1719, 1719, 1719, 1720, 1720],
  );
  assertEquals(run.value.result.structuredContent!.errors, [
    { message_id: "b04", error: "Provider error: Gmail API error: Backend Error" },
  ]);
  assert(run.world.maxInFlight <= READ_AHEAD, `never above four, saw ${run.world.maxInFlight}`);
  assert(run.world.maxInFlight > 1);
});

Deno.test("email_read_batch (gmail): error entries stay in the order asked when the failing reads answer out of order", async () => {
  const order = ids("m", 13);
  const failing: Record<string, number> = { m03: 500, m04: 404, m09: 429, m12: 404 };
  const inbox = await inboxRow("gmail");
  const run = await runTool(
    inbox,
    async (call) => {
      const id = messageIdOf(call);
      // Failures answer late, successes early: completion order puts every
      // error after the messages around it.
      await sleep(failing[id] ? 14 : 2);
      if (failing[id]) return json({ error: { message: `status ${failing[id]}` } }, failing[id]);
      return gmailAnswer(call);
    },
    () => executeReadEmails({ inbox_id: INBOX_ID, message_ids: order }, API_KEY) as Promise<ToolOutcome>,
  );
  assertEquals(readIds(run.value), order.filter((id) => !failing[id]));
  assertEquals(
    (run.value.result.structuredContent!.errors as { message_id: string }[]).map((e) => e.message_id),
    ["m03", "m04", "m09", "m12"],
  );
  assertEquals(
    run.world.console.filter((l) => l.level === "error").map((l) => (l.args[1] as { message_id: string }).message_id),
    ["m03", "m09"],
    "the server's own error log keeps the order too",
  );
});

Deno.test("email_read_batch: nothing is read ahead until one message has been read", async () => {
  // Three stale ids first. While nothing has succeeded the batch goes one id
  // at a time, exactly as it always did; the first success opens the window.
  const order = ids("m", 12);
  const run = await rounds("gmail", (call) => {
    const id = messageIdOf(call);
    if (["m01", "m02", "m03"].includes(id)) return json({ error: { message: "Requested entity was not found." } }, 404);
    return gmailAnswer(call);
  }, { message_ids: order });
  assertEquals(run.roundSizes, [1, 1, 1, 1, 4, 4]);
  assertEquals(readIds(run.value), order.slice(3));
});

Deno.test("email_read_batch: include_attachments stays strictly one read at a time", async () => {
  const order = ids("m", 6);
  const run = await rounds("gmail", (c) => gmailAnswer(c), { message_ids: order, include_attachments: true });
  assertEquals(readIds(run.value), order);
  assertEquals(run.world.maxInFlight, 1);
  assertEquals(run.roundSizes, [1, 1, 1, 1, 1, 1]);
});

Deno.test("email_read_batch: an auth failure part-way wastes at most three reads, and none outlives the call", async () => {
  for (const provider of ["gmail", "outlook"] as const) {
    const order = ids("m", 16);
    const inbox = await inboxRow(provider);
    let open = 0;
    let openAtReturn = -1;
    const run = await runTool(
      inbox,
      async (call) => {
        if (call.host === "login.microsoftonline.com") return json({ error: "invalid_grant" }, 400);
        const id = messageIdOf(call);
        // Reads issued ahead of the fatal one are slow, so they are still in
        // flight when it is consumed.
        open++;
        await sleep(id === "m06" ? 2 : 25);
        open--;
        if (id === "m06") {
          return provider === "gmail"
            ? json({ error: { message: "Invalid Credentials" } }, 401)
            : new Response(null, { status: 401 });
        }
        return provider === "gmail" ? gmailAnswer(call) : graphAnswer(call);
      },
      async () => {
        const outcome = await executeReadEmails({ inbox_id: INBOX_ID, message_ids: order }, API_KEY) as ToolOutcome;
        // Read at the instant the tool returns, before the harness lets
        // anything else settle.
        openAtReturn = open;
        return outcome;
      },
    );
    assertEquals(openAtReturn, 0, `${provider}: every read that was issued had answered before the call returned`);
    assertEquals(run.value.result.isError, true);
    assertEquals(run.value.logErrorCode, "auth_failed");
    const requested = run.world.calls.filter((c) => c.host !== "login.microsoftonline.com").map(messageIdOf);
    assertEquals(new Set(requested).size, requested.length);
    // m06 is index 5: nothing past index 5 + 3 may ever have been asked for.
    assert(requested.every((id) => order.indexOf(id) <= 8), `${provider}: read too far ahead: ${requested}`);
    assert(requested.length > 6, `${provider}: reads really were in flight past the fatal one, or this proves nothing`);
    assert(run.world.maxInFlight <= READ_AHEAD);
  }
});

Deno.test("email_read_batch (outlook): a token refused mid-batch is refreshed once however many reads were in flight", async () => {
  // The old token stops working after the fifth read. Up to four reads are in
  // flight on it; they share ONE refresh and are each retried on the new token.
  const order = ids("m", 14);
  const inbox = await inboxRow("outlook");
  let served = 0;
  const run = await runTool(
    inbox,
    (call) => {
      if (call.host === "login.microsoftonline.com") {
        return json({ access_token: "refreshed-graph-token", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      if (call.bearer !== "refreshed-graph-token" && ++served > 5) return new Response(null, { status: 401 });
      return graphAnswer(call);
    },
    () => executeReadEmails({ inbox_id: INBOX_ID, message_ids: order }, API_KEY) as Promise<ToolOutcome>,
  );
  assertEquals(readIds(run.value), order);
  assertEquals(run.value.result.structuredContent!.errors, []);
  assertEquals(run.world.calls.filter((c) => c.host === "login.microsoftonline.com").length, 1);
  assertEquals(run.world.db.filter((d) => d.method === "PATCH").length, 1, "one rotated token persisted");
});

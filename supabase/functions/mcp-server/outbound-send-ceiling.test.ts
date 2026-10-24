// ---------------------------------------------------------------------------
// Per-inbox daily send ceiling and the workspace send freeze
// (outbound-brakes.ts, migration 20261024130000_outbound_abuse_brakes.sql).
//
// The counting itself is one atomic SQL function and is covered by pgTAP
// (supabase/tests/outbound_abuse_brakes.sql). This file holds the edge side:
// what the gate is asked, how its answer becomes a tool result, that a DB
// failure fails open, and that every send path asks it before anything is
// queued or transmitted.
//
// Run: deno test --allow-read supabase/functions/mcp-server/outbound-send-ceiling.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  brakeRefusalResult,
  type BrakeDb,
  checkOutboundBrakes,
  DAILY_SEND_LIMIT_ERROR_CODE,
  DAILY_SEND_LIMIT_PER_INBOX,
  OUTBOUND_BRAKE_ERROR_CODES,
  parseGateAnswer,
  SEND_LIMIT_META_KEY,
  SENDS_FROZEN_ERROR_CODE,
} from "./outbound-brakes.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const MIGRATION = await Deno.readTextFile(
  new URL("../../migrations/20261024130000_outbound_abuse_brakes.sql", import.meta.url),
);

/** A db whose outbound_send_gate answers `answer` and records every call. */
function fakeDb(answer: { data: unknown; error: { message: string } | null } | (() => never)) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: BrakeDb = {
    rpc(fn, args) {
      calls.push({ fn, args });
      if (typeof answer === "function") return Promise.reject(new Error("network down"));
      return Promise.resolve(answer);
    },
  };
  return { db, calls };
}

const SEND = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  inboxId: "22222222-2222-2222-2222-222222222222",
  messages: 1,
  subject: "Quarterly update",
  body: "Hello there",
  recipients: ["ann@example.test"],
  humanApproved: false,
};

Deno.test("the ceiling is 500 messages per inbox per 24 hours, and the gate is told so", async () => {
  assertEquals(DAILY_SEND_LIMIT_PER_INBOX, 500);
  const { db, calls } = fakeDb({ data: { decision: "allow" }, error: null });
  assertEquals(await checkOutboundBrakes(db, SEND), { kind: "allow" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "outbound_send_gate");
  assertEquals(calls[0].args.p_daily_limit, 500);
  assertEquals(calls[0].args.p_inbox_id, SEND.inboxId);
  assertEquals(calls[0].args.p_commit, true, "an allowed send is counted in the same transaction");
});

Deno.test("a forward batch counts every message, not every recipient", async () => {
  const { db, calls } = fakeDb({ data: { decision: "allow" }, error: null });
  await checkOutboundBrakes(db, {
    ...SEND,
    messages: 12,
    recipients: ["a@example.test", "b@example.test", "c@example.test"],
  });
  assertEquals(calls[0].args.p_messages, 12);
  // The SQL sums `messages` over kind = 'message' rows, one row per call.
  assert(/sum\(messages\)/.test(MIGRATION) && /kind = 'message'/.test(MIGRATION), "the ceiling sums messages");
});

Deno.test("hitting the ceiling is an isError result with daily_send_limit and a retry time", () => {
  const decision = parseGateAnswer({ decision: "daily_limit", retry_at: "2026-10-25T09:30:00+00:00" });
  assertEquals(decision, { kind: "refuse", code: DAILY_SEND_LIMIT_ERROR_CODE, retryAt: "2026-10-25T09:30:00+00:00" });
  const refusal = brakeRefusalResult("email_send", decision as Extract<typeof decision, { kind: "refuse" }>);
  assertEquals(refusal.result.isError, true);
  assertEquals(refusal.result.delivery_status, "not_sent");
  assertEquals(refusal.logErrorCode, "daily_send_limit");
  const meta = refusal.result._meta[SEND_LIMIT_META_KEY] as Record<string, unknown>;
  assertEquals(meta.error_code, "daily_send_limit");
  assertEquals(meta.retry_at, "2026-10-25T09:30:00+00:00");
  const text = refusal.result.content[0].text;
  assert(text.includes("500 messages in 24 hours"), text);
  assert(text.includes("Nothing was sent"), text);
  assert(text.includes("2026-10-25 09:30 UTC"), text);
  assert(!text.includes(String.fromCharCode(0x2014)), "no em dashes in agent-facing copy");
});

Deno.test("a frozen workspace refuses every send with sends_frozen", () => {
  const decision = parseGateAnswer({ decision: "frozen" });
  assertEquals(decision, { kind: "refuse", code: SENDS_FROZEN_ERROR_CODE, retryAt: null });
  const refusal = brakeRefusalResult("email_reply", decision as Extract<typeof decision, { kind: "refuse" }>);
  assertEquals(refusal.logErrorCode, "sends_frozen");
  assert(refusal.result.content[0].text.includes("MCPEmails support"));
  assert(/ADD COLUMN IF NOT EXISTS sends_frozen_at timestamptz/.test(MIGRATION), "the column is nullable timestamptz");
  assert(/IF v_frozen IS NOT NULL THEN/.test(MIGRATION), "the gate checks the freeze first");
});

Deno.test("a DB error, a throw or a malformed answer fails open", async () => {
  for (
    const answer of [
      { data: null, error: { message: "function outbound_send_gate does not exist" } },
      { data: { decision: "maybe" }, error: null },
      { data: "allow", error: null },
      () => {
        throw new Error("unreachable");
      },
    ]
  ) {
    const { db } = fakeDb(answer as never);
    assertEquals(await checkOutboundBrakes(db, SEND), { kind: "allow" });
  }
});

Deno.test("a brake refusal releases the idempotency key and holds an approved send", () => {
  for (const code of ["daily_send_limit", "sends_paused_provider_refusals", "sends_frozen"]) {
    assert(OUTBOUND_BRAKE_ERROR_CODES.has(code), code);
  }
  assert(
    /OUTBOUND_BRAKE_ERROR_CODES\.has\(logErrorCode\)\)\s*\)\s*\{\s*const \{ error: releaseError \}/.test(SOURCE),
    "completeOutboundIdempotency releases the key on a brake refusal, like a provider not-sent",
  );
  assert(
    /OUTBOUND_BRAKE_ERROR_CODES\.has\(dispatchedResult\.logErrorCode\)\s*\)\s*\{\s*throw new ScheduledDispatchHeld/
      .test(SOURCE),
    "the dispatcher holds an approved send a brake refused, never fails it",
  );
  const held = SOURCE.indexOf("OUTBOUND_BRAKE_ERROR_CODES.has(dispatchedResult.logErrorCode)");
  const settled = SOURCE.indexOf("await deps.completeApprovedIdempotency(", held - 4000);
  assert(held > 0 && settled > held, "the hold comes before the approval's idempotency record is settled");
});

/** The body of an `async function NAME(` in index.ts, up to the next top-level function. */
function handlerSource(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} is gone from index.ts`);
  const end = SOURCE.indexOf("\nasync function ", start + 1);
  return SOURCE.slice(start, end < 0 ? undefined : end);
}

Deno.test("every send handler asks the brakes after chat confirm and before queueing or sending", () => {
  for (
    const [handler, tool] of [
      ["executeSendEmail", "email_send"],
      ["executeReplyToEmail", "email_reply"],
      ["executeForwardEmail", "email_forward"],
      ["executeSendDraft", "draft_send"],
    ]
  ) {
    const body = handlerSource(handler);
    const chat = body.indexOf("await chatConfirmGate(");
    const brake = body.indexOf("await outboundBrakeGate(");
    const queue = body.indexOf("await queueSendApproval(");
    assert(brake > 0, `${handler} asks outboundBrakeGate`);
    assert(chat > 0 && chat < brake, `${handler}: chat confirm comes first, so a refusal there counts nothing`);
    assert(brake < queue, `${handler}: the brake comes before the approval queue`);
    assert(body.includes(`tool: "${tool}"`), `${handler} names its tool in the refusal`);
    assert(/if \("refusal" in brake\) return brake\.refusal;/.test(body), `${handler} returns the refusal`);
  }
});

Deno.test("scheduled sends are checked by the dispatcher just before the provider send", () => {
  const dispatch = SOURCE.slice(SOURCE.indexOf("async function handleScheduledDispatch("));
  const brake = dispatch.indexOf("await deps.outboundBrake(");
  const send = dispatch.indexOf("await deps.sendViaProvider(inbox, sendParams)");
  assert(brake > 0 && brake < send, "the brake is asked before the provider send");
  assert(
    /if \(brake\.kind === "refuse"\) \{\s*throw new ScheduledDispatchHeld/.test(dispatch),
    "a refused scheduled send is held pending, not failed",
  );
});

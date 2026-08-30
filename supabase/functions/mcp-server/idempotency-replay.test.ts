// ---------------------------------------------------------------------------
// A replay exists to hand back an answer the caller lost. These tests pin the
// two things that makes true: the envelope carries the original result, and it
// still says `idempotent_replay: true` so nobody mistakes a collapsed retry for
// a second send. The snapshot tests exist for the other half of the bargain —
// the ledger may keep ids and outcomes, never recipients or subjects.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildReplayEnvelope,
  idempotencyResultSnapshot,
  MAX_SNAPSHOT_CHARS,
  noNewEffectPhrase,
} from "./idempotency-replay.ts";

// The shape email_send returns on success.
const SEND_RESULT = {
  message_id: "199f0d1c2b3a4e5f",
  thread_id: "199f0d1c2b3a4e5f",
  sent_at: "2026-08-30T13:44:02.000Z",
  to: [{ email: "bjellanda@gmail.com", name: null }],
  cc: [],
  bcc: [],
  subject: "health check",
  status: "sent",
};

Deno.test("a replay carries the original result and the replay flag", () => {
  const envelope = buildReplayEnvelope({
    key: "hc-20260830-1344-p210",
    status: "succeeded",
    result: idempotencyResultSnapshot(SEND_RESULT),
    isMutation: false,
  });

  assertEquals(envelope.idempotent_replay, true);
  assertEquals(envelope.status, "succeeded");
  assertEquals(envelope.idempotency_key, "hc-20260830-1344-p210");

  const result = envelope.result as Record<string, unknown>;
  // The whole point: the message_id the retry was trying to recover.
  assertEquals(result.message_id, "199f0d1c2b3a4e5f");
  assertEquals(result.thread_id, "199f0d1c2b3a4e5f");
  assertEquals(result.sent_at, "2026-08-30T13:44:02.000Z");
  assertEquals(result.status, "sent");

  // And the message points at it, so a model does not retry a third time.
  assertStringIncludes(envelope.message as string, "result");
  assertStringIncludes(envelope.message as string, "No new email was sent.");
});

Deno.test("the snapshot keeps ids and outcome, never recipients or subject", () => {
  const snapshot = idempotencyResultSnapshot(SEND_RESULT);
  assert(snapshot);
  assertEquals(Object.hasOwn(snapshot, "to"), false);
  assertEquals(Object.hasOwn(snapshot, "cc"), false);
  assertEquals(Object.hasOwn(snapshot, "bcc"), false);
  assertEquals(Object.hasOwn(snapshot, "subject"), false);
});

Deno.test("a bulk result snapshot keeps counts and per-message outcomes", () => {
  const snapshot = idempotencyResultSnapshot({
    succeeded: 2,
    failed: 1,
    operation: "email_move_batch",
    inbox_id: "1245c938-5567-400d-9bf3-a81371a890bf",
    results: [
      { message_id: "A", success: true },
      { message_id: "B", success: true },
      { message_id: "bogus", success: false, error: "message_not_found" },
    ],
  });
  assert(snapshot);
  assertEquals(snapshot.succeeded, 2);
  assertEquals(snapshot.failed, 1);
  assertEquals((snapshot.results as unknown[]).length, 3);
});

Deno.test("an oversized bulk snapshot drops the array and keeps the counts", () => {
  const results = Array.from({ length: 500 }, (_, i) => ({
    message_id: `message-id-that-is-quite-long-${i}`,
    success: true,
  }));
  const snapshot = idempotencyResultSnapshot({
    succeeded: 500,
    failed: 0,
    operation: "email_delete_batch",
    results,
  });
  assert(snapshot);
  assertEquals(snapshot.succeeded, 500);
  assertEquals(Object.hasOwn(snapshot, "results"), false);
  assertEquals(snapshot.results_omitted, true);
  assert(JSON.stringify(snapshot).length <= MAX_SNAPSHOT_CHARS);
});

Deno.test("a result with nothing replayable stores nothing", () => {
  assertEquals(idempotencyResultSnapshot({ subject: "hi", to: ["a@b.c"] }), null);
  assertEquals(idempotencyResultSnapshot(null), null);
  assertEquals(idempotencyResultSnapshot("not an object"), null);
});

Deno.test("a replay with no stored snapshot keeps its original wording", () => {
  const envelope = buildReplayEnvelope({
    key: "k",
    status: "succeeded",
    result: null,
    isMutation: false,
  });
  assertEquals(envelope.idempotent_replay, true);
  assertEquals(Object.hasOwn(envelope, "result"), false);
  assertEquals(
    envelope.message,
    "This logical request was already processed. No new email was sent.",
  );
});

Deno.test("a mutation replay speaks about the mailbox, not about email", () => {
  const envelope = buildReplayEnvelope({
    key: "k",
    status: "succeeded",
    result: { operation: "email_move_batch", succeeded: 2, failed: 1 },
    isMutation: true,
  });
  assertStringIncludes(
    envelope.message as string,
    "The mailbox was not changed again by this retry.",
  );
  assertEquals(noNewEffectPhrase(true), "The mailbox was not changed again by this retry.");
  assertEquals(noNewEffectPhrase(false), "No new email was sent.");
});

Deno.test("unknown and approval statuses keep their existing wording", () => {
  const unknown = buildReplayEnvelope({
    key: "k",
    status: "unknown",
    result: { message_id: "x" },
    isMutation: false,
  });
  assertEquals(
    unknown.message,
    "A prior submission may have reached the provider. No new email was sent. " +
      "Check Sent before taking further action.",
  );

  const pending = buildReplayEnvelope({
    key: "k",
    status: "pending_approval",
    approvalId: "ap_1",
    isMutation: false,
  });
  assertEquals(pending.approval_id, "ap_1");
  assertStringIncludes(pending.message as string, "awaiting dashboard approval");
});

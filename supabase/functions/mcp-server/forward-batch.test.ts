import {
  FORWARD_BATCH_MAX_IDS,
  type ForwardBatchDeps,
  type ForwardClaim,
  type ForwardFailure,
  type ForwardOutcome,
  type ForwardSentMessage,
  forwardMessageArgs,
  forwardMessageIdempotencyKey,
  parseForwardTargets,
  runForwardMessages,
  summarizeForwardBatch,
} from "./forward-batch.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("parseForwardTargets reads a single message_id", () => {
  const targets = parseForwardTargets("email_forward", { message_id: "INBOX:1" });
  assert(targets.ok, "accepted");
  if (!targets.ok || targets.mode !== "single") throw new Error("expected single mode");
  assertEquals(targets.messageId, "INBOX:1", "id preserved");
});

Deno.test("parseForwardTargets reads message_ids and de-duplicates them", () => {
  const targets = parseForwardTargets("email_forward", {
    message_ids: ["INBOX:1", "INBOX:2", "INBOX:1", "  ", 7],
  });
  assert(targets.ok, "accepted");
  if (!targets.ok || targets.mode !== "batch") throw new Error("expected batch mode");
  assertEquals(targets.messageIds.join(","), "INBOX:1,INBOX:2", "deduped, order kept");
});

Deno.test("parseForwardTargets refuses both forms in one call", () => {
  const targets = parseForwardTargets("email_forward", {
    message_id: "INBOX:1",
    message_ids: ["INBOX:2"],
  });
  assert(!targets.ok, "refused");
  if (targets.ok) return;
  assert(targets.message.includes("not both"), "says why");
});

Deno.test("parseForwardTargets refuses neither form", () => {
  const targets = parseForwardTargets("email_forward", {});
  assert(!targets.ok, "refused");
  if (targets.ok) return;
  assert(targets.message.includes("message_ids"), "points at the batch form too");
});

Deno.test("parseForwardTargets refuses an over-cap or empty list", () => {
  const tooMany = parseForwardTargets("email_forward", {
    message_ids: Array.from({ length: FORWARD_BATCH_MAX_IDS + 1 }, (_, i) => `INBOX:${i}`),
  });
  assert(!tooMany.ok, "over-cap refused");
  if (!tooMany.ok) assert(tooMany.message.includes("50"), "names the cap");

  const empty = parseForwardTargets("email_forward", { message_ids: ["", "  "] });
  assert(!empty.ok, "an all-blank list is refused");

  const notArray = parseForwardTargets("email_forward", { message_ids: "INBOX:1" });
  assert(!notArray.ok, "a bare string is refused");
});

function outcome(
  message_id: string,
  status: ForwardOutcome["status"],
): ForwardOutcome {
  return { message_id, status };
}

Deno.test("summarizeForwardBatch counts a clean run as completed", () => {
  const summary = summarizeForwardBatch([outcome("a", "sent"), outcome("b", "sent")]);
  assertEquals(summary.succeeded, 2, "both counted");
  assertEquals(summary.failed, 0, "none failed");
  assertEquals(summary.status, "completed", "completed");
  assertEquals(summary.partial, false, "not partial");
  assertEquals(summary.needs_reconciliation, false, "nothing ambiguous");
});

Deno.test("summarizeForwardBatch reports a partial batch without losing the successes", () => {
  const summary = summarizeForwardBatch([
    outcome("a", "sent"),
    outcome("b", "sent"),
    outcome("c", "not_sent"),
  ]);
  assertEquals(summary.succeeded, 2, "the two that went are still counted");
  assertEquals(summary.failed, 1, "one failed");
  assertEquals(summary.status, "completed_with_errors", "ran to the end");
  assertEquals(summary.partial, true, "must not be filed as done");
  assertEquals(summary.needs_reconciliation, false, "not_sent needs no reconciling");
});

Deno.test("summarizeForwardBatch counts an idempotent replay as a success", () => {
  const summary = summarizeForwardBatch([
    outcome("a", "already_sent"),
    outcome("b", "sent"),
  ]);
  assertEquals(summary.succeeded, 2, "already_sent is delivered, not failed");
  assertEquals(summary.status, "completed", "nothing outstanding");
  assertEquals(summary.partial, false, "a full retry that finished is not partial");
});

Deno.test("summarizeForwardBatch flags a run that stopped early", () => {
  const summary = summarizeForwardBatch([
    outcome("a", "sent"),
    outcome("b", "not_sent"),
    outcome("c", "not_attempted"),
  ]);
  assertEquals(summary.status, "stopped_early", "stopped_early wins over with_errors");
  assertEquals(summary.partial, true, "partial");
});

Deno.test("summarizeForwardBatch flags an unknown outcome for reconciliation", () => {
  const summary = summarizeForwardBatch([outcome("a", "unknown")]);
  assertEquals(summary.needs_reconciliation, true, "caller must check Sent");
  assertEquals(summary.failed, 1, "unknown is not counted as delivered");
});

Deno.test("forwardMessageIdempotencyKey is stable and per message", () => {
  const a = forwardMessageIdempotencyKey("batch-1", "INBOX:1");
  const b = forwardMessageIdempotencyKey("batch-1", "INBOX:2");
  assertEquals(a, forwardMessageIdempotencyKey("batch-1", "INBOX:1"), "stable across retries");
  assert(a !== b, "different messages take different keys");
  assert(
    forwardMessageIdempotencyKey("batch-1", "INBOX:1") !==
      forwardMessageIdempotencyKey("batch-2", "INBOX:1"),
    "different batch keys take different keys",
  );
});

Deno.test("forwardMessageArgs derives per-message arguments the ledger can digest", () => {
  const args = forwardMessageArgs({
    inbox_id: "inbox",
    message_ids: ["INBOX:1", "INBOX:2"],
    to: ["bilag@example.com"],
    include_attachments: true,
    idempotency_key: "batch-1",
  }, "INBOX:2");
  assertEquals(args["message_id"], "INBOX:2", "single id set");
  assertEquals(args["message_ids"], undefined, "batch list removed");
  assertEquals(args["idempotency_key"], undefined, "key never enters the digest");
  assertEquals(args["include_attachments"], true, "the rest of the call is kept");
});

Deno.test("forwardMessageArgs does not mutate the caller's arguments", () => {
  const original = { message_ids: ["INBOX:1"], to: ["a@example.com"] };
  forwardMessageArgs(original, "INBOX:1");
  assertEquals(Array.isArray(original.message_ids), true, "batch list still present");
});

// ── runForwardMessages ──────────────────────────────────────────────────────

/**
 * A fake provider plus a fake idempotency ledger.
 *
 * The ledger is modelled the way the real one behaves: a row per (key, message)
 * that starts `processing`, is settled `succeeded` or released, and answers a
 * later claim for the same pair with a replay. That is what makes the retry
 * test below a real test of resumability rather than of the harness.
 */
function harness(options: {
  /** message id → what forwarding it does, per attempt. */
  behaviour: Record<string, Array<"ok" | "fail" | "fatal" | "unknown">>;
} = { behaviour: {} }) {
  const attempts: Record<string, number> = {};
  const sentLog: string[] = [];
  const ledger = new Map<string, { status: "processing" | "succeeded" | "failed" | "unknown"; sentMessageId?: string }>();

  const deps: ForwardBatchDeps = {
    claim: (messageId, derivedKey) => {
      const row = ledger.get(derivedKey);
      if (row === undefined) {
        ledger.set(derivedKey, { status: "processing" });
        currentKey.set(messageId, derivedKey);
        return Promise.resolve<ForwardClaim>({ kind: "proceed" });
      }
      if (row.status === "processing") return Promise.resolve<ForwardClaim>({ kind: "processing" });
      return Promise.resolve<ForwardClaim>({
        kind: "replay",
        status: row.status,
        ...(row.sentMessageId ? { sentMessageId: row.sentMessageId } : {}),
      });
    },
    forwardOne: (messageId) => {
      const plan = options.behaviour[messageId] ?? ["ok"];
      const attempt = attempts[messageId] ?? 0;
      attempts[messageId] = attempt + 1;
      const outcome = plan[Math.min(attempt, plan.length - 1)];
      if (outcome === "ok") {
        sentLog.push(messageId);
        return Promise.resolve<ForwardSentMessage>({
          message_id: `sent-${messageId}`,
          thread_id: `thread-${messageId}`,
          sent_at: "2026-09-07T10:00:00Z",
          subject: "Fwd: invoice",
        });
      }
      return Promise.reject(new Error(outcome));
    },
    classifyFailure: (err): ForwardFailure => {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "fatal") {
        return { status: "not_sent", error: "no credentials", ledgerCode: "released", fatal: true };
      }
      if (message === "unknown") {
        return { status: "unknown", error: "handed over then failed", ledgerCode: "provider_error", fatal: false };
      }
      return { status: "not_sent", error: "refused before transmission", ledgerCode: "released", fatal: false };
    },
    settle: (messageId, result) => {
      const key = currentKey.get(messageId);
      if (key === undefined) return Promise.resolve();
      if (result.ok) {
        ledger.set(key, { status: "succeeded", sentMessageId: result.sent.message_id });
      } else if (result.ledgerCode === "released") {
        // Mirrors completeOutboundIdempotency: a provably not-sent failure
        // deletes the row so the next attempt claims it clean.
        ledger.delete(key);
      } else {
        ledger.set(key, { status: "unknown" });
      }
      return Promise.resolve();
    },
  };
  const currentKey = new Map<string, string>();
  return { deps, sentLog, attempts, ledger };
}

Deno.test("runForwardMessages forwards every message in the order given", async () => {
  const { deps, sentLog } = harness();
  const outcomes = await runForwardMessages(["a", "b", "c"], null, deps);
  assertEquals(sentLog.join(","), "a,b,c", "sequential, in order");
  assertEquals(outcomes.map((o) => o.status).join(","), "sent,sent,sent", "all sent");
  assertEquals(outcomes[0].sent_message_id, "sent-a", "new message id reported");
  assertEquals(outcomes[0].message_id, "a", "keyed by the SOURCE id");
});

Deno.test("runForwardMessages keeps going after one message fails", async () => {
  const { deps, sentLog } = harness({ behaviour: { b: ["fail"] } });
  const outcomes = await runForwardMessages(["a", "b", "c"], null, deps);
  assertEquals(sentLog.join(","), "a,c", "c is still attempted");
  assertEquals(outcomes.map((o) => o.status).join(","), "sent,not_sent,sent", "per-message truth");
  const summary = summarizeForwardBatch(outcomes);
  assertEquals(summary.succeeded, 2, "the two that went are reported");
  assertEquals(summary.partial, true, "partial");
});

Deno.test("runForwardMessages stops on a fatal failure and says the rest were not attempted", async () => {
  const { deps, sentLog } = harness({ behaviour: { b: ["fatal"] } });
  const outcomes = await runForwardMessages(["a", "b", "c", "d"], null, deps);
  assertEquals(sentLog.join(","), "a", "nothing after the fatal failure is tried");
  assertEquals(
    outcomes.map((o) => o.status).join(","),
    "sent,not_sent,not_attempted,not_attempted",
    "the remainder is explicitly not attempted",
  );
  assert(
    String(outcomes[2].error).includes("no credentials"),
    "the reason the batch stopped travels to every skipped id",
  );
  assertEquals(summarizeForwardBatch(outcomes).status, "stopped_early", "stopped_early");
});

Deno.test("runForwardMessages reports an unknown delivery for one message only", async () => {
  const { deps } = harness({ behaviour: { b: ["unknown"] } });
  const outcomes = await runForwardMessages(["a", "b", "c"], null, deps);
  assertEquals(outcomes[1].status, "unknown", "only b is ambiguous");
  assertEquals(outcomes[2].status, "sent", "c still went");
  assertEquals(
    summarizeForwardBatch(outcomes).needs_reconciliation,
    true,
    "the caller is told to reconcile",
  );
});

Deno.test("a retry of a partial batch re-sends only what did not go", async () => {
  // First run: b fails before transmission, a and c go.
  const h = harness({ behaviour: { b: ["fail", "ok"] } });
  const first = await runForwardMessages(["a", "b", "c"], "key-1", h.deps);
  assertEquals(first.map((o) => o.status).join(","), "sent,not_sent,sent", "one failure");
  assertEquals(h.sentLog.join(","), "a,c", "two transmitted");

  // The identical call with the identical key.
  const second = await runForwardMessages(["a", "b", "c"], "key-1", h.deps);
  assertEquals(
    second.map((o) => o.status).join(","),
    "already_sent,sent,already_sent",
    "a and c are replayed; b is actually sent",
  );
  assertEquals(h.sentLog.join(","), "a,c,b", "b, and only b, was transmitted by the retry");
  assertEquals(h.attempts["a"], 1, "a was never forwarded twice");
  assertEquals(second[0].sent_message_id, "sent-a", "the replay hands back the original id");
  assertEquals(summarizeForwardBatch(second).succeeded, 3, "the retry completes the job");
  assertEquals(summarizeForwardBatch(second).partial, false, "and is not partial");
});

Deno.test("a retry does not re-send a message whose delivery is unknown", async () => {
  const h = harness({ behaviour: { b: ["unknown", "ok"] } });
  await runForwardMessages(["a", "b"], "key-2", h.deps);
  const second = await runForwardMessages(["a", "b"], "key-2", h.deps);
  assertEquals(second[1].status, "unknown", "b stays ambiguous rather than being duplicated");
  assertEquals(h.attempts["b"], 1, "b was attempted exactly once");
});

Deno.test("runForwardMessages stops when retry protection is unavailable", async () => {
  const deps: ForwardBatchDeps = {
    claim: () => Promise.resolve<ForwardClaim>({ kind: "unavailable" }),
    forwardOne: () => {
      throw new Error("must not forward without protection");
    },
    classifyFailure: () => ({ status: "not_sent", error: "x", ledgerCode: "x", fatal: false }),
    settle: () => Promise.resolve(),
  };
  const outcomes = await runForwardMessages(["a", "b"], "key-3", deps);
  assertEquals(outcomes[0].status, "not_sent", "nothing was sent");
  assertEquals(outcomes[1].status, "not_attempted", "and the run stopped");
});

Deno.test("runForwardMessages never settles a ledger row it did not claim", async () => {
  let settled = 0;
  const deps: ForwardBatchDeps = {
    claim: () => Promise.resolve(null),
    forwardOne: (messageId) => Promise.resolve<ForwardSentMessage>({ message_id: `sent-${messageId}` }),
    classifyFailure: () => ({ status: "not_sent", error: "x", ledgerCode: "x", fatal: false }),
    settle: () => {
      settled++;
      return Promise.resolve();
    },
  };
  const outcomes = await runForwardMessages(["a"], "key-4", deps);
  assertEquals(outcomes[0].status, "sent", "sent");
  assertEquals(settled, 0, "an unclaimed message settles nothing");
});

Deno.test("runForwardMessages stops voluntarily when the wall-clock budget is spent", async () => {
  const { deps, sentLog } = harness();
  let started = 0;
  const outcomes = await runForwardMessages(["a", "b", "c"], null, {
    ...deps,
    budgetExhausted: () => started++ >= 2,
  });
  assertEquals(sentLog.join(","), "a,b", "only what fitted was sent");
  assertEquals(outcomes[2].status, "not_attempted", "the rest is reported, not dropped");
  assert(
    String(outcomes[2].error).includes("idempotency_key"),
    "the caller is told how to resume without duplicating",
  );
  assertEquals(summarizeForwardBatch(outcomes).status, "stopped_early", "stopped_early");
});

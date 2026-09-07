// ---------------------------------------------------------------------------
// forward-batch.ts - forwarding many messages in one call, and saying exactly
// which ones landed.
//
// ── Why a batch at all ──────────────────────────────────────────────────────
// `email_compose action:forward` took a single `message_id`, so moving 30
// supplier invoices into an accounting intake address was 30 round trips.
// `email_read action:read_batch` has taken up to 50 ids since it shipped, so
// the asymmetry was arbitrary rather than principled: the same caller, holding
// the same list of ids, could read them in one call and not forward them in
// one call.
//
// The fan-out is deliberately SERVER-side and SEQUENTIAL. ImapClient
// multiplexes one socket and concurrent commands corrupt its buffer, which is
// why runExclusive exists (see imap-client.ts). A tool shape that pushes the
// caller toward 30 parallel calls is a tool shape that manufactures exactly
// that contention.
//
// ── Per-message results, never all-or-nothing ───────────────────────────────
// The whole value of the batch is the answer to "which ones went?". A caller
// whose message 7 failed must still be told 1-6 are sent, because its next
// move - retry, reconcile, tell the user - is different for each. So this
// module models an outcome per message and never collapses the list into a
// single success or failure.
//
// The vocabulary is fixed here rather than at each throw site, because a status
// is read by a model deciding whether to retry, and "not_sent" versus "unknown"
// is the difference between a safe retry and a duplicated invoice.
//
// Pure and dependency-free (bar the id de-duplicator it shares with the batch
// read) so the shapes can be tested without a mailbox.
// ---------------------------------------------------------------------------

import { dedupeMessageIds } from "./message-id-dedupe.ts";

/** Cap on `message_ids`, held at email_read_batch's for the reason above. */
export const FORWARD_BATCH_MAX_IDS = 50;

/**
 * What happened to one message in the batch.
 *
 *   sent          transmitted now; `sent_message_id` is the new message.
 *   already_sent  a prior attempt under the same idempotency_key already sent
 *                 it, so this call did nothing. Not a failure.
 *   not_sent      provably nothing was transmitted (a bad id, a pre-DATA
 *                 refusal). Retrying cannot duplicate anything.
 *   unknown       the failure happened at or after the hand-off to the
 *                 provider. Reconcile against Sent before retrying.
 *   in_progress   another call holds this message's idempotency claim right
 *                 now. Nothing was done here; retry shortly.
 *   not_attempted the batch stopped before reaching it (see stopped_reason).
 *                 Nothing was transmitted for this id.
 */
export type ForwardOutcomeStatus =
  | "sent"
  | "already_sent"
  | "not_sent"
  | "unknown"
  | "in_progress"
  | "not_attempted";

export interface ForwardOutcome {
  /** The SOURCE message id the caller passed, so it can zip its own list. */
  message_id: string;
  status: ForwardOutcomeStatus;
  /** Provider id of the newly sent message. Present for sent/already_sent. */
  sent_message_id?: string;
  thread_id?: string;
  sent_at?: string;
  /** Forward subject, neutralised by the caller. Present when it was sent. */
  subject?: string;
  /** Why this one did not go. Present for every non-sent status. */
  error?: string;
}

export type ForwardTargets =
  | { ok: true; mode: "single"; messageId: string }
  | { ok: true; mode: "batch"; messageIds: string[] }
  | { ok: false; message: string };

/**
 * Read `message_id` / `message_ids` off a forward call.
 *
 * Exactly one of the two, never both. Accepting both and preferring one would
 * make a caller that sent a stale `message_id` alongside a fresh
 * `message_ids` forward a message it did not mean to, and there is no undo on
 * a send.
 *
 * `message_ids` is de-duplicated with the same helper the batch read and the
 * batch mutations use, so `succeeded` counts messages rather than list
 * entries, and the per-message results line up with the caller's own order.
 */
export function parseForwardTargets(
  tool: string,
  args: Record<string, unknown>,
): ForwardTargets {
  const rawSingle = args["message_id"];
  const rawBatch = args["message_ids"];
  const hasSingle = rawSingle !== undefined && rawSingle !== null;
  const hasBatch = rawBatch !== undefined && rawBatch !== null;

  if (hasSingle && hasBatch) {
    return {
      ok: false,
      message:
        `${tool}: pass either message_id (one message) or message_ids (up to ` +
        `${FORWARD_BATCH_MAX_IDS}), not both.`,
    };
  }

  if (hasBatch) {
    if (!Array.isArray(rawBatch)) {
      return {
        ok: false,
        message: `${tool}: message_ids must be an array of message id strings.`,
      };
    }
    if (rawBatch.length > FORWARD_BATCH_MAX_IDS) {
      return {
        ok: false,
        message:
          `${tool}: message_ids must not exceed ${FORWARD_BATCH_MAX_IDS} ids ` +
          `per call, the same cap as email_read action: read_batch. Split the ` +
          `list and forward it in several calls.`,
      };
    }
    const messageIds = dedupeMessageIds(rawBatch);
    if (messageIds.length === 0) {
      return {
        ok: false,
        message:
          `${tool}: message_ids must contain at least one non-empty message id.`,
      };
    }
    return { ok: true, mode: "batch", messageIds };
  }

  if (typeof rawSingle === "string" && rawSingle.length > 0) {
    return { ok: true, mode: "single", messageId: rawSingle };
  }
  return {
    ok: false,
    message:
      `${tool}: message_id is required and must be a non-empty string, or pass ` +
      `message_ids to forward up to ${FORWARD_BATCH_MAX_IDS} messages in one call.`,
  };
}

/** Statuses that mean this message is, right now, in the recipient's mailbox. */
const DELIVERED_STATUSES: ReadonlySet<ForwardOutcomeStatus> = new Set([
  "sent",
  "already_sent",
]);

export interface ForwardBatchSummary {
  succeeded: number;
  failed: number;
  /**
   * completed              every id ended in a delivered state.
   * completed_with_errors  the batch ran to the end; some ids did not go.
   * stopped_early          a failure that would repeat for every remaining id
   *                        (auth, quota) ended the run; the rest are
   *                        not_attempted.
   */
  status: "completed" | "completed_with_errors" | "stopped_early";
  /**
   * True when the call did not finish the work it was asked to do.
   *
   * Read by the dispatcher's idempotency bookkeeping the same way a bulk
   * mailbox operation's is: a partial must not be filed as done. See
   * isPartialToolResult in index.ts.
   */
  partial: boolean;
  /**
   * True when any id ended in `unknown`, i.e. the caller cannot tell from this
   * result alone whether a copy is sitting in the recipient's mailbox.
   */
  needs_reconciliation: boolean;
}

/** Fold the per-message outcomes into the counts and the one-word verdict. */
export function summarizeForwardBatch(
  outcomes: readonly ForwardOutcome[],
): ForwardBatchSummary {
  const succeeded = outcomes.filter((o) => DELIVERED_STATUSES.has(o.status)).length;
  const failed = outcomes.length - succeeded;
  const stoppedEarly = outcomes.some((o) => o.status === "not_attempted");
  return {
    succeeded,
    failed,
    status: stoppedEarly
      ? "stopped_early"
      : failed > 0
      ? "completed_with_errors"
      : "completed",
    partial: failed > 0,
    needs_reconciliation: outcomes.some((o) => o.status === "unknown"),
  };
}

/**
 * The idempotency key one message of a batch is claimed under.
 *
 * A batch cannot take a single whole-call key and still be resumable: settling
 * one ledger row for 30 messages means a retry after "message 7 failed" is
 * answered "already processed" and messages 7-30 are stranded (see
 * isPartialToolResult for the same trap on bulk mailbox operations). Keying per
 * message instead gives the caller the behaviour the batch exists for: retry
 * the identical call with the identical key, the 6 that went are replayed from
 * the ledger and not re-sent, and the 24 that did not are sent.
 *
 * The message id is the discriminator because it is what the caller varies and
 * what the ledger's request digest already commits to. The separator is a pair
 * of characters no provider id uses, so two different (key, id) pairs cannot
 * collide by concatenation.
 *
 * Length is deliberately unbounded here: this string never came from a caller,
 * so the 200-character argument check does not apply to it, and it is HMACed
 * to a fixed-width digest before it reaches the database.
 */
export function forwardMessageIdempotencyKey(
  batchKey: string,
  messageId: string,
): string {
  return `${batchKey} forward ${messageId}`;
}

/**
 * The arguments one message of a batch is claimed and executed under.
 *
 * Derived from the batch's own arguments with `message_ids` swapped for a
 * single `message_id`, so the ledger's request digest describes exactly the
 * message that was forwarded. `idempotency_key` is stripped because the digest
 * is taken over the request, never the key.
 */
export function forwardMessageArgs(
  batchArgs: Record<string, unknown>,
  messageId: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...batchArgs, message_id: messageId };
  delete args["message_ids"];
  delete args["idempotency_key"];
  return args;
}

// ── The run itself ──────────────────────────────────────────────────────────
//
// The loop below is the part worth testing: stop-on-fatal, per-message ledger
// claims, and the exact bookkeeping that makes a retry finish a partial batch
// without re-sending what already went. None of that needs a mailbox or a
// database, so it takes its provider and its ledger as injected functions and
// the server supplies the real ones. See runForwardBatch in index.ts.

/** What a successful forward hands back, reduced to what a result needs. */
export interface ForwardSentMessage {
  /** Provider id of the NEW message, not the source. */
  message_id: string;
  thread_id?: string;
  sent_at?: string;
  /** Already neutralised by the caller; it is the original sender's words. */
  subject?: string;
}

/** How one message's failure is reported, and what it means for the rest. */
export interface ForwardFailure {
  status: "not_sent" | "unknown";
  /** The sentence attached to this message's entry in `results`. */
  error: string;
  /**
   * The code handed to the idempotency ledger for THIS message. Opaque here;
   * index.ts owns which codes release a key and which consume it.
   */
  ledgerCode: string;
  /**
   * True when this failure will repeat for every remaining message, so the run
   * stops and the rest are reported `not_attempted` rather than burning 29 more
   * doomed round trips against an account that is out of quota or logged out.
   */
  fatal: boolean;
}

/**
 * The ledger's answer for one message, reduced to the cases the run cares
 * about. `null` means no protection was requested and the message is simply
 * forwarded.
 */
export type ForwardClaim =
  | { kind: "proceed" }
  | {
    kind: "replay";
    status: "succeeded" | "failed" | "unknown" | "pending_approval" | "approval_approved";
    sentMessageId?: string;
  }
  | { kind: "processing" }
  | { kind: "conflict" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export interface ForwardBatchDeps {
  /** Claim this message under `derivedKey`, or resolve null for no protection. */
  claim: (messageId: string, derivedKey: string) => Promise<ForwardClaim | null>;
  /** Forward one message. Rejects on any failure. */
  forwardOne: (messageId: string) => Promise<ForwardSentMessage>;
  /** Turn a rejection into its per-message report. */
  classifyFailure: (err: unknown, messageId: string) => ForwardFailure;
  /**
   * Optional wall-clock guard, checked BEFORE each message is started.
   *
   * A 50-message forward can outlive the MCP client's patience long before it
   * outlives the edge runtime's. Being cut off mid-run is the bad outcome: the
   * caller gets no result at all and cannot tell which ids went, which is the
   * one thing the batch exists to tell it. Stopping voluntarily turns that into
   * an honest partial the caller can resume with the same idempotency_key.
   */
  budgetExhausted?: () => boolean;
  /** Settle this message's ledger row. Never called for an unclaimed message. */
  settle: (
    messageId: string,
    result:
      | { ok: true; sent: ForwardSentMessage }
      | { ok: false; ledgerCode: string },
  ) => Promise<void>;
}

/** Report a per-message idempotency claim that did not grant execution. */
export function forwardOutcomeFromClaim(
  messageId: string,
  claim: ForwardClaim,
): ForwardOutcome {
  if (claim.kind === "replay") {
    if (claim.status === "succeeded") {
      return {
        message_id: messageId,
        status: "already_sent",
        ...(claim.sentMessageId ? { sent_message_id: claim.sentMessageId } : {}),
        error:
          "Already forwarded by an earlier call under this idempotency_key; " +
          "not sent again.",
      };
    }
    if (claim.status === "failed") {
      return {
        message_id: messageId,
        status: "not_sent",
        error:
          "An earlier call under this idempotency_key failed before sending this " +
          "message, and the same call would fail the same way. Use a new key once " +
          "the cause is fixed.",
      };
    }
    return {
      message_id: messageId,
      status: "unknown",
      error:
        "An earlier call under this idempotency_key may have delivered this " +
        "message. Check Sent before retrying it under a new key.",
    };
  }
  if (claim.kind === "processing") {
    return {
      message_id: messageId,
      status: "in_progress",
      error:
        "Another call is forwarding this message under the same idempotency_key " +
        "right now. Nothing was done here; retry shortly.",
    };
  }
  if (claim.kind === "conflict") {
    return {
      message_id: messageId,
      status: "not_sent",
      error:
        "This idempotency_key was already used for this message with different " +
        "arguments. Retry the original request, or choose a new key.",
    };
  }
  return {
    message_id: messageId,
    status: "not_sent",
    error:
      "Retry protection is unavailable, so this message was not forwarded rather " +
      "than risk a duplicate. Retry shortly with the same idempotency_key.",
  };
}

/**
 * Forward every id in order, reporting each separately.
 *
 * Sequential by construction: each iteration awaits the previous one. That is
 * not incidental tidiness, it is the IMAP single-socket constraint (see the
 * header) expressed as control flow, and it is why the batch exists rather than
 * the caller issuing N parallel calls.
 *
 * A `fatal` failure — no credentials, no quota, no ledger — stops the run and
 * marks the remainder `not_attempted`. Everything else continues, because "the
 * seventh id was stale" says nothing about the eighth.
 */
export async function runForwardMessages(
  messageIds: readonly string[],
  idempotencyKey: string | null,
  deps: ForwardBatchDeps,
): Promise<ForwardOutcome[]> {
  const outcomes: ForwardOutcome[] = [];
  /** Set by the first failure that would repeat for every remaining id. */
  let stoppedReason: string | null = null;

  for (const messageId of messageIds) {
    if (stoppedReason === null && deps.budgetExhausted?.() === true) {
      stoppedReason =
        "The call ran out of its wall-clock allowance. Retry with the ids that " +
        "were not attempted, or with the same message_ids and the same " +
        "idempotency_key — the ones already sent will not be sent again.";
    }
    if (stoppedReason !== null) {
      outcomes.push({
        message_id: messageId,
        status: "not_attempted",
        error: `Not attempted: the batch stopped earlier. ${stoppedReason}`,
      });
      continue;
    }

    let claimed = false;
    if (idempotencyKey !== null) {
      const claim = await deps.claim(
        messageId,
        forwardMessageIdempotencyKey(idempotencyKey, messageId),
      );
      if (claim !== null && claim.kind !== "proceed") {
        const outcome = forwardOutcomeFromClaim(messageId, claim);
        outcomes.push(outcome);
        // A ledger that cannot answer for one message cannot answer for the
        // next thirty either, and forwarding unprotected is how duplicates
        // happen. Stop rather than trade retry safety for throughput.
        if (claim.kind === "unavailable" || claim.kind === "invalid") {
          stoppedReason = outcome.error ?? "Retry protection is unavailable.";
        }
        continue;
      }
      claimed = claim !== null;
    }

    try {
      const sent = await deps.forwardOne(messageId);
      outcomes.push({
        message_id: messageId,
        status: "sent",
        sent_message_id: sent.message_id,
        ...(sent.thread_id ? { thread_id: sent.thread_id } : {}),
        ...(sent.sent_at ? { sent_at: sent.sent_at } : {}),
        ...(sent.subject ? { subject: sent.subject } : {}),
      });
      if (claimed) await deps.settle(messageId, { ok: true, sent });
    } catch (err) {
      const failure = deps.classifyFailure(err, messageId);
      outcomes.push({
        message_id: messageId,
        status: failure.status,
        error: failure.error,
      });
      if (claimed) {
        await deps.settle(messageId, { ok: false, ledgerCode: failure.ledgerCode });
      }
      if (failure.fatal) stoppedReason = failure.error;
    }
  }

  return outcomes;
}

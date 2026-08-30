// ---------------------------------------------------------------------------
// What an idempotent replay gives back.
//
// ── The problem this exists to solve ────────────────────────────────────────
// Repeating an identical send with the same `idempotency_key` correctly
// collapsed instead of sending twice, and returned:
//
//   {"idempotency_key":"...","idempotent_replay":true,"status":"succeeded",
//    "message":"This logical request was already processed. No new email was sent."}
//
// The collapse is right. The response is not enough. The reason an agent
// retries with an idempotency key in the first place is that it lost the
// answer — the connection dropped, the client timed out — and the one thing it
// needs back is the `message_id` the original call produced. Telling it "that
// already happened" without saying WHAT happened leaves it exactly as stranded
// as the dropped connection did, except now it also cannot retry: a second
// attempt collapses the same way, and changing the arguments to force a fresh
// send would duplicate the email.
//
// So the ledger keeps a small snapshot of the original result and the replay
// hands it back, alongside `idempotent_replay: true` so a replay is still
// distinguishable from a fresh success.
//
// ── Why the snapshot is an allow-list ───────────────────────────────────────
// `outbound_idempotency` was built to hold digests and nothing else: no bodies,
// no recipients, no subjects. Persisting a whole tool result would quietly turn
// it into a 24-hour store of who the user emails and about what. The snapshot
// is therefore an explicit list of identity and outcome fields — the ids, the
// counts, the status — and everything else is dropped, including `to`, `cc`,
// `bcc` and `subject`, which the send result carries and which the retrying
// caller already has in the arguments it is retrying with.
// ---------------------------------------------------------------------------

/**
 * Result fields worth surviving into a replay.
 *
 * Every entry is either an identifier the caller cannot reconstruct
 * (`message_id`, `thread_id`, `draft_id`, `scheduled_send_id`), a statement of
 * what the operation did (`status`, `operation`, the counts), or the target it
 * did it to (`inbox_id`, `destination_folder_id`). Content-bearing fields are
 * absent on purpose — see the header.
 */
const REPLAYABLE_SCALAR_FIELDS = [
  "id",
  "message_id",
  "thread_id",
  "draft_id",
  "scheduled_send_id",
  "approval_id",
  "sent_at",
  "send_at",
  "scheduled_for",
  "status",
  "success",
  "operation",
  "inbox_id",
  "destination_folder_id",
  "succeeded",
  "failed",
  "total",
  "permanent",
  "partial",
] as const;

/**
 * Array fields kept when they fit. `results` is the per-message outcome list a
 * bulk caller zips against its own ids, so a bulk replay without it is only
 * half an answer — but 500 entries is also the one thing here that can get
 * large, hence the budget below.
 */
const REPLAYABLE_ARRAY_FIELDS = ["results", "message_ids", "remaining_ids"] as const;

/**
 * Serialized ceiling for one stored snapshot.
 *
 * The row is written on the hot path of every keyed mutation and read back on
 * every replay, so this is sized to stay small: a send snapshot is a few
 * hundred bytes, and only a 500-id bulk result approaches the limit. When it
 * does, the arrays go and the counts stay, because "succeeded: 340" is the part
 * a caller cannot recompute.
 */
export const MAX_SNAPSHOT_CHARS = 8_000;

/**
 * Reduces a tool result payload to the fields worth replaying, or `null` when
 * nothing survives (which is the honest answer for a result that carried no
 * identity at all).
 */
export function idempotencyResultSnapshot(
  payload: unknown,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;

  const snapshot: Record<string, unknown> = {};
  for (const field of REPLAYABLE_SCALAR_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      snapshot[field] = value;
    }
  }

  const arrays: Record<string, unknown> = {};
  for (const field of REPLAYABLE_ARRAY_FIELDS) {
    const value = source[field];
    if (Array.isArray(value)) arrays[field] = value;
  }

  if (Object.keys(snapshot).length === 0 && Object.keys(arrays).length === 0) {
    return null;
  }

  const withArrays = { ...snapshot, ...arrays };
  if (JSON.stringify(withArrays).length <= MAX_SNAPSHOT_CHARS) return withArrays;

  // Too big with the per-message detail. Keep the counts — losing those would
  // make the replay useless in exactly the case (a large bulk run) where the
  // caller is least able to work out what happened by looking.
  if (Object.keys(arrays).length > 0) snapshot["results_omitted"] = true;
  if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_CHARS) return null;
  return snapshot;
}

/**
 * The clause that says nothing new happened, in the noun of the operation.
 *
 * Mutations and sends share every replay branch, but telling a caller that its
 * retried MOVE sent no email is confusing at best, so the sentence is chosen
 * from the operation family rather than hardcoded.
 */
export function noNewEffectPhrase(isMutation: boolean): string {
  return isMutation
    ? "The mailbox was not changed again by this retry."
    : "No new email was sent.";
}

export interface ReplayEnvelopeInput {
  key: string;
  status: "succeeded" | "failed" | "unknown" | "pending_approval" | "approval_approved";
  approvalId?: string;
  /** The stored snapshot of the original result, when the ledger has one. */
  result?: Record<string, unknown> | null;
  /** True for the mailbox-mutation family, false for outbound sends. */
  isMutation: boolean;
}

/**
 * Builds the replay tool payload.
 *
 * `idempotent_replay: true` is preserved unconditionally: a caller must always
 * be able to tell a collapsed retry from a fresh send, and now that the
 * envelope carries the original `result` the flag is the ONLY thing that
 * distinguishes them.
 */
export function buildReplayEnvelope(
  input: ReplayEnvelopeInput,
): Record<string, unknown> {
  const noNewEffect = noNewEffectPhrase(input.isMutation);
  const hasResult = !!input.result && Object.keys(input.result).length > 0;

  const message = input.status === "pending_approval"
    ? "This email has not been sent. It is awaiting dashboard approval; approve or reject the returned approval_id. After rejection, retry this exact request with the same idempotency_key to create a fresh approval."
    : input.status === "approval_approved"
    ? "This email was approved and is queued for delivery. No new email was sent by this retry."
    : input.status === "unknown"
    ? `A prior submission may have reached the provider. ${noNewEffect} ` +
      (input.isMutation
        ? "Check the mailbox before taking further action."
        : "Check Sent before taking further action.")
    : `This logical request was already processed. ${noNewEffect}` +
      (hasResult
        ? " The original outcome is repeated in `result` — use it as you would " +
          "the first call's response; do not retry again to obtain it."
        : "");

  return {
    idempotency_key: input.key,
    idempotent_replay: true,
    status: input.status,
    ...(input.approvalId ? { approval_id: input.approvalId } : {}),
    ...(hasResult ? { result: input.result } : {}),
    message,
  };
}

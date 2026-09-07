// ---------------------------------------------------------------------------
// send-stages.ts - which side of transmission a send failed on.
//
// Every send in this server passes through the same three stages:
//
//   source    read the message being acted on, including its attachment BYTES
//             when include_attachments is set
//   compose   apply the signature, build the body, encode the attachments into
//             MIME, mint the message id
//   transmit  hand those bytes to Gmail / Graph / an SMTP server
//
// Only the third can leave a caller genuinely unsure whether mail went out. The
// first two are, by construction, "nothing exists yet": no MIME was built, no
// send endpoint was called, and there is no Sent copy to reconcile against.
//
// The server already knew this for one case. `TargetUnresolvedError` was added
// on 2026-08-30 because a reply whose ORIGINAL could not be read came back as
// "may or may not have been delivered. Do not retry automatically", and an
// agent that correctly honoured that advice went hunting through Sent for a
// message that was never composed (see message-id-errors.ts).
//
// It came back on 2026-09-07 through the other door. Eight forwards with
// `include_attachments: true` failed while fetching the original's attachment
// bytes - strictly before transmission - and every one of them reported
// `delivery_status: "unknown"`. Reconciling against Sent found nothing, because
// there was nothing: all eight were provably not sent. The classification was
// right in principle and wrong in fact, because the pre-transmission stages
// were not enumerated anywhere. Anything that threw from them fell through to
// the generic `providerFailure` branch, which means "unknown" by default.
//
// So the stages are enumerated here, and the default is inverted. A provider
// path wraps its pre-transmission work in `preTransmission(...)`; everything
// inside is classified not-sent no matter what it throws, and a new throw site
// added there inherits that rather than the ambiguous answer. Reaching
// `delivery_status: "unknown"` now requires being outside every wrapper, which
// is to say: after the bytes were handed over.
//
// ── WHY THE WRAPPER PRESERVES `message` VERBATIM ───────────────────────────
// The handlers in index.ts dispatch on sentinel strings before they look at
// error classes: `message_not_found`, `gmail_auth_failed`, `quota_exceeded`,
// `draft_not_found`, the no-reply-recipients sentence. Each of those already
// has an honest, non-ambiguous result of its own, and re-describing them here
// would silently break every one of those branches. So the wrapper changes the
// error's CLASS and nothing else: the message a handler matches on is the one
// the provider path threw.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { targetUnresolvedMessage } from "./message-id-errors.ts";

/**
 * The pre-transmission stages, enumerated.
 *
 * There is deliberately no stage for transmission itself. "After transmission
 * began" is not a stage a caller opts into, it is what is left when no wrapper
 * applies, and that asymmetry is the safety property this module exists for.
 */
export type SendStage = "source" | "compose";

/**
 * The machine-readable statement a send result makes about delivery.
 *
 * `unknown` carries a do-not-retry warning wherever it appears; `not_sent` is
 * its opposite and promises a safe retry. They are constants because three
 * things read them - the agent-facing sentence, the extension field on the tool
 * result, and (via the error code alongside them) the idempotency ledger - and
 * a typo in one of those fails by quietly meaning the other.
 */
export const DELIVERY_STATUS_NOT_SENT = "not_sent";
export const DELIVERY_STATUS_UNKNOWN = "unknown";

/**
 * A failure that happened before any byte of the message reached the provider.
 *
 * Carried as a class rather than a string prefix for the same reason
 * SmtpNotSentError is: the handler's question is "which phase did this die in",
 * and a phase is not something to re-derive by matching on provider prose that
 * the provider is free to reword.
 */
export class PreTransmissionError extends Error {
  readonly stage: SendStage;

  constructor(stage: SendStage, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreTransmissionError";
    this.stage = stage;
  }
}

/**
 * A send that failed while READING the message it was asked to act on.
 *
 * Covers the original of a reply or a forward, and - the case that produced the
 * 2026-09-07 evidence - the attachment bytes of that original, which are part
 * of reading it. Nothing has been composed at this point, so nothing can have
 * been delivered.
 */
export class TargetUnresolvedError extends PreTransmissionError {
  constructor(message: string, options?: ErrorOptions) {
    super("source", message, options);
    this.name = "TargetUnresolvedError";
  }
}

/**
 * A send that failed while BUILDING the outgoing message: applying the
 * signature, assembling the forwarded or quoted body, encoding attachments into
 * MIME, refreshing the token the send will use.
 *
 * Distinct from {@link TargetUnresolvedError} only in what it says happened -
 * "could not read the message it was asked to act on" would be a lie about a
 * MIME encoder that ran out of memory. The delivery guarantee is identical, and
 * both are `PreTransmissionError`, so a handler that only cares about the
 * guarantee catches the base class.
 */
export class MessageBuildError extends PreTransmissionError {
  constructor(message: string, options?: ErrorOptions) {
    super("compose", message, options);
    this.name = "MessageBuildError";
  }
}

/**
 * Classify one caught value as a pre-transmission failure at `stage`.
 *
 * Already-classified errors pass through untouched: a `TargetUnresolvedError`
 * thrown deep inside a stage keeps its own stage rather than being relabelled
 * by whichever wrapper happens to be outermost. Everything else is wrapped with
 * its message preserved byte-for-byte, for the reason in this file's header.
 */
export function asPreTransmissionError(
  stage: SendStage,
  err: unknown,
): PreTransmissionError {
  if (err instanceof PreTransmissionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return stage === "source"
    ? new TargetUnresolvedError(message, { cause: err })
    : new MessageBuildError(message, { cause: err });
}

/**
 * Run one pre-transmission stage, classifying anything it throws.
 *
 * The unit is the STAGE, not the call: wrap the whole run of work that precedes
 * the provider's send endpoint, so that a line added inside it later is covered
 * without anyone remembering to think about delivery status. Everything after
 * the wrapper is transmission and answers "unknown".
 */
export async function preTransmission<T>(
  stage: SendStage,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw asPreTransmissionError(stage, err);
  }
}

/** {@link preTransmission} for a stage with no awaits in it. */
export function preTransmissionSync<T>(stage: SendStage, run: () => T): T {
  try {
    return run();
  } catch (err) {
    throw asPreTransmissionError(stage, err);
  }
}

/**
 * The sentence a caller gets for a failure on either pre-transmission stage.
 *
 * The "source" half is `targetUnresolvedMessage` verbatim - the wording that
 * already exists, is already pinned by message-id-errors.test.ts, and is
 * already correct for an attachment read, since an attachment is part of the
 * message that could not be read.
 *
 * The "compose" half says the same two things in its own terms, because those
 * two things are the whole point: nothing was sent, and a retry is therefore
 * safe. Neither may ever acquire "may or may not" or "do not retry"; that
 * sentence belongs to a request that reached the send endpoint and then failed,
 * and saying it here costs the caller the one safe action it has.
 */
export function preTransmissionMessage(
  operation: string,
  provider: string,
  stage: SendStage,
  reason: string,
): string {
  if (stage === "source") {
    return targetUnresolvedMessage(operation, provider, reason);
  }
  return (
    `${operation} failed while building the message, before any of it was ` +
    `handed to ${provider} for transmission: nothing was sent, there is no ` +
    `delivery, and no copy in Sent. The failure was: ${reason}. Retrying is ` +
    `safe and cannot duplicate anything.`
  );
}

// ---------------------------------------------------------------------------
// The words a model sees when it calls a tool with arguments the schema rejects.
//
// The validator has always produced good field-level messages ("arguments.since
// must be an ISO 8601 date or date-time"), and they have always been thrown
// away. They were returned as a JSON-RPC protocol error, -32602, with the
// per-field detail hung off `error.data`; the reference MCP SDK renders a
// protocol error as `MCP error ${code}: ${message}` and hosts routinely drop
// `data`, so what actually reached the model was the sentence "Invalid
// arguments for email_read.", which names no field, no rule and no fix. It was
// the single largest error signature in production: 815 calls across 50 of 97
// workspaces, every one of them a model that could have corrected itself on the
// next call if it had been told what was wrong.
//
// The specification draws the line these functions sit on, the same line as
// usage-limit-message.ts: a request that cannot be routed at all (malformed
// JSON-RPC, unknown method, bad credentials) is a PROTOCOL error, while a
// request that reached a known tool and was refused by that tool's rules is an
// EXECUTION error, returned as a normal result with `isError: true`. Clients
// SHOULD hand execution errors to the model and only MAY forward protocol
// errors. Argument validation for a tool that exists is squarely the second
// kind: the tool was found, the caller was authorised, and the arguments lost.
//
// Pure and dependency-free so the wording can be tested without booting the
// server, for the same reason as usage-limit-message.ts and text-safety.ts.
// ---------------------------------------------------------------------------

/** One field-level failure, as produced by the server's schema validator. */
export interface InvalidArgumentDetail {
  /** Dotted path to the offending argument, e.g. `arguments.since`. */
  path: string;
  /** The rule that failed, phrased to follow the path, e.g. "is required". */
  message: string;
}

/**
 * At most this many field failures are spelled out. A schema mismatch that
 * produces more than ten lines is a caller using the wrong tool entirely, and
 * the first ten already say so; the rest would only push the useful part of the
 * message out of a context window.
 */
const MAX_LISTED_ERRORS = 10;

/** Longest echo of a caller-supplied value. Long enough to recognise a typo. */
const MAX_ECHOED_VALUE = 40;

/**
 * Shared closing fact. Agents default to retry-with-backoff on anything that
 * looks transient, and a schema mismatch never clears on its own, so the
 * futility of an identical retry is stated outright rather than left to be
 * inferred from an error code the model may never see.
 *
 * Declarative, never imperative. No "fix the argument", no "try instead": an
 * instruction addressed to a model from inside a tool response is mechanically
 * indistinguishable from prompt injection by the server operator, which is the
 * practice this product's security page promises it does not engage in. Facts
 * about what happened get acted on just as reliably and cost no trust.
 */
const RETRY_FACT =
  "The same arguments will be rejected the same way.";

/** Truncate a caller-supplied value before echoing it back to the caller. */
function echo(value: string): string {
  return value.length <= MAX_ECHOED_VALUE
    ? value
    : `${value.slice(0, MAX_ECHOED_VALUE)}…`;
}

/**
 * Builds the rejection text for arguments that failed the tool's input schema.
 *
 * The shape mirrors the cap message: what happened first, then the facts that
 * let the caller act, then the retry fact. "before it ran" is load-bearing:
 * validation happens ahead of every provider call, so a rejected email_compose
 * definitely did not send a partial message, and a model that cannot rule that
 * out will either refuse to retry or send twice.
 */
export function buildInvalidArgumentsText(
  toolName: string,
  errors: readonly InvalidArgumentDetail[],
): string {
  const listed = errors.slice(0, MAX_LISTED_ERRORS)
    .map((error) => `${error.path} ${error.message}.`);
  const omitted = errors.length - listed.length;
  if (omitted > 0) {
    listed.push(`(${omitted} further argument problem${omitted === 1 ? "" : "s"} not listed.)`);
  }
  return [
    `Invalid arguments for ${toolName}. The call was rejected before it ran, ` +
    `so nothing was read, sent, moved or deleted.`,
    ...listed,
    RETRY_FACT,
  ].join(" ");
}

/**
 * Builds the rejection text for a consolidated tool whose `action` selector was
 * missing or unrecognised.
 *
 * Separate from the schema path because it fires BEFORE schema validation (the
 * action decides which arguments are even legal) and because the useful fact is
 * the enum, not a path. The valid actions are listed in full: this is the one
 * error where naming the allowed values is the entire remedy, and the model
 * that hit it has already proved it does not have them to hand.
 */
export function buildUnknownActionText(
  toolName: string,
  action: string | null,
  validActions: readonly string[],
): string {
  const valid = validActions.join(", ");
  const opening = action === null
    ? `${toolName} requires an 'action' argument and none was given.`
    : `${toolName} has no action '${echo(action)}'.`;
  return [
    `Invalid arguments for ${toolName}. ${opening} The call was rejected ` +
    `before it ran, so nothing was read, sent, moved or deleted.`,
    `The valid actions are: ${valid}.`,
    `Each action uses its own arguments, described in the tool's description.`,
    RETRY_FACT,
  ].join(" ");
}

/**
 * Privacy-safe metadata for rejected MCP tool arguments.
 *
 * Do not add argument values, error messages, inbox IDs, recipient addresses,
 * search text, or any other request content here. This payload is persisted in
 * the activity log and is intended solely to make schema mismatches observable.
 */
export interface ValidationErrorClassification {
  path: string;
  keyword: string;
  /** Accepted so callers can pass their internal error object; never persisted. */
  message?: string;
}

export interface InvalidArgumentAuditDetails {
  phase: "schema_validation";
  tool: string;
  action: string | null;
  errors: PersistedValidationError[];
}

/**
 * What is persisted per failure. `received` is the JSON TYPE a `type` failure
 * saw ("string", "null", "object", …), one word from a closed set of seven and
 * never the value. It exists because without it a `type` failure could not be
 * told apart from another: on 2026-09-23 there was no way to learn whether
 * clients were sending `null` for unset fields or strings for numbers, and
 * those need different fixes.
 */
export interface PersistedValidationError {
  path: string;
  keyword: string;
  received?: JsonTypeName;
}

const JSON_TYPE_NAMES = ["string", "number", "boolean", "null", "object", "array", "undefined"] as const;
type JsonTypeName = typeof JSON_TYPE_NAMES[number];

/** The received type named in a validator `type` message, if it is one of ours. */
function receivedType(message: string | undefined): JsonTypeName | null {
  const match = /received (\w+)$/.exec(message ?? "");
  const name = match?.[1];
  return name && (JSON_TYPE_NAMES as readonly string[]).includes(name) ? name as JsonTypeName : null;
}

/**
 * Convert internal schema errors to the deliberately value-free shape that may
 * be persisted to `activity_log.error_details`.
 */
export function invalidArgumentAuditDetails(
  tool: string,
  action: string | null,
  errors: readonly ValidationErrorClassification[],
): InvalidArgumentAuditDetails {
  return {
    phase: "schema_validation",
    tool,
    action,
    errors: errors.map(({ path, keyword, message }) => {
      const received = keyword === "type" ? receivedType(message) : null;
      return received ? { path, keyword, received } : { path, keyword };
    }),
  };
}

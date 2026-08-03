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
  errors: ValidationErrorClassification[];
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
    errors: errors.map(({ path, keyword }) => ({ path, keyword })),
  };
}

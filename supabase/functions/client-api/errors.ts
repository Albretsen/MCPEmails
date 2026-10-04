// The one error shape client-api answers with:
//   HTTP status + { "error": { "code", "message", "retryable" } }
// `tool_code` is the executor's own code when the error came from the tool
// layer, so the client can branch on something finer than the public code.

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "web_client_disabled"
  | "inbox_not_found"
  | "not_found"
  | "reconnect_required"
  | "rate_limited"
  | "provider_error"
  | "timeout"
  | "invalid_request"
  | "conflict"
  | "allowance_exhausted"
  | "internal_error";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  tool_code?: string;
  /** Seconds, on `rate_limited`. Mirrored in the Retry-After header. */
  retry_after?: number;
}

export class ApiError extends Error {
  readonly body: ErrorBody;
  constructor(
    readonly status: number,
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; toolCode?: string; retryAfter?: number; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.body = {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.toolCode ? { tool_code: options.toolCode } : {}),
      ...(options.retryAfter !== undefined ? { retry_after: options.retryAfter } : {}),
    };
    this.extra = options.extra;
  }
  /** Extra top-level keys beside `error` (never mail content). */
  readonly extra?: Record<string, unknown>;
}

export const unauthenticated = (message = "Sign in again.") => new ApiError(401, "unauthenticated", message);
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const invalidRequest = (message: string) => new ApiError(400, "invalid_request", message);

/** Anything that is not an ApiError becomes a 500 with no detail on the wire. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(500, "internal_error", "Something went wrong. Try again.", { retryable: true });
}

/**
 * Map an executor's error result to the public envelope.
 *
 * `toolCode` is the executor's `logErrorCode`; `message` is the text it wrote
 * for the caller (server-authored, safe to return, never logged).
 */
export function executorError(toolCode: string | null, message: string): ApiError {
  const code = toolCode ?? "error";
  const text = message.length > 2000 ? message.slice(0, 2000) : message;
  const make = (status: number, public_: ErrorCode, retryable = false) =>
    new ApiError(status, public_, text, { retryable, toolCode: code });
  switch (code) {
    case "-32602":
    case "invalid_query":
    case "invalid_recipient":
    case "invalid_idempotency_key":
    case "unsupported_search_criteria":
    case "unsupported_permanent_delete":
    case "draft_has_no_recipients":
    case "inbox_mismatch":
    case "attachment_too_large":
      return make(400, "invalid_request");
    case "inbox_not_found":
    case "no_inbox_connected":
    case "inbox_ambiguous":
    case "inbox_selector_conflict":
      return make(404, "inbox_not_found");
    case "message_not_found":
    case "draft_not_found":
    case "folder_not_found":
    case "not_found":
      return make(404, "not_found");
    case "auth_failed":
      return make(409, "reconnect_required");
    case "search_timeout":
      return make(504, "timeout", true);
    case "quota_exceeded":
      return make(429, "rate_limited", true);
    case "folder_already_exists":
    case "not_cancellable":
    case "idempotency_key_conflict":
      return make(409, "conflict");
    case "scope_denied":
      return make(403, "forbidden");
    case "provider_error":
    case "provider_not_sent":
    case "attachment_unavailable":
    case "db_error":
    case "-32603":
      return make(502, "provider_error", true);
    default:
      return make(422, "invalid_request");
  }
}

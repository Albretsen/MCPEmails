// ---------------------------------------------------------------------------
// Scope denial on the wire.
//
// A tools/call whose action needs a scope the key does not carry used to come
// back as JSON-RPC -32001 (the "invalid API key" code) over HTTP 200. The MCP
// authorization spec, following RFC 6750 §3.1, wants HTTP 403 with a
// WWW-Authenticate challenge carrying `error="insufficient_scope"` and the
// scopes required, so an OAuth client can step up (re-consent for the missing
// scope) instead of treating the key as dead. A 401 would make it discard a
// perfectly valid token; a bare 200 tells it nothing.
//
// This module builds that challenge and recognises the error response that
// should trigger it. Both are pure so the exact header bytes are tested.
// ---------------------------------------------------------------------------

/** The stable, string-typed discriminator clients should branch on. */
export const INSUFFICIENT_SCOPE_ERROR_CODE = "insufficient_scope";

/** The `data` payload of a scope-denial JSON-RPC error. */
export interface InsufficientScopeErrorData {
  error_code: typeof INSUFFICIENT_SCOPE_ERROR_CODE;
  /** Scopes any ONE of which would have authorised the call. */
  required_scopes: string[];
  /** The scopes the presented key actually carries. */
  granted_scopes: string[];
}

/** Build the `data` payload. Copies the arrays so callers cannot alias state. */
export function insufficientScopeErrorData(
  requiredScopes: readonly string[],
  grantedScopes: readonly string[],
): InsufficientScopeErrorData {
  return {
    error_code: INSUFFICIENT_SCOPE_ERROR_CODE,
    required_scopes: [...requiredScopes],
    granted_scopes: [...grantedScopes],
  };
}

/**
 * Whether a JSON-RPC response is a scope denial, judged by the string
 * discriminator rather than the numeric code: the numeric code is an
 * implementation detail (see RPC_INSUFFICIENT_SCOPE in index.ts) and the
 * string is the contract.
 */
export function isInsufficientScopeError(response: unknown): response is {
  error: { data: InsufficientScopeErrorData };
} {
  if (response === null || typeof response !== "object") return false;
  const error = (response as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return record.error_code === INSUFFICIENT_SCOPE_ERROR_CODE &&
    Array.isArray(record.required_scopes);
}

/**
 * A scope token must be a quoted-string-safe RFC 6749 scope token. Ours are
 * `verb:noun` and always qualify; anything else is dropped rather than
 * allowed to break the header's quoting.
 */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/**
 * The WWW-Authenticate value for an HTTP 403 scope denial:
 *
 *   Bearer error="insufficient_scope", scope="send:email",
 *     resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource"
 *
 * `scope` is space-separated per RFC 6750 §3. `resource_metadata` (RFC 9728)
 * is what lets an MCP client that has never seen this server find the
 * authorization server to step up with.
 */
export function buildInsufficientScopeChallenge(
  requiredScopes: readonly string[],
  resourceMetadataUrl: string,
): string {
  const scope = requiredScopes.filter((s) => SCOPE_TOKEN.test(s)).join(" ");
  const parts = [
    `error="${INSUFFICIENT_SCOPE_ERROR_CODE}"`,
    `error_description="The token does not carry a scope this call requires."`,
  ];
  if (scope.length > 0) parts.push(`scope="${scope}"`);
  parts.push(`resource_metadata="${resourceMetadataUrl}"`);
  return `Bearer ${parts.join(", ")}`;
}

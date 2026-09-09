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
 *   Bearer error="insufficient_scope", scope="send:email read:email",
 *     resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource"
 *
 * `scope` is space-separated per RFC 6750 §3. `resource_metadata` (RFC 9728)
 * is what lets an MCP client that has never seen this server find the
 * authorization server to step up with.
 *
 * WHY THE HEADER NAMES THE SCOPES THE TOKEN ALREADY HOLDS (2026-09-09).
 * Until now this emitted `requiredScopes` alone, which silently downgraded a
 * user mid-session. Claude re-authorizes with the union of this header's
 * `scope` and the scope advertised at discovery, and scopes picked up in an
 * EARLIER step-up are not reliably carried into the next one. So a user who
 * consented to read, then stepped up to send, then hit a third denial came out
 * of that third consent holding only what the third challenge named. The MCP
 * spec's own guidance for runtime insufficient-scope errors is to name the
 * permissions the caller should still have alongside the newly required ones,
 * which is what the union below does.
 *
 * WHICH REQUIRED SCOPE THE UNION TAKES. `requiredScopes` is an OR-list:
 * "any ONE of these would have authorised this call" (the registry's
 * `altScopes`). Naming all of them would ask the user to consent to several
 * permissions when one is enough, which is the same over-broad prompt this
 * work exists to remove. Only the FIRST is taken, which the sole caller sets
 * to the action's primary `requiredScope`, with the alternatives after it. The
 * denial itself proves the token holds none of them, so the primary is the
 * minimal grant that makes the call succeed. The JSON body still carries the
 * whole OR-list in `required_scopes` for a client that wants to choose
 * differently; only the header narrows.
 */
export function buildInsufficientScopeChallenge(
  requiredScopes: readonly string[],
  grantedScopes: readonly string[],
  resourceMetadataUrl: string,
): string {
  // Validity is checked before the union so a malformed entry cannot displace
  // a usable one: the first VALID required scope is the one that goes in.
  const required = requiredScopes.filter((s) => SCOPE_TOKEN.test(s));
  // Defensive: this value comes off a JSON-RPC error body reconstructed by a
  // type guard that only asserts `required_scopes` is an array, so an absent
  // or malformed `granted_scopes` must degrade to today's behaviour (the
  // required scope alone) rather than throw on the response path.
  const granted = Array.isArray(grantedScopes)
    ? grantedScopes.filter((s) => SCOPE_TOKEN.test(s))
    : [];

  // Newly required first, then everything the token already carries, deduped.
  // Order is fixed rather than sorted so the header bytes are reproducible.
  const union: string[] = [];
  if (required.length > 0) union.push(required[0]);
  for (const held of granted) {
    if (!union.includes(held)) union.push(held);
  }

  const scope = union.join(" ");
  const parts = [
    `error="${INSUFFICIENT_SCOPE_ERROR_CODE}"`,
    `error_description="The token does not carry a scope this call requires."`,
  ];
  if (scope.length > 0) parts.push(`scope="${scope}"`);
  parts.push(`resource_metadata="${resourceMetadataUrl}"`);
  return `Bearer ${parts.join(", ")}`;
}

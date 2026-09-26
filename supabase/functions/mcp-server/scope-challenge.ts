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
  /**
   * Scopes needed IN ADDITION to one of `required_scopes` (an AND, where
   * `required_scopes` is an OR). Present only when non-empty: today only an
   * automation that lacks both manage:automations and its rule action's scope.
   */
  additional_required_scopes?: string[];
}

/** Build the `data` payload. Copies the arrays so callers cannot alias state. */
export function insufficientScopeErrorData(
  requiredScopes: readonly string[],
  grantedScopes: readonly string[],
  additionalRequiredScopes: readonly string[] = [],
): InsufficientScopeErrorData {
  return {
    error_code: INSUFFICIENT_SCOPE_ERROR_CODE,
    required_scopes: [...requiredScopes],
    granted_scopes: [...grantedScopes],
    ...(additionalRequiredScopes.length > 0
      ? { additional_required_scopes: [...additionalRequiredScopes] }
      : {}),
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
  /**
   * Overrides the generic `error_description`. Only the OpenAI result path
   * passes one (ChatGPT may show it); the HTTP 403 header keeps the generic
   * text byte for byte. Characters that would break the quoted-string are
   * removed rather than escaped.
   */
  errorDescription?: string,
  /**
   * Scopes needed on top of the first required one (see
   * InsufficientScopeErrorData.additional_required_scopes). They go into the
   * union right after it, so one step-up grants everything the call needs.
   */
  additionalRequiredScopes: readonly string[] = [],
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
  const additional = Array.isArray(additionalRequiredScopes)
    ? additionalRequiredScopes.filter((s) => SCOPE_TOKEN.test(s))
    : [];
  const union: string[] = [];
  if (required.length > 0) union.push(required[0]);
  for (const extra of additional) {
    if (!union.includes(extra)) union.push(extra);
  }
  for (const held of granted) {
    if (!union.includes(held)) union.push(held);
  }

  const scope = union.join(" ");
  const parts = [
    `error="${INSUFFICIENT_SCOPE_ERROR_CODE}"`,
    `error_description="${
      quotedStringSafe(errorDescription) || DEFAULT_ERROR_DESCRIPTION
    }"`,
  ];
  if (scope.length > 0) parts.push(`scope="${scope}"`);
  parts.push(`resource_metadata="${resourceMetadataUrl}"`);
  return `Bearer ${parts.join(", ")}`;
}

const DEFAULT_ERROR_DESCRIPTION = "The token does not carry a scope this call requires.";

/** Drops `"`, `\\` and control characters, so the value cannot end the quoted-string early. */
function quotedStringSafe(value: string | undefined): string {
  if (typeof value !== "string") return "";
  // deno-lint-ignore no-control-regex
  return value.replace(/["\\\x00-\x1f\x7f]/g, "").trim();
}

// ---------------------------------------------------------------------------
// The same denial, shaped for OpenAI clients (ChatGPT, Codex).
//
// ChatGPT does not follow an HTTP 403 step-up: on 2026-09-25 its reviewer's
// "send an email" and "create an automation" tests retried once and gave up,
// and the app was rejected. OpenAI's documented contract
// (developers.openai.com/apps-sdk/build/auth, "Triggering authentication UI")
// is a NORMAL tools/call result, HTTP 200, with `isError: true`, a text
// content item, and `_meta["mcp/www_authenticate"]` holding one or more
// WWW-Authenticate values, each carrying BOTH `error` and `error_description`.
// Together with the tool's `securitySchemes` (security-schemes.ts) that is
// what makes ChatGPT offer to relink the connector.
//
// The challenge string is built by the same function as the 403 header, so it
// carries the SAME `scope` value (the primary required scope plus everything
// the token already holds) and the same `resource_metadata`; only the
// `error_description` is the human sentence below instead of the generic one.
//
// No `structuredContent`: MCP says a result with `isError: true` need not
// match the tool's outputSchema (the TypeScript SDK client skips the check for
// error results), and several outputSchemas have required fields an error
// could only satisfy by inventing values. The usage-cap refusal takes the same
// shape (usageLimitResult in index.ts).
// ---------------------------------------------------------------------------

/** The result `_meta` key ChatGPT reads a WWW-Authenticate challenge from. */
export const OPENAI_WWW_AUTHENTICATE_META_KEY = "mcp/www_authenticate";

/** Our own machine-readable copy of the denial, alongside ChatGPT's key. */
export const INSUFFICIENT_SCOPE_META_KEY = "com.mcpemails/insufficient_scope";

/**
 * What each scope lets the assistant do, as [permission phrase, approval
 * phrase]: "This needs permission to <first>. ... approve <second>."
 */
const SCOPE_WORDING: Readonly<Record<string, readonly [string, string]>> = {
  "read:email": ["read email", "reading email"],
  "search:email": ["search email", "searching email"],
  "send:email": ["send email", "sending"],
  "delete:email": ["delete email", "deleting email"],
  "manage:folders": ["organize email and manage folders", "organizing email"],
  "manage:drafts": ["create and edit drafts", "managing drafts"],
  "manage:automations": ["create and manage automations", "managing automations"],
  "schedule:email": ["schedule email", "scheduling email"],
  "manage:contacts": ["look up contacts", "contacts"],
};

function scopeWording(scope: string): readonly [string, string] {
  return SCOPE_WORDING[scope] ??
    [`use the '${scope}' permission`, `the '${scope}' permission`];
}

/**
 * The one-sentence description, also used as the challenge's error_description.
 * Extra scopes (an automation that also needs its rule action's scope) are
 * named in the same sentence, since one reconnect grants them all.
 */
export function insufficientScopeDescription(
  scope: string,
  additionalScopes: readonly string[] = [],
): string {
  const all = [scope, ...additionalScopes.filter((s) => s !== scope)];
  const wordings = all.map(scopeWording);
  // The permission phrases contain "and" themselves ("create and manage
  // automations"), so each extra one gets its own "to" to stay readable.
  const join = (parts: string[], glue: string) =>
    parts.length <= 1
      ? parts.join("")
      : `${parts.slice(0, -1).join(`,${glue}`)} and${glue}${parts[parts.length - 1]}`;
  return `This needs permission to ${join(wordings.map((w) => w[0]), " to ")}. ` +
    `Reconnect MCP Emails and approve ${join(wordings.map((w) => w[1]), " ")}.`;
}

/**
 * Convert a scope-denial JSON-RPC ERROR response (as built by handleToolsCall)
 * into the tools/call RESULT OpenAI clients act on. The caller sends it with
 * HTTP 200 and no WWW-Authenticate header.
 */
export function insufficientScopeToolResult(
  response: { id?: unknown; error: { data: InsufficientScopeErrorData } },
  resourceMetadataUrl: string,
): {
  jsonrpc: "2.0";
  id: string | number | null;
  result: {
    content: Array<{ type: "text"; text: string }>;
    isError: true;
    _meta: Record<string, unknown>;
  };
} {
  const data = response.error.data;
  const required = Array.isArray(data.required_scopes) ? data.required_scopes : [];
  const granted = Array.isArray(data.granted_scopes) ? data.granted_scopes : [];
  const additional = Array.isArray(data.additional_required_scopes)
    ? data.additional_required_scopes.filter((s) => SCOPE_TOKEN.test(s))
    : [];
  const primary = required.find((s) => SCOPE_TOKEN.test(s)) ?? "";
  const description = primary
    ? insufficientScopeDescription(primary, additional)
    : "This needs a permission this connection was not granted. Reconnect MCP Emails and approve it.";
  const missing = primary ? [primary, ...additional.filter((s) => s !== primary)] : [];
  const text = primary
    ? `${description} This connection to MCP Emails was not granted ` +
      `${missing.length > 1 ? "those permissions" : "that permission"} ` +
      `(missing scope${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}), so nothing was done. ` +
      `Try again once ${missing.length > 1 ? "they are" : "it is"} approved.`
    : `${description} Nothing was done.`;
  const id = typeof response.id === "string" || typeof response.id === "number"
    ? response.id
    : null;
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      isError: true,
      _meta: {
        [OPENAI_WWW_AUTHENTICATE_META_KEY]: [
          buildInsufficientScopeChallenge(
            required,
            granted,
            resourceMetadataUrl,
            description,
            additional,
          ),
        ],
        [INSUFFICIENT_SCOPE_META_KEY]: insufficientScopeErrorData(required, granted, additional),
      },
    },
  };
}

/**
 * What each failure code on /admin/growth actually means.
 *
 * `activity_log.error_code` mixes two vocabularies: JSON-RPC transport codes
 * (negative integers, defined by the MCP protocol) and the server's own
 * application codes. Reading a table of raw codes means holding both in your
 * head, so the reliability table explains each one in place.
 *
 * The distinction that matters when triaging: a JSON-RPC code is almost always
 * the CLIENT sending something the server rejected, while an application code
 * is usually the server, the mailbox provider, or a genuine not-found. They
 * lead to completely different investigations.
 */

export type ErrorExplanation = {
  title: string;
  detail: string;
  /** Who to look at first. */
  blame: 'client' | 'provider' | 'server' | 'user';
};

export const ERROR_CODE_EXPLANATIONS: Record<string, ErrorExplanation> = {
  // ---- JSON-RPC transport codes (MCP protocol) ----
  '-32700': {
    title: 'Parse error',
    detail: 'The client sent something that was not valid JSON. Almost always a broken client or a truncated request body.',
    blame: 'client',
  },
  '-32600': {
    title: 'Invalid request',
    detail: 'Well-formed JSON that is not a valid JSON-RPC request object, for example a missing method or id.',
    blame: 'client',
  },
  '-32601': {
    title: 'Method not found',
    detail: 'The client called a tool name the server does not expose. Usually a stale client holding a cached tool list from before a rename: reconnecting fixes it.',
    blame: 'client',
  },
  '-32602': {
    title: 'Invalid params',
    detail: 'The tool exists but the arguments were rejected: a missing required field, a wrong type, or a value outside the allowed set. This is the model calling the tool wrongly, not the mailbox failing. A high count concentrated on one tool usually means that tool\'s schema or description is misleading the model.',
    blame: 'client',
  },
  '-32603': {
    title: 'Internal error',
    detail: 'The server threw while handling a valid request. Ours to fix.',
    blame: 'server',
  },
  '-32001': {
    title: 'Request rejected',
    detail: 'A server-defined rejection: the key lacked the scope the tool needs, a guard refused the operation, or a limit was hit. Check the scope table before assuming a bug.',
    blame: 'server',
  },

  // ---- Application codes ----
  auth_failed: {
    title: 'Authentication failed',
    detail: 'The mailbox rejected the credentials. Either the user typed the wrong app password, or the provider needs a login flow we do not support. Repeated failures from one account with no eventual success mean the provider is effectively broken for us, not that the user gave up.',
    blame: 'user',
  },
  provider_error: {
    title: 'Provider error',
    detail: 'The upstream mail provider returned an error or behaved unexpectedly. Transient at low rates; a sustained rate against one provider is a real incident.',
    blame: 'provider',
  },
  inbox_not_found: {
    title: 'Inbox not found',
    detail: 'The call named an inbox id that does not exist or is not reachable by this key. Commonly a stale client still using an inbox the user has since disconnected.',
    blame: 'client',
  },
  inbox_ambiguous: {
    title: 'Inbox ambiguous',
    detail: 'The key has several inboxes and the call did not say which one to use. The response lists them, so a well-behaved client retries successfully.',
    blame: 'client',
  },
  message_not_found: {
    title: 'Message not found',
    detail: 'The message id no longer resolves: moved, deleted, or from a stale listing. Expected at low rates.',
    blame: 'user',
  },
  invalid_query: {
    title: 'Invalid search query',
    detail: 'The search string could not be parsed into a provider query. Usually the model inventing syntax the provider does not accept.',
    blame: 'client',
  },
  search_timeout: {
    title: 'Search timed out',
    detail: 'The provider did not answer the search in time. Large mailboxes and broad queries are the usual cause.',
    blame: 'provider',
  },
  plan_limit: {
    title: 'Plan limit reached',
    detail: 'The action cap blocked a billable call. This is the paywall firing, which is a product event rather than a fault.',
    blame: 'server',
  },
  validation_failed: {
    title: 'Validation failed',
    detail: 'The request passed schema checks but failed a business rule, for example an address that is not deliverable.',
    blame: 'client',
  },
  conflict: {
    title: 'Conflict',
    detail: 'The operation collided with existing state, such as creating something that already exists.',
    blame: 'client',
  },
};

/** Explanation for a code, or null when we have nothing useful to say. */
export function explainErrorCode(code: string | null): ErrorExplanation | null {
  if (!code) return null;
  return ERROR_CODE_EXPLANATIONS[code] ?? null;
}

// ---------------------------------------------------------------------------
// Per-tool `securitySchemes` for tools/list.
//
// WHY (2026-09-25). OpenAI rejected the ChatGPT app because "send an email"
// and "create an automation" failed. The reviewer's token held read:email and
// search:email only; our answer to a call needing more was the HTTP 403 +
// WWW-Authenticate step-up challenge (scope-challenge.ts), which Claude follows
// and ChatGPT does not. ChatGPT only shows its OAuth (re)linking UI for a tool
// when (1) the tool declares `securitySchemes` in its descriptor and (2) the
// call returns an isError RESULT carrying `_meta["mcp/www_authenticate"]`.
// This module is half (1); half (2) is insufficientScopeToolResult in
// scope-challenge.ts.
//
// Shape, per developers.openai.com/apps-sdk/build/auth:
//
//   securitySchemes: [{ type: "oauth2", scopes: ["send:email"] }]
//
// `scopes` is what ChatGPT asks for on the consent screen when linking for
// this tool. It names ONE primary scope per tool, the one its headline action
// needs (see consolidatedSecurityScopes); anything more is asked for at run
// time by the challenge, never up front.
// Alternatives (`altScopes`) are deliberately left out: they are an OR-list
// ("any one of these also works"), and naming them would widen the consent
// prompt for no gain — the same reasoning buildInsufficientScopeChallenge uses
// to take only the first required scope.
//
// Pure, so the derivation is tested directly against the real action tables.
// ---------------------------------------------------------------------------

/** One entry of a tool descriptor's `securitySchemes` array. */
export interface OAuth2SecurityScheme {
  type: "oauth2";
  scopes: string[];
}

/**
 * The `securitySchemes` array for a tool whose actions need `scopes`, or
 * undefined when there are none (nothing to declare, so nothing is emitted).
 * Deduplicated, first-use order kept so the wire bytes are reproducible.
 */
export function toolSecuritySchemes(
  scopes: readonly string[],
): OAuth2SecurityScheme[] | undefined {
  const unique: string[] = [];
  for (const scope of scopes) {
    if (typeof scope === "string" && scope.length > 0 && !unique.includes(scope)) {
      unique.push(scope);
    }
  }
  if (unique.length === 0) return undefined;
  return [{ type: "oauth2", scopes: unique }];
}

/**
 * The scope a consolidated tool declares: the primary scope of its FIRST
 * advertised action, alone.
 *
 * Deliberately NOT the union of every action's scope. OpenAI does not document
 * whether ChatGPT reads a multi-scope list as all-required (as OpenAPI scope
 * lists are) and pre-checks a token against it. If it does, `draft` declaring
 * ["manage:drafts","send:email"] would make a drafts-only grant look unable to
 * create a draft, and `folder` would demand read:email for its legacy 'list'.
 * One scope per tool cannot over-demand: an action that needs more (draft
 * send, a move automation's manage:folders) still gets it through the runtime
 * `mcp/www_authenticate` challenge, which names the exact scope missing.
 * The first advertised action is the tool's headline use in every spec
 * (email_read list, draft create, folder create, automation create).
 */
export function consolidatedSecurityScopes(
  actions: Readonly<Record<string, { scope: string; advertised?: boolean }>>,
): string[] {
  const all = Object.values(actions);
  const first = all.find((action) => action.advertised !== false) ?? all[0];
  return first ? [first.scope] : [];
}

/**
 * Whether an MCP `clientInfo.name` (as recorded in mcp_client_capabilities)
 * is one of OpenAI's clients: ChatGPT or Codex.
 *
 * Names observed in production on 2026-09-25: `openai-mcp`,
 * `openai-mcp (Codex)`, `openai-mcp (ChatGPT)`, `codex-mcp-client` (which is
 * ALSO what ChatGPT connectors present as), `Codex`, `codex-config-check`.
 * No OAuth key has ever been seen from both an OpenAI and a non-OpenAI client.
 */
export function isOpenAiClientName(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase();
  return normalized.startsWith("openai-mcp") || normalized.startsWith("codex");
}

/**
 * Whether an `api_keys.name` is one our OAuth token endpoint minted for an
 * OpenAI client. apps/web/app/api/oauth/token/route.ts names every OAuth key
 * `OAuth: <registered client_name>`, de-duplicated with a " (n)" suffix.
 * Observed for OpenAI on 2026-09-25: `OAuth: ChatGPT`, `OAuth: chatgpt.com`,
 * `OAuth: Codex`, each optionally suffixed.
 *
 * A second, query-free signal beside the `initialize` row: it is on the key
 * row the request already loaded. Self-reported like clientInfo is, and it
 * only ever selects the SHAPE of a scope refusal, never whether a call runs.
 */
export function isOpenAiOAuthKeyName(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  return /^OAuth: (chatgpt(\.com)?|codex|openai)( \(\d+\))?$/i.test(name.trim());
}

// ---------------------------------------------------------------------------
// MCP Apps (`io.modelcontextprotocol/ui`) — resource surface
//
// This module holds the pure, I/O-free half of the MCP Apps protocol layer:
// the `ui://` resource registry, the wire-shape builders for `resources/list`,
// `resources/read` and `resources/templates/list`, the `resources` capability
// object emitted at `initialize`, and the `_meta` the tool list carries.
//
// It lives outside `index.ts` for the same reason `validation-observability.ts`
// does: `index.ts` calls `Deno.serve` and constructs a service-role Supabase
// client at module load, so it cannot be imported by a test. Everything here is
// deterministic and dependency-free, so `mcp-app-resources.test.ts` can assert
// the exact bytes we put on the wire.
//
// ── Empirical grounding ─────────────────────────────────────────────────────
// Every shape below was verified against the official `modelcontextprotocol/
// ext-apps` reference host during the Phase 0 spike; see
// `docs/mcp-apps/phase-0-protocol-findings.md` (wire-format cheat sheet) and
// the fixed identifiers in `docs/mcp-apps/contract.md` §0.
// ---------------------------------------------------------------------------

import { REVIEW_CARD_HTML } from "./ui/review-card.html.ts";

/**
 * The mimeType that marks a resource as an MCP App rather than plain HTML.
 *
 * Phase 0 Q7.6: the string must be *exactly* this — no space after the
 * semicolon, no `charset` parameter. The reference host compares it literally
 * and silently declines to render anything else as an app.
 */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Canonical URI of the single review card. Fixed by `contract.md` §0. */
export const REVIEW_CARD_RESOURCE_URI = "ui://mcpemails/review-card.html";

/**
 * The `resources` capability object declared in the `initialize` result.
 *
 * Phase 0 Q5 makes this a hard blocker rather than a nicety: the host's
 * `AppBridge.connect()` only wires the app→server resource proxy when
 * `serverCapabilities.resources` is truthy, so without this every
 * `resources/read` issued from inside the iframe fails `-32601 Method not
 * found` — even though the host's own out-of-band read succeeded and the card
 * rendered. Both flags are honest: we serve a fixed catalogue and will not
 * implement `resources/subscribe`.
 */
export const RESOURCES_CAPABILITY = {
  subscribe: false,
  listChanged: false,
} as const;

/**
 * Content Security Policy advertised for our `ui://` resources: empty on every
 * axis (`contract.md` §0).
 *
 * The card reaches the outside world exclusively through `app.callServerTool`,
 * which is proxied by the host over its existing MCP connection and is not
 * subject to page CSP. It therefore needs to `fetch()` nothing, embed nothing,
 * frame nothing and set no `<base>`. Phase 0 Q7.7 confirms `csp` and
 * `prefersBorder` are the only `_meta.ui` resource fields the reference host
 * acts on, and that an omitted `csp` falls back to a restrictive default —
 * we state ours explicitly rather than relying on that default.
 *
 * Returned fresh per call so a caller cannot mutate the shape shared by every
 * subsequent response.
 */
export function mcpAppUiMeta(): {
  ui: {
    csp: {
      connectDomains: string[];
      resourceDomains: string[];
      frameDomains: string[];
      baseUriDomains: string[];
    };
    prefersBorder: boolean;
  };
} {
  return {
    ui: {
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      // The card draws its own bordered container, so a host-drawn border
      // would double up.
      prefersBorder: false,
    },
  };
}

/** One entry in the `ui://` resource catalogue. */
interface McpAppResource {
  uri: string;
  /** Programmatic identifier, stable across releases. */
  name: string;
  /** Human-readable label for resource browsers. */
  title: string;
  description: string;
  /** The document served by `resources/read`. */
  html: string;
}

/**
 * The complete `ui://` catalogue. Exactly one entry today.
 *
 * Phase 0 Q7.5 is the reason to be careful here: the host's
 * `getToolUiResourceUri` *throws* on a non-`ui://` URI rather than returning
 * undefined, so a typo in a scheme takes down the entire tool list, not just
 * one card.
 */
const MCP_APP_RESOURCES: readonly McpAppResource[] = [
  {
    uri: REVIEW_CARD_RESOURCE_URI,
    name: "review_card",
    title: "Review card",
    description:
      "Interactive review surface for outbound and bulk mailbox operations: " +
      "shows exactly what will be sent, deleted, or moved before it happens.",
    html: REVIEW_CARD_HTML,
  },
];

/**
 * `resources/list` result.
 *
 * `_meta.ui` is emitted here *as well as* on the read content. Phase 0 Q7.2:
 * both locations are read, the content-level one wins, and hosts differ in
 * which they consult — the listing-level copy lets a host review the CSP at
 * connect time. Sending both is the only shape that is correct everywhere.
 */
export function buildResourcesListResult(): {
  resources: Array<Record<string, unknown>>;
} {
  return {
    resources: MCP_APP_RESOURCES.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: mcpAppUiMeta(),
    })),
  };
}

/**
 * `resources/read` result for `uri`, or `null` when the URI is not in the
 * catalogue (the caller turns that into a JSON-RPC error, never a throw).
 *
 * Phase 0 Q7.6: `contents` must contain *exactly one* item — the reference
 * host throws `Unexpected contents count` on zero or two, which surfaces to
 * the user as a broken card rather than a readable error.
 */
export function buildResourceReadResult(
  uri: string,
): { contents: Array<Record<string, unknown>> } | null {
  const resource = MCP_APP_RESOURCES.find((entry) => entry.uri === uri);
  if (!resource) return null;

  return {
    contents: [{
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      mimeType: MCP_APP_MIME_TYPE,
      text: resource.html,
      _meta: mcpAppUiMeta(),
    }],
  };
}

/**
 * `resources/templates/list` result — deliberately empty.
 *
 * Our catalogue is a fixed set of concrete URIs with no parameterised
 * templates. The method is still implemented because `AppBridge` proxies it
 * whenever `resources` is declared, and an unhandled `-32601` shows up as noise
 * in app logs (Phase 0 cheat sheet).
 */
export function buildResourceTemplatesListResult(): {
  resourceTemplates: Array<Record<string, unknown>>;
} {
  return { resourceTemplates: [] };
}

// ---------------------------------------------------------------------------
// Tool-level `_meta`
// ---------------------------------------------------------------------------

/**
 * The outbound tools that can return a review card, and the single source of
 * truth for *which* tools those are.
 *
 * ── Card-bearing is not the same as card-emitting ───────────────────────────
 * Membership here means "a call to this tool can produce a payload the card
 * knows how to render". It does NOT mean the tool always does, and it must not
 * be read as "attach `_meta.ui` at module load". These three only ever produce
 * a reviewable payload when the send is held for a human — `queueSendApproval`
 * returns null unless the target inbox has `send_approval_required` set — and
 * that switch is off for the overwhelming majority of inboxes.
 *
 * `_meta.ui` is per-tool, not per-call: a host mounts and fetches the card for
 * EVERY result of a tool that carries it. So stamping these three
 * unconditionally made every ordinary send mount a card with nothing to show,
 * which is what the stuck loading skeleton under `email_compose` actually was.
 * The list is therefore applied at `tools/list` time, per key, through
 * `reviewCardMetaForListing` below — see the gate note in `handleToolsList`.
 *
 * The `approval_*` tools are not listed here: they are defined in
 * `mcp-app-approvals.ts` and carry `appOnlyReviewCardToolMeta()` instead,
 * which adds `visibility: ["app"]` on top of the same resource URI. They are
 * correctly unconditional — they are app-only affordances that exist solely to
 * drive the card and always return an envelope.
 */
export const REVIEW_CARD_TOOL_NAMES: readonly string[] = [
  "email_compose",
  "draft",
  "schedule",
];

/**
 * The bulk tools that can return a bulk-plan card.
 *
 * Kept beside `REVIEW_CARD_TOOL_NAMES` rather than in `index.ts` because the
 * two lists are now governed by the same rule: a card-bearing tool earns its
 * `_meta.ui` per key at `tools/list` time, never at module load. (It lived in
 * `index.ts` while the outbound list was unconditional and this one was not —
 * that asymmetry is gone.)
 *
 * These emit a plan only when the target inbox has `bulk_review_mode = 'plan'`.
 */
export const BULK_PLAN_CARD_TOOL_NAMES: readonly string[] = [
  "email_delete",
  "email_organize",
];

/**
 * The `_meta` attached to a UI-bearing tool in `tools/list`.
 *
 * ── `visibility` is NOT an authorisation boundary ───────────────────────────
 * The `_meta.ui` object also admits a `visibility: ["app"]` field, and it is
 * tempting to read it as "only the card may call this tool". Phase 0 Q2 proved
 * that reading is wrong, three ways: (a) the filter lives in the *host's own
 * application code*, not in the SDK, and the SDK's own
 * `isToolVisibilityAppOnly` helper is exported but never called by the library;
 * (b) an app-originated `tools/call` is byte-for-byte indistinguishable from a
 * model-originated one at the server — same origin, same headers, same bearer
 * credentials, because the iframe's call is proxied through the host's existing
 * MCP client; and (c) a plain SDK client with no app in the picture called an
 * `["app"]`-only tool successfully.
 *
 * So `visibility` is a host UI hint and nothing more. The mail tools below
 * therefore omit it entirely — they are meant to be model-callable — and
 * nothing anywhere in this server treats the field as a security control. The
 * approval tools DO emit it (see `appOnlyReviewCardToolMeta`), purely so a
 * well-behaved host keeps them out of the model's picker.
 *
 * Phase 0 Q7.4: emit only the nested `_meta.ui.resourceUri`. The deprecated
 * flat `_meta["ui/resourceUri"]` key still works as a fallback but is
 * documented for removal before GA.
 */
export function reviewCardToolMeta(): {
  ui: { resourceUri: string };
} {
  return { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI } };
}

/**
 * `_meta` for the approval tools: the same card, plus `visibility: ["app"]`.
 *
 * ── Why emit `visibility` here after all that ───────────────────────────────
 * Tidiness, and only tidiness. A host that implements the reference filter
 * (`visibility.includes("model")`) keeps `approval_review`, `approval_decide`,
 * `approval_update` and `approval_schedule` out of the model's tool picker,
 * which is worth having: they are card affordances, not things a model should
 * reach for unprompted.
 *
 * It buys **no** security whatsoever, and the design does not lean on it by a
 * single millimetre. Phase 0 Q2 (quoted above) established that the server is
 * given no way to tell an app-originated call from a model-originated one, and
 * that a plain SDK client calls an `["app"]`-only tool successfully. So the
 * approval tools are written on the assumption that a prompt-injected agent
 * calls all four of them: every one is either read-only, reversible, or
 * fail-safe, and the single irreversible action — approving a send — is not
 * exposed on this channel at all. See `mcp-app-approvals.ts` and
 * `docs/mcp-apps/contract.md` §6.
 *
 * If you are here because you want to add an app-only tool that *does*
 * something irreversible: you cannot. Move the action to an authenticated
 * surface instead.
 */
export function appOnlyReviewCardToolMeta(): {
  ui: { resourceUri: string; visibility: string[] };
} {
  return { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI, visibility: ["app"] } };
}

/**
 * The two per-key opt-ins that decide whether a card-bearing tool is listed
 * with `_meta.ui` in one `tools/list` response.
 *
 * Both are booleans the caller has already resolved from the database, so the
 * decision below stays pure and testable while the query stays in `index.ts`.
 */
export interface ReviewCardGates {
  /** True when the key can reach an inbox with `send_approval_required`. */
  outbound: boolean;
  /** True when the key can reach an inbox with `bulk_review_mode = 'plan'`. */
  bulk: boolean;
}

/**
 * The `_meta` one tool carries in a `tools/list` response, or `undefined` when
 * it must carry none.
 *
 * ── Why this is a function of the key and not of the tool ───────────────────
 * `_meta.ui` is per-tool, so a host mounts, fetches and renders the card for
 * every single result of a tool that advertises one. A card-bearing tool that
 * is not gated in can never produce a payload the card understands — the send
 * is not held, the bulk op is not planned — so the host would spend an iframe
 * and a `resources/read` on every ordinary result and show the user a skeleton
 * or a "could not be displayed" notice for its trouble. Withholding the
 * metadata is the only way to make "a key that has not opted in sees exactly
 * what it saw before MCP Apps existed" literally true, `tools/list` included.
 *
 * Returns `undefined` (not `null`, not an empty object) for every other tool,
 * so the caller can leave the registry entry untouched. That matters for the
 * `approval_*` and `bulk_*` tools, which carry `appOnlyReviewCardToolMeta()`
 * from the registry and must keep it unconditionally — they are app-only
 * affordances that always return an envelope, so there is no mismatch to gate
 * against.
 */
export function reviewCardMetaForListing(
  toolName: string,
  gates: ReviewCardGates,
): { ui: { resourceUri: string } } | undefined {
  if (REVIEW_CARD_TOOL_NAMES.includes(toolName)) {
    return gates.outbound ? reviewCardToolMeta() : undefined;
  }
  if (BULK_PLAN_CARD_TOOL_NAMES.includes(toolName)) {
    return gates.bulk ? reviewCardToolMeta() : undefined;
  }
  return undefined;
}

/**
 * Structural shape of a tool as it appears on the `tools/list` wire. Kept as a
 * type alias (not an interface) so `index.ts`'s richer `ToolDefinition` is
 * structurally assignable to it without either file importing the other's type.
 */
export type ListedTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * Serialize one registry entry into its `tools/list` wire object.
 *
 * Optional fields are omitted entirely rather than emitted as `undefined`, so
 * a tool without an output schema, annotations, or UI metadata produces
 * byte-identical JSON to before MCP Apps existed.
 */
export function serializeToolForList(
  tool: ListedTool,
): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    ...(tool._meta ? { _meta: tool._meta } : {}),
  };
}

// ---------------------------------------------------------------------------
// Client capability observation
// ---------------------------------------------------------------------------

/** The extension key a UI-capable client declares at `initialize`. */
export const UI_EXTENSION_KEY = "io.modelcontextprotocol/ui";

/**
 * True when the client explicitly declared the MCP Apps extension.
 *
 * **This must never gate `_meta.ui` emission.** Phase 0 Q1: the official
 * `ext-apps` reference host sends `capabilities: {}` — no `extensions` key at
 * all — and the entire app flow still works end to end. Following the SEP's
 * "check client capabilities before registering UI-enabled tools" advice would
 * therefore have degraded us to a text-only tool surface against a conforming
 * host. The field is a reliable *positive* signal when present and carries no
 * information when absent, so we record it for observability and branch on
 * nothing.
 */
export function clientSupportsUiExtension(
  capabilities: Record<string, unknown> | undefined,
): boolean {
  const extensions = capabilities?.["extensions"];
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) {
    return false;
  }
  return UI_EXTENSION_KEY in (extensions as Record<string, unknown>);
}

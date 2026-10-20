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

import { REVIEW_CARD_BUILD_ID, REVIEW_CARD_HTML } from "./ui/review-card.html.ts";
import { advertisedInputSchema } from "./advertised-schema.ts";
import { toolSecuritySchemes } from "./security-schemes.ts";

/**
 * The mimeType that marks a resource as an MCP App rather than plain HTML.
 *
 * Phase 0 Q7.6: the string must be *exactly* this — no space after the
 * semicolon, no `charset` parameter. The reference host compares it literally
 * and silently declines to render anything else as an app.
 */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Canonical URI of the single review card, fingerprinted with the build id of
 * the bundle it serves (`contract.md` §0).
 *
 * ── Why this is not a fixed string ─────────────────────────────────────────
 * It was one until 2026-09-16, and that is the bug the draft editor's first
 * week in the real host exposed. The SEP lets a host "prefetch and cache UI
 * resource content", and Claude's host does so by URI and keeps it: measured in
 * production, the host read the card exactly once, then served three later tool
 * calls and a whole new OAuth authorization out of that one copy. A card deploy
 * therefore reached nobody who was already connected — the founder spent forty
 * minutes looking at a bundle that had been replaced on the server, which
 * presents as "my fix did not ship" and is unfalsifiable from inside the card.
 * See `CONCEPT-draft-editor.md` §13 for the log evidence.
 *
 * Fingerprinting the URI makes the cache work FOR us instead: an unchanged
 * bundle keeps its URI and stays cached (the host is right to keep it), and a
 * changed bundle is a URI the host has never seen, so it must read it. The id
 * is a content hash, so this is exact in both directions — no deploy counter to
 * bump and no way to forget.
 *
 * The client still has to re-read `tools/list` to learn the new URI, which it
 * does on connect. So the operational rule is unchanged and now sufficient:
 * reconnect the connector after a card deploy. Before this, reconnecting did
 * not help either, which is what made it so hard to see.
 */
export const REVIEW_CARD_RESOURCE_URI =
  `ui://mcpemails/review-card.${REVIEW_CARD_BUILD_ID}.html`;

/**
 * The unfingerprinted URI every build before 2026-09-16 advertised.
 *
 * Still served, and deliberately served the CURRENT bundle: a host that cached
 * the old `tools/list` will ask for this URI for as long as it holds that
 * listing, and the only two answers are today's card or a `-32002` that renders
 * as a broken cell. A card is always the better answer — envelope skew is what
 * `schema_version` is for, and the card has a screen for it.
 *
 * It is NOT advertised in `resources/list` and no tool points at it. Nothing
 * new can acquire it; it only ever answers a client that already had it.
 */
export const REVIEW_CARD_LEGACY_RESOURCE_URI = "ui://mcpemails/review-card.html";

/**
 * The shape of every fingerprinted card URI this server has ever advertised:
 * the canonical one above with ANY build id in the fingerprint slot.
 *
 * ── Why a read accepts a fingerprint that is not ours ──────────────────────
 * Fingerprinting assumed the client re-reads `tools/list` after a card deploy.
 * Claude's host does not: it keeps the listing it has, ignores
 * `notifications/tools/list_changed`, and goes on asking `resources/read` for
 * the PREVIOUS build's URI, in new chats too. Measured 2026-10-13: the client
 * asked for `review-card.f53069d8832a.html` while the server was on
 * `6f24045a029e`, got `-32002`, and showed "cannot reach MCPEmails" where the
 * card belongs, until the tool list was refreshed by hand. Every card deploy
 * did this to every connected client.
 *
 * So the READ side is tolerant and the ADVERTISED side is not. This is the
 * legacy URI's argument again (see REVIEW_CARD_LEGACY_RESOURCE_URI): the only
 * two answers to a stale URI are today's card or a broken cell, and there is
 * exactly one bundle on this server to give.
 *
 * It costs the cache busting nothing. That works by the advertised URI being
 * one the host has never read, which is still true: a client that refreshes
 * its listing gets the new fingerprint and must fetch it. What a client that
 * does NOT refresh may keep is its cached copy of the old bundle, which is
 * where it already was before this, and envelope skew between an old card and
 * a new server is what `schema_version` is for.
 *
 * Anchored, and the hash is exactly what `REVIEW_CARD_BUILD_ID` is pinned to
 * be (12 lowercase hex), so nothing but a build id fits the slot: no query, no
 * path, no second extension, no other resource name.
 */
const REVIEW_CARD_FINGERPRINTED_URI_PATTERN =
  /^ui:\/\/mcpemails\/review-card\.[0-9a-f]{12}\.html$/;

/**
 * True when `uri` is a well-formed card URI carrying another build's
 * fingerprint. False for the current URI, the legacy one and anything else.
 *
 * Exported for the `resources/read` log line only, so a stale read is
 * countable after a deploy. `buildResourceReadResult` is what serves it.
 */
export function isStaleReviewCardUri(uri: string): boolean {
  return uri !== REVIEW_CARD_RESOURCE_URI && REVIEW_CARD_FINGERPRINTED_URI_PATTERN.test(uri);
}

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
      "shows exactly what will be sent, deleted, or moved before it happens. " +
      "Also the draft editor, where the user reads and edits an unsent draft.",
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
 * `resources/read` result for `uri`, or `null` when the URI names nothing we
 * serve (the caller turns that into a JSON-RPC error, never a throw). Three
 * URIs resolve, all to the one current bundle: the catalogue's, the legacy
 * bare name, and the catalogue's with another build's fingerprint.
 *
 * Phase 0 Q7.6: `contents` must contain *exactly one* item — the reference
 * host throws `Unexpected contents count` on zero or two, which surfaces to
 * the user as a broken card rather than a readable error.
 */
export function buildResourceReadResult(
  uri: string,
): { contents: Array<Record<string, unknown>> } | null {
  const resource = MCP_APP_RESOURCES.find((entry) => entry.uri === uri) ??
    // A client holding a `tools/list` from before the URI was fingerprinted
    // still asks for the bare name; answer it with today's card rather than a
    // "resource not found" that renders as a broken cell. See
    // REVIEW_CARD_LEGACY_RESOURCE_URI.
    // The same answer for a fingerprint from an earlier build: a client that
    // kept its `tools/list` across a card deploy asks for the URI that listing
    // named. See REVIEW_CARD_FINGERPRINTED_URI_PATTERN.
    (uri === REVIEW_CARD_LEGACY_RESOURCE_URI || isStaleReviewCardUri(uri)
      ? MCP_APP_RESOURCES[0]
      : undefined);
  if (!resource) return null;

  return {
    contents: [{
      // Echo the URI that was ASKED for, not the catalogue's. A host matches the
      // content it gets back against the request it made and against its own
      // cache key; handing it a URI it did not ask for is how a legacy read
      // turns into an unrenderable cell. A stale fingerprint is echoed too, for
      // the same reason: the host keys its cache by the URI its listing named,
      // and that listing is the one thing we know it has not replaced.
      uri,
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
  "schedule",
];

/**
 * The draft tool, gated by the draft editor instead (contract §8).
 *
 * ── Why `draft` left the outbound list ─────────────────────────────────────
 * It was there because a held `draft{action:"send"}` produces a §2 outbound
 * envelope, and that is still true. What changed is that it now produces
 * something renderable on FIVE more paths: with `workspaces.draft_editor_enabled`
 * on, every successful create, reply and update carries a §8 draft_editor
 * envelope, and send and delete carry a §4 receipt. So the condition under
 * which `draft` earns `_meta.ui` is no longer "this key can reach an inbox that
 * holds sends" — it is "this workspace has the editor", and gating it on the
 * send opt-in would have withheld the card from every draft the editor exists
 * to show.
 *
 * `email_compose` and `schedule` stay on the outbound gate: they have no second
 * card, and for them an ungated call still returns today's plain payload, which
 * is not an envelope. The asymmetry is the point — see CONCEPT-draft-editor.md
 * §8, which argues it from the same fact: a draft result ALWAYS has something
 * to render, and a send result only sometimes does.
 */
export const DRAFT_EDITOR_CARD_TOOL_NAMES: readonly string[] = [
  "draft",
];

/**
 * The draft editor's own three tools, gated by the SAME flag: one app-only,
 * and two the model may call too (see
 * `DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES` below).
 *
 * ── Why they are no longer stamped at module load ──────────────────────────
 * They were pushed into the registry with `appOnlyReviewCardToolMeta()`
 * unconditionally, on the argument that an app-only tool always returns an
 * envelope so there is no result shape for the card to fail on. True of
 * `approval_*` and `bulk_*`; not true here, because these three are the only
 * app-only tools with a user-facing OFF switch. With the card hidden they
 * still advertised `_meta.ui` while `draft` correctly dropped it — measured
 * 2026-09-16 — so the host kept mounting the editor for an inbox the user had
 * switched off, and `draft_read` kept handing it a full decrypted body.
 *
 * The handlers now refuse when the opt-out is set (`gateDraftTool`), and this
 * list is the listing half of the same fix: no gate, no metadata, which is
 * what "the opt-out is byte-identical to life before MCP Apps" means for
 * `tools/list`. The tools stay LISTED — a card restoring from storage in an
 * old conversation still calls `draft_read`, and a renderable "the card is
 * turned off" envelope is a better answer than a -32601.
 *
 * `draft_read` no longer refuses (2026-10-02). With the gate shut it has no
 * `_meta`, so it is listed as an ordinary model-visible tool, and it answers
 * as one: a plain read with no envelope, which a restoring card cannot render
 * an editor from. `draft_editor_save` still refuses. See
 * `mcp-app-drafts.ts#gateDraftTool`.
 *
 * Kept apart from `DRAFT_EDITOR_CARD_TOOL_NAMES` because the metadata differs:
 * these carry a `visibility` list on top of the resource URI, `draft` does
 * not. Same gate, different shape.
 */
export const DRAFT_EDITOR_APP_TOOL_NAMES: readonly string[] = [
  "draft_read",
  "draft_editor_save",
  "draft_editor_hide",
];

/**
 * The draft-editor tools the model is meant to call while the card is on.
 *
 * ── Why `draft_read` stopped being app-only (2026-10-13, owner's decision) ──
 * With the gate open it carried `visibility: ["app"]`, so a host that honours
 * the hint kept it out of the model's picker. That left a model with no way to
 * learn what a draft says once the user had edited it in the card: `draft_list`
 * returns no body, the write results return none, and the model's own copy is
 * the text it wrote BEFORE the edit. Its next `draft{action:"update"}` then put
 * that older text back over the user's.
 *
 * So `draft_read` is listed to both audiences, `["model", "app"]`: the card
 * still calls it (restore, Refresh, and the fallback when a write's `_meta`
 * body did not arrive), and the model can call it for the current text. Its
 * `content` is the plain read in both gate states, which is what makes the
 * model's call worth making. See `mcp-app-drafts.ts#runDraftRead`.
 *
 * Nothing about what it DISCLOSES changed: `visibility` was never a boundary
 * (Phase 0 Q2, quoted on `reviewCardToolMeta`), the tool has returned the body
 * to any caller with both scopes since it shipped, and with the gate shut it
 * was already an ordinary model-visible tool.
 *
 * It no longer keeps `resourceUri` (2026-10-17, see
 * `DRAFT_EDITOR_UNMOUNTED_TOOL_NAMES` below): a model's read draws no card.
 *
 * ── And `draft_editor_hide`, for consistency with what the card says ───────
 * It was `["app"]` too, as "the card's own Hide link". But the card's copy
 * tells a person the card "can be brought back by asking in this chat", and
 * once the card is hidden there is no card left to click: the only route back
 * is the model calling this tool with `hidden:false`. An app-only listing made
 * that sentence false on every host that honours the hint, and the server
 * instructions said the same wrong thing from the other side ("The host drives
 * them, not you"). So it is `["model", "app"]`, the instructions no longer
 * list it as app-only, and its description says when to call it. It is a
 * display preference, reversible by the same call; the hostile-caller analysis
 * on `runDraftEditorHide` already assumed a model calls it.
 *
 * `draft_editor_save` stays `["app"]`: it writes what a person typed.
 */
export const DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES: readonly string[] = [
  "draft_read",
  "draft_editor_hide",
];

/**
 * The draft-editor tools listed WITHOUT the card's `resourceUri`, so a host
 * never mounts a card under their results. Only `draft_read`.
 *
 * ── Why (live review in claude.ai, 2026-10-17) ─────────────────────────────
 * A model rewriting a draft calls `draft_read` first (its description tells it
 * to), then `draft{action:"update"}`. With `resourceUri` on both, every
 * revision drew TWO cards: the read's one-liner ("Draft: <subject> to <addr>
 * · Open editor", DraftReadLine.tsx) and the editor under the write. The read
 * is for the model; the person already has the editor the write mounts, so the
 * one-liner was noise, and its "Open editor" was a second way into a second
 * live editor for one draft, which is the very thing the one-liner had been
 * introduced to stop.
 *
 * So the listing keeps `visibility: ["model", "app"]` and drops the URI. Per
 * the MCP Apps spec a host mounts UI only for a tool with a `resourceUri`, and
 * an app may call any tool of its own server whose visibility includes "app"
 * (Phase 0 Q2: the reference host's proxy does not check either). The card's
 * own `draft_read` calls (restore, Refresh, the deferred-body fallback,
 * attention checks) are app calls, which never mount anything, so they are
 * unchanged.
 *
 * ── Is the "Open editor" one-liner still needed? ─────────────────────────────
 * Decided no as a default. The case it served, "the original card is gone or
 * far above", is served by the model calling `draft{action:"update"}`, which
 * mounts a full editor under the newest turn. DraftReadLine.tsx stays in the
 * card for one reason: a host still holding a listing from before this change
 * mounts the card for `draft_read` until it re-reads `tools/list`, and the
 * one-liner is the right rendering there. If a real need appears (a person
 * asking to "show me the draft" with no write to make), bring it back as an
 * explicit tool argument, not by re-adding the URI to every read.
 */
export const DRAFT_EDITOR_UNMOUNTED_TOOL_NAMES: readonly string[] = [
  "draft_read",
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
 *
 * `email_search_and_move` is here because it is the same handler under a second
 * name: since 2026-09-09 it is advertised on its own as well as reachable as
 * `email_organize{action:"search_and_move"}`, and that handler calls
 * `createBulkPlan` before it moves anything. Membership is keyed by the name a
 * client CALLS, so leaving it out would mean a plan-mode inbox got a bulk_plan
 * envelope back from a tool whose `tools/list` entry never told the host to
 * mount the card for it, which is an unrenderable result rather than a
 * preview. The plan row it writes still carries `operation: "email_organize"`
 * (see operationForAction in mcp-app-bulk.ts) because that is the contract §3
 * field naming the operation, not the tool the caller happened to use.
 */
export const BULK_PLAN_CARD_TOOL_NAMES: readonly string[] = [
  "email_delete",
  "email_organize",
  "email_search_and_move",
];

/**
 * The same three gates on the per-operation surface (the listing OpenAI
 * clients get, PER_OPERATION_LISTING in index.ts), keyed by the operation
 * rather than by the consolidated tool it belongs to.
 *
 * `_meta.ui` is per tool, so one tool per operation lets the card be claimed
 * only by the operations that can actually return something it renders: the
 * three sends and a scheduled send (held for approval), the four bulk
 * operations that plan before they act, and the five draft writes. The
 * single-message `email_delete` and `email_move`, `schedule_cancel` and every
 * read carry nothing, where their consolidated parents have to.
 */
export const PER_OPERATION_CARD_TOOL_NAMES: Readonly<
  Record<keyof ReviewCardGates, readonly string[]>
> = {
  outbound: ["email_send", "email_reply", "email_forward", "schedule_create"],
  bulk: [
    "email_move_batch",
    "email_delete_batch",
    "email_search_and_move",
    "email_search_and_delete",
  ],
  drafts: ["draft_create", "draft_reply", "draft_update", "draft_send", "draft_delete"],
};

/** Which listing a tool is being serialised for. See PER_OPERATION_LISTING. */
export type ToolSurface = "consolidated" | "per_operation";

/**
 * True when a call to this tool name can mount the review card, under any of
 * the three gates.
 *
 * Deliberately gate-BLIND: it asks "is this a tool whose listing can carry
 * `_meta.ui`", not "does this key have it today". The caller
 * (`card-build-notify.ts`) uses it to decide whether a stale tool listing is
 * worth invalidating, and a key that is not gated in has no card URI to be
 * stale — so the worst a false positive costs is one `tools/list` the client
 * did not strictly need. Resolving the real gates here would mean the database
 * lookups `reviewCardMetaForListing` already did at listing time, repeated on
 * every tool call.
 *
 * ── The draft-editor app tools are IN, as of round two ─────────────────────
 * They were left out on the argument that it cost nothing. It did cost
 * something, and the cost was on the wrong side of the trade this function
 * already made. Two ways:
 *
 *   * By this function's own definition they ARE card-bearing:
 *     `reviewCardMetaForListing` hands all three a card `_meta`
 *     whenever the drafts gate is open, so their listing carries a card URI
 *     that a deploy can make stale exactly like `draft`'s. They are also the
 *     tools the card itself calls most — a restoring cell calls `draft_read`
 *     before it calls anything else — so a client whose next call after a card
 *     deploy was `draft_read` got no notification at all and went on holding
 *     the previous bundle's URI. That is the original problem, not a rounding
 *     error on it.
 *   * `draft_editor_hide` writes the preference and calls
 *     `invalidateCardListings` (index.ts), which is the precise moment
 *     `tools/list` needs re-reading so `_meta.ui` can disappear. It cannot
 *     carry the resulting notification on its OWN response — the decision
 *     reads the `api_keys` row snapshot taken before the write — but it is a
 *     card-bearing call for every subsequent one.
 *
 * The cost is what the paragraph above already accepts: a few `tools/list`
 * round trips a client did not strictly need.
 */
export function isCardBearingToolName(name: string): boolean {
  return (
    REVIEW_CARD_TOOL_NAMES.includes(name) ||
    BULK_PLAN_CARD_TOOL_NAMES.includes(name) ||
    DRAFT_EDITOR_CARD_TOOL_NAMES.includes(name) ||
    DRAFT_EDITOR_APP_TOOL_NAMES.includes(name) ||
    Object.values(PER_OPERATION_CARD_TOOL_NAMES).some((names) => names.includes(name))
  );
}

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
 * `_meta` for a card tool the model is also meant to call: the same card, with
 * `visibility: ["model", "app"]`.
 *
 * The list is spelled out rather than omitted. Omitting `visibility` means the
 * same thing to the reference host (its default is both), but the explicit form
 * says in the listing itself that the card calls this tool as well, and it is
 * the shape the owner asked for. `draft_editor_hide` carries it; `draft_read`
 * carries the same list without the URI (`modelAndAppUnmountedToolMeta`).
 */
export function modelAndAppReviewCardToolMeta(): {
  ui: { resourceUri: string; visibility: string[] };
} {
  return {
    ui: { resourceUri: REVIEW_CARD_RESOURCE_URI, visibility: ["model", "app"] },
  };
}

/**
 * `_meta` for a tool the card calls and the model calls, whose results must
 * NOT mount the card: `visibility` only, no `resourceUri`. `draft_read`; see
 * `DRAFT_EDITOR_UNMOUNTED_TOOL_NAMES`.
 */
export function modelAndAppUnmountedToolMeta(): {
  ui: { visibility: string[] };
} {
  return { ui: { visibility: ["model", "app"] } };
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
  /**
   * True when the draft editor is both rolled out to the calling key's
   * workspace and not switched off by its owner.
   *
   * Three conditions ANDed by the caller: `workspaces.draft_editor_enabled`
   * (our rollout gate), NOT `workspaces.draft_editor_hidden` (the workspace
   * opt-out), and NOT "every inbox this key can reach has
   * `inboxes.draft_editor_hidden`" (the per-inbox opt-out, rolled up).
   *
   * The odd one out, and deliberately so: the other two are per-INBOX opt-ins
   * and the rollout half of this is per-WORKSPACE. A draft envelope is built
   * from the draft itself rather than from an inbox setting, so there is no
   * inbox-level switch for it to key on, and contract §8 puts the flag on
   * `workspaces`.
   */
  drafts: boolean;
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
  surface: ToolSurface = "consolidated",
): { ui: { resourceUri?: string; visibility?: string[] } } | undefined {
  if (surface === "per_operation") {
    // Checked INSTEAD of the consolidated lists, not as well as them:
    // `email_delete` is on the bulk list above as the consolidated tool, and
    // on this surface the same name is the single-message delete, which never
    // plans.
    for (const gate of ["outbound", "bulk", "drafts"] as const) {
      if (PER_OPERATION_CARD_TOOL_NAMES[gate].includes(toolName)) {
        return gates[gate] ? reviewCardToolMeta() : undefined;
      }
    }
    // The draft editor's own three are the same tools on both surfaces, so
    // they get the same metadata from the same function: `draft_read` and
    // `draft_editor_hide` model-and-app, `draft_editor_save` app-only. (When
    // this branch was written all three were app-only, and it said so inline;
    // a second copy of that rule here is what would have left the model unable
    // to read a draft back on this surface alone.)
    return draftEditorOwnToolMeta(toolName, gates);
  }
  if (REVIEW_CARD_TOOL_NAMES.includes(toolName)) {
    return gates.outbound ? reviewCardToolMeta() : undefined;
  }
  if (BULK_PLAN_CARD_TOOL_NAMES.includes(toolName)) {
    return gates.bulk ? reviewCardToolMeta() : undefined;
  }
  if (DRAFT_EDITOR_CARD_TOOL_NAMES.includes(toolName)) {
    return gates.drafts ? reviewCardToolMeta() : undefined;
  }
  // The draft editor's own three: same gate, plus a `visibility` list. They
  // are no longer stamped in the registry, so `undefined` here really does mean
  // "this listing carries no `_meta` at all" — see DRAFT_EDITOR_APP_TOOL_NAMES.
  // `draft_read` and `draft_editor_hide` are listed to the model as well as
  // the card; `draft_editor_save` is app-only.
  return draftEditorOwnToolMeta(toolName, gates);
}

/**
 * The listing `_meta` of the draft editor's own three tools, or `undefined`
 * for any other name and whenever the drafts gate is shut.
 *
 * One function for both surfaces (consolidated and per-operation): these three
 * are not operations of anything and are listed under the same names with the
 * same definitions on each, so which of them the model may call cannot differ
 * by surface.
 */
function draftEditorOwnToolMeta(
  toolName: string,
  gates: ReviewCardGates,
): { ui: { resourceUri?: string; visibility: string[] } } | undefined {
  if (!DRAFT_EDITOR_APP_TOOL_NAMES.includes(toolName)) return undefined;
  if (!gates.drafts) return undefined;
  if (DRAFT_EDITOR_UNMOUNTED_TOOL_NAMES.includes(toolName)) return modelAndAppUnmountedToolMeta();
  return DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES.includes(toolName)
    ? modelAndAppReviewCardToolMeta()
    : appOnlyReviewCardToolMeta();
}

/**
 * Apply `reviewCardMetaForListing` across a whole tool list. The listing path,
 * and a test can call this.
 *
 * ── AND THE CALL SITE IS PINNED SEPARATELY ────────────────────────────────
 * This used to say "THE listing path: `handleToolsList` calls nothing else",
 * and nothing held that claim. A second review broke it in one line — a `.map`
 * after this call re-stamping the three app-only tools — and the whole suite
 * stayed green, with the original bug back on the wire. A stamp inside
 * `toolsForListing` has the same property. Extracting this function bought
 * coverage of the composition and moved the risk one line outwards.
 *
 * So the composition tests below it are no longer the only thing: the last
 * section of `mcp-app-resources.test.ts` calls the real `handleToolsList` (in
 * `MCP_INTROSPECTION_ONLY` mode, where every gate is shut — the state in which
 * advertising `_meta.ui` IS the bug) and asserts on the bytes it returns. If
 * you add a step to that pipeline, that is the test that will tell you.
 *
 * ── Why this is a function and not three lines inside handleToolsList ──────
 * It was those three lines, and that is what let the headline fix ship with no
 * coverage at all. `reviewCardMetaForListing` is pure and was tested as such,
 * but the composition is where the bug lived: `meta ? {...tool, _meta: meta} :
 * tool` PASSES A REGISTRY `_meta` THROUGH UNTOUCHED. So a module-load
 * `TOOL_REGISTRY.push({...definition, _meta: appOnlyReviewCardToolMeta()})` —
 * the exact stamp the draft-editor fix removed, and an easy one to re-add
 * because the shape looks harmless — reinstated the original bug verbatim
 * while every one of the 1171 tests still passed. Reachable only through this
 * composition, so this composition is what a test has to be able to hold.
 *
 * `index.ts` cannot export it: the registry it builds is the thing under test,
 * so the assertion has to be able to run the real mapping over the real
 * registry. It lives here, next to the three name lists it consults.
 *
 * Note what it does NOT do: it never strips. A tool that carries `_meta` from
 * the registry keeps it, which is exactly right for `approval_*` and `bulk_*`
 * (unconditional app-only affordances, stamped at index.ts:7611 and :7632 on
 * purpose) and exactly wrong for anything gated. Gating and stamping are
 * mutually exclusive by construction, and `mcp-app-resources.test.ts` pins
 * which tools are on which side.
 */
export function withListingCardMeta(
  tools: readonly ListedTool[],
  gates: ReviewCardGates,
  surface: ToolSurface = "consolidated",
): ListedTool[] {
  return tools.map((tool) => {
    const meta = reviewCardMetaForListing(tool.name, gates, surface);
    // Merged, not replaced: a per-operation draft tool already carries
    // `openai/fileParams` (draft-attachments.ts), and the card's `ui` must not
    // erase it. Every other tool's own `_meta` is absent, so nothing changes.
    return meta ? { ...tool, _meta: { ...(tool._meta ?? {}), ...meta } } : tool;
  });
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
  /**
   * The narrower copy of `inputSchema` to publish, when the tool accepts
   * actions it does not advertise. See ToolDefinition in index.ts.
   */
  listedInputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  /**
   * The scope a key needs to call this tool. Every real registry entry has
   * one; it is optional here only so hand-built test fixtures stay valid. Read
   * by the serializer as the fallback for `securityScopes`.
   */
  requiredScope?: string;
  /**
   * Every PRIMARY scope any of this tool's actions can require, in first-use
   * order. Set on consolidated tools (derived from their action table); a
   * standalone tool falls back to `[requiredScope]`. See toolSecuritySchemes
   * in security-schemes.ts.
   */
  securityScopes?: readonly string[];
};

/**
 * Serialize one registry entry into its `tools/list` wire object.
 *
 * Optional fields are omitted entirely rather than emitted as `undefined`, so
 * a tool without an output schema, annotations, or UI metadata produces
 * byte-identical JSON to before MCP Apps existed.
 *
 * The input schema goes out WITHOUT its action-specific `allOf` rules
 * (advertised-schema.ts says why); the registry entry keeps them for the
 * validator, and a tool that has none serialises exactly as before.
 *
 * A tool carrying `listedInputSchema` publishes that instead: it is the same
 * schema built from the tool's ADVERTISED actions alone, which is how `folder`
 * shows create|rename|delete while `folder{action:"list"}` still validates
 * against the full `inputSchema` the registry kept. Passing it through
 * advertisedInputSchema too is a no-op that costs nothing and means neither
 * caller has to remember which of the two forms already dropped its rules.
 */
export function serializeToolForList(
  tool: ListedTool,
): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: advertisedInputSchema(tool.listedInputSchema ?? tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    // OpenAI's per-tool auth declaration (developers.openai.com/apps-sdk/
    // build/auth). Top level ONLY, deliberately not mirrored into `_meta`: the
    // presence of `_meta` on a mail tool is this module's signal for "carries
    // card metadata", pinned on the wire by mcp-app-resources.test.ts, and
    // OpenAI documents that ChatGPT reads the top-level field (the `_meta`
    // copy is a back-compat mirror for older clients only). A tool with no
    // scope (a hand-built fixture) emits nothing, so its bytes are unchanged.
    ...securitySchemesEntry(tool),
    ...(tool._meta ? { _meta: tool._meta } : {}),
  };
}

function securitySchemesEntry(tool: ListedTool): Record<string, unknown> {
  const scopes = tool.securityScopes ??
    (tool.requiredScope ? [tool.requiredScope] : []);
  const schemes = toolSecuritySchemes(scopes);
  return schemes ? { securitySchemes: schemes } : {};
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

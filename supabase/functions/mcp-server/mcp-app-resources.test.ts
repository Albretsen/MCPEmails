// ---------------------------------------------------------------------------
// MCP Apps protocol-layer tests.
//
// These assert the exact bytes the server puts on the wire against the shapes
// verified end-to-end during the Phase 0 spike
// (docs/mcp-apps/phase-0-protocol-findings.md, "Wire format cheat sheet") and
// the identifiers fixed in docs/mcp-apps/contract.md §0.
//
// They target mcp-app-resources.ts rather than index.ts because index.ts calls
// Deno.serve and builds a service-role Supabase client at module load, so it
// cannot be imported by a test. Every shape below is produced by the same
// functions index.ts calls.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  appOnlyReviewCardToolMeta,
  buildResourceReadResult,
  buildResourcesListResult,
  buildResourceTemplatesListResult,
  BULK_PLAN_CARD_TOOL_NAMES,
  clientSupportsUiExtension,
  DRAFT_EDITOR_APP_TOOL_NAMES,
  DRAFT_EDITOR_CARD_TOOL_NAMES,
  MCP_APP_MIME_TYPE,
  mcpAppUiMeta,
  RESOURCES_CAPABILITY,
  reviewCardMetaForListing,
  reviewCardToolMeta,
  REVIEW_CARD_LEGACY_RESOURCE_URI,
  REVIEW_CARD_RESOURCE_URI,
  REVIEW_CARD_TOOL_NAMES,
  isCardBearingToolName,
  serializeToolForList,
  withListingCardMeta,
} from "./mcp-app-resources.ts";
import { REVIEW_CARD_BUILD_ID, REVIEW_CARD_HTML } from "./ui/review-card.html.ts";
import { createHash } from "node:crypto";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** The CSP block from contract.md §0 — empty on every axis. */
const EXPECTED_UI_META = {
  ui: {
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    prefersBorder: false,
  },
};

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

Deno.test("initialize declares the resources capability with both flags false", () => {
  // Phase 0 Q5: without a declared `resources` capability the host's AppBridge
  // never wires the resource proxy and every resources/read from inside the
  // iframe fails -32601. Both flags are honest: static catalogue, no subscribe.
  assertEquals(
    RESOURCES_CAPABILITY as { subscribe: boolean; listChanged: boolean },
    { subscribe: false, listChanged: false },
    "resources capability",
  );
});

// ---------------------------------------------------------------------------
// resources/list
// ---------------------------------------------------------------------------

Deno.test("resources/list returns the single review card with listing-level _meta.ui", () => {
  const result = buildResourcesListResult();

  assertEquals(result.resources.length, 1, "resource count");

  const entry = result.resources[0];
  assertEquals(entry["uri"], REVIEW_CARD_RESOURCE_URI, "uri");
  assertEquals(
    entry["uri"],
    `ui://mcpemails/review-card.${REVIEW_CARD_BUILD_ID}.html`,
    "uri matches contract.md §0, build-fingerprinted",
  );
  // The bare URI is served (see the legacy-alias test) but must never be the
  // one advertised: advertising it is what pins a caching host to one build.
  assert(
    entry["uri"] !== REVIEW_CARD_LEGACY_RESOURCE_URI,
    "the advertised uri must carry a build fingerprint",
  );
  assertEquals(entry["mimeType"], MCP_APP_MIME_TYPE, "mimeType");

  // Phase 0 Q7.6: the mimeType is compared literally by the host — no space
  // after the semicolon, no charset parameter.
  assertEquals(entry["mimeType"], "text/html;profile=mcp-app", "exact mimeType string");

  // Phase 0 Q7.2: _meta.ui must appear on the listing entry as well as on the
  // read content, because hosts differ in which one they consult.
  assertEquals(entry["_meta"], EXPECTED_UI_META, "listing-level _meta.ui");

  assert(typeof entry["name"] === "string" && (entry["name"] as string).length > 0, "name present");
  assert(
    typeof entry["description"] === "string" && (entry["description"] as string).length > 0,
    "description present",
  );

  // The listing must never carry the document body — resources/read does that.
  assert(!("text" in entry), "listing entry must not inline the HTML body");
  assert(!("blob" in entry), "listing entry must not inline a blob");
});

Deno.test("every listed resource uses the ui:// scheme", () => {
  // Phase 0 Q7.5: the host's getToolUiResourceUri THROWS on a non-ui:// URI
  // rather than returning undefined, so one typo'd scheme takes down the whole
  // tool list, not just a single card.
  for (const entry of buildResourcesListResult().resources) {
    assert(
      typeof entry["uri"] === "string" && (entry["uri"] as string).startsWith("ui://"),
      `resource uri must use the ui:// scheme, got ${String(entry["uri"])}`,
    );
  }
});

// ---------------------------------------------------------------------------
// resources/read
// ---------------------------------------------------------------------------

Deno.test("resources/read returns exactly one content item for a known URI", () => {
  const result = buildResourceReadResult(REVIEW_CARD_RESOURCE_URI);

  assert(result !== null, "known URI must resolve");

  // Phase 0 Q7.6: the reference host throws "Unexpected contents count" on any
  // number of items other than one, which the user sees as a broken card.
  assertEquals(result!.contents.length, 1, "contents length");

  const content = result!.contents[0];
  assertEquals(content["uri"], REVIEW_CARD_RESOURCE_URI, "content uri");
  assertEquals(content["mimeType"], "text/html;profile=mcp-app", "content mimeType");
  assertEquals(content["_meta"], EXPECTED_UI_META, "content-level _meta.ui");

  const text = content["text"];
  assert(typeof text === "string" && text.length > 0, "content text present");
  assertEquals(text, REVIEW_CARD_HTML, "content text is the generated card module");
});

Deno.test("resources/read reports an unknown URI instead of throwing", () => {
  // The builder returns null rather than throwing; index.ts turns that into a
  // JSON-RPC -32002. An uncaught throw would become a 500 and the host would
  // report a dead connector rather than a missing resource.
  for (
    const uri of [
      "ui://mcpemails/does-not-exist.html",
      "ui://someone-else/review-card.html",
      "https://mcpemails.com/review-card.html",
      "file:///etc/passwd",
      "",
    ]
  ) {
    assertEquals(buildResourceReadResult(uri), null, `unknown uri rejected: ${uri}`);
  }
});

Deno.test("resources/read URI matching is exact, not a prefix or case-insensitive match", () => {
  assertEquals(
    buildResourceReadResult(REVIEW_CARD_RESOURCE_URI + "?v=2"),
    null,
    "query-suffixed uri must not resolve",
  );
  assertEquals(
    buildResourceReadResult(REVIEW_CARD_RESOURCE_URI.toUpperCase()),
    null,
    "upper-cased uri must not resolve",
  );
});

Deno.test("the advertised URI is fingerprinted with the bundle's build id", () => {
  // The whole point: a changed bundle must be a changed URI. Claude's host
  // caches the card by URI and keeps it across tool calls and reconnects
  // (CONCEPT-draft-editor.md §13), so a fixed URI means a card deploy reaches
  // nobody who is already connected.
  assert(
    /^[0-9a-f]{12}$/.test(REVIEW_CARD_BUILD_ID),
    `build id must be 12 lowercase hex, got ${REVIEW_CARD_BUILD_ID}`,
  );
  assert(
    REVIEW_CARD_RESOURCE_URI.includes(REVIEW_CARD_BUILD_ID),
    "the advertised uri must carry the build id",
  );
  assert(
    REVIEW_CARD_RESOURCE_URI.startsWith("ui://") &&
      REVIEW_CARD_RESOURCE_URI.endsWith(".html"),
    "still a ui:// URI ending in .html (Phase 0 Q7.5)",
  );
  // No query string: the fingerprint lives in the path so that a host which
  // normalises or strips query parameters cannot collapse two builds onto one
  // cache key.
  assert(!REVIEW_CARD_RESOURCE_URI.includes("?"), "fingerprint must not be a query parameter");
});

Deno.test("the build id is a content hash of the bundle actually served", () => {
  // Guards the one way this can silently rot: a codegen change that stops
  // deriving the id from the HTML would leave the URI stable across builds and
  // put us straight back into the cached-card bug, with tests still green.
  const digest = createHash("sha256").update(REVIEW_CARD_HTML, "utf8").digest("hex");
  assertEquals(
    REVIEW_CARD_BUILD_ID,
    digest.slice(0, 12),
    "build id must be the first 12 hex of sha256(bundle)",
  );
});

Deno.test("resources/read still answers the pre-fingerprint URI with today's card", () => {
  // A client holding a tools/list from before 2026-09-16 asks for the bare
  // name. Answering -32002 would render as a broken cell for as long as it
  // holds that listing; today's card is always the better answer.
  const result = buildResourceReadResult(REVIEW_CARD_LEGACY_RESOURCE_URI);

  assert(result !== null, "legacy URI must resolve");
  assertEquals(result!.contents.length, 1, "contents length");
  assertEquals(result!.contents[0]["text"], REVIEW_CARD_HTML, "serves the CURRENT bundle");
  assertEquals(result!.contents[0]["_meta"], EXPECTED_UI_META, "content-level _meta.ui");

  // The response echoes the URI that was asked for, not the catalogue's: a host
  // matches content against its own request and cache key.
  assertEquals(
    result!.contents[0]["uri"],
    REVIEW_CARD_LEGACY_RESOURCE_URI,
    "echoes the requested uri",
  );
});

Deno.test("the legacy URI is served but never advertised", () => {
  // Nothing new may acquire it: no listing entry and no tool points at it, so
  // it can only ever answer a client that already had it.
  for (const entry of buildResourcesListResult().resources) {
    assert(
      entry["uri"] !== REVIEW_CARD_LEGACY_RESOURCE_URI,
      "resources/list must not advertise the legacy uri",
    );
  }
  assert(
    reviewCardToolMeta().ui.resourceUri !== REVIEW_CARD_LEGACY_RESOURCE_URI,
    "tool _meta must not point at the legacy uri",
  );
  assert(
    appOnlyReviewCardToolMeta().ui.resourceUri !== REVIEW_CARD_LEGACY_RESOURCE_URI,
    "app-only tool _meta must not point at the legacy uri",
  );
});

Deno.test("resources/templates/list is an empty array", () => {
  // Implemented purely so AppBridge's proxied call does not log a -32601;
  // our URIs are concrete, never parameterised.
  assertEquals(buildResourceTemplatesListResult(), { resourceTemplates: [] }, "templates");
});

Deno.test("ui _meta is a fresh object per call so responses cannot alias state", () => {
  const first = mcpAppUiMeta();
  const second = mcpAppUiMeta();
  assert(first !== second, "meta objects must not be shared");
  first.ui.csp.connectDomains.push("https://evil.example");
  assertEquals(second.ui.csp.connectDomains, [], "mutation must not leak into later responses");
});

// ---------------------------------------------------------------------------
// tools/list _meta
// ---------------------------------------------------------------------------

Deno.test("review-card _meta targets the contract URI and omits visibility", () => {
  assertEquals(
    reviewCardToolMeta(),
    { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI } },
    "tool _meta",
  );

  const serialized = JSON.stringify(reviewCardToolMeta());

  // Phase 0 Q7.4: emit only the nested key. The deprecated flat
  // `_meta["ui/resourceUri"]` is documented for removal before GA.
  assert(!serialized.includes("ui/resourceUri"), "must not emit the deprecated flat key");

  // The mail tools are meant to be model-callable, so they carry no
  // `visibility` at all (its absence means ["model","app"]).
  assert(!serialized.includes("visibility"), "mail tools must not restrict visibility");
});

Deno.test("the approval tools advertise app-only visibility, as a hint and nothing more", () => {
  // Phase 2 introduces the first app-only tools (approval_review,
  // approval_decide, approval_update, approval_schedule) and, with them, the
  // first deliberate use of `visibility`.
  //
  // It is emitted so that a host implementing the reference filter
  // (`visibility.includes("model")`) keeps these out of the model's tool
  // picker. That is the entire benefit: tidiness.
  //
  // Phase 0 Q2 stands unchanged — `visibility` is NOT an authorisation
  // boundary. The server cannot distinguish an app-originated tools/call from a
  // model-originated one, the SDK never enforces the field, and a plain SDK
  // client called an ["app"]-only tool successfully. The approval handlers are
  // therefore written for a hostile caller, and the one irreversible action,
  // approving a send, is not exposed over MCP at all. If you are tempted to
  // relax something because "only the card can call it", re-read
  // docs/mcp-apps/contract.md §6 first.
  assertEquals(
    appOnlyReviewCardToolMeta(),
    { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI, visibility: ["app"] } },
    "app-only tool _meta",
  );

  // Same card, same URI: the difference is the hint, not the resource.
  assertEquals(
    appOnlyReviewCardToolMeta().ui.resourceUri,
    reviewCardToolMeta().ui.resourceUri,
    "both metas point at the one card",
  );

  const first = appOnlyReviewCardToolMeta();
  first.ui.visibility.push("model");
  assertEquals(
    appOnlyReviewCardToolMeta().ui.visibility,
    ["app"],
    "meta must be fresh per call, not shared state",
  );
});

Deno.test("only the two outbound tools are outbound-card-bearing", () => {
  // `draft` LEFT this list on 2026-09-16 (contract §8). It is card-bearing on
  // five more paths than a held send — every create, reply, update, send and
  // delete carries an envelope once the workspace has the draft editor — so
  // gating it on `send_approval_required` would have withheld the card from
  // exactly the results the editor exists to show. It is gated by
  // DRAFT_EDITOR_CARD_TOOL_NAMES instead. `email_compose` and `schedule` have
  // no second card and stay where they were.
  assertEquals(
    [...REVIEW_CARD_TOOL_NAMES].sort(),
    ["email_compose", "schedule"],
    "outbound card-bearing tool names",
  );
  assertEquals(
    [...DRAFT_EDITOR_CARD_TOOL_NAMES].sort(),
    ["draft"],
    "draft-editor card-bearing tool names",
  );
  // `email_search_and_move` is the third since 2026-09-09: the same handler as
  // `email_organize{action:"search_and_move"}`, advertised under its own name,
  // and this list is keyed by the name a client CALLS. Omitting it would hand a
  // plan-mode inbox a bulk_plan envelope from a tool the host was never told to
  // mount the card for.
  assertEquals(
    [...BULK_PLAN_CARD_TOOL_NAMES].sort(),
    ["email_delete", "email_organize", "email_search_and_move"],
    "bulk card-bearing tool names",
  );

  // The two lists are disjoint: a tool is gated by exactly one opt-in, never
  // by both, so reviewCardMetaForListing's first-match-wins order is not load
  // bearing and cannot silently start mattering.
  for (const name of BULK_PLAN_CARD_TOOL_NAMES) {
    assert(!REVIEW_CARD_TOOL_NAMES.includes(name), `${name} must be gated by exactly one opt-in`);
    assert(!DRAFT_EDITOR_CARD_TOOL_NAMES.includes(name), `${name} must be gated by exactly one opt-in`);
  }
  for (const name of DRAFT_EDITOR_CARD_TOOL_NAMES) {
    assert(!REVIEW_CARD_TOOL_NAMES.includes(name), `${name} must be gated by exactly one opt-in`);
  }

  // Read-only tools advertise no card under any gate.
  for (const name of ["inbox_list", "email_read", "folder", "signature", "contact_search"]) {
    assert(!REVIEW_CARD_TOOL_NAMES.includes(name), `${name} must not be outbound card-bearing`);
    assert(!BULK_PLAN_CARD_TOOL_NAMES.includes(name), `${name} must not be bulk card-bearing`);
    assert(!DRAFT_EDITOR_CARD_TOOL_NAMES.includes(name), `${name} must not be draft card-bearing`);
  }
});

// ---------------------------------------------------------------------------
// tools/list gating
//
// The bug these cover: `_meta.ui` is per-tool, not per-call, so a host mounts
// and renders the card for EVERY result of a tool that advertises one. The
// outbound tools were stamped unconditionally at module load, but they only
// ever produce a reviewable payload when the send is held for a human — and
// send_approval_required is set on 3 of 204 production inboxes. So ~99% of
// sends got a card with nothing to show: the stuck loading skeleton.
// ---------------------------------------------------------------------------

const NO_GATES = { outbound: false, bulk: false, drafts: false };
const ALL_GATES = { outbound: true, bulk: true, drafts: true };

Deno.test("a card-bearing tool gets no _meta when its gate is closed", () => {
  for (const name of REVIEW_CARD_TOOL_NAMES) {
    assertEquals(reviewCardMetaForListing(name, NO_GATES), undefined, `${name} ungated`);
    // The bulk opt-in must not open the outbound gate, or an inbox that
    // previews deletes would start mounting empty cards under every send.
    assertEquals(
      reviewCardMetaForListing(name, { outbound: false, bulk: true, drafts: true }),
      undefined,
      `${name} must not be opened by the bulk or draft opt-in`,
    );
  }
  for (const name of BULK_PLAN_CARD_TOOL_NAMES) {
    assertEquals(reviewCardMetaForListing(name, NO_GATES), undefined, `${name} ungated`);
    assertEquals(
      reviewCardMetaForListing(name, { outbound: true, bulk: false, drafts: true }),
      undefined,
      `${name} must not be opened by the send-approval or draft opt-in`,
    );
  }
  // The draft editor is a WORKSPACE flag and the other two are per-inbox
  // opt-ins, so a workspace that holds sends must not thereby get the editor.
  for (const name of DRAFT_EDITOR_CARD_TOOL_NAMES) {
    assertEquals(reviewCardMetaForListing(name, NO_GATES), undefined, `${name} ungated`);
    assertEquals(
      reviewCardMetaForListing(name, { outbound: true, bulk: true, drafts: false }),
      undefined,
      `${name} must not be opened by either inbox opt-in`,
    );
    assertEquals(
      reviewCardMetaForListing(name, { outbound: false, bulk: false, drafts: true }),
      { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI } },
      `${name} is opened by the draft-editor flag alone`,
    );
  }
});

Deno.test("a card-bearing tool gets the exact nested _meta.ui.resourceUri when gated in", () => {
  for (
    const name of [
      ...REVIEW_CARD_TOOL_NAMES,
      ...BULK_PLAN_CARD_TOOL_NAMES,
      ...DRAFT_EDITOR_CARD_TOOL_NAMES,
    ]
  ) {
    assertEquals(
      reviewCardMetaForListing(name, ALL_GATES),
      { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI } },
      `${name} gated in`,
    );
  }

  // Phase 0 Q7.4: the nested key only, never the deprecated flat one, and no
  // `visibility` — the mail tools are meant to be model-callable.
  const serialized = JSON.stringify(reviewCardMetaForListing("email_compose", ALL_GATES));
  assert(!serialized.includes("ui/resourceUri"), "must not emit the deprecated flat key");
  assert(!serialized.includes("visibility"), "mail tools must not restrict visibility");
});

Deno.test("the draft editor's app-only tools are gated by the SAME flag", () => {
  // The WS-2 fix. `draft_read` / `draft_editor_save` / `draft_editor_hide` were
  // stamped with appOnlyReviewCardToolMeta() in the registry unconditionally,
  // on the argument that an app-only tool always returns an envelope. That is
  // true of approval_* and bulk_*, and false of these three: they are the only
  // app-only tools with a user-facing OFF switch. Measured 2026-09-16 with the
  // demo inbox hidden, `draft` correctly dropped its `_meta.ui` while all three
  // of these kept theirs, so the host kept mounting the editor for an inbox the
  // user had switched off.
  for (const name of DRAFT_EDITOR_APP_TOOL_NAMES) {
    assertEquals(reviewCardMetaForListing(name, NO_GATES), undefined, `${name} ungated`);
    assertEquals(
      reviewCardMetaForListing(name, { outbound: true, bulk: true, drafts: false }),
      undefined,
      `${name} must not be opened by either inbox opt-in`,
    );
    // Gated in, they carry `visibility: ["app"]` on top of the resource URI —
    // the difference from `draft`, which is model-callable and must not.
    assertEquals(
      reviewCardMetaForListing(name, { outbound: false, bulk: false, drafts: true }),
      { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI, visibility: ["app"] } },
      `${name} is opened by the draft-editor flag alone`,
    );
  }
  // They are NOT the same list as the model-facing `draft`: same gate,
  // different metadata shape.
  for (const name of DRAFT_EDITOR_APP_TOOL_NAMES) {
    assert(
      !DRAFT_EDITOR_CARD_TOOL_NAMES.includes(name),
      `${name} must not also be in the model-facing list`,
    );
  }
});

Deno.test("a non-card tool gets no _meta under any combination of gates", () => {
  // Includes the OTHER app-only tools: approval_* and bulk_* carry
  // appOnlyReviewCardToolMeta() from the registry unconditionally and must be
  // passed through untouched, so this helper returning undefined for them is
  // what preserves their metadata. The draft-editor three are deliberately
  // absent from this list — see the test above; they are no longer stamped in
  // the registry and get their metadata from here instead.
  for (
    const name of [
      "inbox_list",
      "email_read",
      "folder",
      "draft_unknown",
      "draft_editor",
      "draft_editor_saved",
      "signature",
      "automation",
      "contact_search",
      "approval_review",
      "approval_decide",
      "approval_update",
      "approval_schedule",
      "bulk_execute",
      "bulk_cancel",
      "",
    ]
  ) {
    for (
      const gates of [
        NO_GATES,
        ALL_GATES,
        { outbound: true, bulk: false, drafts: false },
        { outbound: false, bulk: true, drafts: false },
        { outbound: false, bulk: false, drafts: true },
      ]
    ) {
      assertEquals(
        reviewCardMetaForListing(name, gates),
        undefined,
        `${name || "(empty)"} must never be given card _meta`,
      );
    }
  }
});

Deno.test("gating is by exact name, never a prefix or case-insensitive match", () => {
  for (
    const name of [
      "Email_Compose",
      "email_compose ",
      "email_compose_v2",
      "draftx",
      "Draft",
      "draft ",
      "schedul",
    ]
  ) {
    assertEquals(reviewCardMetaForListing(name, ALL_GATES), undefined, `${name} must not match`);
  }
});

Deno.test("gated _meta is a fresh object per call so responses cannot alias state", () => {
  const first = reviewCardMetaForListing("email_compose", ALL_GATES)!;
  const second = reviewCardMetaForListing("email_compose", ALL_GATES)!;
  assert(first !== second, "meta objects must not be shared");
  first.ui.resourceUri = "ui://evil/card.html";
  assertEquals(second.ui.resourceUri, REVIEW_CARD_RESOURCE_URI, "mutation must not leak");
});

Deno.test("an ungated card-bearing tool serialises byte-identically to pre-MCP-Apps", () => {
  // The standard the bulk gate held itself to, now extended to the outbound
  // tools: a key with no approval-required inbox must see exactly the JSON it
  // saw before MCP Apps existed. Compare the two serialisations as strings, so
  // a stray `_meta: undefined` or a reordered key would fail.
  const registryEntry = {
    name: "email_compose",
    title: "Compose email",
    description: "Send, reply, or forward.",
    inputSchema: { type: "object", properties: {}, required: ["action"] },
    annotations: { title: "Compose email", readOnlyHint: false },
  };

  const meta = reviewCardMetaForListing(registryEntry.name, NO_GATES);
  const listed = serializeToolForList(meta ? { ...registryEntry, _meta: meta } : registryEntry);

  assertEquals(
    JSON.stringify(listed),
    JSON.stringify({
      name: "email_compose",
      title: "Compose email",
      description: "Send, reply, or forward.",
      inputSchema: { type: "object", properties: {}, required: ["action"] },
      annotations: { title: "Compose email", readOnlyHint: false },
    }),
    "ungated email_compose wire bytes",
  );
  assert(!("_meta" in listed), "_meta key omitted, not undefined");

  // And with the gate open it gains exactly one key, changing nothing else.
  const gatedMeta = reviewCardMetaForListing(registryEntry.name, ALL_GATES);
  const gated = serializeToolForList({ ...registryEntry, _meta: gatedMeta! });
  assertEquals(
    JSON.stringify(gated),
    JSON.stringify({
      name: "email_compose",
      title: "Compose email",
      description: "Send, reply, or forward.",
      inputSchema: { type: "object", properties: {}, required: ["action"] },
      annotations: { title: "Compose email", readOnlyHint: false },
      _meta: { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI } },
    }),
    "gated email_compose wire bytes",
  );
});

Deno.test("a non-card tool is byte-identical to its pre-MCP-Apps JSON", () => {
  const inboxList = {
    name: "inbox_list",
    title: "List inboxes",
    description: "List the accessible inboxes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List inboxes", readOnlyHint: true, openWorldHint: true },
  };

  for (const gates of [NO_GATES, ALL_GATES]) {
    const meta = reviewCardMetaForListing(inboxList.name, gates);
    const listed = serializeToolForList(meta ? { ...inboxList, _meta: meta } : inboxList);
    assertEquals(
      JSON.stringify(listed),
      JSON.stringify(inboxList),
      "inbox_list wire bytes are untouched by MCP Apps",
    );
  }
});

Deno.test("tools/list emits _meta when present and is byte-identical without it", () => {
  const base = {
    name: "email_compose",
    title: "Compose email",
    description: "Send, reply, or forward.",
    inputSchema: { type: "object", properties: {} },
  };

  // A tool without _meta must serialize exactly as it did before MCP Apps.
  assertEquals(
    serializeToolForList(base),
    {
      name: "email_compose",
      title: "Compose email",
      description: "Send, reply, or forward.",
      inputSchema: { type: "object", properties: {} },
    },
    "tool without optional fields",
  );
  assert(!("_meta" in serializeToolForList(base)), "_meta key omitted, not undefined");
  assert(!("outputSchema" in serializeToolForList(base)), "outputSchema key omitted");
  assert(!("annotations" in serializeToolForList(base)), "annotations key omitted");

  // With _meta attached, it appears verbatim.
  const withMeta = serializeToolForList({ ...base, _meta: reviewCardToolMeta() });
  assertEquals(
    withMeta["_meta"],
    { ui: { resourceUri: REVIEW_CARD_RESOURCE_URI } },
    "emitted tool _meta",
  );

  // Optional fields round-trip alongside it.
  const full = serializeToolForList({
    ...base,
    outputSchema: { type: "object" },
    annotations: { destructiveHint: true },
    _meta: reviewCardToolMeta(),
  });
  assertEquals(full["outputSchema"], { type: "object" }, "outputSchema round-trip");
  assertEquals(full["annotations"], { destructiveHint: true }, "annotations round-trip");
});

Deno.test("tools/list advertises a consolidated tool without its allOf rules and keeps them for the validator", () => {
  // The shape buildConsolidatedTool emits. The registry entry is what
  // tools/call validates against, so stripping must happen on the way out,
  // not in place.
  const rules = [
    {
      if: { properties: { action: { const: "list" } }, required: ["action"] },
      then: { not: { anyOf: [{ required: ["message_id"] }] } },
    },
    {
      if: { properties: { action: { const: "read" } }, required: ["action"] },
      then: { required: ["message_id"] },
    },
  ];
  const registryEntry = {
    name: "email_read",
    title: "Read Email",
    description: "Read, list and search email.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read"], description: "Operation to run. Required: read: message_id." },
        message_id: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
      allOf: rules,
    },
    outputSchema: { type: "object", additionalProperties: true },
  };

  const listed = serializeToolForList(registryEntry);
  assertEquals(
    JSON.stringify(listed),
    JSON.stringify({
      name: "email_read",
      title: "Read Email",
      description: "Read, list and search email.",
      inputSchema: {
        type: "object",
        properties: registryEntry.inputSchema.properties,
        required: ["action"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
    }),
    "advertised wire bytes: full schema minus allOf, outputSchema kept",
  );
  assert(!("allOf" in (listed["inputSchema"] as Record<string, unknown>)), "allOf is not advertised");
  assert(registryEntry.inputSchema.allOf === rules, "the registry entry still carries its rules");
  assertEquals(registryEntry.inputSchema.allOf.length, 2, "all of them");
});

// ---------------------------------------------------------------------------
// Client capability observation
// ---------------------------------------------------------------------------

Deno.test("UI extension detection is a positive-only signal", () => {
  // Phase 0 Q1: the official ext-apps reference host sends exactly this — an
  // empty capabilities object with no `extensions` key — and MCP Apps still
  // works end to end. So `false` here means "unknown", never "unsupported",
  // and nothing in the server may branch on it.
  assertEquals(clientSupportsUiExtension({}), false, "reference host shape");
  assertEquals(clientSupportsUiExtension(undefined), false, "absent capabilities");
  assertEquals(clientSupportsUiExtension({ extensions: {} }), false, "extensions without the UI key");
  assertEquals(clientSupportsUiExtension({ extensions: null }), false, "null extensions");
  assertEquals(
    clientSupportsUiExtension({ extensions: ["io.modelcontextprotocol/ui"] }),
    false,
    "array extensions must not count",
  );
  assertEquals(
    clientSupportsUiExtension({
      extensions: {
        "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
      },
    }),
    true,
    "explicit declaration",
  );
});

// ---------------------------------------------------------------------------
// The served document
// ---------------------------------------------------------------------------

Deno.test("the review card is a small, self-contained HTML5 document", () => {
  assert(REVIEW_CARD_HTML.startsWith("<!DOCTYPE html>"), "must be an HTML5 document");
  assert(REVIEW_CARD_HTML.includes("</html>"), "must be a complete document");

  // Phase 0 Q3/Q4: this is re-transferred out of the edge function on every
  // tool call with no caching anywhere, so size is a per-call egress cost.
  // The real card (Preact + the postMessage shim) is ~52 KB raw / ~17 KB
  // gzipped. This ceiling matches the hard gate in apps/mcp-app/scripts/
  // codegen.mjs, which exits non-zero above it — if you are raising one, raise
  // both, and re-read Q3 first.
  assert(
    REVIEW_CARD_HTML.length < 150_000,
    `review card is ${REVIEW_CARD_HTML.length} bytes; budget is 150 KB raw`,
  );

  // The published CSP is empty on every axis, so any subresource request would
  // simply be blocked by the host and the card would render broken.
  //
  // Match *subresource references* specifically, not the substring "http://".
  // A bare-substring check cannot survive a real bundle: Preact ships the XML
  // namespace constants ("http://www.w3.org/2000/svg") as ordinary strings, and
  // the card legitimately carries the dashboard origin for ui/open-link.
  // Neither is a fetch. Assert on the shapes that actually cause one.
  const subresourcePatterns: [RegExp, string][] = [
    [/<script[^>]+\bsrc\s*=/i, "<script src=…>"],
    [/<link[^>]+\bhref\s*=\s*["']?(?:https?:)?\/\//i, "<link href=…> to an external origin"],
    [/<(?:img|iframe|object|embed|video|audio|source)[^>]+\bsrc\s*=\s*["']?(?:https?:)?\/\//i,
      "external media subresource"],
    [/@import\s+(?:url\s*\(|["'])/i, "@import"],
    [/\burl\s*\(\s*["']?(?:https?:)?\/\//i, "CSS url() to an external origin"],
  ];
  for (const [pattern, label] of subresourcePatterns) {
    assert(
      !pattern.test(REVIEW_CARD_HTML),
      `card must not reference external resources (found ${label})`,
    );
  }
});

// ---------------------------------------------------------------------------
// The listing path, against the REAL registry
//
// ── Why this section exists ────────────────────────────────────────────────
// Everything above tests `reviewCardMetaForListing`, which is pure and was
// always correct. The headline fix lived somewhere else: in the COMPOSITION
// `handleToolsList` performs over the registry. Re-adding the module-load stamp
// the fix removed —
//
//     TOOL_REGISTRY.push({ ...definition, _meta: appOnlyReviewCardToolMeta() });
//
// — reinstates the original bug verbatim, because `withListingCardMeta` maps
// `undefined` to "leave the entry alone" and a registry `_meta` therefore
// SURVIVES being gated out. Verified 2026-09-16: with that line back, the whole
// suite still passed 1171/1171. The gap was that nothing ever looked at the
// registry's `_meta` at all — `reviewCardMetaForListing` was tested as a pure
// function, and `tools-list-visibility.test.ts` and `tool-surface.test.ts` both
// import TOOL_REGISTRY without mentioning `_meta`.
//
// So these run the real mapping over the real registry. index.ts builds it at
// module load and reads the environment while doing so, hence the two env vars
// before the import — the same note as tool-surface.test.ts.
// ---------------------------------------------------------------------------

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { TOOL_REGISTRY, handleRequest } = await import("./index.ts");

/** The names the real listing path leaves carrying `_meta` under these gates. */
function listedWithMeta(gates: {
  outbound: boolean;
  bulk: boolean;
  drafts: boolean;
}): string[] {
  return withListingCardMeta(TOOL_REGISTRY, gates)
    .filter((tool) => tool._meta !== undefined)
    .map((tool) => tool.name);
}

Deno.test("no draft-editor tool carries _meta through the listing when its gate is shut", () => {
  const carried = listedWithMeta(NO_GATES);
  for (const name of [...DRAFT_EDITOR_CARD_TOOL_NAMES, ...DRAFT_EDITOR_APP_TOOL_NAMES]) {
    assert(
      !carried.includes(name),
      `${name} must carry NO _meta when the draft-editor gate is shut — ` +
        "a module-load TOOL_REGISTRY.push({..., _meta}) is the regression this catches",
    );
  }
  // ...and the serialized wire object must not even have the key, so a key that
  // is not gated in gets byte-identical JSON to life before MCP Apps.
  for (const tool of withListingCardMeta(TOOL_REGISTRY, NO_GATES)) {
    if (!DRAFT_EDITOR_APP_TOOL_NAMES.includes(tool.name)) continue;
    assert(
      !("_meta" in serializeToolForList(tool)),
      `${tool.name} must serialise without a _meta key at all`,
    );
  }
});

Deno.test("with every gate shut, the only tools left carrying _meta are approval_* and bulk_*", () => {
  // The general form, so this keeps catching the same regression for a
  // card-bearing tool that does not exist yet. Those two families are stamped at
  // module load on purpose (index.ts:7611 and :7632): they are app-only
  // affordances with no user-facing off switch that always return an envelope,
  // so there is no result shape for the card to fail on and nothing to gate.
  const stamped = listedWithMeta(NO_GATES);
  for (const name of stamped) {
    assert(
      name.startsWith("approval_") || name.startsWith("bulk_"),
      `${name} carries _meta with every gate shut — it must be gated, not stamped`,
    );
  }
  // Both families really are there: an assertion over an empty set proves
  // nothing, and a "fix" that stripped them rather than leaving them alone
  // would be a different regression.
  assert(stamped.some((n) => n.startsWith("approval_")), "approval_* keep their _meta");
  assert(stamped.some((n) => n.startsWith("bulk_")), "bulk_* keep their _meta");
});

Deno.test("the drafts gate opens all four draft-editor tools, and nothing else", () => {
  const carried = listedWithMeta({ outbound: false, bulk: false, drafts: true });
  for (const name of [...DRAFT_EDITOR_CARD_TOOL_NAMES, ...DRAFT_EDITOR_APP_TOOL_NAMES]) {
    assert(carried.includes(name), `${name} must be listed with _meta when gated in`);
  }
  for (const name of [...REVIEW_CARD_TOOL_NAMES, ...BULK_PLAN_CARD_TOOL_NAMES]) {
    if (DRAFT_EDITOR_CARD_TOOL_NAMES.includes(name)) continue;
    assert(!carried.includes(name), `${name} must stay shut behind its own gate`);
  }

  // And the shapes: the app-only three add `visibility: ["app"]`; `draft` does
  // not, because it is model-callable.
  const byName = new Map(
    withListingCardMeta(TOOL_REGISTRY, { outbound: false, bulk: false, drafts: true })
      .map((tool) => [tool.name, tool] as const),
  );
  for (const name of DRAFT_EDITOR_APP_TOOL_NAMES) {
    assertEquals(byName.get(name)?._meta, appOnlyReviewCardToolMeta(), name);
  }
  assertEquals(byName.get("draft")?._meta, reviewCardToolMeta(), "draft is model-callable");
});

Deno.test("every draft-editor tool is card-bearing for the staleness check", () => {
  // `isCardBearingToolName` decides whether a `tools/call` may carry
  // notifications/tools/list_changed. All four listings above can hold a
  // build-fingerprinted card URI, and the card itself calls `draft_read` before
  // it calls anything else — so a client whose next call after a card deploy was
  // `draft_read` got no notification at all and went on holding the previous
  // bundle's URI. NOTE for whoever owns card-build-notify.ts: this widens what
  // reaches `decideBuildNotification`.
  for (
    const name of [
      ...REVIEW_CARD_TOOL_NAMES,
      ...BULK_PLAN_CARD_TOOL_NAMES,
      ...DRAFT_EDITOR_CARD_TOOL_NAMES,
      ...DRAFT_EDITOR_APP_TOOL_NAMES,
    ]
  ) {
    assert(isCardBearingToolName(name), `${name} can hold a stale card URI`);
  }
  for (const name of ["inbox_list", "email_read", "ping", "draft_update", ""]) {
    assert(!isCardBearingToolName(name), `${name} cannot`);
  }
});

// ---------------------------------------------------------------------------
// THE WIRE, not the call site — the outermost boundary this suite can reach
//
// ── Why this section keeps getting rewritten ───────────────────────────────
// `_meta.ui` on a tool nobody opted into has now been re-introduced THREE
// times by adversarial review, each time ONE LAYER further out than the test
// that had just been written to stop it:
//
//   1. `TOOL_REGISTRY.push({ ...definition, _meta: appOnlyReviewCardToolMeta() })`
//      at module load. It survives the gate because `withListingCardMeta` maps
//      "this tool gets no metadata" to "leave the entry alone", so a registry
//      `_meta` is passed through untouched. Green at 1171/1171, because
//      nothing looked at the registry's `_meta` at all.
//      → closed by running the real composition over the real registry.
//   2. a `.map()` inside `handleToolsList`'s own chain, between
//      `withListingCardMeta` and `serializeToolForList`. Green at 1187/1187.
//      → closed by running the real `handleToolsList`.
//   3. a `.map()` inside `routeMethod`, over the result `handleToolsList` had
//      just returned:
//
//          case "tools/list": {
//            const listed = await handleToolsList(req, id, apiKey);
//            const r = listed.result as { tools: Array<Record<string, unknown>> };
//            r.tools = r.tools.map((tool) =>
//              ["draft_read", "draft_editor_save", "draft_editor_hide"]
//                  .includes(tool.name as string)
//                ? { ...tool, _meta: appOnlyReviewCardToolMeta() } : tool);
//            return listed;
//          }
//
//      Green at 1204/1204, with the original bug back on the wire.
//
// The pattern is the point, and it is not a coincidence: every one of those
// tests asserted on a value that some INNER function returned, and a caller
// one level out can always post-process that value. `routeMethod` is not the
// last such layer either — `handleRequest` post-processing `routeMethod`'s
// response would evade a pin on `routeMethod` in exactly the same way.
//
// So these assert on the HTTP response `handleRequest` produces: the real
// transport entry point, the real router, the real handler, the real gates,
// and the actual serialised JSON-RPC bytes a client receives. There is no
// enclosing layer left to add a step to. A stamp anywhere inside — registry,
// `toolsForListing`, `withListingCardMeta`, `serializeToolForList`,
// `handleToolsList`, `routeMethod`, `handleRequest` itself — shows up here.
//
// `MCP_INTROSPECTION_ONLY` is what makes driving the real entry point possible
// with no database and no API key: `handleRequest` routes the introspectable
// methods with a synthetic full-scope key (all 26 tools are listed, both card
// families included), and `keyReviewCardGates` returns every gate shut without
// issuing a query. Every gate shut is precisely the state in which advertising
// `_meta.ui` is the defect, so this is not a weaker test than an integration
// one — it is the case that matters, driven end to end.
// ---------------------------------------------------------------------------

/** The bytes a client gets back from one JSON-RPC method, over the real entry point. */
async function wireResponse(method: string): Promise<Record<string, unknown>> {
  const response = await handleRequest(
    new Request("https://mcp.example.test/mcp-server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method }),
    }),
  );
  assertEquals(response.status, 200, `${method} must answer 200`);
  // Parsed from the response body rather than read off a returned object, so
  // anything that is not JSON-serialisable never reaches these assertions
  // looking healthy.
  const body = JSON.parse(await response.text()) as Record<string, unknown>;
  assertEquals(body.jsonrpc, "2.0", "a JSON-RPC 2.0 envelope");
  assertEquals(body.id, 7, "the response is the one we asked for");
  assert(!("error" in body), `${method} failed: ${JSON.stringify(body.error)}`);
  return body;
}

/** The tools `tools/list` actually advertises, exactly as sent. */
async function realToolsListResponse(): Promise<Array<Record<string, unknown>>> {
  const body = await wireResponse("tools/list");
  const result = body.result as { tools: Array<Record<string, unknown>> };
  return result.tools;
}

Deno.test("the tools/list on the wire advertises no card metadata when every gate is shut", async () => {
  // THE GENERAL FORM, and the durable one: it keeps catching this for a
  // card-bearing tool that does not exist yet. `approval_*` and `bulk_*` are
  // stamped at module load on purpose (index.ts:7611 and :7632) — app-only
  // affordances with no user-facing off switch that always return an envelope,
  // so there is no result shape for the card to fail on and nothing to gate.
  const tools = await realToolsListResponse();
  assert(tools.length > 0, "introspection mode still lists tools");

  const stamped = tools.filter((tool) => "_meta" in tool).map((tool) => tool.name as string);
  for (const name of stamped) {
    assert(
      name.startsWith("approval_") || name.startsWith("bulk_"),
      `${name} reaches the wire carrying _meta with every gate shut — ` +
        "it must be gated, not stamped",
    );
  }
  // Both families really are there. An assertion over an empty set proves
  // nothing, and a "fix" that stripped them rather than leaving them alone
  // would be a different regression.
  assert(stamped.some((n) => n.startsWith("approval_")), "approval_* keep their _meta");
  assert(stamped.some((n) => n.startsWith("bulk_")), "bulk_* keep their _meta");
});

Deno.test("no draft-editor tool reaches the wire with _meta, named one by one", async () => {
  // The general form above is the durable one; this names the four so a failure
  // says which tool, and so the assertion is not vacuous if the listing ever
  // stops including them.
  const tools = await realToolsListResponse();
  const byName = new Map(tools.map((tool) => [tool.name as string, tool]));
  for (const name of [...DRAFT_EDITOR_CARD_TOOL_NAMES, ...DRAFT_EDITOR_APP_TOOL_NAMES]) {
    const tool = byName.get(name);
    assert(tool !== undefined, `${name} is listed to a full-scope key`);
    assert(!("_meta" in tool!), `${name} must reach the wire with no _meta key at all`);
  }
  // `draft` is model-visible and always listed, so this half is never vacuous.
  assert(byName.has("draft"), "draft is always listed");
  assert(!("_meta" in byName.get("draft")!), "draft must carry no _meta");
});

Deno.test("the listing on the wire still goes through serializeToolForList", async () => {
  // The other direction: a call site that stopped serialising would put the
  // registry's internal fields (`listedInputSchema`, the action-specific `allOf`
  // rules) on the wire. Byte-compatibility with life before MCP Apps is the
  // whole claim, so it is asserted rather than assumed.
  const tools = await realToolsListResponse();
  const allowed = new Set([
    "name",
    "title",
    "description",
    "inputSchema",
    "outputSchema",
    "annotations",
    "_meta",
  ]);
  for (const tool of tools) {
    for (const key of Object.keys(tool)) {
      assert(allowed.has(key), `${tool.name} leaks ${key} onto the tools/list wire`);
    }
  }
});

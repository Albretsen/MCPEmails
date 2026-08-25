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
  MCP_APP_MIME_TYPE,
  mcpAppUiMeta,
  RESOURCES_CAPABILITY,
  reviewCardMetaForListing,
  reviewCardToolMeta,
  REVIEW_CARD_RESOURCE_URI,
  REVIEW_CARD_TOOL_NAMES,
  serializeToolForList,
} from "./mcp-app-resources.ts";
import { REVIEW_CARD_HTML } from "./ui/review-card.html.ts";

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
  assertEquals(entry["uri"], "ui://mcpemails/review-card.html", "uri matches contract.md §0");
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
    { ui: { resourceUri: "ui://mcpemails/review-card.html" } },
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
    { ui: { resourceUri: "ui://mcpemails/review-card.html", visibility: ["app"] } },
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

Deno.test("only the three outbound tools are outbound-card-bearing", () => {
  assertEquals(
    [...REVIEW_CARD_TOOL_NAMES].sort(),
    ["draft", "email_compose", "schedule"],
    "outbound card-bearing tool names",
  );
  assertEquals(
    [...BULK_PLAN_CARD_TOOL_NAMES].sort(),
    ["email_delete", "email_organize"],
    "bulk card-bearing tool names",
  );

  // The two lists are disjoint: a tool is gated by exactly one opt-in, never
  // by both, so reviewCardMetaForListing's first-match-wins order is not load
  // bearing and cannot silently start mattering.
  for (const name of BULK_PLAN_CARD_TOOL_NAMES) {
    assert(!REVIEW_CARD_TOOL_NAMES.includes(name), `${name} must be gated by exactly one opt-in`);
  }

  // Read-only tools advertise no card under any gate.
  for (const name of ["inbox_list", "email_read", "folder", "signature", "contact_search"]) {
    assert(!REVIEW_CARD_TOOL_NAMES.includes(name), `${name} must not be outbound card-bearing`);
    assert(!BULK_PLAN_CARD_TOOL_NAMES.includes(name), `${name} must not be bulk card-bearing`);
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

const NO_GATES = { outbound: false, bulk: false };
const ALL_GATES = { outbound: true, bulk: true };

Deno.test("a card-bearing tool gets no _meta when its gate is closed", () => {
  for (const name of REVIEW_CARD_TOOL_NAMES) {
    assertEquals(reviewCardMetaForListing(name, NO_GATES), undefined, `${name} ungated`);
    // The bulk opt-in must not open the outbound gate, or an inbox that
    // previews deletes would start mounting empty cards under every send.
    assertEquals(
      reviewCardMetaForListing(name, { outbound: false, bulk: true }),
      undefined,
      `${name} must not be opened by the bulk opt-in`,
    );
  }
  for (const name of BULK_PLAN_CARD_TOOL_NAMES) {
    assertEquals(reviewCardMetaForListing(name, NO_GATES), undefined, `${name} ungated`);
    assertEquals(
      reviewCardMetaForListing(name, { outbound: true, bulk: false }),
      undefined,
      `${name} must not be opened by the send-approval opt-in`,
    );
  }
});

Deno.test("a card-bearing tool gets the exact nested _meta.ui.resourceUri when gated in", () => {
  for (const name of [...REVIEW_CARD_TOOL_NAMES, ...BULK_PLAN_CARD_TOOL_NAMES]) {
    assertEquals(
      reviewCardMetaForListing(name, ALL_GATES),
      { ui: { resourceUri: "ui://mcpemails/review-card.html" } },
      `${name} gated in`,
    );
  }

  // Phase 0 Q7.4: the nested key only, never the deprecated flat one, and no
  // `visibility` — the mail tools are meant to be model-callable.
  const serialized = JSON.stringify(reviewCardMetaForListing("email_compose", ALL_GATES));
  assert(!serialized.includes("ui/resourceUri"), "must not emit the deprecated flat key");
  assert(!serialized.includes("visibility"), "mail tools must not restrict visibility");
});

Deno.test("a non-card tool gets no _meta under any combination of gates", () => {
  // Includes the app-only tools: they carry appOnlyReviewCardToolMeta() from
  // the registry unconditionally and must be passed through untouched, so this
  // helper returning undefined for them is what preserves their metadata.
  for (
    const name of [
      "inbox_list",
      "email_read",
      "folder",
      "draft_unknown",
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
    for (const gates of [NO_GATES, ALL_GATES, { outbound: true, bulk: false }, { outbound: false, bulk: true }]) {
      assertEquals(
        reviewCardMetaForListing(name, gates),
        undefined,
        `${name || "(empty)"} must never be given card _meta`,
      );
    }
  }
});

Deno.test("gating is by exact name, never a prefix or case-insensitive match", () => {
  for (const name of ["Email_Compose", "email_compose ", "email_compose_v2", "draftx", "schedul"]) {
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
      _meta: { ui: { resourceUri: "ui://mcpemails/review-card.html" } },
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

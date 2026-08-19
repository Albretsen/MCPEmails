# MCP tool-schema context cost: what the spec offers and what clients actually do

Research date: 2026-08-19. Scope: what the current MCP specification and the real Anthropic client
ecosystem provide for reducing the context cost of `tools/list`, measured against our own server
(`supabase/functions/mcp-server/index.ts`).

All measurements in this document were taken by loading the real `TOOL_REGISTRY` from
`supabase/functions/mcp-server/index.ts` and running it through the real `serializeToolForList`
from `supabase/functions/mcp-server/mcp-app-resources.ts`. Method is in the appendix.

---

## Bottom line

1. **The spec has moved twice, not once. The current revision is `2026-07-28`, not `2025-11-25`.**
   Neither revision adds tool filtering, tool groups, "default enabled" tools, or any progressive
   disclosure mechanism. The two community proposals that asked for exactly this (SEP-1576 and
   issue #2808) were closed with no spec-level answer. There is nothing in the protocol to adopt
   here. Sources: [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog),
   [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
   [SEP-1576](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1576),
   [issue #2808](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2808).

2. **The fix already shipped on the client side, and it is on by default.** Anthropic's tool search
   tool (GA, `tool_search_tool_regex_20251119` / `..._bm25_20251119`) plus `defer_loading` means
   Claude Code defers *all* MCP tool definitions by default: only tool **names** and the server's
   **`instructions`** string load at session start. For Claude Code users our 28k to 55k characters
   of schema is already close to free. The lever we control is therefore not schema size for that
   client, it is **discoverability**: names, the `instructions` field, and keyword coverage in
   descriptions. Sources: [Claude Code MCP docs, "Scale with MCP tool search"](https://code.claude.com/docs/en/mcp),
   [tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).

3. **Only three fields of a tool ever reach the model on the Anthropic path: `name`,
   `description`, and `inputSchema`.** The Anthropic Messages API tool object has no field for
   `title`, `outputSchema`, `annotations`, `icons`, or `_meta`, so those are consumed by the client
   or dropped, never rendered into the model's system prompt. In our payload that is 4,749 bytes
   (8.6 percent) that costs nothing in model context. Deleting `outputSchema` or `annotations` to
   save tokens would be a **zero-token change** that loses real client-side behaviour. Do not do it.
   Sources: [Define tools, "Tool use system prompt"](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
   [Tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference).

4. **Nested property `description` strings are the whole ballgame.** Of the 50,665 bytes that
   actually render into context, 20,498 bytes (40.5 percent) are `description` strings on nested
   schema properties, and `inputSchema` overall is 42,992 bytes (85 percent of the rendered
   payload). Tool-level descriptions are only 6,820 bytes. Capping nested descriptions at 60
   characters alone cuts the rendered payload by 18.5 percent; moving that prose out entirely cuts
   it by 40 percent. Everything else (enums at 453 bytes, `default`/`format`/`min`/`max` at
   1,356 bytes combined) is rounding error.

5. **Pagination of `tools/list` saves nothing, and dynamic tool exposure via
   `notifications/tools/list_changed` is a dead end for us.** The spec tells clients to keep
   requesting pages until `nextCursor` is absent, so every client drains every page. And the
   2026-07-28 spec now says the tool set "**MUST NOT** vary per-connection or as a side effect of
   other requests on the connection", which forecloses "serve a small list, expand later". The one
   variation the spec explicitly blesses is by **authorization**, which is exactly the scope
   filtering `handleToolsList` already does. Source:
   [2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
   [pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination).

---

## 1. Spec delta

### 1.1 Correction to the premise: there are two revisions since 2025-06-18

The task framed the current spec as `2025-11-25`. It is not. `2026-07-28` is the current revision
([release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/)). Both deltas are below.

### 1.2 2025-06-18 to 2025-11-25 (complete)

Source: <https://modelcontextprotocol.io/specification/2025-11-25/changelog>

Major changes:

1. Authorization server discovery gains OpenID Connect Discovery 1.0 support (PR #797).
2. Servers may expose `icons` on tools, resources, resource templates and prompts (SEP-973).
3. Incremental scope consent via `WWW-Authenticate` (SEP-835).
4. Guidance on tool names (SEP-986).
5. `ElicitResult` and `EnumSchema` reworked; titled, untitled, single-select and multi-select enums (SEP-1330).
6. URL mode elicitation (SEP-1036).
7. Tool calling in sampling via `tools` / `toolChoice` (SEP-1577).
8. OAuth Client ID Metadata Documents as the recommended registration mechanism (SEP-991).
9. Experimental `tasks` primitive: any request can return a task handle for polling and deferred retrieval (SEP-1686).

Minor changes: stderr logging clarification for stdio; optional `description` on `Implementation`;
HTTP 403 for invalid Origin; updated security best practices; **input validation errors should be
Tool Execution Errors, not Protocol Errors (SEP-1303)**; SSE polling (SEP-1699 and its
clarification); RFC 9728 alignment making `WWW-Authenticate` optional (SEP-985); default values for
primitive types in elicitation schemas (SEP-1034); **JSON Schema 2020-12 established as the default
dialect (SEP-1613)**. Schema change: request payloads decoupled from RPC method definitions
(SEP-1319). Plus four governance items.

Bearing on tool-definition size: **essentially none**. SEP-1613 (2020-12 default) means we can drop
an explicit `$schema` if we carry one. SEP-973 (icons) adds a new optional field that would *add*
bytes on the wire. SEP-1303 is the change our `MCP cap paywall rebuild` work already implemented.

### 1.3 2025-11-25 to 2026-07-28 (complete)

Source: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>

Major changes:

1. Protocol-level sessions and `Mcp-Session-Id` removed. List endpoints no longer vary per-connection. Cross-call state moves to explicit server-minted handles passed as ordinary tool arguments (SEP-2567).
2. MCP made stateless: `initialize` / `notifications/initialized` removed. Every request carries protocol version and client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`, `io.modelcontextprotocol/clientInfo`). Version mismatch returns `UnsupportedProtocolVersionError` (SEP-2575).
3. New `server/discover` RPC, which servers MUST implement, advertising supported protocol versions, capabilities and identity (SEP-2575).
4. HTTP GET endpoint and `resources/subscribe` / `resources/unsubscribe` replaced by `subscriptions/listen`, a single long-lived POST-response stream with per-type opt-in (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`) (SEP-2575).
5. `ping`, `logging/setLevel` and `notifications/roots/list_changed` removed. Log level moves to `io.modelcontextprotocol/logLevel` in `_meta` (SEP-2575).
6. Experimental tasks moved out of core into the official `io.modelcontextprotocol/tasks` extension; `tasks/result` replaced by polling `tasks/get`, new `tasks/update`, `tasks/list` removed (SEP-2663).
7. Multi Round-Trip Requests (MRTR) replace server-initiated requests: servers return `InputRequiredResult` with `inputRequests`, clients retry with `inputResponses` (SEP-2322).
8. All results carry a required `resultType` (`"complete"` or `"input_required"`) (SEP-2322).
9. SSE resumability and message redelivery removed (`Last-Event-ID`, SSE event IDs) (SEP-2575).

Minor changes: `extensions` field on client and server capabilities; OpenTelemetry `_meta` trace
context conventions (SEP-414); **servers SHOULD return tools from `tools/list` in a deterministic
order, explicitly to improve LLM prompt cache hit rates**; required `Mcp-Method` / `Mcp-Name`
headers plus `x-mcp-header` parameter mirroring (SEP-2243); **required `ttlMs` and `cacheScope` on
`tools/list`, `prompts/list`, `resources/list`, `resources/read` and `resources/templates/list` via
a new `CacheableResult` interface (SEP-2549)**; resource-not-found code changed from `-32002` to
`-32602`; `iss` in authorization responses (SEP-2468); `application_type` in DCR (SEP-837);
credentials bound to issuer (SEP-2352); **`inputSchema` and `outputSchema` loosened to allow any
JSON Schema 2020-12 keyword, with `$ref` resolution requirements and composition-keyword resource
bounds (SEP-2106)**; `notifications/elicitation/complete` and `elicitationId` removed; error code
allocation policy carving out `-32020` to `-32099` for the spec.

Deprecated: Roots, Sampling, Logging (SEP-2577); HTTP+SSE transport; `includeContext` values
`"thisServer"` / `"allServers"`; OAuth DCR (RFC 7591) in favour of Client ID Metadata Documents.

### 1.4 Narrowed to things that bear on tool-definition size

**Tool filtering / groups / namespaces / default-enabled: does not exist.** There is no
`enabled`, no tool group, no namespace primitive, no "on demand" flag anywhere in either revision.
Tool *names* get naming guidance (SEP-986) and a note that aggregating proxies SHOULD prefix names
for disambiguation, but that is a collision-avoidance rule, not a filtering mechanism. The two
proposals that asked for a protocol answer to token bloat, SEP-1576 ("Mitigating Token Bloat in MCP")
and issue #2808 ("MCP spec should address tool schema token overhead"), are both closed without one.
See also discussion [#1923 "Progressive Tool Discovery for Token Efficiency"](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1923).

**`notifications/tools/list_changed` and dynamic tool exposure: foreclosed as of 2026-07-28.**
The current tools page is explicit:

> "This set **MAY** be empty and **MAY** change over time [...] but **MUST NOT** vary per-connection
> or as a side effect of other requests on the connection. The set **MAY** vary by the authorization
> presented on the request, for example, returning only the tools the caller's granted scopes
> permit, since credentials are per-request input, not connection state."

So "serve 3 tools, then expand to 16 once the model shows interest" is now a spec violation, because
the expansion would be a side effect of other requests on the connection. What is explicitly legal
is varying by authorization, which is exactly what `handleToolsList` already does via
`isToolAuthorized(tool, apiKey.scopes)`. That legitimises (and arguably should be leaned into) a
scope-narrowed key as the token-reduction mechanism.

Honouring by clients: Claude Code does support `list_changed` and refreshes on it, and since
v2.1.214 keeps previously discovered tools if a refresh fails ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)).
But refresh behaviour is irrelevant if we cannot legally shrink the initial list.

**Pagination: real, universally drained, saves nothing.** `tools/list` supports `cursor` /
`nextCursor`. The [pagination page](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination)
tells clients to "treat a missing `nextCursor` as the end of results" and to loop, and page size is
server-chosen with clients forbidden from assuming one. There is nothing in the spec that lets a
server say "these are the important ones, stop here", and no documented client that stops early.
Verdict: paginating our `tools/list` would add round trips and save zero tokens. **Unverified**
whether some third-party client stops after page one; if it did, that would be a client bug we
should not design around.

**`outputSchema` / `structuredContent`: does not cost model tokens on the Anthropic path.** The
Anthropic Messages API tool object accepts `name`, `description`, `input_schema`, and the optional
properties `cache_control`, `strict`, `defer_loading`, `allowed_callers`, `input_examples`,
`eager_input_streaming`. There is no output-schema field. The rendered system prompt is documented
as `Here are the functions available in JSONSchema format: {{ TOOL DEFINITIONS IN JSON SCHEMA }}`,
and first-hand observation in this very session confirms the rendering is minified JSON of the form
`{"description": ..., "name": ..., "parameters": {...}}` per function, with no `title`, no output
schema, no annotations. Our `outputSchema` is 1,486 bytes across 2 tools and buys client-side
validation of `structuredContent`; keep it.
**Unverified** for non-Anthropic clients (Cursor, VS Code Copilot, Cline). Some of those pass MCP
tool JSON through more literally, in which case `outputSchema` *would* cost. Experiment below.

**Icons, `title`, `_meta`, `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint`): client-only, therefore free in model context, and load-bearing for us.** The
spec's own framing is a client-trust warning ("clients MUST consider tool annotations to be
untrusted unless they come from trusted servers"), which only makes sense for client-side
consumption. Claude Code additionally reads vendor keys out of `_meta`:

- `_meta["anthropic/maxResultSizeChars"]` raises the persist-to-disk threshold for that tool's
  results, up to 500,000 characters.
- `_meta["anthropic/requiresUserInteraction"]: true` forces a permission prompt on every call, even
  under `bypassPermissions`.
- `_meta["anthropic/alwaysLoad"]: true` exempts a single tool from deferral, so it loads upfront.

That last one is the only server-controllable knob over Claude Code's tool-loading behaviour, and it
points the wrong way (it *adds* upfront context). There is no documented `_meta` key that requests
deferral, because deferral is already the default. Our existing `annotations.destructiveHint` on
delete and bulk tools costs 1,876 bytes on the wire and 0 tokens in context, and drives the
human-in-the-loop confirmation the `MCP Apps visibility is not a security boundary` note depends on.
Keeping it is correct.

**Resources vs tools for reference material: a real win, with a client-support caveat.**
`resources/list` and `resources/read` are separate RPCs; their content is not in the tool-definition
prefix. Claude Code "automatically provides tools to list and read MCP resources when servers
support them", so the model can pull a resource on demand. That makes a resource a genuine
just-in-time surface for things like a provider capability matrix ("`has_attachment` is ignored on
generic IMAP, `flagged` is ignored on Outlook/Graph, Gmail searches the whole message not body-only,
`query` is ignored on Fastmail") that today live as prose inside `inputSchema` property
descriptions. Caveats: (a) the model must be motivated to fetch it, which means a one-line pointer
in the tool description, so the saving is net of that pointer; (b) Anthropic's **MCP connector**
path supports tool calls only, explicitly: "Of the feature set of the MCP specification, only tool
calls are currently supported". So the Messages API MCP connector cannot read our resources at all.
We already serve `resources/list` for the `ui://` MCP Apps cards, so the plumbing exists.

**Prompts as a cheaper surface: real but narrow.** We already expose five prompts (triage, find
answer, open loops, decisions, reply drafts). Prompts are user-invoked, not model-invoked, so they
do not reduce the tool prefix. They are the right home for workflow guidance that currently pads
tool descriptions, but they only help when a human picks them.

**Tool search / progressive disclosure in the spec or open SEPs: nothing landed.** The pattern
exists entirely at the client and gateway layer (Anthropic tool search, Cloudflare Code Mode,
Solo.io agentgateway). Do not wait for a spec answer.

---

## 2. How clients actually load tools

### 2.1 Claude Code and the Agent SDK

- **Deferred loading is on by default.** "Tool search keeps MCP context usage low by deferring tool
  definitions until Claude needs them. Only tool names and server instructions load at session
  start." Up to five most-relevant tools load per search, and stay for later turns until compaction
  evicts them.
- **What makes a server eligible:** nothing on our side. Every registered MCP tool is deferred
  unless the *user* sets `alwaysLoad: true` on the server, or the *server* sets
  `_meta["anthropic/alwaysLoad"]: true` on a tool. Deferral is disabled only by client-side
  conditions: `ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, a non-first-party
  `ANTHROPIC_BASE_URL`, Microsoft Foundry on Azure, pre-4.5-generation models on Google Cloud Agent
  Platform, or a model older than Sonnet 4.5 / Haiku 4.5 / Opus 4.5.
- **`ENABLE_TOOL_SEARCH=auto[:N]`** flips to upfront loading while deferrable definitions are under
  N percent (default 10) of the context window. Our ~13k to 15k tokens would sit under 10 percent of
  a 200k window, so a user on `auto` would get our schemas loaded upfront. This is the case where
  schema size still matters in Claude Code.
- **The client truncates.** "Claude Code truncates tool descriptions and server instructions at 2KB
  each. Keep them concise to avoid truncation, and put critical details near the start." Measured:
  our longest tool description is 852 bytes (`email_read`) and `SERVER_INSTRUCTIONS` is 1,796 bytes,
  so nothing truncates today. That leaves only 252 bytes of headroom on the instructions string,
  which is the one field that always loads under tool search. Guard it with a test.
- **The client rewrites schemas.** Root-level `anyOf` / `oneOf` / `allOf` is rejected by the Claude
  API, so Claude Code flattens the schema and *prepends a sentence to the tool description*
  explaining which parameter groups go together. Practical consequence: a refactor that expresses
  per-action parameter sets as a root-level `oneOf` will be flattened and will grow the description,
  not shrink the payload. Combinators nested inside `properties` are passed through unchanged.
- **What is in context when deferred:** tool names only, plus server instructions. Confirmed
  first-hand in this session: deferred tools appear as a bare name list with the note "Until fetched,
  only the name is known, there is no parameter schema, so the tool cannot be invoked."

### 2.2 Anthropic Messages API (direct `tools` array)

- Tool definitions are rendered into a constructed system prompt after a fixed preamble. Only
  `name`, `description` and `input_schema` survive; `input_examples` render alongside the schema
  when present.
- `defer_loading: true` strips a tool from the rendered tools section **before the cache key is
  computed**, so it never enters the system-prompt prefix. Discovery appends a `tool_reference`
  inline in the conversation body, which the API expands.
- **Every tool definition is still sent on every request.** `defer_loading` controls context, not
  wire bytes. So our `tools/list` payload size affects latency and egress regardless.
- Limits: 10,000 deferred tools per request; searches return 5 by default, `limit` 1 to 10,000;
  regex patterns capped at 200 chars, BM25 queries at 500. Both variants search **tool names,
  descriptions, argument names and argument descriptions**.

### 2.3 MCP connector (`mcp_toolset`) on the Messages API

- The caller, not us, controls exposure: `default_config` and per-tool `configs` with `enabled` and
  `defer_loading`. Allowlist pattern is `default_config.enabled: false` plus explicit enables.
- `defer_loading` is set once for the whole server or per tool. There is no way for the server to
  request it.
- Only tool calls are supported. Prompts and resources are not.
- Unknown tool names in `configs` log a backend warning rather than erroring, "MCP servers may have
  dynamic tool availability".

### 2.4 Claude.ai / Claude Desktop remote connectors

**Unverified.** I could not find a public Anthropic statement about whether claude.ai custom
connectors defer MCP tool definitions the way Claude Code does. The support article on custom
connectors does not discuss tool counts, description limits, or context usage. Given that the
underlying capability (tool search, `tool_reference` expansion) is GA on the API and enabled by
default in Claude Code, it is plausible but not documented that claude.ai does the same.

Experiment that settles it: connect the production server to claude.ai with a full-scope key, ask
"what tools do you have available?" in a fresh conversation, and watch our own edge logs. If
claude.ai calls `tools/list` once and the model can immediately name all 10 tools with their
parameters, definitions are loaded upfront. If the model has to run a search step first, or names
tools but not their arguments, they are deferred. A second signal: compare the reported context
usage of a fresh conversation with the connector enabled vs disabled.

### 2.5 Which JSON Schema keywords reach the model

The system prompt says "Here are the functions available in JSONSchema format" and then embeds the
schema. Observed rendering is the schema object serialized whole under a `parameters` key. That
means **every keyword we put in `inputSchema` is forwarded**, including `description` on every
nested property, `enum`, `default`, `format`, `minimum`, `maximum`, `minItems`, `maxItems`, and
`items`. There is no documented allowlist that drops any of them.

Two documented exceptions on the Claude Code path: root-level `anyOf` / `oneOf` / `allOf` is
rewritten into a flat object plus prose, and a tool whose schema cannot be made API-acceptable is
skipped entirely.

**Unverified:** whether the API drops unknown/vendor keywords like `x-mcp-header` before rendering.
Cheap to settle with `count_tokens` (see section 3).

### 2.6 Caching

- Tool definitions sit at the front of the cache prefix hierarchy (`tools`, then `system`, then
  `messages`). Any change to a tool definition invalidates the entire cache.
- With a cache hit, the tool prefix is charged at cache-read rates rather than full input rates, so
  the cost is not literally repaid per turn. It is still counted against the context window every
  turn, which is the constraint that actually bites.
- 2026-07-28 adds two server-side levers that help clients cache: `ttlMs` / `cacheScope` on
  `tools/list` (SEP-2549) and the SHOULD to return tools in deterministic order, stated explicitly
  to "improve LLM prompt cache hit rates". Our registry is a static array, so ordering is already
  deterministic; we do not yet emit `ttlMs` / `cacheScope`.

---

## 3. Token accounting

**Exact method (use this, do not estimate):** `POST /v1/messages/count_tokens` accepts the same
`tools` array as `/v1/messages` and returns `input_tokens`. It is free, rate-limited separately, and
supported on all active models. Take the count with an empty-ish message, then subtract a baseline
run with `tools` omitted, and the difference is the true cost of our tool definitions plus the
tool-use preamble. The docs' own example (one trivial `get_weather` tool plus a one-line user
message) reports 403 tokens, against 14 for a no-tools request, which tells you the fixed tool-use
preamble is roughly 300 tokens before any of your tools.

**Practical rule of thumb, when you cannot call the API:** minified JSON of English-language tool
schemas runs about **3.5 to 3.8 characters per token**. Our full-scope rendered payload of 50,665
characters is therefore roughly 13,500 to 14,500 tokens on a pre-Opus-4.7 tokenizer. Caution: Claude
Opus 4.7 and later, Fable 5 and Mythos 5 use a newer tokenizer that produces **roughly 30 percent
more tokens for the same text**. On those models the same payload is closer to 17,500 to 19,000
tokens. Recount per target model; do not reuse old counts.

**Whitespace does not matter.** The client parses `tools/list` JSON into objects and re-serializes
when building the request, and the API re-renders the schema into the system prompt. Pretty-printing
our registry costs 122,387 bytes vs 55,414 minified on the wire, but the model sees the same tokens
either way. Optimising indentation is pure network-egress work, not token work.

**Measured composition of our `tools/list` (16 tools, full-scope key):**

| Segment | Bytes | Share of wire | Reaches the model? |
| --- | ---: | ---: | --- |
| Whole response, minified | 55,414 | 100% | partially |
| Whole response, pretty-printed | 122,387 | n/a | no, whitespace is dropped |
| `inputSchema` | 42,992 | 77.6% | yes |
| ... of which nested property `description` | 17,886 | 32.3% | yes |
| ... of which `enum` arrays | 453 | 0.8% | yes |
| tool-level `description` | 6,820 | 12.3% | yes |
| `annotations` (16 tools) | 1,876 | 3.4% | no |
| `outputSchema` (2 tools) | 1,486 | 2.7% | no |
| `_meta` (9 tools) | 658 | 1.2% | no |
| `title` | 300 | 0.5% | no |
| `name` | 218 | 0.4% | yes |

Rendered as the model sees it (`{description, name, parameters}` only): **50,665 bytes**, of which
**20,498 bytes (40.5 percent) are nested property descriptions**.

Per tool, largest first (bytes of the full serialized entry):

```
 11074 email_read      desc  852  in 10024
  8111 email_organize  desc  737  in  7162
  5712 email_compose   desc  375  in  5063
  5542 draft           desc  644  in  4646
  4945 email_delete    desc  404  in  4336
  4867 schedule        desc  191  in  4405
  2534 folder          desc  391  in  1935
  2518 contact_search  desc  824  in   997
  2449 signature       desc  446  in  1806
  2379 inbox_list      desc  489  in   711
  1051 approval_update / 1045 approval_decide / 859 approval_schedule
   773 approval_review /  771 bulk_execute   / 757 bulk_cancel
```

The 28,000-character figure in the brief corresponds to a **scope-limited key**, not a full-scope
one. `handleToolsList` filters by `apiKey.scopes`, so a `read:email` only key (inbox_list,
email_read, folder, signature) sees far less; a read plus one write scope lands near 28k. Full-scope
keys pay 55k. Any measurement of "our tools/list cost" must state which scopes.

**What-if measurements (rendered bytes, `{description, name, parameters}` only):**

| Variant | Bytes | Saving vs 50,665 |
| --- | ---: | ---: |
| Baseline, as rendered today | 50,665 | 0% |
| Drop all nested property descriptions | 30,167 | 40.5% |
| Cap nested property descriptions at 60 chars | 41,276 | 18.5% |
| Drop `default` / `format` / `minimum` / `maximum` / `minItems` / `maxItems` | 49,309 | 2.7% |
| Both of the above two | 39,920 | 21.2% |
| Public 10 tools only (drop 6 app-only approval/bulk tools) | 46,980 | 7.3% |

---

## 4. Ranked techniques

Ranking is by (expected saving) times (confidence) divided by (risk plus client-behaviour
dependence).

### 1. Move per-provider caveat prose out of nested property descriptions

**Saving:** up to 40.5 percent of rendered bytes if all nested descriptions go; realistically 15 to
25 percent by trimming the caveat sentences and leaving one clause per property.
**Risk:** medium. Anthropic's own guidance runs the other way ("provide extremely detailed
descriptions", "this is by far the most important factor in tool performance"), and tool search
matches against **argument descriptions** as well as names, so gutting them hurts discoverability.
Mitigate by keeping one plain-language clause per property and exiling only the provider matrix
(what IMAP ignores, what Gmail does differently, what Fastmail drops).
**Client dependence:** none. Works on every client, every model.
**Where the prose goes:** an MCP resource plus a single pointer line in the tool description. Note
the MCP connector cannot read resources, so for that path the information is simply gone. Safer
variant: keep it in the *tool-level* description (6,820 bytes today, cheap) rather than repeating it
per property.

### 2. Deduplicate the boilerplate that repeats across tools

**Saving:** unmeasured but visible. The `inbox_id` description alone is 316 characters and appears
on nearly every tool; the same is true of `inbox`, `limit`, `offset`. Ten copies of 316 characters is
about 3,160 characters, roughly 6 percent, for one property. Across `inbox_id`, `inbox`, `limit`,
`offset`, `folder`, `message_id` the repeated total is plausibly 10 to 15 percent.
**Risk:** low. Shorten the repeated copies to one clause and state the full selection rule once in
`SERVER_INSTRUCTIONS`, which already carries the INBOX SELECTION paragraph. Do **not** use `$ref`
to a `$defs` block: 2026-07-28 added `$ref` resolution requirements (SEP-2106) but the Claude API's
tolerance for `$ref` in `input_schema` is **unverified**, and a rejected schema means Claude Code
silently skips that tool.
**Client dependence:** none for the shortening; high for `$ref`.

### 3. Lean into scope-narrowed API keys as the supported reduction path

**Saving:** 45 to 62 percent for a key that does not carry every scope (55,414 down to about 21,000
for a read-ish key), and it is already implemented.
**Risk:** none technically; it is a product decision. The 2026-07-28 spec explicitly blesses varying
the tool set by authorization, so this is the one filtering mechanism with the protocol's blessing.
**Client dependence:** none.
**Action:** make the dashboard default new keys to the minimum scopes for the stated use case, and
say in the docs that a narrower key means a smaller tool surface and better tool selection. This is
the highest-value, lowest-risk item on the list and it is mostly copy and defaults, not code.

### 4. Write for tool search rather than for upfront loading

**Saving:** zero direct bytes, but it is what actually determines cost on the default Claude Code
path, where only names plus `instructions` load.
**Risk:** none.
**Client dependence:** high, and that is fine, because the dependence is on the default behaviour of
the client that matters most.
**Actions:** (a) verify `SERVER_INSTRUCTIONS` is under 2,048 bytes and front-loads the tool index;
(b) keep the consistent `email_*` / `folder` / `draft` / `schedule` prefixes, which is exactly the
"consistent namespacing so one search matches the whole group" advice; (c) make sure each tool
description contains the words a user would use (archive, unsubscribe, attachment, unread, label,
signature), because both search variants match descriptions and argument descriptions; (d) consider
`_meta["anthropic/alwaysLoad"]: true` on `inbox_list` **only**, at a cost of about 2,379 bytes, so
the entry-point tool is present without a search step. That directly addresses the
`Fresh-connect inbox_list missing` failure mode.

### 5. Drop the 6 app-only approval and bulk tools from the model-visible list

**Saving:** 7.3 percent (3,685 rendered bytes).
**Risk:** high, and mostly already known to be unacceptable. The `MCP Apps visibility is not a
security boundary` finding proves an app-only tool is still callable by the model, so hiding them
from `tools/list` does not make them safe, and hiding them may break the card flows.
**Client dependence:** n/a.
**Verdict:** only worth it if the cards are confirmed not to need model-visible tools.

### 6. Emit `ttlMs` and `cacheScope` on `tools/list`

**Saving:** zero model tokens. It reduces re-fetch traffic and helps clients keep a stable prefix,
which helps prompt-cache hit rates.
**Risk:** none, it is additive and ignored by older clients.
**Client dependence:** high (only 2026-07-28-aware clients read it).
**Verdict:** cheap conformance work, do it when we bump the advertised protocol version, not as a
token measure.

### 7. Strip `default` / `format` / `minimum` / `maximum` / `minItems` / `maxItems`

**Saving:** 2.7 percent.
**Risk:** medium. `default` and the bounds are genuinely useful to the model and to client-side
validation, and `format: "date-time"` communicates the ISO-8601 expectation more compactly than
prose would.
**Verdict:** not worth it. Rejected.

### 8. Delete `outputSchema`, `annotations`, `title`, `_meta` to save tokens

**Saving:** zero on the Anthropic path. These fields never reach the model.
**Risk:** high. `destructiveHint` drives client confirmation, `_meta` drives the MCP Apps cards,
`outputSchema` gives clients structuredContent validation.
**Verdict:** rejected. This is the trap in the brief's premise and the single most important thing
to not do.

### 9. Paginate `tools/list`

**Saving:** zero. Clients drain every page by spec instruction.
**Verdict:** rejected.

### 10. Serve a small initial list and expand via `notifications/tools/list_changed`

**Saving:** would be large.
**Risk:** it is now a spec violation ("MUST NOT vary [...] as a side effect of other requests on the
connection"), and it depends on unreliable client refresh behaviour.
**Verdict:** rejected. Use scope-based variation instead, which is the sanctioned version of the
same idea.

---

## Open questions and the experiments that settle them

| Question | Experiment |
| --- | --- |
| Does claude.ai / Claude Desktop defer connector tool definitions? | Fresh conversation with the connector attached; ask for available tools; check whether the model can state parameter names without a search step, and diff reported context usage with the connector on vs off. |
| Exactly how many tokens does our payload cost on Opus 5 vs Sonnet 4.6? | `POST /v1/messages/count_tokens` with our real `tools` array, once per model, minus a no-tools baseline. Free, and removes all char-per-token guesswork. |
| Does the Claude API strip vendor keywords (`x-mcp-header`, `$ref`, `$defs`) before rendering? | Two `count_tokens` calls on the same schema, one with the keyword and one without. Equal counts means stripped. |
| Do non-Anthropic clients forward `outputSchema` and `annotations` to the model? | Connect via Cursor or VS Code Copilot and inspect their request logs, or measure their reported context. If they forward, the free-fields conclusion is Anthropic-specific. |
| ~~Is `SERVER_INSTRUCTIONS` under Claude Code's 2KB truncation limit?~~ | Settled: 1,796 bytes, under the 2,048 limit, with 252 bytes of headroom. Add a regression test asserting it. |

---

## Appendix: measurement method

The numbers above were produced by copying `supabase/functions/mcp-server/*.ts` into a scratch
directory, changing `const TOOL_REGISTRY` to `export const TOOL_REGISTRY`, commenting out the
`Deno.serve(handleRequest)` call at the bottom of `index.ts`, and running a Deno script that imports
`TOOL_REGISTRY` and maps it through the unmodified `serializeToolForList` from
`mcp-app-resources.ts`, with `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` set
to dummy values so the module-level `createClient` call succeeds. No source file in the repository
was modified. Byte counts are `JSON.stringify(...).length` on the serialized result, which matches
what the edge function writes to the wire.

## Sources

- MCP 2025-11-25 key changes: <https://modelcontextprotocol.io/specification/2025-11-25/changelog>
- MCP 2026-07-28 key changes: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- MCP 2026-07-28 tools: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- MCP 2026-07-28 pagination: <https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination>
- 2026-07-28 release post: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- SEP-1576 (token bloat, closed): <https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1576>
- Issue #2808 (tool schema token overhead, closed): <https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2808>
- Discussion #1923 (progressive tool discovery): <https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1923>
- Tool search tool: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool>
- Tool reference (optional tool properties): <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference>
- Define tools (tool-use system prompt, best practices, input_examples): <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>
- Tool use with prompt caching: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching>
- MCP connector (`mcp_toolset`): <https://platform.claude.com/docs/en/agents-and-tools/mcp-connector>
- Token counting: <https://platform.claude.com/docs/en/build-with-claude/token-counting>
- Claude Code MCP (tool search, `alwaysLoad`, `_meta` annotations, 2KB truncation, root combinators): <https://code.claude.com/docs/en/mcp>
- Agent SDK tool search: <https://code.claude.com/docs/en/agent-sdk/tool-search>
- Anthropic engineering, advanced tool use: <https://www.anthropic.com/engineering/advanced-tool-use>
- Claude.ai custom connectors (no tool-loading detail): <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>

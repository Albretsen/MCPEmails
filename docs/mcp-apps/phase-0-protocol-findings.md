# Phase 0: MCP Apps protocol spike — findings

Date: 2026-08-05
Spike code: `/private/tmp/claude-501/-Users-asgeiralbretsen-Repositories-MCPEmails/31ec7162-7a08-4a71-b024-c68e652c810d/scratchpad/apps-spike/`
Reference implementation read + used as harness: `modelcontextprotocol/ext-apps` @ `92f46a5` (v1.7.5), `@modelcontextprotocol/sdk` 1.29.0.
Nothing was deployed. The production edge function was not modified.

---

## Verdict: GO-WITH-CHANGES

The MCP Apps extension works end-to-end against a hand-rolled, stateless, SDK-free
Deno JSON-RPC server that echoes `protocolVersion: "2025-06-18"`, exactly the shape
`supabase/functions/mcp-server/index.ts` has today. A card rendered, received the
tool result, called a server tool from inside the iframe, requested fullscreen,
pushed model context and sent a message. No session state was needed anywhere.

Phase 1 must additionally do four things, none of them large:

1. **Add `resources` to the `initialize` result capabilities and implement
   `resources/list` + `resources/read`.** This is the one hard blocker in the
   current server. `routeMethod` has no `resources/*` branch and `handleInitialize`
   declares only `tools` and `prompts`. Without a declared `resources` capability
   the host's `AppBridge` never wires the resource proxy and every
   `resources/read` from inside the iframe fails with `-32601 Method not found`
   (reproduced, evidence in Q5).
2. ~~**Enforce `visibility: ["app"]` server-side as well.**~~ **CORRECTED 2026-08-05.**
   This item was self-contradictory and must not be acted on. Q2 in this same
   document proves the server receives *no signal* distinguishing an
   app-originated `tools/call` from a model-originated one — so there is nothing
   to enforce with. `visibility` cannot be made into an authorisation boundary by
   any server-side means, and no server-issued token helps either, because the
   model can call whichever tool hands out the token.
   The actual resolution: authority for irreversible actions moves **off the MCP
   channel entirely**. Approving a send happens only at an authenticated
   `/approvals/<id>` page behind a Supabase session and an owner/admin role
   check. Reversible actions (reject, edit, schedule, bulk-execute) stay inline.
   See `contract.md` §6, which is the binding specification.
3. **Keep echoing `2025-06-18`.** Do not "upgrade" to a version string outside the
   SDK's `SUPPORTED_PROTOCOL_VERSIONS`; a future-dated string hard-fails the
   handshake (Q1).
4. **Budget for the UI resource being re-fetched on every single tool call.**
   No caching anywhere in the reference host (Q4). A 330 KB card is 330 KB per
   tool call out of the edge function.

Everything else is additive metadata on responses the server already emits.

---

## Q1. Protocol version and extension negotiation

**Does the UI extension get negotiated when the server echoes `2025-06-18`? Yes,
fully — and more importantly, the reference host never negotiates it at all.**

What the ext-apps `basic-host` actually sent to the spike server on `initialize`
(captured verbatim, `spike.log.jsonl` entry `initialize.params`):

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": {},
  "clientInfo": { "name": "MCP Apps Host", "version": "1.0.0" }
}
```

`capabilities` is the **empty object**. There is no `extensions` key, and therefore
no `io.modelcontextprotocol/ui` entry. Despite that, the entire app flow worked:
resource fetched, iframe rendered, `ui/initialize` handshake completed,
`callServerTool` round-tripped.

This is the single most important finding for our server design: **a server must
not gate its `_meta.ui` metadata on seeing the extension capability.** The
`getUiCapability` pattern in the SEP ("Servers SHOULD check client capabilities
before registering UI-enabled tools") would have produced a text-only tool surface
against the official reference host. Emit `_meta.ui` unconditionally; hosts that
do not understand it ignore it, which is exactly the graceful-degradation path the
spec describes.

The extension capability *is* transmitted verbatim when a client bothers to declare
it. Probe client (`probe.mjs`) declaring it explicitly, as received by the server:

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": {
    "extensions": {
      "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] }
    }
  },
  "clientInfo": { "name": "spike-probe", "version": "1.0.0" }
}
```

So the field is a reliable *positive* signal when present, and carries no
information when absent. Log it; do not branch on it.

**Version matrix** (`node probe.mjs`, real SDK client, four spike servers each
echoing a different `protocolVersion`):

```
OK   2025-06-18 (production echo): tools=spike_show,spike_app_only,spike_big resources=2
     spike_show._meta = {"ui":{"resourceUri":"ui://spike/card"}}
     resources/read _meta = {"ui":{"csp":{...},"prefersBorder":true}} bytes=327710
OK   2025-11-25 (SDK latest):      ... identical ...
FAIL 2026-07-28 (fictional future): Server's protocol version is not supported: 2026-07-28
OK   2024-11-05 (legacy):          ... identical ...
```

`@modelcontextprotocol/sdk` 1.29.0 hard-codes
`SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']`
and throws in `client/index.js:304` if the server's echoed version is not in it.
`2025-06-18` is in the list, `_meta.ui` survives the SDK's zod parsing at every
supported version, and nothing about MCP Apps is version-gated.

Secondary observation: after the handshake the SDK stamps
`MCP-Protocol-Version: 2025-06-18` (the *server's* echoed value) on every
subsequent POST. Our server ignores that header today, which is correct.

**Minimum version that works: none — the extension is orthogonal to protocol
version. Stay on `2025-06-18`.**

## Q2. App-only visibility — the security question

**A `visibility: ["app"]` tool is hidden from the model's tool picker by the host,
is callable from the iframe, and the server is given no way to tell the two apart.
Enforcement is host-side only, by convention, and we must duplicate it server-side.**

Evidence, three parts.

*(a) The host hides it.* With all three tools returned over the wire, the
basic-host tool picker offered only two:

```
combobox "spike_big"
 option "spike_big" (selected)
 option "spike_show"
```

`spike_app_only` is absent. The filter is in the **host's own application code**,
`examples/basic-host/src/index.tsx:13`:

```ts
function isToolVisibleToModel(tool) {
  const result = McpUiToolMetaSchema.safeParse(tool._meta?.ui);
  const visibility = result.data.visibility;
  if (!visibility) return true;          // default: visible to model
  return visibility.includes("model");
}
```

applied at three call sites (`:150`, `:168`, `:283`).

*(b) The SDK does not enforce it.* `src/app-bridge.ts` exports
`isToolVisibilityAppOnly` / `isToolVisibilityModelOnly` (`:149`, `:163`) and then
**never calls them anywhere in the library**. `AppBridge.connect()`
(`src/app-bridge.ts:1860`) wires the app→server proxy as an unconditional
pass-through:

```ts
if (serverCapabilities.tools) {
  this.oncalltool = async (params, extra) =>
    this._client!.request({ method: "tools/call", params }, CallToolResultSchema,
                          { signal: extra.signal });
}
```

No visibility check, no allow-list. If a host forgets `isToolVisibleToModel`, the
app-only tool lands in the model's tool list.

*(c) The server cannot distinguish the callers.* The app-originated call and a
model-originated call are byte-for-byte indistinguishable at the server. Captured
`tools/call` params from the iframe:

```json
{ "_meta": { "progressToken": 1 }, "name": "spike_app_only",
  "arguments": { "caller": "iframe-card" } }
```

and its headers:

```json
{ "accept": "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-06-18",
  "origin": "http://localhost:8080",
  "sec-fetch-site": "same-site",
  "user-agent": "Mozilla/5.0 ... Claude/1.24012.9 ... Electron/42.7.0 ..." }
```

Same origin, same UA, same bearer credentials, same transport — because the
iframe's call is proxied through the host's *existing* MCP client. `progressToken`
is not a marker (a model client sets one too).

And a plain SDK client, with no app in the picture, called it successfully:

```
model-side call of app-only tool: {"ok":true,"calledBy":"MODEL (should be blocked!)", ...}
```

**Consequence for the send-approval design.** We cannot build a security boundary
out of `visibility: ["app"]` alone. If the plan is "only the card can approve a
send", the approval token must be something the model never sees:

- The card receives a short-lived, single-use `approval_token` in the
  `structuredContent` of the tool that rendered it, **and** that token must not
  appear in the `content` array (the `content` array goes to the model; a host
  that shows `structuredContent` to the model too would leak it — verify per host).
- Better: the card calls a dedicated app-only tool whose server handler derives
  authority from server-side state keyed to the tool-call id, not from anything
  the client supplies.
- Either way, the server-side handler for any app-only tool must additionally
  reject calls that lack that proof. `visibility` is a UI hint, treat it as one.

## Q3. Size ceiling

**No ceiling reached in basic-host up to 51.5 MB.** The practical limit is network
and edge-function cost, not the transport.

Bundled card baseline: the hello-world card built with `vite-plugin-singlefile`
plus the `@modelcontextprotocol/ext-apps` `App` class is **346 KB minified /
82 KB gzipped** for a page whose visible content is six buttons and some `<pre>`
blocks. Nearly all of it is the SDK + zod. That is the number to design around,
not the ~4 KB of our own markup.

Rendered successfully in basic-host, each verified by screenshot of the live card:

| padding | `resources/read` response bytes | result |
| --- | --- | --- |
| 0 KB | 358,589 | renders |
| 1,700 KB | ~2.1 MB | renders |
| 8,000 KB | 8,550,592 | renders |
| 50,000 KB | 51,558,593 | renders |

Local round-trip time for `resources/read` (loopback, so pure serialisation cost):

```
pad=0KB      wireBytes=358589    localRoundTrip=0.04s
pad=200KB    wireBytes=563391    localRoundTrip=0.09s
pad=1000KB   wireBytes=1382592   localRoundTrip=0.04s
pad=8000KB   wireBytes=8550592   localRoundTrip=0.07s
pad=50000KB  wireBytes=51558593  localRoundTrip=0.31s
```

Nothing degraded; the double-iframe `postMessage` + `srcdoc` path swallowed 50 MB.

**Recommended budget: keep each `ui://` bundle under 150 KB gzipped (~500 KB raw),
and treat 1 MB raw as a hard internal cap.** Rationale is not the host, it is
(a) Q4 — this is re-transferred on *every* tool call, from a Supabase edge
function, over the public internet; and (b) real hosts (Claude web/desktop) are
untested by this spike and may impose their own limit. Dropping the SDK for a
hand-written ~2 KB postMessage JSON-RPC shim (the SEP explicitly documents this,
`specification/draft/apps.mdx:434`) would take a card from 346 KB to under 20 KB
and is worth considering for Phase 1.

## Q4. Caching

**`resources/read` is issued once per tool call. No caching within a session, let
alone across sessions.**

Two consecutive `spike_show` invocations in the same page session, from
`spike.log.run2.jsonl`:

```
#21 tools/call:     {"name": "spike_show", "arguments": {}}
#25 resources/read: {"uri": "ui://spike/card", "bytes": 327710}
#29 tools/call:     {"name": "spike_show", "arguments": {}}
#33 resources/read: {"uri": "ui://spike/card", "bytes": 327710}
```

The `ServerInfo` type in `implementation.ts:26` even declares an
`appHtmlCache: Map<string, string>` — and `getUiResource()` (`:115`) never
consults it. Dead field.

Additionally, the app's *own* `resources/read` (the card's "resources/read(self)"
button) also hits the server as a fresh HTTP POST rather than being served from
anything the host already holds (`#28` then `#32` in the final clean run, same URI,
both 327,710 bytes).

`resources/list` is called exactly once, at connection setup, right after
`tools/list`.

The spec permits caching (`Host MAY prefetch and cache UI resource content`) but
the reference host does not. Design for zero caching. If bundles get large, serve
them with strong `ETag`-style versioning in the URI (`ui://mcpemails/inbox@v3`) so
hosts that *do* cache can do so safely, and keep the payload small enough that a
non-caching host is not painful.

## Q5. Stateless viability

**Confirmed: nothing in the app flow requires server-side session state.**

- No `Mcp-Session-Id` was ever sent or expected. Every logged request has
  `"mcpSessionId": null`.
- `initialize` happens **once per host page load**, not before each `tools/call`.
  Sequence from the clean run: `initialize` → `notifications/initialized` →
  `GET /mcp` (SSE attempt) → `tools/list` → `resources/list` → then N independent
  `tools/call` / `resources/read` POSTs.
- The iframe's proxied `tools/call` and `resources/read` arrive as **ordinary
  fresh HTTP POSTs on the same client**, carrying the identical headers and the
  identical bearer credentials the host attached at connect time. Nothing extra is
  needed; our existing per-request API-key auth covers them unchanged.
- Our server's `GET /mcp` → 405 (the SDK's optional SSE stream attempt) is logged
  by the browser as `net::ERR_ABORTED` and is harmless — the SDK falls through.
  Same for the `202` on `notifications/initialized`.

**The one stateless-incompatible gap is the missing `resources` capability.**
Reproduced deliberately with `SPIKE_NO_RESOURCES_CAP=1`, which makes the spike
return today's production capability object:

```json
{"protocolVersion":"2025-06-18",
 "capabilities":{"tools":{"listChanged":false},"prompts":{"listChanged":false}},
 "serverInfo":{"name":"mcp-apps-spike","version":"0.0.1"}}
```

The host itself still worked (the SDK's `enforceStrictCapabilities` is off by
default, so `client.listResources()` succeeded anyway and the card still
rendered). But from inside the iframe:

```
[SPIKE-CARD] resources/read FAILED McpError: MCP error -32601: Method not found
```

because `AppBridge.connect()` only registers `onreadresource` /`onlistresources`
when `serverCapabilities.resources` is truthy. Same gate exists on
`serverCapabilities.tools` for `oncalltool` — we already declare `tools`, so
`callServerTool` is fine. **Declare `resources`.**

## Q6. hostContext — what a real host actually provides

Captured live from `basic-host` inside the running card (screenshot evidence),
everything outside `styles`:

```json
{
  "theme": "dark",
  "displayMode": "inline",
  "availableDisplayModes": ["inline", "fullscreen"],
  "containerDimensions": { "maxHeight": 6000, "width": 695 },
  "platform": "web"
}
```

After clicking `requestDisplayMode({mode:"fullscreen"})` the same object became
`"displayMode": "fullscreen"` and `width` grew to `703`; the host also pushes a
`ui/notifications/host-context-changed` on every iframe resize (the card logged
`onhostcontextchanged containerDimensions` on each one).

**Not provided by basic-host at all:** `safeAreaInsets`, `locale`, `timeZone`,
`deviceCapabilities`, `userAgent`, `toolInfo`, `styles.css.fonts`. The frontend
must treat every one of these as optional with a sane default. Do not assume
`locale`/`timeZone` — format dates from data the server sends, or from the
browser, not from `hostContext`.

`hostCapabilities` / `hostInfo` as received:

```json
{
  "hostInfo": { "name": "MCP Apps Host", "version": "1.0.0" },
  "hostCapabilities": {
    "openLinks": {},
    "serverTools": { "listChanged": false },
    "serverResources": { "listChanged": false },
    "updateModelContext": { "text": {} }
  }
}
```

Note the absence of `sampling`, `downloadFile`, `logging` and `message`. The card's
`sendMessage()` (`ui/message`) nevertheless succeeded against this host — but a
correct app should check `hostCapabilities.message` before using it, since another
host may reject it.

`hostContext.styles.variables` is the full standardized set — 60 keys, matching the
SEP's `McpUiStyleVariableKey` union exactly, all values wrapped in CSS
`light-dark()`. Verbatim source: `examples/basic-host/src/host-styles.ts`. Sample:

```json
{
  "--color-background-primary": "light-dark(#ffffff, #1a1a1a)",
  "--color-background-secondary": "light-dark(#f5f5f5, #2d2d2d)",
  "--color-background-tertiary": "light-dark(#e5e5e5, #404040)",
  "--color-background-inverse": "light-dark(#1a1a1a, #ffffff)",
  "--color-background-ghost": "light-dark(rgba(255,255,255,0), rgba(26,26,26,0))",
  "--color-background-info": "light-dark(#eff6ff, #1e3a5f)",
  "--color-background-danger": "light-dark(#fef2f2, #7f1d1d)",
  "--color-background-success": "light-dark(#f0fdf4, #14532d)",
  "--color-background-warning": "light-dark(#fefce8, #713f12)",
  "--color-background-disabled": "light-dark(rgba(255,255,255,0.5), rgba(26,26,26,0.5))",
  "--color-text-primary": "light-dark(#1f2937, #f3f4f6)",
  "--color-text-secondary": "light-dark(#6b7280, #9ca3af)",
  "--color-text-tertiary": "light-dark(#9ca3af, #6b7280)",
  "--color-text-inverse": "light-dark(#f3f4f6, #1f2937)",
  "--color-text-ghost": "light-dark(rgba(107,114,128,0.5), rgba(156,163,175,0.5))",
  "--color-text-info": "light-dark(#1d4ed8, #60a5fa)",
  "--color-text-danger": "light-dark(#b91c1c, #f87171)",
  "--color-text-success": "light-dark(#15803d, #4ade80)",
  "--color-text-warning": "light-dark(#a16207, #fbbf24)",
  "--color-text-disabled": "light-dark(rgba(31,41,55,0.5), rgba(243,244,246,0.5))",
  "--color-border-primary": "light-dark(#e5e7eb, #404040)",
  "--color-border-secondary": "light-dark(#d1d5db, #525252)",
  "--color-border-tertiary": "light-dark(#f3f4f6, #374151)",
  "--color-border-inverse": "light-dark(rgba(255,255,255,0.3), rgba(0,0,0,0.3))",
  "--color-border-ghost": "light-dark(rgba(229,231,235,0), rgba(64,64,64,0))",
  "--color-border-info": "light-dark(#93c5fd, #1e40af)",
  "--color-border-danger": "light-dark(#fca5a5, #991b1b)",
  "--color-border-success": "light-dark(#86efac, #166534)",
  "--color-border-warning": "light-dark(#fde047, #854d0e)",
  "--color-border-disabled": "light-dark(rgba(229,231,235,0.5), rgba(64,64,64,0.5))",
  "--color-ring-primary": "light-dark(#3b82f6, #60a5fa)",
  "--color-ring-secondary": "light-dark(#6b7280, #9ca3af)",
  "--color-ring-inverse": "light-dark(#ffffff, #1f2937)",
  "--color-ring-info": "light-dark(#2563eb, #3b82f6)",
  "--color-ring-danger": "light-dark(#dc2626, #ef4444)",
  "--color-ring-success": "light-dark(#16a34a, #22c55e)",
  "--color-ring-warning": "light-dark(#ca8a04, #eab308)",
  "--font-sans": "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  "--font-mono": "ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "0.75rem",
  "--font-text-sm-size": "0.875rem",
  "--font-text-md-size": "1rem",
  "--font-text-lg-size": "1.125rem",
  "--font-heading-xs-size": "0.75rem",
  "--font-heading-sm-size": "0.875rem",
  "--font-heading-md-size": "1rem",
  "--font-heading-lg-size": "1.25rem",
  "--font-heading-xl-size": "1.5rem",
  "--font-heading-2xl-size": "1.875rem",
  "--font-heading-3xl-size": "2.25rem",
  "--font-text-xs-line-height": "1.4",
  "--font-text-sm-line-height": "1.4",
  "--font-text-md-line-height": "1.5",
  "--font-text-lg-line-height": "1.5",
  "--font-heading-xs-line-height": "1.4",
  "--font-heading-sm-line-height": "1.4",
  "--font-heading-md-line-height": "1.4",
  "--font-heading-lg-line-height": "1.3",
  "--font-heading-xl-line-height": "1.25",
  "--font-heading-2xl-line-height": "1.2",
  "--font-heading-3xl-line-height": "1.1",
  "--border-radius-xs": "2px",
  "--border-radius-sm": "4px",
  "--border-radius-md": "6px",
  "--border-radius-lg": "8px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  "--shadow-sm": "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
  "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  "--shadow-lg": "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)"
}
```

Real hosts may send a subset — the SEP is explicit that a host "can provide any
subset" — so **every variable needs a `var(--x, fallback)` default in our CSS.**

## Q7. Other things that would surprise a hand-rolled Deno implementation

1. **Host does not apply the theme for you.** Our card rendered light inside a
   dark-themed host, because the variables are `light-dark()` and the sandboxed
   iframe inherits the *system* color-scheme, not `hostContext.theme`. Apps must
   read `hostContext.theme`, write `color-scheme` / a `data-theme` attribute on
   `:root` themselves, and re-apply on `ui/notifications/host-context-changed`.
   ext-apps ships `applyDocumentTheme` / `applyHostStyleVariables` for this.
2. **Two `_meta.ui` locations, content wins.** `resources/list` entries and
   `resources/read` content items may both carry `_meta.ui`; the content item takes
   precedence and the host must check both (`implementation.ts:151`). Put it on
   **both** — listing-level lets a host review CSP at connect time, content-level is
   what actually gets enforced.
3. **`_meta` survives the SDK's zod parsing intact.** Verified at every supported
   protocol version — arbitrary nested objects under `_meta` pass through
   unmodified. No need to flatten.
4. **The deprecated flat key still works but is going away.** `_meta["ui/resourceUri"]`
   is read as a fallback (`app-bridge.ts:130`) and is documented as "removed before
   GA". Emit only `_meta.ui.resourceUri`.
5. **`getToolUiResourceUri` throws on a non-`ui://` URI**, it does not return
   undefined. A typo'd scheme takes down the host's tool list, not just one card.
6. **`resources/read` must return exactly one content item.** `implementation.ts:123`
   throws `Unexpected contents count` otherwise. And `mimeType` must be exactly
   `text/html;profile=mcp-app` — no space after the semicolon, no charset.
7. **`prefersBorder` and `csp` are the only `_meta.ui` resource fields with teeth
   in this host.** An omitted `csp` gets the restrictive default; an empty
   `connectDomains: []` means the card cannot `fetch()` anything, which is correct
   for us since all data arrives via `tools/call`.
8. **CORS must allow `mcp-protocol-version`, `mcp-session-id`, `last-event-id`.**
   The browser preflights `POST /mcp` from the host origin. Our production CORS
   config should be re-checked against this list.
9. **`notifications/initialized` gets a 202 with no body, and the browser reports
   `net::ERR_ABORTED` on it.** Cosmetic; the SDK does not care.
10. **The SDK opens a `GET /mcp` SSE stream and tolerates a 405.** No need to
    implement SSE.
11. **`content` vs `structuredContent`.** Both are delivered to the card in a
    single `ui/notifications/tool-result`. The `content` array is what the model
    reads. Anything sensitive intended only for the card belongs in
    `structuredContent`, and even then, confirm per-host whether structured content
    reaches the model before relying on it as a boundary.
12. **`ui/notifications/tool-input` fires before the result**, carrying the raw
    arguments. Register `ontoolinput`/`ontoolresult` **before** `app.connect()` —
    ext-apps warns (and will throw in a future release) if a first handler for a
    one-shot event is registered after the handshake.
13. **Bundle weight.** `App` + `@modelcontextprotocol/sdk` + zod = ~340 KB of the
    346 KB card. The SEP documents a dependency-free postMessage JSON-RPC pattern
    (`specification/draft/apps.mdx:434`) which is maybe 60 lines. Given Q4's
    re-fetch-per-call behaviour, seriously consider it.

---

## Wire format cheat sheet

Exactly what the spike emitted, verified working end-to-end.

### `initialize` result

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools":     { "listChanged": false },
      "prompts":   { "listChanged": false },
      "resources": { "listChanged": false, "subscribe": false }
    },
    "serverInfo": { "name": "mcp-emails", "version": "1.x.x" },
    "instructions": "..."
  }
}
```

The `resources` entry is the required addition. `subscribe: false` is honest — we
will not implement `resources/subscribe`.

### `tools/list` — a tool with a UI, visible to both (the default)

```json
{
  "name": "email_read",
  "title": "Read email",
  "description": "...",
  "inputSchema": { "type": "object", "properties": { "...": {} } },
  "_meta": {
    "ui": { "resourceUri": "ui://mcpemails/inbox" }
  }
}
```

Omit `visibility` to mean `["model","app"]`. Do not emit
`_meta["ui/resourceUri"]`.

### `tools/list` — an app-only tool

```json
{
  "name": "email_send_approved",
  "title": "Send approved draft",
  "description": "...",
  "inputSchema": { "type": "object", "properties": { "...": {} } },
  "_meta": {
    "ui": { "visibility": ["app"] }
  }
}
```

Reminder from Q2: **also filter this out of `tools/list` server-side and reject it
server-side unless the request carries app-only proof.** The host's filter is not a
boundary.

### `resources/list`

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resources": [
      {
        "uri": "ui://mcpemails/inbox",
        "name": "inbox_card",
        "description": "Inbox triage view",
        "mimeType": "text/html;profile=mcp-app",
        "_meta": {
          "ui": {
            "csp": {
              "connectDomains": [],
              "resourceDomains": [],
              "frameDomains": [],
              "baseUriDomains": []
            },
            "prefersBorder": true
          }
        }
      }
    ]
  }
}
```

### `resources/read`

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "contents": [
      {
        "uri": "ui://mcpemails/inbox",
        "mimeType": "text/html;profile=mcp-app",
        "text": "<!DOCTYPE html><html>...</html>",
        "_meta": {
          "ui": {
            "csp": {
              "connectDomains": [],
              "resourceDomains": [],
              "frameDomains": [],
              "baseUriDomains": []
            },
            "prefersBorder": true
          }
        }
      }
    ]
  }
}
```

Exactly one item. `text` (or `blob`, base64). Content-level `_meta.ui` wins over
listing-level.

### `tools/call` result

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "3 unread in Inbox" }],
    "structuredContent": {
      "items": [{ "id": 1, "subject": "Invoice #4021", "from": "billing@acme.test" }]
    }
  }
}
```

Both fields. `content` is the model-visible fallback for hosts without MCP Apps;
`structuredContent` is what the card renders.

### `resources/templates/list`

Return `{"resourceTemplates": []}`. The `AppBridge` proxies this method whenever
`resources` is declared, so an unhandled `-32601` will show up in app logs.

---

## Human verification checklist (Claude web / desktop)

**I did not test in Claude.** Everything above was measured against the official
`ext-apps` `basic-host` reference harness. The reference host is explicitly
minimal, and Claude's real host may differ on exactly the points that matter to
us. A human with a claude.ai login should confirm the following before Phase 1
locks its design. Point Claude at a Phase-1 preview deployment of the server (or
tunnel the spike server) and connect it as a custom connector.

1. **Does Claude send the extension capability?**
   Trigger any tool call, then read the server logs for the `initialize` params.
   *Working looks like:* `capabilities.extensions["io.modelcontextprotocol/ui"]`
   present with `mimeTypes: ["text/html;profile=mcp-app"]`.
   *Also acceptable:* absent — but then confirm the card still renders, which is
   the actual pass/fail. If it is present, record the exact object; it is the only
   reliable signal for conditional behaviour.

2. **Does the card render at all with `protocolVersion: "2025-06-18"` echoed?**
   Ask Claude to run the UI-bearing tool.
   *Working:* an inline card appears in the transcript instead of (or alongside)
   the tool-result text. *Failing:* text-only result, or a connector error.
   If it fails, re-test with `2025-11-25` echoed to isolate the cause — that
   single fact determines whether Phase 1 must bump `SUPPORTED_PROTOCOL_VERSION`.

3. **Is the app-only tool actually hidden from Claude?**
   In the same conversation, ask Claude directly: *"List every tool you have from
   this connector, exactly as named."*
   *Working:* `spike_app_only` (or its Phase-1 equivalent) is **not** in the list.
   Then ask Claude to call it by name anyway.
   *Working:* Claude reports it has no such tool. *Failing / must-know:* Claude
   calls it and the server executes it — record this, it changes the send-approval
   design.

4. **Is the app-only tool callable from inside the card?**
   Click the card's button that calls it.
   *Working:* result appears in the card. *Failing:* an error in the card, meaning
   Claude blocks app→server calls for tools it filtered out.

5. **Does `structuredContent` leak to the model?**
   Put a distinctive sentinel string (e.g. `SENTINEL-9F3A`) in `structuredContent`
   only, never in `content`. Then ask Claude: *"What is the value of the sentinel
   in that tool result?"*
   *Working (for our security model):* Claude cannot see it.
   *Failing:* Claude reads it back — then no secret may ever travel in
   `structuredContent`, and the approval token must be server-derived.

6. **Caching.** Call the same UI tool three times in one conversation, then start a
   new conversation and call it again. Count `resources/read` hits in the server
   log.
   *Expected from this spike:* 4 reads. *If fewer:* Claude caches, and we must
   version the `ui://` URI on every deploy or users will see stale cards.

7. **`hostContext` from Claude.** The card prints its full `hostContext` and
   `styles.variables`. Screenshot it.
   *What to capture:* whether `locale`, `timeZone`, `safeAreaInsets`,
   `deviceCapabilities`, `toolInfo` and `styles.css.fonts` are populated (basic-host
   omits all of them), and whether the variable *values* differ from the reference
   set above. Send that screenshot to whoever builds the card CSS.

8. **Display modes.** Click the card's `requestDisplayMode("fullscreen")` button.
   *Working:* the card expands and `hostContext.displayMode` flips to
   `"fullscreen"`. Note whether Claude also offers `"pip"` in
   `availableDisplayModes`.

9. **Size.** Deploy one card at ~500 KB raw and confirm it still renders in Claude
   web *and* desktop, and note the visible delay. This spike could not find a
   ceiling; Claude may have one.

10. **Mobile.** Repeat step 2 in the Claude mobile app if available.
    *What to capture:* `platform` value and whether `safeAreaInsets` appears.

---

## Re-running the spike

```
cd /private/tmp/claude-501/-Users-asgeiralbretsen-Repositories-MCPEmails/31ec7162-7a08-4a71-b024-c68e652c810d/scratchpad

# 1. spike MCP server (hand-rolled Deno, mirrors production shape)
cd apps-spike
deno run -A server.ts                      # :3001/mcp, logs to spike.log.jsonl and GET /log
#   env: SPIKE_PROTOCOL_VERSION (default 2025-06-18)
#        SPIKE_BIG_KB           (padding for ui://spike/big)
#        SPIKE_NO_RESOURCES_CAP=1  reproduce today's production capabilities
#        SPIKE_PORT

# 2. the card bundle (only needed if card/main.ts changed)
cd card && npm install && npx vite build   # -> card/dist/index.html

# 3. ext-apps basic-host reference harness (already built)
./run-host.sh                              # :8080 host, :8091 sandbox proxy
#   NOTE: sandbox was moved off the default :8081 (occupied on this machine);
#   SANDBOX_PROXY_BASE_URL in ext-apps/examples/basic-host/src/implementation.ts:10
#   was edited to :8091 and the host re-bundled.

# 4. protocol-version matrix (needs spike servers on :3001-:3004)
node probe.mjs

# 5. size sweep
./size-probe.sh 8000                       # restarts server with 8 MB padding
```

Files:

- `apps-spike/server.ts` — the spike MCP server
- `apps-spike/card/{index.html,main.ts,vite.config.ts}` — the card, bundled single-file
- `apps-spike/probe.mjs` — protocol-version / visibility probe
- `apps-spike/size-probe.sh`, `apps-spike/run-host.sh`
- `apps-spike/spike.log.jsonl` — live log; `spike.log.run1/run2/run3-no-resources-cap.jsonl` — captured runs
- `ext-apps/` — shallow clone of `modelcontextprotocol/ext-apps` @ `92f46a5`

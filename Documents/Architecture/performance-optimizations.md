# Performance Optimizations

## Purpose

This document records the concrete performance decisions made for MCPEmails — a Next.js 15 + Supabase SaaS that exposes connected email accounts to AI agents via the Model Context Protocol. It is a reference for developers implementing features and for agents picking tasks from the checklist, not a wishlist. Every recommendation here has a specific rationale tied to the system's architecture.

---

## 1. Performance Goals

MCPEmails has two distinct performance surfaces with different user expectations:

| Surface | Metric | Target | Rationale |
|---------|--------|--------|-----------|
| MCP tool calls | p95 end-to-end latency | < 500 ms | AI agents block waiting for tool results; slow tools reduce agentic throughput and hit MCP client timeouts |
| Dashboard pages | Largest Contentful Paint (LCP) | < 1 s | Standard SaaS baseline; users are comparing email providers in-product |
| Dashboard pages | Time to First Byte (TTFB) | < 200 ms | Achieved via Server Components rendering on edge-adjacent Vercel regions |
| MCP tool calls | p99 end-to-end latency | < 2 s | Tail-latency budget covering token refresh + IMAP connect on cold paths |
| API key validation | Duration | < 20 ms | Authentication must not dominate the 500 ms MCP budget |
| Dashboard inbox list | TTFB | < 150 ms | Server Component renders list in a single DB query with no waterfalls |
| Email HTML rendering | Parse + sanitise | < 100 ms | Capped by the 50 KB body truncation described in section 9 |

The 500 ms MCP p95 target is the master constraint that drives almost every other decision below.

---

## 2. Performance Budget Table

| Component | Budget | How Measured |
|-----------|--------|--------------|
| API key bcrypt comparison | 40–60 ms | bcrypt cost=12 on 2 vCPU Edge Function |
| Supabase `api_keys` lookup | 5–10 ms | Indexed `key_hash` lookup via PgBouncer |
| Supabase `inboxes` credential load | 5–10 ms | Indexed `workspace_id` + `id` lookup |
| Gmail API single message fetch | 100–250 ms | Median observed; varies by message size |
| Microsoft Graph single message fetch | 100–300 ms | Graph is typically slower than Gmail API |
| IMAP connect + FETCH (Fastmail) | 150–400 ms | TLS handshake + IMAP greeting + SELECT + FETCH |
| `activity_log` INSERT | 5–10 ms | Partition-local insert, no index lock contention |
| Total MCP tool call (Gmail) | ~220–370 ms | Auth + DB + API, fits comfortably under 500 ms |
| Total MCP tool call (IMAP) | ~250–530 ms | Auth + DB + IMAP; tail at p99 may exceed 500 ms |
| Edge Function cold start | < 100 ms | After bundle size controls (section 2) |
| Next.js Server Component render | < 50 ms | Single non-waterfall DB query |
| Client JS bundle per route | < 50 KB gzipped | Code splitting at route level (section 7) |

---

## 3. Edge Function Cold Starts

### Context

The MCP server runs as a Supabase Edge Function (Deno runtime on V8 isolates). Supabase Edge Functions use the same cold-start dynamics as Cloudflare Workers: the isolate is created on first request after an idle period, and the entire module graph must be parsed and initialised before the first request is handled. A cold start that takes 500 ms would consume the entire MCP latency budget before any business logic runs.

### Bundle Size Budget

The `mcp-server` Edge Function must stay under **500 KB uncompressed** (the Supabase Edge Function bundle limit is 2 MB, but cold start time scales with parsed code size). The practical ceiling for sub-100 ms cold starts on Deno is approximately 500 KB.

**Prohibited dependencies in the MCP Edge Function:**

| Dependency | Why prohibited | Alternative |
|-----------|---------------|-------------|
| `nodemailer` | ~350 KB, Node.js-specific | Use `fetch()` against the SMTP-over-HTTP gateway or Gmail API |
| `cheerio` | ~700 KB | `DOMParser` (available in Deno) for HTML sanitisation |
| `lodash` | ~70 KB (even tree-shaken) | Native array/object methods |
| `moment` | ~280 KB | `Temporal` API or `date-fns` with tree-shaking |
| `imap` (npm package) | Node.js `net` module dependency; not available in Deno | `Deno.connectTls()` raw IMAP implementation |
| `googleapis` (full SDK) | ~2 MB total | Direct `fetch()` calls to the Gmail REST API |

**Allowed dependencies:**

- `@modelcontextprotocol/sdk` — the MCP SDK is the foundation; bundle size must be verified after each SDK upgrade
- `@supabase/supabase-js` — use the ESM build; verify no `node:` imports leak in
- `jose` — JWT validation for future token introspection; <30 KB
- Hand-rolled IMAP client — Deno `Deno.connectTls()` + a minimal IMAP command set; approximately 8–12 KB

### Bundle Monitoring

Add a CI step that runs `deno bundle` on the Edge Function entrypoint and fails the build if the output exceeds 500 KB:

```bash
# In CI (GitHub Actions)
deno bundle supabase/functions/mcp-server/index.ts /tmp/mcp-bundle.js
BUNDLE_SIZE=$(wc -c < /tmp/mcp-bundle.js)
echo "Bundle size: ${BUNDLE_SIZE} bytes"
if [ "$BUNDLE_SIZE" -gt 512000 ]; then
  echo "ERROR: MCP Edge Function bundle exceeds 500 KB limit"
  exit 1
fi
```

### Warming Strategies

Edge Function isolates are created on demand. There is no persistent process to keep warm between requests. The strategies available within Supabase's constraints are:

1. **Scheduled keep-alive ping**: A Supabase cron job (pg_cron) fires a lightweight `GET /health` request to the MCP Edge Function every 5 minutes. This is the cheapest warming option and keeps the isolate alive during business hours when AI agents are actively running.

2. **Minimise import side effects**: Any module-level code that runs at import time (e.g., reading environment variables, establishing database connections) delays the first response. Import-time work should be limited to constant definitions. Database connections and credential lookups must happen inside the request handler.

3. **Do not pre-connect to IMAP at import time**: IMAP connections must be established per-request anyway (see section 4), so no warmth is gained from attempting an early connect.

4. **Edge Function region pinning**: Deploy the MCP Edge Function in the same Supabase region as the database (e.g., `us-east-1`). This eliminates cross-region latency on the Supabase internal connection and is configured via `supabase/config.toml`.

---

## 4. Database Query Optimisation

### Index Definitions

The following indexes are required and must be created before the application goes to production. They correspond directly to the hot query paths in the MCP request lifecycle.

```sql
-- 1. API key authentication: look up a key by its bcrypt hash
-- Used on every single MCP tool call during bearer token validation.
-- Without this index, auth would perform a sequential scan of all api_keys rows.
-- Partial index excludes revoked keys (deleted_at IS NOT NULL) to keep the
-- working set small — revoked keys are never authenticated.
CREATE UNIQUE INDEX idx_api_keys_key_hash_active
  ON public.api_keys (key_hash)
  WHERE deleted_at IS NULL;

-- 2. Rate limit enforcement: count recent calls per API key
-- The rate limiter queries: SELECT COUNT(*) FROM activity_log
--   WHERE api_key_id = $1 AND created_at > now() - interval '1 minute'
-- This composite index covers both predicates and avoids a full partition scan.
-- Because activity_log is partitioned by created_at, the planner prunes to
-- the current month's partition automatically; the index accelerates the
-- remaining equality + range filter within that partition.
CREATE INDEX idx_activity_log_api_key_id_created_at
  ON public.activity_log (api_key_id, created_at DESC);

-- 3. Inbox credential load: fetch inbox config for a specific workspace
-- Used in MCP tool calls after API key validation to load the correct inbox.
-- The MCP request carries inbox_id explicitly; this index supports queries
-- of the form: WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
-- The workspace_id leading column aligns with RLS policy evaluation.
CREATE INDEX idx_inboxes_workspace_id
  ON public.inboxes (workspace_id)
  WHERE deleted_at IS NULL;

-- 4. Inbox list on dashboard: list all active inboxes for a workspace
-- Composite index supporting: WHERE workspace_id = $1 AND status = 'active'
-- Dashboard inbox list renders as a Server Component; this single-query index
-- prevents a sequential scan of all inboxes across all workspaces.
CREATE INDEX idx_inboxes_workspace_id_status
  ON public.inboxes (workspace_id, status)
  WHERE deleted_at IS NULL;

-- 5. OAuth token refresh job: find tokens expiring within the next 10 minutes
-- Used by the scheduled Edge Function, not on the hot MCP path.
-- The partial index condition eliminates inactive and IMAP inboxes entirely,
-- keeping the scanned set to active OAuth-based inboxes only.
CREATE INDEX idx_inboxes_token_expires_active
  ON public.inboxes (oauth_token_expires_at)
  WHERE status = 'active' AND provider IN ('gmail', 'outlook');

-- 6. Dashboard activity feed: most recent events per workspace
-- Supports: SELECT ... FROM activity_log WHERE workspace_id = $1
--           ORDER BY created_at DESC LIMIT 50
-- Needs to be created on the partitioned parent — Postgres propagates to
-- all existing and future child partitions automatically.
CREATE INDEX idx_activity_log_workspace_id_created_at
  ON public.activity_log (workspace_id, created_at DESC);

-- 7. API key list on dashboard: list all keys for a workspace
-- Supports the settings page key list: WHERE workspace_id = $1 AND deleted_at IS NULL
CREATE INDEX idx_api_keys_workspace_id_active
  ON public.api_keys (workspace_id)
  WHERE deleted_at IS NULL;
```

### Why Each Index Exists

**`idx_api_keys_key_hash_active`**: Authentication is the first operation on every MCP tool call. bcrypt comparison already costs 40–60 ms; an unindexed scan would add an additional sequential scan proportional to the number of API keys in the system. At 10,000 keys this becomes a serious latency problem. The unique partial index reduces the scan to a single b-tree lookup.

**`idx_activity_log_api_key_id_created_at`**: The rate limiter must count calls within the last 60 seconds before allowing a tool call to proceed. Without this index, the count query on a busy partition would scan every row for the current month for that key. The composite index with `created_at DESC` means the planner can use an index range scan and stop early after counting enough rows.

**`idx_inboxes_workspace_id`**: After validating the API key, the MCP server loads the inbox record to decrypt credentials. Even though the query also filters by `id` (the primary key), the RLS policy appends a `workspace_id` predicate that must be satisfied for the query to return rows. Leading with `workspace_id` aligns with how the planner evaluates RLS-augmented queries.

**`idx_inboxes_workspace_id_status`**: The dashboard inbox list is the first page most users see. This index makes the common read path — "show me my active inboxes" — a fast index scan rather than a heap scan filtered by status.

### Avoiding N+1 Queries

The dashboard must not issue one query per inbox to fetch status information. The inbox list page should load everything it needs in a single query:

```typescript
// Correct — one query for the inbox list page
const { data: inboxes } = await supabase
  .from('inboxes')
  .select('id, email_address, display_name, provider, status, last_sync_at, last_error')
  .eq('workspace_id', workspaceId)
  .is('deleted_at', null)
  .order('created_at', { ascending: true });
```

Do not subsequently loop over `inboxes` and query `activity_log` for each one to get the last-used time. Instead, include a subquery or join in the single load, or accept that `last_sync_at` on the inbox row itself is sufficient for the list view.

### Query Column Projection

Never use `SELECT *` on `inboxes`. The `oauth_access_token`, `oauth_refresh_token`, and `imap_password` columns are `bytea` blobs up to several hundred bytes each. Fetching them on every list query wastes bandwidth and — more importantly — risks accidentally including plaintext blobs in logs if a query error serialises the row. Only request encrypted columns when the credential is about to be used for a live email operation.

---

## 5. Connection Reuse

### Why IMAP Connections Cannot Be Pooled Across Invocations

IMAP is a stateful, session-oriented protocol (RFC 9051). An authenticated IMAP session exists for the lifetime of a TCP connection. Supabase Edge Functions run in short-lived V8 isolates; each invocation starts fresh with no shared memory or persistent sockets from previous invocations.

The following approaches are not viable:

- **Global IMAP connection object in module scope**: The variable would be initialised once per isolate instance, but isolates are not guaranteed to be reused between requests. Supabase may spin up a new isolate for any request; the connection object in the old isolate is garbage collected along with the TCP socket.
- **External connection pool (e.g., a long-running Node.js proxy)**: Would require operating additional infrastructure, undermining the serverless model. The latency from the Edge Function to the proxy and back to Fastmail would likely exceed the latency of a direct connect.
- **Supabase Realtime as a proxy**: Not designed for IMAP traffic.

The consequence is that every IMAP-based tool call must pay the full connection cost: TCP connect, TLS handshake, IMAP server greeting, LOGIN or AUTHENTICATE command, mailbox SELECT, and then the actual command (FETCH, SEARCH, etc.).

On Fastmail, this round-trip takes 150–400 ms measured from Supabase's `us-east-1` region. This eats into the 500 ms MCP budget significantly.

### Minimising IMAP Connect Time

Given that IMAP connections cannot be pooled, the goal is to minimise the per-connection overhead:

1. **Prefer provider API over IMAP where possible**: Gmail and Outlook both expose REST APIs (Gmail API, Microsoft Graph) that are stateless, accept a bearer token, and return JSON. These avoid the TCP + TLS + IMAP handshake entirely. IMAP is used only for Fastmail and generic IMAP providers where no REST API exists.

2. **Pipeline IMAP commands**: After LOGIN succeeds, do not wait for each response before sending the next command. IMAP supports command pipelining. Issue SELECT, then FETCH, without waiting for the SELECT response if the server is known to support it (virtually all servers do). This halves the round-trip count.

3. **Avoid IMAP LIST when possible**: The mailbox list (LIST "" "*") is expensive on accounts with many folders. The inbox is always "INBOX"; use the literal mailbox name unless the user is requesting folder operations.

4. **Use UID-based operations**: IMAP UIDs are stable across sessions. Use `UID FETCH` and `UID SEARCH` so that message references returned by one tool call remain valid in subsequent calls without re-scanning the mailbox.

5. **Connect with TLS directly (IMAPS on port 993)**: Avoid the STARTTLS upgrade path (port 143 + STARTTLS command), which adds one extra round-trip. All Fastmail connections use IMAPS port 993.

6. **Set aggressive socket timeouts**: An IMAP server that is slow to respond should not be allowed to hold the Edge Function invocation for its full timeout window. Set a 3-second connect timeout and a 5-second command timeout. If either fires, return a structured error to the MCP client immediately.

---

## 6. Response Caching

Edge Functions have no persistent memory between invocations. This limits caching to within-invocation state and to strategies that use an external store. The table below records what is cached, where, and for how long.

| Data | Cached? | Location | TTL | Reason |
|------|---------|----------|-----|--------|
| `tools/list` response | Yes | HTTP response header (`Cache-Control`) | 60 seconds | The tool list for a given API key is static — it derives from the key's scopes, which change only when a user edits the key. A 60 s client-side cache reduces redundant `tools/list` calls from agents that initialise frequently. Keyed by `Authorization` header. |
| Token validation result | Yes | In-memory, within invocation | Request lifetime | Once the bearer token is validated and the `api_keys` row is loaded, the result is stored in a local variable and reused within the same request. No re-query to `api_keys` is needed mid-invocation. |
| Email list | No | — | — | Email lists must always reflect the current mailbox state. An agent asking "do I have new messages?" must get a live answer. Returning a stale list would break the semantic contract. |
| Individual email body | No | — | — | Email content changes (labels, read state, flagging). The cost of serving stale content (agent acts on an already-deleted email) exceeds the performance saving. |
| OAuth access token (decrypted) | Yes | In-memory, within invocation | Request lifetime | The decrypted token is used for one or more API calls within a single invocation. It must not be written to any external store — only to the local variable within the handler. |
| `inboxes` row (without credentials) | Conditional | HTTP `Cache-Control: private, max-age=30` | 30 seconds | The inbox metadata (display name, status, provider) changes rarely. Dashboard list requests can carry a 30 s private cache. The MCP tool call path does not cache the inbox row because it also needs the credentials, which must not be cached externally. |
| Rate limit counter | External | Supabase `activity_log` | Real-time | Rate limit enforcement reads from the live `activity_log` partition, not a cache. A cache here would allow over-limit calls to succeed during a cache window, violating the 100/minute cap. |

### `tools/list` Caching Detail

The MCP Edge Function should respond to `tools/list` with:

```
Cache-Control: private, max-age=60
Vary: Authorization
```

This tells the MCP client (e.g., Claude Desktop) that the tool list is valid for 60 seconds for this specific API key. The client will not re-request the list on every tool call, reducing unnecessary round-trips. After 60 seconds the client re-validates, which is fast (the Edge Function returns the same list unless scopes have changed).

Do not cache `tools/list` in a shared cache (CDN, Vercel Edge Cache) because different API keys have different scopes. The `Vary: Authorization` header is set as a defence-in-depth measure in case a shared cache is inadvertently placed upstream.

---

## 7. Batch Operations

### Gmail Batch API

The Gmail REST API supports batching up to 100 individual requests into a single HTTP request using the multipart batch format (`POST https://www.googleapis.com/batch/gmail/v1`). Each sub-request is a complete HTTP request (method, path, headers, body) encoded as a MIME part.

Use batching when an MCP tool call or an email list operation requires fetching multiple message bodies. For example, a `list_inbox` call that returns the 20 most recent messages with preview text requires 20 individual `messages.get` calls — or 1 batch call with 20 sub-requests.

```typescript
// Build a batch request for multiple Gmail messages
async function batchFetchGmailMessages(
  accessToken: string,
  messageIds: string[]
): Promise<GmailMessage[]> {
  const boundary = 'batch_boundary_' + crypto.randomUUID().replace(/-/g, '');

  const parts = messageIds.map((id) =>
    [
      `--${boundary}`,
      'Content-Type: application/http',
      '',
      `GET /gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject,From,Date`,
      '',
    ].join('\r\n')
  );

  const body = parts.join('\r\n') + `\r\n--${boundary}--`;

  const response = await fetch('https://www.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    },
    body,
  });

  return parseGmailBatchResponse(await response.text(), boundary);
}
```

**Batch size limit**: Gmail API accepts up to 100 sub-requests per batch. Do not exceed this. For lists longer than 100, split into multiple batch calls (each batch is still a single HTTP round-trip).

**Quota impact**: A batch of 10 message fetches counts as 10 API quota units (not 1). Batching saves HTTP overhead and latency, not quota.

### Microsoft Graph `$batch`

Microsoft Graph supports JSON batching: a single `POST https://graph.microsoft.com/v1.0/$batch` request containing an array of up to 20 individual requests.

```typescript
async function batchFetchGraphMessages(
  accessToken: string,
  messageIds: string[]
): Promise<GraphMessage[]> {
  // Graph batch limit is 20 per request
  const chunks = chunkArray(messageIds, 20);
  const results: GraphMessage[] = [];

  for (const chunk of chunks) {
    const requests = chunk.map((id, index) => ({
      id: String(index + 1),
      method: 'GET',
      url: `/me/messages/${id}?$select=id,subject,from,receivedDateTime,bodyPreview`,
    }));

    const response = await fetch('https://graph.microsoft.com/v1.0/$batch', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });

    const { responses } = await response.json();
    results.push(...responses.map((r: any) => r.body));
  }

  return results;
}
```

**Graph batch limit**: 20 requests per `$batch` call. For a list of 100 messages, this requires 5 batch calls. However, 5 batch calls over 100 individual calls is still a major improvement: 5 round-trips versus 100.

**Throttling in batch responses**: Each sub-request in a Graph batch can individually return a 429 status. Check the `status` field of each response object, not just the outer HTTP response code. A 429 sub-response includes a `Retry-After` header in the sub-response headers.

### IMAP Batch Fetch

IMAP does not have a batch API in the REST sense, but IMAP's `FETCH` command natively supports a sequence set — a comma-separated or range notation for fetching multiple messages in one command:

```
UID FETCH 1001,1005,1009,1012 (RFC822.HEADER)
UID FETCH 1001:1020 (FLAGS RFC822.SIZE)
```

Always use a sequence set when fetching multiple messages rather than issuing separate `UID FETCH` commands in a loop. The server processes the entire set and streams responses without the client needing to wait for each one.

---

## 8. Next.js Performance

### Server Components Reducing Client JS Bundle

Next.js 15 Server Components execute on the server and send HTML to the client. JavaScript for rendering the component is never sent to the browser. For MCPEmails, the following components must be Server Components:

- `InboxList` — reads workspace inboxes from Supabase and renders the list; no client interactivity needed on the list itself
- `ActivityFeed` (initial load) — the first 50 events are server-rendered; subsequent live updates use a thin Client Component wrapper subscribed to Supabase Realtime
- `ApiKeyList` — reads and renders keys; key revocation uses a Server Action, not client state
- `WorkspaceSettings` — form-based, uses Server Actions for mutation

Marking these as Server Components eliminates their render JavaScript from the client bundle. The client bundle for the dashboard should contain only components that genuinely need client interactivity: the real-time activity feed subscription, the API key copy button, and form validation state.

### Code Splitting at Route Level

Each Next.js `app/` route segment is a separate chunk. The router lazy-loads chunks as the user navigates. No route should load more than **50 KB of gzipped JavaScript** (excluding shared infrastructure such as React itself).

Verify with `next build --profile` and check the `.next/analyze/` output. If a route exceeds 50 KB, investigate with `@next/bundle-analyzer`:

```javascript
// next.config.ts
import bundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

export default withBundleAnalyzer({
  // ...
});
```

```bash
ANALYZE=true next build
```

### Image Optimisation

Use `next/image` for all images. Key settings:

- `priority` on the logo/hero image above the fold (eliminates render-blocking LCP)
- `sizes` attribute for responsive images so the browser requests the correct resolution
- WebP format is the default with AVIF as an optional future improvement
- Hero images must be under 100 KB; thumbnails (provider icons, avatars) under 10 KB

Email provider icons (Gmail, Outlook, Fastmail) are SVGs served as static assets — no `next/image` needed; they do not benefit from raster optimisation.

### Font Subsetting

MCPEmails uses a single variable font (Inter). Configure font subsetting to include only the Latin character set, removing Cyrillic, Greek, Vietnamese, and other ranges that are not used in the UI:

```typescript
// app/layout.tsx
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],           // only Latin subset
  display: 'swap',              // show fallback font while Inter loads
  variable: '--font-inter',     // CSS variable for design token use
  preload: true,
});
```

The `subsets: ['latin']` option reduces the font payload from ~180 KB to ~30 KB. `display: 'swap'` prevents invisible text during font load (FOIT), keeping the LCP element visible.

---

## 9. Supabase Query Patterns

### Select Only Needed Columns

This is enforced across the codebase as a rule, not a recommendation. Every Supabase query must explicitly list the columns it needs.

**Wrong:**
```typescript
const { data } = await supabase.from('inboxes').select('*');
```

**Correct:**
```typescript
const { data } = await supabase
  .from('inboxes')
  .select('id, email_address, display_name, provider, status, last_sync_at');
```

The practical impact: the `inboxes` table contains `oauth_access_token` and `oauth_refresh_token` as `bytea` columns (AES-256-GCM ciphertext). Fetching them unnecessarily adds payload weight, increases serialisation time, and risks them appearing in error logs. They should only be fetched in the MCP credential-load path and the token-refresh Edge Function.

### Avoid N+1 in Dashboard Queries

The dashboard activity feed shows the 50 most recent tool calls with the associated inbox name and API key name. Do not load the activity log rows and then loop to fetch each `inbox.display_name` and `api_key.name`:

**Wrong (N+1 pattern):**
```typescript
const { data: events } = await supabase
  .from('activity_log')
  .select('*')
  .eq('workspace_id', workspaceId)
  .order('created_at', { ascending: false })
  .limit(50);

// N+1: one query per event
for (const event of events) {
  event.inboxName = (await supabase.from('inboxes').select('display_name').eq('id', event.inbox_id).single()).data?.display_name;
}
```

**Correct (single query with embedded select):**
```typescript
const { data: events } = await supabase
  .from('activity_log')
  .select(`
    id,
    tool_name,
    status,
    duration_ms,
    created_at,
    inboxes ( display_name, provider ),
    api_keys ( name, key_prefix )
  `)
  .eq('workspace_id', workspaceId)
  .order('created_at', { ascending: false })
  .limit(50);
```

Supabase's embedded select syntax translates to a single SQL query with JOINs. The result is one round-trip instead of 51.

### RLS-Safe Indexed Queries

Supabase RLS policies evaluate on every query. Policies on tenant-scoped tables use the form:

```sql
USING (workspace_id = (
  SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid() LIMIT 1
))
```

The planner evaluates this subquery once per query (not once per row) when it is correctly written. However, the WHERE clause in the application query must also include `workspace_id` explicitly — do not rely solely on RLS to provide the workspace filter. The explicit application-level filter allows the planner to use the composite index (e.g., `idx_inboxes_workspace_id_status`) without an extra RLS-driven predicate layer that the planner cannot always push down efficiently.

Always pass `workspace_id` as an explicit `.eq()` filter on any query against a workspace-scoped table.

---

## 10. Email HTML Truncation

### The 50 KB Limit

Email HTML bodies are truncated to **50 KB** before sanitisation. This is a hard limit enforced in the MCP `read_email` tool handler before any HTML parsing begins.

**Why 50 KB:**

- Sanitising HTML requires building a DOM tree. A 2 MB marketing email with inline images encoded as data URIs can produce a DOM with tens of thousands of nodes. Parsing this in a short-lived Edge Function invocation exhausts the 128 MB memory limit and significantly increases execution duration.
- The MCP response payload is included in the JSON-RPC response body. MCP clients (Claude Desktop, Claude Code) impose their own limits on tool result size. A 2 MB HTML blob in a tool result causes clients to truncate or reject it.
- For the purpose of AI agents working with email content, 50 KB of rendered text is sufficient. Agents reading email look for actionable content, not pixel-perfect HTML rendering.
- The 50 KB limit is applied to the raw HTML string, before sanitisation removes tags. The sanitised plain-text output will be smaller (typically 30–60% of raw HTML size, depending on tag density).

**Implementation:**

```typescript
const MAX_BODY_BYTES = 50 * 1024; // 50 KB

function truncateEmailBody(rawHtml: string): { body: string; truncated: boolean } {
  if (rawHtml.length <= MAX_BODY_BYTES) {
    return { body: rawHtml, truncated: false };
  }

  // Truncate at a UTF-8 character boundary (JavaScript strings are UTF-16;
  // slice by character count is safe for the byte-size approximation at
  // this scale because ASCII-heavy HTML will be close to 1 byte per char).
  const truncated = rawHtml.slice(0, MAX_BODY_BYTES);
  return { body: truncated, truncated: true };
}
```

When `truncated: true`, the `read_email` tool response includes a `truncated` flag in the result metadata:

```json
{
  "id": "msg_abc123",
  "subject": "Q3 Financial Report",
  "body": "...(first 50 KB of HTML)...",
  "bodyTruncated": true,
  "bodyTruncatedAt": 51200
}
```

### What Clients Should Do When `bodyTruncated: true`

The MCP client (AI agent) should check the `bodyTruncated` flag in the tool result. The recommended handling:

1. **For informational reads**: If the agent is extracting key information (sender, subject, a specific piece of data), 50 KB is almost always sufficient. Proceed without requesting the full body.

2. **To retrieve the full body**: The MCP server should expose a `get_email_raw` tool (scope: `read:email`) that returns the full message body as a Base64-encoded MIME message or a direct download URL. The client calls this tool when the full content is needed, accepting that the response may be large and slow. This is a deliberate opt-in, not the default path.

3. **Do not retry `read_email` expecting more content**: The truncation is deterministic at 50 KB; retrying will return the same truncated result.

4. **Attachment content is always separate**: Attachment bodies are never included in `read_email` regardless of size. Use the `get_attachment` tool, which returns a signed Supabase Storage URL for the attachment binary. Attachment metadata (filename, MIME type, size in bytes) is always included in `read_email`.

---

## 11. Monitoring Performance

### Metrics to Track

Effective performance monitoring requires three layers of instrumentation:

**1. Edge Function Execution Duration**

Supabase Edge Function logs include execution duration per invocation. In addition, the MCP server should emit structured timing data in its response headers and in the `activity_log` row:

- `X-MCP-Auth-Ms`: time spent on bcrypt comparison and DB lookup (target: < 70 ms)
- `X-MCP-Provider-Ms`: time spent on Gmail/Graph/IMAP operation (target: < 350 ms)
- `X-MCP-Total-Ms`: total invocation time (target: < 500 ms p95)

The `activity_log.duration_ms` column stores the total invocation duration for every tool call. This enables offline p95/p99 analysis in Supabase Studio or exported to an analytics platform.

**2. Database Query Time**

Supabase's `pg_stat_statements` extension tracks cumulative execution time and call counts per query. Enable slow query logging (threshold: 100 ms) to catch regressions before they affect users:

```sql
-- Enable slow query logging in Supabase dashboard or via SQL
ALTER SYSTEM SET log_min_duration_statement = 100; -- log queries > 100ms
SELECT pg_reload_conf();
```

Queries to monitor specifically:
- `api_keys` key-hash lookup (expect: < 5 ms)
- `activity_log` rate-limit count (expect: < 10 ms)
- `inboxes` credential load (expect: < 5 ms)
- `activity_log` INSERT (expect: < 10 ms)

**3. Provider API Latency**

Instrument each provider call with a timer:

```typescript
async function callGmailWithTiming(
  method: string,
  params: object,
  accessToken: string
): Promise<{ result: unknown; durationMs: number }> {
  const start = performance.now();
  try {
    const result = await callGmailAPI(method, params, accessToken);
    return { result, durationMs: Math.round(performance.now() - start) };
  } catch (error) {
    // Still record timing even on failure
    throw Object.assign(error as Error, {
      durationMs: Math.round(performance.now() - start),
    });
  }
}
```

Log `durationMs` to the `activity_log` row (the current schema stores this in `duration_ms` on the outer invocation; add a `provider_duration_ms` column in a future migration to distinguish auth time from provider time).

### Alerting Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| MCP tool call p95 duration | > 400 ms | > 800 ms | Investigate provider latency; check for unindexed queries |
| MCP tool call error rate | > 1% | > 5% | Check provider API status; inspect `activity_log.error_code` distribution |
| Rate limit hits | > 50/hour per workspace | > 200/hour per workspace | Contact workspace owner; consider raising limit or investigating runaway agent |
| DB query duration p99 | > 50 ms | > 200 ms | Run `EXPLAIN ANALYZE` on the slow query; check for missing indexes |
| Edge Function cold start rate | > 10% of requests | > 30% | Increase keep-alive ping frequency; investigate isolate eviction |
| 429 responses from providers | > 3/hour per inbox | > 20/hour per inbox | Back off the agent; alert user that inbox is being hammered |

### Dashboard Performance Monitoring

For the Next.js dashboard, monitor Core Web Vitals using Vercel Analytics (included in all Vercel plans):

- **LCP**: Target < 1 s. Regression alert if LCP exceeds 2 s at p75.
- **INP (Interaction to Next Paint)**: Target < 200 ms. Alert if > 500 ms.
- **CLS**: Target < 0.05. Any layout shift after initial load is a bug to fix.

Vercel Analytics data is sampled from real users in production. Do not rely solely on Lighthouse scores in CI — real-world network and device variance matters. Run `next build && next start` locally on a throttled connection (Chrome DevTools > Network > Fast 4G) for pre-merge checks.

### Rate Limit Hit Logging

Every 429 response from a provider must be logged with enough context to diagnose the cause:

```typescript
function logRateLimitHit(
  provider: 'gmail' | 'outlook' | 'fastmail',
  endpoint: string,
  retryAfterMs: number,
  apiKeyId: string,
  inboxId: string
): void {
  console.warn(JSON.stringify({
    event: 'provider_rate_limit',
    provider,
    endpoint,
    retryAfterMs,
    apiKeyId,
    inboxId,
    timestamp: new Date().toISOString(),
  }));
  // The activity_log INSERT for this invocation will carry status='rate_limited'
  // and error_code='provider_429_<provider>'
}
```

Set an alert if `provider_rate_limit` events exceed 3 per hour for any single inbox. Frequent rate-limit hits indicate an agent that is calling email tools in a tight loop — this is a misuse pattern that should be surfaced to the user.

---

## Appendix: Quick Reference

### MCP Hot Path Query Sequence

```
1. Extract bearer token from Authorization header
2. bcrypt.compare(token, api_keys.key_hash)     → idx_api_keys_key_hash_active
3. Check expiry and deleted_at on api_keys row
4. Load inbox row (id, provider, credentials)   → primary key + idx_inboxes_workspace_id
5. Count recent calls in activity_log            → idx_activity_log_api_key_id_created_at
6. Decrypt credentials (in-memory, no DB)
7. Call provider API (Gmail / Graph / IMAP)
8. Truncate + sanitise email body if needed
9. INSERT into activity_log                      → idx_activity_log_workspace_id_created_at
10. Return JSON-RPC result
```

### Environment Variables Affecting Performance

| Variable | Purpose | Recommended Value |
|----------|---------|-------------------|
| `BCRYPT_COST` | bcrypt work factor for API key comparison | `12` (40–60 ms; increase to 13 only on faster hardware) |
| `IMAP_CONNECT_TIMEOUT_MS` | TCP connect + TLS timeout | `3000` |
| `IMAP_COMMAND_TIMEOUT_MS` | Per-command IMAP timeout | `5000` |
| `EMAIL_BODY_MAX_BYTES` | HTML body truncation limit | `51200` (50 KB) |
| `GMAIL_BATCH_SIZE` | Messages per Gmail batch request | `50` (max 100) |
| `GRAPH_BATCH_SIZE` | Messages per Graph batch request | `20` (Graph maximum) |

---

**Version**: 1.0
**Last Updated**: 2026-05-24
**Next Review**: 2026-08-24

// Copy for /docs/api, the developer guide, in every locale.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here
// (apps/web/CLAUDE.md). Same pattern as docs/read-only-access/content.mjs.
//
// TRANSLATION: en, nb, es, fr, de and zh each have their own object of the
// same shape. A copy change goes into all six. The code samples in CODE are
// shared by every locale and are not translated.
//
// Every claim is traced to code. If one of these changes, change the page:
//   key format             apps/web/src/lib/api-keys/generate.ts (mcpe_ + 64 hex)
//   scopes                 apps/web/src/lib/api-keys/scopes.ts (VALID_SCOPES)
//   inbox access           components/dashboard/Pages.jsx EditConnectionModal,
//                          app/api/api-keys/[id]/route.ts (inbox_ids, null = all)
//   dashboard labels       messages/en/dashboard.json apiKeys.*,
//                          messages/en/dashboardChrome.json sidebar.navKeys
//   auth errors            supabase/functions/mcp-server/index.ts
//                          RPC_INVALID_API_KEY (-32001, HTTP 401)
//   scope errors           RPC_INSUFFICIENT_SCOPE (-32004, HTTP 403,
//                          data.error_code, data.required_scopes)
//   rate limit errors      buildRateLimitResponse / buildQuotaExceededResponse
//                          (-32003, HTTP 429, Retry-After, data.retry_after,
//                          data.window)
//   per-plan ceilings      apps/web/src/lib/stripe/plans.ts maxRequestsPerMinute
//                          (the page reads the numbers from there)
//   RateLimit-* headers    PR claude/dev-api-limits
//   unknown tool           -32602 with data.available_tools
//   invalid arguments      invalidArgumentsResult: isError result,
//                          _meta["com.mcpemails/invalid_arguments"]
//   usage limit            usageLimitResult: _meta["com.mcpemails/usage_limit"]
//   pagination             mcp-server/pagination-envelope.ts
//   idempotency            claimOutboundIdempotency, completeOutboundIdempotency,
//                          IDEMPOTENCY_KEY_PROPERTY (200 chars, 24h),
//                          mcp-server/idempotency-replay.ts
//   stateless, JSON reply  index.ts (no session; SSE only when Accept asks)
//   webhooks               PR claude/dev-api-webhooks
//   Claude Code flag       https://code.claude.com/docs/en/mcp
//                          (claude mcp add --transport http ... --header)
//   OpenClaw               /docs/openclaw (PR #239), headers map, not auth oauth
//
// Inline markup: `code`, **bold** and [label](/path), rendered by the page.

export const MCP_URL = 'https://mcpemails.com/api/mcp';

/** Code samples. Shared by every locale; never translated. */
export const CODE = {
  initialize: `curl -s https://mcpemails.com/api/mcp \\
  -H "Authorization: Bearer $MCPEMAILS_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "clientInfo": { "name": "my-agent", "version": "1.0" },
      "capabilities": {}
    }
  }'`,
  toolsList: `curl -s https://mcpemails.com/api/mcp \\
  -H "Authorization: Bearer $MCPEMAILS_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }'`,
  toolsCall: `curl -s https://mcpemails.com/api/mcp \\
  -H "Authorization: Bearer $MCPEMAILS_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "email_read",
      "arguments": { "action": "list", "inbox": "you@example.com", "unread": true, "limit": 20 }
    }
  }'`,
  result: `{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "{\\"messages\\":[...],\\"total\\":42, ...}" }],
    "structuredContent": {
      "messages": [{ "id": "...", "subject": "...", "from": { "name": "...", "email": "..." } }],
      "total": 42,
      "total_is_estimate": false,
      "has_more": true,
      "next_offset": 20
    }
  }
}`,
  scopeError: `HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", ...

{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32004,
    "message": "Insufficient scope: the 'send:email' scope is required to call email_compose.",
    "data": { "error_code": "insufficient_scope", "required_scopes": ["send:email"], ... }
  }
}`,
  rateError: `HTTP/1.1 429 Too Many Requests
Retry-After: 12

{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32003,
    "message": "Rate limit exceeded",
    "data": { "error_code": "rate_limit_exceeded", "window": "per_minute", "retry_after": 12, ... }
  }
}`,
  invalidArgs: `{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "isError": true,
    "content": [{ "type": "text", "text": "Invalid arguments for email_read. The call was rejected before it ran, ..." }],
    "_meta": {
      "com.mcpemails/invalid_arguments": {
        "error_code": "invalid_arguments",
        "retryable": false,
        "errors": [{ "path": "arguments.since", "message": "..." }]
      }
    }
  }
}`,
  send: `curl -s https://mcpemails.com/api/mcp \\
  -H "Authorization: Bearer $MCPEMAILS_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "email_compose",
      "arguments": {
        "action": "send",
        "inbox": "you@example.com",
        "to": ["customer@example.com"],
        "subject": "Your order has shipped",
        "body": "Hi, your order is on its way.",
        "idempotency_key": "order-1042-shipped"
      }
    }
  }'`,
  replay: `{
  "idempotency_key": "order-1042-shipped",
  "idempotent_replay": true,
  "status": "succeeded",
  "result": { "message_id": "...", "inbox_id": "...", "status": "sent" },
  "message": "This logical request was already processed. ..."
}`,
  webhookPayload: `POST /your/webhook HTTP/1.1
Content-Type: application/json
MCPEmails-Event-Id: evt_...
MCPEmails-Event-Type: message.received
MCPEmails-Signature: t=1792843200,v1=5f2b...

{
  "id": "evt_...",
  "type": "message.received",
  "created_at": "2026-10-24T09:20:00.000Z",
  "workspace_id": "...",
  "inbox_id": "...",
  "folder": "INBOX",
  "count": 1,
  "message_ids": ["..."]
}`,
  webhookVerify: `import crypto from 'node:crypto';

// rawBody: the request body exactly as received, before JSON.parse.
export function verifyMcpemailsSignature(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(
    String(header ?? '').split(',').map((part) => part.trim().split('=')),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(\`\${parts.t}.\${rawBody}\`)
    .digest();
  const received = Buffer.from(parts.v1 ?? '', 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}`,
  claudeCode: `claude mcp add --transport http mcpemails https://mcpemails.com/api/mcp \\
  --header "Authorization: Bearer $MCPEMAILS_KEY"`,
  node: `// node agent.mjs  (Node 18 or later, MCPEMAILS_KEY in the environment)
const ENDPOINT = 'https://mcpemails.com/api/mcp';
let nextId = 1;

async function callTool(name, args) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${process.env.MCPEMAILS_KEY}\`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After') ?? 1);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return callTool(name, args);
  }
  const reply = await res.json();
  if (reply.error) throw new Error(\`\${reply.error.code}: \${reply.error.message}\`);
  if (reply.result.isError) throw new Error(reply.result.content[0].text);
  return reply.result.structuredContent;
}

const inbox = 'you@example.com';
let offset = 0;
do {
  const page = await callTool('email_read', { action: 'list', inbox, unread: true, limit: 50, offset });
  for (const m of page.messages) console.log(m.id, m.from?.email, m.subject);
  offset = page.has_more ? page.next_offset : null;
} while (offset !== null);`,
  n8nBody: `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "email_read",
    "arguments": {
      "action": "read",
      "inbox_id": "{{ $json.body.inbox_id }}",
      "message_id": "{{ $json.body.message_ids[0] }}"
    }
  }
}`,
  openclaw: `{
  "mcp": {
    "servers": {
      "mcpemails": {
        "url": "https://mcpemails.com/api/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer mcpe_YOUR_KEY_HERE" }
      }
    }
  }
}`,
};

const en = {
  meta: {
    title: 'Email API for developers: MCPEmails HTTP guide',
    description:
      'Call MCPEmails from scripts, n8n and your own agents: API keys and scopes, the JSON-RPC calls with curl, errors, pagination, idempotency keys, rate limits and signed webhooks for new mail.',
  },
  breadcrumb: 'Developer guide',
  eyebrow: 'Docs',
  title: 'Build on MCPEmails',
  lead:
    'Everything an MCP client does, a script can do with plain HTTPS. One endpoint, one API key, JSON in and JSON out. This guide covers authentication, the three calls you need, errors, retries, limits and webhooks for new mail.',
  toc: 'On this page',
  codeLabels: {
    bash: 'bash',
    http: 'HTTP',
    json: 'JSON',
    js: 'JavaScript',
  },
  sections: [
    {
      id: 'endpoint',
      h: 'The endpoint',
      blocks: [
        { p: 'Every request is a JSON-RPC 2.0 `POST` to `https://mcpemails.com/api/mcp`. This is the same endpoint claude.ai, ChatGPT and other MCP clients use, with the same tools and the same permissions, so a script and a chat assistant see one product.' },
        {
          items: [
            'Send `Content-Type: application/json` and `Accept: application/json`. The answer is one JSON object.',
            'The server keeps no session. There is nothing to open or close, and every request carries its own `Authorization` header.',
            'Successful tool results carry a typed `structuredContent` object, so you never have to parse prose. The same data is in `content[0].text` as a JSON string.',
          ],
        },
      ],
    },
    {
      id: 'auth',
      h: 'Authentication',
      blocks: [
        { h3: 'API keys' },
        {
          items: [
            'Create a key in the dashboard under **API keys** → **New key**. Name it after the script or workflow that will use it.',
            'A key is `mcpe_` followed by 64 hex characters. It is shown once, when you create it, and only a hash is stored. Copy it then; a lost key cannot be recovered, only replaced.',
            'Send it on every request as `Authorization: Bearer mcpe_...`. Never put a key in a URL or a query string.',
            'Every plan can create as many keys as it needs. Use one key per script or workflow, so you can revoke one without touching the others.',
            'Revoking a key on the **API keys** page ends access immediately.',
          ],
        },
        { h3: 'Scopes' },
        { p: 'Each key holds only the permissions you tick when you create it. You can change them later with **Edit access**, and the change applies to the next call without reconnecting.' },
        {
          table: {
            head: ['Scope', 'Allows'],
            rows: [
              ['`read:email`', 'List, read and search messages, download attachments, list inboxes and folders.'],
              ['`search:email`', 'Kept for older keys. Search is covered by `read:email`.'],
              ['`send:email`', 'Send, reply and forward.'],
              ['`manage:drafts`', 'Create, update and delete drafts. Sending a draft also needs `send:email`.'],
              ['`manage:folders`', 'Move, copy, flag and archive messages; create, rename and delete folders.'],
              ['`delete:email`', 'Delete and bulk-delete messages.'],
              ['`manage:contacts`', 'Search contacts from your recent mail.'],
              ['`schedule:email`', 'Schedule sends and manage scheduled emails.'],
              ['`manage:automations`', 'Create rules that run on a schedule with nobody watching.'],
            ],
          },
        },
        { p: 'Start with `read:email` and add a write scope only when the workflow needs it. A call outside the key\'s scopes is refused before we contact your mail server. Workspace viewers can only hold read scopes.' },
        { h3: 'Inbox access' },
        { p: 'A key reaches every inbox in the workspace by default. To pin it to some of them, open **Edit access** on the key and choose the inboxes under **Inbox access**. The limit is checked on every call, so a key pinned to the support inbox cannot read the finance one, whatever the request says.' },
        { h3: 'OAuth for connector apps' },
        { p: 'Apps that people connect themselves, such as claude.ai, ChatGPT and other MCP clients, sign in with OAuth instead of a key: dynamic client registration, authorization code with PKCE, and a consent screen where the user picks the scopes and inboxes. See [OAuth connection](/docs#oauth). For your own scripts, servers and workflows, an API key is simpler.' },
      ],
    },
    {
      id: 'calls',
      h: 'The three calls',
      blocks: [
        { h3: '1. initialize (optional)' },
        { p: 'MCP clients start with `initialize`. A script can skip it, because the server keeps no session, but it is a cheap way to check that the key works and to read the server\'s instructions.' },
        { code: 'initialize', lang: 'bash' },
        { h3: '2. tools/list' },
        { p: '`tools/list` returns every tool this key may call, with its description, its input schema and its output schema. Read it at startup instead of hardcoding tool names or arguments: the list is filtered by the key\'s scopes, and tools gain arguments over time.' },
        { code: 'toolsList', lang: 'bash' },
        { h3: '3. tools/call' },
        { p: 'Call a tool by name with its arguments. Most tools take an `action` that picks what they do, such as `list`, `read` or `search` on `email_read`. Name the mailbox with `inbox` (its address) or `inbox_id`; `inbox_list` returns both.' },
        { code: 'toolsCall', lang: 'bash' },
        { p: 'A successful result:' },
        { code: 'result', lang: 'json' },
        { p: 'The [tool reference](/docs#tools) describes each tool, and the [curl guide](/docs/curl) has more examples.' },
      ],
    },
    {
      id: 'errors',
      h: 'Errors',
      blocks: [
        { p: 'There are two kinds. A request that could not run at all comes back as a JSON-RPC `error` with an HTTP status. A request that reached a tool and was refused by it comes back as a normal `result` with `isError: true`, so an AI model reads the reason. Branch on `data.error_code` or the `_meta` code, not on the message text.' },
        {
          table: {
            head: ['Response', 'When', 'What to do'],
            rows: [
              ['HTTP 401, `-32001`', 'Missing, malformed, revoked or expired key.', 'Fix the `Authorization` header or create a new key. Retrying will not help.'],
              ['HTTP 403, `-32004`, `insufficient_scope`', 'The key lacks a scope this tool action needs. `data.required_scopes` lists what would allow it.', 'Add the scope with **Edit access**, or use another key.'],
              ['HTTP 429, `-32003`, `rate_limit_exceeded`', 'Too many requests. `data.window` says which window filled up.', 'Wait `Retry-After` seconds (also in `data.retry_after`), then retry the same request.'],
              ['`-32602`', 'Unknown tool name. `data.available_tools` lists the names this key can call.', 'Use a name from `tools/list`.'],
              ['`isError: true`, `invalid_arguments`', 'The arguments failed the tool\'s schema. Nothing ran. The text names each bad argument, and when an argument name was guessed, it names the one that exists.', 'Fix the arguments. The same arguments are rejected the same way.'],
              ['`isError: true`, `usage_limit_reached`', 'A Free workspace used its monthly email actions.', 'Wait for the reset date in `_meta`, or upgrade. Paid plans have no monthly cap.'],
              ['`isError: true`, other', 'The tool ran and failed: message not found, provider refused, invalid recipient and so on.', 'Read `content[0].text`. It says what happened and whether anything was sent.'],
            ],
          },
        },
        { code: 'scopeError', lang: 'http' },
        { code: 'rateError', lang: 'http' },
        { code: 'invalidArgs', lang: 'json' },
      ],
    },
    {
      id: 'pagination',
      h: 'Pagination',
      blocks: [
        { p: 'Every list and search result ends with the same four fields:' },
        {
          items: [
            '`has_more`: true when another page exists. Only `has_more: false` means you have seen everything.',
            '`next_offset`: pass it back as `offset`, with every other argument unchanged, to get the next page. It is `null` when `has_more` is false.',
            '`total`: the number of matches, or `null` when the provider cannot count them. It never contradicts the page you are holding.',
            '`total_is_estimate`: true when `total` is an estimate or a floor rather than an exact count.',
          ],
        },
        { p: 'Long message bodies are windowed the same way: when `body_truncated` is true, read again with `body_next_offset` as `body_offset`.' },
      ],
    },
    {
      id: 'idempotency',
      h: 'Retries and idempotency keys',
      blocks: [
        { p: 'A dropped connection after a send leaves you not knowing whether the mail went out. Pass an `idempotency_key` and retry with the same key: the work runs once.' },
        { code: 'send', lang: 'bash' },
        {
          items: [
            'Accepted on sends, replies, forwards, scheduled sends, draft writes and mailbox changes such as move, flag and delete. `tools/list` shows `idempotency_key` in the input schema of every tool that takes it.',
            'Up to 200 characters. Use something from your own system, such as an order number and an event name.',
            'Keys are scoped to the API key that sent them, and remembered for 24 hours.',
            'A retry with the same key and the same arguments does not run again. It returns `idempotent_replay: true`, the original `status`, and the original outcome in `result`, including the `message_id` you may have lost.',
            'The same key with different arguments is refused with `idempotency_key_conflict`. Use a new key for a new operation.',
            'A retry while the first call is still running returns `status: "processing"`. Retry shortly.',
            'When the mail provider refused a send before accepting it, nothing was sent and the key is released, so the identical retry really sends.',
            'When the outcome is uncertain, the replay says `status: "unknown"`. Check Sent before sending again under a new key.',
          ],
        },
        { code: 'replay', lang: 'json' },
      ],
    },
    {
      id: 'approval',
      h: 'Send approval',
      blocks: [
        { p: 'Any inbox can hold every send for a person to approve. A send from your script then returns an `approval_id` with `status: "pending_approval"` instead of going out, and it goes out when someone approves it in the dashboard. This works on every plan and is a good default while a new automation proves itself. A retry with the same `idempotency_key` reports the approval instead of creating a second one.' },
      ],
    },
    {
      id: 'rate-limits',
      h: 'Rate limits',
      blocks: [
        { p: 'Each plan has a per-minute ceiling for the whole workspace. A single key can use the plan\'s full per-minute limit; several keys share it.' },
        { planTable: true },
        {
          items: [
            '`tools/call` responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (in seconds) for whichever window is closer to full, so a client can pace itself before it hits the limit.',
            'Each key also has hourly and daily windows. A 429 names the window that filled up in `data.window`.',
            'A 429 carries `Retry-After` in seconds. Wait that long, then retry the same request.',
            'Free includes a monthly allowance of email actions. Paid plans have no monthly cap and no per-call charge.',
          ],
        },
      ],
    },
    {
      id: 'webhooks',
      h: 'Webhooks for new mail',
      blocks: [
        { p: 'On Pro and Business, MCPEmails can POST to your URL when mail arrives in an inbox, so a workflow starts on new mail instead of polling. Create an endpoint in the dashboard, choose its inboxes, and copy the signing secret, which is shown once. The URL must be HTTPS, on port 443 or 8443. Use the test button to send a signed `ping` event.' },
        { h3: 'The event' },
        { code: 'webhookPayload', lang: 'http' },
        {
          items: [
            '`type` is `message.received`. `message_ids` lists the new messages in that inbox\'s `INBOX` folder, up to 10 per event; `count` is how many arrived, which can be more.',
            'By default the payload carries ids only, no content. An endpoint set to include headers also gets a `messages` list with the `id`, `from` and `subject` of each message.',
            'Fetch the message with `email_read` (`action: "read"`, the `inbox_id` and a `message_id`) using an API key. That key\'s scopes and inbox access apply as usual.',
            'Delivery is usually within about two minutes of the message arriving. Inboxes are checked on a schedule, so this is not instant.',
          ],
        },
        { h3: 'Verify the signature' },
        { p: 'Every delivery carries `MCPEmails-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256 of the timestamp, a dot and the raw request body, keyed with the endpoint\'s secret. The key is the whole secret as shown, `whsec_` prefix included. Recompute the signature over the raw body, compare in constant time, and reject a timestamp more than five minutes old.' },
        { code: 'webhookVerify', lang: 'js' },
        { h3: 'Retries' },
        {
          items: [
            'Answer with any 2xx status within 10 seconds. Anything else counts as a failure, including a redirect, which is not followed.',
            'A failed delivery is retried after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 24 hours. Each retry is signed again with a fresh timestamp.',
            'An endpoint that has failed for 24 hours, or 50 times in a row, is disabled and the workspace owner is told by email. You can turn it back on from the dashboard.',
            'Use `MCPEmails-Event-Id` to ignore a delivery you have already processed. A retry carries the same event id.',
          ],
        },
      ],
    },
    {
      id: 'recipes',
      h: 'Recipes',
      blocks: [
        { h3: 'n8n: run a workflow on new mail' },
        {
          items: [
            'Add a **Webhook** trigger node with HTTP method `POST`, and register its production URL as a webhook endpoint in the MCPEmails dashboard.',
            'Add an **HTTP Request** node: method `POST`, URL `https://mcpemails.com/api/mcp`, authentication **Generic Credential Type** → **Header Auth** with name `Authorization` and value `Bearer mcpe_...`.',
            'Turn on **Send Body**, choose **JSON**, and use the body below to read the new message. The next nodes get the message in `result.structuredContent`.',
            'To check the signature in n8n, enable **Raw Body** on the Webhook node and run the verification above in a **Code** node. On self-hosted n8n, allow the crypto module with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.',
          ],
        },
        { code: 'n8nBody', lang: 'json' },
        { p: 'For an AI Agent node that reads and sends mail itself, see the [n8n guide](/docs/n8n).' },
        { h3: 'Claude Code' },
        { p: 'Add the server with a key in a header. This suits headless machines and CI, where there is no browser for the OAuth sign-in:' },
        { code: 'claudeCode', lang: 'bash' },
        { p: 'The [Claude Code guide](/docs/claude-code) covers the OAuth sign-in and the scope choices.' },
        { h3: 'A short Node script' },
        { p: 'Lists every unread message in one inbox, page by page, and waits out a 429:' },
        { code: 'node', lang: 'js' },
        { h3: 'OpenClaw' },
        { p: 'OpenClaw signs in with OAuth by default; the [OpenClaw guide](/docs/openclaw) walks through it. To use a scoped key instead, put it in the server entry\'s `headers` map and leave `auth` unset, because OpenClaw ignores a static `Authorization` header on an entry set to OAuth.' },
        { code: 'openclaw', lang: 'json' },
      ],
    },
  ],
  planTable: {
    head: ['Plan', 'Requests per minute', 'Webhooks'],
    yes: 'Yes',
    no: 'No',
  },
  cta: {
    title: 'Start with one inbox, free',
    sub: 'Create a key, call tools/list, and see your own mail come back as JSON.',
    button: 'Get started',
    pricing: 'See pricing',
    developers: 'Why developers use MCPEmails',
  },
};

const nb = {
  meta: {
    title: 'E-post-API for utviklere: MCPEmails HTTP-guide',
    description:
      'Kall MCPEmails fra skript, n8n og dine egne agenter: API-nøkler og omfang, JSON-RPC-kallene med curl, feil, paginering, idempotensnøkler, hastighetsgrenser og signerte webhooks for ny e-post.',
  },
  breadcrumb: 'Utviklerguide',
  eyebrow: 'Dokumentasjon',
  title: 'Bygg på MCPEmails',
  lead:
    'Alt en MCP-klient gjør, kan et skript gjøre over vanlig HTTPS. Ett endepunkt, én API-nøkkel, JSON inn og JSON ut. Denne guiden dekker autentisering, de tre kallene du trenger, feil, nye forsøk, grenser og webhooks for ny e-post.',
  toc: 'På denne siden',
  codeLabels: {
    bash: 'bash',
    http: 'HTTP',
    json: 'JSON',
    js: 'JavaScript',
  },
  sections: [
    {
      id: 'endpoint',
      h: 'Endepunktet',
      blocks: [
        { p: 'Hver forespørsel er en JSON-RPC 2.0 `POST` til `https://mcpemails.com/api/mcp`. Dette er samme endepunkt som claude.ai, ChatGPT og andre MCP-klienter bruker, med de samme verktøyene og de samme tillatelsene, så et skript og en chatassistent ser ett og samme produkt.' },
        {
          items: [
            'Send `Content-Type: application/json` og `Accept: application/json`. Svaret er ett JSON-objekt.',
            'Serveren holder ingen sesjon. Det er ingenting å åpne eller lukke, og hver forespørsel bærer sin egen `Authorization`-header.',
            'Vellykkede verktøyresultater har et typet `structuredContent`-objekt, så du slipper å tolke prosa. De samme dataene ligger i `content[0].text` som en JSON-streng.',
          ],
        },
      ],
    },
    {
      id: 'auth',
      h: 'Autentisering',
      blocks: [
        { h3: 'API-nøkler' },
        {
          items: [
            'Opprett en nøkkel i dashbordet under **API-nøkler** → **Ny nøkkel**. Gi den navn etter skriptet eller arbeidsflyten som skal bruke den.',
            'En nøkkel er `mcpe_` etterfulgt av 64 heksadesimale tegn. Den vises én gang, når du oppretter den, og bare en hash lagres. Kopier den da; en mistet nøkkel kan ikke gjenopprettes, bare erstattes.',
            'Send den med hver forespørsel som `Authorization: Bearer mcpe_...`. Legg aldri en nøkkel i en URL eller en query-streng.',
            'Alle planer kan opprette så mange nøkler de trenger. Bruk én nøkkel per skript eller arbeidsflyt, så kan du trekke tilbake én uten å røre de andre.',
            'Å trekke tilbake en nøkkel på siden **API-nøkler** avslutter tilgangen umiddelbart.',
          ],
        },
        { h3: 'Omfang' },
        { p: 'Hver nøkkel har bare de tillatelsene du huker av når du oppretter den. Du kan endre dem senere med **Rediger tilgang**, og endringen gjelder fra neste kall uten å koble til på nytt.' },
        {
          table: {
            head: ['Omfang', 'Tillater'],
            rows: [
              ['`read:email`', 'Liste, lese og søke i meldinger, laste ned vedlegg, liste innbokser og mapper.'],
              ['`search:email`', 'Beholdt for eldre nøkler. Søk dekkes av `read:email`.'],
              ['`send:email`', 'Sende, svare og videresende.'],
              ['`manage:drafts`', 'Opprette, oppdatere og slette utkast. Å sende et utkast krever også `send:email`.'],
              ['`manage:folders`', 'Flytte, kopiere, flagge og arkivere meldinger; opprette, gi nytt navn til og slette mapper.'],
              ['`delete:email`', 'Slette og masseslette meldinger.'],
              ['`manage:contacts`', 'Søke etter kontakter i nylig e-post.'],
              ['`schedule:email`', 'Planlegge sendinger og håndtere planlagte e-poster.'],
              ['`manage:automations`', 'Opprette regler som kjører etter en tidsplan uten at noen følger med.'],
            ],
          },
        },
        { p: 'Start med `read:email` og legg til et skriveomfang bare når arbeidsflyten trenger det. Et kall utenfor nøkkelens omfang avvises før vi kontakter e-postserveren din. Lesere i arbeidsområdet kan bare ha leseomfang.' },
        { h3: 'Innbokstilgang' },
        { p: 'En nøkkel når som standard alle innbokser i arbeidsområdet. For å låse den til noen av dem, åpne **Rediger tilgang** på nøkkelen og velg innboksene under **Innbokstilgang**. Begrensningen sjekkes på hvert kall, så en nøkkel låst til support-innboksen kan ikke lese økonomi-innboksen, uansett hva forespørselen sier.' },
        { h3: 'OAuth for koblingsapper' },
        { p: 'Apper som folk kobler til selv, som claude.ai, ChatGPT og andre MCP-klienter, logger inn med OAuth i stedet for en nøkkel: dynamisk klientregistrering, autorisasjonskode med PKCE og en samtykkeskjerm der brukeren velger omfang og innbokser. Se [OAuth-tilkobling](/docs#oauth). For dine egne skript, servere og arbeidsflyter er en API-nøkkel enklere.' },
      ],
    },
    {
      id: 'calls',
      h: 'De tre kallene',
      blocks: [
        { h3: '1. initialize (valgfritt)' },
        { p: 'MCP-klienter starter med `initialize`. Et skript kan hoppe over det, siden serveren ikke holder noen sesjon, men det er en billig måte å sjekke at nøkkelen virker og lese serverens instruksjoner.' },
        { code: 'initialize', lang: 'bash' },
        { h3: '2. tools/list' },
        { p: '`tools/list` returnerer alle verktøyene denne nøkkelen kan kalle, med beskrivelse, inndataskjema og utdataskjema. Les den ved oppstart i stedet for å hardkode verktøynavn eller argumenter: listen filtreres etter nøkkelens omfang, og verktøy får nye argumenter over tid.' },
        { code: 'toolsList', lang: 'bash' },
        { h3: '3. tools/call' },
        { p: 'Kall et verktøy ved navn med argumentene. De fleste verktøy tar en `action` som bestemmer hva de gjør, som `list`, `read` eller `search` på `email_read`. Oppgi postboksen med `inbox` (adressen) eller `inbox_id`; `inbox_list` returnerer begge.' },
        { code: 'toolsCall', lang: 'bash' },
        { p: 'Et vellykket resultat:' },
        { code: 'result', lang: 'json' },
        { p: '[Verktøyreferansen](/docs#tools) beskriver hvert verktøy, og [curl-guiden](/docs/curl) har flere eksempler.' },
      ],
    },
    {
      id: 'errors',
      h: 'Feil',
      blocks: [
        { p: 'Det finnes to typer. En forespørsel som ikke kunne kjøre i det hele tatt kommer tilbake som en JSON-RPC `error` med en HTTP-status. En forespørsel som nådde et verktøy og ble avvist av det kommer tilbake som et vanlig `result` med `isError: true`, slik at en AI-modell kan lese årsaken. Forgren på `data.error_code` eller `_meta`-koden, ikke på meldingsteksten.' },
        {
          table: {
            head: ['Svar', 'Når', 'Hva du gjør'],
            rows: [
              ['HTTP 401, `-32001`', 'Manglende, feilformet, tilbakekalt eller utløpt nøkkel.', 'Rett `Authorization`-headeren eller opprett en ny nøkkel. Nye forsøk hjelper ikke.'],
              ['HTTP 403, `-32004`, `insufficient_scope`', 'Nøkkelen mangler et omfang denne verktøyhandlingen krever. `data.required_scopes` lister hva som ville tillatt den.', 'Legg til omfanget med **Rediger tilgang**, eller bruk en annen nøkkel.'],
              ['HTTP 429, `-32003`, `rate_limit_exceeded`', 'For mange forespørsler. `data.window` sier hvilket vindu som ble fullt.', 'Vent `Retry-After` sekunder (også i `data.retry_after`), og send så samme forespørsel på nytt.'],
              ['`-32602`', 'Ukjent verktøynavn. `data.available_tools` lister navnene denne nøkkelen kan kalle.', 'Bruk et navn fra `tools/list`.'],
              ['`isError: true`, `invalid_arguments`', 'Argumentene besto ikke verktøyets skjema. Ingenting kjørte. Teksten navngir hvert ugyldige argument, og når et argumentnavn var gjettet, navngir den det som finnes.', 'Rett argumentene. De samme argumentene avvises på samme måte.'],
              ['`isError: true`, `usage_limit_reached`', 'Et Gratis-arbeidsområde har brukt opp månedens e-posthandlinger.', 'Vent til tilbakestillingsdatoen i `_meta`, eller oppgrader. Betalte planer har ingen månedlig grense.'],
              ['`isError: true`, annet', 'Verktøyet kjørte og feilet: melding ikke funnet, leverandøren avviste, ugyldig mottaker og så videre.', 'Les `content[0].text`. Den sier hva som skjedde og om noe ble sendt.'],
            ],
          },
        },
        { code: 'scopeError', lang: 'http' },
        { code: 'rateError', lang: 'http' },
        { code: 'invalidArgs', lang: 'json' },
      ],
    },
    {
      id: 'pagination',
      h: 'Paginering',
      blocks: [
        { p: 'Hvert liste- og søkeresultat slutter med de samme fire feltene:' },
        {
          items: [
            '`has_more`: true når det finnes en side til. Bare `has_more: false` betyr at du har sett alt.',
            '`next_offset`: send den tilbake som `offset`, med alle andre argumenter uendret, for å få neste side. Den er `null` når `has_more` er false.',
            '`total`: antall treff, eller `null` når leverandøren ikke kan telle dem. Den motsier aldri siden du holder.',
            '`total_is_estimate`: true når `total` er et estimat eller et minimum og ikke et nøyaktig antall.',
          ],
        },
        { p: 'Lange meldingstekster deles opp på samme måte: når `body_truncated` er true, les igjen med `body_next_offset` som `body_offset`.' },
      ],
    },
    {
      id: 'idempotency',
      h: 'Nye forsøk og idempotensnøkler',
      blocks: [
        { p: 'En tilkobling som brytes etter en sending lar deg ikke vite om e-posten gikk ut. Send med en `idempotency_key` og prøv igjen med samme nøkkel: arbeidet kjører én gang.' },
        { code: 'send', lang: 'bash' },
        {
          items: [
            'Godtas på sendinger, svar, videresendinger, planlagte sendinger, utkastskriving og postboksendringer som flytting, flagging og sletting. `tools/list` viser `idempotency_key` i inndataskjemaet til hvert verktøy som tar den.',
            'Opptil 200 tegn. Bruk noe fra ditt eget system, som et ordrenummer og et hendelsesnavn.',
            'Nøklene er knyttet til API-nøkkelen som sendte dem, og huskes i 24 timer.',
            'Et nytt forsøk med samme nøkkel og samme argumenter kjører ikke igjen. Det returnerer `idempotent_replay: true`, den opprinnelige `status` og det opprinnelige utfallet i `result`, inkludert `message_id` du kan ha mistet.',
            'Samme nøkkel med andre argumenter avvises med `idempotency_key_conflict`. Bruk en ny nøkkel for en ny operasjon.',
            'Et nytt forsøk mens det første kallet fortsatt kjører returnerer `status: "processing"`. Prøv igjen om kort tid.',
            'Når e-postleverandøren avviste en sending før den ble godtatt, ble ingenting sendt og nøkkelen frigis, så det identiske nye forsøket sender faktisk.',
            'Når utfallet er usikkert, sier gjentakelsen `status: "unknown"`. Sjekk Sendt før du sender igjen under en ny nøkkel.',
          ],
        },
        { code: 'replay', lang: 'json' },
      ],
    },
    {
      id: 'approval',
      h: 'Godkjenning av sending',
      blocks: [
        { p: 'Enhver innboks kan holde tilbake alle sendinger til en person godkjenner dem. En sending fra skriptet ditt returnerer da en `approval_id` med `status: "pending_approval"` i stedet for å gå ut, og den går ut når noen godkjenner den i dashbordet. Dette fungerer på alle planer og er et godt utgangspunkt mens en ny automatisering beviser seg. Et nytt forsøk med samme `idempotency_key` rapporterer godkjenningen i stedet for å opprette en ny.' },
      ],
    },
    {
      id: 'rate-limits',
      h: 'Hastighetsgrenser',
      blocks: [
        { p: 'Hver plan har et tak per minutt for hele arbeidsområdet. En enkelt nøkkel kan bruke hele planens grense per minutt; flere nøkler deler den.' },
        { planTable: true },
        {
          items: [
            '`tools/call`-svar har `RateLimit-Limit`, `RateLimit-Remaining` og `RateLimit-Reset` (i sekunder) for det vinduet som er nærmest fullt, så en klient kan regulere tempoet før den treffer grensen.',
            'Hver nøkkel har også time- og døgnvinduer. En 429 navngir vinduet som ble fullt i `data.window`.',
            'En 429 har `Retry-After` i sekunder. Vent så lenge, og send så samme forespørsel på nytt.',
            'Gratis inkluderer en månedlig kvote med e-posthandlinger. Betalte planer har ingen månedlig grense og ingen kostnad per kall.',
          ],
        },
      ],
    },
    {
      id: 'webhooks',
      h: 'Webhooks for ny e-post',
      blocks: [
        { p: 'På Pro og Business kan MCPEmails sende en POST til din URL når e-post kommer inn i en innboks, så en arbeidsflyt starter på ny e-post i stedet for å polle. Opprett et endepunkt i dashbordet, velg innboksene og kopier signeringsnøkkelen, som vises én gang. URL-en må være HTTPS, på port 443 eller 8443. Bruk testknappen til å sende en signert `ping`-hendelse.' },
        { h3: 'Hendelsen' },
        { code: 'webhookPayload', lang: 'http' },
        {
          items: [
            '`type` er `message.received`. `message_ids` lister de nye meldingene i innboksens `INBOX`-mappe, opptil 10 per hendelse; `count` er hvor mange som kom, og kan være flere.',
            'Som standard inneholder nyttelasten bare id-er, ikke innhold. Et endepunkt satt til å inkludere headere får også en `messages`-liste med `id`, `from` og `subject` for hver melding.',
            'Hent meldingen med `email_read` (`action: "read"`, `inbox_id` og en `message_id`) med en API-nøkkel. Nøkkelens omfang og innbokstilgang gjelder som vanlig.',
            'Levering skjer vanligvis innen rundt to minutter etter at meldingen kom. Innbokser sjekkes etter en tidsplan, så dette er ikke umiddelbart.',
          ],
        },
        { h3: 'Verifiser signaturen' },
        { p: 'Hver levering har `MCPEmails-Signature: t=<unix-sekunder>,v1=<hex>`, der `v1` er HMAC-SHA256 av tidsstempelet, et punktum og den rå forespørselskroppen, med endepunktets hemmelighet som nøkkel. Nøkkelen er hele hemmeligheten slik den vises, `whsec_`-prefikset inkludert. Beregn signaturen på nytt over den rå kroppen, sammenlign i konstant tid, og avvis et tidsstempel som er mer enn fem minutter gammelt.' },
        { code: 'webhookVerify', lang: 'js' },
        { h3: 'Nye forsøk' },
        {
          items: [
            'Svar med en hvilken som helst 2xx-status innen 10 sekunder. Alt annet regnes som en feil, inkludert en omdirigering, som ikke følges.',
            'En mislykket levering prøves igjen etter 1 minutt, 5 minutter, 30 minutter, 2 timer, 6 timer og 24 timer. Hvert nytt forsøk signeres på nytt med et ferskt tidsstempel.',
            'Et endepunkt som har feilet i 24 timer, eller 50 ganger på rad, deaktiveres, og eieren av arbeidsområdet får beskjed på e-post. Du kan slå det på igjen fra dashbordet.',
            'Bruk `MCPEmails-Event-Id` til å ignorere en levering du allerede har behandlet. Et nytt forsøk har samme hendelses-id.',
          ],
        },
      ],
    },
    {
      id: 'recipes',
      h: 'Oppskrifter',
      blocks: [
        { h3: 'n8n: kjør en arbeidsflyt på ny e-post' },
        {
          items: [
            'Legg til en **Webhook**-triggernode med HTTP-metode `POST`, og registrer produksjons-URL-en som et webhook-endepunkt i MCPEmails-dashbordet.',
            'Legg til en **HTTP Request**-node: metode `POST`, URL `https://mcpemails.com/api/mcp`, autentisering **Generic Credential Type** → **Header Auth** med navn `Authorization` og verdi `Bearer mcpe_...`.',
            'Slå på **Send Body**, velg **JSON**, og bruk kroppen nedenfor til å lese den nye meldingen. De neste nodene får meldingen i `result.structuredContent`.',
            'For å sjekke signaturen i n8n, aktiver **Raw Body** på Webhook-noden og kjør verifiseringen over i en **Code**-node. På selvdriftet n8n, tillat crypto-modulen med `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.',
          ],
        },
        { code: 'n8nBody', lang: 'json' },
        { p: 'For en AI Agent-node som leser og sender e-post selv, se [n8n-guiden](/docs/n8n).' },
        { h3: 'Claude Code' },
        { p: 'Legg til serveren med en nøkkel i en header. Det passer for hodeløse maskiner og CI, der det ikke finnes noen nettleser for OAuth-innloggingen:' },
        { code: 'claudeCode', lang: 'bash' },
        { p: '[Claude Code-guiden](/docs/claude-code) dekker OAuth-innloggingen og valget av omfang.' },
        { h3: 'Et kort Node-skript' },
        { p: 'Lister alle uleste meldinger i én innboks, side for side, og venter ut en 429:' },
        { code: 'node', lang: 'js' },
        { h3: 'OpenClaw' },
        { p: 'OpenClaw logger inn med OAuth som standard; [OpenClaw-guiden](/docs/openclaw) går gjennom det. For å bruke en avgrenset nøkkel i stedet, legg den i serveroppføringens `headers`-map og la `auth` stå tom, fordi OpenClaw ignorerer en statisk `Authorization`-header på en oppføring satt til OAuth.' },
        { code: 'openclaw', lang: 'json' },
      ],
    },
  ],
  planTable: {
    head: ['Plan', 'Forespørsler per minutt', 'Webhooks'],
    yes: 'Ja',
    no: 'Nei',
  },
  cta: {
    title: 'Start med én innboks, gratis',
    sub: 'Opprett en nøkkel, kall tools/list, og se din egen e-post komme tilbake som JSON.',
    button: 'Kom i gang',
    pricing: 'Se priser',
    developers: 'Hvorfor utviklere bruker MCPEmails',
  },
};

const es = {
  meta: {
    title: 'API de correo para desarrolladores: guía HTTP de MCPEmails',
    description:
      'Llama a MCPEmails desde scripts, n8n y tus propios agentes: claves de API y ámbitos, las llamadas JSON-RPC con curl, errores, paginación, claves de idempotencia, límites de tasa y webhooks firmados para el correo nuevo.',
  },
  breadcrumb: 'Guía para desarrolladores',
  eyebrow: 'Documentación',
  title: 'Construye sobre MCPEmails',
  lead:
    'Todo lo que hace un cliente MCP, un script puede hacerlo con HTTPS normal. Un endpoint, una clave de API, JSON de entrada y JSON de salida. Esta guía cubre la autenticación, las tres llamadas que necesitas, los errores, los reintentos, los límites y los webhooks para el correo nuevo.',
  toc: 'En esta página',
  codeLabels: {
    bash: 'bash',
    http: 'HTTP',
    json: 'JSON',
    js: 'JavaScript',
  },
  sections: [
    {
      id: 'endpoint',
      h: 'El endpoint',
      blocks: [
        { p: 'Cada solicitud es un `POST` JSON-RPC 2.0 a `https://mcpemails.com/api/mcp`. Es el mismo endpoint que usan claude.ai, ChatGPT y otros clientes MCP, con las mismas herramientas y los mismos permisos, así que un script y un asistente de chat ven un único producto.' },
        {
          items: [
            'Envía `Content-Type: application/json` y `Accept: application/json`. La respuesta es un único objeto JSON.',
            'El servidor no mantiene sesión. No hay nada que abrir ni cerrar, y cada solicitud lleva su propia cabecera `Authorization`.',
            'Los resultados correctos de las herramientas llevan un objeto `structuredContent` tipado, así que nunca tienes que interpretar prosa. Los mismos datos están en `content[0].text` como cadena JSON.',
          ],
        },
      ],
    },
    {
      id: 'auth',
      h: 'Autenticación',
      blocks: [
        { h3: 'Claves de API' },
        {
          items: [
            'Crea una clave en el panel, en **Claves de API** → **Nueva clave**. Ponle el nombre del script o flujo de trabajo que la usará.',
            'Una clave es `mcpe_` seguido de 64 caracteres hexadecimales. Se muestra una sola vez, al crearla, y solo se guarda un hash. Cópiala entonces; una clave perdida no se puede recuperar, solo sustituir.',
            'Envíala en cada solicitud como `Authorization: Bearer mcpe_...`. Nunca pongas una clave en una URL ni en una query string.',
            'Todos los planes pueden crear tantas claves como necesiten. Usa una clave por script o flujo de trabajo, para poder revocar una sin tocar las demás.',
            'Revocar una clave en la página **Claves de API** corta el acceso de inmediato.',
          ],
        },
        { h3: 'Ámbitos' },
        { p: 'Cada clave tiene solo los permisos que marcas al crearla. Puedes cambiarlos después con **Editar acceso**, y el cambio se aplica en la siguiente llamada sin volver a conectar.' },
        {
          table: {
            head: ['Ámbito', 'Permite'],
            rows: [
              ['`read:email`', 'Listar, leer y buscar mensajes, descargar adjuntos, listar buzones y carpetas.'],
              ['`search:email`', 'Se conserva para claves antiguas. La búsqueda está cubierta por `read:email`.'],
              ['`send:email`', 'Enviar, responder y reenviar.'],
              ['`manage:drafts`', 'Crear, actualizar y eliminar borradores. Enviar un borrador también necesita `send:email`.'],
              ['`manage:folders`', 'Mover, copiar, marcar y archivar mensajes; crear, renombrar y eliminar carpetas.'],
              ['`delete:email`', 'Eliminar mensajes, uno a uno o en bloque.'],
              ['`manage:contacts`', 'Buscar contactos en tu correo reciente.'],
              ['`schedule:email`', 'Programar envíos y gestionar los correos programados.'],
              ['`manage:automations`', 'Crear reglas que se ejecutan según un horario sin que nadie las vigile.'],
            ],
          },
        },
        { p: 'Empieza con `read:email` y añade un ámbito de escritura solo cuando el flujo de trabajo lo necesite. Una llamada fuera de los ámbitos de la clave se rechaza antes de contactar con tu servidor de correo. Los lectores del espacio de trabajo solo pueden tener ámbitos de lectura.' },
        { h3: 'Acceso a buzones' },
        { p: 'Por defecto una clave llega a todos los buzones del espacio de trabajo. Para fijarla a algunos, abre **Editar acceso** en la clave y elige los buzones en **Acceso a buzones**. El límite se comprueba en cada llamada, así que una clave fijada al buzón de soporte no puede leer el de finanzas, diga lo que diga la solicitud.' },
        { h3: 'OAuth para apps conectoras' },
        { p: 'Las apps que la gente conecta por su cuenta, como claude.ai, ChatGPT y otros clientes MCP, inician sesión con OAuth en lugar de con una clave: registro dinámico de cliente, código de autorización con PKCE y una pantalla de consentimiento donde el usuario elige los ámbitos y los buzones. Consulta [Conexión OAuth](/docs#oauth). Para tus propios scripts, servidores y flujos de trabajo, una clave de API es más sencilla.' },
      ],
    },
    {
      id: 'calls',
      h: 'Las tres llamadas',
      blocks: [
        { h3: '1. initialize (opcional)' },
        { p: 'Los clientes MCP empiezan con `initialize`. Un script puede saltárselo, porque el servidor no mantiene sesión, pero es una forma barata de comprobar que la clave funciona y de leer las instrucciones del servidor.' },
        { code: 'initialize', lang: 'bash' },
        { h3: '2. tools/list' },
        { p: '`tools/list` devuelve todas las herramientas que esta clave puede llamar, con su descripción, su esquema de entrada y su esquema de salida. Léelo al arrancar en lugar de fijar nombres de herramientas o argumentos en el código: la lista se filtra por los ámbitos de la clave, y las herramientas ganan argumentos con el tiempo.' },
        { code: 'toolsList', lang: 'bash' },
        { h3: '3. tools/call' },
        { p: 'Llama a una herramienta por su nombre con sus argumentos. La mayoría aceptan una `action` que decide qué hacen, como `list`, `read` o `search` en `email_read`. Indica el buzón con `inbox` (su dirección) o `inbox_id`; `inbox_list` devuelve ambos.' },
        { code: 'toolsCall', lang: 'bash' },
        { p: 'Un resultado correcto:' },
        { code: 'result', lang: 'json' },
        { p: 'La [referencia de herramientas](/docs#tools) describe cada herramienta, y la [guía de curl](/docs/curl) tiene más ejemplos.' },
      ],
    },
    {
      id: 'errors',
      h: 'Errores',
      blocks: [
        { p: 'Hay dos tipos. Una solicitud que no pudo ejecutarse en absoluto vuelve como un `error` JSON-RPC con un estado HTTP. Una solicitud que llegó a una herramienta y fue rechazada por ella vuelve como un `result` normal con `isError: true`, para que un modelo de IA lea el motivo. Ramifica según `data.error_code` o el código de `_meta`, no según el texto del mensaje.' },
        {
          table: {
            head: ['Respuesta', 'Cuándo', 'Qué hacer'],
            rows: [
              ['HTTP 401, `-32001`', 'Clave ausente, mal formada, revocada o caducada.', 'Corrige la cabecera `Authorization` o crea una clave nueva. Reintentar no ayudará.'],
              ['HTTP 403, `-32004`, `insufficient_scope`', 'A la clave le falta un ámbito que esta acción de la herramienta necesita. `data.required_scopes` lista lo que la permitiría.', 'Añade el ámbito con **Editar acceso**, o usa otra clave.'],
              ['HTTP 429, `-32003`, `rate_limit_exceeded`', 'Demasiadas solicitudes. `data.window` indica qué ventana se llenó.', 'Espera `Retry-After` segundos (también en `data.retry_after`) y repite la misma solicitud.'],
              ['`-32602`', 'Nombre de herramienta desconocido. `data.available_tools` lista los nombres que esta clave puede llamar.', 'Usa un nombre de `tools/list`.'],
              ['`isError: true`, `invalid_arguments`', 'Los argumentos no pasaron el esquema de la herramienta. No se ejecutó nada. El texto nombra cada argumento incorrecto y, cuando un nombre de argumento fue adivinado, indica el que existe.', 'Corrige los argumentos. Los mismos argumentos se rechazan de la misma forma.'],
              ['`isError: true`, `usage_limit_reached`', 'Un espacio de trabajo Gratis ha agotado sus acciones de correo del mes.', 'Espera a la fecha de reinicio en `_meta`, o mejora de plan. Los planes de pago no tienen tope mensual.'],
              ['`isError: true`, otro', 'La herramienta se ejecutó y falló: mensaje no encontrado, el proveedor lo rechazó, destinatario inválido, etcétera.', 'Lee `content[0].text`. Dice qué pasó y si se envió algo.'],
            ],
          },
        },
        { code: 'scopeError', lang: 'http' },
        { code: 'rateError', lang: 'http' },
        { code: 'invalidArgs', lang: 'json' },
      ],
    },
    {
      id: 'pagination',
      h: 'Paginación',
      blocks: [
        { p: 'Todo resultado de lista o búsqueda termina con los mismos cuatro campos:' },
        {
          items: [
            '`has_more`: true cuando existe otra página. Solo `has_more: false` significa que lo has visto todo.',
            '`next_offset`: pásalo de vuelta como `offset`, con todos los demás argumentos sin cambios, para obtener la página siguiente. Es `null` cuando `has_more` es false.',
            '`total`: el número de coincidencias, o `null` cuando el proveedor no puede contarlas. Nunca contradice la página que tienes.',
            '`total_is_estimate`: true cuando `total` es una estimación o un mínimo y no un recuento exacto.',
          ],
        },
        { p: 'Los cuerpos de mensaje largos se trocean de la misma manera: cuando `body_truncated` es true, vuelve a leer con `body_next_offset` como `body_offset`.' },
      ],
    },
    {
      id: 'idempotency',
      h: 'Reintentos y claves de idempotencia',
      blocks: [
        { p: 'Una conexión que se corta tras un envío te deja sin saber si el correo salió. Pasa una `idempotency_key` y reintenta con la misma clave: el trabajo se ejecuta una sola vez.' },
        { code: 'send', lang: 'bash' },
        {
          items: [
            'Se acepta en envíos, respuestas, reenvíos, envíos programados, escritura de borradores y cambios en el buzón como mover, marcar y eliminar. `tools/list` muestra `idempotency_key` en el esquema de entrada de cada herramienta que la acepta.',
            'Hasta 200 caracteres. Usa algo de tu propio sistema, como un número de pedido y un nombre de evento.',
            'Las claves están ligadas a la clave de API que las envió y se recuerdan durante 24 horas.',
            'Un reintento con la misma clave y los mismos argumentos no se ejecuta de nuevo. Devuelve `idempotent_replay: true`, el `status` original y el resultado original en `result`, incluido el `message_id` que quizá perdiste.',
            'La misma clave con argumentos distintos se rechaza con `idempotency_key_conflict`. Usa una clave nueva para una operación nueva.',
            'Un reintento mientras la primera llamada aún se ejecuta devuelve `status: "processing"`. Reintenta en breve.',
            'Cuando el proveedor de correo rechazó un envío antes de aceptarlo, no se envió nada y la clave se libera, así que el reintento idéntico sí envía.',
            'Cuando el resultado es incierto, la repetición dice `status: "unknown"`. Revisa Enviados antes de enviar otra vez con una clave nueva.',
          ],
        },
        { code: 'replay', lang: 'json' },
      ],
    },
    {
      id: 'approval',
      h: 'Aprobación de envíos',
      blocks: [
        { p: 'Cualquier buzón puede retener todos los envíos hasta que una persona los apruebe. Un envío desde tu script devuelve entonces un `approval_id` con `status: "pending_approval"` en lugar de salir, y sale cuando alguien lo aprueba en el panel. Funciona en todos los planes y es un buen valor por defecto mientras una automatización nueva demuestra lo que vale. Un reintento con la misma `idempotency_key` informa de la aprobación en lugar de crear una segunda.' },
      ],
    },
    {
      id: 'rate-limits',
      h: 'Límites de tasa',
      blocks: [
        { p: 'Cada plan tiene un tope por minuto para todo el espacio de trabajo. Una sola clave puede usar el límite por minuto completo del plan; varias claves lo comparten.' },
        { planTable: true },
        {
          items: [
            'Las respuestas de `tools/call` llevan `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset` (en segundos) para la ventana más cercana a llenarse, de modo que un cliente puede regular su ritmo antes de alcanzar el límite.',
            'Cada clave tiene además ventanas por hora y por día. Un 429 indica en `data.window` qué ventana se llenó.',
            'Un 429 lleva `Retry-After` en segundos. Espera ese tiempo y repite la misma solicitud.',
            'Gratis incluye una asignación mensual de acciones de correo. Los planes de pago no tienen tope mensual ni cargo por llamada.',
          ],
        },
      ],
    },
    {
      id: 'webhooks',
      h: 'Webhooks para el correo nuevo',
      blocks: [
        { p: 'En Pro y Business, MCPEmails puede hacer un POST a tu URL cuando llega correo a un buzón, para que un flujo de trabajo arranque con el correo nuevo en lugar de consultar periódicamente. Crea un endpoint en el panel, elige sus buzones y copia el secreto de firma, que se muestra una sola vez. La URL debe ser HTTPS, en el puerto 443 u 8443. Usa el botón de prueba para enviar un evento `ping` firmado.' },
        { h3: 'El evento' },
        { code: 'webhookPayload', lang: 'http' },
        {
          items: [
            '`type` es `message.received`. `message_ids` lista los mensajes nuevos de la carpeta `INBOX` de ese buzón, hasta 10 por evento; `count` es cuántos llegaron, que pueden ser más.',
            'Por defecto la carga lleva solo ids, sin contenido. Un endpoint configurado para incluir cabeceras recibe además una lista `messages` con el `id`, `from` y `subject` de cada mensaje.',
            'Obtén el mensaje con `email_read` (`action: "read"`, el `inbox_id` y un `message_id`) usando una clave de API. Los ámbitos y el acceso a buzones de esa clave se aplican como siempre.',
            'La entrega suele producirse unos dos minutos después de llegar el mensaje. Los buzones se revisan según un horario, así que no es instantánea.',
          ],
        },
        { h3: 'Verifica la firma' },
        { p: 'Cada entrega lleva `MCPEmails-Signature: t=<segundos unix>,v1=<hex>`, donde `v1` es el HMAC-SHA256 de la marca de tiempo, un punto y el cuerpo crudo de la solicitud, con el secreto del endpoint como clave. La clave es el secreto completo tal como se muestra, prefijo `whsec_` incluido. Recalcula la firma sobre el cuerpo crudo, compara en tiempo constante y rechaza una marca de tiempo de más de cinco minutos.' },
        { code: 'webhookVerify', lang: 'js' },
        { h3: 'Reintentos' },
        {
          items: [
            'Responde con cualquier estado 2xx en 10 segundos. Cualquier otra cosa cuenta como fallo, incluida una redirección, que no se sigue.',
            'Una entrega fallida se reintenta tras 1 minuto, 5 minutos, 30 minutos, 2 horas, 6 horas y 24 horas. Cada reintento se firma de nuevo con una marca de tiempo nueva.',
            'Un endpoint que ha fallado durante 24 horas, o 50 veces seguidas, se desactiva y se avisa por correo al propietario del espacio de trabajo. Puedes volver a activarlo desde el panel.',
            'Usa `MCPEmails-Event-Id` para ignorar una entrega que ya has procesado. Un reintento lleva el mismo id de evento.',
          ],
        },
      ],
    },
    {
      id: 'recipes',
      h: 'Recetas',
      blocks: [
        { h3: 'n8n: ejecutar un flujo de trabajo con el correo nuevo' },
        {
          items: [
            'Añade un nodo disparador **Webhook** con método HTTP `POST`, y registra su URL de producción como endpoint de webhook en el panel de MCPEmails.',
            'Añade un nodo **HTTP Request**: método `POST`, URL `https://mcpemails.com/api/mcp`, autenticación **Generic Credential Type** → **Header Auth** con nombre `Authorization` y valor `Bearer mcpe_...`.',
            'Activa **Send Body**, elige **JSON** y usa el cuerpo de abajo para leer el mensaje nuevo. Los nodos siguientes reciben el mensaje en `result.structuredContent`.',
            'Para comprobar la firma en n8n, activa **Raw Body** en el nodo Webhook y ejecuta la verificación de arriba en un nodo **Code**. En n8n autoalojado, permite el módulo crypto con `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.',
          ],
        },
        { code: 'n8nBody', lang: 'json' },
        { p: 'Para un nodo AI Agent que lea y envíe correo por sí mismo, consulta la [guía de n8n](/docs/n8n).' },
        { h3: 'Claude Code' },
        { p: 'Añade el servidor con una clave en una cabecera. Es lo adecuado para máquinas sin interfaz y CI, donde no hay navegador para el inicio de sesión OAuth:' },
        { code: 'claudeCode', lang: 'bash' },
        { p: 'La [guía de Claude Code](/docs/claude-code) cubre el inicio de sesión OAuth y la elección de ámbitos.' },
        { h3: 'Un script corto en Node' },
        { p: 'Lista todos los mensajes no leídos de un buzón, página a página, y espera a que pase un 429:' },
        { code: 'node', lang: 'js' },
        { h3: 'OpenClaw' },
        { p: 'OpenClaw inicia sesión con OAuth por defecto; la [guía de OpenClaw](/docs/openclaw) lo explica paso a paso. Para usar en su lugar una clave con ámbitos, ponla en el mapa `headers` de la entrada del servidor y deja `auth` sin definir, porque OpenClaw ignora una cabecera `Authorization` estática en una entrada configurada con OAuth.' },
        { code: 'openclaw', lang: 'json' },
      ],
    },
  ],
  planTable: {
    head: ['Plan', 'Solicitudes por minuto', 'Webhooks'],
    yes: 'Sí',
    no: 'No',
  },
  cta: {
    title: 'Empieza con un buzón, gratis',
    sub: 'Crea una clave, llama a tools/list y mira cómo tu propio correo vuelve como JSON.',
    button: 'Empezar',
    pricing: 'Ver precios',
    developers: 'Por qué los desarrolladores usan MCPEmails',
  },
};

const fr = {
  meta: {
    title: 'API e-mail pour développeurs : guide HTTP de MCPEmails',
    description:
      'Appelez MCPEmails depuis des scripts, n8n et vos propres agents : clés API et portées, les appels JSON-RPC avec curl, erreurs, pagination, clés d\'idempotence, limites de débit et webhooks signés pour le nouveau courrier.',
  },
  breadcrumb: 'Guide développeur',
  eyebrow: 'Documentation',
  title: 'Construire sur MCPEmails',
  lead:
    'Tout ce qu\'un client MCP fait, un script peut le faire en HTTPS ordinaire. Un endpoint, une clé API, du JSON en entrée et du JSON en sortie. Ce guide couvre l\'authentification, les trois appels dont vous avez besoin, les erreurs, les nouvelles tentatives, les limites et les webhooks pour le nouveau courrier.',
  toc: 'Sur cette page',
  codeLabels: {
    bash: 'bash',
    http: 'HTTP',
    json: 'JSON',
    js: 'JavaScript',
  },
  sections: [
    {
      id: 'endpoint',
      h: 'L\'endpoint',
      blocks: [
        { p: 'Chaque requête est un `POST` JSON-RPC 2.0 vers `https://mcpemails.com/api/mcp`. C\'est le même endpoint que celui qu\'utilisent claude.ai, ChatGPT et les autres clients MCP, avec les mêmes outils et les mêmes permissions : un script et un assistant de chat voient un seul et même produit.' },
        {
          items: [
            'Envoyez `Content-Type: application/json` et `Accept: application/json`. La réponse est un seul objet JSON.',
            'Le serveur ne garde aucune session. Il n\'y a rien à ouvrir ni à fermer, et chaque requête porte son propre en-tête `Authorization`.',
            'Les résultats d\'outil réussis portent un objet `structuredContent` typé, vous n\'avez donc jamais à analyser de la prose. Les mêmes données sont dans `content[0].text` sous forme de chaîne JSON.',
          ],
        },
      ],
    },
    {
      id: 'auth',
      h: 'Authentification',
      blocks: [
        { h3: 'Clés API' },
        {
          items: [
            'Créez une clé dans le tableau de bord sous **Clés API** → **Nouvelle clé**. Nommez-la d\'après le script ou le workflow qui l\'utilisera.',
            'Une clé est `mcpe_` suivi de 64 caractères hexadécimaux. Elle est affichée une seule fois, à sa création, et seul un hachage est conservé. Copiez-la à ce moment-là ; une clé perdue ne se récupère pas, elle se remplace.',
            'Envoyez-la à chaque requête sous la forme `Authorization: Bearer mcpe_...`. Ne mettez jamais une clé dans une URL ou une query string.',
            'Chaque formule peut créer autant de clés que nécessaire. Utilisez une clé par script ou workflow, pour pouvoir en révoquer une sans toucher aux autres.',
            'Révoquer une clé sur la page **Clés API** coupe l\'accès immédiatement.',
          ],
        },
        { h3: 'Portées' },
        { p: 'Chaque clé ne détient que les permissions que vous cochez à sa création. Vous pouvez les modifier plus tard avec **Modifier l\'accès**, et le changement s\'applique dès l\'appel suivant, sans reconnexion.' },
        {
          table: {
            head: ['Portée', 'Autorise'],
            rows: [
              ['`read:email`', 'Lister, lire et rechercher des messages, télécharger des pièces jointes, lister les boîtes et les dossiers.'],
              ['`search:email`', 'Conservée pour les anciennes clés. La recherche est couverte par `read:email`.'],
              ['`send:email`', 'Envoyer, répondre et transférer.'],
              ['`manage:drafts`', 'Créer, modifier et supprimer des brouillons. Envoyer un brouillon demande aussi `send:email`.'],
              ['`manage:folders`', 'Déplacer, copier, marquer et archiver des messages ; créer, renommer et supprimer des dossiers.'],
              ['`delete:email`', 'Supprimer des messages, un par un ou en masse.'],
              ['`manage:contacts`', 'Rechercher des contacts dans votre courrier récent.'],
              ['`schedule:email`', 'Programmer des envois et gérer les e-mails programmés.'],
              ['`manage:automations`', 'Créer des règles qui s\'exécutent selon un calendrier sans que personne ne surveille.'],
            ],
          },
        },
        { p: 'Commencez avec `read:email` et n\'ajoutez une portée d\'écriture que lorsque le workflow en a besoin. Un appel hors des portées de la clé est refusé avant que nous contactions votre serveur de messagerie. Les lecteurs d\'un espace de travail ne peuvent détenir que des portées de lecture.' },
        { h3: 'Accès aux boîtes' },
        { p: 'Par défaut, une clé atteint toutes les boîtes de l\'espace de travail. Pour la restreindre à certaines d\'entre elles, ouvrez **Modifier l\'accès** sur la clé et choisissez les boîtes sous **Accès aux boîtes**. La restriction est vérifiée à chaque appel : une clé limitée à la boîte support ne peut pas lire celle de la comptabilité, quoi que dise la requête.' },
        { h3: 'OAuth pour les applications connecteurs' },
        { p: 'Les applications que les gens connectent eux-mêmes, comme claude.ai, ChatGPT et les autres clients MCP, se connectent avec OAuth plutôt qu\'avec une clé : enregistrement dynamique du client, code d\'autorisation avec PKCE et un écran de consentement où l\'utilisateur choisit les portées et les boîtes. Voir [Connexion OAuth](/docs#oauth). Pour vos propres scripts, serveurs et workflows, une clé API est plus simple.' },
      ],
    },
    {
      id: 'calls',
      h: 'Les trois appels',
      blocks: [
        { h3: '1. initialize (facultatif)' },
        { p: 'Les clients MCP commencent par `initialize`. Un script peut s\'en passer, puisque le serveur ne garde aucune session, mais c\'est un moyen peu coûteux de vérifier que la clé fonctionne et de lire les instructions du serveur.' },
        { code: 'initialize', lang: 'bash' },
        { h3: '2. tools/list' },
        { p: '`tools/list` renvoie chaque outil que cette clé peut appeler, avec sa description, son schéma d\'entrée et son schéma de sortie. Lisez-le au démarrage plutôt que de coder en dur des noms d\'outils ou des arguments : la liste est filtrée selon les portées de la clé, et les outils gagnent des arguments au fil du temps.' },
        { code: 'toolsList', lang: 'bash' },
        { h3: '3. tools/call' },
        { p: 'Appelez un outil par son nom avec ses arguments. La plupart des outils prennent une `action` qui choisit ce qu\'ils font, comme `list`, `read` ou `search` sur `email_read`. Désignez la boîte avec `inbox` (son adresse) ou `inbox_id` ; `inbox_list` renvoie les deux.' },
        { code: 'toolsCall', lang: 'bash' },
        { p: 'Un résultat réussi :' },
        { code: 'result', lang: 'json' },
        { p: 'La [référence des outils](/docs#tools) décrit chaque outil, et le [guide curl](/docs/curl) contient d\'autres exemples.' },
      ],
    },
    {
      id: 'errors',
      h: 'Erreurs',
      blocks: [
        { p: 'Il en existe deux sortes. Une requête qui n\'a pas pu s\'exécuter du tout revient comme une `error` JSON-RPC avec un statut HTTP. Une requête qui a atteint un outil et a été refusée par lui revient comme un `result` normal avec `isError: true`, pour qu\'un modèle d\'IA lise la raison. Branchez sur `data.error_code` ou sur le code `_meta`, pas sur le texte du message.' },
        {
          table: {
            head: ['Réponse', 'Quand', 'Que faire'],
            rows: [
              ['HTTP 401, `-32001`', 'Clé absente, malformée, révoquée ou expirée.', 'Corrigez l\'en-tête `Authorization` ou créez une nouvelle clé. Réessayer ne servira à rien.'],
              ['HTTP 403, `-32004`, `insufficient_scope`', 'La clé n\'a pas une portée dont cette action d\'outil a besoin. `data.required_scopes` liste ce qui l\'autoriserait.', 'Ajoutez la portée avec **Modifier l\'accès**, ou utilisez une autre clé.'],
              ['HTTP 429, `-32003`, `rate_limit_exceeded`', 'Trop de requêtes. `data.window` indique quelle fenêtre est saturée.', 'Attendez `Retry-After` secondes (aussi dans `data.retry_after`), puis renvoyez la même requête.'],
              ['`-32602`', 'Nom d\'outil inconnu. `data.available_tools` liste les noms que cette clé peut appeler.', 'Utilisez un nom tiré de `tools/list`.'],
              ['`isError: true`, `invalid_arguments`', 'Les arguments n\'ont pas passé le schéma de l\'outil. Rien n\'a été exécuté. Le texte nomme chaque argument fautif et, quand un nom d\'argument a été deviné, indique celui qui existe.', 'Corrigez les arguments. Les mêmes arguments sont refusés de la même manière.'],
              ['`isError: true`, `usage_limit_reached`', 'Un espace de travail Gratuit a épuisé ses actions e-mail du mois.', 'Attendez la date de réinitialisation dans `_meta`, ou passez à une formule supérieure. Les formules payantes n\'ont pas de plafond mensuel.'],
              ['`isError: true`, autre', 'L\'outil s\'est exécuté et a échoué : message introuvable, refus du fournisseur, destinataire invalide, etc.', 'Lisez `content[0].text`. Il dit ce qui s\'est passé et si quelque chose a été envoyé.'],
            ],
          },
        },
        { code: 'scopeError', lang: 'http' },
        { code: 'rateError', lang: 'http' },
        { code: 'invalidArgs', lang: 'json' },
      ],
    },
    {
      id: 'pagination',
      h: 'Pagination',
      blocks: [
        { p: 'Chaque résultat de liste ou de recherche se termine par les mêmes quatre champs :' },
        {
          items: [
            '`has_more` : true quand une autre page existe. Seul `has_more: false` signifie que vous avez tout vu.',
            '`next_offset` : renvoyez-le comme `offset`, avec tous les autres arguments inchangés, pour obtenir la page suivante. Il vaut `null` quand `has_more` est false.',
            '`total` : le nombre de correspondances, ou `null` quand le fournisseur ne peut pas les compter. Il ne contredit jamais la page que vous tenez.',
            '`total_is_estimate` : true quand `total` est une estimation ou un minimum plutôt qu\'un décompte exact.',
          ],
        },
        { p: 'Les corps de message longs sont découpés de la même façon : quand `body_truncated` est true, relisez avec `body_next_offset` comme `body_offset`.' },
      ],
    },
    {
      id: 'idempotency',
      h: 'Nouvelles tentatives et clés d\'idempotence',
      blocks: [
        { p: 'Une connexion coupée après un envoi vous laisse sans savoir si le courrier est parti. Passez une `idempotency_key` et réessayez avec la même clé : le travail ne s\'exécute qu\'une fois.' },
        { code: 'send', lang: 'bash' },
        {
          items: [
            'Acceptée sur les envois, réponses, transferts, envois programmés, écritures de brouillons et modifications de boîte comme déplacer, marquer et supprimer. `tools/list` affiche `idempotency_key` dans le schéma d\'entrée de chaque outil qui l\'accepte.',
            'Jusqu\'à 200 caractères. Utilisez quelque chose de votre propre système, comme un numéro de commande et un nom d\'événement.',
            'Les clés sont rattachées à la clé API qui les a envoyées et mémorisées pendant 24 heures.',
            'Une nouvelle tentative avec la même clé et les mêmes arguments ne s\'exécute pas à nouveau. Elle renvoie `idempotent_replay: true`, le `status` d\'origine et le résultat d\'origine dans `result`, y compris le `message_id` que vous avez peut-être perdu.',
            'La même clé avec des arguments différents est refusée avec `idempotency_key_conflict`. Utilisez une nouvelle clé pour une nouvelle opération.',
            'Une nouvelle tentative pendant que le premier appel s\'exécute encore renvoie `status: "processing"`. Réessayez peu après.',
            'Quand le fournisseur de messagerie a refusé un envoi avant de l\'accepter, rien n\'a été envoyé et la clé est libérée, de sorte que la nouvelle tentative identique envoie réellement.',
            'Quand l\'issue est incertaine, la relecture indique `status: "unknown"`. Vérifiez les éléments envoyés avant de renvoyer sous une nouvelle clé.',
          ],
        },
        { code: 'replay', lang: 'json' },
      ],
    },
    {
      id: 'approval',
      h: 'Approbation des envois',
      blocks: [
        { p: 'N\'importe quelle boîte peut retenir chaque envoi jusqu\'à ce qu\'une personne l\'approuve. Un envoi depuis votre script renvoie alors un `approval_id` avec `status: "pending_approval"` au lieu de partir, et il part quand quelqu\'un l\'approuve dans le tableau de bord. Cela fonctionne sur toutes les formules et constitue un bon réglage par défaut le temps qu\'une nouvelle automatisation fasse ses preuves. Une nouvelle tentative avec la même `idempotency_key` signale l\'approbation au lieu d\'en créer une seconde.' },
      ],
    },
    {
      id: 'rate-limits',
      h: 'Limites de débit',
      blocks: [
        { p: 'Chaque formule a un plafond par minute pour l\'ensemble de l\'espace de travail. Une seule clé peut utiliser toute la limite par minute de la formule ; plusieurs clés la partagent.' },
        { planTable: true },
        {
          items: [
            'Les réponses de `tools/call` portent `RateLimit-Limit`, `RateLimit-Remaining` et `RateLimit-Reset` (en secondes) pour la fenêtre la plus proche de la saturation, afin qu\'un client puisse régler son rythme avant d\'atteindre la limite.',
            'Chaque clé a aussi des fenêtres horaire et quotidienne. Un 429 nomme la fenêtre saturée dans `data.window`.',
            'Un 429 porte `Retry-After` en secondes. Attendez ce délai, puis renvoyez la même requête.',
            'Gratuit inclut une allocation mensuelle d\'actions e-mail. Les formules payantes n\'ont ni plafond mensuel ni facturation à l\'appel.',
          ],
        },
      ],
    },
    {
      id: 'webhooks',
      h: 'Webhooks pour le nouveau courrier',
      blocks: [
        { p: 'Sur Pro et Business, MCPEmails peut envoyer un POST à votre URL quand du courrier arrive dans une boîte, pour qu\'un workflow démarre sur le nouveau courrier au lieu d\'interroger le serveur. Créez un endpoint dans le tableau de bord, choisissez ses boîtes et copiez le secret de signature, affiché une seule fois. L\'URL doit être en HTTPS, sur le port 443 ou 8443. Utilisez le bouton de test pour envoyer un événement `ping` signé.' },
        { h3: 'L\'événement' },
        { code: 'webhookPayload', lang: 'http' },
        {
          items: [
            '`type` vaut `message.received`. `message_ids` liste les nouveaux messages du dossier `INBOX` de cette boîte, jusqu\'à 10 par événement ; `count` indique combien sont arrivés, ce qui peut être plus.',
            'Par défaut, la charge utile ne contient que des identifiants, aucun contenu. Un endpoint réglé pour inclure les en-têtes reçoit aussi une liste `messages` avec `id`, `from` et `subject` de chaque message.',
            'Récupérez le message avec `email_read` (`action: "read"`, l\'`inbox_id` et un `message_id`) en utilisant une clé API. Les portées et l\'accès aux boîtes de cette clé s\'appliquent comme d\'habitude.',
            'La livraison intervient généralement dans les deux minutes environ après l\'arrivée du message. Les boîtes sont vérifiées selon un calendrier, ce n\'est donc pas instantané.',
          ],
        },
        { h3: 'Vérifier la signature' },
        { p: 'Chaque livraison porte `MCPEmails-Signature: t=<secondes unix>,v1=<hex>`, où `v1` est le HMAC-SHA256 de l\'horodatage, d\'un point et du corps brut de la requête, avec le secret de l\'endpoint comme clé. La clé est le secret entier tel qu\'affiché, préfixe `whsec_` inclus. Recalculez la signature sur le corps brut, comparez en temps constant et rejetez tout horodatage de plus de cinq minutes.' },
        { code: 'webhookVerify', lang: 'js' },
        { h3: 'Nouvelles tentatives' },
        {
          items: [
            'Répondez avec n\'importe quel statut 2xx en moins de 10 secondes. Tout le reste compte comme un échec, y compris une redirection, qui n\'est pas suivie.',
            'Une livraison échouée est retentée après 1 minute, 5 minutes, 30 minutes, 2 heures, 6 heures et 24 heures. Chaque nouvelle tentative est signée à nouveau avec un horodatage frais.',
            'Un endpoint qui échoue depuis 24 heures, ou 50 fois de suite, est désactivé et le propriétaire de l\'espace de travail en est informé par e-mail. Vous pouvez le réactiver depuis le tableau de bord.',
            'Utilisez `MCPEmails-Event-Id` pour ignorer une livraison déjà traitée. Une nouvelle tentative porte le même identifiant d\'événement.',
          ],
        },
      ],
    },
    {
      id: 'recipes',
      h: 'Recettes',
      blocks: [
        { h3: 'n8n : lancer un workflow sur le nouveau courrier' },
        {
          items: [
            'Ajoutez un nœud déclencheur **Webhook** avec la méthode HTTP `POST`, et enregistrez son URL de production comme endpoint de webhook dans le tableau de bord MCPEmails.',
            'Ajoutez un nœud **HTTP Request** : méthode `POST`, URL `https://mcpemails.com/api/mcp`, authentification **Generic Credential Type** → **Header Auth** avec le nom `Authorization` et la valeur `Bearer mcpe_...`.',
            'Activez **Send Body**, choisissez **JSON** et utilisez le corps ci-dessous pour lire le nouveau message. Les nœuds suivants reçoivent le message dans `result.structuredContent`.',
            'Pour vérifier la signature dans n8n, activez **Raw Body** sur le nœud Webhook et exécutez la vérification ci-dessus dans un nœud **Code**. Sur un n8n auto-hébergé, autorisez le module crypto avec `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.',
          ],
        },
        { code: 'n8nBody', lang: 'json' },
        { p: 'Pour un nœud AI Agent qui lit et envoie lui-même du courrier, voir le [guide n8n](/docs/n8n).' },
        { h3: 'Claude Code' },
        { p: 'Ajoutez le serveur avec une clé dans un en-tête. Cela convient aux machines sans interface et à la CI, où il n\'y a pas de navigateur pour la connexion OAuth :' },
        { code: 'claudeCode', lang: 'bash' },
        { p: 'Le [guide Claude Code](/docs/claude-code) couvre la connexion OAuth et le choix des portées.' },
        { h3: 'Un court script Node' },
        { p: 'Liste chaque message non lu d\'une boîte, page par page, et patiente le temps d\'un 429 :' },
        { code: 'node', lang: 'js' },
        { h3: 'OpenClaw' },
        { p: 'OpenClaw se connecte avec OAuth par défaut ; le [guide OpenClaw](/docs/openclaw) le détaille. Pour utiliser plutôt une clé à portées limitées, placez-la dans la map `headers` de l\'entrée du serveur et laissez `auth` non défini, car OpenClaw ignore un en-tête `Authorization` statique sur une entrée réglée en OAuth.' },
        { code: 'openclaw', lang: 'json' },
      ],
    },
  ],
  planTable: {
    head: ['Formule', 'Requêtes par minute', 'Webhooks'],
    yes: 'Oui',
    no: 'Non',
  },
  cta: {
    title: 'Commencez avec une boîte, gratuitement',
    sub: 'Créez une clé, appelez tools/list et regardez votre propre courrier revenir en JSON.',
    button: 'Commencer',
    pricing: 'Voir les tarifs',
    developers: 'Pourquoi les développeurs utilisent MCPEmails',
  },
};

const de = {
  meta: {
    title: 'E-Mail-API für Entwickler: der HTTP-Leitfaden von MCPEmails',
    description:
      'Rufen Sie MCPEmails aus Skripten, n8n und eigenen Agenten auf: API-Schlüssel und Scopes, die JSON-RPC-Aufrufe mit curl, Fehler, Paginierung, Idempotenzschlüssel, Ratenlimits und signierte Webhooks für neue E-Mails.',
  },
  breadcrumb: 'Entwicklerleitfaden',
  eyebrow: 'Dokumentation',
  title: 'Auf MCPEmails aufbauen',
  lead:
    'Alles, was ein MCP-Client kann, kann ein Skript über gewöhnliches HTTPS. Ein Endpunkt, ein API-Schlüssel, JSON rein und JSON raus. Dieser Leitfaden behandelt Authentifizierung, die drei Aufrufe, die Sie brauchen, Fehler, Wiederholungen, Limits und Webhooks für neue E-Mails.',
  toc: 'Auf dieser Seite',
  codeLabels: {
    bash: 'bash',
    http: 'HTTP',
    json: 'JSON',
    js: 'JavaScript',
  },
  sections: [
    {
      id: 'endpoint',
      h: 'Der Endpunkt',
      blocks: [
        { p: 'Jede Anfrage ist ein JSON-RPC-2.0-`POST` an `https://mcpemails.com/api/mcp`. Das ist derselbe Endpunkt, den claude.ai, ChatGPT und andere MCP-Clients verwenden, mit denselben Tools und denselben Berechtigungen. Ein Skript und ein Chat-Assistent sehen also ein und dasselbe Produkt.' },
        {
          items: [
            'Senden Sie `Content-Type: application/json` und `Accept: application/json`. Die Antwort ist ein einzelnes JSON-Objekt.',
            'Der Server hält keine Sitzung. Es gibt nichts zu öffnen oder zu schließen, und jede Anfrage trägt ihren eigenen `Authorization`-Header.',
            'Erfolgreiche Tool-Ergebnisse enthalten ein typisiertes `structuredContent`-Objekt, sodass Sie nie Fließtext parsen müssen. Dieselben Daten stehen als JSON-String in `content[0].text`.',
          ],
        },
      ],
    },
    {
      id: 'auth',
      h: 'Authentifizierung',
      blocks: [
        { h3: 'API-Schlüssel' },
        {
          items: [
            'Erstellen Sie einen Schlüssel im Dashboard unter **API-Schlüssel** → **Neuer Schlüssel**. Benennen Sie ihn nach dem Skript oder Workflow, der ihn verwenden wird.',
            'Ein Schlüssel besteht aus `mcpe_` und 64 Hexadezimalzeichen. Er wird einmal angezeigt, beim Erstellen, und nur ein Hash wird gespeichert. Kopieren Sie ihn dann; ein verlorener Schlüssel lässt sich nicht wiederherstellen, nur ersetzen.',
            'Senden Sie ihn bei jeder Anfrage als `Authorization: Bearer mcpe_...`. Setzen Sie einen Schlüssel nie in eine URL oder einen Query-String.',
            'Jeder Tarif kann so viele Schlüssel erstellen, wie er braucht. Verwenden Sie einen Schlüssel pro Skript oder Workflow, damit Sie einen widerrufen können, ohne die anderen anzutasten.',
            'Das Widerrufen eines Schlüssels auf der Seite **API-Schlüssel** beendet den Zugriff sofort.',
          ],
        },
        { h3: 'Scopes' },
        { p: 'Jeder Schlüssel hat nur die Berechtigungen, die Sie beim Erstellen ankreuzen. Sie können sie später unter **Zugriff bearbeiten** ändern; die Änderung gilt ab dem nächsten Aufruf, ohne neu zu verbinden.' },
        {
          table: {
            head: ['Scope', 'Erlaubt'],
            rows: [
              ['`read:email`', 'Nachrichten auflisten, lesen und durchsuchen, Anhänge herunterladen, Postfächer und Ordner auflisten.'],
              ['`search:email`', 'Für ältere Schlüssel beibehalten. Die Suche ist durch `read:email` abgedeckt.'],
              ['`send:email`', 'Senden, antworten und weiterleiten.'],
              ['`manage:drafts`', 'Entwürfe erstellen, aktualisieren und löschen. Einen Entwurf zu senden braucht zusätzlich `send:email`.'],
              ['`manage:folders`', 'Nachrichten verschieben, kopieren, markieren und archivieren; Ordner erstellen, umbenennen und löschen.'],
              ['`delete:email`', 'Nachrichten einzeln oder gesammelt löschen.'],
              ['`manage:contacts`', 'Kontakte in Ihren letzten E-Mails suchen.'],
              ['`schedule:email`', 'Sendungen planen und geplante E-Mails verwalten.'],
              ['`manage:automations`', 'Regeln erstellen, die nach Zeitplan laufen, ohne dass jemand zusieht.'],
            ],
          },
        },
        { p: 'Beginnen Sie mit `read:email` und ergänzen Sie einen Schreib-Scope erst, wenn der Workflow ihn braucht. Ein Aufruf außerhalb der Scopes des Schlüssels wird abgelehnt, bevor wir Ihren Mailserver kontaktieren. Betrachter eines Workspace können nur Lese-Scopes halten.' },
        { h3: 'Postfachzugriff' },
        { p: 'Ein Schlüssel erreicht standardmäßig jedes Postfach im Workspace. Um ihn auf einige davon festzulegen, öffnen Sie **Zugriff bearbeiten** am Schlüssel und wählen die Postfächer unter **Postfachzugriff**. Die Einschränkung wird bei jedem Aufruf geprüft: Ein Schlüssel, der auf das Support-Postfach festgelegt ist, kann das Finanz-Postfach nicht lesen, egal was die Anfrage sagt.' },
        { h3: 'OAuth für Konnektor-Apps' },
        { p: 'Apps, die Nutzer selbst verbinden, etwa claude.ai, ChatGPT und andere MCP-Clients, melden sich mit OAuth statt mit einem Schlüssel an: dynamische Client-Registrierung, Authorization Code mit PKCE und ein Zustimmungsbildschirm, auf dem der Nutzer Scopes und Postfächer wählt. Siehe [OAuth-Verbindung](/docs#oauth). Für Ihre eigenen Skripte, Server und Workflows ist ein API-Schlüssel einfacher.' },
      ],
    },
    {
      id: 'calls',
      h: 'Die drei Aufrufe',
      blocks: [
        { h3: '1. initialize (optional)' },
        { p: 'MCP-Clients beginnen mit `initialize`. Ein Skript kann es überspringen, weil der Server keine Sitzung hält, aber es ist ein günstiger Weg, um zu prüfen, ob der Schlüssel funktioniert, und die Anweisungen des Servers zu lesen.' },
        { code: 'initialize', lang: 'bash' },
        { h3: '2. tools/list' },
        { p: '`tools/list` liefert jedes Tool, das dieser Schlüssel aufrufen darf, mit Beschreibung, Eingabeschema und Ausgabeschema. Lesen Sie es beim Start, statt Tool-Namen oder Argumente fest zu verdrahten: Die Liste ist nach den Scopes des Schlüssels gefiltert, und Tools bekommen mit der Zeit neue Argumente.' },
        { code: 'toolsList', lang: 'bash' },
        { h3: '3. tools/call' },
        { p: 'Rufen Sie ein Tool über seinen Namen mit seinen Argumenten auf. Die meisten Tools nehmen eine `action`, die bestimmt, was sie tun, etwa `list`, `read` oder `search` bei `email_read`. Benennen Sie das Postfach mit `inbox` (seiner Adresse) oder `inbox_id`; `inbox_list` liefert beides.' },
        { code: 'toolsCall', lang: 'bash' },
        { p: 'Ein erfolgreiches Ergebnis:' },
        { code: 'result', lang: 'json' },
        { p: 'Die [Tool-Referenz](/docs#tools) beschreibt jedes Tool, und der [curl-Leitfaden](/docs/curl) enthält weitere Beispiele.' },
      ],
    },
    {
      id: 'errors',
      h: 'Fehler',
      blocks: [
        { p: 'Es gibt zwei Arten. Eine Anfrage, die gar nicht ausgeführt werden konnte, kommt als JSON-RPC-`error` mit einem HTTP-Status zurück. Eine Anfrage, die ein Tool erreicht hat und von ihm abgelehnt wurde, kommt als normales `result` mit `isError: true` zurück, damit ein KI-Modell den Grund liest. Verzweigen Sie anhand von `data.error_code` oder dem `_meta`-Code, nicht anhand des Meldungstexts.' },
        {
          table: {
            head: ['Antwort', 'Wann', 'Was zu tun ist'],
            rows: [
              ['HTTP 401, `-32001`', 'Fehlender, fehlerhafter, widerrufener oder abgelaufener Schlüssel.', 'Korrigieren Sie den `Authorization`-Header oder erstellen Sie einen neuen Schlüssel. Ein erneuter Versuch hilft nicht.'],
              ['HTTP 403, `-32004`, `insufficient_scope`', 'Dem Schlüssel fehlt ein Scope, den diese Tool-Aktion braucht. `data.required_scopes` listet, was sie erlauben würde.', 'Ergänzen Sie den Scope unter **Zugriff bearbeiten** oder verwenden Sie einen anderen Schlüssel.'],
              ['HTTP 429, `-32003`, `rate_limit_exceeded`', 'Zu viele Anfragen. `data.window` sagt, welches Zeitfenster voll ist.', 'Warten Sie `Retry-After` Sekunden (auch in `data.retry_after`) und senden Sie dann dieselbe Anfrage erneut.'],
              ['`-32602`', 'Unbekannter Tool-Name. `data.available_tools` listet die Namen, die dieser Schlüssel aufrufen kann.', 'Verwenden Sie einen Namen aus `tools/list`.'],
              ['`isError: true`, `invalid_arguments`', 'Die Argumente haben das Schema des Tools nicht bestanden. Nichts wurde ausgeführt. Der Text nennt jedes fehlerhafte Argument und, wenn ein Argumentname geraten wurde, den, der existiert.', 'Korrigieren Sie die Argumente. Dieselben Argumente werden auf dieselbe Weise abgelehnt.'],
              ['`isError: true`, `usage_limit_reached`', 'Ein Free-Workspace hat seine E-Mail-Aktionen für den Monat verbraucht.', 'Warten Sie auf das Rücksetzdatum in `_meta` oder führen Sie ein Upgrade durch. Bezahlte Tarife haben keine monatliche Obergrenze.'],
              ['`isError: true`, sonstige', 'Das Tool lief und ist gescheitert: Nachricht nicht gefunden, Anbieter hat abgelehnt, ungültiger Empfänger und so weiter.', 'Lesen Sie `content[0].text`. Dort steht, was passiert ist und ob etwas gesendet wurde.'],
            ],
          },
        },
        { code: 'scopeError', lang: 'http' },
        { code: 'rateError', lang: 'http' },
        { code: 'invalidArgs', lang: 'json' },
      ],
    },
    {
      id: 'pagination',
      h: 'Paginierung',
      blocks: [
        { p: 'Jedes Listen- und Suchergebnis endet mit denselben vier Feldern:' },
        {
          items: [
            '`has_more`: true, wenn eine weitere Seite existiert. Nur `has_more: false` bedeutet, dass Sie alles gesehen haben.',
            '`next_offset`: Geben Sie ihn als `offset` zurück, mit allen anderen Argumenten unverändert, um die nächste Seite zu erhalten. Er ist `null`, wenn `has_more` false ist.',
            '`total`: die Zahl der Treffer, oder `null`, wenn der Anbieter sie nicht zählen kann. Sie widerspricht nie der Seite, die Sie gerade halten.',
            '`total_is_estimate`: true, wenn `total` eine Schätzung oder eine Untergrenze ist und keine exakte Zählung.',
          ],
        },
        { p: 'Lange Nachrichtentexte werden auf dieselbe Weise in Abschnitte geteilt: Wenn `body_truncated` true ist, lesen Sie erneut mit `body_next_offset` als `body_offset`.' },
      ],
    },
    {
      id: 'idempotency',
      h: 'Wiederholungen und Idempotenzschlüssel',
      blocks: [
        { p: 'Eine abgebrochene Verbindung nach einem Versand lässt Sie im Unklaren, ob die E-Mail rausgegangen ist. Übergeben Sie einen `idempotency_key` und wiederholen Sie mit demselben Schlüssel: Die Arbeit läuft genau einmal.' },
        { code: 'send', lang: 'bash' },
        {
          items: [
            'Akzeptiert bei Sendungen, Antworten, Weiterleitungen, geplanten Sendungen, Entwurfsänderungen und Postfachänderungen wie Verschieben, Markieren und Löschen. `tools/list` zeigt `idempotency_key` im Eingabeschema jedes Tools, das ihn annimmt.',
            'Bis zu 200 Zeichen. Verwenden Sie etwas aus Ihrem eigenen System, etwa eine Bestellnummer und einen Ereignisnamen.',
            'Schlüssel sind an den API-Schlüssel gebunden, der sie gesendet hat, und werden 24 Stunden lang gemerkt.',
            'Eine Wiederholung mit demselben Schlüssel und denselben Argumenten läuft nicht erneut. Sie liefert `idempotent_replay: true`, den ursprünglichen `status` und das ursprüngliche Ergebnis in `result`, einschließlich der `message_id`, die Ihnen vielleicht verloren ging.',
            'Derselbe Schlüssel mit anderen Argumenten wird mit `idempotency_key_conflict` abgelehnt. Verwenden Sie für eine neue Operation einen neuen Schlüssel.',
            'Eine Wiederholung, während der erste Aufruf noch läuft, liefert `status: "processing"`. Versuchen Sie es kurz darauf erneut.',
            'Wenn der Mailanbieter einen Versand abgelehnt hat, bevor er ihn angenommen hat, wurde nichts gesendet und der Schlüssel wird freigegeben, sodass die identische Wiederholung tatsächlich sendet.',
            'Wenn der Ausgang ungewiss ist, meldet die Wiedergabe `status: "unknown"`. Prüfen Sie den Ordner Gesendet, bevor Sie unter einem neuen Schlüssel erneut senden.',
          ],
        },
        { code: 'replay', lang: 'json' },
      ],
    },
    {
      id: 'approval',
      h: 'Sendefreigabe',
      blocks: [
        { p: 'Jedes Postfach kann jede Sendung zurückhalten, bis eine Person sie freigibt. Eine Sendung aus Ihrem Skript liefert dann eine `approval_id` mit `status: "pending_approval"`, statt rauszugehen, und geht raus, sobald jemand sie im Dashboard freigibt. Das funktioniert in jedem Tarif und ist eine gute Voreinstellung, solange sich eine neue Automatisierung erst bewähren muss. Eine Wiederholung mit demselben `idempotency_key` meldet die Freigabe, statt eine zweite anzulegen.' },
      ],
    },
    {
      id: 'rate-limits',
      h: 'Ratenlimits',
      blocks: [
        { p: 'Jeder Tarif hat eine Obergrenze pro Minute für den gesamten Workspace. Ein einzelner Schlüssel kann das volle Minutenlimit des Tarifs nutzen; mehrere Schlüssel teilen es sich.' },
        { planTable: true },
        {
          items: [
            '`tools/call`-Antworten tragen `RateLimit-Limit`, `RateLimit-Remaining` und `RateLimit-Reset` (in Sekunden) für das Zeitfenster, das am nächsten an seiner Grenze ist, damit ein Client sein Tempo anpassen kann, bevor er das Limit erreicht.',
            'Jeder Schlüssel hat außerdem Stunden- und Tagesfenster. Ein 429 nennt in `data.window` das Fenster, das voll ist.',
            'Ein 429 trägt `Retry-After` in Sekunden. Warten Sie so lange und senden Sie dann dieselbe Anfrage erneut.',
            'Free enthält ein monatliches Kontingent an E-Mail-Aktionen. Bezahlte Tarife haben keine monatliche Obergrenze und keine Kosten pro Aufruf.',
          ],
        },
      ],
    },
    {
      id: 'webhooks',
      h: 'Webhooks für neue E-Mails',
      blocks: [
        { p: 'In Pro und Business kann MCPEmails einen POST an Ihre URL senden, wenn E-Mails in einem Postfach eintreffen, sodass ein Workflow bei neuer Post startet, statt abzufragen. Erstellen Sie im Dashboard einen Endpunkt, wählen Sie seine Postfächer und kopieren Sie das Signaturgeheimnis, das einmal angezeigt wird. Die URL muss HTTPS sein, auf Port 443 oder 8443. Mit der Testschaltfläche senden Sie ein signiertes `ping`-Ereignis.' },
        { h3: 'Das Ereignis' },
        { code: 'webhookPayload', lang: 'http' },
        {
          items: [
            '`type` ist `message.received`. `message_ids` listet die neuen Nachrichten im Ordner `INBOX` dieses Postfachs, bis zu 10 pro Ereignis; `count` ist die Zahl der eingetroffenen Nachrichten und kann höher sein.',
            'Standardmäßig enthält die Nutzlast nur IDs, keinen Inhalt. Ein Endpunkt, der auf Header einschließen gestellt ist, erhält zusätzlich eine `messages`-Liste mit `id`, `from` und `subject` jeder Nachricht.',
            'Holen Sie die Nachricht mit `email_read` (`action: "read"`, der `inbox_id` und einer `message_id`) über einen API-Schlüssel. Die Scopes und der Postfachzugriff dieses Schlüssels gelten wie gewohnt.',
            'Die Zustellung erfolgt in der Regel innerhalb von etwa zwei Minuten nach Eintreffen der Nachricht. Postfächer werden nach Zeitplan geprüft, es geschieht also nicht sofort.',
          ],
        },
        { h3: 'Signatur prüfen' },
        { p: 'Jede Zustellung trägt `MCPEmails-Signature: t=<Unix-Sekunden>,v1=<hex>`, wobei `v1` der HMAC-SHA256 über den Zeitstempel, einen Punkt und den rohen Anfragekörper ist, mit dem Geheimnis des Endpunkts als Schlüssel. Der Schlüssel ist das ganze Geheimnis wie angezeigt, einschließlich des Präfixes `whsec_`. Berechnen Sie die Signatur über den rohen Körper neu, vergleichen Sie in konstanter Zeit und lehnen Sie einen Zeitstempel ab, der älter als fünf Minuten ist.' },
        { code: 'webhookVerify', lang: 'js' },
        { h3: 'Wiederholungen' },
        {
          items: [
            'Antworten Sie innerhalb von 10 Sekunden mit einem beliebigen 2xx-Status. Alles andere zählt als Fehlschlag, auch eine Weiterleitung, der nicht gefolgt wird.',
            'Eine fehlgeschlagene Zustellung wird nach 1 Minute, 5 Minuten, 30 Minuten, 2 Stunden, 6 Stunden und 24 Stunden wiederholt. Jede Wiederholung wird mit einem frischen Zeitstempel neu signiert.',
            'Ein Endpunkt, der 24 Stunden lang oder 50-mal in Folge fehlgeschlagen ist, wird deaktiviert, und der Workspace-Inhaber wird per E-Mail informiert. Sie können ihn im Dashboard wieder einschalten.',
            'Verwenden Sie `MCPEmails-Event-Id`, um eine bereits verarbeitete Zustellung zu ignorieren. Eine Wiederholung trägt dieselbe Ereignis-ID.',
          ],
        },
      ],
    },
    {
      id: 'recipes',
      h: 'Rezepte',
      blocks: [
        { h3: 'n8n: einen Workflow bei neuer E-Mail starten' },
        {
          items: [
            'Fügen Sie einen **Webhook**-Trigger-Node mit der HTTP-Methode `POST` hinzu und registrieren Sie seine Produktions-URL als Webhook-Endpunkt im MCPEmails-Dashboard.',
            'Fügen Sie einen **HTTP Request**-Node hinzu: Methode `POST`, URL `https://mcpemails.com/api/mcp`, Authentifizierung **Generic Credential Type** → **Header Auth** mit dem Namen `Authorization` und dem Wert `Bearer mcpe_...`.',
            'Aktivieren Sie **Send Body**, wählen Sie **JSON** und verwenden Sie den Body unten, um die neue Nachricht zu lesen. Die folgenden Nodes erhalten die Nachricht in `result.structuredContent`.',
            'Um die Signatur in n8n zu prüfen, aktivieren Sie **Raw Body** am Webhook-Node und führen die obige Prüfung in einem **Code**-Node aus. Auf selbst gehostetem n8n erlauben Sie das crypto-Modul mit `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.',
          ],
        },
        { code: 'n8nBody', lang: 'json' },
        { p: 'Für einen AI-Agent-Node, der selbst E-Mails liest und sendet, siehe den [n8n-Leitfaden](/docs/n8n).' },
        { h3: 'Claude Code' },
        { p: 'Fügen Sie den Server mit einem Schlüssel in einem Header hinzu. Das passt zu Headless-Maschinen und CI, wo es keinen Browser für die OAuth-Anmeldung gibt:' },
        { code: 'claudeCode', lang: 'bash' },
        { p: 'Der [Claude-Code-Leitfaden](/docs/claude-code) behandelt die OAuth-Anmeldung und die Wahl der Scopes.' },
        { h3: 'Ein kurzes Node-Skript' },
        { p: 'Listet jede ungelesene Nachricht in einem Postfach, Seite für Seite, und wartet einen 429 ab:' },
        { code: 'node', lang: 'js' },
        { h3: 'OpenClaw' },
        { p: 'OpenClaw meldet sich standardmäßig mit OAuth an; der [OpenClaw-Leitfaden](/docs/openclaw) führt Sie hindurch. Um stattdessen einen eingeschränkten Schlüssel zu verwenden, tragen Sie ihn in die `headers`-Map des Servereintrags ein und lassen `auth` leer, denn OpenClaw ignoriert einen statischen `Authorization`-Header bei einem Eintrag, der auf OAuth steht.' },
        { code: 'openclaw', lang: 'json' },
      ],
    },
  ],
  planTable: {
    head: ['Tarif', 'Anfragen pro Minute', 'Webhooks'],
    yes: 'Ja',
    no: 'Nein',
  },
  cta: {
    title: 'Mit einem Postfach starten, kostenlos',
    sub: 'Erstellen Sie einen Schlüssel, rufen Sie tools/list auf und sehen Sie Ihre eigenen E-Mails als JSON zurückkommen.',
    button: 'Loslegen',
    pricing: 'Preise ansehen',
    developers: 'Warum Entwickler MCPEmails nutzen',
  },
};

const zh = {
  meta: {
    title: '面向开发者的邮件 API：MCPEmails HTTP 指南',
    description:
      '从脚本、n8n 和你自己的代理调用 MCPEmails：API 密钥与权限范围、用 curl 发起的 JSON-RPC 调用、错误、分页、幂等键、速率限制，以及新邮件的签名 webhook。',
  },
  breadcrumb: '开发者指南',
  eyebrow: '文档',
  title: '基于 MCPEmails 构建',
  lead:
    'MCP 客户端能做的一切，脚本都能用普通 HTTPS 完成。一个端点，一个 API 密钥，JSON 进，JSON 出。本指南涵盖身份验证、你需要的三个调用、错误、重试、限制，以及新邮件的 webhook。',
  toc: '本页内容',
  codeLabels: {
    bash: 'bash',
    http: 'HTTP',
    json: 'JSON',
    js: 'JavaScript',
  },
  sections: [
    {
      id: 'endpoint',
      h: '端点',
      blocks: [
        { p: '每个请求都是发往 `https://mcpemails.com/api/mcp` 的 JSON-RPC 2.0 `POST`。这与 claude.ai、ChatGPT 和其他 MCP 客户端使用的是同一个端点，工具相同，权限相同，所以脚本和聊天助手看到的是同一个产品。' },
        {
          items: [
            '发送 `Content-Type: application/json` 和 `Accept: application/json`。响应是一个 JSON 对象。',
            '服务器不保存会话。没有需要打开或关闭的东西，每个请求都带自己的 `Authorization` 头。',
            '成功的工具结果带有类型化的 `structuredContent` 对象，你不必解析自然语言。同样的数据也以 JSON 字符串形式放在 `content[0].text` 中。',
          ],
        },
      ],
    },
    {
      id: 'auth',
      h: '身份验证',
      blocks: [
        { h3: 'API 密钥' },
        {
          items: [
            '在控制台的 **API 密钥** → **新建密钥** 中创建密钥。按将要使用它的脚本或工作流命名。',
            '密钥是 `mcpe_` 加 64 个十六进制字符。它只在创建时显示一次，之后只保存哈希。请当场复制；丢失的密钥无法找回，只能替换。',
            '每次请求都以 `Authorization: Bearer mcpe_...` 的形式发送。切勿把密钥放进 URL 或查询字符串。',
            '每个套餐都可以创建任意数量的密钥。每个脚本或工作流用一个密钥，这样撤销一个不会影响其他的。',
            '在 **API 密钥** 页面撤销密钥会立即终止访问。',
          ],
        },
        { h3: '权限范围' },
        { p: '每个密钥只拥有你在创建时勾选的权限。之后可以通过 **编辑访问权限** 修改，改动在下一次调用时生效，无需重新连接。' },
        {
          table: {
            head: ['权限范围', '允许的操作'],
            rows: [
              ['`read:email`', '列出、阅读和搜索邮件，下载附件，列出收件箱和文件夹。'],
              ['`search:email`', '为旧密钥保留。搜索已由 `read:email` 覆盖。'],
              ['`send:email`', '发送、回复和转发。'],
              ['`manage:drafts`', '创建、更新和删除草稿。发送草稿还需要 `send:email`。'],
              ['`manage:folders`', '移动、复制、标记和归档邮件；创建、重命名和删除文件夹。'],
              ['`delete:email`', '删除和批量删除邮件。'],
              ['`manage:contacts`', '从最近的邮件中搜索联系人。'],
              ['`schedule:email`', '定时发送以及管理已定时的邮件。'],
              ['`manage:automations`', '创建按计划运行、无需有人看管的规则。'],
            ],
          },
        },
        { p: '从 `read:email` 开始，只在工作流确实需要时再添加写入权限。超出密钥权限范围的调用会在我们联系你的邮件服务器之前被拒绝。工作区中的查看者只能持有读取权限。' },
        { h3: '收件箱访问' },
        { p: '默认情况下，密钥可以访问工作区中的所有收件箱。要把它限定在其中几个，请在密钥上打开 **编辑访问权限**，在 **收件箱访问** 下选择收件箱。这一限制在每次调用时都会检查，所以限定在支持收件箱的密钥读不到财务收件箱，无论请求怎么写。' },
        { h3: '连接器应用的 OAuth' },
        { p: '由用户自行连接的应用，例如 claude.ai、ChatGPT 和其他 MCP 客户端，使用 OAuth 而不是密钥登录：动态客户端注册、带 PKCE 的授权码，以及一个由用户选择权限范围和收件箱的授权页面。参见 [OAuth 连接](/docs#oauth)。对于你自己的脚本、服务器和工作流，API 密钥更简单。' },
      ],
    },
    {
      id: 'calls',
      h: '三个调用',
      blocks: [
        { h3: '1. initialize（可选）' },
        { p: 'MCP 客户端以 `initialize` 开始。脚本可以跳过它，因为服务器不保存会话，但它是检查密钥是否可用、读取服务器说明的低成本方式。' },
        { code: 'initialize', lang: 'bash' },
        { h3: '2. tools/list' },
        { p: '`tools/list` 返回该密钥可以调用的每个工具，包括描述、输入 schema 和输出 schema。请在启动时读取它，而不是硬编码工具名或参数：列表按密钥的权限范围过滤，而且工具会随时间增加参数。' },
        { code: 'toolsList', lang: 'bash' },
        { h3: '3. tools/call' },
        { p: '按名称调用工具并传入参数。大多数工具接受一个 `action` 来决定做什么，例如 `email_read` 上的 `list`、`read` 或 `search`。用 `inbox`（邮箱地址）或 `inbox_id` 指定邮箱；`inbox_list` 会同时返回两者。' },
        { code: 'toolsCall', lang: 'bash' },
        { p: '一个成功的结果：' },
        { code: 'result', lang: 'json' },
        { p: '[工具参考](/docs#tools) 介绍每个工具，[curl 指南](/docs/curl) 有更多示例。' },
      ],
    },
    {
      id: 'errors',
      h: '错误',
      blocks: [
        { p: '错误有两类。完全无法执行的请求以带 HTTP 状态码的 JSON-RPC `error` 返回。到达了工具但被工具拒绝的请求以普通 `result` 返回，并带 `isError: true`，这样 AI 模型可以读到原因。请根据 `data.error_code` 或 `_meta` 中的代码分支，不要依赖消息文本。' },
        {
          table: {
            head: ['响应', '何时出现', '如何处理'],
            rows: [
              ['HTTP 401, `-32001`', '密钥缺失、格式错误、已撤销或已过期。', '修正 `Authorization` 头或创建新密钥。重试没有用。'],
              ['HTTP 403, `-32004`, `insufficient_scope`', '密钥缺少此工具操作所需的权限范围。`data.required_scopes` 列出了可以放行的权限。', '通过 **编辑访问权限** 添加该权限范围，或换用另一个密钥。'],
              ['HTTP 429, `-32003`, `rate_limit_exceeded`', '请求过多。`data.window` 说明哪个窗口已满。', '等待 `Retry-After` 秒（也在 `data.retry_after` 中），然后重试同一请求。'],
              ['`-32602`', '未知的工具名。`data.available_tools` 列出该密钥可以调用的名称。', '使用 `tools/list` 中的名称。'],
              ['`isError: true`, `invalid_arguments`', '参数未通过工具的 schema 校验。什么都没有执行。文本会指出每个错误的参数，如果参数名是猜的，还会给出实际存在的那个。', '修正参数。同样的参数会以同样的方式被拒绝。'],
              ['`isError: true`, `usage_limit_reached`', '免费工作区已用完当月的邮件操作额度。', '等待 `_meta` 中的重置日期，或升级套餐。付费套餐没有月度上限。'],
              ['`isError: true`, 其他', '工具已运行但失败：邮件不存在、服务商拒绝、收件人无效等。', '阅读 `content[0].text`。它会说明发生了什么，以及是否有邮件被发出。'],
            ],
          },
        },
        { code: 'scopeError', lang: 'http' },
        { code: 'rateError', lang: 'http' },
        { code: 'invalidArgs', lang: 'json' },
      ],
    },
    {
      id: 'pagination',
      h: '分页',
      blocks: [
        { p: '每个列表和搜索结果都以同样的四个字段结尾：' },
        {
          items: [
            '`has_more`：还有下一页时为 true。只有 `has_more: false` 才表示你已看完全部。',
            '`next_offset`：把它作为 `offset` 传回，其他参数保持不变，即可获取下一页。`has_more` 为 false 时它为 `null`。',
            '`total`：匹配数量，服务商无法统计时为 `null`。它永远不会与你手上的这一页矛盾。',
            '`total_is_estimate`：当 `total` 是估计值或下限而非精确计数时为 true。',
          ],
        },
        { p: '过长的邮件正文以同样方式分段：当 `body_truncated` 为 true 时，用 `body_next_offset` 作为 `body_offset` 再读一次。' },
      ],
    },
    {
      id: 'idempotency',
      h: '重试与幂等键',
      blocks: [
        { p: '发送后连接中断，你就无法知道邮件是否已发出。传入 `idempotency_key` 并用同一个键重试：操作只执行一次。' },
        { code: 'send', lang: 'bash' },
        {
          items: [
            '适用于发送、回复、转发、定时发送、草稿写入，以及移动、标记、删除等邮箱更改。`tools/list` 会在每个接受它的工具的输入 schema 中显示 `idempotency_key`。',
            '最长 200 个字符。使用你自己系统里的内容，例如订单号加事件名。',
            '键与发送它的 API 密钥绑定，保留 24 小时。',
            '用同一个键和同样的参数重试不会再次执行。它返回 `idempotent_replay: true`、原始的 `status`，以及 `result` 中的原始结果，包括你可能丢失的 `message_id`。',
            '同一个键配不同的参数会以 `idempotency_key_conflict` 被拒绝。新操作请用新键。',
            '在第一次调用仍在运行时重试会返回 `status: "processing"`。稍后再试。',
            '如果邮件服务商在接受之前就拒绝了发送，则什么都没有发出，键会被释放，这样完全相同的重试会真正发送。',
            '当结果不确定时，重放会返回 `status: "unknown"`。在用新键再次发送之前，请先检查已发送文件夹。',
          ],
        },
        { code: 'replay', lang: 'json' },
      ],
    },
    {
      id: 'approval',
      h: '发送审批',
      blocks: [
        { p: '任何收件箱都可以暂留每一次发送，等人工审批。此时脚本的发送会返回带 `status: "pending_approval"` 的 `approval_id` 而不是直接发出，等有人在控制台批准后才会发送。这在所有套餐上都可用，是新自动化在证明自己之前的好默认设置。用同一个 `idempotency_key` 重试会报告该审批，而不是再创建一个。' },
      ],
    },
    {
      id: 'rate-limits',
      h: '速率限制',
      blocks: [
        { p: '每个套餐对整个工作区都有一个每分钟上限。单个密钥可以用满套餐的每分钟限额；多个密钥则共享它。' },
        { planTable: true },
        {
          items: [
            '`tools/call` 的响应带有 `RateLimit-Limit`、`RateLimit-Remaining` 和 `RateLimit-Reset`（秒），对应最接近满额的那个窗口，客户端可以据此在触发限制前自行控制节奏。',
            '每个密钥还有小时和天窗口。429 会在 `data.window` 中指出哪个窗口已满。',
            '429 带有以秒计的 `Retry-After`。等待这么久，然后重试同一请求。',
            '免费套餐包含每月的邮件操作额度。付费套餐没有月度上限，也不按调用计费。',
          ],
        },
      ],
    },
    {
      id: 'webhooks',
      h: '新邮件 webhook',
      blocks: [
        { p: '在 Pro 和 Business 套餐上，当邮件到达收件箱时，MCPEmails 可以向你的 URL 发送 POST，让工作流由新邮件触发，而不必轮询。在控制台创建端点，选择它的收件箱，并复制只显示一次的签名密钥。URL 必须是 HTTPS，端口为 443 或 8443。用测试按钮发送一个带签名的 `ping` 事件。' },
        { h3: '事件' },
        { code: 'webhookPayload', lang: 'http' },
        {
          items: [
            '`type` 为 `message.received`。`message_ids` 列出该收件箱 `INBOX` 文件夹中的新邮件，每个事件最多 10 条；`count` 是到达的数量，可能更多。',
            '默认情况下负载只包含 id，不含内容。设置为包含邮件头的端点还会收到一个 `messages` 列表，含每封邮件的 `id`、`from` 和 `subject`。',
            '用 API 密钥通过 `email_read`（`action: "read"`、`inbox_id` 和 `message_id`）获取邮件。该密钥的权限范围和收件箱访问照常生效。',
            '投递通常在邮件到达后约两分钟内完成。收件箱按计划检查，所以不是即时的。',
          ],
        },
        { h3: '验证签名' },
        { p: '每次投递都带有 `MCPEmails-Signature: t=<unix 秒>,v1=<hex>`，其中 `v1` 是以端点密钥计算的 HMAC-SHA256，输入为时间戳、一个点和原始请求体。密钥是显示的完整 secret，包括 `whsec_` 前缀。对原始请求体重新计算签名，用恒定时间比较，并拒绝超过五分钟的时间戳。' },
        { code: 'webhookVerify', lang: 'js' },
        { h3: '重试' },
        {
          items: [
            '在 10 秒内以任意 2xx 状态响应。其他一切都算失败，包括重定向，我们不会跟随重定向。',
            '失败的投递会在 1 分钟、5 分钟、30 分钟、2 小时、6 小时和 24 小时后重试。每次重试都用新的时间戳重新签名。',
            '连续失败 24 小时或连续失败 50 次的端点会被停用，并通过邮件通知工作区所有者。你可以在控制台重新启用它。',
            '用 `MCPEmails-Event-Id` 忽略已经处理过的投递。重试会带同一个事件 id。',
          ],
        },
      ],
    },
    {
      id: 'recipes',
      h: '实用示例',
      blocks: [
        { h3: 'n8n：由新邮件触发工作流' },
        {
          items: [
            '添加一个 HTTP 方法为 `POST` 的 **Webhook** 触发节点，并把它的生产 URL 注册为 MCPEmails 控制台中的 webhook 端点。',
            '添加一个 **HTTP Request** 节点：方法 `POST`，URL `https://mcpemails.com/api/mcp`，身份验证选 **Generic Credential Type** → **Header Auth**，名称为 `Authorization`，值为 `Bearer mcpe_...`。',
            '开启 **Send Body**，选择 **JSON**，用下面的请求体读取新邮件。后续节点可以在 `result.structuredContent` 中拿到邮件。',
            '要在 n8n 中校验签名，请在 Webhook 节点上启用 **Raw Body**，并在 **Code** 节点中运行上面的验证代码。自托管的 n8n 需要用 `NODE_FUNCTION_ALLOW_BUILTIN=crypto` 放行 crypto 模块。',
          ],
        },
        { code: 'n8nBody', lang: 'json' },
        { p: '若要让 AI Agent 节点自己读取和发送邮件，请参阅 [n8n 指南](/docs/n8n)。' },
        { h3: 'Claude Code' },
        { p: '通过请求头中的密钥添加服务器。这适合没有浏览器完成 OAuth 登录的无头机器和 CI：' },
        { code: 'claudeCode', lang: 'bash' },
        { p: '[Claude Code 指南](/docs/claude-code) 介绍了 OAuth 登录和权限范围的选择。' },
        { h3: '一段简短的 Node 脚本' },
        { p: '逐页列出一个收件箱中的所有未读邮件，并在遇到 429 时等待：' },
        { code: 'node', lang: 'js' },
        { h3: 'OpenClaw' },
        { p: 'OpenClaw 默认使用 OAuth 登录；[OpenClaw 指南](/docs/openclaw) 有完整步骤。若要改用限定权限的密钥，请把它放进服务器条目的 `headers` 映射中，并且不要设置 `auth`，因为 OpenClaw 会忽略设为 OAuth 的条目上的静态 `Authorization` 头。' },
        { code: 'openclaw', lang: 'json' },
      ],
    },
  ],
  planTable: {
    head: ['套餐', '每分钟请求数', 'Webhook'],
    yes: '是',
    no: '否',
  },
  cta: {
    title: '从一个收件箱免费开始',
    sub: '创建一个密钥，调用 tools/list，看看你自己的邮件以 JSON 形式返回。',
    button: '开始使用',
    pricing: '查看价格',
    developers: '开发者为什么选择 MCPEmails',
  },
};

export const DEVELOPER_DOCS = { en, nb, es, fr, de, zh };

export function developerDocsCopy(locale) {
  return DEVELOPER_DOCS[locale] ?? en;
}

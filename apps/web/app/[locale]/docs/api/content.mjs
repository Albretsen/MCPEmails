// Copy for /docs/api, the developer guide, in every locale.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here
// (apps/web/CLAUDE.md). Same pattern as docs/read-only-access/content.mjs.
//
// TRANSLATION: only `en` is written. nb, es, fr, de and zh point at the
// English object until they are translated; replace each with its own object
// of the same shape. The code samples in CODE are shared by every locale and
// are not translated.
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

// Placeholders until translated: every locale renders English. See the header.
export const DEVELOPER_DOCS = { en, nb: en, es: en, fr: en, de: en, zh: en };

export function developerDocsCopy(locale) {
  return DEVELOPER_DOCS[locale] ?? en;
}

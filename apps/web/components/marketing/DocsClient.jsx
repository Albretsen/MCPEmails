'use client';

import { useState } from 'react';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';

/* ─── Quick-start steps ──────────────────────────────────────── */

const QUICKSTART_STEPS = [
  {
    num: '01',
    label: 'Sign up & connect an inbox',
    heading: 'Create your account and connect Gmail',
    body: 'Sign up at mcpemails.com, then go to Dashboard → Inboxes → Connect Inbox. Choose Gmail and follow the OAuth flow. Your inbox is ready in under a minute.',
    code: null,
    cta: { label: 'Connect your inbox →', href: '/signup' },
  },
  {
    num: '02',
    label: 'Create an API key',
    heading: 'Generate a bearer token for your agent',
    body: 'In Dashboard → API Keys, click "Create key". Give it a name, select the scopes your agent needs (read:email and/or send:email), and copy the key — it is shown only once.',
    code: `# Your key looks like this:
mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456`,
    cta: null,
  },
  {
    num: '03',
    label: 'Add MCPEmails to your agent',
    heading: 'Paste the MCP endpoint into your client',
    body: 'Use the tabs below for your client. claude.ai connects via OAuth — no API key needed, just paste the URL and authorize. For Claude Desktop, Cursor, or programmatic access, use your API key from step 02.',
    code: null,
    tabs: true,
    cta: null,
  },
  {
    num: '04',
    label: 'Make your first call',
    heading: 'Ask your agent to check your inbox',
    body: 'No inbox UUID copy-pasting needed. Your agent can call list_inboxes first to discover all connected inboxes and their UUIDs automatically. Then ask: "Check my inbox and summarise the last 5 unread messages."',
    code: `# The agent calls list_inboxes first — no hardcoded UUIDs needed.
# System prompt (optional, for multi-inbox setups):
You have access to email via MCPEmails.
Start by calling list_inboxes to discover available inboxes.`,
    cta: null,
  },
];

const CLIENT_SNIPPETS = {
  oauth: `# claude.ai — OAuth connection (no API key required)
#
# 1. Go to claude.ai → Customize → Connectors
# 2. Click "Add connector" and paste this URL:
#
#      https://www.mcpemails.com/mcp
#
# 3. Click Connect. MCPEmails will open an authorization screen
#    where you sign in with your mcpemails account.
# 4. After authorizing, all your tools are live in Claude.
#
# Under the hood: claude.ai uses OAuth 2.0 + PKCE with dynamic
# client registration (RFC 7591). No manual key setup needed.`,
  claude: `// claude_desktop_config.json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/mcp",
      "auth": {
        "type": "bearer",
        "token": "mcpe_live_YOUR_KEY_HERE"
      }
    }
  }
}`,
  cursor: `// .cursor/mcp.json
{
  "mcp": {
    "servers": {
      "mcpemails": {
        "url": "https://www.mcpemails.com/mcp",
        "bearer": "mcpe_live_YOUR_KEY_HERE"
      }
    }
  }
}`,
  raw: `# Raw JSON-RPC 2.0 — initialize handshake
curl -X POST https://www.mcpemails.com/mcp \\
  -H "Authorization: Bearer mcpe_live_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "clientInfo": { "name": "my-agent", "version": "1.0" },
      "capabilities": {}
    }
  }'`,
};

/* ─── Tool reference data ────────────────────────────────────── */

const TOOLS = [
  {
    name: 'list_inboxes',
    scope: 'read:email',
    title: 'List Inboxes',
    desc: 'Returns all inboxes the current API key or OAuth token is permitted to access. Call this first to discover inbox_id values — no copy-pasting UUIDs from the dashboard.',
    params: [],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "list_inboxes",
    "arguments": {}
  }
}`,
      response: `{
  "inboxes": [
    {
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "email_address": "alice@example.com",
      "display_name": "Alice (Work)",
      "provider": "gmail"
    },
    {
      "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d",
      "email_address": "alice@company.com",
      "display_name": "Company Outlook",
      "provider": "outlook"
    }
  ]
}`,
    },
  },
  {
    name: 'list_inbox',
    scope: 'read:email',
    title: 'List Inbox',
    desc: 'List email summaries from a connected inbox, newest first. Supports pagination, folder selection, and unread filtering.',
    params: [
      { name: 'inbox_id', type: 'string (uuid)', required: true,  desc: 'UUID of the inbox to list. Call list_inboxes first to discover available inbox IDs.' },
      { name: 'limit',    type: 'integer',       required: false, desc: 'Max results to return. Default 20, max 100.' },
      { name: 'offset',   type: 'integer',       required: false, desc: 'Zero-based pagination offset. Default 0.' },
      { name: 'folder',   type: 'string',        required: false, desc: 'Folder to list. Default "INBOX". Other values: "SENT", "DRAFTS", "TRASH".' },
      { name: 'unread_only', type: 'boolean',    required: false, desc: 'Return only unread messages. Default false.' },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "list_inbox",
    "arguments": {
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "limit": 5,
      "unread_only": true
    }
  }
}`,
      response: `{
  "messages": [
    {
      "id": "18a3c2d7f9b1e4a0",
      "from": { "name": "Alice Nguyen", "email": "alice@example.com" },
      "subject": "Q2 Forecast Report",
      "date": "2026-05-24T10:30:00Z",
      "preview": "Hi, please find the Q2 forecast attached...",
      "is_read": false,
      "has_attachments": true,
      "folder": "INBOX"
    }
  ],
  "total": 12,
  "has_more": true,
  "next_offset": 5
}`,
    },
  },
  {
    name: 'read_email',
    scope: 'read:email',
    title: 'Read Email',
    desc: 'Fetch the full content of a single email by ID, including plain-text body, optional sanitized HTML, and optional attachment data.',
    params: [
      { name: 'inbox_id',           type: 'string (uuid)', required: true,  desc: 'UUID of the inbox containing the email. Call list_inboxes to get available inbox IDs.' },
      { name: 'message_id',         type: 'string',        required: true,  desc: 'Provider message ID from list_inbox or search_emails.' },
      { name: 'include_html',       type: 'boolean',       required: false, desc: 'Include sanitized HTML body. Default false.' },
      { name: 'include_attachments',type: 'boolean',       required: false, desc: 'Include base64 attachment data. Default false.' },
      { name: 'mark_as_read',       type: 'boolean',       required: false, desc: 'Mark message as read after fetching. Default false.' },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {
    "name": "read_email",
    "arguments": {
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "message_id": "18a3c2d7f9b1e4a0",
      "mark_as_read": true
    }
  }
}`,
      response: `{
  "id": "18a3c2d7f9b1e4a0",
  "from": { "name": "Alice Nguyen", "email": "alice@example.com" },
  "to": [{ "name": "Bob Smith", "email": "bob@example.com" }],
  "cc": [], "bcc": [],
  "subject": "Q2 Forecast Report",
  "date": "2026-05-24T10:30:00Z",
  "body_text": "Hi Bob,\\n\\nPlease find the Q2 forecast attached.\\n\\nBest, Alice",
  "body_html": null,
  "attachments": [],
  "is_read": true,
  "labels": ["INBOX", "IMPORTANT"]
}`,
    },
  },
  {
    name: 'search_emails',
    scope: 'read:email',
    title: 'Search Emails',
    desc: 'Search an inbox using provider-native query syntax. Gmail supports Gmail search operators; Outlook uses $search; IMAP providers support a subset of IMAP SEARCH criteria.',
    params: [
      { name: 'inbox_id',       type: 'string (uuid)', required: true,  desc: 'UUID of the inbox to search. Call list_inboxes to get available inbox IDs.' },
      { name: 'query',          type: 'string',        required: true,  desc: 'Search query. For Gmail: "from:alice@example.com after:2026/01/01". For Outlook: natural-language or KQL queries.' },
      { name: 'limit',          type: 'integer',       required: false, desc: 'Max results. Default 20, max 100.' },
      { name: 'offset',         type: 'integer',       required: false, desc: 'Pagination offset. Default 0.' },
      { name: 'include_folders',type: 'array',         required: false, desc: 'Restrict search to these folders (IMAP only). Default: search all folders.' },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": {
    "name": "search_emails",
    "arguments": {
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "query": "from:alice@example.com subject:forecast",
      "limit": 10
    }
  }
}`,
      response: `{
  "messages": [
    {
      "id": "18a3c2d7f9b1e4a0",
      "from": { "name": "Alice Nguyen", "email": "alice@example.com" },
      "subject": "Q2 Forecast Report",
      "date": "2026-05-24T10:30:00Z",
      "preview": "Hi Bob, please find the Q2 forecast attached...",
      "is_read": false,
      "has_attachments": true
    }
  ],
  "total": 3,
  "has_more": false,
  "next_offset": 10,
  "query_normalized": "from:alice@example.com subject:forecast"
}`,
    },
  },
  {
    name: 'send_email',
    scope: 'send:email',
    title: 'Send Email',
    desc: 'Send a new email from a connected inbox. Supports plain text, optional HTML body, CC/BCC, and file attachments (up to 10 MB total).',
    params: [
      { name: 'inbox_id', type: 'string (uuid)',  required: true,  desc: 'UUID of the inbox to send from. Call list_inboxes to get available inbox IDs.' },
      { name: 'to',       type: 'array[string]',  required: true,  desc: 'Recipient email addresses. Max 50.' },
      { name: 'subject',  type: 'string',         required: true,  desc: 'Email subject line. Max 998 characters.' },
      { name: 'body',     type: 'string',         required: true,  desc: 'Plain-text email body.' },
      { name: 'cc',       type: 'array[string]',  required: false, desc: 'CC recipients. Default [].' },
      { name: 'bcc',      type: 'array[string]',  required: false, desc: 'BCC recipients. Default [].' },
      { name: 'html_body',type: 'string',         required: false, desc: 'HTML version of the body (multipart/alternative). Caller is responsible for safe HTML.' },
      { name: 'reply_to', type: 'string',         required: false, desc: 'Reply-To header address.' },
      { name: 'attachments', type: 'array',       required: false, desc: 'File attachments. Each item: { filename, mime_type, data (base64) }. Max 20 items, 10 MB total.' },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": {
    "name": "send_email",
    "arguments": {
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "to": ["carol@example.com"],
      "subject": "Follow-up on Q2 Forecast",
      "body": "Hi Carol,\\n\\nJust following up on the Q2 report.\\n\\nBest, Bob"
    }
  }
}`,
      response: `{
  "message_id": "18b4d3e8g0c2f5b1",
  "thread_id": "18b4d3e8g0c2f5b1",
  "sent_at": "2026-05-24T11:15:00Z",
  "to": [{ "name": "Carol Wang", "email": "carol@example.com" }],
  "cc": [], "bcc": [],
  "subject": "Follow-up on Q2 Forecast",
  "status": "sent"
}`,
    },
  },
  {
    name: 'reply_to_email',
    scope: 'send:email',
    title: 'Reply to Email',
    desc: 'Send a reply to an existing email. Threading headers (In-Reply-To, References) are set automatically. Supports reply-all and attachments.',
    params: [
      { name: 'inbox_id',   type: 'string (uuid)', required: true,  desc: 'UUID of the inbox that contains the original message. Call list_inboxes to get available inbox IDs.' },
      { name: 'message_id', type: 'string',        required: true,  desc: 'Provider message ID of the email being replied to.' },
      { name: 'body',       type: 'string',        required: true,  desc: 'Plain-text reply body.' },
      { name: 'html_body',  type: 'string',        required: false, desc: 'Optional HTML version of the reply.' },
      { name: 'reply_all',  type: 'boolean',       required: false, desc: 'Reply to all original recipients (To + Cc). Default false.' },
      { name: 'attachments',type: 'array',         required: false, desc: 'File attachments. Same schema as send_email. Max 20 items.' },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 6, "method": "tools/call",
  "params": {
    "name": "reply_to_email",
    "arguments": {
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "message_id": "18a3c2d7f9b1e4a0",
      "body": "Thanks Alice, I've reviewed the forecast. Looks good!",
      "reply_all": false
    }
  }
}`,
      response: `{
  "message_id": "18b4d3e8g0c2f5b2",
  "thread_id": "18a3c2d7f9b1e4a0",
  "sent_at": "2026-05-24T11:17:00Z",
  "in_reply_to": "18a3c2d7f9b1e4a0",
  "to": [{ "name": "Alice Nguyen", "email": "alice@example.com" }],
  "subject": "Re: Q2 Forecast Report",
  "status": "sent"
}`,
    },
  },
];

/* ─── Error codes ────────────────────────────────────────────── */

const ERROR_CODES = [
  { code: '-32001', type: 'Protocol', when: 'Invalid or revoked API key', retryable: false },
  { code: '-32601', type: 'Protocol', when: 'Unknown tool name', retryable: false },
  { code: '-32602', type: 'Protocol', when: 'Missing or invalid parameter', retryable: false },
  { code: 'inbox_not_found',    type: 'Execution', when: 'inbox_id not found or not accessible', retryable: false },
  { code: 'message_not_found',  type: 'Execution', when: 'message_id does not exist (may have been deleted)', retryable: false },
  { code: 'scope_denied',       type: 'Execution', when: 'API key lacks required scope for this tool', retryable: false },
  { code: 'invalid_recipient',  type: 'Execution', when: 'A recipient address failed RFC 5322 validation', retryable: false },
  { code: 'auth_failed',        type: 'Execution', when: 'Provider OAuth token expired/revoked — user must reconnect', retryable: false },
  { code: 'rate_limit_exceeded',type: 'Execution', when: 'Per-key rate limit hit (100/min, 1,000/hr, 10,000/day)', retryable: true },
  { code: 'quota_exceeded',     type: 'Execution', when: 'Daily send quota reached (plan limit)', retryable: false },
  { code: 'attachment_too_large',type: 'Execution', when: 'Total attachment size exceeds 10 MB', retryable: false },
  { code: 'search_timeout',     type: 'Execution', when: 'Provider search took > 30 seconds — simplify query', retryable: true },
  { code: 'provider_error',     type: 'Execution', when: 'Provider returned an unexpected 5xx error', retryable: true },
];

/* ─── Sub-components ─────────────────────────────────────────── */

function CodeBlock({ code, lang = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(code);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="docs-code-wrap">
      <div className="docs-code-bar">
        {lang && <span className="docs-code-lang">{lang}</span>}
        <button className="copy-btn" onClick={copy} style={{ marginLeft: 'auto' }}>
          <MIcon name="copy" size={12} color="var(--fg-3)" />
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="docs-pre"><code>{code}</code></pre>
    </div>
  );
}

function ClientTabs() {
  const [tab, setTab] = useState('oauth');
  const labels = { oauth: 'claude.ai (OAuth)', claude: 'Claude Desktop', cursor: 'Cursor', raw: 'Raw cURL' };
  return (
    <div style={{ marginTop: 16 }}>
      <div className="client-tabs">
        {Object.keys(labels).map(k => (
          <button
            key={k}
            className={'client-tab' + (tab === k ? ' active' : '')}
            onClick={() => setTab(k)}
          >
            {labels[k]}
          </button>
        ))}
      </div>
      <CodeBlock code={CLIENT_SNIPPETS[tab]} lang={tab === 'raw' ? 'bash' : 'json'} />
    </div>
  );
}

function QuickstartStep({ step }) {
  return (
    <div className="docs-step">
      <div className="docs-step-num">
        <span className="num">{step.num}</span>
        <span className="t">{step.label}</span>
      </div>
      <div className="docs-step-body">
        <h3>{step.heading}</h3>
        <p>{step.body}</p>
        {step.tabs && <ClientTabs />}
        {step.code && <CodeBlock code={step.code} />}
        {step.cta && (
          <a className="btn btn-primary" href={step.cta.href} style={{ marginTop: 16 }}>
            {step.cta.label}
          </a>
        )}
      </div>
    </div>
  );
}

function ParamBadge({ required }) {
  return (
    <span
      className="docs-badge"
      style={{
        background: required ? 'var(--cobalt-50)' : 'var(--bg-sunken)',
        color: required ? 'var(--cobalt-700)' : 'var(--fg-3)',
        border: required ? '1px solid rgba(37,71,229,0.18)' : '1px solid var(--border-1)',
      }}
    >
      {required ? 'required' : 'optional'}
    </span>
  );
}

function ScopeBadge({ scope }) {
  const isSend = scope === 'send:email';
  return (
    <span
      className="docs-badge"
      style={{
        background: isSend ? 'var(--amber-50)' : 'var(--mint-50)',
        color: isSend ? 'var(--amber-700)' : 'var(--mint-700)',
        border: isSend ? '1px solid rgba(217,119,6,0.2)' : '1px solid rgba(31,203,139,0.25)',
      }}
    >
      {scope}
    </span>
  );
}

function ToolSection({ tool }) {
  const [showExample, setShowExample] = useState(false);
  return (
    <div className="docs-tool" id={'tool-' + tool.name}>
      <div className="docs-tool-header">
        <div className="docs-tool-title">
          <code className="docs-tool-name">{tool.name}</code>
          <ScopeBadge scope={tool.scope} />
        </div>
        <p className="docs-tool-desc">{tool.desc}</p>
      </div>

      {tool.params.length === 0 ? (
        <div className="docs-params-wrap" style={{ padding: '12px 16px', color: 'var(--fg-3)', fontSize: 13, fontFamily: 'var(--font-sans)' }}>
          No parameters — call with an empty arguments object: <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 4 }}>{'{}'}</code>
        </div>
      ) : (
        <div className="docs-params-wrap">
          <table className="docs-params-tbl">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Type</th>
                <th>Required</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {tool.params.map(p => (
                <tr key={p.name}>
                  <td><code className="docs-param-name">{p.name}</code></td>
                  <td><span className="docs-type">{p.type}</span></td>
                  <td><ParamBadge required={p.required} /></td>
                  <td className="docs-param-desc">{p.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        className="docs-example-toggle"
        onClick={() => setShowExample(v => !v)}
      >
        <MIcon name="arrow" size={12} color="var(--cobalt-600)" />
        {showExample ? 'Hide' : 'Show'} example request &amp; response
      </button>

      {showExample && (
        <div className="docs-example-grid">
          <div>
            <div className="docs-example-label">Request</div>
            <CodeBlock code={tool.example.request} lang="json" />
          </div>
          <div>
            <div className="docs-example-label">Response</div>
            <CodeBlock code={tool.example.response} lang="json" />
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────── */

export default function DocsClient() {
  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">Documentation</div>
          <h1 className="pricing-page-h1">
            Your agent has an inbox<br />in four steps.
          </h1>
          <p className="pricing-page-lead">
            Connect any email account, paste one URL into claude.ai or generate
            an API key for Claude Desktop — done in minutes. Full tool reference
            and OAuth connection guide below.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a className="btn btn-primary btn-lg" href="#quickstart">Quick start</a>
            <a className="btn btn-secondary btn-lg" href="#oauth">OAuth (claude.ai)</a>
            <a className="btn btn-secondary btn-lg" href="#tools">Tool reference</a>
          </div>
        </div>
      </section>

      {/* Quick start */}
      <section className="section" id="quickstart" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">Quick start</div>
            <h2>Up and running in minutes.</h2>
            <p className="sub">No SDK required. MCPEmails speaks standard MCP over HTTP — drop it into any MCP-compatible agent.</p>
          </div>
          <div className="docs-steps">
            {QUICKSTART_STEPS.map(step => (
              <QuickstartStep key={step.num} step={step} />
            ))}
          </div>
        </div>
      </section>

      {/* MCP endpoint reference */}
      <section className="section" id="endpoint" style={{ paddingTop: 64, paddingBottom: 64, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">Endpoint</div>
            <h2>One URL, standard MCP.</h2>
            <p className="sub">
              All traffic goes to a single Streamable HTTP endpoint. Authenticate with a
              bearer token from your dashboard.
            </p>
          </div>

          <div className="docs-endpoint-grid">
            <div className="docs-endpoint-card">
              <div className="docs-endpoint-row">
                <span className="docs-method">POST</span>
                <code className="docs-url">https://mcpemails.com/mcp</code>
              </div>
              <p style={{ margin: '12px 0 0', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', lineHeight: 1.6 }}>
                Send a JSON-RPC 2.0 request body. Supported methods: <code>initialize</code>,{' '}
                <code>tools/list</code>, <code>tools/call</code>.
              </p>
            </div>

            <div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>Transport: <strong>Streamable HTTP</strong> (MCP 2024-11-05)</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>Auth: <strong>Authorization: Bearer &lt;api-key&gt;</strong></span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>Rate limits: <strong>100 req/min · 1,000/hr · 10,000/day</strong> per key</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>Response format: <strong>JSON-RPC 2.0</strong></span>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 32 }}>
            <div className="docs-example-label" style={{ marginBottom: 8 }}>Initialize handshake</div>
            <CodeBlock
              code={`curl -X POST https://mcpemails.com/mcp \\
  -H "Authorization: Bearer mcpe_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "clientInfo": { "name": "my-agent", "version": "1.0" },
      "capabilities": {}
    }
  }'`}
              lang="bash"
            />
          </div>
        </div>
      </section>

      {/* OAuth connection */}
      <section className="section" id="oauth" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">OAuth connection</div>
            <h2>Zero-config for claude.ai.</h2>
            <p className="sub">
              claude.ai and other OAuth 2.0 clients connect automatically via the standard
              authorization code + PKCE flow. No API key setup, no config file — just paste
              the URL and click Connect.
            </p>
          </div>

          <div className="docs-endpoint-grid" style={{ marginBottom: 32 }}>
            <div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span><strong>Step 1 —</strong> Go to claude.ai → Customize → Connectors → Add connector</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span><strong>Step 2 —</strong> Paste <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85em', background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 4 }}>https://www.mcpemails.com/mcp</code> as the server URL</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span><strong>Step 3 —</strong> Click Connect. MCPEmails opens an authorization screen</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span><strong>Step 4 —</strong> Sign in with your mcpemails account and approve access</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span><strong>Done —</strong> All six tools are live. claude.ai refreshes tokens automatically</span>
              </div>
            </div>

            <div>
              <div className="docs-endpoint-card">
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', lineHeight: 1.7 }}>
                  <p style={{ margin: '0 0 10px', fontWeight: 600, color: 'var(--fg-1)' }}>How it works under the hood</p>
                  <p style={{ margin: '0 0 8px' }}>
                    claude.ai registers itself via{' '}
                    <strong>RFC 7591 Dynamic Client Registration</strong> — you never need to
                    pre-register a client ID.
                  </p>
                  <p style={{ margin: '0 0 8px' }}>
                    Authorization uses <strong>OAuth 2.0 Authorization Code + PKCE</strong> (RFC 7636),
                    so no client secret is ever transmitted.
                  </p>
                  <p style={{ margin: 0 }}>
                    Tokens are scoped to exactly the permissions you approve:{' '}
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85em', background: 'var(--bg-sunken)', padding: '1px 4px', borderRadius: 3 }}>read:email</code>{' '}
                    and/or{' '}
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85em', background: 'var(--bg-sunken)', padding: '1px 4px', borderRadius: 3 }}>send:email</code>.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div style={{ padding: '14px 18px', background: 'var(--bg-sunken)', borderRadius: 8, border: '1px solid var(--border-1)', fontSize: 13, color: 'var(--fg-3)', fontFamily: 'var(--font-sans)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--fg-2)' }}>Using Claude Desktop, Cursor, or a custom agent?</strong>{' '}
            Create an API key in Dashboard → API Keys and follow the Quick start above.
            API key and OAuth connections both use the same MCP endpoint and tools.
          </div>
        </div>
      </section>

      {/* Tool reference */}
      <section className="section" id="tools" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">Tool reference</div>
            <h2>Six tools. All the email ops your agent needs.</h2>
            <p className="sub">
              Start with <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9em', background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 4 }}>list_inboxes</code>{' '}
              to discover available inboxes and their UUIDs. The remaining five tools each take an{' '}
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9em', background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 4 }}>inbox_id</code>{' '}
              returned by that call. Click "Show example" to see a full request and response.
            </p>
          </div>

          {/* Tool nav */}
          <div className="docs-tool-nav">
            {TOOLS.map(t => (
              <a key={t.name} className="docs-tool-nav-item" href={'#tool-' + t.name}>
                <code>{t.name}</code>
                <ScopeBadge scope={t.scope} />
              </a>
            ))}
          </div>

          <div className="docs-tools-list">
            {TOOLS.map(tool => (
              <ToolSection key={tool.name} tool={tool} />
            ))}
          </div>
        </div>
      </section>

      {/* Error codes */}
      <section className="section" id="errors" style={{ paddingTop: 64, paddingBottom: 64, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">Error codes</div>
            <h2>Error codes &amp; retry guidance.</h2>
            <p className="sub">
              Protocol errors are returned as JSON-RPC error objects. Execution errors are returned as
              normal results with <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9em', background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 4 }}>isError: true</code>.
            </p>
          </div>

          <div className="comparison-wrap">
            <table className="comparison-tbl">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Type</th>
                  <th>When it occurs</th>
                  <th style={{ textAlign: 'center' }}>Retryable</th>
                </tr>
              </thead>
              <tbody>
                {ERROR_CODES.map(e => (
                  <tr key={e.code}>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{e.code}</code></td>
                    <td>
                      <span
                        className="docs-badge"
                        style={{
                          background: e.type === 'Protocol' ? 'var(--cobalt-50)' : 'var(--bg-sunken)',
                          color: e.type === 'Protocol' ? 'var(--cobalt-700)' : 'var(--fg-3)',
                          border: e.type === 'Protocol' ? '1px solid rgba(37,71,229,0.18)' : '1px solid var(--border-1)',
                        }}
                      >
                        {e.type}
                      </span>
                    </td>
                    <td style={{ color: 'var(--fg-2)', fontSize: 14 }}>{e.when}</td>
                    <td style={{ textAlign: 'center' }}>
                      {e.retryable
                        ? <MIcon name="check" size={16} color="var(--mint-600)" />
                        : <span style={{ color: 'var(--fg-4)', fontSize: 16 }}>—</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 32 }}>
            <div className="docs-example-label" style={{ marginBottom: 8 }}>Example execution error response</div>
            <CodeBlock
              code={`{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [{
      "type": "text",
      "text": "Inbox 3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c not found or not accessible."
    }],
    "isError": true,
    "errorCode": "inbox_not_found"
  }
}`}
              lang="json"
            />
          </div>
        </div>
      </section>

      {/* Rate limits */}
      <section className="section" id="rate-limits" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="section-head">
            <div className="eye-label">Rate limits</div>
            <h2>Rate limits &amp; quotas.</h2>
          </div>

          <div className="docs-steps" style={{ gap: 14 }}>
            <div className="step">
              <div className="num">Per key</div>
              <h4>100 requests / minute · 1,000 / hour · 10,000 / day</h4>
              <p>Limits are enforced per API key in rolling windows. When exceeded, the server returns <code>rate_limit_exceeded</code> with a <code>retryAfter</code> field (seconds to wait).</p>
            </div>
            <div className="step">
              <div className="num">Send quota</div>
              <h4>200 sends / day (Free) · 2,000 / day (Pro) · Custom (Enterprise)</h4>
              <p>Applies only to <code>send_email</code> and <code>reply_to_email</code>. Counted per workspace per UTC calendar day. Returns <code>quota_exceeded</code> when reached.</p>
            </div>
            <div className="step">
              <div className="num">Retrying</div>
              <h4>Use the retryAfter field — never retry sends blindly</h4>
              <p>For <code>rate_limit_exceeded</code> and <code>provider_error</code>, use exponential backoff starting at <code>retryAfter</code> seconds. Do not auto-retry <code>send_email</code> on <code>provider_error</code> — the message may have been accepted; check <code>delivery_status</code> first.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">Ready to connect your inbox?</h2>
          <p className="pricing-cta-sub">
            Start on the Free plan — 100 MCP calls / month, no card required.
            Upgrade when your agent needs more.
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">Get started free</a>
            <a className="btn btn-on-dark btn-lg" href="/pricing">See pricing</a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

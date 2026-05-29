'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';

// Rich-text tag handlers shared across this page (inline code + bold).
const RICH = {
  code: (chunks) => <code className="t-code-inline">{chunks}</code>,
  b: (chunks) => <strong>{chunks}</strong>,
};

/* ─── Quick-start steps ──────────────────────────────────────── */
// Structural data only; user-facing text is resolved via t('quickstart.steps.<id>.*').

const QUICKSTART_STEPS = [
  {
    num: '01',
    id: 'signup',
    code: null,
    cta: { id: 'signup', href: '/signup' },
  },
  {
    num: '02',
    id: 'apikey',
    code: `# Your key looks like this:
mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456`,
    cta: null,
  },
  {
    num: '03',
    id: 'addclient',
    code: null,
    tabs: true,
    cta: null,
  },
  {
    num: '04',
    id: 'firstcall',
    code: `# The agent calls list_inboxes first, so no hardcoded UUIDs.
# System prompt (optional, for multi-inbox setups):
You have access to email via MCPEmails.
Start by calling list_inboxes to discover available inboxes.`,
    cta: null,
  },
];

const CLIENT_SNIPPETS = {
  oauth: `# OAuth-capable clients (claude.ai, Claude Desktop, Cursor…)
# No API key required. Paste the URL, click Connect, authorize.
#
# Example: claude.ai
#   1. Go to claude.ai → Customize → Connectors
#   2. Click "Add connector" and paste this URL:
#
#        https://www.mcpemails.com/api/mcp
#
#   3. Click Connect and sign in with your mcpemails account.
#   4. All six tools are live immediately.
#
# Claude Desktop and Cursor follow the same OAuth flow when
# the server URL is configured in their MCP settings.`,
  claude: `// claude_desktop_config.json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
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
        "url": "https://www.mcpemails.com/api/mcp",
        "bearer": "mcpe_live_YOUR_KEY_HERE"
      }
    }
  }
}`,
  raw: `# Raw JSON-RPC 2.0: initialize handshake
curl -X POST https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer mcpe_live_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
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
};

/* ─── Tool reference data ────────────────────────────────────── */

const TOOLS = [
  {
    name: 'list_inboxes',
    scope: 'read:email',
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
    params: [
      { name: 'inbox_id', type: 'string (uuid)', required: true },
      { name: 'limit',    type: 'integer',       required: false },
      { name: 'offset',   type: 'integer',       required: false },
      { name: 'folder',   type: 'string',        required: false },
      { name: 'unread_only', type: 'boolean',    required: false },
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
    params: [
      { name: 'inbox_id',           type: 'string (uuid)', required: true },
      { name: 'message_id',         type: 'string',        required: true },
      { name: 'include_html',       type: 'boolean',       required: false },
      { name: 'include_attachments',type: 'boolean',       required: false },
      { name: 'mark_as_read',       type: 'boolean',       required: false },
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
    params: [
      { name: 'inbox_id',       type: 'string (uuid)', required: true },
      { name: 'query',          type: 'string',        required: true },
      { name: 'limit',          type: 'integer',       required: false },
      { name: 'offset',         type: 'integer',       required: false },
      { name: 'include_folders',type: 'array',         required: false },
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
    params: [
      { name: 'inbox_id', type: 'string (uuid)',  required: true },
      { name: 'to',       type: 'array[string]',  required: true },
      { name: 'subject',  type: 'string',         required: true },
      { name: 'body',     type: 'string',         required: true },
      { name: 'cc',       type: 'array[string]',  required: false },
      { name: 'bcc',      type: 'array[string]',  required: false },
      { name: 'html_body',type: 'string',         required: false },
      { name: 'reply_to', type: 'string',         required: false },
      { name: 'attachments', type: 'array',       required: false },
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
    params: [
      { name: 'inbox_id',   type: 'string (uuid)', required: true },
      { name: 'message_id', type: 'string',        required: true },
      { name: 'body',       type: 'string',        required: true },
      { name: 'html_body',  type: 'string',        required: false },
      { name: 'reply_all',  type: 'boolean',       required: false },
      { name: 'attachments',type: 'array',         required: false },
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
  { code: '-32001', type: 'JSON-RPC error', whenKey: 'auth', retryable: false },
  { code: '-32601', type: 'JSON-RPC error', whenKey: 'method', retryable: false },
  { code: '-32602', type: 'JSON-RPC error', whenKey: 'param', retryable: false },
  { code: '-32029', type: 'JSON-RPC error', whenKey: 'rate', retryable: true },
  { code: 'isError: true', type: 'Tool result', whenKey: 'tool', retryable: false },
];

/* ─── Sub-components ─────────────────────────────────────────── */

function CodeBlock({ code, lang = '' }) {
  const t = useTranslations('docs');
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
          {copied ? t('copy.copied') : t('copy.copy')}
        </button>
      </div>
      <pre className="docs-pre"><code>{code}</code></pre>
    </div>
  );
}

function ClientTabs() {
  const t = useTranslations('docs');
  const [tab, setTab] = useState('oauth');
  const tabKeys = ['oauth', 'claude', 'cursor', 'raw'];
  return (
    <div style={{ marginTop: 16 }}>
      <div className="client-tabs">
        {tabKeys.map(k => (
          <button
            key={k}
            className={'client-tab' + (tab === k ? ' active' : '')}
            onClick={() => setTab(k)}
          >
            {t(`clientTabs.${k}`)}
          </button>
        ))}
      </div>
      <CodeBlock code={CLIENT_SNIPPETS[tab]} lang={tab === 'raw' ? 'bash' : 'json'} />
    </div>
  );
}

function QuickstartStep({ step }) {
  const t = useTranslations('docs');
  const base = `quickstart.steps.${step.id}`;
  return (
    <div className="docs-step">
      <div className="docs-step-num">
        <span className="num">{step.num}</span>
        <span className="t">{t(`${base}.label`)}</span>
      </div>
      <div className="docs-step-body">
        <h3>{t(`${base}.heading`)}</h3>
        <p>{t(`${base}.body`)}</p>
        {step.tabs && <ClientTabs />}
        {step.code && <CodeBlock code={step.code} />}
        {step.cta && (
          <a className="btn btn-primary" href={step.cta.href} style={{ marginTop: 16 }}>
            {t(`${base}.cta`)}
          </a>
        )}
      </div>
    </div>
  );
}

function ParamBadge({ required }) {
  const t = useTranslations('docs');
  return (
    <span
      className="docs-badge"
      style={{
        background: required ? 'var(--cobalt-50)' : 'var(--bg-sunken)',
        color: required ? 'var(--cobalt-700)' : 'var(--fg-3)',
        border: required ? '1px solid rgba(37,71,229,0.18)' : '1px solid var(--border-1)',
      }}
    >
      {required ? t('tools.badgeRequired') : t('tools.badgeOptional')}
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
  const t = useTranslations('docs');
  const [showExample, setShowExample] = useState(false);
  return (
    <div className="docs-tool" id={'tool-' + tool.name}>
      <div className="docs-tool-header">
        <div className="docs-tool-title">
          <code className="docs-tool-name">{tool.name}</code>
          <ScopeBadge scope={tool.scope} />
        </div>
        <p className="docs-tool-desc">{t(`tools.${tool.name}.desc`)}</p>
      </div>

      {tool.params.length === 0 ? (
        <div className="docs-params-wrap" style={{ padding: '12px 16px', color: 'var(--fg-3)', fontSize: 13, fontFamily: 'var(--font-sans)' }}>
          {t('tools.noParams')} <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-sunken)', padding: '1px 5px', borderRadius: 4 }}>{'{}'}</code>
        </div>
      ) : (
        <div className="docs-params-wrap">
          <table className="docs-params-tbl">
            <thead>
              <tr>
                <th>{t('tools.thParameter')}</th>
                <th>{t('tools.thType')}</th>
                <th>{t('tools.thRequired')}</th>
                <th>{t('tools.thDescription')}</th>
              </tr>
            </thead>
            <tbody>
              {tool.params.map(p => (
                <tr key={p.name}>
                  <td><code className="docs-param-name">{p.name}</code></td>
                  <td><span className="docs-type">{p.type}</span></td>
                  <td><ParamBadge required={p.required} /></td>
                  <td className="docs-param-desc">{t(`tools.${tool.name}.params.${p.name}`)}</td>
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
        {showExample ? t('tools.hideExample') : t('tools.showExample')}
      </button>

      {showExample && (
        <div className="docs-example-grid">
          <div>
            <div className="docs-example-label">{t('tools.labelRequest')}</div>
            <CodeBlock code={tool.example.request} lang="json" />
          </div>
          <div>
            <div className="docs-example-label">{t('tools.labelResponse')}</div>
            <CodeBlock code={tool.example.response} lang="json" />
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────── */

export default function DocsClient() {
  const t = useTranslations('docs');
  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{t('hero.eyebrow')}</div>
          <h1 className="pricing-page-h1">
            {t('hero.titleLine1')}<br />{t('hero.titleLine2')}
          </h1>
          <p className="pricing-page-lead">
            {t('hero.lead')}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a className="btn btn-primary btn-lg" href="#quickstart">{t('hero.ctaQuickStart')}</a>
            <a className="btn btn-secondary btn-lg" href="#oauth">{t('hero.ctaOAuth')}</a>
            <a className="btn btn-secondary btn-lg" href="#tools">{t('hero.ctaTools')}</a>
            <a className="btn btn-secondary btn-lg" href="/docs/providers">{t('hero.ctaProviders')}</a>
          </div>
        </div>
      </section>

      {/* Quick start */}
      <section className="section" id="quickstart" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">{t('quickstart.eyebrow')}</div>
            <h2>{t('quickstart.heading')}</h2>
            <p className="sub">{t('quickstart.sub')}</p>
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
            <div className="eye-label">{t('endpoint.eyebrow')}</div>
            <h2>{t('endpoint.heading')}</h2>
            <p className="sub">
              {t('endpoint.sub')}
            </p>
          </div>

          <div className="docs-endpoint-grid">
            <div className="docs-endpoint-card">
              <div className="docs-endpoint-row">
                <span className="docs-method">POST</span>
                <code className="docs-url">https://www.mcpemails.com/api/mcp</code>
              </div>
              <p style={{ margin: '12px 0 0', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', lineHeight: 1.6 }}>
                {t.rich('endpoint.bodyMethods', RICH)}
              </p>
            </div>

            <div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('endpoint.infoTransport', RICH)}</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('endpoint.infoAuth', RICH)}</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('endpoint.infoRateLimits', RICH)}</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('endpoint.infoFormat', RICH)}</span>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 32 }}>
            <div className="docs-example-label" style={{ marginBottom: 8 }}>{t('endpoint.handshakeLabel')}</div>
            <CodeBlock
              code={`curl -X POST https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer mcpe_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
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
            <div className="eye-label">{t('oauth.eyebrow')}</div>
            <h2>{t('oauth.heading')}</h2>
            <p className="sub">
              {t('oauth.sub')}
            </p>
          </div>

          <div className="docs-endpoint-grid" style={{ marginBottom: 32 }}>
            <div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('oauth.step1', RICH)}</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('oauth.step2', RICH)}</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('oauth.step3', RICH)}</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('oauth.step4', RICH)}</span>
              </div>
              <div className="docs-info-row">
                <MIcon name="check" size={14} color="var(--mint-600)" />
                <span>{t.rich('oauth.stepDone', RICH)}</span>
              </div>
            </div>

            <div>
              <div className="docs-endpoint-card">
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', lineHeight: 1.7 }}>
                  <p style={{ margin: '0 0 10px', fontWeight: 600, color: 'var(--fg-1)' }}>{t('oauth.howTitle')}</p>
                  <p style={{ margin: '0 0 8px' }}>
                    {t.rich('oauth.howP1', RICH)}
                  </p>
                  <p style={{ margin: '0 0 8px' }}>
                    {t.rich('oauth.howP2', RICH)}
                  </p>
                  <p style={{ margin: 0 }}>
                    {t.rich('oauth.howP3', RICH)}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div style={{ padding: '14px 18px', background: 'var(--bg-sunken)', borderRadius: 8, border: '1px solid var(--border-1)', fontSize: 13, color: 'var(--fg-3)', fontFamily: 'var(--font-sans)', lineHeight: 1.6 }}>
            {t.rich('oauth.noOauthNote', RICH)}
          </div>
        </div>
      </section>

      {/* Tool reference */}
      <section className="section" id="tools" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">{t('tools.eyebrow')}</div>
            <h2>{t('tools.heading')}</h2>
            <p className="sub">
              {t.rich('tools.sub', RICH)}
            </p>
          </div>

          {/* Tool nav */}
          <div className="docs-tool-nav">
            {TOOLS.map(tool => (
              <a key={tool.name} className="docs-tool-nav-item" href={'#tool-' + tool.name}>
                <code>{tool.name}</code>
                <ScopeBadge scope={tool.scope} />
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
            <div className="eye-label">{t('errors.eyebrow')}</div>
            <h2>{t('errors.heading')}</h2>
            <p className="sub">
              {t.rich('errors.sub', RICH)}
            </p>
          </div>

          <div className="comparison-wrap">
            <table className="comparison-tbl">
              <thead>
                <tr>
                  <th>{t('errors.thCode')}</th>
                  <th>{t('errors.thType')}</th>
                  <th>{t('errors.thWhen')}</th>
                  <th style={{ textAlign: 'center' }}>{t('errors.thRetryable')}</th>
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
                    <td style={{ color: 'var(--fg-2)', fontSize: 14 }}>{t(`errors.rows.${e.whenKey}`)}</td>
                    <td style={{ textAlign: 'center' }}>
                      {e.retryable
                        ? <MIcon name="check" size={16} color="var(--mint-600)" />
                        : <span style={{ color: 'var(--fg-4)', fontSize: 16 }}>{t('errors.retryableNo')}</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 32 }}>
            <div className="docs-example-label" style={{ marginBottom: 8 }}>{t('errors.exampleLabel')}</div>
            <CodeBlock
              code={`// Tool execution error: inbox not found
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "Inbox not found or not accessible." }],
    "isError": true
  }
}

// Rate limit error: JSON-RPC error object with data
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded",
    "data": {
      "error_code": "rate_limit_exceeded",
      "window": "per_minute",
      "limit": 100,
      "used": 100,
      "retry_after": 34
    }
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
            <div className="eye-label">{t('rateLimits.eyebrow')}</div>
            <h2>{t('rateLimits.heading')}</h2>
          </div>

          <div className="docs-steps" style={{ gap: 14 }}>
            <div className="step">
              <div className="num">{t('rateLimits.perKeyTag')}</div>
              <h4>{t('rateLimits.perKeyHeading')}</h4>
              <p>{t.rich('rateLimits.perKeyBody', RICH)}</p>
            </div>
            <div className="step">
              <div className="num">{t('rateLimits.planTag')}</div>
              <h4>{t('rateLimits.planHeading')}</h4>
              <p>{t.rich('rateLimits.planBody', RICH)}</p>
            </div>
            <div className="step">
              <div className="num">{t('rateLimits.retryTag')}</div>
              <h4>{t('rateLimits.retryHeading')}</h4>
              <p>{t.rich('rateLimits.retryBody', RICH)}</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{t('cta.heading')}</h2>
          <p className="pricing-cta-sub">
            {t('cta.sub')}
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{t('cta.primary')}</a>
            <a className="btn btn-on-dark btn-lg" href="/pricing">{t('cta.secondary')}</a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

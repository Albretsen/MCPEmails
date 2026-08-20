'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
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
    code: `# The agent calls inbox_list first, so no hardcoded UUIDs.
# System prompt (optional, for multi-inbox setups):
You have access to email via MCPEmails.
Start by calling inbox_list to discover available inboxes.`,
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
#        https://mcpemails.com/api/mcp
#
#   3. Click Connect and sign in with your mcpemails account.
#   4. Every tool your approved scopes allow is live immediately.
#
# Claude Desktop and Cursor follow the same OAuth flow when
# the server URL is configured in their MCP settings.`,
  claude: `// claude_desktop_config.json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://mcpemails.com/api/mcp",
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
        "url": "https://mcpemails.com/api/mcp",
        "bearer": "mcpe_live_YOUR_KEY_HERE"
      }
    }
  }
}`,
  raw: `# Raw JSON-RPC 2.0: initialize handshake
curl -X POST https://mcpemails.com/api/mcp \\
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

/* ─── Scope styling ──────────────────────────────────────────── */
// Each tool is gated by exactly one scope. tools/list only returns the tools
// your key (or OAuth token) is scoped for. Colours map to the four token
// families available in the marketing theme.

const SCOPE_STYLES = {
  'read:email':     { bg: 'var(--mint-50)',   fg: 'var(--mint-700)',   border: '1px solid rgba(31,203,139,0.25)' },
  'search:email':   { bg: 'var(--mint-50)',   fg: 'var(--mint-700)',   border: '1px solid rgba(31,203,139,0.25)' },
  'send:email':     { bg: 'var(--amber-50)',  fg: 'var(--amber-700)',  border: '1px solid rgba(217,119,6,0.2)' },
  'manage:folders': { bg: 'var(--cobalt-50)', fg: 'var(--cobalt-700)', border: '1px solid rgba(37,71,229,0.18)' },
  'manage:drafts':  { bg: 'var(--cobalt-50)', fg: 'var(--cobalt-700)', border: '1px solid rgba(37,71,229,0.18)' },
  'manage:contacts':{ bg: 'var(--mint-50)',   fg: 'var(--mint-700)',   border: '1px solid rgba(31,203,139,0.25)' },
  'schedule:email': { bg: 'var(--amber-50)',  fg: 'var(--amber-700)',  border: '1px solid rgba(217,119,6,0.2)' },
  // Amber rather than cobalt: this is the only scope that lets the server touch
  // a mailbox with nobody watching, so it reads alongside the other
  // acts-on-the-world scopes instead of the quieter manage:* family.
  'manage:automations': { bg: 'var(--amber-50)', fg: 'var(--amber-700)', border: '1px solid rgba(217,119,6,0.2)' },
  'delete:email':   { bg: 'var(--red-50)',    fg: 'var(--red-700)',    border: '1px solid rgba(229,72,77,0.25)' },
};

/* ─── Tool reference data ────────────────────────────────────── */
// One card per consolidated tool, in the order the MCP server's tool registry
// returns them. Most tools take a required `action` selector; the param table
// lists the union of every action's params (each action uses the relevant
// subset — see the description). `scopes` lists every scope an action may need.
// params/examples are structural; descriptions are resolved via
// t('tools.<name>.desc') and t('tools.<name>.params.<param>').

const TOOLS = [
  {
    name: 'inbox_list',
    scopes: ['read:email'],
    params: [
      { name: 'provider',             type: 'enum',    required: false },
      { name: 'include_capabilities', type: 'boolean', required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "inbox_list",
    "arguments": {}
  }
}`,
      response: `{
  "inboxes": [
    {
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "email_address": "alice@example.com",
      "display_name": "Alice (Work)",
      "provider": "gmail",
      "service": null,
      "capabilities": {
        "flags": true, "folders": false, "labels": true,
        "move": true, "copy": false, "delete": true,
        "trash_vs_expunge": "trash", "forward": true, "drafts": true,
        "contacts_api": true, "contacts_db": true, "scheduling": true,
        "search_syntax": "gmail"
      },
      "compatibility": {
        "schema_version": "compatibility-v1",
        "profile": "gmail-v1",
        "status": "available",
        "operations": {
          "search.body": "different",
          "organization.move": "different",
          "organization.copy": "unavailable",
          "delete.permanent": "unavailable"
        }
      }
    },
    {
      "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d",
      "email_address": "alice@fastmail.com",
      "display_name": "Fastmail",
      "provider": "imap",
      "service": "fastmail",
      "capabilities": { "search_syntax": "imap", "copy": true },
      "compatibility": {
        "schema_version": "compatibility-v1",
        "profile": "imap-baseline-v1",
        "status": "available",
        "operations": { "search.has_attachment": "unavailable", "organization.move": "different" }
      }
    }
  ]
}`,
    },
  },
  {
    name: 'email_read',
    scopes: ['read:email', 'search:email'],
    params: [
      { name: 'action',              type: 'enum',          required: true },
      { name: 'inbox_id',            type: 'string (uuid)', required: false },
      { name: 'inbox',               type: 'string',        required: false },
      { name: 'message_id',          type: 'string',        required: false },
      { name: 'message_ids',         type: 'array[string]', required: false },
      { name: 'folder',              type: 'string',        required: false },
      { name: 'unread_only',         type: 'boolean',       required: false },
      { name: 'limit',               type: 'integer',       required: false },
      { name: 'offset',              type: 'integer',       required: false },
      { name: 'include_html',        type: 'boolean',       required: false },
      { name: 'include_attachments', type: 'boolean',       required: false },
      { name: 'mark_as_read',        type: 'boolean',       required: false },
      { name: 'from',                type: 'string',        required: false },
      { name: 'to',                  type: 'string',        required: false },
      { name: 'cc',                  type: 'string',        required: false },
      { name: 'subject',             type: 'string',        required: false },
      { name: 'body',                type: 'string',        required: false },
      { name: 'text',                type: 'string',        required: false },
      { name: 'unread',              type: 'boolean',       required: false },
      { name: 'has_attachment',      type: 'boolean',       required: false },
      { name: 'flagged',             type: 'boolean',       required: false },
      { name: 'since',               type: 'string (ISO date)', required: false },
      { name: 'before',              type: 'string (ISO date)', required: false },
      { name: 'query',               type: 'string',        required: false },
      { name: 'include_folders',     type: 'array',         required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "email_read",
    "arguments": {
      "action": "list",
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
    name: 'email_organize',
    scopes: ['manage:folders'],
    params: [
      { name: 'action',               type: 'enum',          required: true },
      { name: 'inbox_id',             type: 'string (uuid)', required: false },
      { name: 'inbox',                type: 'string',        required: false },
      { name: 'message_id',           type: 'string',        required: false },
      { name: 'message_ids',          type: 'array[string]', required: false },
      { name: 'destination_folder_id',type: 'string',        required: false },
      { name: 'flag_action',          type: 'enum',          required: false },
      { name: 'from',                 type: 'string',        required: false },
      { name: 'to',                   type: 'string',        required: false },
      { name: 'cc',                   type: 'string',        required: false },
      { name: 'subject',              type: 'string',        required: false },
      { name: 'body',                 type: 'string',        required: false },
      { name: 'text',                 type: 'string',        required: false },
      { name: 'unread',               type: 'boolean',       required: false },
      { name: 'has_attachment',       type: 'boolean',       required: false },
      { name: 'flagged',              type: 'boolean',       required: false },
      { name: 'since',                type: 'string (ISO date)', required: false },
      { name: 'before',               type: 'string (ISO date)', required: false },
      { name: 'query',                type: 'string',        required: false },
      { name: 'include_folders',      type: 'array',         required: false },
      { name: 'limit',                type: 'integer',       required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 18, "method": "tools/call",
  "params": {
    "name": "email_organize",
    "arguments": {
      "action": "move",
      "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d",
      "message_id": "4412",
      "destination_folder_id": "archive"
    }
  }
}`,
      response: `{
  "success": true,
  "message_id": "4412",
  "operation": "email_move",
  "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d",
  "destination_folder_id": "Archive"
}`,
    },
  },
  {
    name: 'email_delete',
    scopes: ['delete:email'],
    params: [
      { name: 'action',          type: 'enum',          required: true },
      { name: 'inbox_id',        type: 'string (uuid)', required: false },
      { name: 'inbox',           type: 'string',        required: false },
      { name: 'message_id',      type: 'string',        required: false },
      { name: 'message_ids',     type: 'array[string]', required: false },
      { name: 'permanent',       type: 'boolean',       required: false },
      { name: 'from',            type: 'string',        required: false },
      { name: 'to',              type: 'string',        required: false },
      { name: 'cc',              type: 'string',        required: false },
      { name: 'subject',         type: 'string',        required: false },
      { name: 'body',            type: 'string',        required: false },
      { name: 'text',            type: 'string',        required: false },
      { name: 'unread',          type: 'boolean',       required: false },
      { name: 'has_attachment',  type: 'boolean',       required: false },
      { name: 'flagged',         type: 'boolean',       required: false },
      { name: 'since',           type: 'string (ISO date)', required: false },
      { name: 'before',          type: 'string (ISO date)', required: false },
      { name: 'query',           type: 'string',        required: false },
      { name: 'include_folders', type: 'array',         required: false },
      { name: 'limit',           type: 'integer',       required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 20, "method": "tools/call",
  "params": {
    "name": "email_delete",
    "arguments": {
      "action": "delete",
      "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d",
      "message_id": "4412"
    }
  }
}`,
      response: `{
  "success": true,
  "message_id": "4412",
  "operation": "email_delete",
  "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d",
  "permanent": false
}`,
    },
  },
  {
    name: 'email_compose',
    scopes: ['send:email'],
    params: [
      { name: 'action',              type: 'enum',          required: true },
      { name: 'inbox_id',            type: 'string (uuid)', required: false },
      { name: 'inbox',               type: 'string',        required: false },
      { name: 'message_id',          type: 'string',        required: false },
      { name: 'to',                  type: 'array[string]', required: false },
      { name: 'subject',             type: 'string',        required: false },
      { name: 'body',                type: 'string',        required: false },
      { name: 'cc',                  type: 'array[string]', required: false },
      { name: 'bcc',                 type: 'array[string]', required: false },
      { name: 'html_body',           type: 'string',        required: false },
      { name: 'reply_to',            type: 'string',        required: false },
      { name: 'reply_all',           type: 'boolean',       required: false },
      { name: 'include_attachments', type: 'boolean',       required: false },
      { name: 'include_signature',   type: 'boolean',       required: false },
      { name: 'attachments',         type: 'array',         required: false },
      { name: 'idempotency_key',     type: 'string',        required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 6, "method": "tools/call",
  "params": {
    "name": "email_compose",
    "arguments": {
      "action": "send",
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
    name: 'folder',
    scopes: ['read:email', 'manage:folders'],
    params: [
      { name: 'action',    type: 'enum',          required: true },
      { name: 'inbox_id',  type: 'string (uuid)', required: false },
      { name: 'inbox',     type: 'string',        required: false },
      { name: 'name',      type: 'string',        required: false },
      { name: 'folder_id', type: 'string',        required: false },
      { name: 'new_name',  type: 'string',        required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": {
    "name": "folder",
    "arguments": {
      "action": "list",
      "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d"
    }
  }
}`,
      response: `{
  "inbox_id": "7a2e9c1d-4b8f-6e3a-2c5d-1f0e9b8a7c6d",
  "folders": [
    { "id": "INBOX",   "name": "INBOX",   "type": "folder", "total_messages": 412, "unread_messages": 12 },
    { "id": "Archive", "name": "Archive", "type": "folder", "total_messages": 9803, "unread_messages": 0 },
    { "id": "Sent",    "name": "Sent",    "type": "folder", "total_messages": 880, "unread_messages": null }
  ]
}`,
    },
  },
  {
    name: 'draft',
    scopes: ['manage:drafts'],
    params: [
      { name: 'action',   type: 'enum',          required: true },
      { name: 'inbox_id', type: 'string (uuid)', required: false },
      { name: 'inbox',    type: 'string',        required: false },
      { name: 'draft_id', type: 'string',        required: false },
      { name: 'subject',  type: 'string',        required: false },
      { name: 'body',     type: 'string',        required: false },
      { name: 'to',       type: 'array[string]', required: false },
      { name: 'cc',       type: 'array[string]', required: false },
      { name: 'bcc',      type: 'array[string]', required: false },
      { name: 'html_body',type: 'string',        required: false },
      { name: 'include_signature', type: 'boolean', required: false },
      { name: 'idempotency_key', type: 'string', required: false },
      { name: 'limit',    type: 'integer',       required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 26, "method": "tools/call",
  "params": {
    "name": "draft",
    "arguments": {
      "action": "create",
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "to": ["erin@example.com"],
      "subject": "Contract review",
      "body": "Hi Erin, draft notes attached."
    }
  }
}`,
      response: `{
  "draft_id": "r-8830",
  "subject": "Contract review",
  "to": [{ "name": null, "email": "erin@example.com" }],
  "created_at": "2026-05-24T11:40:00Z"
}`,
    },
  },
  {
    name: 'schedule',
    scopes: ['schedule:email'],
    params: [
      { name: 'action',            type: 'enum',          required: true },
      { name: 'inbox_id',          type: 'string (uuid)', required: false },
      { name: 'inbox',             type: 'string',        required: false },
      { name: 'to',                type: 'array[string]', required: false },
      { name: 'subject',           type: 'string',        required: false },
      { name: 'body',              type: 'string',        required: false },
      { name: 'send_at',           type: 'string (ISO 8601)', required: false },
      { name: 'cc',                type: 'array[string]', required: false },
      { name: 'bcc',               type: 'array[string]', required: false },
      { name: 'html_body',         type: 'string',        required: false },
      { name: 'reply_to',          type: 'string',        required: false },
      { name: 'attachments',       type: 'array',         required: false },
      { name: 'scheduled_send_id', type: 'string (uuid)', required: false },
      { name: 'idempotency_key',   type: 'string',        required: false },
      { name: 'limit',             type: 'integer',       required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 31, "method": "tools/call",
  "params": {
    "name": "schedule",
    "arguments": {
      "action": "create",
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "to": ["carol@example.com"],
      "subject": "Reminder: kickoff at 9am",
      "body": "See you tomorrow.",
      "send_at": "2026-06-02T07:00:00Z"
    }
  }
}`,
      response: `{
  "scheduled": true,
  "scheduled_send_id": "c91e0b2a-7f3d-4a18-9c44-2b6e1d8f0a55",
  "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "send_at": "2026-06-02T07:00:00Z",
  "status": "pending"
}`,
    },
  },
  {
    name: 'contact_search',
    scopes: ['manage:contacts'],
    params: [
      { name: 'query',    type: 'string',        required: true },
      { name: 'inbox_id', type: 'string (uuid)', required: false },
      { name: 'inbox',    type: 'string',        required: false },
      { name: 'limit',    type: 'integer',       required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 29, "method": "tools/call",
  "params": {
    "name": "contact_search",
    "arguments": {
      "query": "alice",
      "limit": 5
    }
  }
}`,
      response: `{
  "contacts": [
    {
      "email_address": "alice@example.com",
      "display_name": "Alice Nguyen",
      "message_count": 87,
      "last_contacted_at": "2026-05-24T10:30:00Z"
    }
  ]
}`,
    },
  },
  {
    // The rule's own action object is exposed as `rule_action` because the
    // consolidated schema reserves `action` for the operation selector, the same
    // rename email_organize's `flag` action uses for `flag_action`.
    name: 'automation',
    scopes: ['manage:automations'],
    params: [
      { name: 'action',               type: 'enum',          required: true },
      { name: 'automation_id',        type: 'string (uuid)', required: false },
      { name: 'inbox_id',             type: 'string (uuid)', required: false },
      { name: 'inbox',                type: 'string',        required: false },
      { name: 'name',                 type: 'string',        required: false },
      { name: 'filter',               type: 'object',        required: false },
      { name: 'rule_action',          type: 'object',        required: false },
      { name: 'interval_minutes',     type: 'enum',          required: false },
      { name: 'max_messages_per_run', type: 'integer',       required: false },
      { name: 'limit',                type: 'integer',       required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 31, "method": "tools/call",
  "params": {
    "name": "automation",
    "arguments": {
      "action": "create",
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "name": "Vendor invoices to Finance",
      "filter": {
        "from": "billing@",
        "subject": "invoice",
        "unread": true
      },
      "rule_action": {
        "type": "move",
        "folder": "Finance/Invoices"
      },
      "interval_minutes": 60,
      "max_messages_per_run": 25
    }
  }
}`,
      response: `{
  "automation": {
    "id": "b41c7d90-2a63-4e18-9f52-6c0d8b1e7a34",
    "name": "Vendor invoices to Finance",
    "enabled": false,
    "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
    "filter": { "from": "billing@", "subject": "invoice", "unread": true },
    "action": { "type": "move", "folder": "Finance/Invoices" },
    "interval_minutes": 60,
    "max_messages_per_run": 25,
    "next_run_at": null,
    "last_run_at": null,
    "consecutive_failures": 0,
    "disabled_reason": null
  },
  "enabled": false,
  "message": "Automation created and left disabled. Preview it, then enable it."
}`,
    },
  },
  {
    name: 'signature',
    scopes: ['read:email', 'send:email'],
    params: [
      { name: 'action',               type: 'enum',          required: true },
      { name: 'inbox_id',             type: 'string (uuid)', required: false },
      { name: 'inbox',                type: 'string',        required: false },
      { name: 'signature_text',       type: 'string',        required: false },
      { name: 'signature_html',       type: 'string',        required: false },
      { name: 'signature_enabled',    type: 'boolean',       required: false },
      { name: 'signature_reply_mode', type: 'enum',          required: false },
    ],
    example: {
      request: `{
  "jsonrpc": "2.0", "id": 33, "method": "tools/call",
  "params": {
    "name": "signature",
    "arguments": {
      "action": "set",
      "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
      "signature_text": "Bob Chen\\nHead of Sales · Acme Inc.",
      "signature_reply_mode": "first_only"
    }
  }
}`,
      response: `{
  "inbox_id": "3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "signature_enabled": true,
  "signature_reply_mode": "first_only",
  "signature_source": "manual",
  "signature_text": "Bob Chen\\nHead of Sales · Acme Inc.",
  "signature_html": null,
  "signature_updated_at": "2026-06-23T11:20:00Z"
}`,
    },
  },
];

// Flattened list — used for the in-page tool navigation.
const ALL_TOOLS = TOOLS;

/* ─── Error codes ────────────────────────────────────────────── */

const ERROR_CODES = [
  { code: '-32001', type: 'JSON-RPC error', whenKey: 'auth', retryable: false },
  { code: '-32601', type: 'JSON-RPC error', whenKey: 'method', retryable: false },
  { code: '-32602', type: 'JSON-RPC error', whenKey: 'param', retryable: false },
  { code: '-32003', type: 'JSON-RPC error', whenKey: 'rate', retryable: true },
  { code: 'isError: true', type: 'Tool result', whenKey: 'tool', retryable: false },
  { code: 'isError: true', type: 'Tool result', whenKey: 'cap', retryable: false },
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
  const s = SCOPE_STYLES[scope] ?? SCOPE_STYLES['read:email'];
  return (
    <span
      className="docs-badge"
      style={{ background: s.bg, color: s.fg, border: s.border }}
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
          {tool.scopes.map(s => <ScopeBadge key={s} scope={s} />)}
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
            <a className="btn btn-secondary btn-lg" href="#automation-safety">{t('hero.ctaSafety')}</a>
            <Link className="btn btn-secondary btn-lg" href="/docs/providers">{t('hero.ctaProviders')}</Link>
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
                <code className="docs-url">https://mcpemails.com/api/mcp</code>
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
              code={`curl -X POST https://mcpemails.com/api/mcp \\
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

          {/* Polling vs. push clarification: the API is pull-only. */}
          <div style={{
            marginTop: 28,
            display: 'flex',
            gap: 12,
            padding: '16px 18px',
            borderRadius: 12,
            border: '1px solid var(--border-1)',
            background: 'var(--bg-surface)',
          }}>
            <div style={{ flexShrink: 0, marginTop: 2 }}>
              <MIcon name="refresh" size={18} color="var(--cobalt-600)" />
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
                {t('endpoint.pollingHeading')}
              </div>
              <p style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', lineHeight: 1.6 }}>
                {t.rich('endpoint.pollingBody', RICH)}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Product capabilities — deliberately grouped as interface behaviour, not
          as a new tool catalogue. */}
      <section className="section" id="operations" style={{ paddingTop: 64, paddingBottom: 64 }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">{t('operations.eyebrow')}</div>
            <h2>{t('operations.heading')}</h2>
            <p className="sub">{t('operations.sub')}</p>
          </div>
          <div className="docs-endpoint-grid">
            {['approval', 'portable', 'content', 'reliable', 'workflows', 'drafts'].map((key) => (
              <div className="docs-endpoint-card" key={key}>
                <h3 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 16, color: 'var(--fg-1)' }}>
                  {t(`operations.${key}.heading`)}
                </h3>
                <p style={{ margin: '8px 0 0', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', lineHeight: 1.6 }}>
                  {t.rich(`operations.${key}.body`, RICH)}
                </p>
              </div>
            ))}
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
            {ALL_TOOLS.map(tool => (
              <a key={tool.name} className="docs-tool-nav-item" href={'#tool-' + tool.name}>
                <code>{tool.name}</code>
                {tool.scopes.map(s => <ScopeBadge key={s} scope={s} />)}
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

      {/* Automation safety model.
          Placed straight after the tool reference because it is the answer to the
          question the `automation` tool raises: what exactly is allowed to happen
          to a mailbox when nobody is watching. The claims here are deliberately
          narrow and each one maps to an enforced mechanism, not an intention. */}
      <section className="section" id="automation-safety" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">{t('automationSafety.eyebrow')}</div>
            <h2>{t('automationSafety.heading')}</h2>
            <p className="sub">{t.rich('automationSafety.sub', RICH)}</p>
          </div>

          {/* The determinism claim gets its own panel: it is the one property the
              rest of the model rests on. */}
          <div className="docs-endpoint-card" style={{ marginBottom: 28 }}>
            <h3 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 18, color: 'var(--fg-1)' }}>
              {t('automationSafety.deterministic.heading')}
            </h3>
            <p style={{ margin: '10px 0 0', fontFamily: 'var(--font-sans)', fontSize: 15, color: 'var(--fg-2)', lineHeight: 1.7 }}>
              {t.rich('automationSafety.deterministic.body', RICH)}
            </p>
            <p style={{ margin: '12px 0 0', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', lineHeight: 1.7 }}>
              {t.rich('automationSafety.deterministic.why', RICH)}
            </p>
          </div>

          <div className="docs-endpoint-grid">
            {['noDelete', 'forward', 'draftReply', 'template', 'runLog', 'keyAuthority', 'autoDisable', 'perRunCap'].map((key) => (
              <div className="docs-endpoint-card" key={key}>
                <h3 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 16, color: 'var(--fg-1)' }}>
                  {t(`automationSafety.items.${key}.heading`)}
                </h3>
                <p style={{ margin: '8px 0 0', fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', lineHeight: 1.6 }}>
                  {t.rich(`automationSafety.items.${key}.body`, RICH)}
                </p>
              </div>
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
                  <tr key={e.whenKey}>
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

// Rate limit: JSON-RPC error object with data (HTTP 429). Safe to retry
// after retry_after seconds.
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32003,
    "message": "Rate limit exceeded",
    "data": {
      "error_code": "rate_limit_exceeded",
      "window": "per_minute",
      "limit": 100,
      "used": 100,
      "retry_after": 34
    }
  }
}

// Fair-use ceiling: a normal tool result (HTTP 200) with isError: true.
// NOT a JSON-RPC error, and NOT retryable until reset_at.
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [{
      "type": "text",
      "text": "Usage limit reached for this workspace. Calls resume at reset_at."
    }],
    "isError": true,
    "_meta": {
      "com.mcpemails/usage_limit": {
        "error_code": "usage_limit_reached",
        "reset_at": "2026-09-01T00:00:00.000Z",
        "dashboard_url": "https://mcpemails.com/dashboard/usage"
      }
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
              <div className="num">{t('rateLimits.capTag')}</div>
              <h4>{t('rateLimits.capHeading')}</h4>
              <p>{t.rich('rateLimits.capBody', RICH)}</p>
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
            <Link className="btn btn-on-dark btn-lg" href="/pricing">{t('cta.secondary')}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
